import { Router, Response } from 'express';
import { DateTime } from 'luxon';
import ExcelJS from 'exceljs';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveWorkspaceRole, requireWorkspace } from '../lib/workspace';
import { writeAudit, clientIp } from '../lib/audit';
import { getOnlineUserIds } from '../socket/roomHandler';
import { canViewAnalyticsOf, applyOvertimeGrace, finalStatus, workDayOf, ShiftDef, layerDataToLegacy, LayerData, ZoneType } from '@virtualmeet/shared';
import { findUserInOrg } from '../lib/orgScope';

const router = Router();

// ─── Period parsing (Bagian B.2) — shared by every tier's endpoint ────────
export type PeriodType = 'daily' | 'weekly' | 'monthly' | 'custom';

export function parsePeriod(query: { period?: unknown; from?: unknown; to?: unknown }): { type: PeriodType; start: Date; end: Date } {
  const raw = String(query.period ?? '');
  const type: PeriodType = (['daily', 'weekly', 'monthly', 'custom'] as const).includes(raw as PeriodType) ? (raw as PeriodType) : 'weekly';
  const now = DateTime.now().setZone('Asia/Jakarta');

  if (type === 'custom') {
    let start = query.from ? DateTime.fromISO(String(query.from), { zone: 'Asia/Jakarta' }).startOf('day') : DateTime.invalid('missing');
    let end = query.to ? DateTime.fromISO(String(query.to), { zone: 'Asia/Jakarta' }).endOf('day') : DateTime.invalid('missing');
    if (!start.isValid || !end.isValid || start > end) {
      start = now.startOf('week');
      end = now.endOf('week');
    } else if (end.diff(start, 'days').days > 366) {
      end = start.plus({ days: 366 }).endOf('day');
    }
    return { type, start: start.toJSDate(), end: end.toJSDate() };
  }
  if (type === 'daily') return { type, start: now.startOf('day').toJSDate(), end: now.endOf('day').toJSDate() };
  if (type === 'monthly') return { type, start: now.startOf('month').toJSDate(), end: now.endOf('month').toJSDate() };
  // Weekly (default) — luxon's startOf('week') is Monday (ISO 8601),
  // matching the brief's "minggu berjalan (Senin–Minggu WIB)" exactly.
  return { type, start: now.startOf('week').toJSDate(), end: now.endOf('week').toJSDate() };
}

// StatusInterval/ConnectionEvent store real instants and can be compared
// against `start`/`end` directly. DailyVibeCounter/TaskCompletionSnapshot/
// AttendanceRecord instead store a `date` BUCKET — 00:00 UTC of the WIB
// calendar day number, NOT the real UTC instant of that day's WIB midnight
// (see workDayOf's own doc comment; AttendanceRecord.date already uses this
// exact convention). Comparing a raw period instant against a bucket value
// directly would be off by WIB's fixed 7-hour offset at the boundaries —
// both ends must be bucketed the same way before querying.
function bucketedRange(start: Date, end: Date): { gte: Date; lte: Date } {
  return { gte: workDayOf(start, 'Asia/Jakarta'), lte: workDayOf(end, 'Asia/Jakarta') };
}

// Bagian B.3.1's "Target jam kerja per periode" — default 40j/minggu,
// scaled by the period's actual day count (PERLU KONFIRMASI per Bagian D;
// this default is the brief's own stated fallback).
function targetWorkMinutes(start: Date, end: Date): number {
  const days = Math.max(1, DateTime.fromJSDate(end).diff(DateTime.fromJSDate(start), 'days').days);
  return Math.round((40 * 60) * (days / 7));
}

// A.3's 6-status distribution + B.3.1's Focus/Meeting-time cards, clipped to
// [start,end). An open interval (endedAt null) is clipped at `now` (it's
// still ongoing) or `end`, whichever is earlier. 'offline' is computed as
// the period span minus every known-status minute — literal to Bagian A.3
// ("Offline hanya saat tidak ada session"), which does mean it dominates a
// week/month view for anyone who isn't online 24/7; that's what the brief
// specifies, not an oversight.
async function computeStatusDistribution(userId: string, start: Date, end: Date) {
  const prisma = getPrisma();
  const intervals = await prisma.statusInterval.findMany({
    where: { userId, startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gt: start } }] },
  });
  const now = new Date();
  const totals: Record<string, number> = { available: 0, focus: 0, in_meeting: 0, busy: 0, away: 0 };
  for (const iv of intervals) {
    const clipStart = iv.startedAt < start ? start : iv.startedAt;
    const rawEnd = iv.endedAt ?? now;
    const clipEnd = rawEnd > end ? end : rawEnd;
    const ms = clipEnd.getTime() - clipStart.getTime();
    if (ms <= 0) continue;
    if (iv.status in totals) totals[iv.status] += ms;
  }
  const periodMs = end.getTime() - start.getTime();
  const knownMs = Object.values(totals).reduce((a, b) => a + b, 0);
  const offlineMs = Math.max(0, periodMs - knownMs);
  return {
    availableMinutes: Math.round(totals.available / 60000),
    focusMinutes: Math.round(totals.focus / 60000),
    inMeetingMinutes: Math.round(totals.in_meeting / 60000),
    busyMinutes: Math.round(totals.busy / 60000),
    awayMinutes: Math.round(totals.away / 60000),
    offlineMinutes: Math.round(offlineMs / 60000),
  };
}

// v2 Bagian B.4 — resolves a Zone's `type` (the closest available
// voluntary-vs-required signal — see computeVibe's "voluntary call-join
// rate" component) from whichever source is authoritative for this room
// (modern layerData-backed rooms vs legacy `zones` JSON) — same resolution
// roomHandler.ts's own ROOM_STATE emit already uses, reused here rather
// than re-derived, so a room converted to the modern editor doesn't
// silently break this lookup.
async function resolveZoneType(roomSlug: string, zoneId: string): Promise<ZoneType | undefined> {
  const prisma = getPrisma();
  const room = await prisma.room.findUnique({ where: { slug: roomSlug }, select: { zones: true, layerData: true } });
  if (!room) return undefined;
  let zones: { id: string; type?: string }[] = [];
  if (room.layerData) {
    try { zones = layerDataToLegacy(room.layerData as unknown as LayerData).zones; } catch { zones = []; }
  } else if (Array.isArray(room.zones)) {
    zones = room.zones as unknown as { id: string; type?: string }[];
  }
  return zones.find((z) => z.id === zoneId)?.type as ZoneType | undefined;
}

