import { Router, Response } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { getTodayAttendanceStatus, checkOut } from '../lib/larkAttendance';

// A12 — the NEW Lark-backed attendance endpoints (distinct from the retired
// MeetKai-native ones in attendance.ts). Status is read live from Lark so it
// reflects checkouts done either here or in the Lark app.
const attendanceLark = Router();

// Today's check-in/out status (source of truth = Lark). Frontend polls this on
// load and when the attendance panel opens — not in a background loop.
attendanceLark.get('/attendance/status', authenticateToken, async (req: AuthRequest, res: Response) => {
  const status = await getTodayAttendanceStatus(req.userId!);
  res.json(status);
});

// Check out from MeetKai. Idempotent; a distinct HTTP status per outcome so the
// UI can message precisely.
attendanceLark.post('/attendance/checkout', authenticateToken, async (req: AuthRequest, res: Response) => {
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
});

export default attendanceLark;
