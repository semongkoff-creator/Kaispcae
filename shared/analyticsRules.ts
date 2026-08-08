// Productivity Analytics — Bagian B.4's "habis lembur, dimaklumi" grace
// rule. Kept separate from attendanceRules.ts: this ANNOTATES attendance
// data for the new analytics endpoints, it never changes what
// attendanceRules.ts itself computes or what AttendanceReport.tsx shows —
// existing attendance behaviour stays untouched.

export interface OvertimeGraceInput {
  userId: string;
  // workDayOf-bucketed (00:00 UTC of the WIB calendar date), same
  // convention AttendanceRecord.date already uses.
  date: Date;
  status: string; // AttendanceStatus, kept as `string` here to avoid a hard dependency on attendanceRules' type
  overtimeMinutes: number;
  clockOut: Date | null;
}

export interface OvertimeGrace {
  reason: 'habis_lembur';
  previousDayClockOut: Date | null;
  previousDayOvertimeMinutes: number;
}

// Reads AttendanceRecord.overtimeMinutes directly — already shift-relative
// (see attendanceRules.ts's computeTotals), which is more correct than a
// fixed wall-clock threshold for shifts that don't start in the morning.
// Annotates rather than mutates `status`: the raw truth stays in the DB:
// callers decide how to RENDER a grace (e.g. "Habis lembur — dimaklumi"
// instead of a red "Terlambat" badge).
//
// `records` must include, for each user, the record immediately BEFORE the
// requested period's start (not just records inside the period) — otherwise
// the first day in range can never look back far enough to find yesterday's
// overtime. The caller widens its own date-range query by one extra day for
// this reason (see routes/analytics.ts).
export function applyOvertimeGrace<T extends OvertimeGraceInput>(
  records: T[],
  graceMinMinutes: number,
): (T & { grace: OvertimeGrace | null })[] {
  const byUser = new Map<string, T[]>();
  for (const r of records) {
    const list = byUser.get(r.userId) ?? [];
    list.push(r);
    byUser.set(r.userId, list);
  }
  for (const list of byUser.values()) list.sort((a, b) => a.date.getTime() - b.date.getTime());

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  // A long-weekend gap (Fri → Mon) is still "the next work day" per the
  // brief ("berlaku 1 hari kerja berikutnya") — 3 days covers that without
  // reaching back across a real absence (leave, illness) and crediting a
  // grace that's gone stale.
  const MAX_GAP_MS = 3 * ONE_DAY_MS;

  return records.map((r) => {
    if (r.status !== 'late') return { ...r, grace: null };
    const list = byUser.get(r.userId)!;
    const idx = list.indexOf(r);
    const prev = idx > 0 ? list[idx - 1] : undefined;
    if (prev && r.date.getTime() - prev.date.getTime() <= MAX_GAP_MS && prev.overtimeMinutes >= graceMinMinutes) {
      return {
        ...r,
        grace: { reason: 'habis_lembur', previousDayClockOut: prev.clockOut, previousDayOvertimeMinutes: prev.overtimeMinutes },
      };
    }
    return { ...r, grace: null };
  });
}
