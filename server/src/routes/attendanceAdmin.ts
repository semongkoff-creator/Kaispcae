import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { ShiftDef, computeTotals, finalStatus, canViewAttendanceOf } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireWorkspace, resolveWorkspaceRole } from '../lib/workspace';
import { writeAudit, clientIp } from '../lib/audit';
import { rateLimit } from '../middleware/rateLimit';

const aa = Router();
const mutationLimit = rateLimit(60 * 1000, 30);

// ─── Shifts ─────────────────────────────────────────────────────────

aa.get('/attendance/shifts', authenticateToken, async (_req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    // Readable by everyone: you need to know your own shift's hours. Editing
    // is admin-only below.
    const shifts = await prisma.shift.findMany({ orderBy: { name: 'asc' } });
    return res.json({ shifts });
  } catch (err) { console.error('[attendance] shifts error:', err); return res.status(500).json({ error: 'Gagal memuat shift' }); }
});

aa.post('/admin/attendance/shifts', authenticateToken, requireWorkspace('attendance:manageShifts'), mutationLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const name = String(req.body?.name ?? '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Nama shift wajib diisi' });
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    const startTime = String(req.body?.startTime ?? '');
    const endTime = String(req.body?.endTime ?? '');
    if (!hhmm.test(startTime) || !hhmm.test(endTime)) return res.status(400).json({ error: 'Jam harus format HH:mm' });
    const shift = await prisma.shift.create({
      data: {
        name, startTime, endTime,
        timezone: String(req.body?.timezone ?? 'Asia/Jakarta'),
        breakMinutes: Math.max(0, Math.floor(Number(req.body?.breakMinutes) || 0)),
        graceMinutes: Math.max(0, Math.floor(Number(req.body?.graceMinutes) || 0)),
        workdays: Array.isArray(req.body?.workdays) ? req.body.workdays.map(Number).filter((d: number) => d >= 1 && d <= 7) : [1, 2, 3, 4, 5],
        overtimeRule: ['none', 'after_shift', 'manual'].includes(req.body?.overtimeRule) ? req.body.overtimeRule : 'after_shift',
        geofenceLat: req.body?.geofenceLat != null ? Number(req.body.geofenceLat) : null,
        geofenceLng: req.body?.geofenceLng != null ? Number(req.body.geofenceLng) : null,
        geofenceRadiusM: req.body?.geofenceRadiusM != null ? Math.floor(Number(req.body.geofenceRadiusM)) : null,
        allowedIps: Array.isArray(req.body?.allowedIps) ? req.body.allowedIps.map(String) : [],
      },
    });
    await writeAudit(prisma, { actorId: req.userId!, action: 'attendance:manageShifts', targetType: 'shift', targetId: shift.id, meta: { created: name }, ip: clientIp(req) });
    return res.status(201).json({ shift });
  } catch (err) { console.error('[attendance] create shift error:', err); return res.status(500).json({ error: 'Gagal membuat shift' }); }
});

aa.patch('/admin/attendance/shifts/:id', authenticateToken, requireWorkspace('attendance:manageShifts'), mutationLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const before = await prisma.shift.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Shift tidak ditemukan' });
    const data: Record<string, unknown> = {};
    for (const k of ['name', 'startTime', 'endTime', 'timezone', 'overtimeRule'] as const) if (req.body?.[k] !== undefined) data[k] = String(req.body[k]);
    for (const k of ['breakMinutes', 'graceMinutes', 'geofenceRadiusM'] as const) if (req.body?.[k] !== undefined) data[k] = req.body[k] === null ? null : Math.floor(Number(req.body[k]));
    for (const k of ['geofenceLat', 'geofenceLng'] as const) if (req.body?.[k] !== undefined) data[k] = req.body[k] === null ? null : Number(req.body[k]);
    if (req.body?.workdays !== undefined) data.workdays = req.body.workdays.map(Number);
    if (req.body?.allowedIps !== undefined) data.allowedIps = req.body.allowedIps.map(String);
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Tidak ada perubahan' });
    const shift = await prisma.shift.update({ where: { id: before.id }, data });
    await writeAudit(prisma, {
      actorId: req.userId!, action: 'attendance:manageShifts', targetType: 'shift', targetId: shift.id,
      meta: { before: Object.fromEntries(Object.keys(data).map((k) => [k, (before as Record<string, unknown>)[k]])), after: data }, ip: clientIp(req),
    });
    return res.json({ shift });
  } catch (err) { console.error('[attendance] patch shift error:', err); return res.status(500).json({ error: 'Gagal menyimpan shift' }); }
});

