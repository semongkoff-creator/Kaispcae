import { Server, Socket } from 'socket.io';
import { SocketEvents, EmoteEvent } from '@virtualmeet/shared';

export function registerEmoteHandlers(io: Server, socket: Socket) {
  socket.on(SocketEvents.EMOTE_PLAY, (data: { emote: string; x: number; y: number }) => {
    // QA (Akses tamu checklist item 2, "Guest terbatas") — a modified
    // client could still emit this directly even with the hotkey blocked
    // client-side (see App.tsx's keydown handler) — this is the real gate.
    if ((socket.data as { guestId?: string }).guestId) return;
    // Scoped to the sender's game room — socket.broadcast.emit would leak
    // emotes to every other room/meeting running on the same server.
    const rooms = Array.from(socket.rooms);
    const gameRoom = rooms.find((r) => r !== socket.id);
    if (!gameRoom) return;

    const event: EmoteEvent = {
      playerId: socket.id,
      emote: data.emote as EmoteEvent['emote'],
      x: data.x,
      y: data.y,
      timestamp: Date.now(),
    };
    socket.to(gameRoom).emit(SocketEvents.EMOTE_PLAY, event);
  });
}
