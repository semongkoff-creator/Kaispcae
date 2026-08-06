import { Server, Socket } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { SocketEvents, ChannelMessage } from '@virtualmeet/shared';
import { socketRateLimit } from '../middleware/rateLimit';
import { sanitizeChat } from '../middleware/validate';
import { ensureGroupConversation, ensureDmConversation } from '../lib/conversations';
import { canAccessRoomChat } from '../lib/chatAccess';
import { relayChannelMessageToLark } from '../lib/larkChatSync';


// Keyed by userId, not socket.id — a per-connection key means disconnecting
// and reconnecting resets the counter for free, which matters more here
// than for the zone-chat limiter it mirrors (chatHandler.ts's canSendChat)
// since these messages are persisted permanently rather than just relayed.
const canSendChannelChat = socketRateLimit(5); // max 5 messages/sec per user
const canSignalTyping = socketRateLimit(4); // typing pings are client-throttled; this just caps abuse

// Is this user actually in this DM? DirectConversation is still the
// authoritative store during the Conversation migration, so it answers first;
// the ConversationParticipant fallback means an id already in the new
// dm:<userAId>:<userBId> form resolves too. Step 4 deletes the first branch
// and leaves the second.
async function canAccessDm(prisma: PrismaClient, conversationId: string, userId: string): Promise<boolean> {
  const dm = await prisma.directConversation.findUnique({ where: { id: conversationId } });
  if (dm) return dm.userAId === userId || dm.userBId === userId;
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  return !!participant;
}

function toMessageDto(m: {
  id: string;
  channelId: string | null;
  conversationId: string | null;
  parentId: string | null;
  senderId: string;
  sender: { displayName: string };
  text: string;
  attachmentUrl: string | null;
  attachmentName: string | null;
  createdAt: Date;
  clientId?: string | null;
  isPinned?: boolean;
}): ChannelMessage {
  return {
    id: m.id,
    channelId: m.channelId ?? undefined,
    conversationId: m.conversationId ?? undefined,
    parentId: m.parentId ?? undefined,
    senderId: m.senderId,
    senderName: m.sender.displayName,
    text: m.text,
    attachmentUrl: m.attachmentUrl ?? undefined,
    attachmentName: m.attachmentName ?? undefined,
    createdAt: m.createdAt.getTime(),
    // Bug 6 — round-tripped so the SENDER's client can match this confirmed
    // broadcast back to the optimistic bubble it already showed (by clientId,
    // since the optimistic bubble's temp id IS the clientId) and swap it in
    // place instead of appending a duplicate. Meaningless to anyone else —
    // clientId is the sender's own dedup key, harmless to expose.
    clientId: m.clientId ?? undefined,
    isPinned: m.isPinned || undefined,
  };
}

// The attachment is always uploaded first via POST /api/uploads (see
// routes/uploads.ts), which only ever hands back a same-origin
// /api/uploads/<uuid+ext> path — never trust the client's attachmentUrl
// as-is, or it could plant an arbitrary external URL (phishing/tracking
// pixel) dressed up as a chat attachment.
function isValidAttachmentUrl(url: unknown): url is string {
  // Legacy disk uploads (/api/uploads/<uuid>.<ext>) OR A8 Lark Drive-backed
  // attachments (/api/files/<file_token>). Either way it's a same-origin path
  // this server produced — never an arbitrary/external URL from the client.
  return (
    typeof url === 'string' &&
    (/^\/api\/uploads\/[a-zA-Z0-9-]+\.[a-zA-Z0-9]{1,10}$/.test(url) || /^\/api\/files\/[a-zA-Z0-9_-]+$/.test(url))
  );
}

// A client-generated send id (see ChatMessage.clientId). Bounded because it
// lands in a UNIQUE index: unbounded client-supplied strings there are an
// easy way to bloat it. Absent/malformed just means "no dedup for this send"
// — never a rejection, so an older client that doesn't send one still works.
function normalizeClientId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64) return null;
  return trimmed;
}

