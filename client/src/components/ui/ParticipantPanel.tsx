import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PeopleFill, CameraVideoFill, ChevronUp, ChevronDown, PersonWalking, MagnetFill, ChatDotsFill, PersonDashFill, X, ThreeDotsVertical, Headphones, HandIndexThumbFill } from 'react-bootstrap-icons';
import { roleAtLeast, Role, WorkMode } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { PRESENCE_LABEL, PRESENCE_EMOJI } from '@/data/presence';

// One labelled row inside a participant's action menu. Icon plus wording,
// because five bare icons crowded into a row said nothing until you hovered
// each one to find out what it did.
function MenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
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
  );
}

interface ParticipantPanelProps {
  remoteStreams: Map<string, MediaStream>;
  emitFollowRequest: (targetUserId: string) => void;
  emitFollowUnfollow: () => void;
  emitSummonUser: (nickname: string) => void;
  // A10 — "colek"/slap a participant by name (lightweight attention nudge).
  emitSlap: (nickname: string) => void;
  // Opens (or creates) a persisted 1:1 DM with this account — see
  // useChannelChat.ts's startDm. Undefined for rows with no account id
  // (unreachable today — login is mandatory before joining a room).
  onStartDm?: (targetUserId: string) => void;
  // Temporary removal from the room, admin+ only (see shared/permissions.ts's
  // 'room:kick') — not a ban, the target can rejoin any time.
  emitKick?: (targetUserId: string) => void;
  // Bug 12 — open state is now controlled by the parent's single-active-panel
  // coordinator (was local), so opening this closes any other panel and vice
  // versa. onToggle flips it (header click); onClose forces it shut.
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}

const MAX_VIDEO_THUMBS = 3;

