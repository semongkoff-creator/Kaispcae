import { useCallback, useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { HourglassSplit, CameraVideo, CheckCircle, PeopleFill, EmojiSmile, ClockHistory, Download } from 'react-bootstrap-icons';
import { PeriodPicker, PeriodValue, defaultPeriodValue } from './PeriodPicker';

const API = '/api';
async function req<T>(path: string): Promise<T> {
  const token = localStorage.getItem('vm_token');
  const res = await fetch(`${API}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `Gagal: ${res.status}`);
  return res.json();
}

interface IndividualResponse {
  period: { type: string; start: string; end: string };
  jamHadir: { totalMinutes: number; targetMinutes: number };
  overtime: { totalMinutes: number };
  focusMinutes: number;
  meetingMinutes: number;
  taskSelesai: { due: number; completed: number };
  connections: { count: number };
  vibe: { score: number };
  distribution: { availableMinutes: number; focusMinutes: number; inMeetingMinutes: number; busyMinutes: number; awayMinutes: number; offlineMinutes: number };
  attendanceHistory: { date: string; clockIn: string | null; clockOut: string | null; status: string; workMinutes: number; overtimeMinutes: number; grace: { reason: string; previousDayClockOut: string | null; previousDayOvertimeMinutes: number } | null }[];
}

function fmtMinutes(m: number): string {
  const sign = m < 0 ? '-' : '';
  const abs = Math.abs(Math.round(m));
  return `${sign}${Math.floor(abs / 60)}j ${abs % 60}m`;
}

const PIE_COLORS = ['#7c3aed', '#2563eb', '#d97706', '#6b7280', '#0891b2'];

const card = 'bg-gray-50 dark:bg-gray-800 rounded-xl p-3';
const cardLabel = 'text-[11px] text-gray-500 dark:text-gray-400 flex items-center gap-1.5 mb-1';
const cardValue = 'text-lg font-semibold text-gray-800 dark:text-gray-100';

// Bagian B.3.1 — Individual tier. `userId` is only ever set by AdminConsole
// (Phase 3, a manager/admin browsing someone else's data via
// canViewAnalyticsOf) — MyAnalyticsPanel.tsx always leaves it unset (self).
export function AnalyticsPanel({ userId }: { userId?: string }) {
  const [period, setPeriod] = useState<PeriodValue>(defaultPeriodValue());
  const [data, setData] = useState<IndividualResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ period: period.period });
      if (period.period === 'custom') { qs.set('from', period.from); qs.set('to', period.to); }
      if (userId) qs.set('userId', userId);
      setData(await req<IndividualResponse>(`/analytics/individual?${qs}`));
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal memuat'); }
    finally { setLoading(false); }
  }, [period, userId]);
  useEffect(() => { void load(); }, [load]);

  // Bagian B.7 — same "server-built file, unconditional audit entry" shape
  // as AttendanceReport.tsx's own exportCsv, just xlsx instead of CSV.
  const exportExcel = async () => {
    const token = localStorage.getItem('vm_token');
    const qs = new URLSearchParams({ tier: 'individual', period: period.period });
    if (period.period === 'custom') { qs.set('from', period.from); qs.set('to', period.to); }
    if (userId) qs.set('userId', userId);
    const res = await fetch(`${API}/analytics/export?${qs}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) { setError('Gagal mengekspor'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `analitik-individu-${DateTime.now().toFormat('yyyyLLdd')}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  };

  const pieData = data ? [
    { name: 'Available/Focus', value: data.distribution.availableMinutes + data.distribution.focusMinutes },
    { name: 'In Meeting', value: data.distribution.inMeetingMinutes },
    { name: 'Busy', value: data.distribution.busyMinutes },
    { name: 'Away', value: data.distribution.awayMinutes },
    { name: 'Offline', value: data.distribution.offlineMinutes },
  ].filter((d) => d.value > 0) : [];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <PeriodPicker value={period} onChange={setPeriod} />
        <button onClick={exportExcel} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-purple-600 text-white text-xs font-medium cursor-pointer hover:bg-purple-700">
          <Download size={11} /> Ekspor Excel
        </button>
      </div>

      {error && <p className="mb-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-2 py-1.5">{error}</p>}
      {loading || !data ? <p className="text-xs text-gray-400">Memuat…</p> : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
            <div className={card}>
              <p className={cardLabel}><ClockHistory size={12} /> Jam hadir</p>
              <p className={cardValue}>{fmtMinutes(data.jamHadir.totalMinutes)}</p>
              <p className="text-[10px] text-gray-400">dari target {fmtMinutes(data.jamHadir.targetMinutes)}</p>
            </div>
            <div className={card}>
              <p className={cardLabel}><HourglassSplit size={12} /> Focus time</p>
              <p className={cardValue}>{fmtMinutes(data.focusMinutes)}</p>
              <p className="text-[10px] text-gray-400">Waktu deep-work tanpa gangguan</p>
            </div>
            <div className={card}>
              <p className={cardLabel}><CameraVideo size={12} /> Waktu meeting</p>
              <p className={cardValue}>{fmtMinutes(data.meetingMinutes)}</p>
            </div>
            <div className={card}>
              <p className={cardLabel}><CheckCircle size={12} /> Task selesai</p>
              <p className={cardValue}>{data.taskSelesai.completed}/{data.taskSelesai.due}</p>
            </div>
            <div className={card}>
              <p className={cardLabel}><PeopleFill size={12} /> Connections</p>
              <p className={cardValue}>{data.connections.count}</p>
              <p className="text-[10px] text-gray-400">Obrolan spontan</p>
            </div>
            <div className={card}>
              <p className={cardLabel}><EmojiSmile size={12} /> Vibe pribadi</p>
              <p className={cardValue}>{data.vibe.score.toFixed(1)}/10</p>
            </div>
          </div>

          {data.overtime.totalMinutes > 0 && (
            <p className="mb-4 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-2.5 py-1.5">
              Lembur periode ini: {fmtMinutes(data.overtime.totalMinutes)}
            </p>
          )}

          <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mb-2">Distribusi waktu</p>
          <div className="flex flex-col sm:flex-row items-center gap-3 mb-4">
            <div className="w-40 h-40 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={35} outerRadius={65} paddingAngle={2}>
                    {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v) => fmtMinutes(typeof v === 'number' ? v : 0)} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex-1 grid grid-cols-1 gap-1 text-xs w-full">
              {pieData.map((d, i) => (
                <div key={d.name} className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                  <span className="text-gray-600 dark:text-gray-300 flex-1">{d.name}</span>
                  <span className="text-gray-400">{fmtMinutes(d.value)}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mb-1">Riwayat kehadiran & lembur</p>
          <div className="overflow-x-auto max-h-64 overflow-y-auto mb-4">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white dark:bg-gray-900">
                <tr className="text-left text-gray-400 border-b border-gray-100 dark:border-gray-700">
                  <th className="py-2 pr-3 font-medium">Tanggal</th>
                  <th className="py-2 pr-3 font-medium">Masuk</th>
                  <th className="py-2 pr-3 font-medium">Keluar</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 font-medium">Lembur</th>
                </tr>
              </thead>
              <tbody>
                {data.attendanceHistory.map((r) => (
                  <tr key={r.date} className="border-b border-gray-50 dark:border-gray-800">
                    <td className="py-1.5 pr-3 text-gray-500 whitespace-nowrap">{DateTime.fromISO(r.date).setLocale('id').toFormat('d LLL')}</td>
                    <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-300">{r.clockIn ? DateTime.fromISO(r.clockIn).toFormat('HH.mm') : '—'}</td>
                    <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-300">{r.clockOut ? DateTime.fromISO(r.clockOut).toFormat('HH.mm') : '—'}</td>
                    <td className="py-1.5 pr-3">
                      {r.grace ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300" title={`Lembur ${fmtMinutes(r.grace.previousDayOvertimeMinutes)} hari sebelumnya`}>
                          Habis lembur — dimaklumi
                        </span>
                      ) : (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${r.status === 'late' ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
                          {r.status}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-gray-600 dark:text-gray-300">{r.overtimeMinutes > 0 ? fmtMinutes(r.overtimeMinutes) : '—'}</td>
                  </tr>
                ))}
                {!data.attendanceHistory.length && <tr><td colSpan={5} className="py-3 text-gray-400">Tidak ada data pada rentang ini.</td></tr>}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-gray-400 italic">
            Ini cermin evaluasi diri, bukan penilaian atasan.
          </p>
        </>
      )}
    </div>
  );
}
