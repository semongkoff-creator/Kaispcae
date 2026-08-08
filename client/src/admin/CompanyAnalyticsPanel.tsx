import { useCallback, useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, LineChart, Line, CartesianGrid } from 'recharts';
import { PeopleFill, GraphUp, CheckCircle, HourglassSplit, ClockHistory, CurrencyExchange, Download } from 'react-bootstrap-icons';
import { PeriodPicker, PeriodValue, defaultPeriodValue } from './PeriodPicker';
import { RankingBoard } from './RankingBoard';

const API = '/api';
async function req<T>(path: string): Promise<T> {
  const token = localStorage.getItem('vm_token');
  const res = await fetch(`${API}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `Gagal: ${res.status}`);
  return res.json();
}

interface CompanyResponse {
  period: { type: string; start: string; end: string };
  timAktif: { online: number; total: number };
  utilization: { percent: number | null };
  deliveryOnTime: { rate: number | null; due: number; completed: number };
  avgFocusPercent: number;
  schedulingSaved: { connections: number; hours: number };
  roi: { timeSavedValueIdr: number; netValueIdr: number; roiPercent: number } | null;
  utilizationByDept: { departmentId: string; name: string; memberCount: number; utilizationPercent: number | null }[];
  heatmap: { weekday: number; hours: number[] }[];
  trend: { start: string; end: string; due: number; completed: number; rate: number | null }[];
}

const card = 'bg-gray-50 dark:bg-gray-800 rounded-xl p-3';
const cardLabel = 'text-[11px] text-gray-500 dark:text-gray-400 flex items-center gap-1.5 mb-1';
const cardValue = 'text-lg font-semibold text-gray-800 dark:text-gray-100';
const WEEKDAY_LABELS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
const fmtIdr = (n: number) => `Rp${n.toLocaleString('id-ID')}`;

function heatColor(minutes: number, max: number): string {
  if (minutes <= 0 || max <= 0) return 'rgba(124,58,237,0.05)';
  const alpha = Math.min(1, minutes / max);
  return `rgba(124,58,237,${0.08 + alpha * 0.82})`;
}

// Bagian B.3.3 — All Kaitech tier, admin/founder only (server-gated via
// requireWorkspace('analytics:viewAllCompany'), see routes/analytics.ts).
export function CompanyAnalyticsPanel() {
  const [period, setPeriod] = useState<PeriodValue>(defaultPeriodValue());
  const [data, setData] = useState<CompanyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ period: period.period });
      if (period.period === 'custom') { qs.set('from', period.from); qs.set('to', period.to); }
      setData(await req<CompanyResponse>(`/analytics/company?${qs}`));
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal memuat'); }
    finally { setLoading(false); }
  }, [period]);
  useEffect(() => { void load(); }, [load]);

  const maxHeat = data ? Math.max(1, ...data.heatmap.flatMap((d) => d.hours)) : 1;
  const trendData = data?.trend.map((t) => ({
    label: DateTime.fromISO(t.start).setLocale('id').toFormat('d LLL'),
    rate: t.rate ?? 0,
  })) ?? [];
  const deptData = data?.utilizationByDept.map((d) => ({ name: d.name, utilization: d.utilizationPercent ?? 0 })) ?? [];

  const exportExcel = async () => {
    const token = localStorage.getItem('vm_token');
    const qs = new URLSearchParams({ tier: 'company', period: period.period });
    if (period.period === 'custom') { qs.set('from', period.from); qs.set('to', period.to); }
    const res = await fetch(`${API}/analytics/export?${qs}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) { setError('Gagal mengekspor'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `analitik-perusahaan-${DateTime.now().toFormat('yyyyLLdd')}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  };

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
              <p className={cardLabel}><PeopleFill size={12} /> Tim aktif</p>
              <p className={cardValue}>{data.timAktif.online}/{data.timAktif.total}</p>
            </div>
            <div className={card}>
              <p className={cardLabel}><GraphUp size={12} /> Utilization</p>
              <p className={cardValue}>{data.utilization.percent ?? '—'}{data.utilization.percent !== null ? '%' : ''}</p>
              <p className="text-[10px] text-gray-400">% jam hadir yang produktif</p>
            </div>
            <div className={card}>
              <p className={cardLabel}><CheckCircle size={12} /> Delivery on-time</p>
              <p className={cardValue}>{data.deliveryOnTime.rate ?? '—'}{data.deliveryOnTime.rate !== null ? '%' : ''}</p>
              <p className="text-[10px] text-gray-400">{data.deliveryOnTime.completed}/{data.deliveryOnTime.due} task</p>
            </div>
            <div className={card}>
              <p className={cardLabel}><HourglassSplit size={12} /> Rata-rata focus</p>
              <p className={cardValue}>{data.avgFocusPercent}%</p>
              <p className="text-[10px] text-gray-400">Target ≥40%</p>
            </div>
            <div className={card}>
              <p className={cardLabel}><ClockHistory size={12} /> Scheduling saved</p>
              <p className={cardValue}>{data.schedulingSaved.hours}j</p>
              <p className="text-[10px] text-gray-400">{data.schedulingSaved.connections} meeting spontan</p>
            </div>
            <div className={card}>
              <p className={cardLabel}><CurrencyExchange size={12} /> ROI estimasi</p>
              {data.roi ? (
                <>
                  <p className={cardValue}>{data.roi.roiPercent}%</p>
                  <p className="text-[10px] text-gray-400">Nilai bersih {fmtIdr(data.roi.netValueIdr)}</p>
                </>
              ) : (
                <p className="text-xs text-amber-600 dark:text-amber-400">Perlu diisi biaya platform & tarif/jam di Kebijakan</p>
              )}
            </div>
          </div>

          <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mb-2">Heatmap kehadiran</p>
          <div className="overflow-x-auto mb-4">
            <table className="border-separate" style={{ borderSpacing: 2 }}>
              <thead>
                <tr>
                  <th className="w-8" />
                  {Array.from({ length: 24 }, (_, h) => (
                    <th key={h} className="text-[8px] font-normal text-gray-400 w-4">{h % 3 === 0 ? h : ''}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.heatmap.map((row) => (
                  <tr key={row.weekday}>
                    <td className="text-[10px] text-gray-400 pr-1">{WEEKDAY_LABELS[row.weekday - 1]}</td>
                    {row.hours.map((m, h) => (
                      <td key={h} title={`${WEEKDAY_LABELS[row.weekday - 1]} ${h}:00 — ${m} menit`}>
                        <div className="w-4 h-4 rounded-sm" style={{ background: heatColor(m, maxHeat) }} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <div>
              <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mb-2">Utilization per departemen</p>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={deptData} layout="vertical" margin={{ left: 8 }}>
                    <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10 }} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={90} />
                    <Tooltip formatter={(v) => `${v}%`} />
                    <Bar dataKey="utilization" fill="#7c3aed" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mb-2">Tren delivery on-time (4 periode)</p>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
                    <Tooltip formatter={(v) => `${v}%`} />
                    <Line type="monotone" dataKey="rate" stroke="#7c3aed" strokeWidth={2} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <RankingBoard scope="company" period={period} />
        </>
      )}
    </div>
  );
}
