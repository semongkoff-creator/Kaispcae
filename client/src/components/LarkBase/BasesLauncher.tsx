import { useEffect, useState } from 'react';
import { XLg, PlusLg, Table as TableIcon, ArrowRight } from 'react-bootstrap-icons';
import { BASE_ROLE_LABELS } from '@virtualmeet/shared';
import { baseApi, BaseSummary } from './api';
import { CurrentUser } from './serverStore';
import LarkBaseApp from './index';

// Standalone "Basis Data" launcher — lists the user's bases (owned + shared),
// creates new ones, and opens one into the full LarkBaseApp. Rendered as an
// in-room overlay (the room rail stays reachable; we offset by pl-14).
export function BasesLauncher({ currentUser, onClose }: { currentUser: CurrentUser; onClose: () => void }) {
  const [bases, setBases] = useState<BaseSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => baseApi.listBases().then((r) => setBases(r.bases)).catch((e) => setError(e instanceof Error ? e.message : 'Gagal memuat'));
  useEffect(() => { load(); }, []);

  const create = async () => {
    setCreating(true); setError(null);
    try { const b = await baseApi.createBase('Basis Data Baru'); setOpenId(b.id); }
    catch (e) { setError(e instanceof Error ? e.message : 'Gagal membuat base'); }
    finally { setCreating(false); }
  };

  if (openId) return <LarkBaseApp baseId={openId} currentUser={currentUser} onClose={() => { setOpenId(null); load(); }} />;

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-gray-50 dark:bg-gray-900 pl-14">
      <div className="flex items-center gap-2 px-6 py-4 border-b border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800">
        <TableIcon size={18} className="text-purple-600" />
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Basis Data</h2>
        <div className="flex-1" />
        <button onClick={onClose} aria-label="Tutup" className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 cursor-pointer"><XLg size={18} /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
            <p className="text-sm text-gray-500 dark:text-gray-400">Basis data kolaboratif ala Lark Base</p>
            <button onClick={create} disabled={creating} className="inline-flex items-center gap-1.5 text-sm font-medium bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white px-3 py-2 rounded-lg cursor-pointer"><PlusLg size={14} /> Base baru</button>
          </div>
          {error && <p className="text-sm text-red-500 mb-3">{error}</p>}
          {bases === null ? (
            <p className="text-sm text-gray-400">Memuat…</p>
          ) : bases.length === 0 ? (
            <div className="text-center py-16 text-gray-400">
              <p className="text-lg mb-1">Belum ada basis data</p>
              <p className="text-sm">Buat yang pertama lewat tombol "Base baru".</p>
            </div>
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
              {bases.map((b) => (
                <button key={b.id} onClick={() => setOpenId(b.id)} className="text-left bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm p-4 hover:border-purple-300 hover:shadow-md transition-all cursor-pointer group focus:ring-2 focus:ring-purple-500 outline-none">
                  <div className="flex items-center justify-between mb-2">
                    <span className="w-9 h-9 rounded-lg bg-purple-100 dark:bg-purple-900/40 text-purple-600 flex items-center justify-center"><TableIcon size={16} /></span>
                    <ArrowRight size={14} className="text-gray-300 group-hover:text-purple-500" />
                  </div>
                  <p className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">{b.name}</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">{BASE_ROLE_LABELS[b.role]}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
