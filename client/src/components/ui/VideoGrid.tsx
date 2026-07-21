import { useRef, useEffect, useState } from 'react';
import { MicMuteFill, CameraVideoOffFill, PipFill, VolumeUpFill, VolumeMuteFill, DisplayFill, RecordCircleFill, EyeSlashFill, CameraVideoFill } from 'react-bootstrap-icons';
import { ProximityPlayer, EmoteEvent, EMOTE_EMOJI } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';

// Accent colours for initial bubbles, drawn from the palette already used
// across MeetKai (the purple the HUD is built on, plus the teal/amber/rose
// used for zones, badges and alerts) so a tile never introduces a colour the
// rest of the app doesn't use.
const INITIAL_COLORS = ['#7c3aed', '#0d9488', '#d97706', '#e11d48', '#4f46e5', '#059669'];

// Same name → same colour, on every screen, for the whole session. A random
// pick would give the same person a different colour in each viewer's window,
// which quietly destroys the "colour helps me recognise who this is" benefit
// that is the entire reason for colouring them at all.
function colorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return INITIAL_COLORS[hash % INITIAL_COLORS.length];
}

// One letter from a single-word name, first + last for a full name.
// Array.from (not [0]) because indexing a string splits surrogate pairs —
// an emoji or non-Latin name would render as half a broken character.
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0])[0] ?? '?';
  if (words.length === 1) return first.toUpperCase();
  const last = Array.from(words[words.length - 1])[0] ?? '';
  return (first + last).toUpperCase();
}

// What a tile shows while someone's camera is off. Replaces an earlier
// attempt that drew their in-world pixel character here: on the map that
// sprite IS the person, but shrunk into a 96px tile next to real webcam
// video it read as decoration rather than as "this is who is here".
//
// No photo branch exists because there is no photo to show — the User model
// has avatarConfig (pixel-avatar parts) and no image field anywhere in the
// schema. When profile photos are added, they slot in above the initials as
// the preferred case; nothing here needs restructuring for that.
function InitialsAvatar({ name, large }: { name: string; large?: boolean }) {
  const initials = initialsOf(name);
  return (
    <div className="w-full h-full flex items-center justify-center bg-gray-100 dark:bg-gray-700">
      <div
        className={`rounded-full flex items-center justify-center font-semibold text-white select-none ${large ? 'w-20 h-20 text-2xl' : 'w-9 h-9 text-xs'}`}
        style={{ backgroundColor: colorForName(name) }}
        title={name}
      >
        {initials}
      </div>
    </div>
  );
}

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

// A presented screen as its own panel, pinned in place — deliberately NOT a
// tile in the camera column. Previously both lived in one centred flex
// container, so enlarging the screen shoved the camera strip around and the
// two fought for the same space. Separate containers can't collide.
//
// Position is FIXED and not draggable: during a presentation everyone should
// be looking at the same thing in the same place, and a panel each viewer has
// nudged somewhere different is just clutter. An earlier version made it
// draggable; that was reversed deliberately, so don't reintroduce it without
// the same decision being made again.
//
// The panel is a fixed 16:9 box with the video object-contain inside it. An
// even earlier version set width from the viewport (82vw) but capped height
// independently, so box and content disagreed on aspect ratio: the video
// letterboxed correctly while the box around it stayed enormously wide.
function ScreenSharePanel({ name, stream, isLocal }: { name: string; stream: MediaStream; isLocal: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    video.play().catch(() => {});
    return () => { video.srcObject = null; };
  }, [stream]);

  const togglePip = () => {
    const video = videoRef.current;
    if (!video) return;
    if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
    else video.requestPictureInPicture?.().catch(() => {});
  };

  return (
    <div
      // Pinned top-centre. The 9rem cap is not arbitrary: the camera column
      // is a 6rem-wide rail at right-4, so anything wider would slide under
      // the participant tiles on a narrow window — the exact "participants
      // covering the screen" this layout exists to prevent. top-16 clears the
      // HUD strip along the top edge.
      className="absolute z-30 top-16 left-1/2 -translate-x-1/2 pointer-events-auto w-[min(640px,calc(100vw-9rem))] rounded-lg overflow-hidden border border-purple-200 dark:border-gray-600 shadow-xl bg-white/95 dark:bg-gray-800/95 backdrop-blur-sm animate-fade-in"
    >
      {/* A label, not a handle — the panel does not move. */}
      <div className="flex items-center gap-1.5 px-2 py-1 bg-purple-50 dark:bg-gray-700 select-none">
        <DisplayFill size={10} className="text-purple-600 dark:text-purple-300 shrink-0" />
        <span className="text-[11px] text-gray-700 dark:text-gray-200 truncate flex-1">{name}</span>
        <button onClick={togglePip} title="Picture-in-picture" className="shrink-0 text-gray-500 hover:text-purple-700 dark:hover:text-purple-300 cursor-pointer">
          <PipFill size={10} />
        </button>
      </div>
      {/* aspect-video locks the box; object-contain fits any incoming screen
          ratio inside it, letterboxed on black rather than cropped. */}
      <div className="relative w-full aspect-video bg-black">
        <video ref={videoRef} autoPlay playsInline muted={isLocal} className="absolute inset-0 w-full h-full object-contain" />
      </div>
    </div>
  );
}

