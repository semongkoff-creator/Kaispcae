import { Server, Socket } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { SocketEvents, RtcSignal, Role, hasFeatureAccess } from '@virtualmeet/shared';
import { resolveRoomRole } from '../lib/roles';


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
  return resolveRoomRole(prisma, userId, dbRoom.id, dbRoom.ownerId);
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
    const ok = !!myRoom && !!targetSocket && targetSocket.rooms.has(myRoom);
    // [webrtc-diag] TEMPORARY — this relay drops signals silently, so a
    // mismatch here is invisible from the client: offers simply never
    // arrive, no error anywhere. Logging both sides' room sets makes a drop
    // (and WHY) readable straight from the server log. Remove once the
    // two-way audio cause is confirmed and fixed.
    console.log('[webrtc-diag]', ok ? 'relay OK' : 'relay DROPPED', {
      event: event.replace('rtc:', ''),
      from: socket.id,
      to: signal.toId,
      myRoom,
      myRooms: Array.from(socket.rooms).filter((r) => r !== socket.id),
      targetFound: !!targetSocket,
      targetRooms: targetSocket ? Array.from(targetSocket.rooms).filter((r) => r !== targetSocket.id) : null,
    });
    if (!ok) return;
    io.to(signal.toId).emit(event, { ...signal, fromId: socket.id });
  }

  // Broadcast, not relayed to one peer: anyone already in the room needs it,
  // and so does anyone who walks up later (the client re-announces on each new
  // peer connection). fromId is set server-side from the real socket, never
  // taken from the payload — same rule as the offer/answer relay below, so a
  // client can't claim someone else's screen is theirs.
  socket.on(SocketEvents.RTC_SCREEN_SHARE, (data: { streamId: string | null }) => {
    const room = getSocketRoom(socket);
    if (!room) return;
    const streamId = typeof data?.streamId === 'string' ? data.streamId.slice(0, 200) : null;
    socket.to(room).emit(SocketEvents.RTC_SCREEN_SHARE, { fromId: socket.id, streamId });
  });

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