export function ParticipantPanel({ remoteStreams, emitFollowRequest, emitFollowUnfollow, emitSummonUser, emitSlap, onStartDm, emitKick, open, onToggle, onClose }: ParticipantPanelProps) {
  const playerRecords = useGameStore((s) => s.playerRecords);
  const localPlayer = useGameStore((s) => s.localPlayer);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const followInfo = useGameStore((s) => s.followInfo);
  const followerUserIds = useGameStore((s) => s.followerUserIds);
  const localSpeaking = useGameStore((s) => s.localSpeaking);
  const speakingPlayers = useGameStore((s) => s.speakingPlayers);
  const localRole = useGameStore((s) => s.localRole);
  const masterAdminUserId = useGameStore((s) => s.masterAdminUserId);
  const adminPlayerIds = useGameStore((s) => s.adminPlayerIds);
  const staffPlayerIds = useGameStore((s) => s.staffPlayerIds);

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

  const remotePlayers = Object.values(playerRecords);
  const totalOnline = remotePlayers.length + 1;

  const videoActive = remotePlayers.filter((p) => remoteStreams.has(p.id));
  const videoThumbs = videoActive.slice(0, MAX_VIDEO_THUMBS);
  const videoOverflowCount = videoActive.length - videoThumbs.length;

  return (
    <div className="relative z-40 pointer-events-auto">
      <button
        onClick={onToggle}
        title="Participants"
        className="bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm px-3 py-2 rounded-lg text-xs text-purple-700 dark:text-purple-300 hover:text-purple-800 border border-purple-200 dark:border-gray-600 shadow-sm cursor-pointer inline-flex items-center gap-1.5"
      >
        <PeopleFill size={13} /> {totalOnline} {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
      </button>

      {open && (
        <div
          className="absolute top-full left-0 mt-2 w-56 max-h-[60vh] bg-white/95 dark:bg-gray-900/95 backdrop-blur-md rounded-xl border border-purple-100 dark:border-gray-700 shadow-2xl flex flex-col pointer-events-auto"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="p-3 border-b border-purple-100 dark:border-gray-700 flex items-center justify-between">
            <span className="text-gray-900 dark:text-gray-100 text-sm font-medium">Participants</span>
            <div className="flex items-center gap-2">
              <span className="text-gray-400 dark:text-gray-500 text-xs">{totalOnline} online</span>
              <button
                onClick={onClose}
                title="Close"
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>
          </div>

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
              name={localPlayer.name}
              color={localPlayer.color}
              status={localPlayer.status}
              handRaised={localPlayer.handRaised}
              workMode={localPlayer.workMode}
              awayReason={localPlayer.awayReason}
              speaking={localSpeaking}
              role={localRole}
              isLocal
              inCall={false}
              followerCount={followerUserIds.length}
            />
            {remotePlayers.map((p) => (
              <ParticipantRow
                key={p.id}
                name={p.name}
                color={p.color}
                status={p.status}
                handRaised={p.handRaised}
                workMode={p.workMode}
                awayReason={p.awayReason}
                speaking={speakingPlayers.has(p.id)}
                role={roleOf(p.userId)}
                isLocal={false}
                inCall={remoteStreams.has(p.id)}
                isFollowingThem={!!p.userId && followInfo?.targetUserId === p.userId}
                onFollow={p.userId ? () => emitFollowRequest(p.userId!) : undefined}
                onUnfollow={emitFollowUnfollow}
                onSummon={() => emitSummonUser(p.name)}
                onSlap={() => emitSlap(p.name)}
                onMessage={p.userId && onStartDm ? () => onStartDm(p.userId!) : undefined}
                onKick={canKick && p.userId && emitKick ? () => emitKick(p.userId!) : undefined}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ParticipantRow({
  name,
  color,
  status,
  handRaised,
  workMode,
  awayReason,
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
  onMessage,
  onKick,
}: {
  name: string;
  color: string;
  status?: string;
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
  // Opens a persisted 1:1 DM with this participant (see useChannelChat.ts).
  onMessage?: () => void;
  // Temporary removal from the room — undefined (not just a no-op) when I'm
  // below admin, same "hide, don't disable" convention as onSummon above.
  onKick?: () => void;
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
  const hasActions = !isLocal && (onFollow || onUnfollow || onSummon || onSlap || onMessage || onKick);

  return (
    <div className="flex items-center justify-between px-2 py-1 rounded bg-purple-50/50 dark:bg-gray-700/50">
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
        <div className="min-w-0">
          <span className="text-gray-700 dark:text-gray-300 text-xs truncate flex items-center gap-1">
            {role === 'owner' && <span title="Room owner" className="shrink-0">👑</span>}
            {role === 'admin' && <span title="Admin" className="shrink-0">🛡️</span>}
            <span className="truncate">{name}</span>
          </span>
          {status && <span className="text-gray-400 dark:text-gray-500 text-[10px] truncate block">{status}</span>}
          {workMode === 'away' && awayReason && (
            <span className="text-gray-400 dark:text-gray-500 text-[10px] truncate block">Away · {awayReason}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {/* Live presence cues, glanceable per row — same signals shown over
            the avatar (raise-hand ✋, AFK 💤) and video tile (speaking 🔊). */}
        {handRaised && <span title="Hand raised" className="text-[11px] leading-none animate-bounce">✋</span>}
        {workMode === 'focus' && <Headphones title="Fokus (jangan diganggu)" size={12} className="text-purple-500 shrink-0" />}
        {workMode && workMode !== 'focus' && (
          <span title={PRESENCE_LABEL[workMode]} className="text-[11px] leading-none shrink-0">
            {workMode === 'available' ? '' : PRESENCE_EMOJI[workMode]}
          </span>
        )}
        {speaking && <span title="Speaking" className="text-[11px] leading-none animate-pulse">🔊</span>}
        {status?.startsWith('💤') && <span title="Away" className="text-[11px] leading-none opacity-70">💤</span>}
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
          <button
            onClick={onUnfollow}
            title="Berhenti mengikuti"
            className="text-purple-600 hover:text-purple-800 cursor-pointer inline-flex items-center gap-0.5 text-[10px] font-medium bg-purple-100 px-1.5 py-0.5 rounded"
          >
            <X size={10} /> Mengikuti
          </button>
        )}
        {hasActions && (
          <>
            <button
              ref={triggerRef}
              onClick={() => (menuOpen ? closeMenu() : openMenu())}
              title={`Aksi untuk ${name}`}
              className={`cursor-pointer rounded px-0.5 ${menuOpen ? 'text-purple-600 bg-purple-100 dark:bg-gray-600' : 'text-gray-400 dark:text-gray-500 hover:text-purple-600'}`}
            >
              <ThreeDotsVertical size={13} />
            </button>
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
                {!isFollowingThem && onFollow && (
                  <MenuItem icon={<PersonWalking size={12} />} label="Ikuti" onClick={pick(onFollow)} />
                )}
                {onSummon && (
                  <MenuItem icon={<MagnetFill size={12} />} label="Panggil ke sini" onClick={pick(onSummon)} />
                )}
                {onSlap && (
                  <MenuItem icon={<HandIndexThumbFill size={12} />} label="Colek (sadarkan)" onClick={pick(onSlap)} />
                )}
                {onMessage && (
                  <MenuItem icon={<ChatDotsFill size={11} />} label="Kirim pesan" onClick={pick(onMessage)} />
                )}
                {onKick && (
                  <>
                    <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
                    <MenuItem
                      icon={<PersonDashFill size={12} />}
                      label="Keluarkan"
                      danger
                      onClick={pick(() => { if (window.confirm(`Keluarkan ${name} dari room ini? Dia bisa masuk lagi kapan saja.`)) onKick(); })}
                    />
                  </>
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
