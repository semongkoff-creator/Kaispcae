import { useEffect, useState, useCallback } from 'react';
import { XLg, ShieldLock, Buildings } from 'react-bootstrap-icons';
import { CurrentUser } from '@/hooks/useCurrentUser';
import { operatorApi, OperatorOrganization } from './api';

const dateFmt = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });

// Gated here AND on the one request this panel makes (requireOperator,
// server/src/lib/operator.ts) — a non-operator who forces their way here
// still gets 403, same posture as AdminConsole's own gate comment.
export function OperatorConsole({ currentUser, onClose }: { currentUser: CurrentUser; onClose: () => void }) {
  const [orgs, setOrgs] = useState<OperatorOrganization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { organizations } = await operatorApi.getOrganizations();
      setOrgs(organizations);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentUser.isOperator) void load();
    else setLoading(false);
  }, [currentUser.isOperator, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!currentUser.isOperator) {
    return (
      <div className="absolute inset-0 z-40 flex items-center justify-center bg-white dark:bg-gray-900 pl-14">
        <div className="text-center max-w-sm px-6">
          <ShieldLock size={32} className="mx-auto text-gray-300 dark:text-gray-600 mb-3" />
          <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">Halaman ini khusus operator deployment</p>
          <button onClick={onClose} className="mt-4 px-3 py-1.5 rounded-lg bg-purple-600 text-white text-xs font-medium cursor-pointer hover:bg-purple-700">
            Kembali
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-white dark:bg-gray-900 overflow-hidden pl-14">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800 shrink-0">
        <div className="flex items-center gap-2">
          <Buildings size={16} className="text-purple-600" />
          <h1 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Semua organisasi</h1>
          {!loading && !error && <span className="text-xs text-gray-400">{orgs.length} org</span>}
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer">
          <XLg size={16} className="text-gray-500" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <p className="text-xs text-gray-400">Memuat organisasi…</p>
        ) : error ? (
          <p className="text-xs text-red-500">{error}</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-400 border-b border-gray-100 dark:border-gray-800">
                <th className="py-2 pr-3 font-medium">Nama</th>
                <th className="py-2 pr-3 font-medium">Anggota</th>
                <th className="py-2 pr-3 font-medium">Admin</th>
                <th className="py-2 pr-3 font-medium">Dibuat</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((org) => (
                <tr key={org.id} className="border-b border-gray-50 dark:border-gray-800/50">
                  <td className="py-2 pr-3 text-gray-800 dark:text-gray-100">{org.name}</td>
                  <td className="py-2 pr-3 text-gray-500">{org.memberCount}</td>
                  <td className="py-2 pr-3 text-gray-500">{org.admins.map((a) => a.displayName).join(', ') || '—'}</td>
                  <td className="py-2 pr-3 text-gray-500">{dateFmt.format(new Date(org.createdAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