// v2 Bagian B.4 — the new 4-component behavioral Vibe formula, replacing
// v1's emote/chat/furniture/connection weighted sum. Each component is 0-1
// normalized; `null` means "no data for this person this period" (not "bad")
// and is EXCLUDED from the weighted average with its weight redistributed
// proportionally among the rest — same fairness spirit as Bagian C.4.1's
// data-sufficiency exclusion, applied per-component instead of per-person.
// Weights are admin-editable WorkspacePolicy fields (brief flags them as
// unconfirmed) — never hardcoded "what matters most" assumptions.
async function computeVibe(userId: string, start: Date, end: Date, organizationId: string) {
  const prisma = getPrisma();
  const days = Math.max(1, DateTime.fromJSDate(end).diff(DateTime.fromJSDate(start), 'days').days);
  const [counters, connectionCount, policy, pokeAgg, meetingIntervals, records] = await Promise.all([
    prisma.dailyVibeCounter.aggregate({
      where: { userId, date: bucketedRange(start, end) },
      _sum: { emoteCount: true, waveCount: true, chatCount: true, furnitureCount: true },
    }),
    prisma.connectionEvent.count({
      where: { occurredAt: { gte: start, lt: end }, OR: [{ userAId: userId }, { userBId: userId }] },
    }),
    // Migration slice — WorkspacePolicy is now keyed by organizationId, not
    // a single shared id='singleton' row every org used to read (and, via
    // the PATCH route, silently overwrite for every other org's users too).
    prisma.workspacePolicy.findUnique({ where: { organizationId } }),
    prisma.pokeResponseSample.aggregate({
      where: { userId, occurredAt: { gte: start, lt: end } },
      _avg: { latencyMs: true }, _count: true,
    }),
    prisma.statusInterval.findMany({
      where: { userId, status: 'in_meeting', startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gt: start } }] },
      select: { roomSlug: true, zoneId: true, startedAt: true, endedAt: true },
    }),
    prisma.attendanceRecord.findMany({ where: { userId, date: bucketedRange(start, end) }, select: { overtimeMinutes: true, status: true } }),
  ]);

  const emote = counters._sum.emoteCount ?? 0;
  const wave = counters._sum.waveCount ?? 0;
  const chat = counters._sum.chatCount ?? 0;
  const furniture = counters._sum.furnitureCount ?? 0;

  // 1. Emote engagement — reinterpreted from "positive rate" (Bagian B.4)
  // since no negative/neutral emote exists to compare against (checked:
  // EmoteType is wave|clap|laugh|heart|party|think|sleep|fire, all
  // positive-leaning) — this is normalized engagement frequency instead.
  const emoteComponent = Math.min(1, (emote / days) / 5);

  // 2. Poke response time — null (excluded, not penalized) if this person
  // was never poked, or never gave a qualifying response, this period.
  const ceilingSec = policy?.analyticsPokeResponseCeilingSeconds ?? 120;
  const pokeComponent = pokeAgg._count > 0 && pokeAgg._avg.latencyMs != null
    ? Math.max(0, 1 - (pokeAgg._avg.latencyMs / 1000) / ceilingSec)
    : null;

  // 3. Voluntary call-join rate — in_meeting minutes spent in a 'general'
  // zone (not a dedicated 'meeting' room) over total in_meeting minutes.
  const now = new Date();
  let totalMeetingMs = 0;
  let voluntaryMeetingMs = 0;
  const zoneTypeCache = new Map<string, ZoneType | undefined>();
  for (const iv of meetingIntervals) {
    const clipStart = iv.startedAt < start ? start : iv.startedAt;
    const rawEnd = iv.endedAt ?? now;
    const clipEnd = rawEnd > end ? end : rawEnd;
    const ms = clipEnd.getTime() - clipStart.getTime();
    if (ms <= 0) continue;
    totalMeetingMs += ms;
    if (iv.zoneId) {
      const cacheKey = `${iv.roomSlug}:${iv.zoneId}`;
      if (!zoneTypeCache.has(cacheKey)) zoneTypeCache.set(cacheKey, await resolveZoneType(iv.roomSlug, iv.zoneId));
      if (zoneTypeCache.get(cacheKey) === 'general') voluntaryMeetingMs += ms;
    }
  }
  const voluntaryComponent = totalMeetingMs > 0 ? voluntaryMeetingMs / totalMeetingMs : null;

  // 4. Overtime frequency, inverted — fraction of present days WITHOUT
  // overtime; null if there's no attendance to judge this by at all.
  const presentRecords = records.filter((r) => r.status !== 'absent' && r.status !== 'holiday');
  const daysWithOvertime = presentRecords.filter((r) => r.overtimeMinutes > 0).length;
  const overtimeComponent = presentRecords.length > 0 ? 1 - daysWithOvertime / presentRecords.length : null;

  const weighted: { key: string; value: number | null; weight: number }[] = [
    { key: 'emoteEngagement', value: emoteComponent, weight: policy?.analyticsVibeWeightEmote ?? 0.25 },
    { key: 'pokeResponse', value: pokeComponent, weight: policy?.analyticsVibeWeightPoke ?? 0.25 },
    { key: 'voluntaryCallJoin', value: voluntaryComponent, weight: policy?.analyticsVibeWeightVoluntaryCall ?? 0.25 },
    { key: 'overtimeInverted', value: overtimeComponent, weight: policy?.analyticsVibeWeightOvertimeInverted ?? 0.25 },
  ];
  const usable = weighted.filter((c): c is { key: string; value: number; weight: number } => c.value !== null && c.weight > 0);
  const totalWeight = usable.reduce((s, c) => s + c.weight, 0);
  const score = totalWeight > 0
    ? Math.round((usable.reduce((s, c) => s + c.value * c.weight, 0) / totalWeight) * 100) / 10
    : 0;

  return {
    score,
    connectionCount, emote, wave, chat, furniture,
    // Bagian B.4's "always show the breakdown" requirement — never a bare
    // score. null components are surfaced as-is (client renders "no data"),
    // not silently zeroed.
    breakdown: {
      emoteEngagement: emoteComponent,
      pokeResponse: pokeComponent,
      voluntaryCallJoin: voluntaryComponent,
      overtimeInverted: overtimeComponent,
    },
  };
}

async function computeTaskCompletion(userId: string, start: Date, end: Date) {
  const prisma = getPrisma();
  const agg = await prisma.taskCompletionSnapshot.aggregate({
    where: { userId, date: bucketedRange(start, end) },
    _sum: { dueCount: true, completedCount: true },
  });
  return { due: agg._sum.dueCount ?? 0, completed: agg._sum.completedCount ?? 0 };
}

// Bagian B.4's "habis lembur — dimaklumi" grace, applied to this window.
// Widens the query by one extra day BEFORE `start` — applyOvertimeGrace
// needs the immediately preceding record to check yesterday's overtime for
// the FIRST day in range (see its own doc comment in shared/analyticsRules.ts).
async function computeAttendance(userId: string, start: Date, end: Date, organizationId: string) {
  const prisma = getPrisma();
  const { gte: bucketedStart, lte: bucketedEnd } = bucketedRange(start, end);
  const [policy, records] = await Promise.all([
    prisma.workspacePolicy.findUnique({ where: { organizationId } }),
    prisma.attendanceRecord.findMany({
      where: { userId, date: { gte: DateTime.fromJSDate(bucketedStart).minus({ days: 3 }).toJSDate(), lte: bucketedEnd } },
      include: { shift: true },
      orderBy: { date: 'asc' },
    }),
  ]);
  const graceMin = policy?.analyticsOvertimeGraceMinMinutes ?? 60;

  const withStatus = records.map((r) => {
    const shift: ShiftDef | null = r.shift
      ? { startTime: r.shift.startTime, endTime: r.shift.endTime, timezone: r.shift.timezone, breakMinutes: r.shift.breakMinutes, graceMinutes: r.shift.graceMinutes, overtimeRule: r.shift.overtimeRule, workdays: r.shift.workdays }
      : null;
    const status = shift && r.clockIn && r.clockOut ? finalStatus(shift, r.clockIn, r.clockOut, r.status === 'auto_closed') : r.status;
    return { userId, date: r.date, status, overtimeMinutes: r.overtimeMinutes, clockOut: r.clockOut, workMinutes: r.workMinutes, clockIn: r.clockIn };
  });
  const annotated = applyOvertimeGrace(withStatus, graceMin);
  // Only the records actually inside [start,end) — the widened lookback
  // window above exists purely so THOSE records can see one day further
  // back, not to leak into the response.
  const inRange = annotated.filter((r) => r.date >= bucketedStart && r.date <= bucketedEnd);

  const totalWorkMinutes = inRange.reduce((sum, r) => sum + r.workMinutes, 0);
  const totalOvertimeMinutes = inRange.reduce((sum, r) => sum + r.overtimeMinutes, 0);
  return {
    totalWorkMinutes,
    totalOvertimeMinutes,
    days: inRange.map((r) => ({
      date: r.date.toISOString(),
      clockIn: r.clockIn?.toISOString() ?? null,
      clockOut: r.clockOut?.toISOString() ?? null,
      status: r.status,
      workMinutes: r.workMinutes,
      overtimeMinutes: r.overtimeMinutes,
      grace: r.grace,
    })),
  };
}