aa.post('/admin/attendance/assignments', authenticateToken, requireWorkspace('attendance:manageShifts'), mutationLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const userId = String(req.body?.userId ?? '');
    const shiftId = String(req.body?.shiftId ?? '');
    const from = req.body?.effectiveFrom ? new Date(String(req.body.effectiveFrom)) : new Date();
    if (!userId || !shiftId) return res.status(400).json({ error: 'userId dan shiftId wajib' });
    const a = await prisma.shiftAssignment.create({
      data: { userId, shiftId, effectiveFrom: from, effectiveTo: req.body?.effectiveTo ? new Date(String(req.body.effectiveTo)) : null },
    });
    await writeAudit(prisma, { actorId: req.userId!, action: 'attendance:manageShifts', targetType: 'assignment', targetId: a.id, targetUserId: userId, meta: { shiftId }, ip: clientIp(req) });
    return res.status(201).json({ assignment: a });
  } catch (err) { console.error('[attendance] assign error:', err); return res.status(500).json({ error: 'Gagal menugaskan shift' }); }
});

// ─── Admin edit of a record — reason REQUIRED (criterion #32) ────────

aa.patch('/admin/attendance/records/:id', authenticateToken, requireWorkspace('attendance:editRecord'), mutationLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const before = await prisma.attendanceRecord.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Record tidak ditemukan' });

    // No reason, no edit. A silent attendance edit is exactly what C5 forbids.
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'Alasan wajib diisi untuk mengubah record absensi' });

    const data: Record<string, unknown> = {};
    if (req.body?.clockIn !== undefined) data.clockIn = req.body.clockIn ? new Date(String(req.body.clockIn)) : null;
    if (req.body?.clockOut !== undefined) data.clockOut = req.body.clockOut ? new Date(String(req.body.clockOut)) : null;
    if (req.body?.status !== undefined) data.status = String(req.body.status);
    if (req.body?.note !== undefined) data.note = req.body.note ? String(req.body.note).slice(0, 500) : null;
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Tidak ada perubahan' });

    // Recompute totals from the edited times rather than trusting anything sent.
    const shift = before.shiftId ? await prisma.shift.findUnique({ where: { id: before.shiftId } }) : null;
    const ci = (data.clockIn as Date) ?? before.clockIn;
    const co = (data.clockOut as Date) ?? before.clockOut;
    if (shift && ci && co) {
      const t = computeTotals(shift as ShiftDef, ci, co);
      data.workMinutes = t.workMinutes;
      data.overtimeMinutes = t.overtimeMinutes;
      if (req.body?.status === undefined) data.status = finalStatus(shift as ShiftDef, ci, co, false);
    }

    const after = await prisma.attendanceRecord.update({ where: { id: before.id }, data });
    await writeAudit(prisma, {
      actorId: req.userId!, action: 'attendance:editRecord', targetType: 'attendance', targetId: before.id,
      targetUserId: before.userId, reason,
      meta: {
        before: { clockIn: before.clockIn, clockOut: before.clockOut, status: before.status, workMinutes: before.workMinutes },
        after: { clockIn: after.clockIn, clockOut: after.clockOut, status: after.status, workMinutes: after.workMinutes },
      },
      ip: clientIp(req),
    });
    await prisma.notification.create({
      data: { recipientId: before.userId, kind: 'workspace', body: `Record absensimu diubah admin. Alasan: ${reason}` },
    });
    return res.json({ record: after });
  } catch (err) { console.error('[attendance] admin edit error:', err); return res.status(500).json({ error: 'Gagal mengubah record' }); }
});

// ─── Leave types & holidays ─────────────────────────────────────────

aa.get('/attendance/leave-types', authenticateToken, async (_req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    return res.json({ types: await prisma.leaveType.findMany({ orderBy: { name: 'asc' } }) });
  } catch (err) { console.error('[attendance] leave types error:', err); return res.status(500).json({ error: 'Gagal' }); }
});

aa.post('/admin/attendance/leave-types', authenticateToken, requireWorkspace('attendance:manageLeaveTypes'), mutationLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Nama wajib diisi' });
    const t = await prisma.leaveType.create({
      data: {
        name,
        quotaPerYear: Math.max(0, Math.floor(Number(req.body?.quotaPerYear) || 0)),
        paid: req.body?.paid !== false,
        requiresApproval: req.body?.requiresApproval !== false,
      },
    });
    await writeAudit(prisma, { actorId: req.userId!, action: 'attendance:manageLeaveTypes', targetType: 'leaveType', targetId: t.id, meta: { created: name }, ip: clientIp(req) });
    return res.status(201).json({ type: t });
  } catch (err) { console.error('[attendance] create leave type error:', err); return res.status(500).json({ error: 'Gagal membuat jenis cuti' }); }
});

