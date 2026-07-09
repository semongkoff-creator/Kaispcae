import { useEffect, useRef, useState } from 'react';
import { PeopleFill, CameraVideoFill, ChevronUp, ChevronDown, PersonWalking, MagnetFill, StarFill, X } from 'react-bootstrap-icons';
import { roleAtLeast } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';

interface ParticipantPanelProps {
  remoteStreams: Map<string, MediaStream>;
  emitFollowRequest: (targetUserId: string) => void;
  emitFollowUnfollow: () => void;
  emitSummonUser: (nickname: string) => void;
  emitSpotlightToggle: (targetUserId: string) => void;
}

const MAX_VIDEO_THUMBS = 3;

export function ParticipantPanel({ remoteStreams, emitFollowRequest, emitFollowUnfollow, emitSummonUser, emitSpotlightToggle }: ParticipantPanelProps) {
  const [open, setOpen] = useState(false);
  const playerRecords = useGameStore((s) => s.playerRecords);
  const localPlayer = useGameStore((s) => s.localPlayer);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const followInfo = useGameStore((s) => s.followInfo);
  const followerUserIds = useGameStore((s) => s.followerUserIds);
  const spotlightedUserIds = useGameStore((s) => s.spotlightedUserIds);
  const canModerate = roleAtLeast(useGameStore((s) => s.localRole), 'staff');

  const remotePlayers = Object.values(playerRecords);
  const totalOnline = remotePlayers.length + 1;

  const videoActive = remotePlayers.filter((p) => remoteStreams.has(p.id));
  const videoThumbs = videoActive.slice(0, MAX_VIDEO_THUMBS);
  const videoOverflowCount = videoActive.length - videoThumbs.length;

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        className="absolute top-14 left-16 z-40 bg-white/90 backdrop-blur-sm px-3 py-2 rounded-lg text-xs text-purple-700 hover:text-purple-800 border border-purple-200 shadow-sm cursor-pointer pointer-events-auto inline-flex items-center gap-1.5"
      >
        <PeopleFill size={13} /> {totalOnline} {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
      </button>

      {open && (
        <div
          className="absolute top-24 left-16 z-40 w-56 max-h-[60vh] bg-white/95 backdrop-blur-md rounded-xl border border-purple-100 shadow-2xl flex flex-col pointer-events-auto"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="p-3 border-b border-purple-100 flex items-center justify-between">
            <span className="text-gray-900 text-sm font-medium">Participants</span>
            <span className="text-gray-400 text-xs">{totalOnline} online</span>
          </div>

          {videoThumbs.length > 0 && (
            <div className="p-2 border-b border-purple-100 flex gap-1.5 flex-wrap">
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
                isLocal={false}
                inCall={remoteStreams.has(p.id)}
                isFollowingThem={!!p.userId && followInfo?.targetUserId === p.userId}
                onFollow={p.userId ? () => emitFollowRequest(p.userId!) : undefined}
                onUnfollow={emitFollowUnfollow}
                onSummon={canModerate ? () => emitSummonUser(p.name) : undefined}
                isSpotlighted={!!p.userId && spotlightedUserIds.includes(p.userId)}
                onSpotlight={canModerate && p.userId ? () => emitSpotlightToggle(p.userId!) : undefined}
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
  status,
  isLocal,
  inCall,
  followerCount,
  isFollowingThem,
  onFollow,
  onUnfollow,
  onSummon,
  isSpotlighted,
  onSpotlight,
}: {
  name: string;
  color: string;
  status?: string;
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
}) {
  return (
    <div className="flex items-center justify-between px-2 py-1 rounded bg-purple-50/50">
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
        <div className="min-w-0">
          <span className="text-gray-700 text-xs truncate block">{name}</span>
          {status && <span className="text-gray-400 text-[10px] truncate block">{status}</span>}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
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
                className="text-gray-400 hover:text-purple-600 cursor-pointer"
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
            className="text-gray-400 hover:text-purple-600 cursor-pointer"
          >
            <MagnetFill size={12} />
          </button>
        )}
        {!isLocal && onSpotlight && (
          <button
            onClick={onSpotlight}
            title={isSpotlighted ? `Remove spotlight from ${name}` : `Spotlight ${name} (visible to everyone regardless of distance)`}
            className={`cursor-pointer ${isSpotlighted ? 'text-amber-500' : 'text-gray-400 hover:text-amber-500'}`}
          >
            <StarFill size={12} />
          </button>
        )}
        {isLocal && <span className="text-gray-400 text-[10px]">You</span>}
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