// Shared by Team/Company — bundles one member's per-tier compute calls.
// Reused as-is by Individual too would be redundant with its own inline
// Promise.all (kept separate there so the response shape stays exactly
// B.3.1's, not wrapped in this helper's grouping).
async function computeMemberSummary(userId: string, start: Date, end: Date, organizationId: string) {
  const [distribution, vibe, tasks, attendance] = await Promise.all([
    computeStatusDistribution(userId, start, end),
    computeVibe(userId, start, end, organizationId),
    computeTaskCompletion(userId, start, end),
    computeAttendance(userId, start, end, organizationId),
  ]);
  return { distribution, vibe, tasks, attendance };
}

// v2 Bagian B.2 #4 — Live Meeting List. "Right now" by construction: an
// open StatusInterval (endedAt null) with status 'in_meeting' IS someone
// currently in a meeting — no separate live-state tracking needed, this is
// exactly what the column already means.
async function computeLiveMeetings(userIds: string[], names: Map<string, string>) {
  if (!userIds.length) return [];
  const prisma = getPrisma();
  const open = await prisma.statusInterval.findMany({
    where: { userId: { in: userIds }, status: 'in_meeting', endedAt: null },
    select: { userId: true, roomSlug: true, startedAt: true },
  });
  if (!open.length) return [];
  const rooms = await prisma.room.findMany({ where: { slug: { in: [...new Set(open.map((o) => o.roomSlug))] } }, select: { slug: true, name: true } });
  const roomNames = new Map(rooms.map((r) => [r.slug, r.name]));
  const now = Date.now();
  return open.map((o) => ({
    userId: o.userId,
    name: names.get(o.userId) ?? o.userId,
    roomSlug: o.roomSlug,
    roomName: roomNames.get(o.roomSlug) ?? o.roomSlug,
    startedAt: o.startedAt.toISOString(),
    durationMinutes: Math.round((now - o.startedAt.getTime()) / 60000),
  }));
}

// Bagian B.3.1's "Sehat 35-50% dari jam kerja" — focus time as a percentage
// of jam hadir (attendance work minutes), the closest thing to "jam kerja"
// this app tracks. 0 if there's no attendance to divide by, not NaN/Infinity.
function focusPercent(focusMinutes: number, jamHadirMinutes: number): number {
  if (jamHadirMinutes <= 0) return 0;
  return Math.round((focusMinutes / jamHadirMinutes) * 1000) / 10;
}

// v2 Bagian B.5 #1 — DAU + Peak Concurrent Users. Both computed from the
// SAME StatusInterval fetch (one query, two derived metrics) rather than a
// periodic "sample the concurrent count" sweep — a sampling job would add a
// new table AND only catch peaks that happen to land on a sample tick,
// missing true peaks between samples. A sweep-line over real interval data
// is exact and needs no new writes at all.
async function computeDauAndPeakConcurrent(userIds: string[], start: Date, end: Date): Promise<{
  dau: { date: string; count: number }[];
  peakConcurrent: number;
  peakConcurrentAt: string | null;
}> {
  if (!userIds.length) return { dau: [], peakConcurrent: 0, peakConcurrentAt: null };
  const prisma = getPrisma();
  const intervals = await prisma.statusInterval.findMany({
    where: { userId: { in: userIds }, startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gt: start } }] },
    select: { userId: true, startedAt: true, endedAt: true },
  });
  const now = new Date();

  // DAU: per WIB calendar day in range, count distinct users with any
  // coverage that day. Day-bucketing an INTERVAL (not a point) isn't a
  // plain SQL GROUP BY, so this walks day-by-day client-side.
  const dau: { date: string; count: number }[] = [];
  let cursor = DateTime.fromJSDate(start).setZone('Asia/Jakarta').startOf('day');
  const last = DateTime.fromJSDate(end).setZone('Asia/Jakarta');
  while (cursor < last) {
    const dayStart = cursor.toJSDate();
    const dayEnd = cursor.endOf('day').toJSDate();
    const active = new Set<string>();
    for (const iv of intervals) {
      const ivEnd = iv.endedAt ?? now;
      if (iv.startedAt < dayEnd && ivEnd > dayStart) active.add(iv.userId);
    }
    dau.push({ date: cursor.toFormat('yyyy-LL-dd'), count: active.size });
    cursor = cursor.plus({ days: 1 });
  }

  // Peak concurrent — classic sweep-line: +1 at each start, -1 at each end,
  // sorted by time, track the running max.
  type SweepPoint = { at: number; delta: 1 | -1 };
  const points: SweepPoint[] = [];
  for (const iv of intervals) {
    const s = Math.max(iv.startedAt.getTime(), start.getTime());
    const e = Math.min((iv.endedAt ?? now).getTime(), end.getTime());
    if (e <= s) continue;
    points.push({ at: s, delta: 1 }, { at: e, delta: -1 });
  }
  // Ends sort before starts at the same instant, so a back-to-back
  // handoff (one session ending exactly as another begins) doesn't get
  // double-counted as +1 concurrency it never actually had.
  points.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let running = 0, peak = 0, peakAt: number | null = null;
  for (const p of points) {
    running += p.delta;
    if (running > peak) { peak = running; peakAt = p.at; }
  }

  return { dau, peakConcurrent: peak, peakConcurrentAt: peakAt ? new Date(peakAt).toISOString() : null };
}

// Bagian B.3.3's attendance heatmap (jam 0-23 x hari Sen-Min) — any StatusInterval
// coverage counts as "present" regardless of which status, walked hour-by-hour
// so a long interval splits correctly across grid cells instead of all
// landing in its start hour.
async function computeAttendanceHeatmap(userIds: string[], start: Date, end: Date) {
  const prisma = getPrisma();
  if (!userIds.length) return [];
  const intervals = await prisma.statusInterval.findMany({
    where: { userId: { in: userIds }, startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gt: start } }] },
    select: { startedAt: true, endedAt: true },
  });
  const now = new Date();
  // grid[weekday(0=Mon..6=Sun)][hour(0-23)] = total minutes present, WIB.
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const iv of intervals) {
    const clampedStart = iv.startedAt < start ? start : iv.startedAt;
    const rawEnd = iv.endedAt ?? now;
    const clampedEnd = rawEnd > end ? end : rawEnd;
    let cursor = DateTime.fromJSDate(clampedStart).setZone('Asia/Jakarta');
    const clipEnd = DateTime.fromJSDate(clampedEnd).setZone('Asia/Jakarta');
    while (cursor < clipEnd) {
      const hourEnd = cursor.plus({ hours: 1 }).startOf('hour');
      const segEnd = hourEnd < clipEnd ? hourEnd : clipEnd;
      const minutes = segEnd.diff(cursor, 'minutes').minutes;
      if (minutes > 0) grid[cursor.weekday - 1][cursor.hour] += minutes;
      cursor = segEnd;
    }
  }
  return grid.map((hours, wIdx) => ({ weekday: wIdx + 1, hours: hours.map((m) => Math.round(m)) }));
}

