import { Server, Socket } from 'socket.io';
import { SocketEvents, ChatMessage } from '@virtualmeet/shared';
import { getSocketIdsInZone } from './zoneHandler';

let messageId = 0;

export function registerChatHandlers(io: Server, socket: Socket, playerName: () => string, playerColor: () => string) {
  let currentRoom: string | null = null;

  socket.on(SocketEvents.JOIN_ROOM, (roomId: string) => {
    currentRoom = roomId || 'main-office';
  });

  socket.on(SocketEvents.CHAT_MESSAGE, (text: string, isProximity?: boolean, zoneId?: string) => {
    const msg: ChatMessage = {
      id: `msg-${++messageId}`,
      senderId: socket.id,
      senderName: playerName(),
      senderColor: playerColor(),
      text: text.slice(0, 200),
      timestamp: Date.now(),
      isProximity: !!isProximity,
      zoneId,
    };

    // Zone-private messages only go to sockets currently tracked as inside
    // that zone (see zoneHandler.ts) — never the whole room/server. The
    // sender always gets their own message even if the zone-membership
    // tracking hasn't caught up yet (e.g. right at zone entry).
    if (zoneId && currentRoom) {
      const recipients = new Set(getSocketIdsInZone(currentRoom, zoneId));
      recipients.add(socket.id);
      for (const socketId of recipients) {
        io.to(socketId).emit(SocketEvents.CHAT_BROADCAST, msg);
      }
      return;
    }

    io.emit(SocketEvents.CHAT_BROADCAST, msg);
  });

  socket.on(SocketEvents.CHAT_BUBBLE, (text: string) => {
    socket.broadcast.emit(SocketEvents.CHAT_BUBBLE, {
      playerId: socket.id,
      text: text.slice(0, 100),
    });
  });
}
