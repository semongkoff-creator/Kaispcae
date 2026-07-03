import { Server, Socket } from 'socket.io';
import { SocketEvents } from '@virtualmeet/shared';

export function registerZoneHandlers(io: Server, socket: Socket) {
  socket.on(SocketEvents.ZONE_ENTER, (zoneId: string) => {
    socket.broadcast.emit(SocketEvents.ZONE_ENTER, { playerId: socket.id, zoneId });
  });

  socket.on(SocketEvents.ZONE_EXIT, (zoneId: string) => {
    socket.broadcast.emit(SocketEvents.ZONE_EXIT, { playerId: socket.id, zoneId });
  });
}
