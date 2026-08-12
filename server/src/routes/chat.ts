import { Router, Response } from 'express';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { SocketEvents, Channel, ChannelMessage, ConversationPreview, DirectConversationSummary, DirectConversationStarted, Role, hasFeatureAccess } from '@kaispace/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { validate, createChannelSchema, startDmSchema, sanitizeChat } from '../middleware/validate';
import { resolveRoomRole as resolveRoomRoleShared } from '../lib/roles';
import { ensureGroupConversation, ensureDmConversation, groupConversationId, dmConversationId } from '../lib/conversations';
import { canAccessRoomChat } from '../lib/chatAccess';
import { findRoomInOrg, findUserInOrg } from '../lib/orgScope';

const chat = Router();


// Set once from index.ts, same pattern as routes/rooms.ts's ioRef — lets
// channel create/delete notify every connected client in the room so their
// channel switcher list stays live without polling.
let ioRef: Server | null = null;
export function setIo(io: Server): void {
  ioRef = io;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

function parseLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// Thin wrapper over the shared resolver (see lib/roles.ts) — kept as a
// local name matching this file's existing (room, userId) argument order so
// none of the call sites below needed to change.
async function resolveRoomRole(prisma: PrismaClient, room: { id: string; ownerId: string; organizationId: string }, userId: string): Promise<Role> {
  return resolveRoomRoleShared(prisma, userId, room.id, room.ownerId, room.organizationId);
}

function toChannelDto(c: { id: string; roomId: string; name: string; isDefault: boolean; createdAt: Date }, lastMessage?: ConversationPreview): Channel {
  return { id: c.id, roomId: c.roomId, name: c.name, isDefault: c.isDefault, createdAt: c.createdAt.getTime(), ...(lastMessage ? { lastMessage } : {}) };
}

// The newest top-level message for each of the given conversations, in ONE
// query — the messenger sidebar needs a preview per row, and doing that per
// row would be a query per conversation on every list load.
//
// Keyed by conversationId2 (the new column), so this is also a live check
// that the backfill is complete: a conversation whose messages never got one
// would silently preview as empty.
async function lastMessagesByConversation(
  prisma: PrismaClient,
  conversationIds: string[],
): Promise<Map<string, ConversationPreview>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await prisma.chatMessage.findMany({
    where: { conversationId2: { in: conversationIds }, parentId: null },
    orderBy: { createdAt: 'desc' },
    distinct: ['conversationId2'],
    include: { sender: { select: { displayName: true } } },
  });
  return new Map(
    rows.map((m) => [
      m.conversationId2!,
      {
        senderName: m.sender.displayName,
        // An attachment-only message has empty text — preview the filename
        // instead of a blank row.
        text: m.text || m.attachmentName || 'Lampiran',
        createdAt: m.createdAt.getTime(),
      },
    ]),
  );
}

function toMessageDto(m: {
  id: string;
  channelId: string | null;
  conversationId: string | null;
  parentId: string | null;
  senderId: string;
  sender: { displayName: string };
  text: string;
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  createdAt: Date;
  _count?: { replies: number };
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
    replyCount: m._count?.replies,
    isPinned: m.isPinned || undefined,
  };
}

function toDmSummaryDto(
  c: {
    id: string;
    roomId: string;
    createdAt: Date;
    userAId: string;
    userBId: string;
    userA: { id: string; displayName: string };
    userB: { id: string; displayName: string };
  },
  viewerId: string,
  lastMessage?: ConversationPreview
): DirectConversationSummary {
  const other = c.userAId === viewerId ? c.userB : c.userA;
  return {
    id: c.id,
    roomId: c.roomId,
    otherUser: { id: other.id, displayName: other.displayName },
    createdAt: c.createdAt.getTime(),
    ...(lastMessage ? { lastMessage } : {}),
  };
}

