import { Server, Socket } from 'socket.io';
import { SocketEvents, ChatMessage } from '@virtualmeet/shared';

let messageId = 0;

export function registerChatHandlers(io: Server, socket: Socket, playerName: () => string, playerColor: () => string) {
  socket.on(SocketEvents.CHAT_MESSAGE, (text: string, isProximity?: boolean) => {
    const msg: ChatMessage = {
      id: `msg-${++messageId}`,
      senderId: socket.id,
      senderName: playerName(),
      senderColor: playerColor(),
      text: text.slice(0, 200),
      timestamp: Date.now(),
      isProximity: !!isProximity,
    };
    io.emit(SocketEvents.CHAT_BROADCAST, msg);
  });

  socket.on(SocketEvents.CHAT_BUBBLE, (text: string) => {
    socket.broadcast.emit(SocketEvents.CHAT_BUBBLE, {
      playerId: socket.id,
      text: text.slice(0, 100),
    });
  });
}
