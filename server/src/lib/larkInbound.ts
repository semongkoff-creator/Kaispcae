import { Server } from 'socket.io';
import { getPrisma } from './prisma';
import { sanitizeChat } from '../middleware/validate';
import { getUserName } from './larkIm';
import { deliverLarkMessageToChannel, getLarkRelayUserId } from './larkChatSync';

// Bagian 4 — INBOUND handler for a Lark im.message.receive_v1 event. Transport
// agnostic: it takes the already-decrypted event object, so it works the same
// whether events arrive over the SDK's persistent WebSocket connection (see
// larkWs.ts — the mode we use) or a raw webhook. The SDK's EventDispatcher
// hands the handler the event body directly, i.e. `{ sender, message }`.
export async function handleInboundLarkMessage(io: Server, event: any): Promise<void> {
  const msg = event?.message;
  if (!msg) return;

  // Group text only. p2p (DM) and non-text are explicitly out of scope.
  if (msg.chat_type !== 'group' || msg.message_type !== 'text') return;
  const chatId: string | undefined = msg.chat_id;
  const messageId: string | undefined = msg.message_id;
  if (!chatId || !messageId) return;

  // Anti-echo guard #1: only human-sent messages. Our own relayed messages (and
  // any other bot in the group) carry a non-'user' sender_type.
  const senderType: string | undefined = event?.sender?.sender_type;
  if (senderType && senderType !== 'user') return;

  const prisma = getPrisma();

  // Anti-echo guard #2: skip a message MeetKai itself just relayed out.
  const echoed = await prisma.larkSentMessage.findUnique({ where: { messageId } });
  if (echoed) return;

  // Resolve the Lark group → room → its default channel.
  const map = await prisma.roomChatMap.findUnique({ where: { chatId } });
  if (!map) return;
  const channel = await prisma.channel.findFirst({
    where: { roomId: map.roomId, isDefault: true },
    select: { id: true, name: true, roomId: true },
  });
  if (!channel) return;

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
