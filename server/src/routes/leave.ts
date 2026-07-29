import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { approvalEnabled, listMyLeaves, getLeaveTypes, createLeaveInstance } from '../lib/larkApproval';

// A9 — leave (Cuti) request via Lark Approval. Thin bridge; Lark is the source
// of truth (no local copy). Clear errors so the widget never silently fails.
const router = Router();

const NOT_CONFIGURED = { error: 'not-configured', message: 'Fitur Cuti belum dikonfigurasi (approval_code kosong).' };
const NO_LARK = { error: 'no-lark', message: 'Hubungkan akun Lark dulu (login lewat Lark) untuk mengajukan cuti.' };
const LARK_FAIL = { error: 'lark', message: 'Gagal terhubung ke Lark Approval. Coba lagi sebentar.' };

async function larkOpenId(userId: string): Promise<string | null> {
  const u = await getPrisma().user.findUnique({ where: { id: userId }, select: { larkOpenId: true } });
  return u?.larkOpenId ?? null;
}

router.get('/leave/options', authenticateToken, async (_req: AuthRequest, res: Response) => {
  if (!approvalEnabled()) return res.status(503).json(NOT_CONFIGURED);
  try {
    return res.json({ leaveTypes: await getLeaveTypes() });
  } catch (e) {
    console.error('[leave] options error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

router.get('/leave/mine', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!approvalEnabled()) return res.status(503).json(NOT_CONFIGURED);
  const openId = await larkOpenId(req.userId!);
  if (!openId) return res.status(409).json(NO_LARK);
  try {
    return res.json({ leaves: await listMyLeaves(openId) });
  } catch (e) {
    console.error('[leave] mine error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

router.post('/leave', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!approvalEnabled()) return res.status(503).json(NOT_CONFIGURED);
  const openId = await larkOpenId(req.userId!);
  if (!openId) return res.status(409).json(NO_LARK);

  const b = req.body ?? {};
  const name = String(b.name ?? '').trim();
  const start = String(b.start ?? '').trim();
  const end = String(b.end ?? '').trim();
  const reason = String(b.reason ?? '').trim();
  const unit = ['DAY', 'HALF_DAY', 'HOUR'].includes(b.unit) ? b.unit : 'DAY';
  const interval = Number(b.interval);
  const timezoneOffset = Number.isFinite(b.timezoneOffset) ? Number(b.timezoneOffset) : 0;
  if (!name || !start || !end || !reason || !Number.isFinite(interval) || interval <= 0) {
    return res.status(400).json({ error: 'bad-request', message: 'Lengkapi jenis cuti, tanggal, durasi, dan alasan.' });
  }

  try {
    const instanceCode = await createLeaveInstance(openId, { name, start, end, unit, interval, reason: reason.slice(0, 1000), timezoneOffset });
    if (!instanceCode) return res.status(502).json(LARK_FAIL);
    return res.status(201).json({ instanceCode });
  } catch (e) {
    console.error('[leave] create error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

export default router;
