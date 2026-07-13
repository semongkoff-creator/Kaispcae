import { Server, Socket } from 'socket.io';
import { SocketEvents, ChatMessage } from '@virtualmeet/shared';
import { getSocketIdsInZone, isSocketInZone } from './zoneHandler';
import { socketRateLimit } from '../middleware/rateLimit';

let messageId = 0;
const canSendChat = socketRateLimit(5); // max 5 chat messages/sec per socket

export function registerChatHandlers(io: Server, socket: Socket, playerName: () => string, playerColor: () => string) {
  let currentRoom: string | null = null;

  socket.on(SocketEvents.JOIN_ROOM, (roomId: string) => {
    currentRoom = roomId || 'main-office';
  });

  // Zone-private chat only — the old whole-room broadcast case (no zoneId)
  // is superseded by the room's persisted default Channel (see
  // channelChatHandler.ts's CHANNEL_MESSAGE_SEND); this event now only
  // fires for the "Private" zone tab in ChatPanel.tsx.
  socket.on(SocketEvents.CHAT_MESSAGE, (text: string, isProximity?: boolean, zoneId?: string) => {
    if (!canSendChat(socket.id)) return;
    // Reject a claimed zone chat from a sender not actually tracked as
    // being inside that zone — the client-side UI already hides the
    // private tab once you leave (see ChatPanel.tsx), but a modified
    // client could still emit this directly with a stale/spoofed zoneId.
    if (!zoneId || !(currentRoom && isSocketInZone(currentRoom, socket.id, zoneId))) return;
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
    const recipients = new Set(getSocketIdsInZone(currentRoom, zoneId));
    recipients.add(socket.id);
    for (const socketId of recipients) {
      io.to(socketId).emit(SocketEvents.CHAT_BROADCAST, msg);
    }
  });

  socket.on(SocketEvents.CHAT_BUBBLE, (text: string) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit(SocketEvents.CHAT_BUBBLE, {
      playerId: socket.id,
      text: text.slice(0, 100),
    });
  });
}
