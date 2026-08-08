import { DateTime } from 'luxon';

// Bagian B.2 — shared by every analytics tier + ranking. `period` mirrors
// the server's PeriodType (routes/analytics.ts's parsePeriod); `from`/`to`
// (YYYY-MM-DD) only matter when period === 'custom'.
export type PeriodValue = { period: 'daily' | 'weekly' | 'monthly' | 'custom'; from: string; to: string };

const OPTIONS: { key: PeriodValue['period']; label: string }[] = [
  { key: 'daily', label: 'Harian' },
  { key: 'weekly', label: 'Mingguan' },
  { key: 'monthly', label: 'Bulanan' },
  { key: 'custom', label: 'Kustom' },
];

export function defaultPeriodValue(): PeriodValue {
  const now = DateTime.now().setZone('Asia/Jakarta');
  return { period: 'weekly', from: now.startOf('week').toISODate()!, to: now.endOf('week').toISODate()! };
}

// The active range's own display label (e.g. "3–9 Ags 2026") — computed
// from `value` directly rather than trusting the server round-trip, so it
// updates the instant the user picks a period, before the fetch resolves.
export function periodRangeLabel(value: PeriodValue): string {
  const now = DateTime.now().setZone('Asia/Jakarta').setLocale('id');
  let start: DateTime; let end: DateTime;
  if (value.period === 'daily') { start = now.startOf('day'); end = now.endOf('day'); }
  else if (value.period === 'monthly') { start = now.startOf('month'); end = now.endOf('month'); }
  else if (value.period === 'custom') {
    start = DateTime.fromISO(value.from, { zone: 'Asia/Jakarta' }).setLocale('id');
    end = DateTime.fromISO(value.to, { zone: 'Asia/Jakarta' }).setLocale('id');
    if (!start.isValid || !end.isValid) return '—';
  } else { start = now.startOf('week'); end = now.endOf('week'); }

  if (start.hasSame(end, 'day')) return start.toFormat('d LLL yyyy');
  if (start.hasSame(end, 'month')) return `${start.toFormat('d')}–${end.toFormat('d LLL yyyy')}`;
  return `${start.toFormat('d LLL')} – ${end.toFormat('d LLL yyyy')}`;
}

const field = 'bg-gray-50 dark:bg-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-800 dark:text-gray-100 outline-none cursor-pointer';

export function PeriodPicker({ value, onChange }: { value: PeriodValue; onChange: (v: PeriodValue) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
        {OPTIONS.map((o) => (
          <button
            key={o.key}
            onClick={() => onChange({ ...value, period: o.key })}
            className={`px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer transition-colors ${
              value.period === o.key
                ? 'bg-white dark:bg-gray-700 text-purple-700 dark:text-purple-300 shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {value.period === 'custom' && (
        <>
          <input type="date" value={value.from} max={value.to} onChange={(e) => onChange({ ...value, from: e.target.value })} aria-label="Dari tanggal" className={field} />
          <input type="date" value={value.to} min={value.from} onChange={(e) => onChange({ ...value, to: e.target.value })} aria-label="Sampai tanggal" className={field} />
        </>
      )}
      <span className="text-xs text-gray-400">{periodRangeLabel(value)}</span>
    </div>
  );
}