aa.post('/admin/attendance/holidays', authenticateToken, requireWorkspace('attendance:manageLeaveTypes'), mutationLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const date = new Date(String(req.body?.date));
    if (isNaN(date.getTime())) return res.status(400).json({ error: 'Tanggal tidak valid' });
    const h = await prisma.holiday.upsert({
      where: { date }, update: { name: String(req.body?.name ?? 'Libur') },
      create: { date, name: String(req.body?.name ?? 'Libur') },
    });
    return res.status(201).json({ holiday: h });
  } catch (err) { console.error('[attendance] holiday error:', err); return res.status(500).json({ error: 'Gagal' }); }
});

// ─── Leave requests ─────────────────────────────────────────────────

aa.post('/attendance/leaves', authenticateToken, mutationLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const typeId = String(req.body?.typeId ?? '');
    const type = await prisma.leaveType.findUnique({ where: { id: typeId } });
    if (!type) return res.status(400).json({ error: 'Jenis cuti tidak valid' });
    const startDate = new Date(String(req.body?.startDate));
    const endDate = new Date(String(req.body?.endDate));
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || endDate < startDate) return res.status(400).json({ error: 'Tanggal tidak valid' });
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'Alasan wajib diisi' });

    // Quota check, server-side. Days already approved this year count.
    const yearStart = new Date(Date.UTC(startDate.getUTCFullYear(), 0, 1));
    const yearEnd = new Date(Date.UTC(startDate.getUTCFullYear(), 11, 31));
    const taken = await prisma.leave.findMany({
      where: { userId: req.userId!, typeId, status: 'approved', startDate: { gte: yearStart, lte: yearEnd } },
      select: { startDate: true, endDate: true, halfDay: true },
    });
    const daysOf = (s: Date, e: Date, half: boolean) => (half ? 0.5 : Math.floor((e.getTime() - s.getTime()) / 86400000) + 1);
    const used = taken.reduce((n, l) => n + daysOf(l.startDate, l.endDate, l.halfDay), 0);
    const want = daysOf(startDate, endDate, !!req.body?.halfDay);
    if (type.quotaPerYear > 0 && used + want > type.quotaPerYear) {
      return res.status(400).json({ error: `Kuota ${type.name} tidak cukup (terpakai ${used}, sisa ${type.quotaPerYear - used}, minta ${want}).` });
    }

    const leave = await prisma.leave.create({
      data: {
        userId: req.userId!, typeId, startDate, endDate, halfDay: !!req.body?.halfDay, reason,
        status: type.requiresApproval ? 'pending' : 'approved',
        decidedAt: type.requiresApproval ? null : new Date(),
      },
    });
    const me = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true, managerId: true } });
    if (type.requiresApproval) {
      const approvers = me?.managerId ? [me.managerId] : (await prisma.user.findMany({ where: { workspaceRole: 'admin', active: true }, select: { id: true } })).map((u) => u.id);
      for (const a of approvers) {
        await prisma.notification.create({ data: { recipientId: a, kind: 'workspace', body: `${me?.displayName ?? 'Seseorang'} mengajukan ${type.name}.` } });
      }
    }
    return res.status(201).json({ leave });
  } catch (err) { console.error('[attendance] leave error:', err); return res.status(500).json({ error: 'Gagal mengajukan cuti' }); }
});

