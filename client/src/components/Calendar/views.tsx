import { DateTime, Interval } from 'luxon';
import { CalendarEventDto, CalendarSummary } from './api';

// The four calendar views. All of them take instants (UTC ISO strings) and
// render them in `zone` — the viewer's own timezone. Nothing here ever does
// date maths on a raw Date; luxon does it in the target zone so a week that
// crosses a DST boundary still has the right number of hours.

export interface ViewProps {
  events: CalendarEventDto[];
  calendars: CalendarSummary[];
  zone: string;
  cursor: DateTime;              // the day/week/month being shown
  onOpen: (e: CalendarEventDto) => void;
  onCreateAt?: (start: DateTime) => void;
}

const HOUR_PX = 44;
const DAY_START = 0;
const DAY_END = 24;

export const timeFmt = (zone: string) => (iso: string) => DateTime.fromISO(iso, { zone }).setLocale('id').toFormat('HH.mm');

function colorOf(e: CalendarEventDto, calendars: CalendarSummary[]): string {
  return calendars.find((c) => c.id === e.calendarId)?.color ?? '#a855f7';
}

// Lay overlapping events side by side instead of stacking them on top of each
// other — otherwise a double-booked hour looks like a single meeting.
function layout(dayEvents: CalendarEventDto[], zone: string) {
  const sorted = [...dayEvents].sort((a, b) => a.start.localeCompare(b.start));
  const columns: CalendarEventDto[][] = [];
  for (const e of sorted) {
    const s = DateTime.fromISO(e.start, { zone });
    const en = DateTime.fromISO(e.end, { zone });
    let placed = false;
    for (const col of columns) {
      const last = col[col.length - 1];
      if (DateTime.fromISO(last.end, { zone }) <= s) { col.push(e); placed = true; break; }
    }
    if (!placed) columns.push([e]);
    void en;
  }
  const pos = new Map<string, { col: number; total: number }>();
  columns.forEach((col, i) => col.forEach((e) => pos.set(e.id + e.recurrenceId, { col: i, total: columns.length })));
  return pos;
}

function EventBlock({ e, zone, calendars, onOpen, pos }: {
  e: CalendarEventDto; zone: string; calendars: CalendarSummary[]; onOpen: (e: CalendarEventDto) => void;
  pos?: { col: number; total: number };
}) {
  const s = DateTime.fromISO(e.start, { zone });
  const en = DateTime.fromISO(e.end, { zone });
  const top = (s.hour + s.minute / 60 - DAY_START) * HOUR_PX;
  const height = Math.max(18, (en.diff(s, 'minutes').minutes / 60) * HOUR_PX);
  const width = pos ? 100 / pos.total : 100;
  const left = pos ? pos.col * width : 0;
  const color = colorOf(e, calendars);
  return (
    <button
      onClick={() => onOpen(e)}
      style={{ top, height, width: `calc(${width}% - 4px)`, left: `${left}%`, borderLeftColor: color, backgroundColor: `${color}1a` }}
      className="absolute rounded-md border-l-2 px-1.5 py-0.5 text-left overflow-hidden cursor-pointer hover:brightness-95 focus:outline-none focus:ring-1 focus:ring-purple-500"
      title={`${e.title} · ${timeFmt(zone)(e.start)}`}
    >
      <span className={`block text-[10px] font-medium truncate ${e.busyOnly ? 'text-gray-500 italic' : 'text-gray-800 dark:text-gray-100'}`}>{e.title}</span>
      <span className="block text-[9px] text-gray-500 truncate">{timeFmt(zone)(e.start)}</span>
    </button>
  );
}

