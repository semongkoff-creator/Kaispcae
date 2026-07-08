import { Server, Socket } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { SocketEvents, MediaType, MediaPayload, MapMediaObject, WhiteboardStroke } from '@virtualmeet/shared';
import { getPlayerName } from './roomHandler';
import { socketRateLimit } from '../middleware/rateLimit';
import { deleteUploadedFile } from '../routes/uploads';

// §6 — Add Media. Self-contained module tracking its own uid/room mappings
// rather than reaching into roomHandler.ts's private state — same
// "small deliberate duplication for decoupling" precedent as followHandler.ts.
// Delete-permission ("creator or admin", per spec §6's own rule) is resolved
// fresh from RoomMember.role on every check rather than via roomHandler.ts's
// in-memory admin cache — mirrors how teleport.ts's REST routes independently
// resolve role, since this module has no socket-layer admin state to reuse.

const MEDIA_TYPES: MediaType[] = ['image', 'youtube', 'whiteboard', 'file'];
const IMAGE_FILE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — spec §6's table, Image row (and File, see doc comment on the model)

const canAddMedia = socketRateLimit(2);
const canRemoveMedia = socketRateLimit(3);
const canDrawStroke = socketRateLimit(30); // freehand drawing needs much higher throughput than a discrete action

const socketToUid = new Map<string, string>();
const socketToRoom = new Map<string, string>();

function getPrisma(): PrismaClient {
  return new PrismaClient();
}

function toClientShape(row: {
  id: string; roomId: string; type: string; x: number; y: number;
  createdBy: string; createdByName: string; createdAt: Date; expiresAt: Date | null; payload: unknown;
}): MapMediaObject {
  return {
    id: row.id,
    roomId: row.roomId,
    type: row.type as MediaType,
    x: row.x,
    y: row.y,
    createdBy: row.createdBy,
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    payload: (row.payload as MediaPayload) ?? {},
  };
}

async function canDeleteMedia(prisma: PrismaClient, userId: string, roomId: string, ownerId: string, createdBy: string): Promise<boolean> {
  if (userId === createdBy || userId === ownerId) return true;
  const member = await prisma.roomMember.findUnique({ where: { userId_roomId: { userId, roomId } } });
  return member?.role === 'admin';
}

function isValidPayload(type: MediaType, payload: MediaPayload | undefined): boolean {
  if (!payload) return type === 'whiteboard'; // whiteboard starts with no payload — strokes are added after
  switch (type) {
    case 'image':
    case 'file':
      return typeof payload.url === 'string' && payload.url.startsWith('/api/uploads/');
    case 'youtube':
      return typeof payload.videoId === 'string' && /^[\w-]{11}$/.test(payload.videoId);
    case 'whiteboard':
      return true;
    default:
      return false;
  }
}