// Bagian B.3.3's "Tren delivery on-time (4 periode terakhir)" — replays the
// SAME period length 4 times, walking backward from the current window.
async function computeOnTimeTrend(userIds: string[], start: Date, end: Date) {
  const prisma = getPrisma();
  const spanMs = end.getTime() - start.getTime();
  const windows = Array.from({ length: 4 }, (_, i) => {
    const offset = spanMs * (3 - i);
    return { start: new Date(start.getTime() - offset), end: new Date(end.getTime() - offset) };
  });
  return Promise.all(windows.map(async (w) => {
    const agg = await prisma.taskCompletionSnapshot.aggregate({
      where: { userId: { in: userIds }, date: bucketedRange(w.start, w.end) },
      _sum: { dueCount: true, completedCount: true },
    });
    const due = agg._sum.dueCount ?? 0;
    const completed = agg._sum.completedCount ?? 0;
    return { start: w.start.toISOString(), end: w.end.toISOString(), due, completed, rate: due > 0 ? Math.round((completed / due) * 1000) / 10 : null };
  }));
}

// v2 Bagian B.5 #6 — Top Connectors network detail. Built from
// ConnectionEvent alone (the one genuinely pairwise signal this app
// tracks — chat is zone-broadcast, not pairwise; see the v2 plan's own
// note on why poke-pairs weren't added as a second signal, to keep this
// scoped). One row per unique pair, weight = event count in the period.
async function computeConnectionNetwork(
  users: { id: string; displayName: string; departmentId: string | null }[],
  departments: { id: string; name: string }[],
  start: Date,
  end: Date,
) {
  const prisma = getPrisma();
  const ids = users.map((u) => u.id);
  if (!ids.length) return { nodes: [], edges: [], isolationInsight: null };
  const idSet = new Set(ids);
  const events = await prisma.connectionEvent.findMany({
    where: { occurredAt: { gte: start, lt: end }, OR: [{ userAId: { in: ids } }, { userBId: { in: ids } }] },
    select: { userAId: true, userBId: true },
  });

  const userMap = new Map(users.map((u) => [u.id, u]));
  const edgeMap = new Map<string, { a: string; b: string; weight: number }>();
  for (const e of events) {
    if (!idSet.has(e.userAId) || !idSet.has(e.userBId)) continue; // both sides must be in this pool (team/company scope)
    const key = e.userAId < e.userBId ? `${e.userAId}:${e.userBId}` : `${e.userBId}:${e.userAId}`;
    const existing = edgeMap.get(key);
    if (existing) existing.weight += 1;
    else edgeMap.set(key, { a: e.userAId, b: e.userBId, weight: 1 });
  }
  const edges = [...edgeMap.values()].map((e) => {
    const deptA = userMap.get(e.a)?.departmentId;
    const deptB = userMap.get(e.b)?.departmentId;
    return { a: e.a, b: e.b, weight: e.weight, crossDept: !!deptA && !!deptB && deptA !== deptB };
  });
  const nodes = users.map((u) => ({ userId: u.id, name: u.displayName, departmentId: u.departmentId }));

  // "Departemen X paling terisolasi" — only meaningful with >=2 departments
  // (with one department, every edge is trivially same-dept — not a signal).
  let isolationInsight: string | null = null;
  const deptIdsPresent = new Set(users.map((u) => u.departmentId).filter((d): d is string => !!d));
  if (deptIdsPresent.size >= 2) {
    const byDept = new Map<string, { cross: number; total: number }>();
    for (const e of edges) {
      for (const deptId of [userMap.get(e.a)?.departmentId, userMap.get(e.b)?.departmentId]) {
        if (!deptId) continue;
        const cur = byDept.get(deptId) ?? { cross: 0, total: 0 };
        cur.total += e.weight;
        if (e.crossDept) cur.cross += e.weight;
        byDept.set(deptId, cur);
      }
    }
    let lowestRatio = Infinity;
    let mostIsolatedDeptId: string | null = null;
    for (const [deptId, stat] of byDept) {
      if (stat.total === 0) continue;
      const ratio = stat.cross / stat.total;
      if (ratio < lowestRatio) { lowestRatio = ratio; mostIsolatedDeptId = deptId; }
    }
    if (mostIsolatedDeptId) {
      const deptName = departments.find((d) => d.id === mostIsolatedDeptId)?.name ?? mostIsolatedDeptId;
      isolationInsight = `Departemen ${deptName} paling terisolasi dari tim lain — ${Math.round(lowestRatio * 100)}% interaksinya lintas-departemen.`;
    }
  }

  return { nodes, edges, isolationInsight };
}

// GET /api/analytics/individual — Bagian B.3.1. Self by default; `userId`
// param only if canViewAnalyticsOf passes (self / workspace admin / direct
// manager — same rule attendance already uses). Deliberately never returns
// any cross-user field — Bagian C.1's "never show comparisons at Individual
// tier" is enforced by this endpoint's shape, not just hidden in the UI.
router.get('/analytics/individual', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const targetUserId = typeof req.query.userId === 'string' && req.query.userId ? req.query.userId : req.userId!;

    if (targetUserId !== req.userId) {
      const [role, target] = await Promise.all([
        resolveWorkspaceRole(prisma, req.userId!),
        findUserInOrg(prisma, targetUserId, req.organizationId, { id: true, managerId: true }),
      ]);
      if (!target || !canViewAnalyticsOf({ id: req.userId!, workspaceRole: role ?? 'member' }, target)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      await writeAudit(prisma, {
        actorId: req.userId!, action: 'attendance:viewAll', targetType: 'attendance',
        targetUserId, meta: { via: 'analytics:individual' }, ip: clientIp(req),
      });
    }

    const { type, start, end } = parsePeriod(req.query);
    const [distribution, vibe, tasks, attendance] = await Promise.all([
      computeStatusDistribution(targetUserId, start, end),
      computeVibe(targetUserId, start, end, req.organizationId),
      computeTaskCompletion(targetUserId, start, end),
      computeAttendance(targetUserId, start, end, req.organizationId),
    ]);

    return res.json({
      period: { type, start: start.toISOString(), end: end.toISOString() },
      jamHadir: { totalMinutes: attendance.totalWorkMinutes, targetMinutes: targetWorkMinutes(start, end) },
      overtime: { totalMinutes: attendance.totalOvertimeMinutes },
      focusMinutes: distribution.focusMinutes,
      meetingMinutes: distribution.inMeetingMinutes,
      taskSelesai: tasks,
      connections: { count: vibe.connectionCount },
      vibe: { score: vibe.score, breakdown: vibe.breakdown },
      distribution,
      attendanceHistory: attendance.days,
    });
  } catch (err) {
    console.error('[analytics] individual error:', err);
    return res.status(500).json({ error: 'Gagal memuat analytics' });
  }
});

// GET /api/analytics/individual/timeline — v2 Bagian B.1 #2, the per-day
// Gantt view. Same self/canViewAnalyticsOf permission shape as
// /analytics/individual above (duplicated rather than extracted — this
// file's established convention, see /analytics/export's own copy of the
// same check). Returns RAW StatusInterval blocks for one WIB day (not
// summed totals) — same clip-to-window math as computeStatusDistribution,
// just returning the blocks themselves instead of aggregating them away.
router.get('/analytics/individual/timeline', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const targetUserId = typeof req.query.userId === 'string' && req.query.userId ? req.query.userId : req.userId!;

    if (targetUserId !== req.userId) {
      const [role, target] = await Promise.all([
        resolveWorkspaceRole(prisma, req.userId!),
        findUserInOrg(prisma, targetUserId, req.organizationId, { id: true, managerId: true }),
      ]);
      if (!target || !canViewAnalyticsOf({ id: req.userId!, workspaceRole: role ?? 'member' }, target)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const requestedDate = typeof req.query.date === 'string' ? DateTime.fromFormat(req.query.date, 'yyyy-LL-dd', { zone: 'Asia/Jakarta' }) : DateTime.invalid('missing');
    const day = (requestedDate.isValid ? requestedDate : DateTime.now().setZone('Asia/Jakarta')).startOf('day');
    const dayStart = day.toJSDate();
    const dayEnd = day.endOf('day').toJSDate();

    const intervals = await prisma.statusInterval.findMany({
      where: { userId: targetUserId, startedAt: { lt: dayEnd }, OR: [{ endedAt: null }, { endedAt: { gt: dayStart } }] },
      orderBy: { startedAt: 'asc' },
    });
    const now = new Date();
    const blocks = intervals
      .map((iv) => {
        const clipStart = iv.startedAt < dayStart ? dayStart : iv.startedAt;
        const rawEnd = iv.endedAt ?? now;
        const clipEnd = rawEnd > dayEnd ? dayEnd : rawEnd;
        return {
          status: iv.status,
          startMinuteOfDay: Math.round((clipStart.getTime() - dayStart.getTime()) / 60000),
          endMinuteOfDay: Math.round((clipEnd.getTime() - dayStart.getTime()) / 60000),
        };
      })
      .filter((b) => b.endMinuteOfDay > b.startMinuteOfDay);

    return res.json({ date: day.toFormat('yyyy-LL-dd'), blocks });
  } catch (err) {
    console.error('[analytics] timeline error:', err);
    return res.status(500).json({ error: 'Gagal memuat timeline' });
  }
});