// GET /api/rooms/:slug/channels — lazily backfills a "general" channel for
// rooms created before this feature existed (see rooms.ts's POST /rooms,
// which now creates one up front for every new room).
chat.get('/rooms/:slug/channels', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    // Multi-tenant Fase 3 — chat.ts was never touched in Fase 2's route
    // sweep; every raw room lookup by slug in this file gets the same
    // findRoomInOrg treatment as every other file's did.
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!(await canAccessRoomChat(prisma, room, req.userId!, req.organizationId))) {
      return res.status(403).json({ error: 'Not a member of this room' });
    }

    let channels = await prisma.channel.findMany({ where: { roomId: room.id }, orderBy: { createdAt: 'asc' } });
    if (channels.length === 0) {
      const general = await prisma.channel.create({ data: { roomId: room.id, name: 'general', isDefault: true } });
      await ensureGroupConversation(prisma, general);
      channels = [general];
    }
    const previews = await lastMessagesByConversation(prisma, channels.map((c) => groupConversationId(c.id)));
    return res.json({ channels: channels.map((c) => toChannelDto(c, previews.get(groupConversationId(c.id)))) });
  } catch (err) {
    console.error('[chat] list channels error:', err);
    return res.status(500).json({ error: 'Failed to list channels' });
  }
});

// POST /api/rooms/:slug/channels — admin+ only (see shared/permissions.ts)
chat.post('/rooms/:slug/channels', authenticateToken, validate(createChannelSchema), async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const role = await resolveRoomRole(prisma, room, req.userId!);
    if (!hasFeatureAccess(role, 'channel:create')) {
      return res.status(403).json({ error: 'Only room admins can create channels' });
    }

    const name = sanitizeChat(req.body.name).slice(0, 30) || 'channel';
    const channel = await prisma.channel.create({ data: { roomId: room.id, name } });
    await ensureGroupConversation(prisma, channel);

    if (ioRef) ioRef.to(room.slug).emit(SocketEvents.CHANNEL_CREATED, toChannelDto(channel));
    return res.status(201).json({ channel: toChannelDto(channel) });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: 'A channel with that name already exists' });
    }
    console.error('[chat] create channel error:', err);
    return res.status(500).json({ error: 'Failed to create channel' });
  }
});

// DELETE /api/rooms/:slug/channels/:channelId — admin+ only, the default
// channel can never be deleted (every room needs at least one channel).
chat.delete('/rooms/:slug/channels/:channelId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const channel = await prisma.channel.findUnique({ where: { id: req.params.channelId } });
    if (!channel || channel.roomId !== room.id) return res.status(404).json({ error: 'Channel not found' });
    if (channel.isDefault) return res.status(400).json({ error: 'Cannot delete the default channel' });

    const role = await resolveRoomRole(prisma, room, req.userId!);
    if (!hasFeatureAccess(role, 'channel:delete')) {
      return res.status(403).json({ error: 'Only room admins can delete channels' });
    }

    await prisma.channel.delete({ where: { id: channel.id } });
    if (ioRef) ioRef.to(room.slug).emit(SocketEvents.CHANNEL_DELETED, { channelId: channel.id });
    return res.json({ success: true });
  } catch (err) {
    console.error('[chat] delete channel error:', err);
    return res.status(500).json({ error: 'Failed to delete channel' });
  }
});

// GET /api/rooms/:slug/channels/:channelId/messages?before=<messageId>&limit=50
// Top-level only (parentId: null) — thread replies are fetched separately
// via GET /messages/:messageId/replies below. Returned oldest-first (the
// order a chat scrollback reads in); `before` cursors to strictly older
// messages for "load older" at the top of the panel.
chat.get('/rooms/:slug/channels/:channelId/messages', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!(await canAccessRoomChat(prisma, room, req.userId!, req.organizationId))) {
      return res.status(403).json({ error: 'Not a member of this room' });
    }

    const channel = await prisma.channel.findUnique({ where: { id: req.params.channelId } });
    if (!channel || channel.roomId !== room.id) return res.status(404).json({ error: 'Channel not found' });

    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    // Reads through the new column; channelId is still written alongside it
    // (see channelChatHandler.ts's dual-write) and stays the rollback path.
    // Every pre-existing message was backfilled, so this returns the same set
    // — verified against the live database before the switch, not assumed.
    const messages = await prisma.chatMessage.findMany({
      where: { conversationId2: groupConversationId(channel.id), parentId: null },
      orderBy: { createdAt: 'desc' },
      take: parseLimit(req.query.limit),
      ...(before ? { cursor: { id: before }, skip: 1 } : {}),
      include: { sender: { select: { displayName: true } }, _count: { select: { replies: true } } },
    });
    return res.json({ messages: messages.reverse().map(toMessageDto) });
  } catch (err) {
    console.error('[chat] list channel messages error:', err);
    return res.status(500).json({ error: 'Failed to load messages' });
  }
});

