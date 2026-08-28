import { useEffect, useMemo, useRef, useState } from 'react';
import { X, ChevronDown, Search, ArrowRight, MicMuteFill } from 'react-bootstrap-icons';
import { roleAtLeast } from '@virtualmeet/shared';
import { api, ApiError } from '@/services/api';
import { useGameStore } from '@/stores/gameStore';
import { MANUAL_STATUSES, ManualStatus, PRESENCE_LABEL, PRESENCE_EMOJI } from '@/data/presence';
import { ParticipantActionsMenu } from '@/components/ParticipantActionsMenu';

interface MemberListPanelProps {
  localUserId: string;
  currentRoomSlug: string;
  emitRosterListRequest: () => void;
  onClose: () => void;
  manualStatus: ManualStatus;
  onPickPresence: (status: ManualStatus) => void;
  hasMySeat: boolean;
  onMySeat: () => void;
  // Same handler set ParticipantPanel already receives from the parent —
  // threaded through here too so this list's ⋮ menu fires the identical
  // actions. isGuest gates Summon/Slap the same way it does there.
  isGuest?: boolean;
  emitFollowRequest: (targetUserId: string) => void;
  emitFollowUnfollow: () => void;
  emitSummonUser: (nickname: string) => void;
  emitSlap: (nickname: string) => void;
  onStartDm?: (targetUserId: string) => void;
  onReport?: (targetUserId: string, name: string) => void;
  emitKick?: (targetUserId: string) => void;
  emitForceMute?: (targetUserId: string) => void;
  emitForcePull?: (targetUserId: string) => void;
  emitSpotlight?: (targetUserId: string, active: boolean) => void;
}