// Persist a send, but treat a repeat of the same (conversation, clientId) as
// the SAME message rather than a second one.
//
// The dedup is the database's, not a check-then-insert: two retries racing
// each other would both pass a findFirst before either commits, and the
// second would still double-post. Letting the UNIQUE index reject the loser
// and then reading back the winner is the only version without that window.
//
// Returns duplicate:true when the row already existed, so the caller can tell
// the sender's own client about it without re-broadcasting a message everyone
// else already has on screen.
async function createMessageDeduped(
  prisma: PrismaClient,
  data: Parameters<PrismaClient['chatMessage']['create']>[0]['data'] & { conversationId2: string },
  clientId: string | null,
) {
  const include = { sender: { select: { displayName: true } } } as const;
  try {
    const message = await prisma.chatMessage.create({ data: { ...data, clientId }, include });
    return { message, duplicate: false };
  } catch (e: any) {
    if (e?.code !== 'P2002' || !clientId) throw e;
    const existing = await prisma.chatMessage.findFirst({
      where: { conversationId2: data.conversationId2, clientId },
      include,
    });
    if (!existing) throw e;
    return { message: existing, duplicate: true };
  }
}

// Persisted Channel/DM/Thread chat. Self-contained, like followHandler.ts's
// own uid/socket tracking — doesn't reach into chatHandler.ts's or
// roomHandler.ts's private maps, just trusts socket.data.userId (set at
// handshake auth, see index.ts) for who's actually sending. A socket only
// joins the ONE channel/DM socket.io room it currently has open in
// ChatPanel.tsx, switching via *_JOIN/*_LEAVE — mirrors zoneHandler.ts's
// enter/exit tracking rather than joining every channel up front.
export function registerChannelChatHandlers(io: Server, socket: Socket) {
  socket.on(SocketEvents.CHANNEL_JOIN, async (channelId: string) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId || typeof channelId !== 'string' || !channelId) return;
    try {
      const prisma = getPrisma();
      const channel = await prisma.channel.findUnique({ where: { id: channelId }, include: { room: true } });
      if (!channel || !(await canAccessRoomChat(prisma, channel.room, userId))) return;
      socket.join(`channel:${channelId}`);
    } catch (e) {
      console.error('[channelChat] failed to authorize channel join:', e);
    }
  });

  socket.on(SocketEvents.CHANNEL_LEAVE, (channelId: string) => {
    if (typeof channelId === 'string' && channelId) socket.leave(`channel:${channelId}`);
  });

  // Authorized exactly like CHANNEL_JOIN above. This check was missing
  // entirely: joining a DM's socket room took nothing but the conversationId,
  // so anyone holding one received that pair's messages and typing signals
  // live. Sending was already gated (DM_MESSAGE_SEND re-checks the pair) —
  // it was reading that was open, which is the quieter half to miss.
  //
  // Random cuids made that hard to exploit by guesswork. That was luck, not a
  // control, and it is about to run out: conversation ids become
  // dm:<userAId>:<userBId> (see the Conversation model), i.e. derivable by
  // anyone who has seen two user ids — and user ids travel in ordinary socket
  // payloads. An unauthorized join must be impossible before the ids become
  // predictable, not after.
  socket.on(SocketEvents.DM_JOIN, async (conversationId: string) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId || typeof conversationId !== 'string' || !conversationId) return;
    try {
      const prisma = getPrisma();
      if (!(await canAccessDm(prisma, conversationId, userId))) return;
      socket.join(`dm:${conversationId}`);
    } catch (e) {
      console.error('[channelChat] failed to authorize DM join:', e);
    }
  });

  // Typing relays — transient, no DB. The sender must already have JOINed the
  // target's socket room (so it's the same access-gated room the messages flow
  // through); we just forward the sender's userId to the OTHER members, who
  // resolve the display name locally. socket.to(...) excludes the sender.
  socket.on(SocketEvents.CHANNEL_TYPING, (channelId: string) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId || typeof channelId !== 'string' || !channelId || !canSignalTyping(userId)) return;
    socket.to(`channel:${channelId}`).emit(SocketEvents.CHANNEL_TYPING_UPDATE, { channelId, userId });
  });

  socket.on(SocketEvents.DM_TYPING, (conversationId: string) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId || typeof conversationId !== 'string' || !conversationId || !canSignalTyping(userId)) return;
    socket.to(`dm:${conversationId}`).emit(SocketEvents.DM_TYPING_UPDATE, { conversationId, userId });
  });

  socket.on(SocketEvents.MESSAGE_DELETE, async (payload: { messageId: string }) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId || typeof payload?.messageId !== 'string') return;
    try {
      const prisma = getPrisma();
      const msg = await prisma.chatMessage.findUnique({ where: { id: payload.messageId } });
      // Own messages only — no admin-delete in this pass. A missing/foreign
      // message is silently ignored (nothing to do, and we don't leak whether
      // an id exists).
      if (!msg || msg.senderId !== userId) return;
      // Deleting a parent cascades its thread replies (see schema's
      // ThreadReplies onDelete: Cascade), so one delete cleans the whole
      // subtree; clients drop replies on their own when the parent goes.
      await prisma.chatMessage.delete({ where: { id: msg.id } });
      const room = msg.channelId ? `channel:${msg.channelId}` : `dm:${msg.conversationId}`;
      io.to(room).emit(SocketEvents.MESSAGE_DELETED, {
        messageId: msg.id,
        channelId: msg.channelId ?? undefined,
        conversationId: msg.conversationId ?? undefined,
        parentId: msg.parentId ?? undefined,
      });
    } catch (e) {
      console.error('[channelChat] failed to delete message:', e);
    }
  });

  socket.on(SocketEvents.MESSAGE_EDIT, async (payload: { messageId: string; text: string }) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId || typeof payload?.messageId !== 'string') return;
    const text = sanitizeChat(payload?.text || '');
    if (!text) return; // an empty edit would be a delete — use MESSAGE_DELETE for that
    try {
      const prisma = getPrisma();
      const msg = await prisma.chatMessage.findUnique({ where: { id: payload.messageId } });
      if (!msg || msg.senderId !== userId) return; // own messages only
      // Attachment-only messages have no text to edit — skip rather than
      // silently blanking the message body next to its file.
      if (!msg.text) return;
      await prisma.chatMessage.update({ where: { id: msg.id }, data: { text } });
      const room = msg.channelId ? `channel:${msg.channelId}` : `dm:${msg.conversationId}`;
      io.to(room).emit(SocketEvents.MESSAGE_EDITED, {
        messageId: msg.id,
        channelId: msg.channelId ?? undefined,
        conversationId: msg.conversationId ?? undefined,
        parentId: msg.parentId ?? undefined,
        text,
      });
    } catch (e) {
      console.error('[channelChat] failed to edit message:', e);
    }
  });

  // Pin/unpin — open to anyone who can access this channel/DM (re-checked
  // here, same as CHANNEL_JOIN/DM_JOIN do at join time), NOT limited to the
  // sender the way MESSAGE_DELETE/MESSAGE_EDIT are. Curating important
  // messages for the whole thread isn't modifying someone else's content —
  // it's the same "anyone can do it" posture as Slack/Discord's own pin.
  socket.on(SocketEvents.MESSAGE_PIN, async (payload: { messageId: string; pinned: boolean }) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId || typeof payload?.messageId !== 'string') return;
    try {
      const prisma = getPrisma();
      const msg = await prisma.chatMessage.findUnique({ where: { id: payload.messageId } });
      if (!msg) return;
      if (msg.channelId) {
        const channel = await prisma.channel.findUnique({ where: { id: msg.channelId }, include: { room: true } });
        if (!channel || !(await canAccessRoomChat(prisma, channel.room, userId))) return;
      } else if (msg.conversationId) {
        if (!(await canAccessDm(prisma, msg.conversationId, userId))) return;
      } else {
        return; // orphaned message (shouldn't happen) — nothing to authorize against
      }
      const pinned = !!payload.pinned;
      await prisma.chatMessage.update({ where: { id: msg.id }, data: { isPinned: pinned } });
      const room = msg.channelId ? `channel:${msg.channelId}` : `dm:${msg.conversationId}`;
      io.to(room).emit(SocketEvents.MESSAGE_PINNED, {
        messageId: msg.id,
        channelId: msg.channelId ?? undefined,
        conversationId: msg.conversationId ?? undefined,
        pinned,
      });
    } catch (e) {
      console.error('[channelChat] failed to pin/unpin message:', e);
    }
  });

  socket.on(SocketEvents.DM_LEAVE, (conversationId: string) => {
    if (typeof conversationId === 'string' && conversationId) socket.leave(`dm:${conversationId}`);
  });

  socket.on(SocketEvents.CHANNEL_MESSAGE_SEND, async (payload: { channelId: string; text: string; parentId?: string; attachmentUrl?: string; attachmentName?: string; clientId?: string }) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId || !canSendChannelChat(userId)) return;
    const text = sanitizeChat(payload?.text || '');
    const hasAttachment = isValidAttachmentUrl(payload?.attachmentUrl);
    // A message needs SOME content — text, an attachment, or both — never
    // neither (an empty attachment-less send is just a no-op click).
    if ((!text && !hasAttachment) || !payload?.channelId) return;

    try {
      const prisma = getPrisma();
      const channel = await prisma.channel.findUnique({ where: { id: payload.channelId }, include: { room: true } });
      if (!channel || !(await canAccessRoomChat(prisma, channel.room, userId))) return;

      // A client-supplied parentId must actually belong to THIS channel —
      // otherwise a reply could be planted under a message pulled from an
      // unrelated channel/DM the sender has no business referencing.
      if (payload.parentId) {
        const parent = await prisma.chatMessage.findUnique({ where: { id: payload.parentId } });
        if (!parent || parent.channelId !== payload.channelId) return;
      }

      // Dual-write: channelId stays authoritative, conversationId2 is kept in
      // lockstep so the two never disagree about where a message lives. The
      // ensure* call is what makes this safe for a channel created before the
      // Conversation model existed — its mirror row may not exist yet, and
      // conversationId2 is a real FK.
      const conversationId2 = await ensureGroupConversation(prisma, channel);

      const { message, duplicate } = await createMessageDeduped(prisma, {
        channelId: payload.channelId,
        conversationId2,
        parentId: payload.parentId || null,
        senderId: userId,
        text,
        attachmentUrl: hasAttachment ? payload.attachmentUrl : null,
        attachmentName: hasAttachment ? (payload.attachmentName || '').slice(0, 200) || null : null,
      }, normalizeClientId(payload?.clientId));

      // A duplicate goes back to the sender alone: everyone else in the
      // channel already received this message from the send that won, and
      // re-broadcasting would paint it twice on their screens.
      const target = duplicate ? socket : io.to(`channel:${payload.channelId}`);
      target.emit(SocketEvents.CHANNEL_MESSAGE_NEW, toMessageDto(message));

      // Bagian 4 — relay to the mapped Lark group (default channel only).
      // Fire-and-forget: a Lark outage must never fail the MeetKai send. Skip
      // duplicates (already relayed by the original send) and attachment-only
      // messages (empty text; the helper no-ops on those too).
      if (!duplicate && text) {
        void relayChannelMessageToLark(prisma, channel, userId, message.sender.displayName, text).catch((e) =>
          console.error('[channelChat] Lark relay failed:', e),
        );
      }
    } catch (e) {
      console.error('[channelChat] failed to persist channel message:', e);
    }
  });

  socket.on(SocketEvents.DM_MESSAGE_SEND, async (payload: { conversationId: string; text: string; parentId?: string; attachmentUrl?: string; attachmentName?: string; clientId?: string }) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId || !canSendChannelChat(userId)) return;
    const text = sanitizeChat(payload?.text || '');
    const hasAttachment = isValidAttachmentUrl(payload?.attachmentUrl);
    if ((!text && !hasAttachment) || !payload?.conversationId) return;

    try {
      const prisma = getPrisma();
      // Confirm the sender is actually a participant before persisting —
      // never trust a client-supplied conversationId alone.
      const conversation = await prisma.directConversation.findUnique({ where: { id: payload.conversationId } });
      if (!conversation || (conversation.userAId !== userId && conversation.userBId !== userId)) return;

      // Same cross-context guard as the channel handler above — a
      // client-supplied parentId must belong to this exact conversation.
      if (payload.parentId) {
        const parent = await prisma.chatMessage.findUnique({ where: { id: payload.parentId } });
        if (!parent || parent.conversationId !== payload.conversationId) return;
      }

      // Dual-write, same as the channel handler above.
      const conversationId2 = await ensureDmConversation(prisma, {
        userAId: conversation.userAId,
        userBId: conversation.userBId,
        roomId: conversation.roomId,
        createdAt: conversation.createdAt,
      });

      const { message, duplicate } = await createMessageDeduped(prisma, {
        conversationId: payload.conversationId,
        conversationId2,
        parentId: payload.parentId || null,
        senderId: userId,
        text,
        attachmentUrl: hasAttachment ? payload.attachmentUrl : null,
        attachmentName: hasAttachment ? (payload.attachmentName || '').slice(0, 200) || null : null,
      }, normalizeClientId(payload?.clientId));

      const target = duplicate ? socket : io.to(`dm:${payload.conversationId}`);
      target.emit(SocketEvents.DM_MESSAGE_NEW, toMessageDto(message));
    } catch (e) {
      console.error('[channelChat] failed to persist DM message:', e);
    }
  });
}
