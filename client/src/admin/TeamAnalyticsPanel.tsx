import { useCallback, useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import { PeopleFill, HourglassSplit, CameraVideo, CheckCircle, EmojiSmile, Download } from 'react-bootstrap-icons';
import { PeriodPicker, PeriodValue, defaultPeriodValue } from './PeriodPicker';
import { RankingBoard } from './RankingBoard';
import { OfficeActivityFeed } from './OfficeActivityFeed';

const API = '/api';
async function req<T>(path: string): Promise<T> {
  const token = localStorage.getItem('vm_token');
  const res = await fetch(`${API}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `Gagal: ${res.status}`);
  return res.json();
}

interface TeamMember {
  userId: string; name: string; isOnlineNow: boolean;
  jamHadirMinutes: number; overtimeMinutes: number; focusMinutes: number; meetingMinutes: number;
  taskDue: number; taskCompleted: number; vibeScore: number; focusPercent: number;
}
interface LiveMeeting {
  userId: string; name: string; roomSlug: string; roomName: string; startedAt: string; durationMinutes: number;
}
interface TeamResponse {
  period: { type: string; start: string; end: string };
  members: TeamMember[];
  summary: {
    anggotaAktifHariIni: number; totalAnggota: number; avgFocusPercent: number;
    taskOnTimeRate: number | null; anggotaDenganLembur: number; avgMeetingMinutesPerDay: number; vibeTim: number;
  } | null;
  liveMeetings: LiveMeeting[];
}

function fmtMinutes(m: number): string {
  const abs = Math.round(Math.abs(m));
  return `${Math.floor(abs / 60)}j ${abs % 60}m`;
}

const card = 'bg-gray-50 dark:bg-gray-800 rounded-xl p-3';
const cardLabel = 'text-[11px] text-gray-500 dark:text-gray-400 flex items-center gap-1.5 mb-1';
const cardValue = 'text-lg font-semibold text-gray-800 dark:text-gray-100';

// Bagian B.3.2 — Team tier, direct reports of the logged-in manager only
// (server scopes this via User.managerId, same as the existing
// GET /attendance/team — see routes/analytics.ts).
export function TeamAnalyticsPanel() {
  const [period, setPeriod] = useState<PeriodValue>(defaultPeriodValue());
  const [data, setData] = useState<TeamResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const qs = new URLSearchParams({ period: period.period });
      if (period.period === 'custom') { qs.set('from', period.from); qs.set('to', period.to); }
      setData(await req<TeamResponse>(`/analytics/team?${qs}`));
      setError(null);
    } catch (e) { if (!silent) setError(e instanceof Error ? e.message : 'Gagal memuat'); }
    finally { if (!silent) setLoading(false); }
  }, [period]);
  useEffect(() => { void load(); }, [load]);
  // Live Meeting List (v2 B.2 #4) — same "polled, badge lag costs nothing"
  // posture as the app's existing pendingJoinCount polling (App.tsx), not a
  // dedicated socket push, so it stays fresh without new live infra.
  useEffect(() => {
    const iv = setInterval(() => void load(true), 15000);
    return () => clearInterval(iv);
  }, [load]);

  const exportExcel = async () => {
    const token = localStorage.getItem('vm_token');
    const qs = new URLSearchParams({ tier: 'team', period: period.period });
    if (period.period === 'custom') { qs.set('from', period.from); qs.set('to', period.to); }
    const res = await fetch(`${API}/analytics/export?${qs}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) { setError('Gagal mengekspor'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `analitik-team-${DateTime.now().toFormat('yyyyLLdd')}.xlsx`; a.click();
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
      {loading || !data ? <p className="text-xs text-gray-400">Memuat…</p> : !data.summary ? (
        <p className="text-xs text-gray-400">Kamu belum jadi atasan langsung siapa pun di sistem ini.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
            <div className={card}>
              <p className={cardLabel}><PeopleFill size={12} /> Anggota aktif</p>
              <p className={cardValue}>{data.summary.anggotaAktifHariIni}/{data.summary.totalAnggota}</p>
            </div>
            <div className={card}>
              <p className={cardLabel}><HourglassSplit size={12} /> Rata-rata focus</p>
              <p className={cardValue}>{data.summary.avgFocusPercent}%</p>
              <p className="text-[10px] text-gray-400">Sehat 35–50%</p>
            </div>
            <div className={card}>
              <p className={cardLabel}><CheckCircle size={12} /> Task on-time</p>
              <p className={cardValue}>{data.summary.taskOnTimeRate ?? '—'}{data.summary.taskOnTimeRate !== null ? '%' : ''}</p>
            </div>
            <div className={card}>
              <p className={cardLabel}>⏰ Anggota lembur</p>
              <p className={cardValue}>{data.summary.anggotaDenganLembur}</p>
              <p className="text-[10px] text-gray-400">Pantau agar tidak burnout</p>
            </div>
            <div className={card}>
              <p className={cardLabel}><CameraVideo size={12} /> Meeting/hari</p>
              <p className={cardValue}>{fmtMinutes(data.summary.avgMeetingMinutesPerDay)}</p>
            </div>
            <div className={card}>
              <p className={cardLabel}><EmojiSmile size={12} /> Vibe tim</p>
              <p className={cardValue}>{data.summary.vibeTim.toFixed(1)}/10</p>
            </div>
          </div>

          <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mb-1 flex items-center gap-1.5">
            <CameraVideo size={12} /> Sedang meeting sekarang
            {data.liveMeetings.length > 0 && <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />}
          </p>
          {data.liveMeetings.length === 0 ? (
            <p className="text-xs text-gray-400 mb-3">Tidak ada anggota yang sedang meeting.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
              {data.liveMeetings.map((m) => (
                <div key={m.userId} className="bg-green-50 dark:bg-green-900/20 rounded-lg px-2.5 py-1.5 flex items-center justify-between text-xs">
                  <span className="text-gray-700 dark:text-gray-200 font-medium">{m.name}</span>
                  <span className="text-gray-500 dark:text-gray-400">{m.roomName} · {m.durationMinutes}m</span>
                </div>
              ))}
            </div>
          )}

          <div className="mb-3"><OfficeActivityFeed /></div>

          <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mb-1">Roster anggota</p>
          <div className="overflow-x-auto mb-3">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-100 dark:border-gray-700">
                  <th className="py-2 pr-3 font-medium">Nama</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Jam hadir</th>
                  <th className="py-2 pr-3 font-medium">Focus</th>
                  <th className="py-2 pr-3 font-medium">Meeting</th>
                  <th className="py-2 pr-3 font-medium">Task</th>
                  <th className="py-2 font-medium">Vibe</th>
                </tr>
              </thead>
              <tbody>
                {data.members.map((m) => (
                  <tr key={m.userId} className="border-b border-gray-50 dark:border-gray-800">
                    <td className="py-1.5 pr-3 text-gray-800 dark:text-gray-100 font-medium">{m.name}</td>
                    <td className="py-1.5 pr-3">
                      <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ${m.isOnlineNow ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300' : 'bg-gray-100 dark:bg-gray-700 text-gray-500'}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${m.isOnlineNow ? 'bg-green-500' : 'bg-gray-400'}`} />
                        {m.isOnlineNow ? 'Online' : 'Offline'}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-300">{fmtMinutes(m.jamHadirMinutes)}</td>
                    <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-300">{m.focusPercent}%</td>
                    <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-300">{fmtMinutes(m.meetingMinutes)}</td>
                    <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-300">{m.taskCompleted}/{m.taskDue}</td>
                    <td className="py-1.5 text-gray-600 dark:text-gray-300">{m.vibeScore.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-gray-400 italic mb-4">
            Ini bukan ranking hukuman. "Focus rendah + meeting tinggi" sering berarti orang itu tumpuan koordinasi. Pakai untuk bantu tim, bukan menghakimi.
          </p>

          <RankingBoard scope="team" period={period} />
        </>
      )}
    </div>
  );
}
