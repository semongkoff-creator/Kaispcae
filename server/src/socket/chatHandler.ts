import { Server, Socket } from 'socket.io';
import { SocketEvents, ChatMessage } from '@virtualmeet/shared';
import { getSocketIdsInZone, isSocketInZone } from './zoneHandler';
import { socketRateLimit } from '../middleware/rateLimit';
import { isMusicCommand, handleMusicCommand } from './musicHandler';

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

    // Music Bot — !play/!skip/!pause/!resume/!queue/!stop. Detected here
    // (server-side, before anything is broadcast) so it can't be spoofed by
    // a modified client sending the raw command text expecting it to just
    // render as a normal message. A recognized command is NEVER broadcast
    // as the sender's own chat message — only the bot's reply is.
    if (isMusicCommand(text)) {
      void handleMusicCommand(io, currentRoom, zoneId, socket.id, playerName(), text)
        .catch((e) => console.error('[musicBot] handleMusicCommand failed:', e));
      return;
    }

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
    // Bug 21 — socket.to() excludes the emitting socket itself, so the
    // sender's own bubble never rendered on their own screen even though
    // everyone else in the room saw it. io.to() includes every member of
    // the room, sender included — same fix already applied to CHAT_MESSAGE
    // above (see its "sender always gets their own message" comment).
    io.to(currentRoom).emit(SocketEvents.CHAT_BUBBLE, {
      playerId: socket.id,
      text: text.slice(0, 100),
    });
  });
}
