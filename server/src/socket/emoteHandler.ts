import { Server, Socket } from 'socket.io';
import { SocketEvents, EmoteEvent } from '@virtualmeet/shared';

export function registerEmoteHandlers(io: Server, socket: Socket) {
  socket.on(SocketEvents.EMOTE_PLAY, (data: { emote: string; x: number; y: number }) => {
    const event: EmoteEvent = {
      playerId: socket.id,
      emote: data.emote as EmoteEvent['emote'],
      x: data.x,
      y: data.y,
      timestamp: Date.now(),
    };
    socket.broadcast.emit(SocketEvents.EMOTE_PLAY, event);
  });
}
