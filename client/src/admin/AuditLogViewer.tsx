import { useEffect, useState, useCallback } from 'react';
import { adminApi, AuditEntry, AdminMember, AuditFilter } from './api';

const timeFmt = new Intl.DateTimeFormat('id-ID', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

// Render { before, after } as "lama → baru" per changed key. This is the whole
// point of the log: an admin action must be legible without reading JSON.
function DiffLines({ meta }: { meta: Record<string, unknown> | null }) {
  if (!meta) return null;
  const before = meta.before as Record<string, unknown> | undefined;
  const after = meta.after as Record<string, unknown> | undefined;
  if (!before && !after) {
    return <span className="text-gray-400">{JSON.stringify(meta)}</span>;
  }
  const keys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]));
  return (
    <span className="space-y-0.5">
      {keys.map((k) => (
        <span key={k} className="block">
          <span className="text-gray-400">{k}: </span>
          <span className="line-through text-gray-400">{JSON.stringify(before?.[k]) ?? '—'}</span>
          <span className="text-gray-400"> → </span>
          <span className="text-gray-700 dark:text-gray-200 font-medium">{JSON.stringify(after?.[k]) ?? '—'}</span>
        </span>
      ))}
    </span>
  );
}

export function AuditLogViewer() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [filter, setFilter] = useState<AuditFilter>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (f: AuditFilter) => {
    setLoading(true);
    try {
      const r = await adminApi.getAudit(f);
      setEntries(r.entries);
      setActions(r.actions);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(filter); }, [filter, load]);
  useEffect(() => { adminApi.getMembers().then((r) => setMembers(r.members)).catch(() => { /* filter list is optional */ }); }, []);

  const set = (patch: Partial<AuditFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const sel = 'bg-gray-50 dark:bg-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-800 dark:text-gray-100 outline-none cursor-pointer';

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Audit log</h2>
        <span className="text-xs text-gray-400">{entries.length} entri</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select value={filter.actorId ?? ''} onChange={(e) => set({ actorId: e.target.value || undefined })} aria-label="Filter pelaku" className={sel}>
          <option value="">Semua pelaku</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
        </select>
        <select value={filter.targetUserId ?? ''} onChange={(e) => set({ targetUserId: e.target.value || undefined })} aria-label="Filter subjek" className={sel}>
          <option value="">Semua subjek</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
        </select>
        <select value={filter.action ?? ''} onChange={(e) => set({ action: e.target.value || undefined })} aria-label="Filter aksi" className={sel}>
          <option value="">Semua aksi</option>
          {actions.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <input type="date" value={filter.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined })} aria-label="Dari tanggal" className={sel} />
        <input type="date" value={filter.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined })} aria-label="Sampai tanggal" className={sel} />
        {Object.keys(filter).length > 0 && (
          <button onClick={() => setFilter({})} className="text-xs text-purple-600 hover:underline cursor-pointer">Bersihkan</button>
        )}
      </div>

      {error && <p className="mb-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-2 py-1.5">{error}</p>}
      {loading ? (
        <p className="text-xs text-gray-400">Memuat…</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-gray-400">Tidak ada entri untuk filter ini.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-400 border-b border-gray-100 dark:border-gray-700">
                <th className="py-2 pr-3 font-medium whitespace-nowrap">Waktu</th>
                <th className="py-2 pr-3 font-medium">Pelaku</th>
                <th className="py-2 pr-3 font-medium">Aksi</th>
                <th className="py-2 pr-3 font-medium">Subjek</th>
                <th className="py-2 pr-3 font-medium">Perubahan</th>
                <th className="py-2 font-medium">Alasan</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-gray-50 dark:border-gray-800 align-top">
                  <td className="py-2 pr-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{timeFmt.format(new Date(e.createdAt))}</td>
                  <td className="py-2 pr-3 text-gray-800 dark:text-gray-100 font-medium whitespace-nowrap">{e.actor.displayName}</td>
                  <td className="py-2 pr-3">
                    <code className="text-[11px] px-1.5 py-0.5 rounded bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300">{e.action}</code>
                    <span className="block text-[11px] text-gray-400 mt-0.5">{e.targetType}</span>
                  </td>
                  <td className="py-2 pr-3 text-gray-600 dark:text-gray-300 whitespace-nowrap">{e.targetUser?.displayName ?? '—'}</td>
                  <td className="py-2 pr-3 text-[11px]"><DiffLines meta={e.meta} /></td>
                  <td className="py-2 text-gray-600 dark:text-gray-300">{e.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-[11px] text-gray-400">
        Log ini hanya bisa ditambah, tidak bisa diubah atau dihapus — tidak ada endpoint untuk itu, dan memang tidak boleh ada.
      </p>
    </div>
  );
}
