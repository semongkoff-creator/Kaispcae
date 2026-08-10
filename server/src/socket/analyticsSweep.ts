import { Server } from 'socket.io';
import { DateTime } from 'luxon';
import { PROXIMITY_THRESHOLD, TILE_SIZE } from '@virtualmeet/shared';
import { getPrisma } from '../lib/prisma';
import { getActiveRoomSlugs, pinSystemNotice } from './roomHandler';
import { getCachedPlayers } from '../store/roomStore';
import { listTasksInRange } from '../lib/larkTasks';
import { computeRanking } from '../routes/analytics';
import { sendGroupText } from '../lib/larkIm';
import { broadcastAnalyticsActivity } from './analyticsFeed';
import { prunePendingPokes } from '../lib/pokeResponse';

// Productivity Analytics — Bagian A.2's "connection" event (spontaneous
// proximity chat between two people). No server-side proximity signal
// existed before this (client-side WebRTC connect is 100% local, see
// useProximity.ts) — this tick is the whole of that new subsystem.
//
// Deliberately NOT derived from Zone co-occupancy: most of the map isn't
// inside a defined Zone, so that would miss most real proximity chats and
// undermine the "spontaneous, no scheduling needed" metric the brief's ROI
// card depends on. Position-distance is the only signal that covers the
// whole map the way actual proximity A/V does.
//
// One row per (pair, cooldown window) — not per tick — so one long
// conversation isn't counted as dozens of separate "connections". Cooldown
// state is in-memory only (same caveat as every other in-memory cache in
// roomStore.ts: fine for a single server process).
const CONNECTION_COOLDOWN_MS = 10 * 60 * 1000;
const lastLoggedAt = new Map<string, number>();

function pairKey(roomSlug: string, uidA: string, uidB: string): string {
  return uidA < uidB ? `${roomSlug}:${uidA}:${uidB}` : `${roomSlug}:${uidB}:${uidA}`;
}

export function startAnalyticsSweep(
  io: Server,
  proximityIntervalMs = 20 * 1000,
  taskSyncIntervalMs = 15 * 60 * 1000,
  hallOfFameCheckIntervalMs = 5 * 60 * 1000,
): void {
  setInterval(() => void sweepProximityOnce(io), proximityIntervalMs);
  setInterval(() => void syncTaskCompletionsOnce(), taskSyncIntervalMs);
  setInterval(() => void runWeeklyHallOfFameOnce(io), hallOfFameCheckIntervalMs);
}

async function sweepProximityOnce(io: Server): Promise<void> {
  try {
    const prisma = getPrisma();
    const now = Date.now();

    // Prune entries whose cooldown has already lapsed — they're dead
    // weight either way (a pair past cooldown is re-logged fresh next
    // tick, same as if the entry never existed), so this is a correctness
    // no-op that also stops the map from growing without bound over a
    // long-running process (every distinct pair that's EVER been close
    // would otherwise sit here forever).
    for (const [key, loggedAt] of lastLoggedAt) {
      if (now - loggedAt >= CONNECTION_COOLDOWN_MS) lastLoggedAt.delete(key);
    }
    // Same unbounded-growth guard for pokeResponse.ts's own in-memory map.
    prunePendingPokes();

    for (const roomSlug of getActiveRoomSlugs()) {
      // Guests have no User row (FK would fail) — same exclusion as every
      // other analytics write. `userId` is only set once auth resolves it.
      const players = getCachedPlayers(roomSlug).filter((p) => !p.isGuest && p.userId);
      for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
          const a = players[i];
          const b = players[j];
          const uidA = a.userId!;
          const uidB = b.userId!;
          if (uidA === uidB) continue; // same account, two tabs/reconnect ghost

          try {
            const distanceTiles = Math.hypot(a.x - b.x, a.y - b.y) / TILE_SIZE;
            if (distanceTiles > PROXIMITY_THRESHOLD) continue;

            const key = pairKey(roomSlug, uidA, uidB);
            const last = lastLoggedAt.get(key);
            if (last !== undefined && now - last < CONNECTION_COOLDOWN_MS) continue;

            lastLoggedAt.set(key, now);
            const [userAId, userBId] = uidA < uidB ? [uidA, uidB] : [uidB, uidA];
            await prisma.connectionEvent.create({ data: { roomSlug, userAId, userBId } });
            // v2 Bagian B.2 #5 — Office Activity Feed. Broadcast from BOTH
            // sides (proximity is mutual, unlike a poke's clear sender) so
            // each side's own manager sees it regardless of who "started" it.
            broadcastAnalyticsActivity(io, a.userId!, a.name, 'connection', undefined, { userId: b.userId!, userName: b.name });
            broadcastAnalyticsActivity(io, b.userId!, b.name, 'connection', undefined, { userId: a.userId!, userName: a.name });
          } catch (e) {
            console.error(`[analytics] failed to record connection ${uidA}/${uidB} in ${roomSlug}:`, e);
          }
        }
      }
    }
  } catch (e) {
    console.error('[analytics] proximity sweep error:', e);
  }
}