export function registerMediaHandlers(io: Server, socket: Socket): void {
  socket.on(SocketEvents.JOIN_ROOM, async (roomId: string, _playerName?: string, _avatarConfig?: unknown, userId?: string) => {
    const room = roomId || 'main-office';
    const uid = (socket.data as { userId?: string }).userId || userId || socket.id;
    socketToUid.set(socket.id, uid);
    socketToRoom.set(socket.id, room);

    try {
      const prisma = getPrisma();
      const dbRoom = await prisma.room.findUnique({ where: { slug: room } });
      if (!dbRoom) return;
      const rows = await prisma.mapMediaObject.findMany({ where: { roomId: dbRoom.id } });
      socket.emit(SocketEvents.MEDIA_LIST, { mediaObjects: rows.map(toClientShape) });
    } catch (e) {
      console.error('[media] list on join error:', e);
    }
  });

  socket.on(SocketEvents.MEDIA_ADD, async (data: { type: MediaType; x: number; y: number; payload?: MediaPayload }) => {
    if (!canAddMedia(socket.id)) return;
    const room = socketToRoom.get(socket.id); if (!room) return;
    const uid = socketToUid.get(socket.id); if (!uid) return;
    if (!data || !MEDIA_TYPES.includes(data.type) || typeof data.x !== 'number' || typeof data.y !== 'number') return;
    if (!isValidPayload(data.type, data.payload)) {
      socket.emit('admin:error', { message: 'Invalid media data' });
      return;
    }

    try {
      const prisma = getPrisma();
      const dbRoom = await prisma.room.findUnique({ where: { slug: room } });
      if (!dbRoom) return;

      const needsTtl = data.type === 'image' || data.type === 'file';
      const row = await prisma.mapMediaObject.create({
        data: {
          roomId: dbRoom.id,
          type: data.type,
          x: Math.round(data.x),
          y: Math.round(data.y),
          createdBy: uid,
          createdByName: getPlayerName(socket.id),
          expiresAt: needsTtl ? new Date(Date.now() + IMAGE_FILE_TTL_MS) : null,
          payload: (data.payload ?? {}) as object,
        },
      });
      io.to(room).emit(SocketEvents.MEDIA_ADDED, toClientShape(row));
    } catch (e) {
      console.error('[media] add error:', e);
    }
  });

  socket.on(SocketEvents.MEDIA_REMOVE, async (data: { id: string }) => {
    if (!canRemoveMedia(socket.id)) return;
    const room = socketToRoom.get(socket.id); if (!room) return;
    const uid = socketToUid.get(socket.id); if (!uid) return;
    if (!data?.id) return;

    try {
      const prisma = getPrisma();
      const dbRoom = await prisma.room.findUnique({ where: { slug: room } });
      if (!dbRoom) return;
      const row = await prisma.mapMediaObject.findFirst({ where: { id: data.id, roomId: dbRoom.id } });
      if (!row) return;

      if (!(await canDeleteMedia(prisma, uid, dbRoom.id, dbRoom.ownerId, row.createdBy))) {
        socket.emit('admin:error', { message: 'Only the creator or an admin can remove this' });
        return;
      }

      await prisma.mapMediaObject.delete({ where: { id: row.id } });
      const payload = row.payload as MediaPayload;
      if ((row.type === 'image' || row.type === 'file') && payload?.url) {
        deleteUploadedFile(payload.url);
      }
      io.to(room).emit(SocketEvents.MEDIA_REMOVED, { id: row.id });
    } catch (e) {
      console.error('[media] remove error:', e);
    }
  });

  // Strokes are additive — two people drawing at once never "conflict" the
  // way concurrent edits to the same text/shape would, so a plain broadcast
  // of each completed stroke (persisted by appending to payload.strokes) is
  // enough for real-time multi-user sync without a CRDT/OT library.
  socket.on(SocketEvents.WHITEBOARD_STROKE, async (data: { mediaId: string; stroke: WhiteboardStroke }) => {
    if (!canDrawStroke(socket.id)) return;
    const room = socketToRoom.get(socket.id); if (!room) return;
    if (!data?.mediaId || !data.stroke || !Array.isArray(data.stroke.points) || data.stroke.points.length === 0) return;

    try {
      const prisma = getPrisma();
      const row = await prisma.mapMediaObject.findUnique({ where: { id: data.mediaId } });
      if (!row || row.type !== 'whiteboard') return;
      const payload = (row.payload as MediaPayload) ?? {};
      const strokes = [...(payload.strokes ?? []), data.stroke];
      await prisma.mapMediaObject.update({ where: { id: row.id }, data: { payload: { ...payload, strokes } as object } });
      socket.to(room).emit(SocketEvents.WHITEBOARD_STROKE_ADDED, { mediaId: data.mediaId, stroke: data.stroke });
    } catch (e) {
      console.error('[media] whiteboard stroke error:', e);
    }
  });

  socket.on(SocketEvents.WHITEBOARD_CLEAR, async (data: { mediaId: string }) => {
    const room = socketToRoom.get(socket.id); if (!room) return;
    const uid = socketToUid.get(socket.id); if (!uid) return;
    if (!data?.mediaId) return;

    try {
      const prisma = getPrisma();
      const dbRoom = await prisma.room.findUnique({ where: { slug: room } });
      if (!dbRoom) return;
      const row = await prisma.mapMediaObject.findFirst({ where: { id: data.mediaId, roomId: dbRoom.id } });
      if (!row || row.type !== 'whiteboard') return;
      if (!(await canDeleteMedia(prisma, uid, dbRoom.id, dbRoom.ownerId, row.createdBy))) {
        socket.emit('admin:error', { message: 'Only the creator or an admin can clear this whiteboard' });
        return;
      }
      const payload = (row.payload as MediaPayload) ?? {};
      await prisma.mapMediaObject.update({ where: { id: row.id }, data: { payload: { ...payload, strokes: [] } as object } });
      io.to(room).emit(SocketEvents.WHITEBOARD_CLEARED, { mediaId: row.id });
    } catch (e) {
      console.error('[media] whiteboard clear error:', e);
    }
  });

  socket.on(SocketEvents.DISCONNECT, () => {
    socketToUid.delete(socket.id);
    socketToRoom.delete(socket.id);
  });
}

// Periodic sweep for expired Image/File objects — this app has no dedicated
// job queue/cron infra, so an in-process interval stands in for the spec's
// "cron job hapus objek + file setelah expire". Broadcasts MEDIA_REMOVED so
// clients still displaying an expired object drop it without needing to
// reload.
export function startMediaExpirySweep(io: Server, intervalMs = 5 * 60 * 1000): void {
  setInterval(async () => {
    try {
      const prisma = getPrisma();
      const expired = await prisma.mapMediaObject.findMany({ where: { expiresAt: { lt: new Date() } } });
      if (expired.length === 0) return;
      for (const row of expired) {
        const payload = row.payload as MediaPayload;
        if (payload?.url) deleteUploadedFile(payload.url);
        const dbRoom = await prisma.room.findUnique({ where: { id: row.roomId } });
        if (dbRoom) io.to(dbRoom.slug).emit(SocketEvents.MEDIA_REMOVED, { id: row.id });
      }
      await prisma.mapMediaObject.deleteMany({ where: { id: { in: expired.map((r) => r.id) } } });
      console.log(`[media] expiry sweep removed ${expired.length} object(s)`);
    } catch (e) {
      console.error('[media] expiry sweep error:', e);
    }
  }, intervalMs);
}
