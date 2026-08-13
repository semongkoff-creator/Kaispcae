import { useEffect, useState, useCallback } from 'react';
import { DateTime } from 'luxon';
import { PlusLg, Trash, GeoAlt, PeopleFill } from 'react-bootstrap-icons';
import { showConfirm, showPrompt } from '@/stores/modalStore';

const API = '/api';
async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('vm_token');
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `Gagal: ${res.status}`);
  return res.json();
}

interface Room { id: string; name: string; capacity: number; location: string | null; equipment: string[]; bookableBy: string }
interface Booking { id: string; title: string; start: string; end: string; organizer: { id: string; displayName: string } }

const field = 'w-full bg-gray-50 dark:bg-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-800 dark:text-gray-100 outline-none focus:ring-1 focus:ring-purple-500';
const fmt = (iso: string) => DateTime.fromISO(iso).setLocale('id').toFormat('d LLL, HH.mm');

export function CalendarSettings() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openRoom, setOpenRoom] = useState<string | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);

  const load = useCallback(async () => {
    try { setRooms((await req<{ rooms: Room[] }>('/meeting-rooms')).rooms); }
    catch (e) { setError(e instanceof Error ? e.message : 'Gagal memuat'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const flash = (m: string) => { setOk(m); setTimeout(() => setOk(null), 1800); };

  const patch = async (id: string, data: Record<string, unknown>) => {
    try { await req(`/admin/meeting-rooms/${id}`, { method: 'PATCH', body: JSON.stringify(data) }); await load(); flash('Tersimpan.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Gagal'); }
  };

  const remove = async (r: Room) => {
    if (!(await showConfirm(`Hapus ruang “${r.name}”? Booking yang ada akan kehilangan ruangnya.`, { danger: true }))) return;
    try { await req(`/admin/meeting-rooms/${r.id}`, { method: 'DELETE' }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Gagal'); }
  };

  // Viewing someone's bookings is an admin power and IS audit-logged by the
  // server — the list shows titles, unlike free/busy, precisely because this
  // is the room-management view.
  const showBookings = async (roomId: string) => {
    if (openRoom === roomId) { setOpenRoom(null); return; }
    try {
      const from = new Date().toISOString();
      const to = new Date(Date.now() + 30 * 86400000).toISOString();
      setBookings((await req<{ bookings: Booking[] }>(`/admin/meeting-rooms/${roomId}/bookings?from=${from}&to=${to}`)).bookings);
      setOpenRoom(roomId);
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal memuat booking'); }
  };

  const cancel = async (b: Booking) => {
    const reason = await showPrompt(`Batalkan booking "${b.title}"? Alasan (opsional):`);
    if (reason === null) return;
    try {
      await req(`/admin/bookings/${b.id}`, { method: 'DELETE', body: JSON.stringify({ reason }) });
      if (openRoom) await showBookings(openRoom), await showBookings(openRoom);
      flash('Booking dibatalkan — pemiliknya diberi tahu.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal'); }
  };

  return (
    <div className="max-w-3xl">
      {error && <p className="mb-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-2 py-1.5">{error}</p>}
      {ok && <p className="mb-2 text-xs text-green-700 bg-green-50 dark:bg-green-900/20 rounded-lg px-2 py-1.5">{ok}</p>}

      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Ruang meeting</h2>
        <button onClick={() => setCreating(true)} className="text-xs text-purple-600 hover:underline cursor-pointer inline-flex items-center gap-1"><PlusLg size={10} /> Ruang baru</button>
      </div>
      {!rooms.length && <p className="text-[11px] text-gray-400 mb-3">Belum ada ruang meeting.</p>}

      <div className="space-y-2">
        {rooms.map((r) => (
          <div key={r.id} className="rounded-lg border border-gray-100 dark:border-gray-700 p-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-gray-800 dark:text-gray-100">{r.name}</span>
              <span className="text-[11px] text-gray-400 inline-flex items-center gap-0.5"><PeopleFill size={9} /> {r.capacity}</span>
              {r.location && <span className="text-[11px] text-gray-400 inline-flex items-center gap-0.5"><GeoAlt size={9} /> {r.location}</span>}
              <button onClick={() => showBookings(r.id)} className="ml-auto text-[11px] text-purple-600 hover:underline cursor-pointer">
                {openRoom === r.id ? 'Tutup booking' : 'Lihat booking'}
              </button>
              <button onClick={() => remove(r)} aria-label={`Hapus ${r.name}`} className="text-gray-400 hover:text-red-600 cursor-pointer"><Trash size={11} /></button>
            </div>

            <div className="grid grid-cols-3 gap-2 mt-1.5">
              <label className="block">
                <span className="block text-[10px] text-gray-400">Kapasitas</span>
                <input type="number" defaultValue={r.capacity} onBlur={(e) => patch(r.id, { capacity: Number(e.target.value) })} className={field} />
              </label>
              <label className="block">
                <span className="block text-[10px] text-gray-400">Lokasi</span>
                <input defaultValue={r.location ?? ''} onBlur={(e) => patch(r.id, { location: e.target.value || null })} className={field} />
              </label>
              <label className="block">
                <span className="block text-[10px] text-gray-400">Siapa boleh booking</span>
                <select defaultValue={r.bookableBy} onChange={(e) => patch(r.id, { bookableBy: e.target.value })} className={field}>
                  <option value="member">Semua anggota</option>
                  <option value="admin">Admin saja</option>
                </select>
              </label>
            </div>

            {openRoom === r.id && (
              <div className="mt-2 border-t border-gray-100 dark:border-gray-700 pt-2">
                <p className="text-[11px] text-gray-400 mb-1">Booking 30 hari ke depan ({bookings.length})</p>
                {!bookings.length && <p className="text-[11px] text-gray-400">Belum ada booking.</p>}
                {bookings.map((b) => (
                  <div key={b.id} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-gray-50 dark:hover:bg-gray-800">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11px] text-gray-800 dark:text-gray-100 truncate">{b.title}</span>
                      <span className="block text-[10px] text-gray-400">{fmt(b.start)}–{DateTime.fromISO(b.end).toFormat('HH.mm')} · {b.organizer.displayName}</span>
                    </span>
                    <button onClick={() => cancel(b)} className="text-[10px] text-red-600 hover:underline cursor-pointer shrink-0">Batalkan</button>
                  </div>
                ))}
                <p className="text-[10px] text-gray-400 mt-1">Melihat & membatalkan booking orang tercatat di audit log.</p>
              </div>
            )}
          </div>
        ))}
      </div>

      <p className="mt-4 text-[11px] text-gray-400">
        Bentrok booking ditolak server, bukan cuma disembunyikan di UI — dua orang yang klik bersamaan tetap hanya satu yang dapat.
      </p>

      {creating && <NewRoom onClose={() => setCreating(false)} onDone={load} />}
    </div>
  );
}

function NewRoom({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState(4);
  const [location, setLocation] = useState('');
  const [bookableBy, setBookableBy] = useState('member');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    try {
      await req('/admin/meeting-rooms', { method: 'POST', body: JSON.stringify({ name, capacity, location: location || null, bookableBy }) });
      onDone(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal'); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-xs bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-4">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-2">Ruang meeting baru</h3>
        {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
        <div className="space-y-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama ruang" aria-label="Nama ruang" className={field} />
          <input type="number" value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} aria-label="Kapasitas" className={field} />
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Lokasi (opsional)" aria-label="Lokasi" className={field} />
          <select value={bookableBy} onChange={(e) => setBookableBy(e.target.value)} aria-label="Siapa boleh booking" className={field}>
            <option value="member">Semua anggota boleh booking</option>
            <option value="admin">Admin saja</option>
          </select>
        </div>
        <button onClick={submit} className="mt-3 w-full py-2 rounded-lg bg-purple-600 text-white text-xs font-medium cursor-pointer hover:bg-purple-700">Buat</button>
      </div>
    </div>
  );
}
