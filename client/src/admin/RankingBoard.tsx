import { useCallback, useEffect, useState } from 'react';
import { PeriodValue } from './PeriodPicker';

const API = '/api';
async function req<T>(path: string): Promise<T> {
  const token = localStorage.getItem('vm_token');
  const res = await fetch(`${API}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `Gagal: ${res.status}`);
  return res.json();
}

interface RankingCategory {
  kategori: string; arah: 'tinggi_baik' | 'rendah_baik';
  top: { rank: number; user: string; userId: string; nilai: string }[];
  worst: { user: string; userId: string; nilai: string; konteks: string | null } | null;
  excluded: { user: string; userId: string; alasan: string }[];
}
interface RankingResponse {
  period: { type: string; start: string; end: string };
  scope: 'team' | 'company';
  categories: RankingCategory[];
}

const MEDAL = ['🥇', '🥈', '🥉'];

// Bagian C — Task 2, embedded inside Team/All-Kaitech (not a separate top-
// level tab — the brief lists "papan achievement" as one section WITHIN
// each of those tiers, see B.3.2/B.3.3). Never mounted anywhere reachable
// from the Individual tier — C.1's "the worst is never shown publicly/at
// Individual tier" holds because this component simply isn't rendered
// there, backed by the endpoint itself having no individual scope at all.
export function RankingBoard({ scope, period }: { scope: 'team' | 'company'; period: PeriodValue }) {
  const [data, setData] = useState<RankingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ period: period.period, scope });
      if (period.period === 'custom') { qs.set('from', period.from); qs.set('to', period.to); }
      setData(await req<RankingResponse>(`/analytics/ranking?${qs}`));
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Gagal memuat'); }
    finally { setLoading(false); }
  }, [period, scope]);
  useEffect(() => { void load(); }, [load]);

  if (loading || !data) return <p className="text-xs text-gray-400">Memuat ranking…</p>;
  if (error) return <p className="text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-2 py-1.5">{error}</p>;
  if (!data.categories.length) return <p className="text-xs text-gray-400">Belum ada anggota untuk diranking.</p>;

  return (
    <div>
      <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mb-1">🏆 Papan Achievement</p>
      <p className="text-[11px] text-gray-400 mb-3">
        Top dirayakan. "Terendah" cuma sinyal bantu untuk {scope === 'team' ? 'kamu' : 'admin'} — bukan hukuman, sering ada konteks di baliknya.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {data.categories.map((cat) => (
          <div key={cat.kategori} className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
            <p className="text-xs font-semibold text-gray-800 dark:text-gray-100 mb-2">{cat.kategori}</p>
            {cat.top.length ? (
              <ul className="space-y-1 mb-2">
                {cat.top.map((t) => (
                  <li key={t.userId} className="flex items-center gap-1.5 text-xs">
                    <span>{MEDAL[t.rank - 1] ?? `#${t.rank}`}</span>
                    <span className="text-gray-700 dark:text-gray-200 flex-1 truncate">{t.user}</span>
                    <span className="text-gray-400">{t.nilai}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] text-gray-400 mb-2">Belum cukup data.</p>
            )}
            {cat.worst && (
              <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700">
                <p className="text-[10px] text-gray-400 flex items-center justify-between">
                  <span>Terendah: <span className="text-gray-500 dark:text-gray-300">{cat.worst.user}</span> ({cat.worst.nilai})</span>
                </p>
                {cat.worst.konteks && <p className="text-[10px] text-amber-600 dark:text-amber-400 italic">Konteks: {cat.worst.konteks}</p>}
              </div>
            )}
            {cat.excluded.length > 0 && (
              <p className="text-[10px] text-gray-300 dark:text-gray-600 mt-1">{cat.excluded.length} orang data tidak cukup, dikecualikan.</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