// GET /api/analytics/team — Bagian B.3.2. Direct reports of the caller
// ONLY (`where: { managerId: req.userId }`, same shape as the existing
// GET /attendance/team) — a non-manager naturally gets an empty roster, no
// separate WorkspaceAction needed (see shared/workspacePermissions.ts's
// doc comment on 'analytics:viewAllCompany' for why 'analytics:viewTeam'
// deliberately doesn't exist).
router.get('/analytics/team', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const reports = await prisma.user.findMany({ where: { managerId: req.userId! }, select: { id: true, displayName: true } });
    const { type, start, end } = parsePeriod(req.query);
    if (!reports.length) {
      return res.json({ period: { type, start: start.toISOString(), end: end.toISOString() }, members: [], summary: null, liveMeetings: [] });
    }

    const onlineIds = getOnlineUserIds();
    const names = new Map(reports.map((r) => [r.id, r.displayName]));
    const liveMeetings = await computeLiveMeetings(reports.map((r) => r.id), names);
    const members = await Promise.all(reports.map(async (m) => {
      const s = await computeMemberSummary(m.id, start, end, req.organizationId!);
      return {
        userId: m.id,
        name: m.displayName,
        // "Online hari ini" (B.3.2) — a live snapshot at request time, not a
        // full day's history; reads as a real-time pulse independent of
        // whichever period is selected for the rest of the dashboard.
        isOnlineNow: onlineIds.has(m.id),
        jamHadirMinutes: s.attendance.totalWorkMinutes,
        overtimeMinutes: s.attendance.totalOvertimeMinutes,
        focusMinutes: s.distribution.focusMinutes,
        meetingMinutes: s.distribution.inMeetingMinutes,
        taskDue: s.tasks.due,
        taskCompleted: s.tasks.completed,
        vibeScore: s.vibe.score,
        focusPercent: focusPercent(s.distribution.focusMinutes, s.attendance.totalWorkMinutes),
      };
    }));

    await writeAudit(prisma, {
      actorId: req.userId!, action: 'attendance:viewAll', targetType: 'attendance',
      meta: { via: 'analytics:team', team: reports.map((r) => r.id) }, ip: clientIp(req),
    });

    const days = Math.max(1, DateTime.fromJSDate(end).diff(DateTime.fromJSDate(start), 'days').days);
    const totalDue = members.reduce((s, m) => s + m.taskDue, 0);
    const totalCompleted = members.reduce((s, m) => s + m.taskCompleted, 0);
    const summary = {
      anggotaAktifHariIni: members.filter((m) => m.isOnlineNow).length,
      totalAnggota: members.length,
      avgFocusPercent: Math.round((members.reduce((s, m) => s + m.focusPercent, 0) / members.length) * 10) / 10,
      taskOnTimeRate: totalDue > 0 ? Math.round((totalCompleted / totalDue) * 1000) / 10 : null,
      anggotaDenganLembur: members.filter((m) => m.overtimeMinutes > 0).length,
      // Meeting COUNT per day isn't tracked (only continuous in_meeting
      // duration is, via StatusInterval) — this is average meeting MINUTES
      // per member per day instead, the closest available proxy.
      avgMeetingMinutesPerDay: Math.round(members.reduce((s, m) => s + m.meetingMinutes, 0) / members.length / days),
      vibeTim: Math.round((members.reduce((s, m) => s + m.vibeScore, 0) / members.length) * 10) / 10,
    };

    return res.json({ period: { type, start: start.toISOString(), end: end.toISOString() }, members, summary, liveMeetings });
  } catch (err) {
    console.error('[analytics] team error:', err);
    return res.status(500).json({ error: 'Gagal memuat analytics tim' });
  }
});

// GET /api/analytics/company — Bagian B.3.3, admin/founder only.
router.get('/analytics/company', authenticateToken, requireWorkspace('analytics:viewAllCompany'), async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const { type, start, end } = parsePeriod(req.query);
    // Multi-tenant Fase 2 — `users` used to have no org filter at all
    // ("select every active employee"), the root pool for this entire
    // endpoint. Migration slice — `departments` and `policy` now also
    // org-scoped (previously Department had no organizationId at all, and
    // WorkspacePolicy was the single shared id='singleton' row).
    const [users, departments, policy] = await Promise.all([
      prisma.user.findMany({ where: { active: true, organizationId: req.organizationId }, select: { id: true, displayName: true, departmentId: true } }),
      prisma.department.findMany({ where: { organizationId: req.organizationId }, select: { id: true, name: true } }),
      prisma.workspacePolicy.findUnique({ where: { organizationId: req.organizationId } }),
    ]);

    const perUser = await Promise.all(users.map(async (u) => {
      const s = await computeMemberSummary(u.id, start, end, req.organizationId!);
      return {
        userId: u.id, departmentId: u.departmentId,
        jamHadirMinutes: s.attendance.totalWorkMinutes, focusMinutes: s.distribution.focusMinutes,
        meetingMinutes: s.distribution.inMeetingMinutes, overtimeMinutes: s.attendance.totalOvertimeMinutes,
        taskDue: s.tasks.due, taskCompleted: s.tasks.completed, vibeScore: s.vibe.score,
        connectionCount: s.vibe.connectionCount,
      };
    }));

    await writeAudit(prisma, {
      actorId: req.userId!, action: 'analytics:viewAllCompany', targetType: 'attendance',
      meta: { via: 'analytics:company', users: perUser.length }, ip: clientIp(req),
    });

    const onlineIds = getOnlineUserIds();
    const totalJamHadir = perUser.reduce((s, u) => s + u.jamHadirMinutes, 0);
    const totalProduktif = perUser.reduce((s, u) => s + u.focusMinutes + u.meetingMinutes, 0);
    const totalDue = perUser.reduce((s, u) => s + u.taskDue, 0);
    const totalCompleted = perUser.reduce((s, u) => s + u.taskCompleted, 0);
    const totalConnections = perUser.reduce((s, u) => s + u.connectionCount, 0);

    const utilizationByDept = departments.map((d) => {
      const deptUsers = perUser.filter((u) => u.departmentId === d.id);
      const jamHadir = deptUsers.reduce((s, u) => s + u.jamHadirMinutes, 0);
      const produktif = deptUsers.reduce((s, u) => s + u.focusMinutes + u.meetingMinutes, 0);
      return {
        departmentId: d.id, name: d.name, memberCount: deptUsers.length,
        utilizationPercent: jamHadir > 0 ? Math.round((produktif / jamHadir) * 1000) / 10 : null,
      };
    });

    // Bagian B.6's ROI — "Scheduling saved" counts spontaneous proximity
    // connections (ConnectionEvent) as the "meeting spontan" the brief means
    // (no scheduling required to have happened). ROI itself stays null
    // until BOTH cost inputs are configured (Bagian D flags these as PERLU
    // KONFIRMASI, no default exists in the brief) — never a fabricated number.
    const schedulingSavedMinutes = totalConnections * (policy?.analyticsSchedulingSavedMinutesPerMeeting ?? 5);
    const schedulingSavedHours = Math.round((schedulingSavedMinutes / 60) * 10) / 10;
    let roi: { timeSavedValueIdr: number; netValueIdr: number; roiPercent: number } | null = null;
    if (policy?.analyticsAvgHourlyRateIdr && policy?.analyticsPlatformMonthlyCostIdr) {
      const timeSavedValueIdr = Math.round(schedulingSavedHours * policy.analyticsAvgHourlyRateIdr);
      const netValueIdr = timeSavedValueIdr - policy.analyticsPlatformMonthlyCostIdr;
      const roiPercent = Math.round((netValueIdr / policy.analyticsPlatformMonthlyCostIdr) * 100);
      roi = { timeSavedValueIdr, netValueIdr, roiPercent };
    }

    const userIds = users.map((u) => u.id);
    const [heatmap, trend, dauAndPeak, network] = await Promise.all([
      computeAttendanceHeatmap(userIds, start, end),
      computeOnTimeTrend(userIds, start, end),
      computeDauAndPeakConcurrent(userIds, start, end),
      computeConnectionNetwork(users, departments, start, end),
    ]);

    return res.json({
      period: { type, start: start.toISOString(), end: end.toISOString() },
      timAktif: { online: onlineIds.size, total: users.length },
      utilization: { percent: totalJamHadir > 0 ? Math.round((totalProduktif / totalJamHadir) * 1000) / 10 : null },
      deliveryOnTime: { rate: totalDue > 0 ? Math.round((totalCompleted / totalDue) * 1000) / 10 : null, due: totalDue, completed: totalCompleted },
      avgFocusPercent: perUser.length
        ? Math.round((perUser.reduce((s, u) => s + focusPercent(u.focusMinutes, u.jamHadirMinutes), 0) / perUser.length) * 10) / 10
        : 0,
      schedulingSaved: { connections: totalConnections, hours: schedulingSavedHours },
      roi,
      utilizationByDept,
      heatmap,
      trend,
      dau: dauAndPeak.dau,
      peakConcurrent: { count: dauAndPeak.peakConcurrent, at: dauAndPeak.peakConcurrentAt },
      network,
    });
  } catch (err) {
    console.error('[analytics] company error:', err);
    return res.status(500).json({ error: 'Gagal memuat analytics perusahaan' });
  }
});

