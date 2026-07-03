import { Server, Socket } from 'socket.io';
import { SocketEvents } from '@virtualmeet/shared';

// Actual A/V zone restriction is computed client-side (see useProximity.ts —
// every client already knows every player's position and the room's zones,
// so it derives membership locally with no round trip). This handler just
// relays enter/exit so other clients in the SAME room can react (e.g. a
// "so-and-so joined the meeting room" indicator). Scoped with socket.to(room)
// instead of socket.broadcast so it doesn't leak across unrelated rooms.
export function registerZoneHandlers(io: Server, socket: Socket) {
  let currentRoom: string | null = null;

  socket.on(SocketEvents.JOIN_ROOM, (roomId: string) => {
    currentRoom = roomId || 'main-office';
  });

  socket.on(SocketEvents.ZONE_ENTER, (zoneId: string) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit(SocketEvents.ZONE_ENTER, { playerId: socket.id, zoneId });
  });

  socket.on(SocketEvents.ZONE_EXIT, (zoneId: string) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit(SocketEvents.ZONE_EXIT, { playerId: socket.id, zoneId });
  });
}
