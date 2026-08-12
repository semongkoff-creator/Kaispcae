import { Server } from 'socket.io';
import { DateTime } from 'luxon';
import { PROXIMITY_THRESHOLD, TILE_SIZE } from '@virtualmeet/shared';
import { getPrisma } from '../lib/prisma';
import { getActiveRoomSlugs, pinSystemNotice } from './roomHandler';
import { getCachedPlayers } from '../store/roomStore';
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
    // Migration slice — this used to rank every active user across every
    // org in ONE global leaderboard, then broadcast the winners' real
    // names and scores into every active room on the deployment
    // (getActiveRoomSlugs() with no org filter) — a company's employee
    // ranking and identities leaking straight into another company's
    // rooms. Grouped by org below so each company gets its own
    // leaderboard, notified/pinned/pushed only within its own boundary.
    const users = await prisma.user.findMany({ where: { active: true }, select: { id: true, displayName: true, organizationId: true } });
    if (!users.length) { lastHallOfFameWeekKey = weekKey; return; }

    const usersByOrg = new Map<string, { id: string; displayName: string }[]>();
    for (const u of users) {
      if (!usersByOrg.has(u.organizationId)) usersByOrg.set(u.organizationId, []);
      usersByOrg.get(u.organizationId)!.push({ id: u.id, displayName: u.displayName });
    }

    const activeRoomSlugs = getActiveRoomSlugs();

    for (const [organizationId, orgUsers] of usersByOrg) {
      try {
        const names = new Map(orgUsers.map((u) => [u.id, u.displayName]));
        const categories = await computeRanking(orgUsers.map((u) => u.id), names, priorWeekStart.toJSDate(), priorWeekEnd.toJSDate(), organizationId);
        const winners = categories.filter((c) => c.top.length > 0).map((c) => ({ kategori: c.kategori, winner: c.top[0] }));
        if (!winners.length) continue;

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
        // Intersect the in-memory active-room list (workspace-wide, no org
        // concept of its own) against THIS org's own rooms.
        if (activeRoomSlugs.length) {
          const orgActiveRooms = await prisma.room.findMany({
            where: { organizationId, slug: { in: activeRoomSlugs } }, select: { slug: true },
          });
          for (const { slug } of orgActiveRooms) pinSystemNotice(io, slug, noticeText, 'Hall of Fame');
        }

        const policy = await prisma.workspacePolicy.findUnique({ where: { organizationId } });
        if (policy?.analyticsHallOfFameLarkChatId) {
          void sendGroupText(policy.analyticsHallOfFameLarkChatId, noticeText).catch((e) =>
            console.error('[analytics] Lark Hall of Fame push failed:', e),
          );
        }
      } catch (e) {
        console.error('[analytics] hall of fame sweep error for org:', organizationId, e);
      }
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
}
