import { Server, Socket } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { SocketEvents, ChannelMessage } from '@virtualmeet/shared';
import { socketRateLimit } from '../middleware/rateLimit';
import { sanitizeChat } from '../middleware/validate';

function getPrisma(): PrismaClient {
  return new PrismaClient();
}

// Keyed by userId, not socket.id — a per-connection key means disconnecting
// and reconnecting resets the counter for free, which matters more here
// than for the zone-chat limiter it mirrors (chatHandler.ts's canSendChat)
// since these messages are persisted permanently rather than just relayed.
const canSendChannelChat = socketRateLimit(5); // max 5 messages/sec per user

// Mirrors routes/chat.ts's canAccessRoomChat (small deliberate duplication
// for decoupling, same convention as followHandler.ts's own uid/socket
// tracking) — without this, joining a channel's socket room or sending
// into it required nothing but a guessed/leaked channelId, letting anyone
// silently eavesdrop on (or post into) a private room's chat they were
// never part of. Also lets a global admin account (see shared/permissions.ts's
// AccountRole) into any room's chat, same as routes/chat.ts's copy.
async function canAccessRoomChat(prisma: PrismaClient, room: { id: string; ownerId: string; isPublic: boolean }, userId: string): Promise<boolean> {
  if (room.isPublic) return true;
  if (userId === room.ownerId) return true;
  const [user, member] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { accountRole: true } }),
    prisma.roomMember.findUnique({ where: { userId_roomId: { userId, roomId: room.id } } }),
  ]);
  if (user?.accountRole === 'admin') return true;
  return !!member;
}

function toMessageDto(m: {
  id: string;
  channelId: string | null;
  conversationId: string | null;
  parentId: string | null;
  senderId: string;
  sender: { displayName: string };
  text: string;
  createdAt: Date;
}): ChannelMessage {
  return {
    id: m.id,
    channelId: m.channelId ?? undefined,
    conversationId: m.conversationId ?? undefined,
    parentId: m.parentId ?? undefined,
    senderId: m.senderId,
    senderName: m.sender.displayName,
    text: m.text,
    createdAt: m.createdAt.getTime(),
  };
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

  socket.on(SocketEvents.DM_JOIN, (conversationId: string) => {
    if (typeof conversationId === 'string' && conversationId) socket.join(`dm:${conversationId}`);
  });

  socket.on(SocketEvents.DM_LEAVE, (conversationId: string) => {
    if (typeof conversationId === 'string' && conversationId) socket.leave(`dm:${conversationId}`);
  });

  socket.on(SocketEvents.CHANNEL_MESSAGE_SEND, async (payload: { channelId: string; text: string; parentId?: string }) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId || !canSendChannelChat(userId)) return;
    const text = sanitizeChat(payload?.text || '');
    if (!text || !payload?.channelId) return;

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

      const message = await prisma.chatMessage.create({
        data: {
          channelId: payload.channelId,
          parentId: payload.parentId || null,
          senderId: userId,
          text,
        },
        include: { sender: { select: { displayName: true } } },
      });
      io.to(`channel:${payload.channelId}`).emit(SocketEvents.CHANNEL_MESSAGE_NEW, toMessageDto(message));
    } catch (e) {
      console.error('[channelChat] failed to persist channel message:', e);
    }
  });

  socket.on(SocketEvents.DM_MESSAGE_SEND, async (payload: { conversationId: string; text: string; parentId?: string }) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId || !canSendChannelChat(userId)) return;
    const text = sanitizeChat(payload?.text || '');
    if (!text || !payload?.conversationId) return;

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

      const message = await prisma.chatMessage.create({
        data: {
          conversationId: payload.conversationId,
          parentId: payload.parentId || null,
          senderId: userId,
          text,
        },
        include: { sender: { select: { displayName: true } } },
      });
      io.to(`dm:${payload.conversationId}`).emit(SocketEvents.DM_MESSAGE_NEW, toMessageDto(message));
    } catch (e) {
      console.error('[channelChat] failed to persist DM message:', e);
    }
  });
}
