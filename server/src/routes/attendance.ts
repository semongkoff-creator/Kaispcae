import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import {
  ShiftDef, clockInStatus, finalStatus, computeTotals, workDayOf, isWorkday,
  checkGeofence, canViewAttendanceOf, lateMinutes, STATUS_LABELS,
} from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveWorkspaceRole } from '../lib/workspace';
import { writeAudit, clientIp } from '../lib/audit';
import { rateLimit } from '../middleware/rateLimit';
import { findUserInOrg } from '../lib/orgScope';

const attendance = Router();
const clockLimit = rateLimit(60 * 1000, 10);
const mutationLimit = rateLimit(60 * 1000, 30);

// THE rule of this module: the time is whatever the SERVER's clock says.
// A client may send a timestamp; we ignore it. This is not paranoia — a user
// can set their OS clock to anything, and attendance is exactly the feature
// people cheat (finish criterion #27).
const serverNow = () => new Date();

type ShiftRow = ShiftDef & { id: string; geofenceLat: number | null; geofenceLng: number | null; geofenceRadiusM: number | null; allowedIps: string[] };

async function shiftFor(prisma: ReturnType<typeof getPrisma>, userId: string, at: Date): Promise<ShiftRow | null> {
  const a = await prisma.shiftAssignment.findFirst({
    where: { userId, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] },
    orderBy: { effectiveFrom: 'desc' },
    include: { shift: true },
  });
  return (a?.shift as ShiftRow) ?? null;
}

function ipAllowed(allowed: string[], ip: string | null): boolean {
  if (!allowed.length) return true;
  if (!ip) return false;
  // Plain prefix match — enough for "10.0.x" style office ranges without
  // pulling in a CIDR library.
  return allowed.some((a) => ip === a || ip.startsWith(a.replace(/\.0\/\d+$/, '.')));
}

// ─── Clock in / out ─────────────────────────────────────────────────

attendance.get('/attendance/today', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const now = serverNow();
    const shift = await shiftFor(prisma, req.userId!, now);
    const zone = shift?.timezone ?? 'Asia/Jakarta';
    const date = workDayOf(now, zone);
    const record = await prisma.attendanceRecord.findUnique({ where: { userId_date: { userId: req.userId!, date } } });
    return res.json({
      // The client renders ITS clock for the ticking display, but every
      // decision (late/on-time) uses this server value.
      serverNow: now.toISOString(),
      shift: shift ? {
        id: shift.id, name: (shift as unknown as { name: string }).name,
        startTime: shift.startTime, endTime: shift.endTime, timezone: shift.timezone,
        graceMinutes: shift.graceMinutes, breakMinutes: shift.breakMinutes, workdays: shift.workdays,
        hasGeofence: shift.geofenceLat != null,
      } : null,
      isWorkday: shift ? isWorkday(shift, now) : true,
      record: record ? {
        id: record.id, date: record.date.toISOString(),
        clockIn: record.clockIn?.toISOString() ?? null,
        clockOut: record.clockOut?.toISOString() ?? null,
        status: record.status, workMinutes: record.workMinutes, overtimeMinutes: record.overtimeMinutes,
      } : null,
    });
  } catch (err) { console.error('[attendance] today error:', err); return res.status(500).json({ error: 'Gagal memuat absensi' }); }
});

