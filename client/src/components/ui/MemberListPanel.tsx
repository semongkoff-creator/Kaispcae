import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CameraVideoFill, PersonWalking, X, MegaphoneFill, MicMuteFill, Search, VolumeMuteFill, ChevronDown, ChevronRight } from 'react-bootstrap-icons';
import { roleAtLeast, Role, WorkMode } from '@kaispace/shared';
import { useGameStore } from '@/stores/gameStore';
import { PRESENCE_LABEL, PRESENCE_EMOJI, PARTICIPANT_GROUP_ORDER, MANUAL_STATUSES, ManualStatus } from '@/data/presence';
import { Tooltip } from '@/components/ui/Tooltip';
import { showConfirm } from '@/stores/modalStore';
import { api, OrgMember } from '@/services/api';
import { formatRelativeTimeId, formatExactDateTimeId } from '@/utils/relativeTime';
import { SignalBars } from '@/components/ui/SignalBars';
import type { PeerQuality } from '@/services/connectionQuality';
import { subscribeConnectionQuality, getPeerQualitySnapshot } from '@/stores/connectionQuality';
import { ParticipantActionsMenu } from '@/components/ParticipantActionsMenu';

interface MemberListPanelProps {
  remoteStreams: Map<string, MediaStream>;
  // specs/2026-08-21-room-scoped-participants-design.md — the room this
  // panel is showing participants FOR. Threaded through to
  // api.getRoomParticipants so the "Offline" section only shows members who
  // have actually been active in THIS room before, not the whole organization.
  roomSlug: string;
  // Local mic state lives in useWebRTC (isMicMuted), not on the local
  // player's own record — the PLAYER_MIC_UPDATED listener deliberately
  // skips writing back to yourself (see useSocket.ts), so it's passed
  // through separately for the local row's badge.
  isMicMuted: boolean;
  // QA (Akses tamu checklist item 2, "Guest terbatas") — hides this
  // VIEWER's ability to use Summon/Slap/Locate (already server-rejected
  // for Summon/Slap; Locate is pure client pathfinding with no server
  // component to gate). Does NOT affect whether others can target a guest
  // with these — only what the guest viewing this panel can do.
  isGuest?: boolean;
  // specs/2026-08-21-room-entry-name-prompt-design.md — final-review fix:
  // the local user's OWN row must show their real account name, not
  // whatever room-entry nametag they're currently using — participant
  // lists are explicitly out of this feature's scope.
  localAccountName: string;
  emitFollowRequest: (targetUserId: string) => void;
  emitFollowUnfollow: () => void;
  emitSummonUser: (nickname: string) => void;
  // A10 — "colek"/slap a participant by name (lightweight attention nudge).
  emitSlap: (nickname: string) => void;
  // Opens (or creates) a persisted 1:1 DM with this account — see
  // useChannelChat.ts's startDm. Undefined for rows with no account id
  // (unreachable today — login is mandatory before joining a room).
  onStartDm?: (targetUserId: string) => void;
  // Item 13, "Panic/report user" — open to every real member (not
  // admin-gated, unlike Kick/Force Mute below): reporting someone's
  // behavior is exactly the tool the person WITHOUT moderation power needs.
  // Undefined only when there's no account id to report against (guest
  // rows) or the viewer is a guest themselves (isGuest gate at the call
  // site, same convention as onSummon/onSlap).
  onReport?: (targetUserId: string, name: string) => void;
  // Temporary removal from the room, admin+ only (see shared/permissions.ts's
  // 'room:kick') — not a ban, the target can rejoin any time.
  emitKick?: (targetUserId: string) => void;
  // QA (Moderasi checklist item 11, "Kick/mute admin") — admin+ only (see
  // shared/permissions.ts's 'room:force_mute'). Distinct from onToggleMute
  // below: that one is a purely LOCAL "mute them for me" listening
  // preference (mutedUserIds); this actually turns the TARGET's own mic
  // off, visible to everyone via the normal PLAYER_MIC_UPDATED badge.
  emitForceMute?: (targetUserId: string) => void;
  // "Tarik Paksa" (Force-pull) — admin+ only (see shared/permissions.ts's
  // 'force_pull'). Unlike Summon (emitSummonUser above, open to everyone,
  // consent-gated), this moves the target immediately with no accept step.
  emitForcePull?: (targetUserId: string) => void;
  // ZEP-style Spotlight — admin+ only (see shared/permissions.ts's
  // 'presence:spotlight'). Reaches everyone in the room regardless of
  // distance/zone/DND once active.
  emitSpotlight?: (targetUserId: string, active: boolean) => void;
  // Bug 12 — open state is now controlled by the parent's single-active-panel
  // coordinator (was local), so opening this closes any other panel and vice
  // versa. onToggle flips it (header click); onClose forces it shut.
  open: boolean;
  onToggle: () => void;
  onClose: () => void;