aa.get('/attendance/leaves', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const mine = req.query.mine !== 'false';
    if (mine) {
      const leaves = await prisma.leave.findMany({
        where: { userId: req.userId! }, orderBy: { startDate: 'desc' }, include: { type: true },
      });
      // Remaining quota per type, so the UI never has to guess.
      const types = await prisma.leaveType.findMany();
      const year = new Date().getUTCFullYear();
      const quota = types.map((t) => {
        const used = leaves
          .filter((l) => l.typeId === t.id && l.status === 'approved' && l.startDate.getUTCFullYear() === year)
          .reduce((n, l) => n + (l.halfDay ? 0.5 : Math.floor((l.endDate.getTime() - l.startDate.getTime()) / 86400000) + 1), 0);
        return { typeId: t.id, name: t.name, quotaPerYear: t.quotaPerYear, used, remaining: Math.max(0, t.quotaPerYear - used) };
      });
      return res.json({ leaves, quota });
    }
    // Approver view: your reports, or everyone if admin.
    const role = await resolveWorkspaceRole(prisma, req.userId!);
    const where = role === 'admin' ? {} : { user: { managerId: req.userId! } };
    if (role !== 'admin') {
      const reports = await prisma.user.count({ where: { managerId: req.userId! } });
      if (!reports) return res.status(403).json({ error: 'Tidak ada pengajuan yang perlu kamu setujui' });
    }
    const leaves = await prisma.leave.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 100,
      include: { type: true, user: { select: { id: true, displayName: true } } },
    });
    return res.json({ leaves });
  } catch (err) { console.error('[attendance] list leaves error:', err); return res.status(500).json({ error: 'Gagal memuat cuti' }); }
});

// Approve/reject — admin OR the requester's direct manager.
async function canApprove(prisma: ReturnType<typeof getPrisma>, approverId: string, subjectId: string): Promise<boolean> {
  const role = await resolveWorkspaceRole(prisma, approverId);
  if (role === 'admin') return true;
  const subject = await prisma.user.findUnique({ where: { id: subjectId }, select: { managerId: true } });
  return subject?.managerId === approverId;
}

aa.post('/attendance/leaves/:id/decide', authenticateToken, mutationLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const leave = await prisma.leave.findUnique({ where: { id: req.params.id }, include: { type: true } });
    if (!leave) return res.status(404).json({ error: 'Pengajuan tidak ditemukan' });
    if (leave.userId === req.userId) return res.status(403).json({ error: 'Tidak boleh menyetujui pengajuanmu sendiri' });
    if (!(await canApprove(prisma, req.userId!, leave.userId))) return res.status(403).json({ error: 'Kamu bukan approver untuk orang ini' });
    const status = req.body?.status === 'approved' ? 'approved' : req.body?.status === 'rejected' ? 'rejected' : null;
    if (!status) return res.status(400).json({ error: 'Status tidak valid' });

    const updated = await prisma.leave.update({
      where: { id: leave.id },
      data: { status, approverId: req.userId!, decidedAt: new Date(), decisionNote: req.body?.note ? String(req.body.note).slice(0, 300) : null },
    });
    await writeAudit(prisma, {
      actorId: req.userId!, action: 'attendance:approve', targetType: 'leave', targetId: leave.id,
      targetUserId: leave.userId, meta: { before: { status: leave.status }, after: { status } }, ip: clientIp(req),
    });
    await prisma.notification.create({
      data: { recipientId: leave.userId, kind: 'workspace', body: `Pengajuan ${leave.type.name} kamu ${status === 'approved' ? 'disetujui' : 'ditolak'}.` },
    });
    return res.json({ leave: updated });
  } catch (err) { console.error('[attendance] decide leave error:', err); return res.status(500).json({ error: 'Gagal memutuskan' }); }
});

aa.post('/attendance/corrections/:id/decide', authenticateToken, mutationLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const c = await prisma.correction.findUnique({ where: { id: req.params.id }, include: { record: true } });
    if (!c) return res.status(404).json({ error: 'Koreksi tidak ditemukan' });
    if (c.userId === req.userId) return res.status(403).json({ error: 'Tidak boleh menyetujui koreksimu sendiri' });
    if (!(await canApprove(prisma, req.userId!, c.userId))) return res.status(403).json({ error: 'Kamu bukan approver untuk orang ini' });
    const status = req.body?.status === 'approved' ? 'approved' : 'rejected';

    await prisma.correction.update({ where: { id: c.id }, data: { status, approverId: req.userId!, decidedAt: new Date() } });
    if (status === 'approved') {
      // Only NOW does the requested time touch the record — and it's still the
      // server that recomputes the totals from it.
      const data: Record<string, unknown> = {};
      if (c.requestedClockIn) data.clockIn = c.requestedClockIn;
      if (c.requestedClockOut) data.clockOut = c.requestedClockOut;
      const shift = c.record.shiftId ? await prisma.shift.findUnique({ where: { id: c.record.shiftId } }) : null;
      const ci = (data.clockIn as Date) ?? c.record.clockIn;
      const co = (data.clockOut as Date) ?? c.record.clockOut;
      if (shift && ci && co) {
        const t = computeTotals(shift as ShiftDef, ci, co);
        data.workMinutes = t.workMinutes; data.overtimeMinutes = t.overtimeMinutes;
        data.status = finalStatus(shift as ShiftDef, ci, co, false);
      }
      await prisma.attendanceRecord.update({ where: { id: c.recordId }, data });
      await writeAudit(prisma, {
        actorId: req.userId!, action: 'attendance:editRecord', targetType: 'attendance', targetId: c.recordId,
        targetUserId: c.userId, reason: `Koreksi disetujui: ${c.reason}`,
        meta: { before: { clockIn: c.record.clockIn, clockOut: c.record.clockOut }, after: { clockIn: ci, clockOut: co } },
        ip: clientIp(req),
      });
    }
    await prisma.notification.create({
      data: { recipientId: c.userId, kind: 'workspace', body: `Koreksi absensimu ${status === 'approved' ? 'disetujui' : 'ditolak'}.` },
    });
    return res.json({ status });
  } catch (err) { console.error('[attendance] decide correction error:', err); return res.status(500).json({ error: 'Gagal memutuskan' }); }
});