attendance.post('/attendance/clock-in', authenticateToken, clockLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const now = serverNow(); // NOT req.body.time — see serverNow()'s note.
    const shift = await shiftFor(prisma, req.userId!, now);
    if (!shift) return res.status(400).json({ error: 'Kamu belum punya shift. Hubungi admin.' });
    const zone = shift.timezone;
    const date = workDayOf(now, zone);

    // Anti-duplicate: one open day at a time (criterion #29).
    const existing = await prisma.attendanceRecord.findUnique({ where: { userId_date: { userId: req.userId!, date } } });
    if (existing?.clockIn && !existing.clockOut) return res.status(409).json({ error: 'Kamu sudah clock in dan belum clock out.' });
    if (existing?.clockIn && existing.clockOut) return res.status(409).json({ error: 'Kamu sudah menyelesaikan absensi hari ini.' });

    const ip = clientIp(req);
    if (!ipAllowed(shift.allowedIps, ip)) return res.status(403).json({ error: 'Clock in hanya diizinkan dari jaringan kantor.' });

    // Geofence is validated HERE, from the coordinates as sent — a forged
    // coordinate is still checked against the fence, and a fuzzy fix is
    // refused rather than quietly accepted (criterion #28).
    const fence = shift.geofenceLat != null && shift.geofenceLng != null && shift.geofenceRadiusM != null
      ? { lat: shift.geofenceLat, lng: shift.geofenceLng, radiusM: shift.geofenceRadiusM }
      : null;
    const coords = req.body?.lat != null ? { lat: Number(req.body.lat), lng: Number(req.body.lng), accuracyM: Number(req.body.accuracyM) } : null;
    const geo = checkGeofence(fence, coords);
    if (!geo.ok) {
      const msg = geo.reason === 'no_location' ? 'Lokasi wajib untuk shift ini.'
        : geo.reason === 'poor_accuracy' ? 'Akurasi GPS terlalu rendah. Coba di tempat terbuka.'
        : `Kamu di luar area kantor (±${geo.distanceM} m dari titik).`;
      return res.status(403).json({ error: msg });
    }

    const record = await prisma.attendanceRecord.upsert({
      where: { userId_date: { userId: req.userId!, date } },
      update: {
        clockIn: now, shiftId: shift.id, status: clockInStatus(shift, now),
        clockInLat: coords?.lat ?? null, clockInLng: coords?.lng ?? null, clockInAccuracyM: coords?.accuracyM ?? null,
        clockInIp: ip,
      },
      create: {
        userId: req.userId!, date, clockIn: now, shiftId: shift.id, status: clockInStatus(shift, now),
        clockInLat: coords?.lat ?? null, clockInLng: coords?.lng ?? null, clockInAccuracyM: coords?.accuracyM ?? null,
        clockInIp: ip,
      },
    });
    const late = lateMinutes(shift, now);
    return res.status(201).json({
      id: record.id, clockIn: record.clockIn?.toISOString(), status: record.status,
      message: late > 0 ? `Terlambat ${late} menit` : 'Tepat waktu',
    });
  } catch (err) { console.error('[attendance] clock-in error:', err); return res.status(500).json({ error: 'Gagal clock in' }); }
});

attendance.post('/attendance/clock-out', authenticateToken, clockLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const now = serverNow();
    const shift = await shiftFor(prisma, req.userId!, now);
    const zone = shift?.timezone ?? 'Asia/Jakarta';
    // A night shift's clock-out lands on the NEXT local day; find the open
    // record rather than assuming today's.
    const open = await prisma.attendanceRecord.findFirst({
      where: { userId: req.userId!, clockIn: { not: null }, clockOut: null },
      orderBy: { date: 'desc' },
    });
    if (!open) return res.status(409).json({ error: 'Kamu belum clock in.' });
    void zone;

    const shiftRow = open.shiftId ? await prisma.shift.findUnique({ where: { id: open.shiftId } }) : shift;
    if (!shiftRow) return res.status(400).json({ error: 'Shift tidak ditemukan' });

    const coords = req.body?.lat != null ? { lat: Number(req.body.lat), lng: Number(req.body.lng), accuracyM: Number(req.body.accuracyM) } : null;
    const fence = shiftRow.geofenceLat != null && shiftRow.geofenceLng != null && shiftRow.geofenceRadiusM != null
      ? { lat: shiftRow.geofenceLat, lng: shiftRow.geofenceLng, radiusM: shiftRow.geofenceRadiusM }
      : null;
    const geo = checkGeofence(fence, coords);
    if (!geo.ok) return res.status(403).json({ error: geo.reason === 'outside' ? `Kamu di luar area kantor (±${geo.distanceM} m).` : 'Lokasi tidak valid untuk clock out.' });

    const totals = computeTotals(shiftRow as ShiftDef, open.clockIn!, now);
    const record = await prisma.attendanceRecord.update({
      where: { id: open.id },
      data: {
        clockOut: now,
        status: finalStatus(shiftRow as ShiftDef, open.clockIn!, now, false),
        workMinutes: totals.workMinutes, overtimeMinutes: totals.overtimeMinutes,
        clockOutLat: coords?.lat ?? null, clockOutLng: coords?.lng ?? null, clockOutAccuracyM: coords?.accuracyM ?? null,
      },
    });
    return res.json({
      id: record.id, clockOut: record.clockOut?.toISOString(), status: record.status,
      workMinutes: record.workMinutes, overtimeMinutes: record.overtimeMinutes,
      message: STATUS_LABELS[record.status as keyof typeof STATUS_LABELS] ?? record.status,
    });
  } catch (err) { console.error('[attendance] clock-out error:', err); return res.status(500).json({ error: 'Gagal clock out' }); }
});

// ─── My history ─────────────────────────────────────────────────────

