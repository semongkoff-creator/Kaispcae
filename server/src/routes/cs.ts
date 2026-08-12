import { Router, Request, Response } from 'express';
import { Server } from 'socket.io';
import crypto from 'crypto';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { getConfig } from '../config';
import { matchFaq } from '../data/csFaq';
import { pushCsReply } from '../socket/csHandler';

const cs = Router();

// Tahap 4 — POST /api/cs/reply needs the live socket server to push an
// admin reply in real time; same "HTTP route needs the socket server"
// pattern as guestInvite.ts's own setIo.
let ioRef: Server | null = null;
export function setIo(io: Server): void {
  ioRef = io;
}

// Constant-time comparison so a wrong token guess can't be narrowed down
// via response-time differences. Buffer lengths must match before calling
// crypto.timingSafeEqual (it throws otherwise) — comparing lengths first is
// the standard, accepted shape of this check; length isn't the secret part.
function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// A session is reusable for this long before a fresh one starts instead —
// keeps a same-day conversation continuous across closing/reopening the
// widget, without letting a genuinely old (days-later) chat silently
// resurface as if it were still relevant.
const SESSION_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

const MAX_MESSAGE_CHARS = 2000;

const GREETING_TEXT = 'Halo! Ada yang bisa dibantu? Tanya seputar cara pakai KaiSpace, atau ketik "admin" kalau ingin bicara dengan tim kami.';
const FALLBACK_TEXT = 'Maaf, aku belum punya jawaban untuk itu. Mau coba tanya dengan kata lain, atau langsung hubungi admin?';
const HANDOFF_NOT_CONFIGURED_TEXT = 'Fitur hubungi admin belum tersedia saat ini. Coba lagi nanti.';
const RELAY_FAILED_TEXT = 'Pesanmu gagal diteruskan ke admin. Coba kirim lagi.';
const WA_LINK_TEXT = 'Klik tombol di bawah untuk chat langsung dengan admin kami di WhatsApp.';
const BUTTON_HANDOFF_MESSAGE = 'Pengguna meminta bantuan admin lewat tombol "Hubungi admin".';

interface SerializedMessage {
  id: string;
  from: string;
  text: string;
  createdAt: Date;
}

function serialize(m: { id: string; from: string; text: string; createdAt: Date }): SerializedMessage {
  return { id: m.id, from: m.from, text: m.text, createdAt: m.createdAt };
}

// Tahap 3 — MeetKai -> n8n. POSTs the agreed contract payload; never throws,
// always resolves to whether it worked so callers can decide what to store/
// show without a try/catch of their own. N8N_CS_WEBHOOK_URL is optional
// (see config/index.ts) so this fails informatively rather than crashing
// when the n8n side isn't configured/deployed yet.
async function postToN8n(payload: { sessionId: string; userName: string; userId: string; message: string }): Promise<{ ok: boolean; error?: string }> {
  const cfg = getConfig();
  if (!cfg.N8N_CS_WEBHOOK_URL) {
    console.warn('[cs] N8N_CS_WEBHOOK_URL not configured — handoff/relay skipped');
    return { ok: false, error: HANDOFF_NOT_CONFIGURED_TEXT };
  }
  try {
    const res = await fetch(cfg.N8N_CS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error('[cs] n8n webhook returned', res.status);
      return { ok: false, error: RELAY_FAILED_TEXT };
    }
    return { ok: true };
  } catch (e) {
    console.error('[cs] n8n webhook request failed:', e);
    return { ok: false, error: RELAY_FAILED_TEXT };
  }
}

