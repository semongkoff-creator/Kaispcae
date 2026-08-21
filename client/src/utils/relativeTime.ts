// specs/2026-08-21-first-seen-offline-members-design.md — a "first seen"
// timestamp can realistically be months or years old, unlike
// ActivityFeed.tsx's own local formatRelativeTime (seconds/minutes/hours
// only, English, not shared/exported) — this is a separate, broader
// helper rather than extending that one, since the two callers' actual
// time ranges don't overlap in any way sharing would help with. Uses the
// browser's native Intl.RelativeTimeFormat — no new dependency, and it's
// already locale-aware (Indonesian "X yang lalu" phrasing) for free.
const rtf = new Intl.RelativeTimeFormat('id', { numeric: 'auto' });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60],
  ['month', 30 * 24 * 60 * 60],
  ['week', 7 * 24 * 60 * 60],
  ['day', 24 * 60 * 60],
  ['hour', 60 * 60],
  ['minute', 60],
];

export function formatRelativeTimeId(timestamp: number): string {
  const diffSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  if (absSeconds < 60) return 'baru saja';
  for (const [unit, secondsInUnit] of UNITS) {
    if (absSeconds >= secondsInUnit) {
      const value = Math.round(diffSeconds / secondsInUnit);
      return rtf.format(value, unit);
    }
  }
  return 'baru saja';
}
