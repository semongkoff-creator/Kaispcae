import { useEffect, useState } from 'react';
import { X, CircleFill } from 'react-bootstrap-icons';
import { api, ApiError } from '@/services/api';
import { useGameStore } from '@/stores/gameStore';
import { Avatar } from '@/components/Messenger/chatVisuals';

interface MemberListPanelProps {
  localUserId: string;
  currentRoomSlug: string;
  emitRosterListRequest: () => void;
  onClose: () => void;
}

// QA (Presence checklist item #8, "Member list akurat") — the full workspace
// roster (api.getWorkspacePeople, any authenticated user), cross-referenced
// against the live online/room registry in gameStore.roster (populated by
// useSocket's ROSTER_SNAPSHOT/ROSTER_UPDATED listeners). Unlike
// ParticipantPanel (only people standing in THIS room), this spans every
// room in the workspace — that's the "lokasi ruang" half of the checklist
// item. A guest never opens this (see Sidebar's isGuest gate) — guests have
// no User row, so they can't appear in api.getWorkspacePeople() either.
export function MemberListPanel({ localUserId, currentRoomSlug, emitRosterListRequest, onClose }: MemberListPanelProps) {
  const [people, setPeople] = useState<{ id: string; displayName: string }[] | null>(null);
  const [error, setError] = useState('');
  const roster = useGameStore((s) => s.roster);

  useEffect(() => {
    emitRosterListRequest();
    api.getWorkspacePeople()
      .then((res) => setPeople(res.people))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Gagal memuat daftar member'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = (people ?? [])
    .map((p) => ({ ...p, presence: roster[p.id] }))
    .sort((a, b) => {
      // Online first, then this room's own members, then alphabetical.
      if (!!a.presence !== !!b.presence) return a.presence ? -1 : 1;
      const aHere = a.presence?.roomSlug === currentRoomSlug ? 0 : 1;
      const bHere = b.presence?.roomSlug === currentRoomSlug ? 0 : 1;
      if (aHere !== bHere) return aHere - bHere;
      return a.displayName.localeCompare(b.displayName);
    });
  const onlineCount = rows.filter((r) => r.presence).length;
  // The local user is included in their own ROSTER_SNAPSHOT/_UPDATED entries
  // (server records every non-guest join, not just other people's), so this
  // is the same live data other rows use — not a special case.
  const myPresence = roster[localUserId];
  const myRoomName = myPresence?.zoneName ? `${myPresence.roomName} · ${myPresence.zoneName}` : (myPresence?.roomName ?? currentRoomSlug);

  return (
    <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onMouseDown={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 w-full max-w-sm max-h-[80vh] flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0">
          <div>
            <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Member</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">{people ? `${onlineCount} online dari ${people.length}` : 'Memuat…'}</p>
            {/* Bug report follow-up — makes it obvious at a glance whether
                "(room kamu)" tags below are plausible: if this says the same
                room as everyone else online, that's not the panel failing
                to differentiate, it's genuinely the only populated room. */}
            <p className="text-[10px] text-gray-400 dark:text-gray-500">Kamu di room: {myRoomName}</p>
          </div>
          <button onClick={onClose} title="Tutup" className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 cursor-pointer">
            <X size={18} />
          </button>
        </div>

        {error && <p className="px-5 text-xs text-red-500 mb-2">{error}</p>}

        <div className="overflow-y-auto px-2 pb-3 flex-1">
          {people === null && !error && (
            <p className="px-3 py-4 text-sm text-gray-400 dark:text-gray-500 text-center">Memuat daftar member…</p>
          )}
          {rows.map((r) => {
            const online = !!r.presence;
            const here = r.presence?.roomSlug === currentRoomSlug;
            return (
              <div key={r.id} className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-purple-50 dark:hover:bg-gray-700">
                <div className="relative shrink-0">
                  <Avatar name={r.displayName} seed={r.id} size={36} />
                  <CircleFill
                    size={9}
                    className={`absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-white dark:ring-gray-800 ${online ? 'text-green-500' : 'text-gray-300 dark:text-gray-600'}`}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-900 dark:text-gray-100 truncate">
                    {r.displayName}{r.id === localUserId ? ' (kamu)' : ''}
                  </p>
                  {/* Bug fix — this used to collapse to a plain "Di sini" for
                      anyone sharing your room, which told you THAT they were
                      nearby but never named the room itself — exactly the
                      "lokasi ruang ga ketauan dimana" the checklist item
                      ("lokasi ruang real-time") asks for. Always show the
                      actual room name now; "(room kamu)" only adds the
                      "that's where you are too" context on top of it. */}
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                    {online
                      ? `${r.presence!.roomName}${r.presence!.zoneName ? ` · ${r.presence!.zoneName}` : ''}${here ? ' (room kamu)' : ''}`
                      : 'Offline'}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