// ─── Bagian C — Ranking / Achievement ──────────────────────────────────

interface RankablePerson {
  userId: string; name: string;
  presentDays: number;
  jamHadirMinutes: number; overtimeMinutes: number;
  focusMinutes: number; meetingMinutes: number;
  taskDue: number; taskCompleted: number;
  connectionCount: number; connectionPartners: number;
}

async function computePresentDaysMap(userIds: string[], start: Date, end: Date): Promise<Map<string, number>> {
  const prisma = getPrisma();
  if (!userIds.length) return new Map();
  const rows = await prisma.attendanceRecord.groupBy({
    by: ['userId'],
    where: { userId: { in: userIds }, date: bucketedRange(start, end), status: { notIn: ['absent', 'holiday'] } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.userId, r._count._all]));
}

// Bagian C.3 #3/#7 — "Paling aktif connection" (frequency) vs "Top
// connector" (breadth) are genuinely different metrics even without a
// duration signal: #3 = how many connection EVENTS you were part of, #7 =
// how many DISTINCT people you connected with. Computed together in one
// pass over ConnectionEvent (cheaper than querying per user per category).
async function computeConnectionStatsMap(userIds: string[], start: Date, end: Date): Promise<Map<string, { count: number; partners: number }>> {
  const prisma = getPrisma();
  if (!userIds.length) return new Map();
  const idSet = new Set(userIds);
  const events = await prisma.connectionEvent.findMany({
    where: { occurredAt: { gte: start, lt: end }, OR: [{ userAId: { in: userIds } }, { userBId: { in: userIds } }] },
    select: { userAId: true, userBId: true },
  });
  const counts = new Map<string, number>();
  const partners = new Map<string, Set<string>>();
  for (const e of events) {
    for (const [self, other] of [[e.userAId, e.userBId], [e.userBId, e.userAId]] as const) {
      if (!idSet.has(self)) continue;
      counts.set(self, (counts.get(self) ?? 0) + 1);
      if (!partners.has(self)) partners.set(self, new Set());
      partners.get(self)!.add(other);
    }
  }
  const result = new Map<string, { count: number; partners: number }>();
  for (const id of userIds) result.set(id, { count: counts.get(id) ?? 0, partners: partners.get(id)?.size ?? 0 });
  return result;
}

async function buildRankablePool(userIds: string[], names: Map<string, string>, start: Date, end: Date, organizationId: string): Promise<RankablePerson[]> {
  const [presentDaysMap, connMap, summaries] = await Promise.all([
    computePresentDaysMap(userIds, start, end),
    computeConnectionStatsMap(userIds, start, end),
    Promise.all(userIds.map((id) => computeMemberSummary(id, start, end, organizationId))),
  ]);
  return userIds.map((id, i) => {
    const s = summaries[i];
    const conn = connMap.get(id) ?? { count: 0, partners: 0 };
    return {
      userId: id, name: names.get(id) ?? id,
      presentDays: presentDaysMap.get(id) ?? 0,
      jamHadirMinutes: s.attendance.totalWorkMinutes, overtimeMinutes: s.attendance.totalOvertimeMinutes,
      focusMinutes: s.distribution.focusMinutes, meetingMinutes: s.distribution.inMeetingMinutes,
      taskDue: s.tasks.due, taskCompleted: s.tasks.completed,
      connectionCount: conn.count, connectionPartners: conn.partners,
    };
  });
}

interface RankingCategoryResult {
  kategori: string; arah: 'tinggi_baik' | 'rendah_baik';
  top: { rank: number; user: string; userId: string; nilai: string }[];
  worst: { user: string; userId: string; nilai: string; konteks: string | null } | null;
  excluded: { user: string; userId: string; alasan: string }[];
}

// Bagian C.4.4 — simple, explainable heuristics, not ML. Checked in a fixed
// priority order; the first that fires wins (one context line, per spec).
function worstContext(person: RankablePerson, pool: RankablePerson[]): string | null {
  const avgMeeting = pool.reduce((s, p) => s + p.meetingMinutes, 0) / (pool.length || 1);
  if (avgMeeting > 0 && person.meetingMinutes > avgMeeting * 1.5) return 'beban meeting tinggi';
  if (person.overtimeMinutes > 0) return 'ada lembur di periode ini';
  if (person.presentDays < 5) return 'baru mulai tercatat / kehadiran terbatas periode ini';
  return null;
}

function fmtMinutesShort(m: number): string {
  const abs = Math.round(Math.abs(m));
  return `${Math.floor(abs / 60)}j ${abs % 60}m`;
}

