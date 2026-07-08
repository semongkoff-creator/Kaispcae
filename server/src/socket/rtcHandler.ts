import { Server, Socket } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { SocketEvents, RtcSignal, Role, hasFeatureAccess } from '@virtualmeet/shared';

function getPrisma(): PrismaClient {
  return new PrismaClient();
}

// A socket only ever joins one room (the room slug) via socket.join() in
// roomHandler.ts's JOIN_ROOM — socket.io also auto-joins every socket to a
// room named after its own id, so filtering that out leaves at most the
// one real room this socket is in.
function getSocketRoom(socket: Socket): string | undefined {
  for (const r of socket.rooms) {
    if (r !== socket.id) return r;
  }
  return undefined;
}

// §6 — spotlighted user ids per room, ephemeral (same in-memory-only
// convention as roomAdminMap/roomFollows elsewhere) — keyed by account
// userId, not socket id, so it survives the spotlighted user's own
// reconnects within the session.
const roomSpotlights = new Map<string, Set<string>>();

function getRoomSpotlights(room: string): Set<string> {
  if (!roomSpotlights.has(room)) roomSpotlights.set(room, new Set());
  return roomSpotlights.get(room)!;
}

async function resolveRole(prisma: PrismaClient, userId: string, roomSlug: string): Promise<Role> {
  const dbRoom = await prisma.room.findUnique({ where: { slug: roomSlug } });
  if (!dbRoom) return 'member';
  if (userId === dbRoom.ownerId) return 'owner';
  const member = await prisma.roomMember.findUnique({ where: { userId_roomId: { userId, roomId: dbRoom.id } } });
  if (member?.role === 'admin') return 'admin';
  if (member?.role === 'staff') return 'staff';
  return 'member';
}

export function registerRtcHandlers(io: Server, socket: Socket) {
  // A newly-joining socket has no way to learn about spotlights toggled
  // before it connected otherwise — SPOTLIGHT_CHANGED only reaches sockets
  // already in the room at broadcast time.
  socket.on(SocketEvents.JOIN_ROOM, (roomId: string) => {
    const room = roomId || 'main-office';
    const spotlights = roomSpotlights.get(room);
    if (spotlights && spotlights.size > 0) {
      socket.emit(SocketEvents.SPOTLIGHT_CHANGED, { spotlightedUserIds: Array.from(spotlights) });
    }
  });

  // Previously relayed to ANY socket id the client claimed as `toId`, with
  // no check that the target was even in the same room — any connected
  // client could probe/spam-signal arbitrary sockets server-wide. Now both
  // ends must share a room, and `fromId` is always server-set to the real
  // sender rather than trusting whatever the client put in the payload
  // (same "never trust client-claimed identity" principle as §2's
  // socket.data.userId check in index.ts).
  function relay(event: string, signal: RtcSignal) {
    const myRoom = getSocketRoom(socket);
    const targetSocket = io.sockets.sockets.get(signal.toId);
    if (!myRoom || !targetSocket || !targetSocket.rooms.has(myRoom)) return;
    io.to(signal.toId).emit(event, { ...signal, fromId: socket.id });
  }

  socket.on(SocketEvents.RTC_OFFER, (signal: RtcSignal) => relay(SocketEvents.RTC_OFFER, signal));
  socket.on(SocketEvents.RTC_ANSWER, (signal: RtcSignal) => relay(SocketEvents.RTC_ANSWER, signal));
  socket.on(SocketEvents.RTC_ICE_CANDIDATE, (signal: RtcSignal) => relay(SocketEvents.RTC_ICE_CANDIDATE, signal));

  socket.on(SocketEvents.SPOTLIGHT_TOGGLE, async (data: { targetUserId: string }) => {
    const room = getSocketRoom(socket);
    const uid = (socket.data as { userId?: string }).userId;
    if (!room || !uid || !data?.targetUserId) return;

    try {
      const prisma = getPrisma();
      const role = await resolveRole(prisma, uid, room);
      if (!hasFeatureAccess(role, 'rtc:spotlight')) {
        socket.emit('admin:error', { message: 'Staff role or higher required to spotlight players' });
        return;
      }

      const spotlights = getRoomSpotlights(room);
      if (spotlights.has(data.targetUserId)) spotlights.delete(data.targetUserId);
      else spotlights.add(data.targetUserId);

      io.to(room).emit(SocketEvents.SPOTLIGHT_CHANGED, { spotlightedUserIds: Array.from(spotlights) });
    } catch (e) {
      console.error('[rtc] spotlight toggle error:', e);
    }
  });
}
