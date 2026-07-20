import { useState } from 'react';
import { XLg, PersonPlus, Trash, StarFill } from 'react-bootstrap-icons';
import { BaseRole, BASE_ROLE_LABELS, can } from '@virtualmeet/shared';
import { useServerBase } from '../serverStore';
import { baseApi } from '../api';
import { colorForUser } from './PresenceBar';
import { ShareLinks } from './ShareLinks';

const ASSIGNABLE: BaseRole[] = ['editor', 'commenter', 'viewer'];

export function SharePanel({ onClose }: { onClose: () => void }) {
  const baseId = useServerBase((s) => s.baseId);
  const baseName = useServerBase((s) => s.baseName);
  const myRole = useServerBase((s) => s.myRole);
  const ownerId = useServerBase((s) => s.ownerId);
  const members = useServerBase((s) => s.members);
  const currentUser = useServerBase((s) => s.currentUser);
  const refreshMembers = useServerBase((s) => s.refreshMembers);

  const isOwner = can('base:manageMembers', { role: myRole ?? undefined });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<BaseRole>('editor');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const invite = async () => {
    setErr(null); setBusy(true);
    try { await baseApi.addMember(baseId, email.trim(), role); setEmail(''); await refreshMembers(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Gagal mengundang'); }
    finally { setBusy(false); }
  };
  const changeRole = async (userId: string, r: BaseRole) => { try { await baseApi.updateMember(baseId, userId, r); await refreshMembers(); } catch (e) { setErr(e instanceof Error ? e.message : 'Gagal'); } };
  const remove = async (userId: string) => { if (!window.confirm('Cabut akses anggota ini?')) return; try { await baseApi.removeMember(baseId, userId); await refreshMembers(); } catch (e) { setErr(e instanceof Error ? e.message : 'Gagal'); } };
  const transfer = async (userId: string, name: string) => {
    const typed = window.prompt(`Transfer kepemilikan ke ${name}? Ketik nama base "${baseName}" untuk konfirmasi:`);
    if (typed !== baseName) { if (typed !== null) setErr('Nama base tidak cocok — transfer dibatalkan'); return; }
    try { await baseApi.transfer(baseId, userId); await refreshMembers(); onClose(); window.location.reload(); } catch (e) { setErr(e instanceof Error ? e.message : 'Gagal transfer'); }
  };

  return (
    <div className="fixed inset-0 z-[75] flex justify-end" role="dialog" aria-modal="true" aria-label="Bagikan base">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white dark:bg-gray-900 h-full shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-700 shrink-0">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Bagikan "{baseName}"</h3>
          <button onClick={onClose} aria-label="Tutup" className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 cursor-pointer"><XLg size={18} /></button>
        </div>

        {isOwner && (
          <div className="p-4 border-b border-gray-100 dark:border-gray-700">
            <label className="text-xs text-gray-400 mb-1 block">Undang lewat email</label>
            <div className="flex gap-2">
              <input value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && email.trim()) invite(); }} type="email" placeholder="email@perusahaan.com" className="flex-1 min-w-0 text-sm bg-gray-50 dark:bg-gray-700 rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-purple-500" />
              <select value={role} onChange={(e) => setRole(e.target.value as BaseRole)} aria-label="Peran undangan" className="text-sm bg-gray-50 dark:bg-gray-700 rounded-lg px-2 outline-none cursor-pointer">
                {ASSIGNABLE.map((r) => <option key={r} value={r}>{BASE_ROLE_LABELS[r]}</option>)}
              </select>
              <button onClick={invite} disabled={busy || !email.trim()} className="inline-flex items-center gap-1 bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white text-sm px-3 rounded-lg cursor-pointer"><PersonPlus size={14} /></button>
            </div>
            {err && <p className="text-[11px] text-red-500 mt-1.5">{err}</p>}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2">
          <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold px-2 py-1">Anggota ({members.length})</p>
          {members.map((mem) => {
            const isSelf = mem.userId === currentUser?.id;
            const isTheOwner = mem.userId === ownerId;
            return (
              <div key={mem.userId} className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800">
                <span className={`w-7 h-7 rounded-full ${colorForUser(mem.userId)} text-white text-xs font-bold flex items-center justify-center shrink-0`}>{mem.name.charAt(0).toUpperCase()}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-800 dark:text-gray-100 truncate">{mem.name}{isSelf && <span className="text-gray-400"> (kamu)</span>}</p>
                  {mem.email && <p className="text-[11px] text-gray-400 truncate">{mem.email}</p>}
                </div>
                {isTheOwner ? (
                  <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 font-medium shrink-0"><StarFill size={11} /> {BASE_ROLE_LABELS.owner}</span>
                ) : isOwner ? (
                  <>
                    <select value={mem.role} onChange={(e) => changeRole(mem.userId, e.target.value as BaseRole)} aria-label={`Peran ${mem.name}`} className="text-xs bg-gray-50 dark:bg-gray-700 rounded px-1.5 py-1 outline-none cursor-pointer shrink-0">
                      {ASSIGNABLE.map((r) => <option key={r} value={r}>{BASE_ROLE_LABELS[r]}</option>)}
                    </select>
                    <button onClick={() => transfer(mem.userId, mem.name)} title="Jadikan pemilik (transfer)" aria-label="Transfer kepemilikan" className="text-gray-300 hover:text-amber-500 cursor-pointer shrink-0"><StarFill size={13} /></button>
                    <button onClick={() => remove(mem.userId)} title="Cabut akses" aria-label="Cabut akses" className="text-gray-300 hover:text-red-500 cursor-pointer shrink-0"><Trash size={13} /></button>
                  </>
                ) : (
                  <span className="text-xs text-gray-400 shrink-0">{BASE_ROLE_LABELS[mem.role]}</span>
                )}
              </div>
            );
          })}
        </div>
        <ShareLinks />
      </div>
    </div>
  );
}