// GET /api/messages/:messageId/replies?before=&limit= — thread view for one
// parent message. No room/channel slug in the path since a message id is
// already globally unique, but that means membership must be resolved
// explicitly from the parent's own channel/conversation — it is NOT
// implicit just because the caller supplies a valid id (a message id isn't
// a secret; anyone who ever saw one anywhere could otherwise use it to read
// a thread they have no right to).
chat.get('/messages/:messageId/replies', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const parent = await prisma.chatMessage.findUnique({
      where: { id: req.params.messageId },
      include: { channel: { include: { room: true } }, conversation: true },
    });
    if (!parent) return res.status(404).json({ error: 'Message not found' });

    if (parent.channel) {
      if (!(await canAccessRoomChat(prisma, parent.channel.room, req.userId!, req.organizationId))) {
        return res.status(403).json({ error: 'Not a member of this room' });
      }
    } else if (parent.conversation) {
      if (parent.conversation.userAId !== req.userId && parent.conversation.userBId !== req.userId) {
        return res.status(403).json({ error: 'Not a participant in this conversation' });
      }
    } else {
      return res.status(404).json({ error: 'Message not found' });
    }

    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    const replies = await prisma.chatMessage.findMany({
      where: { parentId: req.params.messageId },
      orderBy: { createdAt: 'desc' },
      take: parseLimit(req.query.limit),
      ...(before ? { cursor: { id: before }, skip: 1 } : {}),
      include: { sender: { select: { displayName: true } } },
    });
    return res.json({ replies: replies.reverse().map(toMessageDto) });
  } catch (err) {
    console.error('[chat] list replies error:', err);
    return res.status(500).json({ error: 'Failed to load replies' });
  }
});

