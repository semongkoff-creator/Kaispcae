import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { SocketEvents, ChannelMessage } from '@virtualmeet/shared';
import { ensureGroupConversation } from './conversations';
import { sendGroupText } from './larkIm';

// Bagian 4 — the two directions of the Lark ↔ MeetKai channel sync live here so
// the socket handler (outbound) and the webhook route (inbound) share one
// implementation instead of drifting. Only a room's DEFAULT ("general")
// channel participates; DM/zone chat never reach this file.

const RELAY_EMAIL = 'lark-relay@meetkai.local';
let relayUserIdCache: string | null = null;

// A single synthetic account that inbound Lark messages are attributed to when
// their sender has no matching MeetKai user (see larkOpenId mapping in the
// webhook). Created lazily; the password is random-and-unusable so it can never
// be logged into. displayName "Lark" so ChatAvatar renders a consistent badge.
export async function getLarkRelayUserId(prisma: PrismaClient): Promise<string> {
  if (relayUserIdCache) return relayUserIdCache;
  const existing = await prisma.user.findUnique({ where: { email: RELAY_EMAIL }, select: { id: true } });
  if (existing) {
    relayUserIdCache = existing.id;
    return existing.id;
  }
  const created = await prisma.user.create({
    data: {
      email: RELAY_EMAIL,
      password: `lark-relay-unusable-${randomUUID()}`,
      displayName: 'Lark',
    },
    select: { id: true },
  });
  relayUserIdCache = created.id;
  return created.id;
}

// INBOUND: persist a Lark-originated message into a channel and broadcast it on
// the EXACT same path a native send uses — CHANNEL_MESSAGE_NEW to the
// `channel:<id>` socket room — so the existing ChatPanel bubbles/avatar/
// auto-scroll render it with zero new UI. Writes channelId AND conversationId2
// so history reads (which key on conversationId2) pick it up too. The store's
// append is idempotent by message id, so a redelivered event won't double-post.
export async function deliverLarkMessageToChannel(
  io: Server,
  prisma: PrismaClient,
  channel: { id: string; name: string; roomId: string },
  senderId: string,
  text: string,
): Promise<void> {
  const conversationId2 = await ensureGroupConversation(prisma, channel);
  const message = await prisma.chatMessage.create({
    data: { channelId: channel.id, conversationId2, senderId, text },
    include: { sender: { select: { displayName: true } } },
  });
  const dto: ChannelMessage = {
    id: message.id,
    channelId: message.channelId ?? undefined,
    senderId: message.senderId,
    senderName: message.sender.displayName,
    text: message.text,
    createdAt: message.createdAt.getTime(),
  };
  io.to(`channel:${channel.id}`).emit(SocketEvents.CHANNEL_MESSAGE_NEW, dto);
}

// OUTBOUND: relay a message just sent in MeetKai to the mapped Lark group, as
// `[Sender] text`. Fire-and-forget by contract — the caller must NOT await this
// in a way that can fail the user's own send (a Lark outage must not break
// MeetKai chat). Only the default channel of a mapped room relays; everything
// else is a no-op. The returned Lark message_id is recorded so the inbound
// webhook recognises and drops the echo.
export async function relayChannelMessageToLark(
  prisma: PrismaClient,
  channel: { roomId: string; isDefault: boolean },
  senderName: string,
  text: string,
): Promise<void> {
  // [diag-b4] temporary — remove once outbound sync confirmed working.
  console.log('[diag-b4 out] relay called', JSON.stringify({ isDefault: channel.isDefault, roomId: channel.roomId }));
  if (!channel.isDefault) {
    console.log('[diag-b4 out] skipped: channel is not the default channel');
    return;
  }
  const trimmed = (text || '').trim();
  if (!trimmed) return; // attachment-only sends have nothing to relay
  const map = await prisma.roomChatMap.findUnique({ where: { roomId: channel.roomId } });
  if (!map) {
    console.log('[diag-b4 out] skipped: no RoomChatMap for room', channel.roomId);
    return;
  }
  const messageId = await sendGroupText(map.chatId, `[${senderName}] ${trimmed}`);
  console.log('[diag-b4 out] sendGroupText ->', messageId ? `ok ${messageId}` : 'FAILED (see [larkIm] error above)');
  if (messageId) {
    // Best-effort ledger write — a lost row only risks one echoed message, not
    // correctness of the send itself.
    await prisma.larkSentMessage.create({ data: { messageId } }).catch(() => {});
  }
}
