import { useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import { XLg, Trash, CameraVideo, People, GeoAlt, Bell, ArrowRepeat } from 'react-bootstrap-icons';
import { EditScope, Rsvp, RSVP_LABELS, describeRule } from '@kaispace/shared';
import { calendarApi, CalendarEventDto, CalendarSummary, MeetingRoomDto, MeetingZoneDto, EventInput, BusyBlock } from './api';
import { api, RoomInfo } from '@/services/api';
import { showConfirm } from '@/stores/modalStore';

const RRULE_PRESETS: { label: string; value: string | null }[] = [
  { label: 'Tidak berulang', value: null },
  { label: 'Setiap hari', value: 'FREQ=DAILY' },
  { label: 'Setiap minggu', value: 'FREQ=WEEKLY' },
  { label: 'Setiap 2 minggu', value: 'FREQ=WEEKLY;INTERVAL=2' },
  { label: 'Setiap bulan', value: 'FREQ=MONTHLY' },
  { label: 'Setiap tahun', value: 'FREQ=YEARLY' },
];
const REMINDER_PRESETS = [0, 5, 10, 30, 60, 1440];

const label = 'block text-[11px] text-gray-400 mb-0.5';
const field = 'w-full bg-gray-50 dark:bg-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-800 dark:text-gray-100 outline-none focus:ring-1 focus:ring-purple-500';

// Free/busy strip for one attendee. It renders BUSY BLOCKS ONLY — the API
// gives us nothing else on purpose (no titles), so there is nothing here that
// could leak what someone is actually doing.
function BusyBar({ busy, windowStart, windowEnd, clash }: { busy: BusyBlock[]; windowStart: DateTime; windowEnd: DateTime; clash: boolean }) {
  const total = windowEnd.diff(windowStart, 'minutes').minutes || 1;
  return (
    <span className={`relative block h-2 rounded-full overflow-hidden ${clash ? 'bg-red-100 dark:bg-red-900/30' : 'bg-gray-100 dark:bg-gray-700'}`}>
      {busy.map((b, i) => {
        const s = DateTime.fromISO(b.start);
        const e = DateTime.fromISO(b.end);
        const left = Math.max(0, (s.diff(windowStart, 'minutes').minutes / total) * 100);
        const width = Math.min(100 - left, (e.diff(s, 'minutes').minutes / total) * 100);
        if (width <= 0) return null;
        return <span key={i} style={{ left: `${left}%`, width: `${width}%` }} className={`absolute inset-y-0 ${clash ? 'bg-red-400' : 'bg-gray-400'}`} />;
      })}
    </span>
  );
}

export function EventPanel({
  event, calendars, zone, currentUserId, defaultStart, onClose, onSaved, onStartMeeting,
}: {
  event: CalendarEventDto | null;          // null = create mode
  calendars: CalendarSummary[];
  zone: string;
  currentUserId: string;
  defaultStart?: DateTime;
  onClose: () => void;
  onSaved: () => void;
  onStartMeeting?: (e: CalendarEventDto) => void;
}) {
  const editable = calendars.filter((c) => c.role === 'owner' || c.role === 'editor');
  const isNew = !event;
  const [calendarId, setCalendarId] = useState(event?.calendarId ?? editable[0]?.id ?? '');
  const [title, setTitle] = useState(event?.title ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [location, setLocation] = useState(event?.location ?? '');
  const [start, setStart] = useState(
    (event ? DateTime.fromISO(event.start, { zone }) : (defaultStart ?? DateTime.now().setZone(zone).startOf('hour').plus({ hours: 1 })))
      .toFormat("yyyy-MM-dd'T'HH:mm"),
  );
  const [end, setEnd] = useState(
    (event ? DateTime.fromISO(event.end, { zone }) : (defaultStart ?? DateTime.now().setZone(zone).startOf('hour').plus({ hours: 1 })).plus({ hours: 1 }))
      .toFormat("yyyy-MM-dd'T'HH:mm"),
  );
  const [rrule, setRrule] = useState<string | null>(event?.rrule ?? null);
  const [visibility, setVisibility] = useState<'default' | 'private'>(event?.visibility ?? 'default');
  const [roomId, setRoomId] = useState(event?.roomId ?? '');
  const [rooms, setRooms] = useState<MeetingRoomDto[]>([]);
  const [meetkaiRoomSlug, setMeetkaiRoomSlug] = useState(event?.meetkaiRoomSlug ?? '');
  const [kaispaceRooms, setKaispaceRooms] = useState<RoomInfo[]>([]);
  const [meetkaiZoneId, setMeetkaiZoneId] = useState(event?.meetkaiZoneId ?? '');
  const [meetingZones, setMeetingZones] = useState<MeetingZoneDto[]>([]);
  const [meetkaiPassword, setMeetkaiPassword] = useState(event?.meetkaiPassword ?? '');
  const [reminders, setReminders] = useState<number[]>([10]);
  const [members, setMembers] = useState<{ userId: string; name: string }[]>([]);
  const [attendeeIds, setAttendeeIds] = useState<string[]>(event?.attendees?.map((a) => a.userId).filter((id) => id !== event?.organizerId) ?? []);
  const [freebusy, setFreebusy] = useState<Record<string, BusyBlock[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<EditScope>('this');
  const [busy, setBusy] = useState(false);

  const startDt = DateTime.fromISO(start, { zone });
  const endDt = DateTime.fromISO(end, { zone });
  const myRsvp = event?.attendees?.find((a) => a.userId === currentUserId)?.rsvp;
  const isOrganizer = event ? event.organizerId === currentUserId : true;
  const canEdit = isNew || (!event!.busyOnly && calendars.find((c) => c.id === event!.calendarId)?.role !== 'viewer');

  useEffect(() => { calendarApi.listRooms().then((r) => setRooms(r.rooms)).catch(() => { /* rooms are optional */ }); }, []);
  useEffect(() => { api.getRooms().then((r) => setKaispaceRooms(r.rooms)).catch(() => { /* optional */ }); }, []);

  // Refetches this room's Meeting Areas whenever the Room selection changes,
  // and drops a stale Zone selection left over from a previously-picked room.
  useEffect(() => {
    if (!meetkaiRoomSlug) { setMeetingZones([]); setMeetkaiZoneId(''); return; }
    calendarApi.listMeetingZones(meetkaiRoomSlug)
      .then((r) => {
        setMeetingZones(r.zones);
        setMeetkaiZoneId((prev) => (r.zones.some((z) => z.id === prev) ? prev : ''));
      })
      .catch(() => setMeetingZones([]));
  }, [meetkaiRoomSlug]);
  useEffect(() => {
    // The workspace directory — NOT /api/admin/members, which is admin-only:
    // using that meant an ordinary member got a 403 and an empty invite list,
    // i.e. they could not invite anyone at all.
    fetch('/api/workspace/people', { headers: { Authorization: `Bearer ${localStorage.getItem('vm_token')}` } })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { people: { id: string; displayName: string }[] }) => setMembers(d.people.map((m) => ({ userId: m.id, name: m.displayName }))))
      .catch(() => setMembers(event?.attendees?.map((a) => ({ userId: a.userId, name: a.name })) ?? []));
  }, [event]);

  // Refresh the free/busy strips whenever the slot or the invitee list moves.
  useEffect(() => {
    if (!attendeeIds.length || !startDt.isValid) { setFreebusy({}); return; }
    const from = startDt.startOf('day');
    const to = startDt.endOf('day');
    calendarApi.freeBusy(attendeeIds, from.toJSDate(), to.toJSDate())
      .then((r) => setFreebusy(r.freebusy))
      .catch(() => setFreebusy({}));
  }, [attendeeIds.join(','), start]);

  const clashes = (userId: string) =>
    (freebusy[userId] ?? []).some((b) => DateTime.fromISO(b.start) < endDt && DateTime.fromISO(b.end) > startDt);

  const save = async () => {
    setError(null);
    if (!startDt.isValid || !endDt.isValid || endDt <= startDt) { setError('Waktu selesai harus setelah waktu mulai.'); return; }
    // Bug fix — an empty calendarId (no editable calendar to pick, or the
    // "Kalender" dropdown just never got a selection) used to be sent
    // straight through, producing POST /api/calendars//events — a 404 with
    // no clear reason shown. CalendarApp.tsx now auto-provisions a default
    // calendar so this dropdown is never actually empty in practice, but
    // this guard stays as the last line of defense against submitting a
    // request that can only fail.
    if (isNew && !calendarId) { setError('Pilih kalender dulu.'); return; }
    setBusy(true);
    const input: EventInput = {
      title: title.trim() || 'Tanpa judul',
      description: description || null,
      location: location || null,
      // Convert the wall-clock the user typed, in THEIR zone, to a UTC instant.
      start: startDt.toUTC().toISO()!,
      end: endDt.toUTC().toISO()!,
      timezone: zone,
      roomId: roomId || null,
      rrule,
      visibility,
      attendeeIds,
      reminders,
      meetkaiRoomSlug: meetkaiRoomSlug || null,
      meetkaiZoneId: meetkaiRoomSlug && meetkaiZoneId ? meetkaiZoneId : null,
      meetkaiPassword: meetkaiRoomSlug && meetkaiZoneId && meetkaiPassword ? meetkaiPassword : null,
    };
    try {
      if (isNew) await calendarApi.createEvent(calendarId, input);
      else await calendarApi.patchEvent(event!.id, { ...input, scope: event!.isRecurring ? scope : 'all', recurrenceId: event!.recurrenceId });
      onSaved(); onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menyimpan');
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!event) return;
    if (!(await showConfirm('Hapus acara ini?', { danger: true }))) return;
    try {
      await calendarApi.deleteEvent(event.id, event.isRecurring ? scope : 'all', event.recurrenceId);
      onSaved(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal menghapus'); }
  };

  const answer = async (r: Rsvp) => {
    if (!event) return;
    try { await calendarApi.rsvp(event.id, r); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Gagal RSVP'); }
  };

  // A "busy only" event belongs to someone else and this viewer may not see
  // its details — show exactly that, not an empty form.
  if (event?.busyOnly) {
    return (
      <Shell onClose={onClose} title="Sibuk">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Orang ini sibuk pada {DateTime.fromISO(event.start, { zone }).setLocale('id').toFormat('cccc, d LLL HH.mm')}–
          {DateTime.fromISO(event.end, { zone }).toFormat('HH.mm')}.
        </p>
        <p className="text-[11px] text-gray-400 mt-2">Detail acaranya tidak dibagikan ke kamu.</p>
      </Shell>
    );
  }

  return (
    <Shell onClose={onClose} title={isNew ? 'Acara baru' : canEdit ? 'Ubah acara' : 'Detail acara'}>
      {error && <p className="mb-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-2 py-1.5">{error}</p>}

      {/* RSVP — only for people who were actually invited */}
      {event && !isOrganizer && myRsvp && (
        <div className="mb-3 p-2 rounded-lg bg-purple-50 dark:bg-purple-900/20">
          <p className="text-[11px] text-gray-600 dark:text-gray-300 mb-1">Kamu diundang — hadir?</p>
          <div className="flex gap-1">
            {(['accepted', 'tentative', 'declined'] as Rsvp[]).map((r) => (
              <button key={r} onClick={() => answer(r)}
                className={`px-2 py-1 rounded-lg text-[11px] font-medium cursor-pointer ${myRsvp === r ? 'bg-purple-600 text-white' : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100'}`}>
                {RSVP_LABELS[r]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div>
          <label className={label} htmlFor="ev-title">Judul</label>
          <input id="ev-title" value={title} onChange={(e) => setTitle(e.target.value)} readOnly={!canEdit} placeholder="Rapat mingguan" className={field} />
        </div>

        {isNew && (
          <div>
            <label className={label} htmlFor="ev-cal">Kalender</label>
            <select id="ev-cal" value={calendarId} onChange={(e) => setCalendarId(e.target.value)} className={field}>
              {editable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={label} htmlFor="ev-start">Mulai</label>
            <input id="ev-start" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} readOnly={!canEdit} className={field} />
          </div>
          <div>
            <label className={label} htmlFor="ev-end">Selesai</label>
            <input id="ev-end" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} readOnly={!canEdit} className={field} />
          </div>
        </div>
        <p className="text-[10px] text-gray-400">Zona waktumu: {zone}</p>

        <div>
          <label className={label} htmlFor="ev-rrule"><ArrowRepeat size={10} className="inline mr-1" />Perulangan</label>
          <select id="ev-rrule" value={rrule ?? ''} onChange={(e) => setRrule(e.target.value || null)} disabled={!canEdit} className={field}>
            {RRULE_PRESETS.map((p) => <option key={p.label} value={p.value ?? ''}>{p.label}</option>)}
            {rrule && !RRULE_PRESETS.some((p) => p.value === rrule) && <option value={rrule}>{describeRule(rrule)}</option>}
          </select>
          {rrule && <p className="text-[10px] text-gray-400 mt-0.5">{describeRule(rrule)}</p>}
        </div>

        {/* Recurring edits must say WHAT they apply to — this is the whole
            "ini / ini dan seterusnya / semua" contract. */}
        {event?.isRecurring && canEdit && (
          <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-900/20">
            <p className="text-[11px] text-gray-600 dark:text-gray-300 mb-1">Perubahan berlaku untuk:</p>
            <div className="flex flex-wrap gap-1">
              {([['this', 'Hanya acara ini'], ['thisAndFollowing', 'Ini dan seterusnya'], ['all', 'Semua']] as [EditScope, string][]).map(([v, l]) => (
                <button key={v} onClick={() => setScope(v)}
                  className={`px-2 py-1 rounded-lg text-[11px] cursor-pointer ${scope === v ? 'bg-purple-600 text-white' : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200'}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Hidden once a KaiSpace room is picked below — Ruang meeting (a
            generic bookable resource, capacity/equipment, clash-checked) and
            Room KaiSpace (this event's actual auto-join room) both answer
            "which room is this meeting in", so showing both at once reads as
            two competing pickers. Room KaiSpace wins once chosen. */}
        {!meetkaiRoomSlug && (
          <div>
            <label className={label} htmlFor="ev-room">Ruang meeting</label>
            <select id="ev-room" value={roomId} onChange={(e) => setRoomId(e.target.value)} disabled={!canEdit} className={field}>
              <option value="">Tidak pakai ruang</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.capacity} orang{r.bookableBy === 'admin' ? ' (admin)' : ''}</option>)}
            </select>
            <p className="text-[10px] text-gray-400 mt-0.5">Bentrok ruang ditolak server, bukan cuma disembunyikan di sini.</p>
          </div>
        )}

        <div>
          <label className={label} htmlFor="ev-kaispace-room">Room KaiSpace</label>
          <select
            id="ev-kaispace-room" value={meetkaiRoomSlug}
            onChange={(e) => {
              setMeetkaiRoomSlug(e.target.value);
              // Ruang meeting hides once this is set (see above) — drop
              // whatever it held so a stale, now-invisible selection
              // doesn't still ride along in the save payload.
              if (e.target.value) setRoomId('');
            }}
            disabled={!canEdit} className={field}
          >
            <option value="">Tidak pakai auto-join</option>
            {kaispaceRooms.map((r) => <option key={r.slug} value={r.slug}>{r.name}</option>)}
          </select>
        </div>

        {meetkaiRoomSlug && (
          <div>
            <label className={label} htmlFor="ev-meeting-area">Meeting Area</label>
            <select
              id="ev-meeting-area" value={meetkaiZoneId}
              onChange={(e) => setMeetkaiZoneId(e.target.value)}
              disabled={!canEdit} className={field}
            >
              <option value="">Pilih Meeting Area…</option>
              {meetingZones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
            <p className="text-[10px] text-gray-400 mt-0.5">Peserta yang online di room ini otomatis ditarik ke sini saat meeting mulai.</p>
          </div>
        )}

        {meetkaiRoomSlug && meetkaiZoneId && (
          <div>
            <label className={label} htmlFor="ev-meeting-password">Password (opsional)</label>
            <input
              id="ev-meeting-password" type="text" value={meetkaiPassword}
              onChange={(e) => setMeetkaiPassword(e.target.value)}
              readOnly={!canEdit} className={field}
              placeholder="Kosongkan jika tidak private"
            />
            <p className="text-[10px] text-gray-400 mt-0.5">Peserta terundang selalu bisa masuk tanpa password.</p>
          </div>
        )}

        <div>
          <label className={label} htmlFor="ev-loc"><GeoAlt size={10} className="inline mr-1" />Lokasi</label>
          <input id="ev-loc" value={location} onChange={(e) => setLocation(e.target.value)} readOnly={!canEdit} className={field} />
        </div>

        <div>
          <label className={label} htmlFor="ev-desc">Deskripsi</label>
          <textarea id="ev-desc" value={description} onChange={(e) => setDescription(e.target.value)} readOnly={!canEdit} rows={2} className={`${field} resize-none`} />
        </div>

        {/* Attendees + free/busy */}
        {canEdit && (
          <div>
            <label className={label}><People size={10} className="inline mr-1" />Undang</label>
            <select
              value=""
              onChange={(e) => { if (e.target.value) setAttendeeIds((a) => [...new Set([...a, e.target.value])]); }}
              className={field}
              aria-label="Tambah peserta"
            >
              <option value="">Tambah peserta…</option>
              {members.filter((m) => m.userId !== currentUserId && !attendeeIds.includes(m.userId)).map((m) => (
                <option key={m.userId} value={m.userId}>{m.name}</option>
              ))}
            </select>
            <div className="mt-1 space-y-1">
              {attendeeIds.map((id) => {
                const m = members.find((x) => x.userId === id);
                const rsvp = event?.attendees?.find((a) => a.userId === id)?.rsvp;
                const bad = clashes(id);
                return (
                  <div key={id} className="flex items-center gap-1.5">
                    <span className="w-24 shrink-0 text-[11px] text-gray-700 dark:text-gray-200 truncate">{m?.name ?? id.slice(0, 6)}</span>
                    <span className="flex-1 min-w-0"><BusyBar busy={freebusy[id] ?? []} windowStart={startDt.startOf('day')} windowEnd={startDt.endOf('day')} clash={bad} /></span>
                    {rsvp && <span className="text-[9px] text-gray-400 shrink-0">{RSVP_LABELS[rsvp]}</span>}
                    {bad && <span className="text-[9px] text-red-600 shrink-0">bentrok</span>}
                    <button onClick={() => setAttendeeIds((a) => a.filter((x) => x !== id))} aria-label={`Hapus ${m?.name ?? ''}`} className="text-gray-400 hover:text-red-600 cursor-pointer shrink-0">
                      <XLg size={9} />
                    </button>
                  </div>
                );
              })}
              {attendeeIds.length > 0 && (
                <p className="text-[9px] text-gray-400">Bar hanya menunjukkan sibuk/senggang — judul acara orang lain tidak ditampilkan.</p>
              )}
            </div>
          </div>
        )}

        {canEdit && (
          <div>
            <label className={label}><Bell size={10} className="inline mr-1" />Pengingat</label>
            <div className="flex flex-wrap gap-1">
              {REMINDER_PRESETS.map((m) => (
                <button key={m} onClick={() => setReminders((r) => (r.includes(m) ? r.filter((x) => x !== m) : [...r, m]))}
                  className={`px-1.5 py-0.5 rounded text-[10px] cursor-pointer ${reminders.includes(m) ? 'bg-purple-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
                  {m === 0 ? 'Saat mulai' : m >= 60 ? `${m / 60} jam` : `${m} menit`}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-gray-400 mt-0.5">Dikirim sebagai notifikasi di aplikasi.</p>
          </div>
        )}

        {canEdit && (
          <label className="flex items-center gap-2 text-[11px] text-gray-700 dark:text-gray-200 cursor-pointer">
            <input type="checkbox" checked={visibility === 'private'} onChange={(e) => setVisibility(e.target.checked ? 'private' : 'default')} className="w-3 h-3 accent-purple-600" />
            Privat — orang lain hanya melihat “Sibuk”
          </label>
        )}
      </div>

      {event && onStartMeeting && !event.busyOnly && (
        <button onClick={() => onStartMeeting(event)} className="mt-3 w-full inline-flex items-center justify-center gap-1.5 py-2 rounded-lg bg-green-600 text-white text-xs font-medium cursor-pointer hover:bg-green-700">
          <CameraVideo size={12} /> Mulai meeting
        </button>
      )}

      {canEdit && (
        <div className="flex items-center gap-2 mt-4">
          <button onClick={save} disabled={busy} className="flex-1 py-2 rounded-lg bg-purple-600 text-white text-xs font-medium cursor-pointer hover:bg-purple-700 disabled:opacity-50">
            {busy ? 'Menyimpan…' : isNew ? 'Buat acara' : 'Simpan'}
          </button>
          {event && (
            <button onClick={remove} aria-label="Hapus acara" className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 cursor-pointer">
              <Trash size={13} />
            </button>
          )}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children, title, onClose }: { children: React.ReactNode; title: string; onClose: () => void }) {
  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-[400px] bg-white dark:bg-gray-800 shadow-2xl flex flex-col">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-700 shrink-0">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">{title}</h2>
        <button onClick={onClose} aria-label="Tutup" className="ml-auto p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 cursor-pointer"><XLg size={13} /></button>
      </header>
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
    </div>
  );
}
