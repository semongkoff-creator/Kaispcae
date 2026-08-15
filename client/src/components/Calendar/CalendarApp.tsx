import { useEffect, useState, useCallback, useMemo } from 'react';
import { DateTime } from 'luxon';
import { XLg, ChevronLeft, ChevronRight, PlusLg, Download, Trash } from 'react-bootstrap-icons';
import { calendarApi, CalendarSummary, CalendarEventDto } from './api';
import { DayView, WeekView, MonthView, AgendaView } from './views';
import { EventPanel } from './EventPanel';
import { toIcs } from './ics';
import { showAlert, showConfirm, showPrompt } from '@/stores/modalStore';

type ViewKind = 'day' | 'week' | 'month' | 'agenda';
const VIEWS: { id: ViewKind; label: string }[] = [
  { id: 'day', label: 'Hari' },
  { id: 'week', label: 'Minggu' },
  { id: 'month', label: 'Bulan' },
  { id: 'agenda', label: 'Agenda' },
];

export function CalendarApp({ currentUser, onClose, onStartMeeting }: {
  currentUser: { id: string; name: string; timezone: string };
  onClose: () => void;
  onStartMeeting?: (slug: string) => void;
}) {
  const zone = currentUser.timezone;
  const [view, setView] = useState<ViewKind>('week');
  const [cursor, setCursor] = useState(() => DateTime.now().setZone(zone));
  const [calendars, setCalendars] = useState<CalendarSummary[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [events, setEvents] = useState<CalendarEventDto[]>([]);
  const [panel, setPanel] = useState<{ event: CalendarEventDto | null; at?: DateTime } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The instant window the current view covers, in the VIEWER's zone.
  const range = useMemo(() => {
    if (view === 'day') return { from: cursor.startOf('day'), to: cursor.endOf('day') };
    if (view === 'week') return { from: cursor.startOf('week'), to: cursor.endOf('week') };
    if (view === 'month') return { from: cursor.startOf('month').startOf('week'), to: cursor.endOf('month').endOf('week') };
    return { from: cursor.startOf('day'), to: cursor.plus({ days: 30 }).endOf('day') };
  }, [view, cursor]);

  const loadCalendars = useCallback(async () => {
    try { setCalendars((await calendarApi.listCalendars()).calendars); }
    catch (e) { setError(e instanceof Error ? e.message : 'Gagal memuat kalender'); }
  }, []);
  useEffect(() => { void loadCalendars(); }, [loadCalendars]);

  const visibleIds = calendars.filter((c) => !hidden.has(c.id)).map((c) => c.id);

  const loadEvents = useCallback(async () => {
    if (!visibleIds.length) { setEvents([]); return; }
    try {
      setEvents((await calendarApi.getEvents(visibleIds, range.from.toJSDate(), range.to.toJSDate())).events);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal memuat acara'); }
  }, [visibleIds.join(','), range.from.toISO(), range.to.toISO()]);
  useEffect(() => { void loadEvents(); }, [loadEvents]);

  const step = (dir: 1 | -1) => {
    const unit = view === 'day' ? 'days' : view === 'week' ? 'weeks' : view === 'month' ? 'months' : 'days';
    setCursor((c) => c.plus({ [unit]: dir * (view === 'agenda' ? 30 : 1) }));
  };

  const heading = view === 'month'
    ? cursor.setLocale('id').toFormat('LLLL yyyy')
    : view === 'day'
      ? cursor.setLocale('id').toFormat('cccc, d LLLL yyyy')
      : `${range.from.setLocale('id').toFormat('d LLL')} – ${range.to.setLocale('id').toFormat('d LLL yyyy')}`;

  const newCalendar = async () => {
    const name = await showPrompt('Nama kalender baru:');
    if (!name?.trim()) return;
    try { await calendarApi.createCalendar(name.trim()); await loadCalendars(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Gagal'); }
  };

  const removeCalendar = async (c: CalendarSummary) => {
    if (!(await showConfirm(`Hapus kalender “${c.name}” beserta acaranya?`, { danger: true }))) return;
    try { await calendarApi.deleteCalendar(c.id); await loadCalendars(); await loadEvents(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Gagal menghapus'); }
  };

  const exportIcs = () => {
    const blob = new Blob([toIcs(events.filter((e) => !e.busyOnly), zone)], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meetkai-${range.from.toISODate()}.ics`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startMeeting = async (e: CalendarEventDto) => {
    // Room integration, honestly scoped: this opens/creates a room session
    // for the event. There is no transcript/notulen pipeline in this repo, so
    // nothing beyond the room link is claimed.
    const slug = e.meetkaiRoomSlug;
    if (slug && onStartMeeting) { onStartMeeting(slug); return; }
    await showAlert('Belum ada room yang tertaut ke acara ini.');
  };

  const ViewComp = view === 'day' ? DayView : view === 'week' ? WeekView : view === 'month' ? MonthView : AgendaView;

  return (
    // pl-14 clears the room's Sidebar rail — same as the other full-screen modules.
    <div className="absolute inset-0 z-40 flex bg-white dark:bg-gray-900 overflow-hidden pl-14">
      <aside className="w-44 sm:w-52 shrink-0 border-r border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60 flex flex-col">
        <div className="px-3 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2">
          <button onClick={onClose} aria-label="Kembali" className="p-1 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 cursor-pointer shrink-0"><XLg size={14} /></button>
          <p className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">Kalender</p>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {calendars.map((c) => (
            <div key={c.id} className="group flex items-center gap-1.5 px-1.5 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
              <input
                type="checkbox"
                checked={!hidden.has(c.id)}
                onChange={(e) => setHidden((h) => { const n = new Set(h); if (e.target.checked) n.delete(c.id); else n.add(c.id); return n; })}
                aria-label={`Tampilkan ${c.name}`}
                style={{ accentColor: c.color }}
                className="w-3 h-3 shrink-0"
              />
              <span className="min-w-0 flex-1 text-xs text-gray-700 dark:text-gray-200 truncate">{c.name}</span>
              {c.type === 'team' && <span className="text-[9px] text-gray-400 shrink-0">tim</span>}
              {c.role === 'owner' && (
                <button onClick={() => removeCalendar(c)} aria-label={`Hapus ${c.name}`} className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 cursor-pointer shrink-0"><Trash size={10} /></button>
              )}
            </div>
          ))}
          {!calendars.length && <p className="text-[11px] text-gray-400 px-1">Belum ada kalender.</p>}
        </div>
        <button onClick={newCalendar} className="m-2 py-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-xs text-gray-500 hover:border-purple-400 hover:text-purple-600 cursor-pointer inline-flex items-center justify-center gap-1">
          <PlusLg size={11} /> Kalender baru
        </button>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col">
        <header className="flex items-center gap-1.5 px-3 py-2 border-b border-gray-100 dark:border-gray-700 shrink-0 flex-wrap">
          <button onClick={() => setCursor(DateTime.now().setZone(zone))} className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer">Hari ini</button>
          <button onClick={() => step(-1)} aria-label="Sebelumnya" className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"><ChevronLeft size={12} /></button>
          <button onClick={() => step(1)} aria-label="Berikutnya" className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"><ChevronRight size={12} /></button>
          <h1 className="text-sm font-semibold text-gray-800 dark:text-gray-100 ml-1 truncate">{heading}</h1>

          <div className="flex-1" />
          <div className="flex items-center gap-0.5 bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
            {VIEWS.map((v) => (
              <button key={v.id} onClick={() => setView(v.id)} aria-current={view === v.id ? 'page' : undefined}
                className={`px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer ${view === v.id ? 'bg-white dark:bg-gray-700 text-purple-700 dark:text-purple-300 shadow-sm' : 'text-gray-600 dark:text-gray-300'}`}>
                {v.label}
              </button>
            ))}
          </div>
          <button onClick={exportIcs} title="Ekspor .ics" aria-label="Ekspor .ics" className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"><Download size={13} /></button>
          <button onClick={() => setPanel({ event: null })} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-purple-600 text-white text-xs font-medium cursor-pointer hover:bg-purple-700">
            <PlusLg size={11} /> Acara
          </button>
        </header>

        {error && <p className="mx-3 mt-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-2 py-1.5">{error}</p>}

        <ViewComp
          events={events}
          calendars={calendars}
          zone={zone}
          cursor={cursor}
          onOpen={(e) => setPanel({ event: e })}
          onCreateAt={(at) => setPanel({ event: null, at })}
        />
      </main>

      {panel && (
        <EventPanel
          key={panel.event?.id ?? 'new'}
          event={panel.event}
          calendars={calendars}
          zone={zone}
          currentUserId={currentUser.id}
          defaultStart={panel.at}
          onClose={() => setPanel(null)}
          onSaved={loadEvents}
          onStartMeeting={startMeeting}
        />
      )}
    </div>
  );
}
