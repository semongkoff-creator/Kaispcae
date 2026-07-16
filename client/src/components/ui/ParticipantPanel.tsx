import { useEffect, useRef, useState } from 'react';
import { PeopleFill, CameraVideoFill, ChevronUp, ChevronDown, PersonWalking, MagnetFill, StarFill, ChatDotsFill, PersonDashFill, X } from 'react-bootstrap-icons';
import { roleAtLeast, Role } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';

interface ParticipantPanelProps {
  remoteStreams: Map<string, MediaStream>;
  emitFollowRequest: (targetUserId: string) => void;
  emitFollowUnfollow: () => void;
  emitSummonUser: (nickname: string) => void;
  emitSpotlightToggle: (targetUserId: string) => void;
  // Opens (or creates) a persisted 1:1 DM with this account — see
  // useChannelChat.ts's startDm. Undefined for rows with no account id
  // (unreachable today — login is mandatory before joining a room).
  onStartDm?: (targetUserId: string) => void;
  // Temporary removal from the room, admin+ only (see shared/permissions.ts's
  // 'room:kick') — not a ban, the target can rejoin any time.
  emitKick?: (targetUserId: string) => void;
}

const MAX_VIDEO_THUMBS = 3;

export function ParticipantPanel({ remoteStreams, emitFollowRequest, emitFollowUnfollow, emitSummonUser, emitSpotlightToggle, onStartDm, emitKick }: ParticipantPanelProps) {
  const [open, setOpen] = useState(false);
  const playerRecords = useGameStore((s) => s.playerRecords);
  const localPlayer = useGameStore((s) => s.localPlayer);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const followInfo = useGameStore((s) => s.followInfo);
  const followerUserIds = useGameStore((s) => s.followerUserIds);
  const spotlightedUserIds = useGameStore((s) => s.spotlightedUserIds);
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
  const canModerate = roleAtLeast(localRole, 'staff');
  const canKick = roleAtLeast(localRole, 'admin');

  const remotePlayers = Object.values(playerRecords);
  const totalOnline = remotePlayers.length + 1;

  const videoActive = remotePlayers.filter((p) => remoteStreams.has(p.id));
  const videoThumbs = videoActive.slice(0, MAX_VIDEO_THUMBS);
  const videoOverflowCount = videoActive.length - videoThumbs.length;

  return (
    <div className="relative z-40 pointer-events-auto">
      <button
        onClick={() => setOpen(!open)}
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
                onClick={() => setOpen(false)}
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
                speaking={speakingPlayers.has(p.id)}
                role={roleOf(p.userId)}
                isLocal={false}
                inCall={remoteStreams.has(p.id)}
                isFollowingThem={!!p.userId && followInfo?.targetUserId === p.userId}
                onFollow={p.userId ? () => emitFollowRequest(p.userId!) : undefined}
                onUnfollow={emitFollowUnfollow}
                onSummon={canModerate ? () => emitSummonUser(p.name) : undefined}
                isSpotlighted={!!p.userId && spotlightedUserIds.includes(p.userId)}
                onSpotlight={canModerate && p.userId ? () => emitSpotlightToggle(p.userId!) : undefined}
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
  speaking,
  role,
  isLocal,
  inCall,
  followerCount,
  isFollowingThem,
  onFollow,
  onUnfollow,
  onSummon,
  isSpotlighted,
  onSpotlight,
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
  // §6 — spotlight bypasses this player's distance-visibility limit for
  // everyone in the room; undefined when I'm below staff or they have no
  // account id (guest fallback — unreachable today, login is mandatory).
  isSpotlighted?: boolean;
  onSpotlight?: () => void;
  // Opens a persisted 1:1 DM with this participant (see useChannelChat.ts).
  onMessage?: () => void;
  // Temporary removal from the room — undefined (not just a no-op) when I'm
  // below admin, same "hide, don't disable" convention as onSummon above.
  onKick?: () => void;
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
          </span>
          {status && <span className="text-gray-400 dark:text-gray-500 text-[10px] truncate block">{status}</span>}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {/* Live presence cues, glanceable per row — same signals shown over
            the avatar (raise-hand ✋, AFK 💤) and video tile (speaking 🔊). */}
        {handRaised && <span title="Hand raised" className="text-[11px] leading-none animate-bounce">✋</span>}
        {speaking && <span title="Speaking" className="text-[11px] leading-none animate-pulse">🔊</span>}
        {status?.startsWith('💤') && <span title="Away" className="text-[11px] leading-none opacity-70">💤</span>}
        {inCall && <CameraVideoFill className="text-purple-600" size={11} title="In call" />}
        {!!followerCount && (
          <span className="text-purple-500 text-[10px] inline-flex items-center gap-0.5" title={`Followed by ${followerCount}`}>
            <PersonWalking size={10} /> {followerCount}
          </span>
        )}
        {!isLocal && (
          isFollowingThem ? (
            <button
              onClick={onUnfollow}
              title="Stop following"
              className="text-purple-600 hover:text-purple-800 cursor-pointer inline-flex items-center gap-0.5 text-[10px] font-medium bg-purple-100 px-1.5 py-0.5 rounded"
            >
              <X size={10} /> Following
            </button>
          ) : (
            onFollow && (
              <button
                onClick={onFollow}
                title={`Follow ${name}`}
                className="text-gray-400 dark:text-gray-500 hover:text-purple-600 cursor-pointer"
              >
                <PersonWalking size={12} />
              </button>
            )
          )
        )}
        {!isLocal && onSummon && (
          <button
            onClick={onSummon}
            title={`Summon ${name} to me`}
            className="text-gray-400 dark:text-gray-500 hover:text-purple-600 cursor-pointer"
          >
            <MagnetFill size={12} />
          </button>
        )}
        {!isLocal && onMessage && (
          <button
            onClick={onMessage}
            title={`Message ${name}`}
            className="text-gray-400 dark:text-gray-500 hover:text-purple-600 cursor-pointer"
          >
            <ChatDotsFill size={11} />
          </button>
        )}
        {!isLocal && onSpotlight && (
          <button
            onClick={onSpotlight}
            title={isSpotlighted ? `Remove spotlight from ${name}` : `Spotlight ${name} (visible to everyone regardless of distance)`}
            className={`cursor-pointer ${isSpotlighted ? 'text-amber-500' : 'text-gray-400 dark:text-gray-500 hover:text-amber-500'}`}
          >
            <StarFill size={12} />
          </button>
        )}
        {!isLocal && onKick && (
          <button
            onClick={() => { if (window.confirm(`Remove ${name} from this room? They can rejoin any time.`)) onKick(); }}
            title={`Remove ${name} from this room`}
            className="text-gray-400 dark:text-gray-500 hover:text-red-500 cursor-pointer"
          >
            <PersonDashFill size={12} />
          </button>
        )}
        {isLocal && <span className="text-gray-400 dark:text-gray-500 text-[10px]">You</span>}
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