attendance.get('/attendance/records', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const targetId = String(req.query.userId ?? req.userId!);

    // Peer-to-peer reads are refused: only yourself, your reports, or an admin
    // (criterion #31).
    if (targetId !== req.userId) {
      // Multi-tenant Fase 2 — targetId is client-supplied; findUserInOrg
      // treats a stranger-org id the same as "doesn't exist".
      const [viewerRole, target] = await Promise.all([
        resolveWorkspaceRole(prisma, req.userId!),
        findUserInOrg(prisma, targetId, req.organizationId, { id: true, managerId: true }),
      ]);
      if (!target) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
      if (!canViewAttendanceOf({ id: req.userId!, workspaceRole: viewerRole ?? 'member' }, target)) {
        return res.status(403).json({ error: 'Tidak boleh melihat absensi orang lain' });
      }
      // Looking at someone else's attendance is always recorded — including
      // an admin's look (C4).
      await writeAudit(prisma, {
        actorId: req.userId!, action: 'attendance:viewAll', targetType: 'attendance',
        targetUserId: targetId, meta: { from: req.query.from ?? null, to: req.query.to ?? null }, ip: clientIp(req),
      });
    }

    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 60 * 86400000);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    const records = await prisma.attendanceRecord.findMany({
      where: { userId: targetId, date: { gte: from, lte: to } },
      orderBy: { date: 'desc' },
      select: {
        id: true, date: true, clockIn: true, clockOut: true, status: true,
        workMinutes: true, overtimeMinutes: true, note: true,
      },
    });
    return res.json({
      records: records.map((r) => ({
        ...r, date: r.date.toISOString(),
        clockIn: r.clockIn?.toISOString() ?? null, clockOut: r.clockOut?.toISOString() ?? null,
      })),
    });
  } catch (err) { console.error('[attendance] records error:', err); return res.status(500).json({ error: 'Gagal memuat riwayat' }); }
});

// A member may NOT edit their own record — only request a correction
// (criterion #30). This route exists purely to say so with the right status.
attendance.patch('/attendance/records/:id', authenticateToken, async (_req: AuthRequest, res: Response) => {
  return res.status(403).json({ error: 'Record absensi tidak bisa diubah sendiri. Ajukan koreksi.' });
});

// ─── Corrections ────────────────────────────────────────────────────

attendance.post('/attendance/corrections', authenticateToken, mutationLimit, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const record = await prisma.attendanceRecord.findUnique({ where: { id: String(req.body?.recordId ?? '') } });
    if (!record) return res.status(404).json({ error: 'Record tidak ditemukan' });
    if (record.userId !== req.userId) return res.status(403).json({ error: 'Hanya bisa mengajukan koreksi untuk absensimu sendiri' });
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'Alasan wajib diisi' });

    const c = await prisma.correction.create({
      data: {
        recordId: record.id, userId: req.userId!, reason,
        requestedClockIn: req.body?.requestedClockIn ? new Date(String(req.body.requestedClockIn)) : null,
        requestedClockOut: req.body?.requestedClockOut ? new Date(String(req.body.requestedClockOut)) : null,
      },
    });
    const me = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true, managerId: true } });
    // Multi-tenant Fase 2 — fallback approver fan-out was workspace-wide
    // with no org filter, so a correction request could page another
    // company's admins.
    const approvers = me?.managerId ? [me.managerId] : (await prisma.user.findMany({ where: { workspaceRole: 'admin', active: true, organizationId: req.organizationId }, select: { id: true } })).map((u) => u.id);
    for (const a of approvers) {
      await prisma.notification.create({ data: { recipientId: a, kind: 'workspace', body: `${me?.displayName ?? 'Seseorang'} mengajukan koreksi absensi.` } });
    }
    return res.status(201).json({ id: c.id, status: c.status });
  } catch (err) { console.error('[attendance] correction error:', err); return res.status(500).json({ error: 'Gagal mengajukan koreksi' }); }
});

attendance.get('/attendance/corrections', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const mine = req.query.mine !== 'false';
    const role = await resolveWorkspaceRole(prisma, req.userId!);
    // Multi-tenant Fase 2 — the admin branch used to be `{}`, returning
    // every correction request company-wide regardless of org.
    if (!mine && !req.organizationId) return res.status(401).json({ error: 'Authentication required' });
    const where = mine
      ? { userId: req.userId! }
      : role === 'admin' ? { user: { organizationId: req.organizationId } } : { user: { managerId: req.userId! } };
    if (!mine && role !== 'admin') {
      const reports = await prisma.user.count({ where: { managerId: req.userId! } });
      if (!reports) return res.status(403).json({ error: 'Tidak ada yang perlu kamu setujui' });
    }
    const rows = await prisma.correction.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 100,
      include: { user: { select: { id: true, displayName: true } }, record: { select: { date: true, clockIn: true, clockOut: true } } },
    });
    return res.json({ corrections: rows });
  } catch (err) { console.error('[attendance] list corrections error:', err); return res.status(500).json({ error: 'Gagal memuat koreksi' }); }
});

export default attendance;
