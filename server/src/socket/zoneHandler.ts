import { Server, Socket } from 'socket.io';
import { SocketEvents } from '@virtualmeet/shared';

// Actual A/V zone restriction is computed client-side (see useProximity.ts —
// every client already knows every player's position and the room's zones,
// so it derives membership locally with no round trip). This handler relays
// enter/exit so other clients in the SAME room can react (e.g. a "so-and-so
// joined the meeting room" indicator), and tracks who's in which zone so
// zone-scoped chat (see chatHandler.ts) can be routed to only those sockets.
const socketZone = new Map<string, { room: string; zoneId: string }>();

export function getSocketIdsInZone(room: string, zoneId: string): string[] {
  const ids: string[] = [];
  for (const [socketId, loc] of socketZone) {
    if (loc.room === room && loc.zoneId === zoneId) ids.push(socketId);
  }
  return ids;
}

// Used by chatHandler.ts to reject a zone-scoped CHAT_MESSAGE from a socket
// that isn't actually tracked as being inside that zone — previously any
// socket could attach any zoneId to a message and it would be routed to
// that zone's chat regardless of whether the sender was really there,
// since only the RECIPIENTS were computed from real zone membership, never
// the sender's own claim (see §1.3's "reject send_chat kalau
// player.currentAreaId tidak sesuai" rule).
export function isSocketInZone(room: string, socketId: string, zoneId: string): boolean {
  const loc = socketZone.get(socketId);
  return !!loc && loc.room === room && loc.zoneId === zoneId;
}

export function registerZoneHandlers(io: Server, socket: Socket) {
  let currentRoom: string | null = null;

  socket.on(SocketEvents.JOIN_ROOM, (roomId: string) => {
    currentRoom = roomId || 'main-office';
  });

  socket.on(SocketEvents.ZONE_ENTER, (zoneId: string) => {
    if (!currentRoom) return;
    socketZone.set(socket.id, { room: currentRoom, zoneId });
    socket.to(currentRoom).emit(SocketEvents.ZONE_ENTER, { playerId: socket.id, zoneId });
  });

  socket.on(SocketEvents.ZONE_EXIT, (zoneId: string) => {
    if (!currentRoom) return;
    socketZone.delete(socket.id);
    socket.to(currentRoom).emit(SocketEvents.ZONE_EXIT, { playerId: socket.id, zoneId });
  });

  socket.on(SocketEvents.DISCONNECT, () => {
    socketZone.delete(socket.id);
  });
}