// Bagian C.3/C.4 — one ranking category. `arah` decides which end of
// `metric` is TOP. `worst` is always drawn from the FULL eligible pool
// (ignores `opts.eligibleForTop`) — e.g. category 6's zero-output filter
// only disqualifies someone from being crowned "efisien", not from being
// flagged as "paling lama online".
function rankCategory(
  kategori: string,
  arah: 'tinggi_baik' | 'rendah_baik',
  pool: RankablePerson[],
  metric: (p: RankablePerson) => number,
  formatValue: (v: number) => string,
  opts: {
    eligibleForTop?: (p: RankablePerson) => boolean;
    tieBreak?: (a: RankablePerson, b: RankablePerson) => number;
    extraExclude?: { predicate: (p: RankablePerson) => boolean; reason: string };
  } = {},
): RankingCategoryResult {
  // C.4.1 — minimal data: fewer than 2 present days is excluded from every
  // category, not just some (a blanket data-sufficiency gate).
  const excluded = pool.filter((p) => p.presentDays < 2).map((p) => ({ user: p.name, userId: p.userId, alasan: 'cuti/baru masuk — data tidak cukup' }));
  let eligible = pool.filter((p) => p.presentDays >= 2);
  if (opts.extraExclude) {
    const { predicate, reason } = opts.extraExclude;
    excluded.push(...eligible.filter(predicate).map((p) => ({ user: p.name, userId: p.userId, alasan: reason })));
    eligible = eligible.filter((p) => !predicate(p));
  }

  const cmp = (a: RankablePerson, b: RankablePerson) => {
    const diff = arah === 'tinggi_baik' ? metric(b) - metric(a) : metric(a) - metric(b);
    if (diff !== 0) return diff;
    const tb = opts.tieBreak?.(a, b) ?? 0;
    if (tb !== 0) return tb;
    return a.name.localeCompare(b.name);
  };

  const topPool = opts.eligibleForTop ? eligible.filter(opts.eligibleForTop) : eligible;
  const top = [...topPool].sort(cmp).slice(0, 3).map((p, i) => ({ rank: i + 1, user: p.name, userId: p.userId, nilai: formatValue(metric(p)) }));

  const sortedAll = [...eligible].sort(cmp);
  const worstPerson = sortedAll.length > 1 ? sortedAll[sortedAll.length - 1] : undefined;
  const worst = worstPerson
    ? { user: worstPerson.name, userId: worstPerson.userId, nilai: formatValue(metric(worstPerson)), konteks: worstContext(worstPerson, eligible) }
    : null;

  return { kategori, arah, top, worst, excluded };
}

// Bagian C.3's 7 categories. Exported so analyticsSweep.ts's weekly Hall of
// Fame sweep can reuse the exact same math (company-wide) rather than
// duplicating it.
export async function computeRanking(userIds: string[], names: Map<string, string>, start: Date, end: Date, organizationId: string): Promise<RankingCategoryResult[]> {
  const pool = await buildRankablePool(userIds, names, start, end, organizationId);
  const perDay = (total: number, p: RankablePerson) => (p.presentDays > 0 ? total / p.presentDays : 0);

  return [
    rankCategory('Paling rajin', 'tinggi_baik', pool, (p) => perDay(p.jamHadirMinutes, p), (v) => `${fmtMinutesShort(v)}/hari`, { tieBreak: (a, b) => b.presentDays - a.presentDays }),
    rankCategory('Paling aktif meeting', 'tinggi_baik', pool, (p) => perDay(p.meetingMinutes, p), (v) => `${fmtMinutesShort(v)}/hari`),
    rankCategory('Paling aktif connection', 'tinggi_baik', pool, (p) => perDay(p.connectionCount, p), (v) => `${v.toFixed(1)}/hari`),
    rankCategory(
      'Paling produktif task', 'tinggi_baik', pool, (p) => (p.taskDue > 0 ? (p.taskCompleted / p.taskDue) * 100 : 0), (v) => `${Math.round(v * 10) / 10}%`,
      { tieBreak: (a, b) => b.taskCompleted - a.taskCompleted, extraExclude: { predicate: (p) => p.taskDue === 0, reason: 'tidak ada task tercatat di periode ini' } },
    ),
    rankCategory('Raja fokus', 'tinggi_baik', pool, (p) => focusPercent(p.focusMinutes, p.jamHadirMinutes), (v) => `${v}%`, { tieBreak: (a, b) => b.meetingMinutes - a.meetingMinutes }),
    rankCategory(
      'Paling efisien', 'rendah_baik', pool, (p) => p.jamHadirMinutes, fmtMinutesShort,
      { eligibleForTop: (p) => p.taskCompleted > 0, tieBreak: (a, b) => b.taskCompleted - a.taskCompleted, extraExclude: { predicate: (p) => p.jamHadirMinutes === 0, reason: 'tidak ada jam hadir tercatat di periode ini' } },
    ),
    rankCategory('Top connector', 'tinggi_baik', pool, (p) => p.connectionPartners, (v) => `${Math.round(v)} orang`, { tieBreak: (a, b) => b.connectionCount - a.connectionCount }),
  ];
}

// GET /api/analytics/ranking — Bagian C. scope=team → caller's own direct
// reports (same managerId scoping as /analytics/team); scope=company →
// admin/founder only. C.1's hard rule ("the worst" never shown at
// Individual tier) holds by construction — this endpoint has no
// self/individual scope at all, only team/company.
router.get('/analytics/ranking', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const scope: 'team' | 'company' = req.query.scope === 'company' ? 'company' : 'team';
    const { type, start, end } = parsePeriod(req.query);

    let pool: { id: string; displayName: string }[];
    if (scope === 'company') {
      // requireWorkspace is middleware, applied at route-registration time —
      // can't switch it per query param, so re-check manually here instead
      // of splitting into two routes (same reasoning as canViewAnalyticsOf's
      // manual check on the Individual endpoint above).
      const role = await resolveWorkspaceRole(prisma, req.userId!);
      if (role !== 'admin') return res.status(403).json({ error: 'Butuh peran admin workspace' });
      // Multi-tenant Fase 2 — used to have no org filter, ranking every
      // active user company-wide regardless of org.
      pool = await prisma.user.findMany({ where: { active: true, organizationId: req.organizationId }, select: { id: true, displayName: true } });
    } else {
      pool = await prisma.user.findMany({ where: { managerId: req.userId! }, select: { id: true, displayName: true } });
    }

    if (!pool.length) {
      return res.json({ period: { type, start: start.toISOString(), end: end.toISOString() }, scope, categories: [] });
    }

    const names = new Map(pool.map((p) => [p.id, p.displayName]));
    const categories = await computeRanking(pool.map((p) => p.id), names, start, end, req.organizationId);

    await writeAudit(prisma, {
      actorId: req.userId!, action: scope === 'company' ? 'analytics:viewAllCompany' : 'attendance:viewAll',
      targetType: 'attendance', meta: { via: 'analytics:ranking', scope, pool: pool.length }, ip: clientIp(req),
    });

    return res.json({ period: { type, start: start.toISOString(), end: end.toISOString() }, scope, categories });
  } catch (err) {
    console.error('[analytics] ranking error:', err);
    return res.status(500).json({ error: 'Gagal memuat ranking' });
  }
});

