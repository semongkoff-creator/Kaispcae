export interface TimelineBlock {
  status: string;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
}

// v2 Bagian B.1 #2 — per-day Gantt. Hand-rolled (colored <div> segments
// positioned by % of a 1440-minute day), same "no chart library needed"
// approach already used for CompanyAnalyticsPanel's attendance heatmap —
// a horizontal bar with a handful of colored blocks doesn't need recharts
// or a dedicated Gantt library.
const STATUS_COLOR: Record<string, string> = {
  available: '#c4b5fd',
  focus: '#7c3aed',
  in_meeting: '#2563eb',
  busy: '#d97706',
  away: '#6b7280',
};
const STATUS_LABEL: Record<string, string> = {
  available: 'Available',
  focus: 'Focus',
  in_meeting: 'In Meeting',
  busy: 'Busy',
  away: 'Away',
};
const HOUR_MARKS = [0, 6, 12, 18, 24];

export function TimelineChart({ blocks }: { blocks: TimelineBlock[] }) {
  return (
    <div>
      <div className="relative h-8 rounded-lg bg-gray-100 dark:bg-gray-800 overflow-hidden">
        {blocks.map((b, i) => (
          <div
            key={i}
            title={`${STATUS_LABEL[b.status] ?? b.status}: ${formatHm(b.startMinuteOfDay)}–${formatHm(b.endMinuteOfDay)}`}
            className="absolute top-0 h-full"
            style={{
              left: `${(b.startMinuteOfDay / 1440) * 100}%`,
              width: `${((b.endMinuteOfDay - b.startMinuteOfDay) / 1440) * 100}%`,
              background: STATUS_COLOR[b.status] ?? '#9ca3af',
            }}
          />
        ))}
      </div>
      <div className="relative h-4 text-[9px] text-gray-400 mt-0.5">
        {HOUR_MARKS.map((h) => (
          <span key={h} className="absolute -translate-x-1/2" style={{ left: `${(h / 24) * 100}%` }}>{h}:00</span>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        {Object.entries(STATUS_LABEL).map(([status, label]) => (
          <span key={status} className="inline-flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400">
            <span className="w-2 h-2 rounded-sm" style={{ background: STATUS_COLOR[status] }} />
            {label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1 text-[10px] text-gray-400">
          <span className="w-2 h-2 rounded-sm bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700" />
          Offline (celah)
        </span>
      </div>
    </div>
  );
}

function formatHm(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}
