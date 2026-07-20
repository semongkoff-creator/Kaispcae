import { Server, Socket } from 'socket.io';
import { SocketEvents, hasFeatureAccess } from '@virtualmeet/shared';
import { getPrisma } from '../lib/prisma';
import { socketRateLimit } from '../middleware/rateLimit';


const canAssign = socketRateLimit(2); // max 2 assign/unassign calls/sec per socket

// Permanent seat assignment (ZEP-style "this is my desk"), distinct from the
// transient sit-down in roomHandler.ts's PLAYER_SIT. Persisted straight into
// the room's furniture JSON in Postgres, same as ROOM_UPDATE does for the
// whole tilemap — this just patches one item instead of resaving everything.
export function registerFurnitureHandlers(io: Server, socket: Socket) {
  let currentRoom: string | null = null;

  socket.on(SocketEvents.JOIN_ROOM, (roomId: string) => {
    currentRoom = roomId || 'main-office';
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
      if (!dbRoom || !Array.isArray(dbRoom.furniture)) return;
      const furniture = dbRoom.furniture as any[];
      const item = furniture.find((f) => f.id === data.furnitureId);
      if (!item || !item.isInteractable) return;
      if (item.assignedToUserId && item.assignedToUserId !== uid) {
        socket.emit('admin:error', { message: 'This seat is already assigned to someone else' });
        return;
      }

      const name = (data.name || 'Someone').slice(0, 30);

      // One assigned seat per user: release any OTHER seat this user already
      // holds so taking a new chair MOVES their seat cleanly instead of
      // leaving them owning two (which made "My Seat" pick an arbitrary one
      // and felt like you couldn't switch chairs). Collect the freed ids so
      // clients drop the old seat's badge too.
      const freed: string[] = [];
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
      for (const fid of freed) io.to(room).emit(SocketEvents.FURNITURE_UNASSIGNED, { furnitureId: fid });
      io.to(room).emit(SocketEvents.FURNITURE_ASSIGNED, { furnitureId: item.id, userId: uid, name });
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
      if (!dbRoom || !Array.isArray(dbRoom.furniture)) return;
      const furniture = dbRoom.furniture as any[];
      const item = furniture.find((f) => f.id === data.furnitureId);
      // Only the current assignee can unassign their own seat — mirrors the
      // "Unassign My Seat" wording (first-person only, no moderation here).
      if (!item || item.assignedToUserId !== uid) return;

      delete item.assignedToUserId;
      delete item.assignedToName;
      await prisma.room.update({ where: { slug: room }, data: { furniture } });
      io.to(room).emit(SocketEvents.FURNITURE_UNASSIGNED, { furnitureId: item.id });
    } catch (e) {
      console.error('[furniture] unassign error:', e);
    }
  });
}
