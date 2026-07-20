// Deep ESM import on purpose. rrule's package `main` is a CJS/UMD bundle, and
// every workspace here is "type": "module" — Node's CJS named-export lexer
// can't read that bundle, so `import { RRule } from 'rrule'` compiles fine and
// then throws "does not provide an export named 'RRule'" at RUNTIME on the
// server. The dist/esm build is real ESM and works for both Node and Vite.
import { RRule, RRuleSet, rrulestr } from 'rrule/dist/esm/index.js';
import { DateTime } from 'luxon';

// Recurrence expansion, shared verbatim by client and server so a series never
// renders one way and saves another.
//
// The whole problem in one sentence: an RRULE is written in LOCAL time
// ("every Monday 09:00 Asia/Jakarta") but instants are stored in UTC, and the
// UTC offset MOVES across a DST boundary. Expanding in UTC gives you a meeting
// that drifts to 08:00 after New York springs forward.
//
// So expansion is done in the event's OWN zone:
//   1. take the master's start as a wall-clock time in `timezone`
//   2. let rrule walk the calendar in that wall-clock frame (UTC-tagged, i.e.
//      rrule's "floating" convention)
//   3. re-attach the zone to each result and convert back to a real UTC instant
// Step 3 is what keeps 09:00 at 09:00 on both sides of a DST change.

export type EditScope = 'this' | 'thisAndFollowing' | 'all';

export interface RecurringMaster {
  start: Date;          // UTC instant of the first occurrence
  end: Date;            // UTC instant of the first occurrence's end
  timezone: string;     // IANA zone the event was authored in
  rrule: string | null; // RFC 5545 RRULE (no DTSTART needed; we supply it)
  exdates?: Date[];     // occurrences removed from the series (UTC instants)
}

export interface Occurrence {
  start: Date;
  end: Date;
  // The occurrence's ORIGINAL start, i.e. its identity within the series.
  // Overrides and exdates are keyed by this, never by array index.
  recurrenceId: Date;
}

// Wall-clock fields of `instant` as seen in `zone`, tagged as if they were UTC.
// This is the frame rrule computes in ("floating" time).
function toFloating(instant: Date, zone: string): Date {
  const dt = DateTime.fromJSDate(instant, { zone });
  return new Date(Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second, dt.millisecond));
}

// Inverse of toFloating: read the UTC-tagged wall clock back as a real instant
// in `zone`. Luxon resolves DST here — a time that doesn't exist (spring
// forward) or happens twice (fall back) is normalised rather than silently
// producing an invalid Date.
function fromFloating(floating: Date, zone: string): Date {
  const dt = DateTime.fromObject(
    {
      year: floating.getUTCFullYear(), month: floating.getUTCMonth() + 1, day: floating.getUTCDate(),
      hour: floating.getUTCHours(), minute: floating.getUTCMinutes(), second: floating.getUTCSeconds(),
      // Milliseconds must round-trip: an occurrence's start IS its identity
      // (recurrenceId keys overrides and exdates). Dropping ms here made a
      // first occurrence come back a few ms off its own master's start.
      millisecond: floating.getUTCMilliseconds(),
    },
    { zone },
  );
  return dt.toJSDate();
}

// Expand a series into the occurrences overlapping [from, to].
export function expandOccurrences(master: RecurringMaster, from: Date, to: Date): Occurrence[] {
  const durationMs = master.end.getTime() - master.start.getTime();

  if (!master.rrule) {
    // One-off event: still filtered by the window so callers can treat both
    // shapes identically.
    if (master.end <= from || master.start >= to) return [];
    return [{ start: master.start, end: master.end, recurrenceId: master.start }];
  }

  const zone = master.timezone || 'UTC';
  const dtstart = toFloating(master.start, zone);

  const set = new RRuleSet();
  const opts = RRule.parseString(master.rrule);
  opts.dtstart = dtstart;
  set.rrule(new RRule(opts));
  for (const ex of master.exdates ?? []) set.exdate(toFloating(ex, zone));

  // Widen the query window by a day on each side before converting to the
  // floating frame: an occurrence can sit inside [from,to] in UTC while its
  // wall-clock date lands outside, and vice versa.
  const pad = 24 * 60 * 60 * 1000;
  const floatFrom = toFloating(new Date(from.getTime() - pad), zone);
  const floatTo = toFloating(new Date(to.getTime() + pad), zone);

  return set
    .between(floatFrom, floatTo, true)
    .map((f) => {
      const start = fromFloating(f, zone);
      return { start, end: new Date(start.getTime() + durationMs), recurrenceId: start };
    })
    .filter((o) => o.end > from && o.start < to);
}

// Cut a series short so it stops BEFORE `before` — the "this and following"
// edit: the old master keeps the past, a new master owns the future.
export function truncateRuleBefore(rule: string, before: Date, zone: string): string {
  const opts = RRule.parseString(rule);
  // UNTIL is exclusive of the split point: one millisecond earlier.
  const floating = toFloating(new Date(before.getTime() - 1), zone);
  opts.until = floating;
  // COUNT and UNTIL are mutually exclusive in RFC 5545; UNTIL wins here
  // because we're splitting at a date, and leaving both would make the rule
  // invalid (rrule throws).
  delete opts.count;
  return new RRule(opts).toString().replace(/^DTSTART[^\n]*\n/, '');
}

// Validate + normalise a rule string coming from a client. Returns null when
// unparseable, so callers can 400 instead of storing something that explodes
// on every later read.
export function normaliseRule(rule: string): string | null {
  try {
    const parsed = rrulestr(rule.startsWith('RRULE:') ? rule : `RRULE:${rule}`);
    const text = parsed.toString().replace(/^DTSTART[^\n]*\n/, '').replace(/^RRULE:/, '');
    return text || null;
  } catch {
    return null;
  }
}

// Human summary in Indonesian for the UI ("Setiap minggu pada Senin").
const FREQ_LABEL: Record<number, string> = {
  [RRule.DAILY]: 'hari',
  [RRule.WEEKLY]: 'minggu',
  [RRule.MONTHLY]: 'bulan',
  [RRule.YEARLY]: 'tahun',
};
const DAY_LABEL = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];

export function describeRule(rule: string | null): string {
  if (!rule) return 'Tidak berulang';
  try {
    const opts = RRule.parseString(rule);
    const every = opts.interval && opts.interval > 1 ? `Setiap ${opts.interval} ` : 'Setiap ';
    let s = every + (FREQ_LABEL[opts.freq as number] ?? 'periode');
    if (opts.byweekday) {
      const days = (Array.isArray(opts.byweekday) ? opts.byweekday : [opts.byweekday])
        .map((d) => DAY_LABEL[typeof d === 'number' ? d : (d as { weekday: number }).weekday] ?? '')
        .filter(Boolean);
      if (days.length) s += ` pada ${days.join(', ')}`;
    }
    if (opts.count) s += `, ${opts.count} kali`;
    if (opts.until) s += `, sampai ${DateTime.fromJSDate(opts.until).setLocale('id').toFormat('d LLL yyyy')}`;
    return s;
  } catch {
    return 'Perulangan tidak valid';
  }
}
