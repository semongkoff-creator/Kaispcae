import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { listTodayTasks, getTaskOptions, createTask, updateTaskStatus } from '../lib/larkTasks';

// A7 — Daily Task API. Thin bridge to the Lark Base table (see lib/larkTasks);
// stores nothing locally. Every handler returns a clear error the widget can
// show — a Lark outage/scope issue must never surface as a silently empty list.
const router = Router();

// The Owner (Lark User) field keys on open_id, so a manual-login user with no
// larkOpenId can't own or be filtered by tasks. Surfaced as a distinct 409 so
// the widget can prompt "connect Lark" instead of showing a generic error.
async function requireLarkOpenId(userId: string): Promise<string | null> {
  const u = await getPrisma().user.findUnique({ where: { id: userId }, select: { larkOpenId: true } });
  return u?.larkOpenId ?? null;
}

const NO_LARK = { error: 'no-lark', message: 'Hubungkan akun Lark dulu (login lewat Lark) untuk memakai Daily Task.' };
const LARK_FAIL = { error: 'lark', message: 'Gagal terhubung ke Lark. Coba lagi sebentar.' };

router.get('/tasks/today', authenticateToken, async (req: AuthRequest, res: Response) => {
  const openId = await requireLarkOpenId(req.userId!);
  if (!openId) return res.status(409).json(NO_LARK);
  try {
    return res.json({ tasks: await listTodayTasks(openId) });
  } catch (e) {
    console.error('[tasks] today error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

router.get('/tasks/options', authenticateToken, async (_req: AuthRequest, res: Response) => {
  try {
    return res.json(await getTaskOptions());
  } catch (e) {
    console.error('[tasks] options error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

router.post('/tasks', authenticateToken, async (req: AuthRequest, res: Response) => {
  const openId = await requireLarkOpenId(req.userId!);
  if (!openId) return res.status(409).json(NO_LARK);
  const task = String(req.body?.task ?? '').trim();
  if (!task) return res.status(400).json({ error: 'bad-request', message: 'Judul tugas wajib diisi.' });
  try {
    const created = await createTask(
      {
        task: task.slice(0, 500),
        workstream: req.body?.workstream || undefined,
        priority: req.body?.priority || undefined,
        status: req.body?.status || undefined,
        notes: typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 2000) : undefined,
        dueDate: typeof req.body?.dueDate === 'number' ? req.body.dueDate : undefined,
        projectRecordId: req.body?.projectRecordId || undefined,
      },
      openId,
    );
    return res.status(201).json({ task: created });
  } catch (e) {
    console.error('[tasks] create error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

router.patch('/tasks/:recordId', authenticateToken, async (req: AuthRequest, res: Response) => {
  const status = String(req.body?.status ?? '').trim();
  if (!status) return res.status(400).json({ error: 'bad-request', message: 'Status wajib diisi.' });
  try {
    await updateTaskStatus(req.params.recordId, status);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[tasks] update error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

export default router;
