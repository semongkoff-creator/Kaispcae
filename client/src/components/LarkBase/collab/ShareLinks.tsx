import { useEffect, useState } from 'react';
import { Link45deg, Trash, Clipboard, Check2 } from 'react-bootstrap-icons';
import { BaseRole, BASE_ROLE_LABELS, can } from '@virtualmeet/shared';
import { useServerBase } from '../serverStore';
import { baseApi, ShareLinkDto } from '../api';

const LINK_ROLES: BaseRole[] = ['viewer', 'commenter', 'editor'];

// Public share-link management (inside SharePanel). Each link points at ONE
// view; optional expiry + password + allow-copy. Owner/editor only.
export function ShareLinks() {
  const baseId = useServerBase((s) => s.baseId);
  const myRole = useServerBase((s) => s.myRole);
  const tables = useServerBase((s) => s.tables);
  const canShare = can('share:create', { role: myRole ?? undefined });

  const viewOptions = tables.flatMap((t) => t.views.map((v) => ({ viewId: v.id, label: `${t.name} · ${v.name}` })));
  const [links, setLinks] = useState<ShareLinkDto[]>([]);
  const [viewId, setViewId] = useState(viewOptions[0]?.viewId ?? '');
  const [role, setRole] = useState<BaseRole>('viewer');
  const [expires, setExpires] = useState('');
  const [password, setPassword] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => baseApi.listShareLinks(baseId).then((r) => setLinks(r.links)).catch(() => {});
  useEffect(() => { if (canShare) load(); /* eslint-disable-line */ }, [baseId]);

  if (!canShare) return null;

  const shareUrl = (token: string) => `${window.location.origin}${window.location.pathname}?share=${token}`;
  const create = async () => {
    setErr(null);
    try {
      await baseApi.createShareLink(baseId, { viewId, role, expiresAt: expires ? new Date(expires + 'T23:59:59').getTime() : undefined, password: password || undefined });
      setPassword(''); setExpires(''); load();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Gagal membuat link'); }
  };
  const revoke = async (token: string) => { if (!window.confirm('Cabut link ini?')) return; await baseApi.revokeShareLink(token).catch(() => {}); load(); };
  const copy = (token: string) => { navigator.clipboard.writeText(shareUrl(token)).then(() => { setCopied(token); setTimeout(() => setCopied(null), 1500); }).catch(() => {}); };
  const viewLabel = (id: string) => viewOptions.find((v) => v.viewId === id)?.label ?? id;

  return (
    <div className="p-4 border-t border-gray-100 dark:border-gray-700">
      <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold mb-2 flex items-center gap-1"><Link45deg size={13} /> Link berbagi</p>

      <div className="space-y-2 bg-gray-50 dark:bg-gray-800/60 rounded-lg p-2 mb-3">
        <div className="flex gap-2">
          <select value={viewId} onChange={(e) => setViewId(e.target.value)} aria-label="View" className="flex-1 min-w-0 text-xs bg-white dark:bg-gray-700 rounded px-2 py-1.5 outline-none">
            {viewOptions.map((v) => <option key={v.viewId} value={v.viewId}>{v.label}</option>)}
          </select>
          <select value={role} onChange={(e) => setRole(e.target.value as BaseRole)} aria-label="Peran link" className="text-xs bg-white dark:bg-gray-700 rounded px-2 py-1.5 outline-none">
            {LINK_ROLES.map((r) => <option key={r} value={r}>{BASE_ROLE_LABELS[r]}</option>)}
          </select>
        </div>
        <div className="flex gap-2">
          <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} title="Kedaluwarsa (opsional)" className="flex-1 min-w-0 text-xs bg-white dark:bg-gray-700 rounded px-2 py-1.5 outline-none" />
          <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (opsional)" className="flex-1 min-w-0 text-xs bg-white dark:bg-gray-700 rounded px-2 py-1.5 outline-none" />
        </div>
        <button onClick={create} disabled={!viewId} className="w-full text-xs bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white py-1.5 rounded-lg cursor-pointer">Buat link</button>
        {err && <p className="text-[11px] text-red-500">{err}</p>}
      </div>

      <div className="space-y-1.5">
        {links.length === 0 && <p className="text-xs text-gray-400">Belum ada link.</p>}
        {links.map((l) => (
          <div key={l.token} className="flex items-center gap-2 text-xs bg-white dark:bg-gray-800 rounded-lg border border-gray-100 dark:border-gray-700 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="text-gray-700 dark:text-gray-200 truncate">{viewLabel(l.viewId)} · {BASE_ROLE_LABELS[l.role]}</p>
              <p className="text-[10px] text-gray-400">
                {l.hasPassword ? '🔒 ' : ''}{l.expiresAt ? `sampai ${new Date(l.expiresAt).toLocaleDateString('id-ID')}` : 'tanpa kedaluwarsa'}
                {l.lastOpenedAt ? ` · dibuka ${new Date(l.lastOpenedAt).toLocaleDateString('id-ID')}` : ' · belum dibuka'}
              </p>
            </div>
            <button onClick={() => copy(l.token)} title="Salin URL" aria-label="Salin URL" className="text-gray-400 hover:text-purple-600 cursor-pointer shrink-0">{copied === l.token ? <Check2 size={14} className="text-green-500" /> : <Clipboard size={13} />}</button>
            <button onClick={() => revoke(l.token)} title="Cabut" aria-label="Cabut link" className="text-gray-400 hover:text-red-500 cursor-pointer shrink-0"><Trash size={13} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
