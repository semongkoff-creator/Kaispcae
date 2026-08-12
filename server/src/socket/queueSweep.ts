import { Server } from 'socket.io';
import { SocketEvents } from '@kaispace/shared';
import { getPrisma } from '../lib/prisma';
import { advanceQueue, QUEUE_CALL_GRACE_MS } from '../lib/roomQueue';
import { forceLeaveForQueue, forceZoneExitForQueue, broadcastZoneQueueSessionCleared, autoSummonToZoneForQueue, advanceZoneQuickQueue } from './roomHandler';

// "Ngobrol dengan CEO" queue — timers a sweep has to enforce, since none of
// them can be a plain setTimeout (a server restart would silently drop them,
// leaving someone admitted forever or a queue stuck on something that will
// never resolve):
//
// 1. SESSION EXPIRY. A slot's endsAt passed while still 'active' — force the
//    holder out (same cleanup as an admin kick) and call the next person.
// 2. CALL NO-SHOW ('quick' only). Someone was 'called' but never actually
//    got in within the grace window — skip them and call the next person.
//    Excludes 'booking': its 'called' state is EXPECTED to sit for a long
//    time (from CEO approval until the scheduled bookingStart) — that's not
//    a no-show, see pass 3 below for what actually governs a booking.
// 3. BOOKING DUE (v2, zone-level only). An approved booking whose scheduled
//    window has arrived — auto-summon the holder in, or if the window has
//    fully passed (missed entirely, e.g. the zone stayed occupied the whole
//    time, or they were offline), treat it as a no-show and free the slot.
//
// Mirrors attendanceSweep.ts's shape (interval + try/catch per pass, so one
// bad row can't wedge the whole sweep from running again).

export function startQueueSweep(io: Server, intervalMs = 20 * 1000): void {
  setInterval(() => void sweepOnce(io), intervalMs);
}

async function sweepOnce(io: Server): Promise<void> {
  try {
    const prisma = getPrisma();
    const now = new Date();

    const expiredActive = await prisma.roomQueueEntry.findMany({
      where: { status: 'active', endsAt: { lte: now } },
      include: { room: { select: { id: true, slug: true, name: true } } },
    });
    for (const e of expiredActive) {
      try {
        await prisma.roomQueueEntry.update({ where: { id: e.id }, data: { status: 'done', completedAt: now } });
        // Room-level: remove them from the whole room (same as an admin
        // kick). Zone-level: only push them out of the ZONE — a restricted
        // zone inside an otherwise ordinary office must never evict someone
        // from the office itself, just the one area they weren't allowed to
        // keep occupying. bookingMode zones stay freely walkable even after
        // the session ends — no physical nudge, just stop the bookkeeping.
        if (e.zoneId) {
          const restriction = await prisma.zoneRestriction.findUnique({ where: { roomId_zoneId: { roomId: e.room.id, zoneId: e.zoneId } } });
          forceZoneExitForQueue(io, e.userId, e.room.slug, e.zoneId, e.zoneName ?? e.zoneId, !restriction?.bookingMode);
          broadcastZoneQueueSessionCleared(io, e.room.slug, e.zoneId);
          await advanceZoneQuickQueue(io, e.room.id, e.room.slug, e.zoneId);
        } else {
          await forceLeaveForQueue(io, e.userId, e.room.slug, e.room.name);
          await advanceQueue(prisma, e.room.id, null);
        }
      } catch (err) {
        console.error(`[queue] failed to expire active entry ${e.id}:`, err);
      }
    }

    const staleCalled = await prisma.roomQueueEntry.findMany({
      where: { mode: 'quick', status: 'called', calledAt: { lte: new Date(now.getTime() - QUEUE_CALL_GRACE_MS) } },
      include: { room: { select: { id: true, slug: true } } },
    });
    for (const e of staleCalled) {
      try {
        await prisma.roomQueueEntry.update({ where: { id: e.id }, data: { status: 'skipped' } });
        if (e.zoneId) await advanceZoneQuickQueue(io, e.room.id, e.room.slug, e.zoneId);
        else await advanceQueue(prisma, e.room.id, null);
      } catch (err) {
        console.error(`[queue] failed to skip no-show entry ${e.id}:`, err);
      }
    }

    // v2 — approved bookings whose scheduled window has started (zoneId is
    // never null for 'booking', see the join endpoint's own validation).
    const dueBookings = await prisma.roomQueueEntry.findMany({
      where: { mode: 'booking', status: 'called', bookingStart: { lte: now } },
      include: { room: { select: { id: true, slug: true } } },
    });
    for (const e of dueBookings) {
      try {
        if (e.bookingEnd && e.bookingEnd.getTime() <= now.getTime()) {
          // The whole window passed without ever starting — missed entirely
          // (zone stayed occupied the whole time, or approved too late).
          await prisma.roomQueueEntry.update({ where: { id: e.id }, data: { status: 'skipped' } });
          continue;
        }
        // Never force a live conversation out to make room for this — retry
        // next tick instead. A booking starting a little late beats
        // interrupting whatever's already happening in the zone.
        const occupied = await prisma.roomQueueEntry.findFirst({
          where: { roomId: e.room.id, zoneId: e.zoneId!, status: 'active' },
        });
        if (occupied) continue;

        const delivered = autoSummonToZoneForQueue(io, e.userId, e.room.slug, e.zoneId!);
        if (!delivered) {
          // Not online right now — hangus, per the v2 spec (a specific clock
          // time, not "whenever they're next online").
          await prisma.roomQueueEntry.update({ where: { id: e.id }, data: { status: 'skipped' } });
          continue;
        }
        await prisma.roomQueueEntry.update({
          where: { id: e.id },
          data: { status: 'active', startedAt: now, endsAt: e.bookingEnd },
        });
        io.to(e.room.slug).emit(SocketEvents.ZONE_QUEUE_SESSION_ACTIVE, { zoneId: e.zoneId, userId: e.userId, playerName: e.name, endsAt: e.bookingEnd!.getTime() });
      } catch (err) {
        console.error(`[queue] failed to auto-summon booking ${e.id}:`, err);
      }
    }
  } catch (err) {
    console.error('[queue] sweep error:', err);
  }
}

// Exported for the test suite: drives one pass deterministically instead of
// waiting for the interval — same convention as runAttendanceSweepOnce.
export async function runQueueSweepOnce(io: Server): Promise<void> {
  await sweepOnce(io);
}