// GET /api/rooms/:slug/dms — the caller's own DM conversations in this room
chat.get('/rooms/:slug/dms', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const conversations = await prisma.directConversation.findMany({
      where: { roomId: room.id, OR: [{ userAId: req.userId }, { userBId: req.userId }] },
      include: {
        userA: { select: { id: true, displayName: true } },
        userB: { select: { id: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const previews = await lastMessagesByConversation(
      prisma,
      conversations.map((c) => dmConversationId(c.userAId, c.userBId)),
    );
    return res.json({
      conversations: conversations.map((c) =>
        toDmSummaryDto(c, req.userId!, previews.get(dmConversationId(c.userAId, c.userBId))),
      ),
    });
  } catch (err) {
    console.error('[chat] list dms error:', err);
    return res.status(500).json({ error: 'Failed to load DMs' });
  }
});

// POST /api/rooms/:slug/dms — find-or-create a DM with { otherUserId }.
// userAId/userBId are always stored sorted so the same pair never produces
// two rows regardless of who started the conversation.
chat.post('/rooms/:slug/dms', authenticateToken, validate(startDmSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { otherUserId } = req.body;
    if (otherUserId === req.userId) {
      return res.status(400).json({ error: "Can't start a DM with yourself" });
    }
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!(await canAccessRoomChat(prisma, room, req.userId!, req.organizationId))) {
      return res.status(403).json({ error: 'Not a member of this room' });
    }

    // Multi-tenant Fase 3 — the DM partner must be in the same org too;
    // otherwise a DM (and the chat history it accumulates) could be started
    // with an account in a different company that merely happens to share
    // a room slug's guessability.
    const otherUser = await findUserInOrg(prisma, otherUserId, req.organizationId, { id: true });
    if (!otherUser) return res.status(404).json({ error: 'User not found' });

    const [userAId, userBId] = [req.userId!, otherUserId].sort();
    const include = {
      userA: { select: { id: true, displayName: true } },
      userB: { select: { id: true, displayName: true } },
    } as const;

    let conversation = await prisma.directConversation.findUnique({
      where: { roomId_userAId_userBId: { roomId: room.id, userAId, userBId } },
      include,
    });
    if (!conversation) {
      try {
        conversation = await prisma.directConversation.create({
          data: { roomId: room.id, userAId, userBId },
          include,
        });
      } catch (createErr: any) {
        // Two near-simultaneous "start a DM" requests from both sides of
        // the same pair can both pass the findUnique-not-found check above
        // before either has committed — the DB's own @@unique constraint
        // correctly lets only one create() succeed, and the loser would
        // otherwise 500 even though the conversation now genuinely exists.
        // Re-fetch instead of failing.
        if (createErr?.code === 'P2002') {
          conversation = await prisma.directConversation.findUnique({
            where: { roomId_userAId_userBId: { roomId: room.id, userAId, userBId } },
            include,
          });
        }
        if (!conversation) throw createErr;
      }
      // The pair's workspace-level mirror. Note this is deliberately OUTSIDE
      // the room-scoped find-or-create above: the same pair starting a DM in
      // a second room makes another DirectConversation row, but resolves to
      // the SAME Conversation — which is precisely the room-independence the
      // migration is for. ensureDmConversation upserts, so the second room is
      // a no-op here rather than a duplicate.
      await ensureDmConversation(prisma, {
        userAId,
        userBId,
        roomId: room.id,
        createdAt: conversation.createdAt,
      });
      // Only on genuine creation — the other participant has no other live
      // way to discover this DM exists (see DM_STARTED's doc comment).
      // Targeted at the two participants' own sockets specifically (not
      // broadcast to the whole room) — everyone else in the room has no
      // business knowing who's DMing whom.
      if (ioRef) {
        const payload: DirectConversationStarted = {
          id: conversation.id,
          roomId: conversation.roomId,
          userA: conversation.userA,
          userB: conversation.userB,
          createdAt: conversation.createdAt.getTime(),
        };
        const participantIds = new Set([userAId, userBId]);
        for (const s of ioRef.sockets.sockets.values()) {
          if (participantIds.has(s.data.userId)) {
            s.emit(SocketEvents.DM_STARTED, payload);
          }
        }
      }
    }
    return res.status(200).json({ conversation: toDmSummaryDto(conversation, req.userId!) });
  } catch (err) {
    console.error('[chat] start dm error:', err);
    return res.status(500).json({ error: 'Failed to start DM' });
  }
});

// GET /api/dms/:conversationId/messages?before=&limit=
chat.get('/dms/:conversationId/messages', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const conversation = await prisma.directConversation.findUnique({ where: { id: req.params.conversationId } });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (conversation.userAId !== req.userId && conversation.userBId !== req.userId) {
      return res.status(403).json({ error: 'Not a participant in this conversation' });
    }

    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    // Reads by PAIR, not by this room's DirectConversation row. That is the
    // behavioural change the whole migration is for: if these two ever talked
    // from another room, that history is one conversation, not two. No pair
    // in this database has DMs in more than one room today, so nothing
    // visibly changes yet — this is the path that makes it true going forward.
    const messages = await prisma.chatMessage.findMany({
      where: {
        conversationId2: dmConversationId(conversation.userAId, conversation.userBId),
        parentId: null,
      },
      orderBy: { createdAt: 'desc' },
      take: parseLimit(req.query.limit),
      ...(before ? { cursor: { id: before }, skip: 1 } : {}),
      include: { sender: { select: { displayName: true } }, _count: { select: { replies: true } } },
    });
    return res.json({ messages: messages.reverse().map(toMessageDto) });
  } catch (err) {
    console.error('[chat] list dm messages error:', err);
    return res.status(500).json({ error: 'Failed to load messages' });
  }
});

export default chat;