  // Status picker + "My Seat" — merged in from the old MemberListPanel per
  // "status sama member jadi satu" (this panel is now the one destination
  // both Status and Member/Participants entry points open). manualStatus/
  // onPickPresence drive the same status dropdown PresenceButton used to
  // own; hasMySeat/onMySeat are the same "Ke Kursi Saya" action the rail
  // icon and the old top-left-pill button already call elsewhere.
  manualStatus: ManualStatus;
  onPickPresence: (status: ManualStatus) => void;
  hasMySeat: boolean;
  onMySeat: () => void;
  // Requests a fresh ROSTER_SNAPSHOT on open — playerRecords already carries
  // live presence, but this panel used to also nudge the server for an
  // up-to-date snapshot the moment it's opened (same call the old
  // MemberListPanel made).
  emitRosterListRequest: () => void;
}

const MAX_VIDEO_THUMBS = 3;

export function MemberListPanel({ remoteStreams, roomSlug, isMicMuted, isGuest, localAccountName, emitFollowRequest, emitFollowUnfollow, emitSummonUser, emitSlap, onStartDm, onReport, emitKick, emitForceMute, emitForcePull, emitSpotlight, open, onToggle, onClose, manualStatus, onPickPresence, hasMySeat, onMySeat, emitRosterListRequest }: MemberListPanelProps) {
  // Drawer side follows the same flag App.tsx uses to switch between
  // VideoGrid (map HUD) and MeetingView (App.tsx:1119) — read directly
  // rather than threaded as a prop, same as the other store slices below.
  const activePanel = useGameStore((s) => s.activePanel);
  const meetingViewActive = activePanel === 'meeting';
  // If the mode flips WHILE the drawer is open, close it rather than try to
  // animate it across to the other edge — left and right are two different
  // anchor points, not a continuous slide, so jumping sides while open would
  // just look broken. Only fires on an actual transition (guarded by the
  // ref), not on mount.
  const prevMeetingViewActive = useRef(meetingViewActive);
  useEffect(() => {
    if (prevMeetingViewActive.current !== meetingViewActive) {
      prevMeetingViewActive.current = meetingViewActive;
      if (open) onClose();
    }
  }, [meetingViewActive, open, onClose]);

  const playerRecords = useGameStore((s) => s.playerRecords);
  // Per-peer media quality, keyed by the same player id playerRecords and
  // remoteStreams use. Subscribed separately from gameStore so a 5s sampling
  // tick re-renders this panel and nothing else.
  const peerQuality = useSyncExternalStore(subscribeConnectionQuality, getPeerQualitySnapshot);
  // Per-field selectors, not the whole object. gameStore's
  // setLocalPlayerMoving replaces localPlayer every 100ms while walking, so
  // subscribing to the object re-rendered this panel — one row per person in
  // the room — ten times a second, for six fields that walking cannot change.
  const localName = useGameStore((s) => s.localPlayer.name);
  const localColor = useGameStore((s) => s.localPlayer.color);
  const localHandRaised = useGameStore((s) => s.localPlayer.handRaised);
  const localWorkMode = useGameStore((s) => s.localPlayer.workMode);
  const localAwayReason = useGameStore((s) => s.localPlayer.awayReason);
  const localSpotlightActive = useGameStore((s) => s.localPlayer.spotlightActive);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const localUserId = useGameStore((s) => s.localUserId);
  const followInfo = useGameStore((s) => s.followInfo);
  const followerUserIds = useGameStore((s) => s.followerUserIds);
  const localSpeaking = useGameStore((s) => s.localSpeaking);
  const speakingPlayers = useGameStore((s) => s.speakingPlayers);
  const localRole = useGameStore((s) => s.localRole);
  const masterAdminUserId = useGameStore((s) => s.masterAdminUserId);
  const adminPlayerIds = useGameStore((s) => s.adminPlayerIds);
  const staffPlayerIds = useGameStore((s) => s.staffPlayerIds);
  const mutedUserIds = useGameStore((s) => s.mutedUserIds);
  const muteUser = useGameStore((s) => s.muteUser);
  const unmuteUser = useGameStore((s) => s.unmuteUser);

  // Room roster (for the Offline section) — fetched once per panel-open,
  // not polled.
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  // Distinguishes "genuinely nobody's offline" from "the fetch failed" —
  // the two used to look identical (an empty list either way), which is
  // exactly the kind of silent failure that made a real bug report
  // ("Offline shows 0 but shouldn't") impossible to tell apart from
  // working-as-intended without opening devtools.
  const [offlineLoadError, setOfflineLoadError] = useState(false);
  const [onlineOpen, setOnlineOpen] = useState(true);
  const [offlineOpen, setOfflineOpen] = useState(true);
  useEffect(() => {
    if (!open) return;
    setOfflineLoadError(false);
    api.getRoomParticipants(roomSlug).then((r) => setOrgMembers(r.members)).catch((e) => {
      console.error('[MemberListPanel] failed to load room participants (Offline section):', e);
      setOfflineLoadError(true);
    });
    emitRosterListRequest();
  }, [open, roomSlug, emitRosterListRequest]);

  // Status picker — same dropdown PresenceButton used to own, now merged
  // into this panel's header row.
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

  // A player's live room role (see gameStore's applyAdminChanged) — keyed by
  // account id, the authoritative source, rather than the per-record isAdmin
  // flag which isn't refreshed on movement upserts.
  const roleOf = (userId?: string): Role => {
    if (!userId) return 'member';
    if (userId === masterAdminUserId) return 'owner';
    if (adminPlayerIds.has(userId)) return 'admin';
    if (staffPlayerIds.has(userId)) return 'staff';
    return 'member';
  };
  const canKick = roleAtLeast(localRole, 'admin');
  const canForceMute = roleAtLeast(localRole, 'admin');
  const canSpotlight = roleAtLeast(localRole, 'admin');
  const canForcePull = roleAtLeast(localRole, 'admin');

  // Ghost mode follow-up — hidden must mean actually gone from every
  // "who's here" surface, not just the game canvas/minimap (which already
  // did this — see GameCanvas.tsx/Minimap.tsx's own canSeeHidden). This
  // panel was the gap: it listed hidden players regardless of viewer role.
  // Admin+ (the only role that can even use Ghost mode — see App.tsx's
  // HiddenButton gate) still sees everyone, same as the canvas/minimap.
  const canSeeHidden = roleAtLeast(localRole, 'admin');
  const remotePlayers = Object.values(playerRecords).filter((p) => !p.hidden || canSeeHidden);
  const totalOnline = remotePlayers.length + 1;

  // Locate ("Temukan") — search by name, then walk the local player toward
  // them (real A* pathfinding, see GameCanvas.tsx's locateRequestRef).
  // Closes the panel afterward so the searcher can actually watch the map
  // while their avatar walks over, same as any action that changes what's
  // happening on the map (Follow/Summon don't close it since those don't
  // move YOUR avatar).
  const [query, setQuery] = useState('');
  const filteredRemotePlayers = query.trim()
    ? remotePlayers.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()))
    : remotePlayers;
  const handleLocate = useCallback((playerId: string) => {
    useGameStore.getState().setLocateRequest(playerId);
    onClose();
  }, [onClose]);

  const videoActive = remotePlayers.filter((p) => remoteStreams.has(p.id));
  const videoThumbs = videoActive.slice(0, MAX_VIDEO_THUMBS);
  const videoOverflowCount = videoActive.length - videoThumbs.length;

  // Offline section — every member who has been active in THIS room and is
  // NOT currently connected (by userId). orgMembers already arrives sorted
  // alphabetically by the server, so no client-side sort is needed after
  // filtering.
  const onlineUserIds = new Set<string>();
  if (localUserId) onlineUserIds.add(localUserId);
  for (const p of remotePlayers) if (p.userId) onlineUserIds.add(p.userId);
  const offlineMembers = orgMembers.filter((m) => !onlineUserIds.has(m.id));
  const filteredOfflineMembers = query.trim()
    ? offlineMembers.filter((m) => m.displayName.toLowerCase().includes(query.trim().toLowerCase()))
    : offlineMembers;

  // Online section grouping — WFO/WFH/WFA first, then everything else, per
  // PARTICIPANT_GROUP_ORDER. Within a group, existing insertion order is
  // kept (unchanged behavior — this wasn't something the room admin asked
  // to change).
  const onlineGroups = new Map<WorkMode, typeof filteredRemotePlayers>();
  for (const status of PARTICIPANT_GROUP_ORDER) onlineGroups.set(status, []);
  for (const p of filteredRemotePlayers) {
    const status = p.workMode ?? 'available';
    (onlineGroups.get(status) ?? onlineGroups.get('available')!).push(p);
  }

  // Reference design's "OrgLabel N/M" section label — org name (capitalized
  // room slug — no separate configured display-name field exists) + online/
  // total counts, using the counts this panel already computes for its own
  // Online/Offline sections rather than a second fetch.
  const orgLabel = roomSlug.charAt(0).toUpperCase() + roomSlug.slice(1);
  const totalMembers = totalOnline + offlineMembers.length;

  return (
    <>
      {open && (
        <div
          // A floating rounded card ("ngambang"), not a flush full-height
          // drawer — anchored near the top rather than dead-centre, but
          // still switching sides with meetingViewActive (existing
          // ParticipantPanel behavior: left over the map HUD, right over
          // Meeting View), same as the old full-height drawer did.
          className={`fixed top-4 z-50 w-80 max-h-[85vh] bg-white dark:bg-gray-800 rounded-2xl shadow-2xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 flex flex-col pointer-events-auto animate-fade-in ${
            meetingViewActive ? 'right-4' : 'left-16'
          }`}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0">
            <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Employee List</h2>
            <Tooltip label="Tutup" detail="Tutup panel ini.">
              <button
                onClick={onClose}
                className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 cursor-pointer"
              >
                <X size={18} />
              </button>
            </Tooltip>
          </div>

          {/* Status picker + My Seat — merged in from the old
              MemberListPanel ("status sama member jadi satu"). */}
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

          {(remotePlayers.length > 0 || offlineMembers.length > 0) && (
            <div className="px-5 pb-3 shrink-0 relative">
              <Search size={13} className="absolute left-8 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search Member"
                className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-login-border-soft dark:border-gray-700 bg-login-surface dark:bg-gray-900 text-gray-900 dark:text-gray-100 outline-none focus:border-login-accent"
              />
            </div>
          )}

          <p className="px-5 pb-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 shrink-0">
            {orgLabel} {totalOnline}/{totalMembers}
          </p>

          {videoThumbs.length > 0 && (
            <div className="p-2 border-b border-purple-100 dark:border-gray-700 flex gap-1.5 flex-wrap">
              {videoThumbs.map((p) => (
                <ParticipantThumb key={p.id} name={p.name} stream={remoteStreams.get(p.id)!} />
              ))}
              {videoOverflowCount > 0 && (
                <div className="w-12 h-12 rounded-lg bg-purple-100 flex items-center justify-center text-purple-600 text-[10px] font-bold shrink-0">
                  +{videoOverflowCount}
                </div>
              )}
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-2 space-y-3">
            <CollapsibleSection title="Online" count={totalOnline} open={onlineOpen} onToggle={() => setOnlineOpen((v) => !v)}>
              <ParticipantRow
                name={localAccountName}
                color={localColor}
                handRaised={localHandRaised}
                workMode={localWorkMode}
                awayReason={localAwayReason}
                spotlightActive={localSpotlightActive}
                onToggleSpotlight={canSpotlight && localUserId && emitSpotlight ? () => emitSpotlight(localUserId, !localSpotlightActive) : undefined}
                micMuted={isMicMuted}
                speaking={localSpeaking}
                role={localRole}
                isLocal
                inCall={false}
                followerCount={followerUserIds.length}
              />
              {filteredRemotePlayers.length === 0 && query.trim() && (
                <p className="px-2 py-3 text-xs text-gray-400 text-center">Tidak ada yang cocok dengan "{query.trim()}".</p>
              )}
              {PARTICIPANT_GROUP_ORDER.flatMap((status) => onlineGroups.get(status)!).map((p) => (
                <ParticipantRow
                  key={p.id}
                  name={p.name}
                  color={p.color}
                  handRaised={p.handRaised}
                  workMode={p.workMode}
                  awayReason={p.awayReason}
                  spotlightActive={p.spotlightActive}
                  micMuted={p.micMuted}
                  speaking={speakingPlayers.has(p.id)}
                  role={roleOf(p.userId)}
                  isLocal={false}
                  inCall={remoteStreams.has(p.id)}
                  quality={peerQuality.get(p.id)}
                  isFollowingThem={!!p.userId && followInfo?.targetUserId === p.userId}
                  onFollow={p.userId ? () => emitFollowRequest(p.userId!) : undefined}
                  onUnfollow={emitFollowUnfollow}
                  onSummon={isGuest ? undefined : () => emitSummonUser(p.name)}
                  onSlap={isGuest ? undefined : () => emitSlap(p.name)}
                  isMuted={!!p.userId && mutedUserIds.has(p.userId)}
                  onToggleMute={p.userId ? () => (mutedUserIds.has(p.userId!) ? unmuteUser(p.userId!) : muteUser(p.userId!)) : undefined}
                  onMessage={p.userId && !p.isGuest && onStartDm ? () => onStartDm(p.userId!) : undefined}
                  onReport={isGuest || !p.userId || !onReport ? undefined : () => onReport(p.userId!, p.name)}
                  isGuest={p.isGuest}
                  onKick={canKick && p.userId && emitKick ? () => emitKick(p.userId!) : undefined}
                  onForceMute={canForceMute && p.userId && emitForceMute && !p.micMuted ? () => emitForceMute(p.userId!) : undefined}
                  onForcePull={canForcePull && p.userId && emitForcePull ? () => emitForcePull(p.userId!) : undefined}
                  onSpotlight={canSpotlight && p.userId && emitSpotlight ? () => emitSpotlight(p.userId!, !p.spotlightActive) : undefined}
                  onLocate={isGuest ? undefined : () => handleLocate(p.id)}
                />
              ))}
            </CollapsibleSection>
            <CollapsibleSection title="Offline" count={offlineMembers.length} open={offlineOpen} onToggle={() => setOfflineOpen((v) => !v)}>
              {offlineLoadError && (
                <p className="px-2 py-3 text-xs text-red-500 text-center">
                  Gagal memuat daftar offline. Coba tutup dan buka lagi panel ini.
                </p>
              )}
              {!offlineLoadError && filteredOfflineMembers.length === 0 && (
                <p className="px-2 py-3 text-xs text-gray-400 text-center">
                  {query.trim() ? `Tidak ada yang cocok dengan "${query.trim()}".` : 'Semua anggota sedang online.'}
                </p>
              )}
              {filteredOfflineMembers.map((m) => (
                <OfflineMemberRow key={m.id} name={m.displayName} lastSeenAt={m.lastSeenAt} />
              ))}
            </CollapsibleSection>
          </div>
        </div>
      )}
    </>
  );
}

function ParticipantRow({
  name,
  color,
  handRaised,
  workMode,
  awayReason,
  spotlightActive,
  micMuted,
  speaking,
  role,
  isLocal,
  inCall,
  quality,
  followerCount,
  isFollowingThem,
  onFollow,
  onUnfollow,
  onSummon,
  onSlap,
  isMuted,
  onToggleMute,
  onMessage,
  onReport,
  onKick,
  onForceMute,
  onForcePull,
  onSpotlight,
  onToggleSpotlight,
  onLocate,
  isGuest,
}: {
  name: string;
  color: string;
  // Live presence cues, mirroring what shows over the avatar / video tile:
  // a raised hand (see Avatar.handRaised) and whether they're currently
  // speaking (from speakingPlayers / localSpeaking in gameStore).
  handRaised?: boolean;
  // A11 — presence status badge by the name (focus=🎧 DND, in_meeting=🎥,
  // lunch=🍽️, away=🌙). Undefined/available shows none.
  workMode?: WorkMode;
  // Fitur 3B — reason picked from the Away popup, shown as small subtext
  // under the name ("Away · External Meeting") only alongside workMode
  // === 'away'; undefined for every other status (never shown otherwise).
  awayReason?: string;
  // ZEP-style Spotlight — broadcasts to everyone regardless of distance/
  // zone/DND while true (see shared/permissions.ts's 'presence:spotlight').
  // Shown on every row (including the local one) since it's meaningful
  // whoever is spotlighted; only admins get the toggle action (onSpotlight
  // for a remote row, onToggleSpotlight below for the local row).
  spotlightActive?: boolean;
  // Mic mute badge — broadcast via PLAYER_MIC/PLAYER_MIC_UPDATED (see
  // Avatar.micMuted), so it's visible for every participant regardless of
  // WebRTC proximity range, not just peers you're actually in call with.
  micMuted?: boolean;
  speaking?: boolean;
  // Live room role (see gameStore roleOf) — renders a 👑 owner / 🛡️ admin
  // badge by the name; 'staff'/'member' show none.
  role?: Role;
  isLocal: boolean;
  inCall: boolean;
  // Undefined for anyone this client has no peer connection to — an offline
  // member, or someone in the room who is simply out of proximity range.
  // Absent is not the same as bad, so the bars are omitted rather than drawn
  // empty.
  quality?: PeerQuality;
  // Local player row only — how many other players currently have me as
  // their Follow target (see followerUserIds in gameStore.ts).
  followerCount?: number;
  // Remote player rows only.
  isFollowingThem?: boolean;
  onFollow?: () => void;
  onUnfollow?: () => void;
  // §5.1 — undefined (not just a no-op) when I'm below staff, so the button
  // doesn't render at all rather than rendering disabled.
  onSummon?: () => void;
  // A10 — "colek"/slap: a lightweight attention nudge (open to everyone, like
  // summon). Undefined for the local row.
  onSlap?: () => void;
  // Personal mute (services/mutedUsers.ts) — purely local, never broadcast.
  // isMuted drives both the row's badge and the toggle label; onToggleMute
  // is undefined only when this row has no userId to key a mute by.
  isMuted?: boolean;
  onToggleMute?: () => void;
  // Opens a persisted 1:1 DM with this participant (see useChannelChat.ts).
  onMessage?: () => void;
  // Item 13, "Panic/report user" — open to everyone, like Slap/Summon, not
  // an admin-only action (undefined only for guest rows/viewers).
  onReport?: () => void;
  // Temporary removal from the room — undefined (not just a no-op) when I'm
  // below admin, same "hide, don't disable" convention as onSummon above.
  onKick?: () => void;
  // QA (Moderasi checklist item 11, "Kick/mute admin") — force this row's
  // player's mic off (visible to everyone via the normal muted badge, not
  // just to me — see onToggleMute below for that separate LOCAL-only
  // preference). Undefined (not disabled) below admin, same convention as
  // onKick, and also undefined once already muted (nothing left to force).
  onForceMute?: () => void;
  // "Tarik Paksa" (Force-pull) — moves this row's player here immediately,
  // no consent. Undefined (not disabled) below admin, same convention as
  // onKick — a plain member never sees this row's option exist at all.
  onForcePull?: () => void;
  // Toggles Spotlight on/off for this row's player — undefined (not just a
  // no-op) below admin, same convention as onKick. Only ever passed for
  // REMOTE rows; the local row gets the separate onToggleSpotlight below
  // instead, since Spotlight is the one action that's meaningful to target
  // at yourself (see specs/2026-08-21-self-spotlight-design.md) — Kick/
  // ForceMute/ForcePull stay excluded from the local row entirely.
  onSpotlight?: () => void;
  // specs/2026-08-21-self-spotlight-design.md — the local row's OWN way to
  // toggle Spotlight on itself. Distinct from onSpotlight above (which is
  // for acting on a REMOTE row): when this is present, the badge below
  // renders as an always-visible, clickable toggle instead of the passive
  // "shown only while active" badge every other row keeps. undefined (not
  // just a no-op) when the local viewer isn't an admin — same "hide, don't
  // disable" convention as every other admin-only action in this file.
  onToggleSpotlight?: () => void;
  // Locate ("Temukan") — walks the LOCAL player toward this row's player
  // via real pathfinding (see GameCanvas.tsx's locateRequestRef). Open to
  // everyone, like Summon/Slap — finding a coworker's current desk isn't a
  // privileged action.
  onLocate?: () => void;
  // Guest Link & Ruang Tunggu — renders a "Guest" badge and, since a guest
  // has no real userId to DM (see Avatar.isGuest's own doc comment),
  // suppresses onMessage at the CALL SITE (not here — see p.userId &&
  // !p.isGuest && onStartDm below) rather than duplicating that guard.
  isGuest?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-2 py-1 rounded bg-purple-50/50 dark:bg-gray-700/50">
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
        <div className="min-w-0">
          <span className="text-gray-700 dark:text-gray-300 text-xs truncate flex items-center gap-1">
            {role === 'owner' && <span title="Room owner" className="shrink-0">👑</span>}
            {role === 'admin' && <span title="Admin" className="shrink-0">🛡️</span>}
            <span className="truncate">{name}</span>
            {isGuest && (
              <span title="Tamu (guest link)" className="shrink-0 px-1 py-px rounded text-[9px] font-semibold uppercase tracking-wide bg-purple-100 dark:bg-purple-900/50 text-purple-600 dark:text-purple-300">
                Guest
              </span>
            )}
          </span>
          {workMode === 'away' && awayReason && (
            <span className="text-gray-400 dark:text-gray-500 text-[10px] truncate block">Away · {awayReason}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {/* Live presence cues, glanceable per row — same signals shown over
            the avatar (raise-hand ✋, presence badge) and video tile (speaking 🔊). */}
        {onToggleSpotlight ? (
          <button
            type="button"
            onClick={onToggleSpotlight}
            title={spotlightActive ? 'Matikan Spotlight' : 'Nyalakan Spotlight'}
            aria-pressed={spotlightActive}
            className={`shrink-0 cursor-pointer transition-colors ${spotlightActive ? 'text-amber-500' : 'text-gray-400 dark:text-gray-500 hover:text-amber-400'}`}
          >
            <MegaphoneFill size={11} />
          </button>
        ) : (
          spotlightActive && <MegaphoneFill title="Spotlight aktif — terdengar/terlihat seluruh room" size={11} className="text-amber-500 shrink-0" />
        )}
        {handRaised && <img src="/assets/img/raise-hand-icon.png" alt="" title="Hand raised" className="w-3 h-2.5 animate-bounce shrink-0" />}
        {workMode && workMode !== 'available' && (
          // Bug fix — this used to render the emoji alone (label only
          // reachable by hovering the title attribute), so a status
          // like "In a meeting" was just a bare 🎥 with no text anyone
          // glancing at the list would recognize. Now matches the
          // emoji+label pairing already used above the avatar (see
          // AvatarSprite.ts's presence pill).
          <span title={PRESENCE_LABEL[workMode]} className="text-[9px] font-semibold px-1 py-px rounded bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-300 shrink-0 whitespace-nowrap">
            {PRESENCE_EMOJI[workMode]} {PRESENCE_LABEL[workMode]}
          </span>
        )}
        {speaking && <span title="Speaking" className="text-[11px] leading-none animate-pulse">🔊</span>}
        {micMuted && <MicMuteFill className="text-red-500" size={11} title={isLocal ? 'Mic Anda mati' : 'Mic mati'} />}
        {isMuted && <VolumeMuteFill className="text-gray-400" size={11} title="Anda bisukan orang ini" />}
        {inCall && <CameraVideoFill className="text-purple-600" size={11} title="In call" />}
        {/* Per-peer, deliberately: this is the reading that separates "my
            connection is bad" from "theirs is". One red row among green ones
            points at that person; all rows red points at this machine, which
            is what the summary in ConnectionIndicator says out loud. */}
        {quality && <SignalBars level={quality.level} bars={quality.bars} relayed={quality.relayed} />}
        {!!followerCount && (
          <span className="text-purple-500 text-[10px] inline-flex items-center gap-0.5" title={`Followed by ${followerCount}`}>
            <PersonWalking size={10} /> {followerCount}
          </span>
        )}
        {/* "Following" stays outside the menu: it's the one item that is a
            STATE as much as an action, and having to open a menu to discover
            you're already following someone defeats the point of showing it. */}
        {!isLocal && isFollowingThem && (
          <Tooltip label="Berhenti mengikuti" detail="Berhenti mengikuti pergerakan orang ini.">
            <button
              onClick={onUnfollow}
              className="text-purple-600 hover:text-purple-800 cursor-pointer inline-flex items-center gap-0.5 text-[10px] font-medium bg-purple-100 px-1.5 py-0.5 rounded"
            >
              <X size={10} /> Mengikuti
            </button>
          </Tooltip>
        )}
        {!isLocal && (
          <ParticipantActionsMenu
            name={name}
            isFollowingThem={isFollowingThem}
            isMuted={isMuted}
            spotlightActive={spotlightActive}
            onLocate={onLocate}
            onFollow={onFollow}
            onSummon={onSummon}
            onForcePull={onForcePull}
            onSlap={onSlap}
            onToggleMute={onToggleMute}
            onMessage={onMessage}
            onSpotlight={onSpotlight}
            onReport={onReport}
            onForceMute={onForceMute}
            onKick={onKick}
          />
        )}
        {isLocal && <span className="text-gray-400 dark:text-gray-500 text-[10px]">Kamu</span>}
      </div>
    </div>
  );
}

function CollapsibleSection({ title, count, open, onToggle, children }: { title: string; count: number; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 cursor-pointer hover:text-gray-600 dark:hover:text-gray-300"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {title} ({count})
      </button>
      {open && <div className="space-y-1 mt-1">{children}</div>}
    </div>
  );
}

function OfflineMemberRow({ name, lastSeenAt }: {
  name: string;
  // specs/2026-08-21-last-seen-offline-members-design.md — null means this
  // account has never actually joined a room (not "unknown"/"loading").
  // Start of the user's MOST RECENT room activity, not their first-ever join.
  lastSeenAt: number | null;
}) {
  return (
    <div className="flex items-center justify-between px-2 py-1 rounded bg-gray-50/50 dark:bg-gray-800/50">
      <div className="min-w-0 flex flex-col">
        <span className="text-gray-500 dark:text-gray-400 text-xs truncate">{name}</span>
        <span className="text-gray-400 dark:text-gray-500 text-[10px] truncate">
          {lastSeenAt ? `Terakhir masuk ${formatRelativeTimeId(lastSeenAt)} (${formatExactDateTimeId(lastSeenAt)})` : 'Belum pernah masuk'}
        </span>
      </div>
    </div>
  );
}

function ParticipantThumb({ name, stream }: { name: string; stream: MediaStream }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    video.play().catch(() => {});
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  return (
    <div className="w-12 h-12 rounded-lg overflow-hidden bg-purple-100 relative shrink-0" title={name}>
      {/* Always a remote participant's stream (see remoteStreams.get(p.id)
          above) — never mirrored, no transform. */}
      <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
      <span className="absolute bottom-0 inset-x-0 bg-black/50 text-white text-[8px] px-1 truncate">{name}</span>
    </div>
  );
}
