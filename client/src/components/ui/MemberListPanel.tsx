import { useEffect, useRef, useState } from 'react';
import { X, CircleFill, ChevronDown } from 'react-bootstrap-icons';
import { api, ApiError } from '@/services/api';
import { useGameStore } from '@/stores/gameStore';
import { Avatar } from '@/components/Messenger/chatVisuals';
import { MANUAL_STATUSES, ManualStatus, PRESENCE_LABEL, PRESENCE_EMOJI } from '@/data/presence';

interface MemberListPanelProps {
  localUserId: string;
  currentRoomSlug: string;
  emitRosterListRequest: () => void;
  onClose: () => void;
  // Status picker merged into this panel per the reference design ("status
  // sama member jadi satu") — same data/handler App.tsx's own top-left-pill
  // PresenceButton used, that standalone button removed now that this is
  // its one home.
  manualStatus: ManualStatus;
  onPickPresence: (status: ManualStatus) => void;
}

// QA (Presence checklist item #8, "Member list akurat") — the full workspace
// roster (api.getWorkspacePeople, any authenticated user), cross-referenced
// against the live online/room registry in gameStore.roster (populated by
// useSocket's ROSTER_SNAPSHOT/ROSTER_UPDATED listeners). Unlike
// ParticipantPanel (only people standing in THIS room), this spans every
// room in the workspace — that's the "lokasi ruang" half of the checklist
// item. A guest never opens this (see Sidebar's isGuest gate) — guests have
// no User row, so they can't appear in api.getWorkspacePeople() either.
export function MemberListPanel({ localUserId, currentRoomSlug, emitRosterListRequest, onClose, manualStatus, onPickPresence }: MemberListPanelProps) {
  const [people, setPeople] = useState<{ id: string; displayName: string }[] | null>(null);
  const [error, setError] = useState('');
  const roster = useGameStore((s) => s.roster);
  const [statusPickerOpen, setStatusPickerOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!statusPickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (statusRef.current && !statusRef.current.contains(e.target as Node)) setStatusPickerOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [statusPickerOpen]);

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
            <p className="text-[10px] text-gray-400 dark:text-gray-500">Kamu di room: {myRoomName}</p>
          </div>
          <button onClick={onClose} title="Tutup" className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 cursor-pointer">
            <X size={18} />
          </button>
        </div>

        {/* Status picker merged in here per this round's feedback — same
            manualStatus/onPickPresence App.tsx already threads to the
            (now-removed) standalone PresenceButton. */}
        <div className="flex items-center gap-2 px-5 pb-3 shrink-0">
          <span className="text-xs text-gray-500 dark:text-gray-400">Status</span>
          <div className="relative" ref={statusRef}>
            <button
              onClick={() => setStatusPickerOpen((v) => !v)}
              className="flex items-center gap-1.5 bg-login-accent text-white text-xs font-medium pl-3 pr-2 py-1 rounded-full cursor-pointer"
            >
              {PRESENCE_LABEL[manualStatus]}
              <ChevronDown size={11} />
            </button>
            {statusPickerOpen && (
              <div
                className="absolute top-full left-0 mt-1 w-40 bg-white dark:bg-gray-800 rounded-xl border border-purple-100 dark:border-gray-700 shadow-xl p-2 z-10"
                onMouseDown={(e) => e.stopPropagation()}
              >
                {MANUAL_STATUSES.map((s) => (
                  <button
                    key={s}
                    onClick={() => { onPickPresence(s); setStatusPickerOpen(false); }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-left cursor-pointer ${
                      manualStatus === s ? 'bg-purple-600 text-white' : 'text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-700'
                    }`}
                  >
                    <span className="w-4 text-center shrink-0">{s === 'available' ? '🟢' : PRESENCE_EMOJI[s]}</span>
                    {PRESENCE_LABEL[s]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {error && <p className="px-5 text-xs text-red-500 mb-2">{error}</p>}

        <div className="overflow-y-auto px-2 pb-3 flex-1">
          {people === null && !error && (
            <p className="px-3 py-4 text-sm text-gray-400 dark:text-gray-500 text-center">Memuat daftar member…</p>
          )}
          {rows.map((r) => {
            const online = !!r.presence;
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
                  {/* Bug fix follow-up — dropped the "(room kamu)" suffix:
                      it only ever compared roomSlug, so once zones existed it
                      actively lied ("room kamu" on someone in a completely
                      different zone of the same office). Just the real,
                      live room+zone location, same for every row including
                      your own — no separate "that's you too" annotation to
                      go stale. */}
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                    {online
                      ? `Online · ${r.presence!.roomName}${r.presence!.zoneName ? ` · ${r.presence!.zoneName}` : ''}`
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
