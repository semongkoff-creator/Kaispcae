import { Server } from 'socket.io';
import { getPrisma } from '../lib/prisma';
import { advanceQueue, QUEUE_CALL_GRACE_MS } from '../lib/roomQueue';
import { forceLeaveForQueue, forceZoneExitForQueue, broadcastZoneQueueSessionCleared } from './roomHandler';

// "Ngobrol dengan CEO" queue — two timers a sweep has to enforce, since
// neither can be a plain setTimeout (a server restart would silently drop
// them, leaving someone admitted forever or a queue stuck waiting on a
// no-show that will never resolve):
//
// 1. SESSION EXPIRY. A slot's endsAt passed while still 'active' — force the
//    holder out (same cleanup as an admin kick) and call the next person.
// 2. CALL NO-SHOW. Someone was 'called' but never actually walked in within
//    the grace window — skip them and call the next person, so one absent
//    person can't jam the whole line.
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
        // keep occupying.
        if (e.zoneId) {
          await forceZoneExitForQueue(io, e.userId, e.room.slug, e.zoneId, e.zoneName ?? e.zoneId);
          broadcastZoneQueueSessionCleared(io, e.room.slug, e.zoneId);
        } else {
          await forceLeaveForQueue(io, e.userId, e.room.slug, e.room.name);
        }
        await advanceQueue(prisma, e.room.id, e.zoneId);
      } catch (err) {
        console.error(`[queue] failed to expire active entry ${e.id}:`, err);
      }
    }

    const staleCalled = await prisma.roomQueueEntry.findMany({
      where: { status: 'called', calledAt: { lte: new Date(now.getTime() - QUEUE_CALL_GRACE_MS) } },
      include: { room: { select: { id: true } } },
    });
    for (const e of staleCalled) {
      try {
        await prisma.roomQueueEntry.update({ where: { id: e.id }, data: { status: 'skipped' } });
        await advanceQueue(prisma, e.room.id, e.zoneId);
      } catch (err) {
        console.error(`[queue] failed to skip no-show entry ${e.id}:`, err);
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
