import { Server, Socket } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { SocketEvents, MediaType, MediaPayload, MapMediaObject, WhiteboardStroke } from '@kaispace/shared';
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

const MEDIA_TYPES: MediaType[] = ['image', 'youtube', 'whiteboard', 'file', 'website', 'bgm'];
// Uploaded-file locator — disk only. The /api/files/ proxy that used to sit
// beside this is gone along with the external store behind it, so a URL of
// that shape can no longer be served and must not be accepted.
export const isUploadUrl = (u: unknown): u is string => typeof u === 'string' && u.startsWith('/api/uploads/');
const IMAGE_FILE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — spec §6's table, Image row (and File, see doc comment on the model)

const canAddMedia = socketRateLimit(2);
const canRemoveMedia = socketRateLimit(3);
const canDrawStroke = socketRateLimit(30); // freehand drawing needs much higher throughput than a discrete action

const socketToUid = new Map<string, string>();
const socketToRoom = new Map<string, string>();


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
  const [user, member] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { accountRole: true } }),
    prisma.roomMember.findUnique({ where: { userId_roomId: { userId, roomId } } }),
  ]);
  return member?.role === 'admin' || user?.accountRole === 'admin';
}

export function isValidMediaPayload(type: MediaType, payload: MediaPayload | undefined): boolean {
  if (!payload) return type === 'whiteboard'; // whiteboard starts with no payload — strokes are added after
  switch (type) {
    case 'image':
    case 'file':
      return isUploadUrl(payload.url);
    case 'youtube':
      return typeof payload.videoId === 'string' && /^[\w-]{11}$/.test(payload.videoId);
    case 'website':
      // https only — reject javascript:/data:/http: etc.
      return typeof payload.websiteUrl === 'string' && /^https:\/\/\S+$/i.test(payload.websiteUrl);
    case 'bgm':
      return isUploadUrl(payload.audioUrl) && typeof payload.areaW === 'number' && typeof payload.areaH === 'number';
    case 'whiteboard':
      return true;
    default:
      return false;
  }
}
const isValidPayload = isValidMediaPayload;

export function registerMediaHandlers(io: Server, socket: Socket): void {
  socket.on(SocketEvents.JOIN_ROOM, async (roomId: string, _playerName?: string, _avatarConfig?: unknown, userId?: string) => {
    const room = roomId || 'main-office';
    const uid = (socket.data as { userId?: string }).userId || userId || socket.id;

    try {
      const prisma = getPrisma();
      const dbRoom = await prisma.room.findUnique({ where: { slug: room } });
      // Multi-tenant Fase 3 — this module registers its OWN independent
      // JOIN_ROOM listener (Socket.IO fires every listener for an event;
      // roomHandler.ts's own org check rejecting and returning does NOT stop
      // the other ~10 modules' listeners from also running) — so the same
      // check has to be repeated here, not just once centrally. socketToRoom/
      // socketToUid are deliberately only set AFTER this passes — every
      // action handler below trusts those maps as "the room this socket is
      // legitimately in", so a rejected cross-org join must never populate
      // them (a rejected roomHandler.ts join stops socket.join from ever
      // happening, but that alone doesn't stop THIS module's own state).
      if (!dbRoom || dbRoom.organizationId !== (socket.data as { organizationId?: string }).organizationId) return;
      socketToUid.set(socket.id, uid);
      socketToRoom.set(socket.id, room);
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
      // Bug media #1 — BGM's shared-clock anchor (see MediaPayload.startedAt's
      // doc comment). Stamped server-side, once, at creation — never from the
      // client, so every listener agrees on the same origin regardless of
      // their own clock being off.
      const payload = data.type === 'bgm' ? { ...(data.payload ?? {}), startedAt: Date.now() } : (data.payload ?? {});
      // specs/2026-08-21-room-entry-name-prompt-design.md — final-review
      // fix (round 2): createdByName is a persisted, DB-visible attribution
      // — same reasoning as noteHandler.ts's authorName fix, see there for
      // the full explanation. Falls back to getPlayerName only if the DB
      // lookup fails.
      const creatorUser = await prisma.user.findUnique({ where: { id: uid }, select: { displayName: true } });
      const row = await prisma.mapMediaObject.create({
        data: {
          roomId: dbRoom.id,
          type: data.type,
          x: Math.round(data.x),
          y: Math.round(data.y),
          createdBy: uid,
          createdByName: creatorUser?.displayName || getPlayerName(socket.id),
          expiresAt: needsTtl ? new Date(Date.now() + IMAGE_FILE_TTL_MS) : null,
          payload: payload as object,
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
        socket.emit('admin:error', { message: 'Kamu tidak punya izin menghapus media ini' });
        return;
      }

      await prisma.mapMediaObject.delete({ where: { id: row.id } });
      const payload = row.payload as MediaPayload;
      if ((row.type === 'image' || row.type === 'file') && payload?.url) deleteUploadedFile(payload.url);
      if (row.type === 'bgm' && payload?.audioUrl) deleteUploadedFile(payload.audioUrl);
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
        socket.emit('admin:error', { message: 'Kamu tidak punya izin menghapus media ini' });
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
