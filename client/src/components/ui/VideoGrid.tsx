import { useRef, useEffect, useState } from 'react';
import { MicMuteFill, CameraVideoOffFill, PipFill, VolumeUpFill, VolumeMuteFill, DisplayFill, RecordCircleFill, EyeSlashFill, CameraVideoFill } from 'react-bootstrap-icons';
import { ProximityPlayer, EmoteEvent, EMOTE_EMOJI } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';

// Most recent still-active emote for a given player/socket id, as the emoji
// to float over their video tile. Shares the in-world emote store, so the
// same 3s lifetime applies (see gameStore.removeExpiredEmotes / GameCanvas).
export function latestReaction(
  emoteEvents: EmoteEvent[],
  id: string | null,
  now: number,
): { emoji: string; ts: number } | null {
  if (!id) return null;
  let best: EmoteEvent | null = null;
  for (const e of emoteEvents) {
    if (e.playerId !== id) continue;
    if (now - e.timestamp >= 3000) continue;
    if (!best || e.timestamp > best.timestamp) best = e;
  }
  return best ? { emoji: EMOTE_EMOJI[best.emote] || '👍', ts: best.timestamp } : null;
}

interface VideoGridProps {
  nearby: ProximityPlayer[];
  localStream: MediaStream | null;
  localScreenStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  remoteScreenStreams: Map<string, MediaStream>;
  micMuted: boolean;
  cameraOff: boolean;
  onManualVolumeChange: (id: string, volume: number) => void;
  // §7 — set only when I'm allowed to know a recording is happening at all
  // (see recordingHandler.ts's per-socket RECORDING_STARTED emit); resolved
  // here from userId to socket id since that's how tiles are keyed.
  recordedTargetUserId?: string;
  isLocalBeingRecorded?: boolean;
}

// Shared with MeetingView.tsx (the "Dedicated Meeting View" full-screen
// layout) so both derive the exact same participant list from the exact
// same proximity/stream data — one filter rule, not two copies that could
// silently drift apart.
export function getVideoTiles(
  nearby: ProximityPlayer[],
  playerRecords: Record<string, { name: string; userId?: string; handRaised?: boolean }>,
  remoteStreams: Map<string, MediaStream>,
  remoteScreenStreams: Map<string, MediaStream>,
  recordedTargetUserId?: string,
) {
  // §6 — 'not_visible' peers get no tile at all (same as before); a
  // 'translucent' peer still gets one, just dimmed (see VideoTile's opacity).
  return nearby
    .filter((p) => p.visibility !== 'not_visible')
    .map((p) => ({
      id: p.id,
      name: playerRecords[p.id]?.name || 'Unknown',
      stream: remoteStreams.get(p.id)!,
      screenStream: remoteScreenStreams.get(p.id),
      translucent: p.visibility === 'translucent',
      isBeingRecorded: !!recordedTargetUserId && playerRecords[p.id]?.userId === recordedTargetUserId,
      handRaised: !!playerRecords[p.id]?.handRaised,
    }))
    .filter((t) => t.stream);
}