// GET /api/analytics/export — Bagian B.7. `tier` decides both the data
// scope AND the permission check, mirroring each tier's own endpoint
// exactly (individual: self/canViewAnalyticsOf; team: managerId scoping,
// no extra gate; company: requireWorkspace('analytics:export')) — this is
// deliberately ONE route with a tier param rather than three, since the
// workbook-building logic is what actually differs per tier, not the
// permission shape (which is copy-identical to the JSON endpoints above).
router.get('/analytics/export', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const tierRaw = String(req.query.tier ?? '');
    const tier: 'individual' | 'team' | 'company' = tierRaw === 'team' ? 'team' : tierRaw === 'company' ? 'company' : 'individual';
    const { type, start, end } = parsePeriod(req.query);

    let targetUserId: string | undefined;
    let poolUsers: { id: string; displayName: string }[] = [];
    if (tier === 'individual') {
      targetUserId = typeof req.query.userId === 'string' && req.query.userId ? req.query.userId : req.userId!;
      if (targetUserId !== req.userId) {
        const [role, target] = await Promise.all([
          resolveWorkspaceRole(prisma, req.userId!),
          findUserInOrg(prisma, targetUserId, req.organizationId, { id: true, managerId: true }),
        ]);
        if (!target || !canViewAnalyticsOf({ id: req.userId!, workspaceRole: role ?? 'member' }, target)) {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }
    } else if (tier === 'team') {
      poolUsers = await prisma.user.findMany({ where: { managerId: req.userId! }, select: { id: true, displayName: true } });
    } else {
      const role = await resolveWorkspaceRole(prisma, req.userId!);
      if (role !== 'admin') return res.status(403).json({ error: 'Butuh peran admin workspace' });
      // Multi-tenant Fase 2 — used to have no org filter, exporting every
      // active user company-wide regardless of org.
      poolUsers = await prisma.user.findMany({ where: { active: true, organizationId: req.organizationId }, select: { id: true, displayName: true } });
    }

    // Unconditional, before the file is even built — same "one exporter,
    // one audit trail" posture as the existing CSV export
    // (attendanceAdmin.ts's GET /admin/attendance/report).
    await writeAudit(prisma, {
      actorId: req.userId!, action: tier === 'company' ? 'analytics:export' : 'attendance:viewAll',
      targetType: 'attendance', targetUserId: tier === 'individual' ? (targetUserId ?? null) : null,
      meta: { via: 'analytics:export', tier, period: type }, ip: clientIp(req),
    });

    const workbook = new ExcelJS.Workbook();
    const zone = 'Asia/Jakarta';
    const periodLabel = `${DateTime.fromJSDate(start).setZone(zone).setLocale('id').toFormat('d LLL yyyy')} – ${DateTime.fromJSDate(end).setZone(zone).setLocale('id').toFormat('d LLL yyyy')}`;
    const tierLabel = tier === 'individual' ? 'Individu' : tier === 'team' ? 'Team' : 'All Kaitech';
    const addHeader = (sheet: ExcelJS.Worksheet) => {
      sheet.addRow([`KaiSpace Productivity Analytics — ${tierLabel}`]);
      sheet.addRow([`Periode: ${periodLabel}`]);
      sheet.addRow([]);
    };

    if (tier === 'individual') {
      const [s, target] = await Promise.all([
        computeMemberSummary(targetUserId!, start, end, req.organizationId),
        prisma.user.findUnique({ where: { id: targetUserId! }, select: { displayName: true } }),
      ]);

      const ringkasan = workbook.addWorksheet('Ringkasan');
      addHeader(ringkasan);
      ringkasan.addRow(['Nama', target?.displayName ?? targetUserId]);
      ringkasan.addRow(['Jam hadir', fmtMinutesShort(s.attendance.totalWorkMinutes)]);
      ringkasan.addRow(['Lembur', fmtMinutesShort(s.attendance.totalOvertimeMinutes)]);
      ringkasan.addRow(['Focus time', fmtMinutesShort(s.distribution.focusMinutes)]);
      ringkasan.addRow(['Waktu meeting', fmtMinutesShort(s.distribution.inMeetingMinutes)]);
      ringkasan.addRow(['Task selesai', `${s.tasks.completed}/${s.tasks.due}`]);
      ringkasan.addRow(['Connections', s.vibe.connectionCount]);
      ringkasan.addRow(['Vibe', s.vibe.score.toFixed(1)]);
      ringkasan.getColumn(1).width = 20;
      ringkasan.getColumn(2).width = 26;

      const detail = workbook.addWorksheet('Detail');
      addHeader(detail);
      detail.addRow(['Tanggal', 'Masuk', 'Keluar', 'Status', 'Menit kerja', 'Lembur (menit)', 'Catatan']);
      for (const d of s.attendance.days) {
        detail.addRow([
          DateTime.fromISO(d.date).setZone(zone).toFormat('yyyy-LL-dd'),
          d.clockIn ? DateTime.fromISO(d.clockIn).setZone(zone).toFormat('HH:mm') : '',
          d.clockOut ? DateTime.fromISO(d.clockOut).setZone(zone).toFormat('HH:mm') : '',
          d.status, d.workMinutes, d.overtimeMinutes,
          d.grace ? 'Habis lembur — dimaklumi' : '',
        ]);
      }
      detail.columns.forEach((c) => { c.width = 16; });

      const rankingSheet = workbook.addWorksheet('Ranking');
      addHeader(rankingSheet);
      rankingSheet.addRow(['Ranking tidak tersedia di tingkat Individu — lihat Bagian C.1 (tidak pernah dibandingkan dengan rekan di sini).']);
    } else {
      const names = new Map(poolUsers.map((u) => [u.id, u.displayName]));
      const summaries = await Promise.all(poolUsers.map(async (u) => ({ user: u, s: await computeMemberSummary(u.id, start, end, req.organizationId!) })));

      const ringkasan = workbook.addWorksheet('Ringkasan');
      addHeader(ringkasan);
      const totalJamHadir = summaries.reduce((sum, x) => sum + x.s.attendance.totalWorkMinutes, 0);
      const totalFocus = summaries.reduce((sum, x) => sum + x.s.distribution.focusMinutes, 0);
      const totalMeeting = summaries.reduce((sum, x) => sum + x.s.distribution.inMeetingMinutes, 0);
      const totalDue = summaries.reduce((sum, x) => sum + x.s.tasks.due, 0);
      const totalCompleted = summaries.reduce((sum, x) => sum + x.s.tasks.completed, 0);
      ringkasan.addRow(['Jumlah anggota', summaries.length]);
      ringkasan.addRow(['Total jam hadir', fmtMinutesShort(totalJamHadir)]);
      ringkasan.addRow(['Total focus time', fmtMinutesShort(totalFocus)]);
      ringkasan.addRow(['Total waktu meeting', fmtMinutesShort(totalMeeting)]);
      ringkasan.addRow(['Task on-time rate', totalDue > 0 ? `${Math.round((totalCompleted / totalDue) * 1000) / 10}%` : '—']);
      ringkasan.getColumn(1).width = 24;
      ringkasan.getColumn(2).width = 20;

      const detail = workbook.addWorksheet('Detail per anggota');
      addHeader(detail);
      detail.addRow(['Nama', 'Jam hadir', 'Lembur', 'Focus', 'Meeting', 'Task selesai', 'Vibe']);
      for (const { user, s } of summaries) {
        detail.addRow([
          user.displayName, fmtMinutesShort(s.attendance.totalWorkMinutes), fmtMinutesShort(s.attendance.totalOvertimeMinutes),
          fmtMinutesShort(s.distribution.focusMinutes), fmtMinutesShort(s.distribution.inMeetingMinutes),
          `${s.tasks.completed}/${s.tasks.due}`, s.vibe.score.toFixed(1),
        ]);
      }
      detail.columns.forEach((c) => { c.width = 16; });

      const rankingSheet = workbook.addWorksheet('Ranking');
      addHeader(rankingSheet);
      const categories = await computeRanking(poolUsers.map((u) => u.id), names, start, end, req.organizationId!);
      for (const cat of categories) {
        rankingSheet.addRow([cat.kategori]);
        rankingSheet.addRow(['Top', ...cat.top.map((t) => `${t.rank}. ${t.user} (${t.nilai})`)]);
        if (cat.worst) rankingSheet.addRow(['Terendah', `${cat.worst.user} (${cat.worst.nilai})`, cat.worst.konteks ?? '']);
        if (cat.excluded.length) rankingSheet.addRow(['Dikecualikan', cat.excluded.map((e) => e.user).join(', ')]);
        rankingSheet.addRow([]);
      }
      rankingSheet.columns.forEach((c) => { c.width = 22; });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `analytics-${tier}-${DateTime.now().setZone(zone).toFormat('yyyyLLdd')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[analytics] export error:', err);
    return res.status(500).json({ error: 'Gagal membuat file Excel' });
  }
});

export default router;
