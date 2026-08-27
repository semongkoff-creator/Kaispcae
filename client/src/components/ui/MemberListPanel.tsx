import { useEffect, useMemo, useRef, useState } from 'react';
import { X, ChevronDown, Search } from 'react-bootstrap-icons';
import { api, ApiError } from '@/services/api';
import { useGameStore } from '@/stores/gameStore';
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
  // "My Seat" quick action shown next to the Status pill — reference
  // design's row has two buttons, not one. Same hasMySeat/onMySeat App.tsx
  // already has for its own top-left-pill button; this is a second entry
  // point to the identical action, not a new feature.
  hasMySeat: boolean;
  onMySeat: () => void;
}

// QA (Presence checklist item #8, "Member list akurat") — the full workspace
// roster (api.getWorkspacePeople, any authenticated user), cross-referenced
// against the live online/room registry in gameStore.roster (populated by
// useSocket's ROSTER_SNAPSHOT/ROSTER_UPDATED listeners). Unlike
// ParticipantPanel (only people standing in THIS room), this spans every
// room in the workspace — that's the "lokasi ruang" half of the checklist
// item. A guest never opens this (see Sidebar's isGuest gate) — guests have
// no User row, so they can't appear in api.getWorkspacePeople() either.
export function MemberListPanel({ localUserId, currentRoomSlug, emitRosterListRequest, onClose, manualStatus, onPickPresence, hasMySeat, onMySeat }: MemberListPanelProps) {
  const [people, setPeople] = useState<{ id: string; displayName: string }[] | null>(null);
  const [error, setError] = useState('');
  const roster = useGameStore((s) => s.roster);
  const [statusPickerOpen, setStatusPickerOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');

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
  const filteredRows = useMemo(
    () => (search.trim() ? rows.filter((r) => r.displayName.toLowerCase().includes(search.trim().toLowerCase())) : rows),
    [rows, search],
  );
  // Reference design's "Kaitech 10/20" section label — org name + online
  // count, same capitalization App.tsx's Room Features header uses for its
  // own roomDisplayName (no separate configured display-name field exists).
  const orgLabel = currentRoomSlug.charAt(0).toUpperCase() + currentRoomSlug.slice(1);

  return (
    <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onMouseDown={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 w-full max-w-sm max-h-[80vh] flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0">
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Employee List</h2>
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
          {hasMySeat && (
            <button
              onClick={onMySeat}
              title="Ke Kursi Saya"
              className="flex items-center gap-1 bg-login-surface dark:bg-gray-700 text-login-accent dark:text-purple-300 text-xs font-medium px-2 py-1 rounded-full cursor-pointer"
            >
              <img src="/assets/img/icons/back_to_seat.svg" width={12} height={12} alt="" />
              My Seat
            </button>
          )}
        </div>

        {/* Search — reference design shows a search bar between Status and
            the member list. Pure client-side filter over the already-
            fetched roster (no new endpoint needed). */}
        <div className="px-5 pb-3 shrink-0">
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search Member"
              className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-login-border-soft dark:border-gray-700 bg-login-surface dark:bg-gray-900 text-gray-900 dark:text-gray-100 outline-none focus:border-login-accent"
            />
          </div>
        </div>

        {error && <p className="px-5 text-xs text-red-500 mb-2">{error}</p>}

        {/* "Kaitech 10/20" — org name + online/total, reference design's own
            section label right above the list. */}
        {people && (
          <p className="px-5 pb-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 shrink-0">
            {orgLabel} {onlineCount}/{people.length}
          </p>
        )}

        <div className="overflow-y-auto px-3 pb-3 flex-1">
          {people === null && !error && (
            <p className="px-2 py-4 text-sm text-gray-400 dark:text-gray-500 text-center">Memuat daftar member…</p>
          )}
          {people && filteredRows.length === 0 && (
            <p className="px-2 py-4 text-sm text-gray-400 dark:text-gray-500 text-center">Tidak ada member yang cocok.</p>
          )}
          {filteredRows.map((r) => {
            const online = !!r.presence;
            return (
              <div key={r.id} className="flex items-center justify-between gap-3 px-2 py-2">
                <p className="text-sm text-gray-900 dark:text-gray-100 truncate">
                  {r.displayName}{r.id === localUserId ? ' (kamu)' : ''}
                </p>
                <p className={`text-xs shrink-0 ${online ? 'text-green-600 dark:text-green-400' : 'text-gray-400 dark:text-gray-500'}`}>
                  {online ? 'Online' : 'Offline'}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