// Productivity Analytics — daily snapshot of Lark Base "Daily Task"
// completions (Bagian B.3.1's "Task selesai" card / B.5's task inputs). Lark
// Base has no company-wide query today (see larkTasks.ts's listTasksInRange)
// and isn't cheap enough to hit on every dashboard load, so this runs once a
// WIB calendar day instead — gated by an in-memory "already did today's
// date" marker rather than a cron dependency, same interval-based posture as
// every other sweep in this codebase. Resets on restart, which is harmless:
// the upsert below is idempotent, so an accidental re-run just re-writes the
// same numbers.
let lastTaskSyncDateKey: string | null = null;

async function syncTaskCompletionsOnce(): Promise<void> {
  try {
    const now = DateTime.now().setZone('Asia/Jakarta');
    // Give the day a moment to fully close out before snapshotting it.
    if (now.hour === 0 && now.minute < 10) return;
    const yesterday = now.minus({ days: 1 });
    const dateKey = yesterday.toFormat('yyyy-LL-dd');
    if (dateKey === lastTaskSyncDateKey) return;

    const prisma = getPrisma();
    const policy = await prisma.workspacePolicy.findUnique({ where: { id: 'singleton' } });
    const doneValues = new Set(
      (policy?.analyticsTaskDoneStatusValues ?? ['Done', 'Selesai', 'Completed']).map((s) => s.toLowerCase()),
    );

    const startMs = yesterday.startOf('day').toMillis();
    const endMs = yesterday.endOf('day').toMillis();
    const tasks = await listTasksInRange(startMs, endMs);

    const perUser = new Map<string, { due: number; completed: number }>();
    for (const task of tasks) {
      const isDone = !!task.status && doneValues.has(task.status.toLowerCase());
      for (const openId of task.ownerOpenIds) {
        const owner = await prisma.user.findFirst({ where: { larkOpenId: openId }, select: { id: true } });
        if (!owner) continue;
        const agg = perUser.get(owner.id) ?? { due: 0, completed: 0 };
        agg.due += 1;
        if (isDone) agg.completed += 1;
        perUser.set(owner.id, agg);
      }
    }

    const date = new Date(Date.UTC(yesterday.year, yesterday.month - 1, yesterday.day));
    for (const [userId, agg] of perUser) {
      try {
        // onTimeCount === completedCount — see the field's doc comment in
        // schema.prisma for why "on time" can't actually be distinguished
        // from "done" with the fields Lark Base exposes today.
        await prisma.taskCompletionSnapshot.upsert({
          where: { userId_date: { userId, date } },
          create: { userId, date, dueCount: agg.due, completedCount: agg.completed, onTimeCount: agg.completed },
          update: { dueCount: agg.due, completedCount: agg.completed, onTimeCount: agg.completed },
        });
      } catch (e) {
        console.error(`[analytics] failed to snapshot tasks for user ${userId}:`, e);
      }
    }
    lastTaskSyncDateKey = dateKey;
  } catch (e) {
    console.error('[analytics] task snapshot sync error:', e);
  }
}

