import { useEffect, useState, useCallback } from 'react';
import { DateTime } from 'luxon';
import { Download } from 'react-bootstrap-icons';
import { AttendanceStatus, STATUS_LABELS } from '@kaispace/shared';
import { adminApi, AdminDepartment } from './api';

const API = '/api';
async function req<T>(path: string): Promise<T> {
  const token = localStorage.getItem('vm_token');
  const res = await fetch(`${API}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `Gagal: ${res.status}`);
  return res.json();
}

interface Row {
  id: string; userId: string; name: string; department: string | null; date: string;
  clockIn: string | null; clockOut: string | null; status: AttendanceStatus;
  workMinutes: number; overtimeMinutes: number;
}

const field = 'bg-gray-50 dark:bg-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-800 dark:text-gray-100 outline-none cursor-pointer';
const hhmm = (iso: string | null) => (iso ? DateTime.fromISO(iso).toFormat('HH.mm') : '—');

export function AttendanceReport() {
  const [rows, setRows] = useState<Row[]>([]);
  const [departments, setDepartments] = useState<AdminDepartment[]>([]);
  const [from, setFrom] = useState(DateTime.now().startOf('month').toISODate()!);
  const [to, setTo] = useState(DateTime.now().toISODate()!);
  const [departmentId, setDepartmentId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to + 'T23:59:59').toISOString() });
      if (departmentId) qs.set('departmentId', departmentId);
      setRows((await req<{ records: Row[] }>(`/admin/attendance/report?${qs}`)).records);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal memuat'); }
    finally { setLoading(false); }
  }, [from, to, departmentId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { adminApi.getDepartments().then((d) => setDepartments(d.departments)).catch(() => { /* filter optional */ }); }, []);

  // The CSV comes from the SERVER (with its own audit entry + UTF-8 BOM) rather
  // than being stitched together here — one exporter, one audit trail.
  const exportCsv = async () => {
    const token = localStorage.getItem('vm_token');
    const qs = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to + 'T23:59:59').toISOString(), format: 'csv' });
    if (departmentId) qs.set('departmentId', departmentId);
    const res = await fetch(`${API}/admin/attendance/report?${qs}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) { setError('Gagal mengekspor'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `absensi-${from}-${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  // Per-person summary for the period.
  const perPerson = new Map<string, { name: string; dept: string | null; hadir: number; telat: number; menit: number; lembur: number }>();
  for (const r of rows) {
    const cur = perPerson.get(r.userId) ?? { name: r.name, dept: r.department, hadir: 0, telat: 0, menit: 0, lembur: 0 };
    cur.hadir += r.clockIn ? 1 : 0;
    cur.telat += r.status === 'late' ? 1 : 0;
    cur.menit += r.workMinutes;
    cur.lembur += r.overtimeMinutes;
    perPerson.set(r.userId, cur);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Dari tanggal" className={field} />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Sampai tanggal" className={field} />
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Departemen" className={field}>
          <option value="">Semua departemen</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <button onClick={exportCsv} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-purple-600 text-white text-xs font-medium cursor-pointer hover:bg-purple-700">
          <Download size={11} /> Ekspor CSV
        </button>
      </div>

      {error && <p className="mb-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-2 py-1.5">{error}</p>}
      {loading ? <p className="text-xs text-gray-400">Memuat…</p> : (
        <>
          <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mb-1">Rekap per orang ({perPerson.size})</p>
          <div className="overflow-x-auto mb-4">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-100 dark:border-gray-700">
                  <th className="py-2 pr-3 font-medium">Nama</th>
                  <th className="py-2 pr-3 font-medium">Departemen</th>
                  <th className="py-2 pr-3 font-medium">Hadir</th>
                  <th className="py-2 pr-3 font-medium">Telat</th>
                  <th className="py-2 pr-3 font-medium">Jam kerja</th>
                  <th className="py-2 font-medium">Lembur</th>
                </tr>
              </thead>
              <tbody>
                {[...perPerson.values()].map((p) => (
                  <tr key={p.name} className="border-b border-gray-50 dark:border-gray-800">
                    <td className="py-1.5 pr-3 text-gray-800 dark:text-gray-100 font-medium">{p.name}</td>
                    <td className="py-1.5 pr-3 text-gray-500">{p.dept ?? '—'}</td>
                    <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-300">{p.hadir} hari</td>
                    <td className={`py-1.5 pr-3 ${p.telat ? 'text-red-600' : 'text-gray-400'}`}>{p.telat}</td>
                    <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-300">{Math.floor(p.menit / 60)}j {p.menit % 60}m</td>
                    <td className="py-1.5 text-gray-600 dark:text-gray-300">{Math.floor(p.lembur / 60)}j {p.lembur % 60}m</td>
                  </tr>
                ))}
                {!perPerson.size && <tr><td colSpan={6} className="py-3 text-gray-400">Tidak ada data pada rentang ini.</td></tr>}
              </tbody>
            </table>
          </div>

          <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mb-1">Rincian ({rows.length} baris)</p>
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white dark:bg-gray-900">
                <tr className="text-left text-gray-400 border-b border-gray-100 dark:border-gray-700">
                  <th className="py-2 pr-3 font-medium">Tanggal</th>
                  <th className="py-2 pr-3 font-medium">Nama</th>
                  <th className="py-2 pr-3 font-medium">Masuk</th>
                  <th className="py-2 pr-3 font-medium">Keluar</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-gray-50 dark:border-gray-800">
                    <td className="py-1.5 pr-3 text-gray-500 whitespace-nowrap">{DateTime.fromISO(r.date).setLocale('id').toFormat('d LLL')}</td>
                    <td className="py-1.5 pr-3 text-gray-800 dark:text-gray-100">{r.name}</td>
                    <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-300">{hhmm(r.clockIn)}</td>
                    <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-300">{hhmm(r.clockOut)}</td>
                    <td className="py-1.5"><span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">{STATUS_LABELS[r.status] ?? r.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="mt-3 text-[11px] text-gray-400">
        Setiap kali laporan ini dibuka atau diekspor, itu tercatat di audit log beserta rentang tanggal dan jumlah barisnya.
      </p>
    </div>
  );
}
