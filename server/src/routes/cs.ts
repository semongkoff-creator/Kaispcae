import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { getConfig } from '../config';
import { matchFaq } from '../data/csFaq';

const cs = Router();

// A session is reusable for this long before a fresh one starts instead —
// keeps a same-day conversation continuous across closing/reopening the
// widget, without letting a genuinely old (days-later) chat silently
// resurface as if it were still relevant.
const SESSION_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

const MAX_MESSAGE_CHARS = 2000;

const GREETING_TEXT = 'Halo! Ada yang bisa dibantu? Tanya seputar cara pakai KaiSpace, atau ketik "admin" kalau ingin bicara dengan tim kami.';
const FALLBACK_TEXT = 'Maaf, aku belum punya jawaban untuk itu. Mau coba tanya dengan kata lain, atau langsung hubungi admin?';
const HANDOFF_NOT_CONFIGURED_TEXT = 'Fitur hubungi admin belum tersedia saat ini. Coba lagi nanti.';
const WA_LINK_TEXT = 'Klik tombol di bawah untuk chat langsung dengan admin kami di WhatsApp.';

interface SerializedMessage {
  id: string;
  from: string;
  text: string;
  createdAt: Date;
}

function serialize(m: { id: string; from: string; text: string; createdAt: Date }): SerializedMessage {
  return { id: m.id, from: m.from, text: m.text, createdAt: m.createdAt };
}

// "Hubungi admin" — a plain wa.me deep link. Opens WhatsApp (app or web)
// with the admin's number and a pre-filled greeting; the actual
// conversation then happens directly in WhatsApp, outside MeetKai entirely.
// An earlier version of this route relayed through an n8n/WAHA workflow
// instead (or alongside this) — dropped entirely: that path depended on an
// external workflow + WhatsApp session actually being up end-to-end, which
// repeatedly wasn't, and misconfigured n8n workflows returned opaque
// upstream errors with nothing MeetKai could act on. This wa.me link has no
// such dependency.
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
      messages: session.messages.map(serialize),
    });
  } catch (e) {
    console.error('[cs] create/reuse session error:', e);
    return res.status(500).json({ error: 'Gagal membuka sesi CS' });
  }
});

// POST /api/cs/session/:id/message — user sends a message. Typing exactly
// "admin" triggers the same handoff as the "Hubungi admin" button (see the
// /handoff route below) — builds a wa.me link. Anything else is matched
// against the FAQ (matchFaq, backed entirely by docs/KB-FAQ-KaiSpace.docx
// via data/csFaq.ts), with offerAdmin signaling a miss so the client shows
// the "Hubungi admin" button.
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
    let waLink: string | null = null;

    if (text.toLowerCase() === 'admin') {
      const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } });
      const link = buildWhatsAppLink(user?.displayName ?? 'User');
      if (link) {
        waLink = link;
        botMessage = serialize(await prisma.csMessage.create({ data: { sessionId: session.id, from: 'bot', text: WA_LINK_TEXT } }));
      } else {
        botMessage = serialize(await prisma.csMessage.create({ data: { sessionId: session.id, from: 'bot', text: HANDOFF_NOT_CONFIGURED_TEXT } }));
        offerAdmin = true;
      }
    } else {
      const match = matchFaq(text);
      const replyText = match?.answer ?? FALLBACK_TEXT;
      offerAdmin = !match;
      botMessage = serialize(await prisma.csMessage.create({ data: { sessionId: session.id, from: 'bot', text: replyText } }));
    }

    await prisma.csSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } });

    return res.json({
      userMessage: serialize(userMessage),
      botMessage,
      offerAdmin,
      waLink,
    });
  } catch (e) {
    console.error('[cs] send message error:', e);
    return res.status(500).json({ error: 'Gagal mengirim pesan' });
  }
});

// POST /api/cs/session/:id/handoff — the "Hubungi admin" button's own
// trigger, distinct from typing "admin" in the message box above but
// sharing the exact same buildWhatsAppLink logic. No free-text body: the
// button has no message of its own.
cs.post('/cs/session/:id/handoff', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const session = await prisma.csSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.userId !== req.userId) return res.status(404).json({ error: 'Sesi CS tidak ditemukan' });

    const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } });
    const link = buildWhatsAppLink(user?.displayName ?? 'User');
    await prisma.csSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } });

    if (!link) {
      const botMessage = serialize(await prisma.csMessage.create({ data: { sessionId: session.id, from: 'bot', text: HANDOFF_NOT_CONFIGURED_TEXT } }));
      return res.json({ botMessage, waLink: null });
    }

    const botMessage = serialize(await prisma.csMessage.create({ data: { sessionId: session.id, from: 'bot', text: WA_LINK_TEXT } }));
    return res.json({ botMessage, waLink: link });
  } catch (e) {
    console.error('[cs] handoff error:', e);
    return res.status(500).json({ error: 'Gagal menghubungkan ke admin' });
  }
});

export default cs;
