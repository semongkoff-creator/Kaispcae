import { Server, Socket } from 'socket.io';
import { SocketEvents, ChatMessage } from '@virtualmeet/shared';
import { getSocketIdsInZone } from './zoneHandler';
import { socketRateLimit } from '../middleware/rateLimit';

let messageId = 0;
const canSendChat = socketRateLimit(5); // max 5 chat messages/sec per socket

export function registerChatHandlers(io: Server, socket: Socket, playerName: () => string, playerColor: () => string) {
  let currentRoom: string | null = null;

  socket.on(SocketEvents.JOIN_ROOM, (roomId: string) => {
    currentRoom = roomId || 'main-office';
  });

  socket.on(SocketEvents.CHAT_MESSAGE, (text: string, isProximity?: boolean, zoneId?: string) => {
    if (!canSendChat(socket.id)) return;
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

    // Scoped to the sender's room — io.emit() here would leak chat across
    // every other room/meeting running on the same server.
    io.to(currentRoom || 'main-office').emit(SocketEvents.CHAT_BROADCAST, msg);
  });

  socket.on(SocketEvents.CHAT_BUBBLE, (text: string) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit(SocketEvents.CHAT_BUBBLE, {
      playerId: socket.id,
      text: text.slice(0, 100),
    });
  });
}
