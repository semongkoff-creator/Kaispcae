import { useState, useEffect, useCallback } from 'react';
import { XLg, PersonPlus, Search, Check2 } from 'react-bootstrap-icons';
import { api } from '@/services/api';
import { Avatar } from './chatVisuals';

// Group members, and adding to them — the WhatsApp shape: the people you can
// add are exactly the room's approved members, picked from a list, added in
// one go. There is no invite-by-email here on purpose; getting INTO the room
// is the approval flow's job (see server/src/lib/roomMembership.ts), and this
// only decides who's in which group once they're already in.
export function GroupMembers({
  channelId,
  roomSlug,
  channelName,
  canManage,
  onClose,
}: {
  channelId: string;
  roomSlug: string;
  channelName: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const [participants, setParticipants] = useState<{ id: string; displayName: string; email: string }[]>([]);
  const [members, setMembers] = useState<{ id: string; displayName: string; email: string; role: string }[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([
        api.getChannelParticipants(channelId),
        api.getRoomMembers(roomSlug),
      ]);
      setParticipants(p.participants);
      setMembers(m.members);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, [channelId, roomSlug]);

  useEffect(() => { void load(); }, [load]);

  const inGroup = new Set(participants.map((p) => p.id));
  const q = query.trim().toLowerCase();
  const addable = members
    .filter((m) => !inGroup.has(m.id))
    .filter((m) => !q || m.displayName.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const add = async () => {
    if (picked.size === 0) return;
    setAdding(true);
    try {
      const res = await api.addChannelParticipants(channelId, [...picked]);
      setPicked(new Set());
      await load();
      // Surfaced rather than swallowed — a partial add looks like a bug if the
      // list just quietly comes back shorter than what was ticked.
      if (res.rejected.length > 0) setError(`${res.rejected.length} orang dilewati (belum jadi anggota room).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menambah');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="absolute inset-y-0 right-0 w-80 bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 flex flex-col z-10">
      <div className="h-14 shrink-0 px-4 flex items-center justify-between border-b border-gray-200 dark:border-gray-700">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold truncate">Anggota grup</h3>
          <p className="text-[11px] text-gray-400 truncate">#{channelName}</p>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <XLg size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && <p className="px-4 py-6 text-xs text-gray-400 text-center">Memuat…</p>}

        {!loading && (
          <>
            <div className="px-4 pt-3 pb-1">
              <p className="text-[11px] uppercase tracking-wide text-gray-400">
                Di grup ini ({participants.length})
              </p>
            </div>
            {participants.length === 0 && (
              <p className="px-4 pb-3 text-xs text-gray-400">Belum ada peserta tercatat.</p>
            )}
            {participants.map((p) => (
              <div key={p.id} className="px-4 py-2 flex items-center gap-2.5">
                <Avatar name={p.displayName} seed={p.id} size={30} />
                <div className="min-w-0">
                  <p className="text-sm truncate">{p.displayName}</p>
                  <p className="text-[11px] text-gray-400 truncate">{p.email}</p>
                </div>
              </div>
            ))}

            {canManage && (
              <>
                <div className="px-4 pt-4 pb-2 border-t border-gray-100 dark:border-gray-800 mt-2">
                  <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-2">Tambah dari anggota room</p>
                  <div className="relative">
                    <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Cari nama"
                      className="w-full pl-7 pr-2 py-1.5 rounded-md bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-xs outline-none focus:border-indigo-400"
                    />
                  </div>
                </div>

                {addable.length === 0 && (
                  <p className="px-4 pb-3 text-xs text-gray-400">
                    {members.length === 0 ? 'Belum ada anggota room.' : 'Semua anggota sudah ada di grup ini.'}
                  </p>
                )}
                {addable.map((m) => {
                  const on = picked.has(m.id);
                  return (
                    <button
                      key={m.id}
                      onClick={() => toggle(m.id)}
                      className={`w-full px-4 py-2 flex items-center gap-2.5 text-left ${
                        on ? 'bg-indigo-50 dark:bg-indigo-950/40' : 'hover:bg-gray-50 dark:hover:bg-gray-800'
                      }`}
                    >
                      <Avatar name={m.displayName} seed={m.id} size={30} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm truncate">{m.displayName}</p>
                        <p className="text-[11px] text-gray-400 truncate">{m.email}</p>
                      </div>
                      <span
                        className={`w-4 h-4 rounded-full border shrink-0 inline-flex items-center justify-center ${
                          on ? 'bg-indigo-500 border-indigo-500 text-white' : 'border-gray-300 dark:border-gray-600'
                        }`}
                      >
                        {on && <Check2 size={10} />}
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </>
        )}
      </div>

      {error && <p className="px-4 py-2 text-[11px] text-amber-600 dark:text-amber-400">{error}</p>}

      {canManage && picked.size > 0 && (
        <div className="p-3 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={add}
            disabled={adding}
            className="w-full inline-flex items-center justify-center gap-1.5 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white text-sm py-2 rounded-lg"
          >
            <PersonPlus size={13} /> {adding ? 'Menambahkan…' : `Tambah ${picked.size} orang`}
          </button>
        </div>
      )}
    </div>
  );
}
