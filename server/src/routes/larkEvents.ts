import express, { Router, Request, Response } from 'express';
import { Server } from 'socket.io';
import { getConfig } from '../config';
import { getPrisma } from '../lib/prisma';
import { sanitizeChat } from '../middleware/validate';
import { verifyLarkSignature, decryptLarkEvent } from '../lib/larkEventCrypto';
import { getUserName } from '../lib/larkIm';
import { deliverLarkMessageToChannel, getLarkRelayUserId } from '../lib/larkChatSync';

// Bagian 4 — INBOUND webhook for Lark Event Subscription. This is the only
// endpoint the public internet can POST to that MeetKai then acts on, so the
// order here is deliberately: verify signature → decrypt → check token →
// dispatch. Anything that fails a check gets a terse status and is dropped; we
// never reveal WHY (a detailed error is a probing oracle).
//
// Mounted with express.raw (NOT the global express.json) because the signature
// is computed over the exact received bytes — see index.ts and larkEventCrypto.

let ioRef: Server | null = null;
export function setLarkEventsIo(io: Server): void {
  ioRef = io;
}

const router = Router();

// im.message.receive_v1 → persist into the mapped room's default channel and
// broadcast. Runs AFTER the 200 is sent (Lark wants a fast ack and retries on
// slow responses), so it only logs on failure.
async function handleMessageReceive(payload: any): Promise<void> {
  const event = payload?.event;
  const msg = event?.message;
  if (!msg) return;

  // Group text only. p2p (DM) and non-text are explicitly out of scope.
  if (msg.chat_type !== 'group' || msg.message_type !== 'text') return;
  const chatId: string | undefined = msg.chat_id;
  const messageId: string | undefined = msg.message_id;
  if (!chatId || !messageId) return;

  // Anti-echo guard #1: skip anything not sent by a human user (our own bot
  // relay, or any other app/bot in the group).
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

  if (ioRef) await deliverLarkMessageToChannel(ioRef, prisma, channel, senderId, text);
}

router.post('/lark/events', express.raw({ type: '*/*', limit: '256kb' }), async (req: Request, res: Response) => {
  const cfg = getConfig();
  const encryptKey = cfg.LARK_ENCRYPT_KEY;
  const verToken = cfg.LARK_VERIFICATION_TOKEN;
  // Feature not configured → behave as if the endpoint doesn't exist. Never
  // hint that a webhook lives here when it isn't wired.
  if (!encryptKey || !verToken) return res.status(404).end();

  const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const timestamp = req.header('X-Lark-Request-Timestamp') || '';
  const nonce = req.header('X-Lark-Request-Nonce') || '';
  const signature = req.header('X-Lark-Signature') || '';

  // 1) Signature over the raw (still-encrypted) bytes.
  if (!verifyLarkSignature(encryptKey, timestamp, nonce, rawBody, signature)) {
    return res.status(401).end();
  }

  // 2) Envelope must carry an encrypted blob (encryption is required for this
  // feature — an unencrypted push is either misconfigured or forged).
  let envelope: any;
  try {
    envelope = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).end();
  }
  if (!envelope?.encrypt) return res.status(400).end();

  const decrypted = decryptLarkEvent(encryptKey, envelope.encrypt);
  if (!decrypted) return res.status(400).end();

  let payload: any;
  try {
    payload = JSON.parse(decrypted);
  } catch {
    return res.status(400).end();
  }

  // 3) URL verification handshake (challenge is inside the encrypted payload).
  if (payload?.type === 'url_verification') {
    if (payload?.token !== verToken) return res.status(401).end();
    return res.json({ challenge: payload.challenge });
  }

  // 4) Event 2.0 envelope: verify the token before trusting anything in it.
  if (payload?.header?.token !== verToken) return res.status(401).end();

  // Ack immediately, then process — a slow DB write must not make Lark retry.
  res.status(200).end();

  if (payload?.header?.event_type === 'im.message.receive_v1') {
    handleMessageReceive(payload).catch((e) => console.error('[larkEvents] handle error:', e));
  }
});

export default router;
