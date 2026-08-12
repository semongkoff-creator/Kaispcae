import { Server, Socket } from 'socket.io';
import { SocketEvents, hasFeatureAccess, LayerData, Furniture } from '@kaispace/shared';
import { getPrisma } from '../lib/prisma';
import { socketRateLimit } from '../middleware/rateLimit';


const canAssign = socketRateLimit(2); // max 2 assign/unassign calls/sec per socket

// Bug fix — once a room has ever been opened in the modern Room Editor,
// layerData becomes its source of truth (see roomHandler.ts's ROOM_STATE:
// furniture is derived from layerData.objects/topObjects via
// layerDataToLegacy, NOT from the legacy `furniture` column, whenever
// layerData is set). This handler used to always patch+save the legacy
// column regardless — so on any layerData room, an assignment would
// broadcast live (everyone's in-memory gameStore updates) but silently NOT
// survive a refresh/relogin, since ROOM_STATE would re-derive furniture from
// layerData and never see the legacy-column write at all. Finding the item
// in whichever store ROOM_STATE actually reads from — mirrored here — is
// what makes an assignment actually persist.
function findFurnitureInLayerData(layerData: LayerData, furnitureId: string): Furniture | undefined {
  return layerData.objects.find((f) => f.id === furnitureId) ?? layerData.topObjects.find((f) => f.id === furnitureId);
}

// Where a user's permanently-assigned seat actually is, checked the SAME way
// findFurnitureInLayerData/FURNITURE_ASSIGN above resolve furniture: layerData
// first (a room ever opened in the modern Room Editor stores furniture there,
// not in the legacy column — see this file's top doc comment), falling back
// to the legacy `furniture` array only when a room has no layerData at all.
// Exported for roomHandler.ts to use in two places: JOIN_ROOM's spawn
// computation, and the "Go to My Seat" TELEPORT_REQUEST handler — which used
// to only check the legacy column, so it silently found nothing for anyone
// whose assigned seat lives in a layerData room. One correct lookup shared by
// both instead of a second, narrower copy of the same logic.
export function findAssignedSeat(dbRoom: { layerData?: unknown; furniture: unknown }, uid: string): { id: string; x: number; y: number } | null {
  if (dbRoom.layerData) {
    const layerData = dbRoom.layerData as unknown as LayerData;
    const item = layerData.objects.find((f) => f.assignedToUserId === uid) ?? layerData.topObjects.find((f) => f.assignedToUserId === uid);
    return item ? { id: item.id, x: item.x, y: item.y } : null;
  }
  if (Array.isArray(dbRoom.furniture)) {
    const item = (dbRoom.furniture as Furniture[]).find((f) => f?.assignedToUserId === uid);
    return item ? { id: item.id, x: item.x, y: item.y } : null;
  }
  return null;
}

