import { Router, Response } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { getTodayAttendanceStatus, checkOut } from '../lib/larkAttendance';

// A12 — the NEW Lark-backed attendance endpoints (distinct from the retired
// MeetKai-native ones in attendance.ts). Status is read live from Lark so it
// reflects checkouts done either here or in the Lark app.
const attendanceLark = Router();

// Today's check-in/out status (source of truth = Lark). Frontend polls this on
// load and when the attendance panel opens — not in a background loop.
//
// QA (Integrasi checklist item 13, "Kegagalan anggun") — wrapped so a DB
// hiccup or an unexpected Lark client error surfaces as a clean 502 to this
// one request, same posture as routes/tasks.ts's LARK_FAIL pattern, instead
// of an uncaught rejection that (pre this fix) had nowhere to go under
// Express 4 and would have hung the request indefinitely.
attendanceLark.get('/attendance/status', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const status = await getTodayAttendanceStatus(req.userId!);
    res.json(status);
  } catch (e) {
    console.error('[attendance] status check failed:', e);
    res.status(502).json({ error: 'Gagal memuat status absensi. Coba lagi.' });
  }
});

// Check out from MeetKai. Idempotent; a distinct HTTP status per outcome so the
// UI can message precisely.
attendanceLark.post('/attendance/checkout', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const outcome = await checkOut(req.userId!);
    if (outcome.ok) return res.json(outcome.status);
    const map = {
      not_lark: { code: 400, error: 'Akun ini tidak terhubung ke Lark.' },
      not_checked_in: { code: 400, error: 'Belum check-in hari ini.' },
      already_checked_out: { code: 409, error: 'Sudah checkout hari ini.' },
      lark_error: { code: 502, error: 'Gagal mengirim checkout ke Lark. Coba lagi.' },
    } as const;
    const m = map[outcome.reason];
    return res.status(m.code).json({ error: m.error, status: outcome.status });
  } catch (e) {
    console.error('[attendance] checkout failed:', e);
    return res.status(502).json({ error: 'Gagal memproses checkout. Coba lagi.' });
  }
});

export default attendanceLark;