export function VideoGrid({ nearby, localStream, localScreenStream, remoteStreams, remoteScreenStreams, micMuted, cameraOff, onManualVolumeChange, recordedTargetUserId, isLocalBeingRecorded }: VideoGridProps) {
  const playerRecords = useGameStore((s) => s.playerRecords);
  const localPlayer = useGameStore((s) => s.localPlayer);
  const localHandRaised = localPlayer.handRaised;
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const emoteEvents = useGameStore((s) => s.emoteEvents);
  const videoTiles = getVideoTiles(nearby, playerRecords, remoteStreams, remoteScreenStreams, recordedTargetUserId);
  const [hidden, setHidden] = useState(false);
  // Which shared screen is the big one. Null = "whichever is first", so a
  // share that starts while nothing is featured is promoted automatically.
  const [featuredKey, setFeaturedKey] = useState<string | null>(null);
  const now = Date.now();

  // Local and remote shares merged into ONE list, because from the viewer's
  // side they're the same kind of thing — content someone is presenting —
  // and only their prominence should differ, not their source.
  const screenEntries: { key: string; name: string; stream: MediaStream; isLocal: boolean }[] = [];
  if (localScreenStream) {
    screenEntries.push({ key: 'local-screen', name: 'Layar Anda', stream: localScreenStream, isLocal: true });
  }
  for (const t of videoTiles) {
    if (t.screenStream) screenEntries.push({ key: `${t.id}-screen`, name: `Layar ${t.name}`, stream: t.screenStream, isLocal: false });
  }

  // Resolved every render rather than stored: when the featured presenter
  // stops sharing (or walks out of range) their key simply stops matching and
  // the next share takes over. Holding it in state would strand the layout on
  // a stream that no longer exists until something else forced an update.
  const featured = screenEntries.find((s) => s.key === featuredKey) ?? screenEntries[0] ?? null;
  const otherScreens = screenEntries.filter((s) => s.key !== featured?.key);

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

  const hideButton = (
    <button
      onClick={() => setHidden(true)}
      title="Hide camera tiles"
      className="pointer-events-auto w-6 h-6 rounded-full bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-purple-200 dark:border-gray-600 shadow-sm flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-purple-700 dark:hover:text-purple-300 cursor-pointer"
    >
      <EyeSlashFill size={11} />
    </button>
  );

  // Identical in both layouts — only where they sit changes, never what they
  // are, so there's no second copy to keep in sync.
  const cameraTiles = (
    <>
      {localStream && (
        <VideoTile name="You" stream={localStream} isLocal micMuted={micMuted} cameraOff={cameraOff} isBeingRecorded={isLocalBeingRecorded} handRaised={localHandRaised} reaction={latestReaction(emoteEvents, localPlayerId, now)} />
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
    </>
  );

  // The camera column keeps its original place and shape whether or not
  // anyone is presenting — the screen lives in its own floating panel, so
  // there is nothing left for the two to fight over.
  return (
    <>
      {featured && (
        <ScreenSharePanel key={featured.key} name={featured.name} stream={featured.stream} isLocal={featured.isLocal} />
      )}
      <div className="absolute top-16 right-4 z-20 flex flex-col items-end gap-1.5 pointer-events-none">
        {hideButton}
        {/* A second simultaneous share stays a thumbnail here; clicking it
            promotes it into the floating panel. Rare, but silently hiding
            someone's presentation would be worse. */}
        {otherScreens.map((s) => (
          <div
            key={s.key}
            onClick={() => setFeaturedKey(s.key)}
            title={`Tampilkan ${s.name}`}
            className="pointer-events-auto cursor-pointer hover:opacity-80 transition-opacity"
          >
            <VideoTile name={s.name} stream={s.stream} isLocal={s.isLocal} isScreen />
          </div>
        ))}
        {cameraTiles}
      </div>
    </>
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
  // A remote peer who turns their camera off doesn't remove the track — it
  // stays attached and goes 'muted', which is the only signal we get. No
  // extra socket event needed, and it also covers "no video track at all"
  // (the audio-only fallback when someone's camera was already in use).
  const [remoteVideoOff, setRemoteVideoOff] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    video.play().catch(() => {});
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  useEffect(() => {
    if (isLocal) return;
    const track = stream.getVideoTracks()[0];
    if (!track) { setRemoteVideoOff(true); return; }
    const sync = () => setRemoteVideoOff(track.muted);
    sync();
    track.addEventListener('mute', sync);
    track.addEventListener('unmute', sync);
    return () => {
      track.removeEventListener('mute', sync);
      track.removeEventListener('unmute', sync);
    };
  }, [stream, isLocal]);

  // Screen shares are exempt: a paused screen share is still the screen, and
  // showing someone's walking avatar in place of it would be misleading.
  const showAvatar = !isScreen && (isLocal ? !!cameraOff : remoteVideoOff);

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
        // object-COVER crops to fill, which is right for a face but wrong for
        // a screen — it would slice off whatever sits at the edges of the
        // presenter's display, usually the toolbars and text people are
        // actually pointing at. Screens get object-contain on black, letting
        // the whole frame through whatever its aspect ratio.
        className={
          isScreen
            ? `w-full object-contain bg-black ${large ? 'max-h-[58vh]' : 'h-16'}`
            : `w-full object-cover bg-purple-100 ${large ? 'h-full aspect-video' : 'h-16'}`
        }
      />
      {/* Covers the video box (which stays mounted and playing underneath, so
          turning the camera back on is instant) rather than unmounting it —
          a black rectangle tells you nothing, the avatar tells you who. */}
      {showAvatar && (
        <div className={`absolute top-0 left-0 right-0 ${large ? 'aspect-video' : 'h-16'}`}>
          <InitialsAvatar name={name} large={large} />
        </div>
      )}
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
