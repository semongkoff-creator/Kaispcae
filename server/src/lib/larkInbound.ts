import { Server } from 'socket.io';
import { getPrisma } from './prisma';
import { sanitizeChat } from '../middleware/validate';
import { getUserName } from './larkIm';
import { deliverLarkMessageToChannel, getLarkRelayUserId, wasRecentlySentByUs } from './larkChatSync';

// Bagian 4 — INBOUND handler for a Lark im.message.receive_v1 event. Transport
// agnostic: it takes the already-decrypted event object, so it works the same
// whether events arrive over the SDK's persistent WebSocket connection (see
// larkWs.ts — the mode we use) or a raw webhook. The SDK's EventDispatcher
// hands the handler the event body directly, i.e. `{ sender, message }`.
export async function handleInboundLarkMessage(io: Server, event: any): Promise<void> {
  const msg = event?.message;
  // [diag-b4] temporary — remove once inbound sync confirmed working.
  console.log('[diag-b4 in] event received', JSON.stringify({
    chat_type: msg?.chat_type, message_type: msg?.message_type,
    chat_id: msg?.chat_id, sender_type: event?.sender?.sender_type,
  }));
  if (!msg) return;

  // Group text only. p2p (DM) and non-text are explicitly out of scope.
  if (msg.chat_type !== 'group' || msg.message_type !== 'text') {
    console.log('[diag-b4 in] dropped: not group-text', msg?.chat_type, msg?.message_type);
    return;
  }
  const chatId: string | undefined = msg.chat_id;
  const messageId: string | undefined = msg.message_id;
  if (!chatId || !messageId) return;

  // Anti-echo guard #0 (fast, in-memory): a message we JUST relayed out. This
  // is the primary guard for user-identity sends — their echo has
  // sender_type="user" and slips past guard #1 below, and this check beats the
  // durable-row check on the echo's round-trip.
  if (wasRecentlySentByUs(messageId)) {
    console.log('[diag-b4 in] dropped: echo (recent in-memory)');
    return;
  }

  // Anti-echo guard #1: bot/app-sent messages. A bot-fallback relay carries a
  // non-'user' sender_type, so this also catches those echoes (and any other
  // bot in the group).
  const senderType: string | undefined = event?.sender?.sender_type;
  if (senderType && senderType !== 'user') {
    console.log('[diag-b4 in] dropped: sender_type not user =', senderType);
    return;
  }

  const prisma = getPrisma();

  // Anti-echo guard #2 (durable): survives a restart that clears guard #0.
  const echoed = await prisma.larkSentMessage.findUnique({ where: { messageId } });
  if (echoed) {
    console.log('[diag-b4 in] dropped: echo of our own outbound');
    return;
  }

  // Resolve the Lark group → room → its default channel.
  const map = await prisma.roomChatMap.findUnique({ where: { chatId } });
  if (!map) {
    console.log('[diag-b4 in] dropped: no RoomChatMap for chat_id', chatId);
    return;
  }
  const channel = await prisma.channel.findFirst({
    where: { roomId: map.roomId, isDefault: true },
    select: { id: true, name: true, roomId: true },
  });
  if (!channel) {
    console.log('[diag-b4 in] dropped: no default channel for room', map.roomId);
    return;
  }
  console.log('[diag-b4 in] delivering to channel', channel.id);

  // Message content is a JSON string {"text":"..."}.
  let rawText = '';
  try {
    rawText = JSON.parse(msg.content || '{}')?.text ?? '';
  } catch {
    rawText = '';
  }
  let text = sanitizeChat(rawText);
  if (!text) return;

  // Attribute the sender: prefer a real MeetKai account (name + avatar render
  // correctly for free), else the relay bot with the Lark name prefixed.
  const openId: string | undefined = event?.sender?.sender_id?.open_id;
  let senderId: string | null = null;
  if (openId) {
    const u = await prisma.user.findUnique({ where: { larkOpenId: openId }, select: { id: true } });
    if (u) senderId = u.id;
  }
  if (!senderId) {
    senderId = await getLarkRelayUserId(prisma);
    const name = (openId ? await getUserName(openId) : null) || 'Lark';
    text = sanitizeChat(`[${name}] ${text}`);
  }

  await deliverLarkMessageToChannel(io, prisma, channel, senderId, text);
}
