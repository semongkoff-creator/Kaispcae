import { useRef, useEffect, useState } from 'react';
import { MicMuteFill, CameraVideoOffFill, PipFill, VolumeUpFill, VolumeMuteFill, DisplayFill, RecordCircleFill, EyeSlashFill, CameraVideoFill } from 'react-bootstrap-icons';
import { ProximityPlayer, EmoteEvent, EMOTE_EMOJI, Avatar } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { drawAvatar } from '@/components/canvas/AvatarSprite';

// Shown in place of a black rectangle when someone's camera is off — the
// same character they're walking around as, so a tile still says WHO is
// there. Reuses the canvas renderer the avatar editor previews with rather
// than a second drawing path that could drift from the in-world look.
function AvatarPlaceholder({ avatar, name }: { avatar?: Avatar; name: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const W = 96, H = 64;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    // Sprite parts load asynchronously, so a single draw can land before the
    // images are ready and freeze half-composed — the avatar editor hit this
    // exact problem and solved it with a loop; this needs the same.
    let raf = 0;
    const loop = (timestamp: number) => {
      ctx.clearRect(0, 0, W, H);
      drawAvatar(ctx, {
        avatar: avatar ?? { id: 'placeholder', name, x: 0, y: 0, direction: 'down', color: '#a78bfa', isMoving: false },
        x: W / 2,
        // y=20 puts drawAvatar's name pill (drawn at y-23, 14px tall) fully
        // above the canvas top, where it clips away — the tile already
        // prints the name underneath, and drawNameLabel has no empty-name
        // early return, so passing '' would leave a small black pill instead.
        y: 20,
        isLocal: false,
        walkAnimOffset: 0,
        timestamp,
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [avatar, name]);

  return <canvas ref={ref} className="w-full h-full object-contain bg-purple-100" />;
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

// A presented screen as its own floating, draggable panel — deliberately NOT
// a tile in the camera column. Previously both lived in one centred flex
// container, so enlarging the screen shoved the camera strip around and the
// two fought for the same space. Separate containers can't collide.
//
// The panel is a fixed 16:9 box with the video object-contain inside it. The
// earlier version set width from the viewport (82vw) but capped height
// independently, so box and content disagreed on aspect ratio: the video
// letterboxed correctly while the box around it stayed enormously wide.
function ScreenSharePanel({ name, stream, isLocal }: { name: string; stream: MediaStream; isLocal: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // null = "wherever CSS centres it". Only once dragged does it become real
  // coordinates, so the panel doesn't need to measure anything to appear.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const grab = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    video.play().catch(() => {});
    return () => { video.srcObject = null; };
  }, [stream]);

  const frame = () => {
    const el = boxRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    return el && parent ? { el, rect: el.getBoundingClientRect(), parent: parent.getBoundingClientRect() } : null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const f = frame();
    if (!f) return;
    // Convert the CSS-centred position into concrete coordinates on the first
    // grab, so the drag starts exactly where the panel already appears rather
    // than jumping.
    setPos({ x: f.rect.left - f.parent.left, y: f.rect.top - f.parent.top });
    grab.current = { dx: e.clientX - f.rect.left, dy: e.clientY - f.rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = grab.current;
    const f = frame();
    if (!g || !f) return;
    const w = f.el.offsetWidth;
    // Always leave a graspable strip on screen — a panel dragged fully out of
    // view could never be dragged back.
    const KEEP = 140;
    const x = Math.max(KEEP - w, Math.min(e.clientX - f.parent.left - g.dx, f.parent.width - KEEP));
    const y = Math.max(0, Math.min(e.clientY - f.parent.top - g.dy, f.parent.height - 36));
    setPos({ x, y });
  };

  const endDrag = (e: React.PointerEvent) => {
    grab.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const togglePip = () => {
    const video = videoRef.current;
    if (!video) return;
    if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
    else video.requestPictureInPicture?.().catch(() => {});
  };

  return (
    <div
      ref={boxRef}
      className="absolute z-30 pointer-events-auto w-[640px] max-w-[calc(100vw-2rem)] rounded-lg overflow-hidden border border-purple-200 dark:border-gray-600 shadow-xl bg-white/95 dark:bg-gray-800/95 backdrop-blur-sm animate-fade-in"
      style={pos ? { left: pos.x, top: pos.y } : { left: '50%', top: '45%', transform: 'translate(-50%, -50%)' }}
    >
      {/* Drag by the title bar only — grabbing the whole panel would make the
          PIP button and any future control impossible to click. */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="flex items-center gap-1.5 px-2 py-1 bg-purple-50 dark:bg-gray-700 cursor-move select-none touch-none"
      >
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
        <VideoTile name="You" stream={localStream} isLocal micMuted={micMuted} cameraOff={cameraOff} isBeingRecorded={isLocalBeingRecorded} handRaised={localHandRaised} reaction={latestReaction(emoteEvents, localPlayerId, now)} avatar={localPlayer} />
      )}
      {videoTiles.map((tile) => (
        <VideoTile
          key={tile.id}
          name={tile.name}
          stream={tile.stream}
          isLocal={false}
          avatar={playerRecords[tile.id]}
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
  avatar,
}: {
  name: string;
  stream: MediaStream;
  isLocal: boolean;
  avatar?: Avatar;
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
          <AvatarPlaceholder avatar={avatar} name={name} />
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