// Permanent seat assignment (ZEP-style "this is my desk"), distinct from the
// transient sit-down in roomHandler.ts's PLAYER_SIT. Persisted straight into
// the room's furniture storage in Postgres, same as ROOM_UPDATE does for the
// whole tilemap — this just patches one item instead of resaving everything.
export function registerFurnitureHandlers(io: Server, socket: Socket) {
  let currentRoom: string | null = null;

  socket.on(SocketEvents.JOIN_ROOM, async (roomId: string) => {
    const slug = roomId || 'main-office';
    // Multi-tenant Fase 3 — this module registers its own independent
    // JOIN_ROOM listener (see mediaHandler.ts's comment on why roomHandler.ts
    // rejecting a cross-org join doesn't stop this one from also running).
    try {
      const room = await getPrisma().room.findUnique({ where: { slug }, select: { organizationId: true } });
      if (!room || room.organizationId !== (socket.data as { organizationId?: string }).organizationId) { currentRoom = null; return; }
    } catch (e) {
      console.error('[furniture] org check failed:', e);
      currentRoom = null;
      return;
    }
    currentRoom = slug;
  });

  socket.on(SocketEvents.FURNITURE_ASSIGN, async (data: { furnitureId: string; name: string }) => {
    if (!canAssign(socket.id)) return;
    const room = currentRoom; if (!room) return;
    const uid = (socket.data as { userId?: string }).userId;
    // 'furniture:assign' only requires 'member' (see shared/permissions.ts)
    // — any authenticated user qualifies, so this is really just the
    // "logged in at all" check; 'guest' (unauthenticated) is the only role
    // hasFeatureAccess would reject here, and is unreachable anyway since
    // login is mandatory before joining a room.
    if (!uid || !hasFeatureAccess('member', 'furniture:assign')) {
      socket.emit('admin:error', { message: 'You must be logged in to assign a seat' });
      return;
    }
    if (typeof data?.furnitureId !== 'string') return;

    try {
      const prisma = getPrisma();
      const dbRoom = await prisma.room.findUnique({ where: { slug: room } });
      if (!dbRoom) return;
      const name = (data.name || 'Someone').slice(0, 30);
      const freed: string[] = [];

      if (dbRoom.layerData) {
        const layerData = dbRoom.layerData as unknown as LayerData;
        const item = findFurnitureInLayerData(layerData, data.furnitureId);
        if (!item || !item.isInteractable) return;
        if (item.assignedToUserId && item.assignedToUserId !== uid) {
          socket.emit('admin:error', { message: 'This seat is already assigned to someone else' });
          return;
        }
        for (const f of [...layerData.objects, ...layerData.topObjects]) {
          if (f.assignedToUserId === uid && f.id !== item.id) {
            delete f.assignedToUserId;
            delete f.assignedToName;
            freed.push(f.id);
          }
        }
        item.assignedToUserId = uid;
        item.assignedToName = name;
        await prisma.room.update({ where: { slug: room }, data: { layerData: layerData as any } });
      } else {
        if (!Array.isArray(dbRoom.furniture)) return;
        const furniture = dbRoom.furniture as any[];
        const item = furniture.find((f) => f.id === data.furnitureId);
        if (!item || !item.isInteractable) return;
        if (item.assignedToUserId && item.assignedToUserId !== uid) {
          socket.emit('admin:error', { message: 'This seat is already assigned to someone else' });
          return;
        }
        for (const f of furniture) {
          if (f.assignedToUserId === uid && f.id !== item.id) {
            delete f.assignedToUserId;
            delete f.assignedToName;
            freed.push(f.id);
          }
        }
        item.assignedToUserId = uid;
        item.assignedToName = name;
        await prisma.room.update({ where: { slug: room }, data: { furniture } });
      }

      for (const fid of freed) io.to(room).emit(SocketEvents.FURNITURE_UNASSIGNED, { furnitureId: fid });
      io.to(room).emit(SocketEvents.FURNITURE_ASSIGNED, { furnitureId: data.furnitureId, userId: uid, name });
    } catch (e) {
      console.error('[furniture] assign error:', e);
    }
  });

  socket.on(SocketEvents.FURNITURE_UNASSIGN, async (data: { furnitureId: string }) => {
    if (!canAssign(socket.id)) return;
    const room = currentRoom; if (!room) return;
    const uid = (socket.data as { userId?: string }).userId;
    if (!uid || typeof data?.furnitureId !== 'string') return;

    try {
      const prisma = getPrisma();
      const dbRoom = await prisma.room.findUnique({ where: { slug: room } });
      if (!dbRoom) return;

      if (dbRoom.layerData) {
        const layerData = dbRoom.layerData as unknown as LayerData;
        const item = findFurnitureInLayerData(layerData, data.furnitureId);
        // Only the current assignee can unassign their own seat — mirrors the
        // "Unassign My Seat" wording (first-person only, no moderation here).
        if (!item || item.assignedToUserId !== uid) return;
        delete item.assignedToUserId;
        delete item.assignedToName;
        await prisma.room.update({ where: { slug: room }, data: { layerData: layerData as any } });
      } else {
        if (!Array.isArray(dbRoom.furniture)) return;
        const furniture = dbRoom.furniture as any[];
        const item = furniture.find((f) => f.id === data.furnitureId);
        if (!item || item.assignedToUserId !== uid) return;
        delete item.assignedToUserId;
        delete item.assignedToName;
        await prisma.room.update({ where: { slug: room }, data: { furniture } });
      }

      io.to(room).emit(SocketEvents.FURNITURE_UNASSIGNED, { furnitureId: data.furnitureId });
    } catch (e) {
      console.error('[furniture] unassign error:', e);
    }
  });
}