export function MemberListPanel({
  localUserId,
  currentRoomSlug,
  emitRosterListRequest,
  onClose,
  manualStatus,
  onPickPresence,
  hasMySeat,
  onMySeat,
  isGuest,
  emitFollowRequest,
  emitFollowUnfollow,
  emitSummonUser,
  emitSlap,
  onStartDm,
  onReport,
  emitKick,
  emitForceMute,
  emitForcePull,
  emitSpotlight,
}: MemberListPanelProps) {
  const [people, setPeople] = useState<{ id: string; displayName: string }[] | null>(null);
  const [error, setError] = useState('');
  const roster = useGameStore((s) => s.roster);
  const followInfo = useGameStore((s) => s.followInfo);
  const mutedUserIds = useGameStore((s) => s.mutedUserIds);
  const muteUser = useGameStore((s) => s.muteUser);
  const unmuteUser = useGameStore((s) => s.unmuteUser);
  const localRole = useGameStore((s) => s.localRole);
  const [statusPickerOpen, setStatusPickerOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');

  // Same admin+ gates as ParticipantPanel — Kick/ForceMute/ForcePull/
  // Spotlight only render for admin+ viewers, everyone else never sees
  // the option exist (props stay undefined rather than disabled).
  const canKick = roleAtLeast(localRole, 'admin');
  const canForceMute = roleAtLeast(localRole, 'admin');
  const canForcePull = roleAtLeast(localRole, 'admin');
  const canSpotlight = roleAtLeast(localRole, 'admin');

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
  const onlineRows = filteredRows.filter((r) => r.presence);
  const offlineRows = filteredRows.filter((r) => !r.presence);
  const orgLabel = currentRoomSlug.charAt(0).toUpperCase() + currentRoomSlug.slice(1);
  const [onlineOpen, setOnlineOpen] = useState(true);
  const [offlineOpen, setOfflineOpen] = useState(true);

  return (
    <div className="fixed inset-0 z-[100]" onMouseDown={onClose}>
      <div
        className="fixed top-0 left-12 bottom-0 w-80 bg-white dark:bg-gray-800 shadow-2xl shadow-purple-100/50 dark:shadow-black/30 border-r border-purple-100 dark:border-gray-700 flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-4 shrink-0">
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Employee List</h2>
          <button onClick={onClose} title="Tutup" className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 cursor-pointer">
            <X size={18} />
          </button>
        </div>

        <div className="flex items-center gap-2 px-5 pb-4 shrink-0">
          <span className="text-sm text-gray-500 dark:text-gray-400">Status</span>
          <div className="relative" ref={statusRef}>
            <button
              onClick={() => setStatusPickerOpen((v) => !v)}
              className="flex items-center gap-1.5 bg-indigo-900 dark:bg-indigo-800 text-white text-xs font-medium pl-3 pr-2 py-1.5 rounded-full cursor-pointer"
            >
              <span className="text-sm leading-none">{manualStatus === 'available' ? '🟢' : PRESENCE_EMOJI[manualStatus]}</span>
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
                      manualStatus === s ? 'bg-indigo-600 text-white' : 'text-gray-700 dark:text-gray-200 hover:bg-indigo-50 dark:hover:bg-gray-700'
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
              className="flex items-center gap-1 bg-indigo-100 dark:bg-gray-700 text-indigo-600 dark:text-indigo-300 text-xs font-medium pl-3 pr-2.5 py-1.5 rounded-full cursor-pointer"
            >
              My Seat
              <ArrowRight size={11} />
            </button>
          )}
        </div>

        <div className="px-5 pb-5 shrink-0">
          <div className="relative">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search Member"
              className="w-full pl-3 pr-9 py-2 text-sm rounded-lg border border-login-border-soft dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 outline-none focus:border-indigo-500"
            />
            <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
          </div>
        </div>

        {error && <p className="px-5 text-xs text-red-500 mb-2">{error}</p>}

        {people && (
          <p className="px-5 pb-2 text-sm font-semibold text-gray-900 dark:text-gray-100 shrink-0">
            {orgLabel} {onlineCount}/{people.length}
          </p>
        )}

        <div className="overflow-y-auto px-5 pb-5 flex-1">
          {people === null && !error && (
            <p className="px-2 py-4 text-sm text-gray-400 dark:text-gray-500 text-center">Memuat daftar member…</p>
          )}
          {people && filteredRows.length === 0 && (
            <p className="px-2 py-4 text-sm text-gray-400 dark:text-gray-500 text-center">Tidak ada member yang cocok.</p>
          )}

          {onlineRows.length > 0 && (
            <>
              <button
                onClick={() => setOnlineOpen((v) => !v)}
                className="w-full flex items-center justify-between pt-1 pb-1 cursor-pointer"
              >
                <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Online — {onlineRows.length}</span>
                <ChevronDown size={12} className={`text-gray-400 dark:text-gray-500 transition-transform ${onlineOpen ? '' : '-rotate-90'}`} />
              </button>
              {onlineOpen && onlineRows.map((r) => {
                // presence.manualStatus / presence.micMuted / presence.spotlightActive
                // are the fields this row needs from gameStore.roster — same
                // assumption flagged before. Rendered defensively: whatever's
                // missing just doesn't show, rather than crashing.
                const status = (r.presence as any)?.manualStatus as ManualStatus | undefined;
                const micMuted = (r.presence as any)?.micMuted as boolean | undefined;
                const spotlightActive = (r.presence as any)?.spotlightActive as boolean | undefined;
                const isFollowingThem = followInfo?.targetUserId === r.id;
                const isMuted = mutedUserIds.has(r.id);
                const isLocal = r.id === localUserId;

                return (
                  <div key={r.id} className="flex items-center justify-between gap-3 py-2">
                    <p className="text-sm text-gray-900 dark:text-gray-100 truncate">
                      {r.displayName}{isLocal ? ' (kamu)' : ''}
                    </p>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {status && (
                        <span className="flex items-center gap-1 text-xs font-bold text-indigo-600 dark:text-indigo-300">
                          <span className="text-sm leading-none">{status === 'available' ? '🟢' : PRESENCE_EMOJI[status]}</span>
                          {PRESENCE_LABEL[status]}
                        </span>
                      )}
                      {micMuted && <MicMuteFill size={13} className="text-red-500" title="Mic mati" />}
                      {!isLocal && (
                        <ParticipantActionsMenu
                          name={r.displayName}
                          isFollowingThem={isFollowingThem}
                          isMuted={isMuted}
                          spotlightActive={spotlightActive}
                          onFollow={() => emitFollowRequest(r.id)}
                          onSummon={isGuest ? undefined : () => emitSummonUser(r.displayName)}
                          onSlap={isGuest ? undefined : () => emitSlap(r.displayName)}
                          onToggleMute={() => (isMuted ? unmuteUser(r.id) : muteUser(r.id))}
                          onMessage={onStartDm ? () => onStartDm(r.id) : undefined}
                          onReport={isGuest || !onReport ? undefined : () => onReport(r.id, r.displayName)}
                          onKick={canKick && emitKick ? () => emitKick(r.id) : undefined}
                          onForceMute={canForceMute && emitForceMute && !micMuted ? () => emitForceMute(r.id) : undefined}
                          onForcePull={canForcePull && emitForcePull ? () => emitForcePull(r.id) : undefined}
                          onSpotlight={canSpotlight && emitSpotlight ? () => emitSpotlight(r.id, !spotlightActive) : undefined}
                        />
                      )}
                      {isLocal && <span className="text-gray-400 dark:text-gray-500 text-[10px]">Kamu</span>}
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {offlineRows.length > 0 && (
            <>
              <button
                onClick={() => setOfflineOpen((v) => !v)}
                className="w-full flex items-center justify-between pt-3 pb-1 cursor-pointer"
              >
                <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Offline — {offlineRows.length}</span>
                <ChevronDown size={12} className={`text-gray-400 dark:text-gray-500 transition-transform ${offlineOpen ? '' : '-rotate-90'}`} />
              </button>
              {offlineOpen && offlineRows.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 py-2">
                  <p className="text-sm text-gray-900 dark:text-gray-100 truncate">{r.displayName}</p>
                  <p className="text-xs shrink-0 text-gray-400 dark:text-gray-500">Offline</p>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}