export function VideoGrid({ nearby, localStream, localScreenStream, remoteStreams, remoteScreenStreams, micMuted, cameraOff, onManualVolumeChange, recordedTargetUserId, isLocalBeingRecorded }: VideoGridProps) {
  const playerRecords = useGameStore((s) => s.playerRecords);
  const localHandRaised = useGameStore((s) => s.localPlayer.handRaised);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const emoteEvents = useGameStore((s) => s.emoteEvents);
  const videoTiles = getVideoTiles(nearby, playerRecords, remoteStreams, remoteScreenStreams, recordedTargetUserId);
  const [hidden, setHidden] = useState(false);
  const now = Date.now();

  const totalTiles = (localStream ? 1 : 0) + (localScreenStream ? 1 : 0) + videoTiles.length
    + videoTiles.filter((t) => t.screenStream).length;

  // Nothing to show (or nothing to hide) — same "don't render a control for
  // something that doesn't exist yet" rule the rest of the HUD follows.
  if (totalTiles === 0) return null;

  if (hidden) {
    return (
      <button
        onClick={() => setHidden(false)}
        title="Show camera tiles"
        className="absolute top-16 right-4 z-20 pointer-events-auto bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-purple-200 dark:border-gray-600 shadow-sm rounded-full px-2.5 py-1.5 flex items-center gap-1.5 text-xs text-purple-700 dark:text-purple-300 cursor-pointer hover:bg-white"
      >
        <CameraVideoFill size={12} /> {totalTiles}
      </button>
    );
  }

  return (
    <div className="absolute top-16 right-4 z-20 flex flex-col items-end gap-1.5 pointer-events-none">
      <button
        onClick={() => setHidden(true)}
        title="Hide camera tiles"
        className="pointer-events-auto w-6 h-6 rounded-full bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-purple-200 dark:border-gray-600 shadow-sm flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-purple-700 dark:hover:text-purple-300 cursor-pointer"
      >
        <EyeSlashFill size={11} />
      </button>
      {localStream && (
        <VideoTile name="You" stream={localStream} isLocal micMuted={micMuted} cameraOff={cameraOff} isBeingRecorded={isLocalBeingRecorded} handRaised={localHandRaised} reaction={latestReaction(emoteEvents, localPlayerId, now)} />
      )}
      {localScreenStream && (
        <VideoTile name="Your screen" stream={localScreenStream} isLocal isScreen />
      )}
      {videoTiles.map((tile) => (
        <VideoTile
          key={tile.id}
          name={tile.name}
          stream={tile.stream}
          isLocal={false}
          translucent={tile.translucent}
          onVolumeChange={(v) => onManualVolumeChange(tile.id, v)}
          isBeingRecorded={tile.isBeingRecorded}
          handRaised={tile.handRaised}
          reaction={latestReaction(emoteEvents, tile.id, now)}
        />
      ))}
      {videoTiles
        .filter((t) => t.screenStream)
        .map((tile) => (
          <VideoTile key={`${tile.id}-screen`} name={`${tile.name}'s screen`} stream={tile.screenStream!} isLocal={false} isScreen />
        ))}
    </div>
  );
}