// ─── Admin report ───────────────────────────────────────────────────

aa.get('/admin/attendance/report', authenticateToken, requireWorkspace('attendance:exportReports'), async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const from = new Date(String(req.query.from ?? new Date(Date.now() - 30 * 86400000).toISOString()));
    const to = new Date(String(req.query.to ?? new Date().toISOString()));
    const departmentId = req.query.departmentId ? String(req.query.departmentId) : undefined;

    const rows = await prisma.attendanceRecord.findMany({
      where: { date: { gte: from, lte: to }, user: departmentId ? { departmentId } : undefined },
      include: { user: { select: { id: true, displayName: true, department: { select: { name: true } } } } },
      orderBy: [{ date: 'desc' }],
      take: 5000,
    });
    await writeAudit(prisma, {
      actorId: req.userId!, action: 'attendance:exportReports', targetType: 'attendance',
      meta: { rows: rows.length, from: from.toISOString(), to: to.toISOString(), departmentId: departmentId ?? null }, ip: clientIp(req),
    });

    if (req.query.format === 'csv') {
      const head = 'Nama,Departemen,Tanggal,Masuk,Keluar,Status,Menit kerja,Lembur\n';
      const body = rows.map((r) => [
        r.user.displayName, r.user.department?.name ?? '', r.date.toISOString().slice(0, 10),
        r.clockIn?.toISOString() ?? '', r.clockOut?.toISOString() ?? '', r.status, r.workMinutes, r.overtimeMinutes,
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="absensi.csv"');
      return res.send('﻿' + head + body); // BOM so Excel reads UTF-8
    }
    return res.json({
      records: rows.map((r) => ({
        id: r.id, userId: r.user.id, name: r.user.displayName, department: r.user.department?.name ?? null,
        date: r.date.toISOString(), clockIn: r.clockIn?.toISOString() ?? null, clockOut: r.clockOut?.toISOString() ?? null,
        status: r.status, workMinutes: r.workMinutes, overtimeMinutes: r.overtimeMinutes,
      })),
    });
  } catch (err) { console.error('[attendance] report error:', err); return res.status(500).json({ error: 'Gagal memuat laporan' }); }
});

// Team view for managers — their direct reports only, no admin power needed.
aa.get('/attendance/team', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const reports = await prisma.user.findMany({ where: { managerId: req.userId! }, select: { id: true, displayName: true, managerId: true } });
    if (!reports.length) return res.json({ records: [] });
    const role = await resolveWorkspaceRole(prisma, req.userId!);
    for (const r of reports) {
      if (!canViewAttendanceOf({ id: req.userId!, workspaceRole: role ?? 'member' }, r)) return res.status(403).json({ error: 'Forbidden' });
    }
    const from = new Date(String(req.query.from ?? new Date(Date.now() - 14 * 86400000).toISOString()));
    const records = await prisma.attendanceRecord.findMany({
      where: { userId: { in: reports.map((r) => r.id) }, date: { gte: from } },
      include: { user: { select: { id: true, displayName: true } } },
      orderBy: { date: 'desc' },
    });
    await writeAudit(prisma, {
      actorId: req.userId!, action: 'attendance:viewAll', targetType: 'attendance',
      meta: { team: reports.map((r) => r.id), rows: records.length }, ip: clientIp(req),
    });
    return res.json({ records });
  } catch (err) { console.error('[attendance] team error:', err); return res.status(500).json({ error: 'Gagal' }); }
});

export default aa;