function HourGrid({ days, events, zone, calendars, onOpen, onCreateAt }: ViewProps & { days: DateTime[] }) {
  const hours = Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i);
  const now = DateTime.now().setZone(zone);
  return (
    <div className="flex-1 overflow-auto">
      <div className="flex min-w-[600px]">
        {/* hour gutter */}
        <div className="w-12 shrink-0 sticky left-0 bg-white dark:bg-gray-900 z-10">
          <div className="h-7" />
          {hours.map((h) => (
            <div key={h} style={{ height: HOUR_PX }} className="relative">
              <span className="absolute -top-1.5 right-1 text-[9px] text-gray-400">{String(h).padStart(2, '0')}.00</span>
            </div>
          ))}
        </div>
        {days.map((day) => {
          const dayEvents = events.filter((e) => {
            const s = DateTime.fromISO(e.start, { zone });
            return s.hasSame(day, 'day');
          });
          const pos = layout(dayEvents, zone);
          const isToday = day.hasSame(now, 'day');
          return (
            <div key={day.toISODate()} className="flex-1 min-w-[90px] border-l border-gray-100 dark:border-gray-700">
              <div className={`h-7 flex items-center justify-center text-[10px] font-medium sticky top-0 bg-white dark:bg-gray-900 z-10 ${isToday ? 'text-purple-600' : 'text-gray-500'}`}>
                {day.setLocale('id').toFormat('ccc d')}
              </div>
              <div className="relative">
                {hours.map((h) => (
                  <div
                    key={h}
                    style={{ height: HOUR_PX }}
                    onClick={() => onCreateAt?.(day.set({ hour: h, minute: 0 }))}
                    className="border-t border-gray-50 dark:border-gray-800 hover:bg-purple-50/40 dark:hover:bg-purple-900/10 cursor-pointer"
                  />
                ))}
                {/* current-time line */}
                {isToday && (
                  <div
                    style={{ top: (now.hour + now.minute / 60 - DAY_START) * HOUR_PX }}
                    className="absolute left-0 right-0 h-px bg-red-500 z-20 pointer-events-none"
                  >
                    <span className="absolute -left-1 -top-1 w-2 h-2 rounded-full bg-red-500" />
                  </div>
                )}
                {dayEvents.map((e) => (
                  <EventBlock key={e.id + e.recurrenceId} e={e} zone={zone} calendars={calendars} onOpen={onOpen} pos={pos.get(e.id + e.recurrenceId)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DayView(props: ViewProps) {
  return <HourGrid {...props} days={[props.cursor]} />;
}

export function WeekView(props: ViewProps) {
  // Monday-first, matching the Base module's calendar view and id-ID norms.
  const start = props.cursor.startOf('week');
  return <HourGrid {...props} days={Array.from({ length: 7 }, (_, i) => start.plus({ days: i }))} />;
}

export function MonthView({ events, calendars, zone, cursor, onOpen, onCreateAt }: ViewProps) {
  const first = cursor.startOf('month').startOf('week');
  const last = cursor.endOf('month').endOf('week');
  const days = Interval.fromDateTimes(first, last).splitBy({ days: 1 }).map((d) => d.start!);
  const now = DateTime.now().setZone(zone);
  const MAX = 3;

  return (
    <div className="flex-1 overflow-auto p-2">
      <div className="grid grid-cols-7 gap-px bg-gray-100 dark:bg-gray-700 rounded-lg overflow-hidden min-w-[600px]">
        {['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'].map((d) => (
          <div key={d} className="bg-gray-50 dark:bg-gray-800 py-1 text-center text-[10px] font-medium text-gray-500">{d}</div>
        ))}
        {days.map((day) => {
          const dayEvents = events
            .filter((e) => DateTime.fromISO(e.start, { zone }).hasSame(day, 'day'))
            .sort((a, b) => a.start.localeCompare(b.start));
          const isToday = day.hasSame(now, 'day');
          const outside = day.month !== cursor.month;
          return (
            <div
              key={day.toISODate()}
              onClick={() => onCreateAt?.(day.set({ hour: 9 }))}
              className={`bg-white dark:bg-gray-900 min-h-[86px] p-1 cursor-pointer hover:bg-purple-50/40 dark:hover:bg-purple-900/10 ${outside ? 'opacity-40' : ''}`}
            >
              <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] mb-0.5 ${isToday ? 'bg-purple-600 text-white font-bold' : 'text-gray-500'}`}>
                {day.day}
              </span>
              {dayEvents.slice(0, MAX).map((e) => (
                <button
                  key={e.id + e.recurrenceId}
                  onClick={(ev) => { ev.stopPropagation(); onOpen(e); }}
                  style={{ backgroundColor: `${colorOf(e, calendars)}1a`, borderLeftColor: colorOf(e, calendars) }}
                  className="block w-full text-left rounded border-l-2 px-1 py-0.5 mb-0.5 cursor-pointer hover:brightness-95"
                >
                  <span className={`block text-[9px] truncate ${e.busyOnly ? 'text-gray-500 italic' : 'text-gray-700 dark:text-gray-200'}`}>
                    {timeFmt(zone)(e.start)} {e.title}
                  </span>
                </button>
              ))}
              {dayEvents.length > MAX && (
                <span className="block text-[9px] text-purple-600 px-1">+{dayEvents.length - MAX} lagi</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AgendaView({ events, calendars, zone, onOpen }: ViewProps) {
  const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start));
  const byDay = new Map<string, CalendarEventDto[]>();
  for (const e of sorted) {
    const key = DateTime.fromISO(e.start, { zone }).toISODate()!;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(e);
  }
  if (!sorted.length) return <p className="p-4 text-xs text-gray-400">Tidak ada acara pada rentang ini.</p>;

  return (
    <div className="flex-1 overflow-auto p-3 space-y-3">
      {[...byDay.entries()].map(([day, list]) => (
        <div key={day}>
          <p className="text-[11px] font-semibold text-gray-700 dark:text-gray-200 mb-1">
            {DateTime.fromISO(day, { zone }).setLocale('id').toFormat('cccc, d LLLL yyyy')}
          </p>
          <div className="space-y-1">
            {list.map((e) => (
              <button
                key={e.id + e.recurrenceId}
                onClick={() => onOpen(e)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg border border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer text-left"
              >
                <span className="w-1.5 h-8 rounded-full shrink-0" style={{ backgroundColor: colorOf(e, calendars) }} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-xs truncate ${e.busyOnly ? 'text-gray-500 italic' : 'text-gray-800 dark:text-gray-100 font-medium'}`}>{e.title}</span>
                  <span className="block text-[10px] text-gray-400">
                    {timeFmt(zone)(e.start)}–{timeFmt(zone)(e.end)}
                    {e.roomName ? ` · ${e.roomName}` : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
