import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CameraVideoFill, PersonWalking, MagnetFill, ChatDotsFill, PersonDashFill, X, ThreeDotsVertical, Headphones, HandIndexThumbFill, MegaphoneFill, MicMuteFill, GeoAltFill, Search, VolumeMuteFill, VolumeUpFill, FlagFill } from 'react-bootstrap-icons';
import { roleAtLeast, Role, WorkMode } from '@kaispace/shared';
import { useGameStore } from '@/stores/gameStore';
import { PRESENCE_LABEL, PRESENCE_EMOJI } from '@/data/presence';
import { Tooltip } from '@/components/ui/Tooltip';
import { showConfirm } from '@/stores/modalStore';
import { api, OrgMember } from '@/services/api';

// One labelled row inside a participant's action menu. Icon plus wording,
// because five bare icons crowded into a row said nothing until you hovered
// each one to find out what it did. `detail` is optional, longer copy shown
// via the shared Tooltip component — the row's own `label` text already
// identifies the action, so this is only for the extra "what this actually
// does" line, same split every other Tooltip caller uses.
function MenuItem({ icon, label, onClick, danger, detail }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean; detail?: string }) {
  return (
    <Tooltip label={label} detail={detail} wrapperClassName="w-full">
      <button
        onClick={onClick}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left cursor-pointer transition-colors ${
          danger
            ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30'
            : 'text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-700'
        }`}
      >
        <span className="shrink-0 w-4 flex justify-center">{icon}</span>
        {label}
      </button>
    </Tooltip>
  );
}

interface ParticipantPanelProps {
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
}

const MAX_VIDEO_THUMBS = 3;

export function ParticipantPanel({ remoteStreams, roomSlug, isMicMuted, isGuest, localAccountName, emitFollowRequest, emitFollowUnfollow, emitSummonUser, emitSlap, onStartDm, onReport, emitKick, emitForceMute, emitForcePull, emitSpotlight, open, onToggle, onClose }: ParticipantPanelProps) {
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

  const localUserId = useGameStore((s) => s.localUserId);

  // Room roster (for the Offline section) — fetched once per panel-open,
  // not polled.
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  useEffect(() => {
    if (!open) return;
    api.getRoomParticipants(roomSlug).then((r) => setOrgMembers(r.members)).catch(() => {});
  }, [open, roomSlug]);

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

  // Offline section — every org member NOT currently connected (by userId).
  const onlineUserIds = new Set<string>();
  if (localUserId) onlineUserIds.add(localUserId);
  for (const p of remotePlayers) if (p.userId) onlineUserIds.add(p.userId);
  const offlineMembers = orgMembers.filter((m) => !onlineUserIds.has(m.id));

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

  return (
    <>
      {open && (
        <div
          // Full-height drawer: left edge (after the Sidebar rail, w-12)
          // over the map HUD, right edge over Meeting View — the common
          // "participants panel" placement for a meeting layout. `fixed`
          // (not absolute) so it spans the real viewport height regardless
          // of any ancestor's own height/scroll.
          className={`fixed inset-y-0 z-50 w-80 bg-white/95 dark:bg-gray-900/95 backdrop-blur-xl shadow-2xl shadow-purple-500/10 flex flex-col pointer-events-auto animate-fade-in ${
            meetingViewActive
              ? 'right-0 border-l border-purple-200/50 dark:border-white/10'
              : 'left-12 border-r border-purple-200/50 dark:border-white/10'
          }`}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="p-3 border-b border-purple-100 dark:border-gray-700 flex items-center justify-between">
            <span className="text-gray-900 dark:text-gray-100 text-sm font-medium">Participants</span>
            <div className="flex items-center gap-2">
              <span className="text-gray-400 dark:text-gray-500 text-xs">{totalOnline} online</span>
              <Tooltip label="Tutup" detail="Tutup panel Peserta.">
                <button
                  onClick={onClose}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
                >
                  <X size={14} />
                </button>
              </Tooltip>
            </div>
          </div>

          {(remotePlayers.length > 0 || offlineMembers.length > 0) && (
            <div className="px-3 pt-2 pb-1 relative">
              <Search size={11} className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Cari nama..."
                className="w-full pl-6 pr-2 py-1 rounded-md bg-purple-50 dark:bg-gray-800 border border-purple-100 dark:border-gray-700 text-xs outline-none focus:border-purple-400 dark:focus:border-purple-500 text-gray-700 dark:text-gray-200 placeholder:text-gray-400"
              />
            </div>
          )}

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

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            <ParticipantRow
              name={localAccountName}
              color={localColor}
              handRaised={localHandRaised}
              workMode={localWorkMode}
              awayReason={localAwayReason}
              spotlightActive={localSpotlightActive}
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
            {filteredRemotePlayers.map((p) => (
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
  // whoever is spotlighted; only admins get the toggle action (onSpotlight).
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
  // no-op) below admin, same convention as onKick. Never present on the
  // local row (isLocal never gets action props, only the badge above).
  onSpotlight?: () => void;
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
  // Menu coordinates in viewport space, measured from the trigger when it
  // opens. null = closed.
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const menuOpen = menuPos !== null;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Closing needs BOTH refs: the menu lives in a portal on document.body, so
  // as far as the DOM tree is concerned a click inside it is outside the row.
  // Checking only one would make the menu dismiss itself the instant you
  // tried to click one of its own items.
  const closeMenu = useCallback(() => setMenuPos(null), []);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !popRef.current?.contains(t)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    // Position is measured once on open, so any scroll or resize would leave
    // the menu floating away from its row — close instead of chasing it.
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [menuOpen, closeMenu]);

  const openMenu = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const MENU_W = 176; // w-44
    const MENU_H = 190; // generous estimate; only used to decide flip direction
    // Flip above the trigger when there isn't room below, and keep the right
    // edge on screen — a participant near the bottom of a tall list would
    // otherwise get a menu running off the viewport.
    const openUp = r.bottom + MENU_H > window.innerHeight && r.top > MENU_H;
    const right = Math.max(8, Math.min(window.innerWidth - r.right, window.innerWidth - MENU_W - 8));
    setMenuPos({ top: openUp ? r.top - MENU_H - 4 : r.bottom + 4, right });
  };

  // Every action wrapped so the menu closes as soon as one is chosen —
  // leaving it open over a row whose state just changed reads as if the
  // click didn't register.
  const pick = (fn?: () => void) => () => { closeMenu(); fn?.(); };
  const hasActions = !isLocal && (onFollow || onUnfollow || onSummon || onSlap || onToggleMute || onMessage || onReport || onKick || onForceMute || onForcePull || onSpotlight || onLocate);

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
        {spotlightActive && <MegaphoneFill title="Spotlight aktif — terdengar/terlihat seluruh room" size={11} className="text-amber-500 shrink-0" />}
        {handRaised && <img src="/assets/img/raise-hand-icon.png" alt="" title="Hand raised" className="w-3 h-2.5 animate-bounce shrink-0" />}
        {workMode === 'focus' && <Headphones title="Fokus (jangan diganggu)" size={12} className="text-purple-500 shrink-0" />}
        {workMode && workMode !== 'focus' && workMode !== 'available' && (
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
        {hasActions && (
          <>
            <Tooltip label={`Aksi untuk ${name}`} detail="Buka menu aksi untuk orang ini.">
            <button
              ref={triggerRef}
              onClick={() => (menuOpen ? closeMenu() : openMenu())}
              className={`cursor-pointer rounded px-0.5 ${menuOpen ? 'text-purple-600 bg-purple-100 dark:bg-gray-600' : 'text-gray-400 dark:text-gray-500 hover:text-purple-600'}`}
            >
              <ThreeDotsVertical size={13} />
            </button>
            </Tooltip>
            {menuPos && createPortal(
              // Rendered on document.body, NOT inside the row. An absolutely
              // positioned menu is clipped by any ancestor whose overflow
              // isn't visible, and the participant list is overflow-y-auto —
              // so the menu was being cut off AND counted as scrollable
              // content, which is what made the scrollbar appear. z-index
              // cannot fix clipping; only leaving the container can.
              //
              // position: fixed alone would not have been enough either: the
              // panel uses backdrop-blur, and backdrop-filter establishes a
              // containing block, so a fixed child would still be trapped
              // inside it.
              <div
                ref={popRef}
                style={{ top: menuPos.top, right: menuPos.right }}
                className="fixed z-[60] w-44 py-1 rounded-lg bg-white dark:bg-gray-800 border border-purple-200 dark:border-gray-600 shadow-xl overflow-hidden"
              >
                {onLocate && (
                  <MenuItem icon={<GeoAltFill size={12} />} label="Temukan" detail="Pusatkan kamera ke posisi orang ini di peta." onClick={pick(onLocate)} />
                )}
                {!isFollowingThem && onFollow && (
                  <MenuItem icon={<PersonWalking size={12} />} label="Ikuti" detail="Ikuti otomatis ke mana pun orang ini berjalan." onClick={pick(onFollow)} />
                )}
                {onSummon && (
                  <MenuItem icon={<MagnetFill size={12} />} label="Panggil ke sini" detail="Undang orang ini ke lokasimu — dia harus menyetujui dulu." onClick={pick(onSummon)} />
                )}
                {onForcePull && (
                  <MenuItem
                    icon={<MagnetFill size={12} />}
                    label="Tarik Paksa"
                    detail="Pindahkan orang ini ke lokasimu langsung, tanpa persetujuan."
                    danger
                    onClick={pick(async () => { if (await showConfirm(`Tarik paksa ${name} ke sini? Tidak perlu persetujuan dia — beda dari "Panggil ke sini".`, { danger: true })) onForcePull(); })}
                  />
                )}
                {onSlap && (
                  <MenuItem icon={<HandIndexThumbFill size={12} />} label="Colek (sadarkan)" detail="Getarkan avatar orang ini sebentar untuk menarik perhatiannya." onClick={pick(onSlap)} />
                )}
                {onToggleMute && (
                  <MenuItem
                    icon={isMuted ? <VolumeUpFill size={12} /> : <VolumeMuteFill size={12} />}
                    label={isMuted ? 'Batalkan bisukan' : 'Bisukan'}
                    detail="Cuma mengubah suara yang KAMU dengar — mic orang ini tetap aktif untuk orang lain."
                    onClick={pick(onToggleMute)}
                  />
                )}
                {onMessage && (
                  <MenuItem icon={<ChatDotsFill size={11} />} label="Kirim pesan" detail="Buka percakapan DM 1-on-1 dengan orang ini." onClick={pick(onMessage)} />
                )}
                {onSpotlight && (
                  <MenuItem
                    icon={<MegaphoneFill size={11} />}
                    label={spotlightActive ? 'Matikan Spotlight' : 'Nyalakan Spotlight'}
                    detail="Jadikan orang ini tampilan utama di Meeting View semua orang."
                    onClick={pick(onSpotlight)}
                  />
                )}
                {onReport && (
                  <MenuItem icon={<FlagFill size={11} />} label="Laporkan" detail="Laporkan perilaku orang ini ke admin workspace." danger onClick={pick(onReport)} />
                )}
                {(onForceMute || onKick) && (
                  <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
                )}
                {onForceMute && (
                  <MenuItem
                    icon={<MicMuteFill size={12} />}
                    label="Matikan Mic (Admin)"
                    detail="Matikan mic orang ini secara paksa — dia bisa menyalakannya lagi sendiri."
                    danger
                    onClick={pick(async () => { if (await showConfirm(`Matikan mic ${name}? Dia bisa nyalain lagi sendiri kapan saja.`, { danger: true })) onForceMute(); })}
                  />
                )}
                {onKick && (
                  <MenuItem
                    icon={<PersonDashFill size={12} />}
                    label="Keluarkan"
                    detail="Keluarkan orang ini dari room — dia bisa masuk lagi kapan saja."
                    danger
                    onClick={pick(async () => { if (await showConfirm(`Keluarkan ${name} dari room ini? Dia bisa masuk lagi kapan saja.`, { danger: true })) onKick(); })}
                  />
                )}
              </div>,
              document.body,
            )}
          </>
        )}
        {isLocal && <span className="text-gray-400 dark:text-gray-500 text-[10px]">Kamu</span>}
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