// Bagian C.6 — weekly Hall of Fame. Gated by an in-memory "already did this
// ISO week" marker, checked on a 5-min interval within a Monday-00:05-00:20
// WIB window (the 5-minute head start lets syncTaskCompletionsOnce's own
// 00:10 gate finish snapshotting last week's final day first). Same
// restart-is-harmless reasoning as lastTaskSyncDateKey above.
let lastHallOfFameWeekKey: string | null = null;

async function runWeeklyHallOfFameOnce(io: Server): Promise<void> {
  try {
    const now = DateTime.now().setZone('Asia/Jakarta');
    if (!(now.weekday === 1 && now.hour === 0 && now.minute >= 5 && now.minute < 20)) return;
    const priorWeekStart = now.startOf('week').minus({ weeks: 1 });
    const priorWeekEnd = priorWeekStart.endOf('week');
    const weekKey = priorWeekStart.toFormat("kkkk-'W'WW");
    if (weekKey === lastHallOfFameWeekKey) return;

    const prisma = getPrisma();
    const users = await prisma.user.findMany({ where: { active: true }, select: { id: true, displayName: true } });
    if (!users.length) { lastHallOfFameWeekKey = weekKey; return; }

    const names = new Map(users.map((u) => [u.id, u.displayName]));
    const categories = await computeRanking(users.map((u) => u.id), names, priorWeekStart.toJSDate(), priorWeekEnd.toJSDate());
    const winners = categories.filter((c) => c.top.length > 0).map((c) => ({ kategori: c.kategori, winner: c.top[0] }));
    if (!winners.length) { lastHallOfFameWeekKey = weekKey; return; }

    for (const w of winners) {
      try {
        await prisma.notification.create({
          data: { recipientId: w.winner.userId, kind: 'workspace', body: `🔥 ${w.kategori} — Minggu ${priorWeekStart.toFormat('W')} (${w.winner.nilai})` },
        });
        io.to(`user:${w.winner.userId}`).emit('base:notif', {});
      } catch (e) {
        console.error('[analytics] failed to notify hall-of-fame winner:', w.winner.userId, e);
      }
    }

    const noticeText = `🏆 Hall of Fame — Minggu ${priorWeekStart.toFormat('d LLL')} s/d ${priorWeekEnd.toFormat('d LLL')}\n${
      winners.map((w) => `${w.kategori}: ${w.winner.user} (${w.winner.nilai})`).join('\n')
    }`;
    for (const roomSlug of getActiveRoomSlugs()) {
      pinSystemNotice(io, roomSlug, noticeText, 'Hall of Fame');
    }

    const policy = await prisma.workspacePolicy.findUnique({ where: { id: 'singleton' } });
    if (policy?.analyticsHallOfFameLarkChatId) {
      void sendGroupText(policy.analyticsHallOfFameLarkChatId, noticeText).catch((e) =>
        console.error('[analytics] Lark Hall of Fame push failed:', e),
      );
    }

    lastHallOfFameWeekKey = weekKey;
  } catch (e) {
    console.error('[analytics] hall of fame sweep error:', e);
  }
}

// Exported for the test suite, same convention as runQueueSweepOnce/
// runAttendanceSweepOnce. Hall of Fame is deliberately NOT included here —
// it's time-gated to a specific weekly window, so a manual test drives it
// directly rather than through this always-run hook.
export async function runAnalyticsSweepOnce(io: Server): Promise<void> {
  await sweepProximityOnce(io);
  await syncTaskCompletionsOnce();
}