// Exported for MeetingView.tsx (the "Dedicated Meeting View" full-screen
// grid) — same tile, just sized up via `large` instead of a second
// hand-maintained copy of the mirror/PIP/volume-slider logic.
export function VideoTile({
  name,
  stream,
  isLocal,
  micMuted,
  cameraOff,
  isScreen,
  translucent,
  onVolumeChange,
  isBeingRecorded,
  handRaised,
  reaction,
  large,
}: {
  name: string;
  stream: MediaStream;
  isLocal: boolean;
  micMuted?: boolean;
  cameraOff?: boolean;
  isScreen?: boolean;
  translucent?: boolean;
  onVolumeChange?: (volume: number) => void;
  isBeingRecorded?: boolean;
  handRaised?: boolean;
  reaction?: { emoji: string; ts: number } | null;
  large?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [volume, setVolume] = useState(1);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    video.play().catch(() => {});
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  const handlePip = () => {
    const video = videoRef.current;
    if (!video) return;
    if (document.pictureInPictureElement === video) {
      document.exitPictureInPicture().catch(() => {});
    } else {
      video.requestPictureInPicture?.().catch(() => {});
    }
  };

  return (
    <div
      className={`pointer-events-auto bg-white/90 backdrop-blur-sm rounded-lg overflow-hidden border border-purple-200 shadow-lg transition-all duration-300 animate-fade-in group relative ${large ? 'w-full' : 'w-24'}`}
      style={{ opacity: translucent ? 0.5 : 1 }}
    >
      {/* Mirror the LOCAL self-preview only — raising your right hand should
          show on the right side of YOUR OWN preview, same as a real mirror
          (every video call app does this for the self-view). Remote tiles
          and screen shares stay unmirrored. This is purely a browser-side
          style on the <video> element — it can't touch the actual
          MediaStreamTrack sent to WebRTC peers. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        style={{ transform: isLocal && !isScreen ? 'scaleX(-1)' : 'none' }}
        className={`w-full object-cover bg-purple-100 ${large ? 'h-full aspect-video' : 'h-16'}`}
      />
      {/* §6 — PIP, available on every tile (local or remote, camera or
          screen) via the standard requestPictureInPicture API; shown on
          hover so it doesn't clutter the small tile by default. */}
      <button
        onClick={handlePip}
        title="Picture-in-picture"
        className={`absolute top-0.5 right-0.5 rounded bg-black/50 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer ${large ? 'w-5 h-5' : 'w-4 h-4'}`}
      >
        <PipFill size={large ? 11 : 8} />
      </button>
      {isScreen && (
        <span className="absolute top-0.5 left-0.5 bg-black/50 text-white rounded p-0.5">
          <DisplayFill size={large ? 10 : 8} />
        </span>
      )}
      {/* Quick reaction — a single emoji floating up from the bottom-center
          of the tile, restarting whenever a newer reaction arrives (keyed by
          its timestamp). Shared with the in-world emote system, so a reaction
          here also shows above the avatar and vice-versa. */}
      {reaction && !isScreen && (
        <span
          key={reaction.ts}
          className={`absolute left-1/2 -translate-x-1/2 bottom-6 pointer-events-none select-none animate-reaction-float ${large ? 'text-4xl' : 'text-2xl'}`}
          style={{ textShadow: '0 1px 3px rgba(0,0,0,0.4)' }}
        >
          {reaction.emoji}
        </span>
      )}
      {/* Raised-hand cue — amber badge, top-left, gently waving so it draws
          the eye during a meeting (the whole point of "raise hand"). */}
      {handRaised && !isScreen && (
        <span
          className={`absolute left-0.5 bg-amber-400 text-white rounded-full shadow flex items-center justify-center animate-bounce ${isBeingRecorded ? 'top-6' : 'top-0.5'} ${large ? 'w-6 h-6 text-sm' : 'w-4 h-4 text-[10px]'}`}
          title={`${isLocal ? 'You have' : `${name} has`} raised a hand`}
        >
          ✋
        </span>
      )}
      {isBeingRecorded && (
        <span className="absolute top-0.5 left-0.5 bg-red-600/90 text-white text-[9px] font-bold rounded px-1 py-0.5 inline-flex items-center gap-0.5">
          <RecordCircleFill size={9} /> {large && 'REC'}
        </span>
      )}
      <div className={`flex items-center justify-between gap-1 ${large ? 'px-2 py-1 text-xs' : 'px-1 py-0.5 text-[10px]'}`}>
        <span className="text-gray-700 truncate flex-1">{name}</span>
        {isLocal && (
          <span className="flex gap-1 shrink-0">
            {micMuted && <MicMuteFill className="text-red-500" size={large ? 12 : 9} />}
            {cameraOff && <CameraVideoOffFill className="text-red-500" size={large ? 12 : 9} />}
          </span>
        )}
      </div>
      {/* §6 — manual per-listener volume, purely client-side (spec's own
          rule: no server sync needed, it's just my own listening preference).
          Not shown for screen-share tiles or my own tiles — screen share
          carries no audio track here, and muting yourself already has the
          mic button. */}
      {!isLocal && !isScreen && onVolumeChange && (
        <div className={`flex items-center gap-1 ${large ? 'px-2 pb-1.5 gap-1.5' : 'px-1 pb-1'}`}>
          {volume === 0 ? <VolumeMuteFill size={large ? 10 : 8} className="text-gray-400 shrink-0" /> : <VolumeUpFill size={large ? 10 : 8} className="text-gray-400 shrink-0" />}
          <input
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={volume}
            onChange={(e) => {
              const v = Number(e.target.value);
              setVolume(v);
              onVolumeChange(v);
            }}
            className="flex-1 accent-purple-600 h-1"
          />
        </div>
      )}
    </div>
  );
}
