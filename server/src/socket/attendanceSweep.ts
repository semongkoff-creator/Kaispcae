import { Server } from 'socket.io';
import { getPrisma } from '../lib/prisma';
import { ShiftDef, computeTotals, shiftBounds, LOCATION_RETENTION_DAYS } from '@virtualmeet/shared';

// Two scheduled jobs for Attendance.
//
// 1. AUTO CLOCK-OUT (finish criterion #33). Someone who forgets to clock out
//    would otherwise accrue hours forever. After a grace period past their
//    shift's end we close the day, mark it `auto_closed`, and tell them to
//    file a correction — we do NOT guess their real leaving time and we do NOT
//    silently keep the record open.
//
// 2. LOCATION RETENTION (C4). Clock in/out coordinates are point-in-time proof
//    of presence, not an archive of where someone has been. After
//    LOCATION_RETENTION_DAYS they are wiped; the attendance record itself
//    stays. This runs unconditionally — it is not an admin toggle.

const AUTO_CLOSE_AFTER_HOURS = 6;

export function startAttendanceSweep(io: Server, intervalMs = 5 * 60 * 1000): void {
  setInterval(async () => {
    await autoClockOut(io);
    await purgeOldLocations();
  }, intervalMs);
}

async function autoClockOut(io: Server): Promise<void> {
  try {
    const prisma = getPrisma();
    const now = new Date();
    const open = await prisma.attendanceRecord.findMany({
      where: { clockIn: { not: null }, clockOut: null },
      include: { shift: true },
    });
    for (const r of open) {
      if (!r.shift || !r.clockIn) continue;
      const { end } = shiftBounds(r.shift as ShiftDef, r.clockIn);
      const deadline = end.plus({ hours: AUTO_CLOSE_AFTER_HOURS }).toJSDate();
      if (now < deadline) continue;

      // Close at the shift's end, not "now": inventing hours the person didn't
      // work would be worse than admitting we don't know.
      const closeAt = end.toJSDate();
      const totals = computeTotals(r.shift as ShiftDef, r.clockIn, closeAt);
      await prisma.attendanceRecord.update({
        where: { id: r.id },
        data: {
          clockOut: closeAt, status: 'auto_closed',
          workMinutes: totals.workMinutes, overtimeMinutes: 0,
          note: 'Ditutup otomatis karena lupa clock out — ajukan koreksi kalau jamnya tidak sesuai.',
        },
      });
      await prisma.notification.create({
        data: {
          recipientId: r.userId, kind: 'workspace',
          body: 'Kamu lupa clock out. Absensimu ditutup otomatis di jam shift berakhir — ajukan koreksi kalau tidak sesuai.',
        },
      });
      io.to(`user:${r.userId}`).emit('base:notif', {});
      console.log(`[attendance] auto clock-out for record ${r.id}`);
    }
  } catch (e) {
    console.error('[attendance] auto clock-out sweep error:', e);
  }
}

async function purgeOldLocations(): Promise<void> {
  try {
    const prisma = getPrisma();
    const cutoff = new Date(Date.now() - LOCATION_RETENTION_DAYS * 86400000);
    const stale = await prisma.attendanceRecord.findMany({
      where: {
        date: { lt: cutoff },
        locationPurgedAt: null,
        OR: [{ clockInLat: { not: null } }, { clockOutLat: { not: null } }],
      },
      select: { id: true },
      take: 500,
    });
    if (!stale.length) return;
    await prisma.attendanceRecord.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: {
        clockInLat: null, clockInLng: null, clockInAccuracyM: null,
        clockOutLat: null, clockOutLng: null, clockOutAccuracyM: null,
        locationPurgedAt: new Date(),
      },
    });
    console.log(`[attendance] purged location data from ${stale.length} record(s) older than ${LOCATION_RETENTION_DAYS} days`);
  } catch (e) {
    console.error('[attendance] location purge error:', e);
  }
}

// Exported for the test suite: lets a test drive one pass deterministically
// instead of waiting for the interval.
export async function runAttendanceSweepOnce(io: Server): Promise<void> {
  await autoClockOut(io);
  await purgeOldLocations();
}