// "Hubungi admin" — a plain wa.me deep link, not the n8n/WAHA relay above.
// Opens WhatsApp (app or web) with the admin's number and a pre-filled
// greeting; the actual conversation then happens directly in WhatsApp,
// outside MeetKai entirely. Chosen over the n8n/WAHA bridge for reliability
// — that path depends on an external workflow + WhatsApp session actually
// being up end-to-end, which repeatedly wasn't. Real-time in-app sync
// (mirroring the WA conversation back into this chat) is a possible later
// upgrade, not this — see N8N_CS_WEBHOOK_URL/postToN8n above, left intact
// for that.
function buildWhatsAppLink(userName: string): string | null {
  const cfg = getConfig();
  if (!cfg.CS_ADMIN_WHATSAPP_NUMBER) return null;
  const text = `Halo, saya ${userName} butuh bantuan terkait KaiSpace.`;
  return `https://wa.me/${cfg.CS_ADMIN_WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}

// POST /api/cs/session — find-or-create this user's CS session. Reuses a
// recent one (see SESSION_REUSE_WINDOW_MS) so the conversation survives the
// widget being closed and reopened, rather than minting a fresh row (and
// losing scrollback) every single time.
cs.post('/cs/session', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const since = new Date(Date.now() - SESSION_REUSE_WINDOW_MS);
    let session = await prisma.csSession.findFirst({
      where: { userId: req.userId!, updatedAt: { gte: since } },
      orderBy: { updatedAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) {
      session = await prisma.csSession.create({
        data: {
          userId: req.userId!,
          messages: { create: [{ from: 'bot', text: GREETING_TEXT }] },
        },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      });
    }
    return res.json({
      sessionId: session.id,
      mode: session.mode,
      messages: session.messages.map(serialize),
    });
  } catch (e) {
    console.error('[cs] create/reuse session error:', e);
    return res.status(500).json({ error: 'Gagal membuka sesi CS' });
  }
});

// POST /api/cs/session/:id/message — user sends a message.
// - 'bot' mode: typing exactly "admin" triggers the handoff (same as the
//   "Hubungi admin" button, see the /handoff route below) — BOTH a wa.me
//   link (always shown, the guaranteed path) AND a fire-and-forget relay
//   to n8n (a bonus if that workflow's own WAHA step happens to be working;
//   its failure is never allowed to block or hide the wa.me link — see
//   buildWhatsAppLink's comment for why n8n alone isn't trusted as the only
//   path). Anything else is matched against the FAQ (matchFaq), with
//   offerAdmin signaling a miss.
// - 'human' mode: every message is relayed to n8n instead (Tahap 3's
//   "pesan lanjutan user selama mode human juga diteruskan") — nothing
//   transitions a session into 'human' anymore (see below), so this path
//   is currently unreachable through normal use; left in place for the
//   real-time-sync upgrade mentioned in buildWhatsAppLink's comment.
// Admin replies arriving back (Tahap 4) are a separate path — POST
// /api/cs/reply, pushed to the client over its own socket, not fetched here.
cs.post('/cs/session/:id/message', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Pesan tidak boleh kosong' });
    if (text.length > MAX_MESSAGE_CHARS) return res.status(400).json({ error: 'Pesan terlalu panjang' });

    const prisma = getPrisma();
    const session = await prisma.csSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.userId !== req.userId) return res.status(404).json({ error: 'Sesi CS tidak ditemukan' });

    const userMessage = await prisma.csMessage.create({ data: { sessionId: session.id, from: 'user', text } });

    let botMessage: SerializedMessage | null = null;
    let offerAdmin = false;
    let mode = session.mode;
    let relayed: boolean | null = null;
    let waLink: string | null = null;

    if (session.mode === 'bot' && text.toLowerCase() === 'admin') {
      const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } });
      const link = buildWhatsAppLink(user?.displayName ?? 'User');
      // Fire-and-forget — never awaited, never allowed to change what the
      // user sees below. postToN8n's own try/catch always resolves, so
      // there's nothing to catch here; a failure is only ever logged
      // server-side (see postToN8n).
      void postToN8n({ sessionId: session.id, userName: user?.displayName ?? 'User', userId: req.userId!, message: text });
      if (link) {
        waLink = link;
        botMessage = serialize(await prisma.csMessage.create({ data: { sessionId: session.id, from: 'bot', text: WA_LINK_TEXT } }));
      } else {
        botMessage = serialize(await prisma.csMessage.create({ data: { sessionId: session.id, from: 'bot', text: HANDOFF_NOT_CONFIGURED_TEXT } }));
        offerAdmin = true;
      }
    } else if (session.mode === 'bot') {
      const match = matchFaq(text);
      const replyText = match?.answer ?? FALLBACK_TEXT;
      offerAdmin = !match;
      botMessage = serialize(await prisma.csMessage.create({ data: { sessionId: session.id, from: 'bot', text: replyText } }));
    } else {
      // Already 'human' — relay silently (no per-message bot bubble; the
      // client shows one persistent "connected to admin" banner instead of
      // repeating a status line after every message). A failed relay still
      // leaves the message stored above so it isn't lost, just unsent.
      const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } });
      const result = await postToN8n({ sessionId: session.id, userName: user?.displayName ?? 'User', userId: req.userId!, message: text });
      relayed = result.ok;
      if (!result.ok) {
        botMessage = serialize(await prisma.csMessage.create({ data: { sessionId: session.id, from: 'bot', text: result.error! } }));
      }
    }

    await prisma.csSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } });

    return res.json({
      userMessage: serialize(userMessage),
      botMessage,
      offerAdmin,
      mode,
      relayed,
      waLink,
    });
  } catch (e) {
    console.error('[cs] send message error:', e);
    return res.status(500).json({ error: 'Gagal mengirim pesan' });
  }
});

// POST /api/cs/session/:id/handoff — the "Hubungi admin" button's own
// trigger, distinct from typing "admin" in the message box above but
// sharing the exact same buildWhatsAppLink + fire-and-forget postToN8n
// logic (see the /message handler's own comment for why both fire).
// No free-text body: the button has no message of its own.
cs.post('/cs/session/:id/handoff', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const session = await prisma.csSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.userId !== req.userId) return res.status(404).json({ error: 'Sesi CS tidak ditemukan' });

    if (session.mode === 'human') {
      return res.json({ mode: 'human', botMessage: null, waLink: null });
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } });
    const link = buildWhatsAppLink(user?.displayName ?? 'User');
    void postToN8n({ sessionId: session.id, userName: user?.displayName ?? 'User', userId: req.userId!, message: BUTTON_HANDOFF_MESSAGE });
    await prisma.csSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } });

    if (!link) {
      const botMessage = serialize(await prisma.csMessage.create({ data: { sessionId: session.id, from: 'bot', text: HANDOFF_NOT_CONFIGURED_TEXT } }));
      return res.json({ mode: 'bot', botMessage, waLink: null });
    }

    const botMessage = serialize(await prisma.csMessage.create({ data: { sessionId: session.id, from: 'bot', text: WA_LINK_TEXT } }));
    return res.json({ mode: 'bot', botMessage, waLink: link });
  } catch (e) {
    console.error('[cs] handoff error:', e);
    return res.status(500).json({ error: 'Gagal menghubungkan ke admin' });
  }
});

// POST /api/cs/reply — n8n -> MeetKai (Tahap 4). Deliberately NOT behind
// authenticateToken: the caller is n8n itself, a server with no MeetKai
// account of its own, not a logged-in user — token is the only guard, and
// it must reject BEFORE touching the DB on any mismatch (never "teruskan"
// on a bad token, per the spec's own security requirement). Not rate
// limited beyond the app's existing global limiter — this is a
// server-to-server webhook the n8n side controls, not public.
cs.post('/cs/reply', async (req: Request, res: Response) => {
  const cfg = getConfig();
  const providedToken = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!cfg.CS_N8N_TOKEN || !timingSafeEqualStrings(providedToken, cfg.CS_N8N_TOKEN)) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
  const text = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!sessionId || !text) return res.status(400).json({ error: 'sessionId dan message wajib diisi' });
  if (text.length > MAX_MESSAGE_CHARS) return res.status(400).json({ error: 'Pesan terlalu panjang' });

  try {
    const prisma = getPrisma();
    const session = await prisma.csSession.findUnique({ where: { id: sessionId } });
    if (!session) return res.status(404).json({ error: 'Sesi CS tidak ditemukan' });

    const message = await prisma.csMessage.create({ data: { sessionId, from: 'admin', text } });
    await prisma.csSession.update({ where: { id: sessionId }, data: { updatedAt: new Date() } });

    if (ioRef) {
      pushCsReply(ioRef, session.userId, { sessionId, from: 'admin', text, createdAt: message.createdAt.toISOString() });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('[cs] reply error:', e);
    return res.status(500).json({ error: 'Gagal memproses balasan' });
  }
});

export default cs;
