import { useEffect, useState, useCallback } from 'react';
import { PlusLg, GeoAlt } from 'react-bootstrap-icons';
import { adminApi, AdminMember } from './api';
import { showPrompt } from '@/stores/modalStore';

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

interface Shift {
  id: string; name: string; startTime: string; endTime: string; timezone: string;
  breakMinutes: number; graceMinutes: number; workdays: number[]; overtimeRule: string;
  geofenceLat: number | null; geofenceLng: number | null; geofenceRadiusM: number | null;
}
interface LeaveType { id: string; name: string; quotaPerYear: number; paid: boolean; requiresApproval: boolean }

const field = 'w-full bg-gray-50 dark:bg-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-800 dark:text-gray-100 outline-none focus:ring-1 focus:ring-purple-500';
const DAYS = [['Sen', 1], ['Sel', 2], ['Rab', 3], ['Kam', 4], ['Jum', 5], ['Sab', 6], ['Min', 7]] as const;

export function AttendanceSettings() {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, t, m] = await Promise.all([
        req<{ shifts: Shift[] }>('/attendance/shifts'),
        req<{ types: LeaveType[] }>('/attendance/leave-types'),
        adminApi.getMembers(),
      ]);
      setShifts(s.shifts); setTypes(t.types); setMembers(m.members);
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal memuat'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const flash = (m: string) => { setOk(m); setTimeout(() => setOk(null), 1800); };

  const patchShift = async (id: string, data: Record<string, unknown>) => {
    try { await req(`/admin/attendance/shifts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }); await load(); flash('Tersimpan.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Gagal'); }
  };

  const assign = async (userId: string, shiftId: string) => {
    if (!shiftId) return;
    try {
      await req('/admin/attendance/assignments', { method: 'POST', body: JSON.stringify({ userId, shiftId, effectiveFrom: new Date().toISOString() }) });
      flash('Shift ditugaskan.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal'); }
  };

  const addType = async () => {
    const name = await showPrompt('Nama jenis cuti:');
    if (!name?.trim()) return;
    const quota = Number(await showPrompt('Kuota per tahun (hari):', '12', { inputType: 'number' }) ?? 12);
    try { await req('/admin/attendance/leave-types', { method: 'POST', body: JSON.stringify({ name: name.trim(), quotaPerYear: quota }) }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Gagal'); }
  };

  const addHoliday = async () => {
    const date = await showPrompt('Tanggal libur (YYYY-MM-DD):');
    if (!date) return;
    const name = await showPrompt('Nama libur:', 'Libur nasional') ?? 'Libur';
    try { await req('/admin/attendance/holidays', { method: 'POST', body: JSON.stringify({ date, name }) }); flash('Libur ditambahkan.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Gagal'); }
  };

  return (
    <div className="max-w-3xl">
      {error && <p className="mb-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-2 py-1.5">{error}</p>}
      {ok && <p className="mb-2 text-xs text-green-700 bg-green-50 dark:bg-green-900/20 rounded-lg px-2 py-1.5">{ok}</p>}

      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Shift</h2>
        <button onClick={() => setCreating(true)} className="text-xs text-purple-600 hover:underline cursor-pointer inline-flex items-center gap-1"><PlusLg size={10} /> Shift baru</button>
      </div>
      {!shifts.length && <p className="text-[11px] text-gray-400 mb-3">Belum ada shift. Tanpa shift, tidak ada yang bisa clock in.</p>}
      <div className="space-y-2 mb-5">
        {shifts.map((s) => (
          <div key={s.id} className="rounded-lg border border-gray-100 dark:border-gray-700 p-2.5">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs font-medium text-gray-800 dark:text-gray-100">{s.name}</span>
              <span className="text-[11px] text-gray-400">{s.startTime}–{s.endTime} · {s.timezone}</span>
              {s.geofenceLat != null && <span className="text-[10px] text-purple-600 inline-flex items-center gap-0.5"><GeoAlt size={9} /> geofence {s.geofenceRadiusM} m</span>}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <label className="block">
                <span className="block text-[10px] text-gray-400">Toleransi telat (menit)</span>
                <input type="number" defaultValue={s.graceMinutes} onBlur={(e) => patchShift(s.id, { graceMinutes: Number(e.target.value) })} className={field} />
              </label>
              <label className="block">
                <span className="block text-[10px] text-gray-400">Istirahat (menit)</span>
                <input type="number" defaultValue={s.breakMinutes} onBlur={(e) => patchShift(s.id, { breakMinutes: Number(e.target.value) })} className={field} />
              </label>
              <label className="block">
                <span className="block text-[10px] text-gray-400">Aturan lembur</span>
                <select defaultValue={s.overtimeRule} onChange={(e) => patchShift(s.id, { overtimeRule: e.target.value })} className={field}>
                  <option value="none">Tidak ada</option>
                  <option value="after_shift">Setelah jam shift</option>
                  <option value="manual">Manual</option>
                </select>
              </label>
            </div>
            <div className="flex items-center gap-1 mt-1.5">
              <span className="text-[10px] text-gray-400 mr-1">Hari kerja:</span>
              {DAYS.map(([l, d]) => (
                <button key={d} onClick={() => patchShift(s.id, { workdays: s.workdays.includes(d) ? s.workdays.filter((x) => x !== d) : [...s.workdays, d] })}
                  className={`px-1.5 py-0.5 rounded text-[10px] cursor-pointer ${s.workdays.includes(d) ? 'bg-purple-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-500'}`}>
                  {l}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2 mt-1.5">
              <label className="block">
                <span className="block text-[10px] text-gray-400">Geofence lat</span>
                <input defaultValue={s.geofenceLat ?? ''} placeholder="kosong = tanpa" onBlur={(e) => patchShift(s.id, { geofenceLat: e.target.value === '' ? null : Number(e.target.value) })} className={field} />
              </label>
              <label className="block">
                <span className="block text-[10px] text-gray-400">Geofence lng</span>
                <input defaultValue={s.geofenceLng ?? ''} onBlur={(e) => patchShift(s.id, { geofenceLng: e.target.value === '' ? null : Number(e.target.value) })} className={field} />
              </label>
              <label className="block">
                <span className="block text-[10px] text-gray-400">Radius (m)</span>
                <input type="number" defaultValue={s.geofenceRadiusM ?? ''} onBlur={(e) => patchShift(s.id, { geofenceRadiusM: e.target.value === '' ? null : Number(e.target.value) })} className={field} />
              </label>
            </div>
          </div>
        ))}
      </div>

      <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-2">Tugaskan shift ke anggota</h2>
      <div className="max-h-56 overflow-y-auto space-y-1 mb-5">
        {members.filter((m) => m.active).slice(0, 60).map((m) => (
          <div key={m.id} className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800">
            <span className="flex-1 text-xs text-gray-700 dark:text-gray-200 truncate">{m.displayName}</span>
            <select defaultValue="" onChange={(e) => assign(m.id, e.target.value)} aria-label={`Shift untuk ${m.displayName}`} className="bg-gray-50 dark:bg-gray-700 rounded px-1.5 py-1 text-[11px] outline-none cursor-pointer">
              <option value="">Pilih shift…</option>
              {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        ))}
      </div>

      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Jenis cuti & libur</h2>
        <span className="flex gap-2">
          <button onClick={addType} className="text-xs text-purple-600 hover:underline cursor-pointer">+ Jenis cuti</button>
          <button onClick={addHoliday} className="text-xs text-purple-600 hover:underline cursor-pointer">+ Hari libur</button>
        </span>
      </div>
      <div className="space-y-1">
        {types.map((t) => (
          <div key={t.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-gray-100 dark:border-gray-700">
            <span className="flex-1 text-xs text-gray-800 dark:text-gray-100">{t.name}</span>
            <span className="text-[11px] text-gray-400">{t.quotaPerYear} hari/tahun</span>
            <span className="text-[10px] text-gray-400">{t.paid ? 'dibayar' : 'tidak dibayar'}</span>
          </div>
        ))}
        {!types.length && <p className="text-[11px] text-gray-400">Belum ada jenis cuti.</p>}
      </div>

      <p className="mt-4 text-[11px] text-gray-400">
        Lokasi hanya direkam saat clock in/out dan dihapus otomatis setelah 90 hari. Tidak ada pelacakan berkelanjutan, dan itu bukan pengaturan yang bisa dimatikan.
      </p>

      {creating && <NewShift onClose={() => setCreating(false)} onDone={load} />}
    </div>
  );
}

function NewShift({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [startTime, setStart] = useState('09:00');
  const [endTime, setEnd] = useState('17:00');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    try {
      await req('/admin/attendance/shifts', { method: 'POST', body: JSON.stringify({ name, startTime, endTime, timezone: 'Asia/Jakarta', breakMinutes: 60, graceMinutes: 10, workdays: [1, 2, 3, 4, 5] }) });
      onDone(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal'); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-xs bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-4">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-2">Shift baru</h3>
        {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
        <div className="space-y-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama shift" aria-label="Nama shift" className={field} />
          <div className="grid grid-cols-2 gap-2">
            <input type="time" value={startTime} onChange={(e) => setStart(e.target.value)} aria-label="Jam mulai" className={field} />
            <input type="time" value={endTime} onChange={(e) => setEnd(e.target.value)} aria-label="Jam selesai" className={field} />
          </div>
        </div>
        <button onClick={submit} className="mt-3 w-full py-2 rounded-lg bg-purple-600 text-white text-xs font-medium cursor-pointer hover:bg-purple-700">Buat</button>
      </div>
    </div>
  );
}
