import { useRef, useEffect, useState, useMemo, memo } from 'react';
import { MicMuteFill, CameraVideoOffFill, ArrowsFullscreen, FullscreenExit, PlusLg, DashLg, ArrowCounterclockwise, XLg, VolumeUpFill, VolumeMuteFill, DisplayFill, RecordCircleFill, EyeSlashFill, CameraVideoFill, WifiOff, Grid3x3GapFill } from 'react-bootstrap-icons';
import { ProximityPlayer, EmoteEvent, EMOTE_EMOJI } from '@kaispace/shared';
import { useGameStore } from '@/stores/gameStore';
import { useProfiles } from '@/hooks/useProfiles';
import { Tooltip } from '@/components/ui/Tooltip';
import { ChatAvatar, avatarColor } from './ChatAvatar';

// autoPictureInPicture (part of the Picture-in-Picture spec — tells the
// browser to auto-float this element into native PiP when the tab/app is
// hidden while it's playing, no fresh user gesture needed at that moment)
// isn't in this project's TS DOM lib yet. Same pattern MiniMode.tsx already
// uses for window.documentPictureInPicture — augment the real DOM type
// rather than reaching for `as any` at every call site.
declare global {
  interface HTMLVideoElement {
    autoPictureInPicture: boolean;
  }
}

// What a tile shows while someone's camera is off — the SAME ChatAvatar used in
// chat, so it shows the person's profile photo when they have one and otherwise
// their real-name initials. `name` here must be the REAL name (never a display
// label like "Kamu"); the caller passes the label separately for the corner
// text. Centered on a neutral backdrop, sized up on the large (Meeting View) path.
function TileAvatar({ name, photoUrl, large }: { name: string; photoUrl?: string; large?: boolean }) {
  return (
    <div className="w-full h-full flex items-center justify-center bg-gray-100 dark:bg-gray-700">
      {/* Wrapper div so ChatAvatar's own `self-end` doesn't bottom-align it. */}
      <div className="flex">
        <ChatAvatar name={name} color={avatarColor(name)} photoUrl={photoUrl} size={large ? 88 : 36} />
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
  // QA (Fallback checklist item 9) — ids whose WebRTC connection failed
  // permanently (see useWebRTC's failedPeers). A peer in here still gets a
  // tile (same as any other nearby player) but VideoTile shows a
  // "connection lost" badge over it instead of a silently frozen picture.
  failedPeerIds?: Set<string>;
  // Peers whose incoming screen-share frames have stalled (see useWebRTC's
  // screenStalledPeers) — ICE is still nominally connected, but no new
  // frames arrived on the last tick. Distinct from failedPeerIds above:
  // this is "actively trying to recover" (restartIce() in progress), not a
  // permanent failure, so it gets its own "Menyambung ulang..." overlay
  // rather than the connection-lost badge.
  screenStalledPeerIds?: Set<string>;
  // Meeting View entry point — moved here from Sidebar's Room Features
  // dropdown to sit next to the hide/show camera-tiles toggle instead.
  // VideoGrid only ever renders while Meeting View is NOT active, so this
  // is always the "enter" direction; exiting uses MeetingView's own close
  // button.
  onToggleMeetingView: () => void;
  // "Layar Penuh" is a true edge-to-edge takeover now (see ScreenSharePanel's
  // own doc comment) — the bottom HUD toolbar lives in App.tsx, outside this
  // component entirely, so hiding it while maximized needs to bubble all the
  // way up rather than stopping at this component's own local `hidden`
  // state (which only ever controlled the camera-tile rail here).
  onScreenShareMaximizedChange?: (maximized: boolean) => void;
}

// Shared with MeetingView.tsx (the "Dedicated Meeting View" full-screen
// layout) so both derive the exact same participant list from the exact
// same proximity/stream data — one filter rule, not two copies that could
// silently drift apart.
export function getVideoTiles(
  nearby: ProximityPlayer[],
  playerRecords: Record<string, { name: string; userId?: string; handRaised?: boolean; isGuest?: boolean }>,
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
      stream: remoteStreams.get(p.id),
      screenStream: remoteScreenStreams.get(p.id),
      translucent: p.visibility === 'translucent',
      isBeingRecorded: !!recordedTargetUserId && playerRecords[p.id]?.userId === recordedTargetUserId,
      handRaised: !!playerRecords[p.id]?.handRaised,
      // QA (Akses tamu checklist item 6, "Label Guest") — already shown in
      // ParticipantPanel; video tiles never carried it, even though a tile is
      // the more likely thing someone glances at mid-meeting.
      isGuest: !!playerRecords[p.id]?.isGuest,
    }));
    // Deliberately NOT filtered by stream any more. A nearby player must show
    // the moment they're in range — as live video if it's flowing, or as an
    // initials tile if their camera is off or their media hasn't connected
    // yet. The old `.filter((t) => t.stream)` made anyone without a live
    // camera track invisible in the column even while standing right next to
    // you, which read as "proximity isn't working". VideoTile renders the
    // initials avatar whenever stream is absent (see its showAvatar).
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
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;

// Also doubles as the enlarged-camera focus panel (see VideoGrid's
// cameraEntries/onEnlarge) — same zoom/pan/maximize behavior works just as
// well for zooming into a face as it does a shared screen, so this one panel
// covers both rather than a second hand-maintained copy.
function ScreenSharePanel({ name, stream, isLocal, mirror, onClose, onMaximizedChange, stalled }: { name: string; stream: MediaStream; isLocal: boolean; mirror?: boolean; onClose: () => void; onMaximizedChange?: (maximized: boolean) => void; stalled?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [maximized, setMaximizedState] = useState(false);
  // Wraps setMaximized so every path that changes it (the button below, and
  // Escape) also tells the parent — VideoGrid uses this to auto-hide the
  // camera-tile rail while the share fills the screen, since a tile column
  // still floating over a "Layar Penuh" share defeats the point of maximizing.
  const setMaximized = (next: boolean | ((prev: boolean) => boolean)) => {
    setMaximizedState((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      onMaximizedChange?.(v);
      return v;
    });
  };
  // Purely local magnification of the shared picture. Nothing is sent
  // anywhere: the presenter and everyone else keep seeing their own view at
  // their own zoom.
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    // Same auto-PiP-on-tab-hide as every tile's own video (see VideoTile's
    // doc comment) — the featured/big panel is still just a <video>
    // underneath, so it gets the same treatment.
    video.autoPictureInPicture = true;
    video.play().catch(() => {});
    return () => { video.srcObject = null; };
  }, [stream]);

  // A different presenter's screen is a different picture — carrying the
  // previous one's zoom and pan across would drop the viewer into a random
  // corner of a screen they've never seen.
  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, [stream]);

  // How far the content may be dragged before its edge would come inside the
  // frame. The video fills the box, so each side overflows by half the excess.
  const clampOffset = (x: number, y: number, z: number) => {
    const box = boxRef.current;
    if (!box || z <= 1) return { x: 0, y: 0 };
    const maxX = (box.clientWidth * (z - 1)) / 2;
    const maxY = (box.clientHeight * (z - 1)) / 2;
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
  };

  const applyZoom = (nextZ: number, anchorX: number, anchorY: number) => {
    setZoom((prevZ) => {
      const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZ));
      // Keeps whatever sits under the anchor point pinned in place, so
      // zooming aims at what you're pointing at instead of always the middle.
      setOffset((prev) => {
        if (z === 1) return { x: 0, y: 0 };
        const ratio = z / prevZ;
        return clampOffset(anchorX - (anchorX - prev.x) * ratio, anchorY - (anchorY - prev.y) * ratio, z);
      });
      return z;
    });
  };

  // Attached natively with passive:false rather than via React's onWheel.
  // React registers wheel listeners passively, which makes preventDefault a
  // no-op — the zoom would work but the page would scroll underneath it at
  // the same time.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = box.getBoundingClientRect();
      // Anchor measured from the box's centre, because that's the origin the
      // transform scales around.
      const ax = e.clientX - r.left - r.width / 2;
      const ay = e.clientY - r.top - r.height / 2;
      setZoom((prevZ) => {
        const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prevZ * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        setOffset((prev) => {
          if (z === 1) return { x: 0, y: 0 };
          const ratio = z / prevZ;
          return clampOffset(ax - (ax - prev.x) * ratio, ay - (ay - prev.y) * ratio, z);
        });
        return z;
      });
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, []);

  // Panning the CONTENT. Deliberately hung off the video box, never the title
  // bar — the panel itself must stay pinned, and a drag that sometimes moved
  // the window and sometimes the picture would be worse than neither.
  const pan = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    // Nothing to pan at 1× — the picture already fits. Starting a drag here
    // would just look broken.
    if (zoom <= 1) return;
    pan.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = pan.current;
    if (!p) return;
    setOffset(clampOffset(e.clientX - p.x, e.clientY - p.y, zoom));
  };

  const endPan = (e: React.PointerEvent) => {
    pan.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  // Escape leaves the enlarged view. Anything that takes over most of the
  // screen needs a way out that doesn't depend on finding a small button.
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMaximized(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [maximized]);

  // Same control row, rendered two ways: a normal light bar that takes its
  // own row when the panel is its usual size, or floated as a semi-
  // transparent dark overlay ON TOP of the video when maximized — "Layar
  // Penuh" otherwise still lost its top rows to a dedicated title bar, which
  // read as the picture not actually reaching the top. One function so the
  // onClick handlers only exist once, never duplicated between the two.
  const renderControls = (variant: 'light' | 'dark') => {
    const dim = variant === 'dark'
      ? 'text-white/70 hover:text-white hover:bg-white/20'
      : 'text-gray-500 hover:text-purple-700 dark:text-gray-300 dark:hover:text-purple-300 hover:bg-purple-100 dark:hover:bg-gray-600';
    return (
      <>
        <DisplayFill size={10} className={`shrink-0 ${variant === 'dark' ? 'text-white/80' : 'text-purple-600 dark:text-purple-300'}`} />
        <span className={`text-[11px] truncate flex-1 ${variant === 'dark' ? 'text-white/90' : 'text-gray-700 dark:text-gray-200'}`}>{name}</span>
        {/* Only shown once it's actually zoomed — at 100% there is nothing to
            explain, and a permanent "100%" badge would just be noise. */}
        {zoom > 1 && (
          <span className={`shrink-0 text-[10px] font-medium tabular-nums ${variant === 'dark' ? 'text-white/90' : 'text-purple-700 dark:text-purple-300'}`}>
            {Math.round(zoom * 100)}%
          </span>
        )}
        <Tooltip label="Perkecil" detail="Perkecil tampilan konten ini.">
          <button
            onClick={() => applyZoom(zoom / 1.25, 0, 0)}
            disabled={zoom <= MIN_ZOOM}
            className={`shrink-0 cursor-pointer p-0.5 rounded disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent ${dim}`}
          >
            <DashLg size={12} />
          </button>
        </Tooltip>
        <Tooltip label="Perbesar" detail="Perbesar tampilan konten ini.">
          <button
            onClick={() => applyZoom(zoom * 1.25, 0, 0)}
            disabled={zoom >= MAX_ZOOM}
            className={`shrink-0 cursor-pointer p-0.5 rounded disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent ${dim}`}
          >
            <PlusLg size={12} />
          </button>
        </Tooltip>
        {zoom > 1 && (
          <Tooltip label="Ukuran 100%" detail="Kembalikan zoom ke ukuran normal.">
            <button
              onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}
              className={`shrink-0 cursor-pointer p-0.5 rounded ${dim}`}
            >
              <ArrowCounterclockwise size={12} />
            </button>
          </Tooltip>
        )}
        {/* Named for what it does. It used to say "Perbesar", which collided
            with the enlarge button on the thumbnail — two different actions
            wearing the same word. */}
        <Tooltip label="Layar Penuh" detail="Perbesar panel ini agar memenuhi layar, atau kembali ke ukuran biasa.">
          <button
            onClick={() => setMaximized((v) => !v)}
            className={`shrink-0 cursor-pointer p-0.5 rounded ${dim}`}
          >
            {maximized ? <FullscreenExit size={12} /> : <ArrowsFullscreen size={12} />}
          </button>
        </Tooltip>
        {/* Back to a thumbnail. Without this there is no way out of the focus
            panel short of the presenter stopping — a dead end the spec
            explicitly forbids. */}
        <Tooltip label="Tutup" detail="Tutup panel dan kembali ke kolom peserta.">
          <button
            onClick={onClose}
            className={`shrink-0 cursor-pointer p-0.5 rounded ${variant === 'dark' ? 'text-white/70 hover:text-red-300 hover:bg-white/20' : 'text-gray-500 hover:text-red-500 dark:text-gray-300 hover:bg-red-50 dark:hover:bg-gray-600'}`}
          >
            <XLg size={11} />
          </button>
        </Tooltip>
      </>
    );
  };

  return (
    <div
      // Non-maximized: pinned top-centre, filling the space between the left
      // nav rail, the top edge, and the HUD toolbar at the bottom.
      //
      // bottom-24 (6rem), not a near-zero inset — the bottom HUD toolbar
      // (App.tsx, absolute bottom-6, z-50) sits above this panel (z-30) and
      // stays clickable regardless, but a panel reaching past it put the
      // toolbar pill floating on top of the picture instead of sitting
      // cleanly below it. bottom-20 (the same clearance the BGM area control
      // reserves for this same toolbar elsewhere in App.tsx) was tried first
      // but measured 2px short with the toolbar's actual rendered height —
      // bottom-24 leaves real margin instead of a knife-edge fit.
      // Centred with left-0 right-0 mx-auto, NOT left-1/2 + -translate-x-1/2.
      // animate-fade-in animates `transform`, and its `both` fill-mode makes
      // the final keyframe stick permanently — an animation beats a normal
      // declaration in the cascade, so translateY(0) silently wiped out the
      // -50% horizontal shift. The panel kept left:50% with no shift back,
      // putting its LEFT EDGE at screen centre and hanging off to the right.
      // Auto margins centre it without touching transform at all, so the two
      // can't fight.
      //
      // left-14, not a symmetric inset: the left nav (Sidebar.tsx) is a
      // w-12 (48px) z-50 rail that sits ON TOP of this z-30 panel, so a
      // flush-left panel had its title and left edge hidden under it and the
      // visible picture pushed off-centre. Clearing 56px on the left puts the
      // panel in the space actually visible beside the rail.
      //
      // Maximized: true edge-to-edge (inset-0, no rounded corners) — "bener-
      // bener full screen kayak nonton YouTube" on request, not just a
      // bigger panel with the same margins. This only works cleanly because
      // onMaximizedChange now also hides BOTH the sidebar rail and the HUD
      // toolbar (see App.tsx's screenShareMaximized) — with either of those
      // still rendered at their z-50, inset-0 would just put them back to
      // floating on top of the picture, the exact bug the non-maximized
      // clearances above exist to avoid.
      className={`absolute z-30 flex flex-col pointer-events-auto overflow-hidden border border-purple-200 dark:border-gray-600 shadow-xl bg-white/95 dark:bg-gray-800/95 backdrop-blur-sm animate-fade-in ${
        maximized
          ? 'inset-0 rounded-none border-0'
          : 'left-14 right-2 top-1 bottom-24 rounded-lg'
      }`}
    >
      {/* A label, not a handle — the panel does not move. Only takes its own
          row in the non-maximized size; maximized floats the identical
          controls on top of the video instead (below), so "Layar Penuh"
          actually gives the picture the full height rather than losing a row
          of it to a title bar. */}
      {!maximized && (
        <div className="flex items-center gap-1.5 px-2 py-1 bg-purple-50 dark:bg-gray-700 select-none">
          {renderControls('light')}
        </div>
      )}
      {/* flex-1 lets the box fill whatever height the panel has left after the
          title bar — or, maximized, the WHOLE panel, since there's no title
          row sibling left to share it with (the 16:9 aspect-lock is gone —
          see the panel comment); object-contain fits any incoming screen
          ratio inside it, letterboxed on black rather than cropped.
          overflow-hidden turns it into the viewport the zoomed picture is
          seen through — without it a magnified
          screen would spill over the panel's edges. */}
      <div
        ref={boxRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        // The cursor is the only hint that dragging does anything, so it
        // appears exactly when panning is possible and not before.
        className={`relative w-full flex-1 min-h-0 bg-black overflow-hidden ${
          zoom > 1 ? (pan.current ? 'cursor-grabbing' : 'cursor-grab') : ''
        }`}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          // The transform lives on the VIDEO, never on the panel — the panel
          // itself stays pinned, so magnifying the content can't become a way
          // to move the window. At zoom 1 this is the identity transform, so
          // object-contain and the aspect ratio behave exactly as before.
          // object-top, not the object-contain default of centered: when the
          // shared window's ratio doesn't match the box, the leftover space
          // used to split evenly above AND below the picture — a visible gap
          // at the top even after the title-bar row was removed (maximized).
          // Anchoring to the top puts all of that leftover space at the
          // bottom instead, where a screen share's actual content (browser
          // chrome, the app being shown) is never sitting anyway.
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})${mirror ? ' scaleX(-1)' : ''}` }}
          className="absolute inset-0 w-full h-full object-contain object-top"
        />
        {/* Screen-share stall recovery — sits over whatever frame the video
            froze on (never unmounted, so the moment frames resume this just
            disappears again) instead of leaving a silently frozen/black
            picture with no explanation. See webrtcService's
            checkScreenStall/attemptScreenRecovery. */}
        {stalled && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/55 text-white pointer-events-none">
            <span className="w-8 h-8 rounded-full border-2 border-white/40 border-t-white animate-spin" />
            <span className="text-sm font-medium">Menyambung ulang...</span>
          </div>
        )}
        {/* The title bar's replacement while maximized — floats over the
            video (z-10, semi-transparent so the picture still reads through
            behind it) instead of pushing it down a row. */}
        {maximized && (
          <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-1.5 px-2 py-1 bg-black/55 backdrop-blur-sm select-none">
            {renderControls('dark')}
          </div>
        )}
      </div>
    </div>
  );
}

export function VideoGrid({ nearby, localStream, localScreenStream, remoteStreams, remoteScreenStreams, micMuted, cameraOff, onManualVolumeChange, recordedTargetUserId, isLocalBeingRecorded, failedPeerIds, screenStalledPeerIds, onToggleMeetingView, onScreenShareMaximizedChange }: VideoGridProps) {
  const playerRecords = useGameStore((s) => s.playerRecords);
  const localPlayer = useGameStore((s) => s.localPlayer);
  const localHandRaised = localPlayer.handRaised;
  // Speaking state (same source GameCanvas uses to ring an avatar on the
  // map) is deliberately NOT read here any more — VideoTile now selects its
  // own speakingId/isLocal slice directly (see its doc comment), so this
  // component doesn't re-render, and hence doesn't re-render every tile in
  // the grid, every time anyone's speaking status changes.
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const localUserId = useGameStore((s) => s.localUserId);
  const emoteEvents = useGameStore((s) => s.emoteEvents);
  const videoTiles = getVideoTiles(nearby, playerRecords, remoteStreams, remoteScreenStreams, recordedTargetUserId);

  // Profile photos for the camera-off avatars — same source/pattern as
  // MeetingView.tsx's identical fix (Bug 16): resolved by userId via the
  // shared chat identity cache, so a tile shows the person's real photo and
  // real-name initials instead of the corner label ("You") initialing to "Y".
  const profileIds = useMemo(() => {
    const ids = [localUserId];
    for (const t of videoTiles) { const uid = playerRecords[t.id]?.userId; if (uid) ids.push(uid); }
    return ids.filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localUserId, videoTiles.map((t) => t.id).join(','), playerRecords]);
  const profiles = useProfiles(profileIds);
  const [hidden, setHidden] = useState(false);
  // Which shared screen is the big one. Null = "whichever is first", so a
  // share that starts while nothing is featured is promoted automatically.
  // Which shared screen (or enlarged camera) is the big one — manual only.
  // Reverted the brief ZEP-style "auto-feature the first incoming share"
  // behavior on request: it read as the picture barging over the HUD
  // toolbar uninvited rather than a helpful "look here". Enlarging is a
  // deliberate click (the thumbnail's "Perbesar" button below, or a tile's
  // own onEnlarge) — a screen share simply joins the thumbnail rail like
  // camera tiles do until someone asks to feature it.
  const [featuredKey, setFeaturedKey] = useState<string | null>(null);
  const now = Date.now();

  // Local and remote shares merged into ONE list, because from the viewer's
  // side they're the same kind of thing — content someone is presenting —
  // and only their prominence should differ, not their source.
  const screenEntries: { key: string; name: string; stream: MediaStream; isLocal: boolean; mirror?: boolean; peerId?: string }[] = [];
  if (localScreenStream) {
    screenEntries.push({ key: 'local-screen', name: 'Layar Anda', stream: localScreenStream, isLocal: true });
  }
  for (const t of videoTiles) {
    if (t.screenStream) screenEntries.push({ key: `${t.id}-screen`, name: `Layar ${t.name}`, stream: t.screenStream, isLocal: false, peerId: t.id });
  }

  // A tile's own enlarge button (see VideoTile's onEnlarge) opens the SAME
  // focus panel screen shares use, keyed separately (`-camera` suffix) so a
  // camera and that same person's screen share can never collide on one key.
  // Gated on the tile actually having a stream — same "nothing to enlarge"
  // rule VideoTile itself uses to decide whether to render the button.
  const cameraEntries: { key: string; name: string; stream: MediaStream; isLocal: boolean; mirror?: boolean; peerId?: string }[] = [];
  if (localStream && !cameraOff) {
    cameraEntries.push({ key: 'local-camera', name: 'Anda', stream: localStream, isLocal: true, mirror: true });
  }
  for (const t of videoTiles) {
    if (t.stream) cameraEntries.push({ key: `${t.id}-camera`, name: t.name, stream: t.stream, isLocal: false });
  }

  // Resolved every render rather than stored: when the featured presenter
  // stops sharing (or walks out of range) their key simply stops matching, the
  // panel closes on its own, and nothing needs cleaning up. Holding it in
  // state would strand the layout on a stream that no longer exists until
  // something else forced an update. Same applies to an enlarged camera —
  // if that person's camera goes off, their -camera key vanishes from
  // cameraEntries and the panel closes itself right along with it.
  const featured = [...screenEntries, ...cameraEntries].find((s) => s.key === featuredKey) ?? null;
  const otherScreens = screenEntries.filter((s) => s.key !== featured?.key);

  const totalTiles = (localStream ? 1 : 0) + (localScreenStream ? 1 : 0) + videoTiles.length
    + videoTiles.filter((t) => t.screenStream).length;

  // Nothing to show (or nothing to hide) — same "don't render a control for
  // something that doesn't exist yet" rule the rest of the HUD follows.
  if (totalTiles === 0) return null;

  // !featured — a bare "hidden" with an active featured panel (screen share
  // or enlarged camera) must NOT hit this early return: ScreenSharePanel's
  // own onMaximizedChange sets `hidden` true so the tile rail gets out of
  // the way while a share fills the screen (see its doc comment) — but this
  // return used to replace the ENTIRE component output, including the panel
  // that triggered it, so clicking "Layar Penuh" made the very share you'd
  // just maximized vanish instead of filling the screen. Measured live: the
  // panel disappeared the instant maximize was clicked. Gating on `featured`
  // too means only the plain "hide the tile rail, nothing is featured" case
  // collapses to this small chip; the tile-rail column itself is what
  // actually hides below, in the main return.
  if (hidden && !featured) {
    return (
      <div className="absolute top-16 right-4 z-20 flex items-center gap-1.5 pointer-events-auto">
        {/* Kept reachable even with tiles hidden — otherwise hiding the
            camera strip would also hide the only way into Meeting View. */}
        <Tooltip label="Meeting View" detail="Buka tampilan video-call layar penuh.">
          <button
            onClick={onToggleMeetingView}
            className="pointer-events-auto w-6 h-6 rounded-full bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-purple-200 dark:border-gray-600 shadow-sm flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-purple-700 dark:hover:text-purple-300 cursor-pointer"
          >
            <Grid3x3GapFill size={11} />
          </button>
        </Tooltip>
        <Tooltip label="Tampilkan Tile Kamera" detail="Tampilkan lagi strip video yang disembunyikan.">
          <button
            onClick={() => setHidden(false)}
            className="bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-purple-200 dark:border-gray-600 shadow-sm rounded-full px-2.5 py-1.5 flex items-center gap-1.5 text-xs text-purple-700 dark:text-purple-300 cursor-pointer hover:bg-white"
          >
            <CameraVideoFill size={12} /> {totalTiles}
          </button>
        </Tooltip>
      </div>
    );
  }

  const hideButton = (
    <Tooltip label="Sembunyikan Tile Kamera" detail="Sembunyikan strip video sementara, tanpa mematikan kamera/mic siapa pun.">
      <button
        onClick={() => setHidden(true)}
        className="pointer-events-auto w-6 h-6 rounded-full bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-purple-200 dark:border-gray-600 shadow-sm flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-purple-700 dark:hover:text-purple-300 cursor-pointer"
      >
        <EyeSlashFill size={11} />
      </button>
    </Tooltip>
  );

  // Meeting View entry — moved here from Sidebar's Room Features dropdown,
  // grouped with the hide/show toggle above (same icon Sidebar used to show,
  // same size/style as hideButton for a matched pair). Function unchanged —
  // still just calls onToggleMeetingView (openPanel('meeting') in App.tsx).
  const meetingViewButton = (
    <Tooltip label="Meeting View" detail="Buka tampilan video-call layar penuh.">
      <button
        onClick={onToggleMeetingView}
        className="pointer-events-auto w-6 h-6 rounded-full bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-purple-200 dark:border-gray-600 shadow-sm flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-purple-700 dark:hover:text-purple-300 cursor-pointer"
      >
        <Grid3x3GapFill size={11} />
      </button>
    </Tooltip>
  );

  // Identical in both layouts — only where they sit changes, never what they
  // are, so there's no second copy to keep in sync.
  const cameraTiles = (
    <>
      {localStream && (
        <VideoTile name="You" avatarName={profiles.get(localUserId)?.name || localPlayer.name} photoUrl={profiles.get(localUserId)?.photo ?? undefined} stream={localStream} isLocal micMuted={micMuted} cameraOff={cameraOff} isBeingRecorded={isLocalBeingRecorded} handRaised={localHandRaised} reaction={latestReaction(emoteEvents, localPlayerId, now)} onEnlarge={() => setFeaturedKey('local-camera')} />
      )}
      {videoTiles.map((tile) => {
        const uid = playerRecords[tile.id]?.userId;
        return (
          <VideoTile
            key={tile.id}
            name={tile.name}
            avatarName={(uid ? profiles.get(uid)?.name : '') || tile.name}
            photoUrl={uid ? profiles.get(uid)?.photo ?? undefined : undefined}
            stream={tile.stream}
            isLocal={false}
            micMuted={!!playerRecords[tile.id]?.micMuted}
            speakingId={tile.id}
            translucent={tile.translucent}
            onVolumeChange={(v) => onManualVolumeChange(tile.id, v)}
            isBeingRecorded={tile.isBeingRecorded}
            handRaised={tile.handRaised}
            reaction={latestReaction(emoteEvents, tile.id, now)}
            onEnlarge={() => setFeaturedKey(`${tile.id}-camera`)}
            connectionFailed={failedPeerIds?.has(tile.id)}
            isGuest={tile.isGuest}
          />
        );
      })}
    </>
  );

  // The camera column keeps its original place and shape whether or not
  // anyone is presenting — the screen lives in its own floating panel, so
  // there is nothing left for the two to fight over.
  return (
    <>
      {featured && (
        <ScreenSharePanel
          key={featured.key}
          name={featured.name}
          stream={featured.stream}
          isLocal={featured.isLocal}
          mirror={featured.mirror}
          onClose={() => setFeaturedKey(null)}
          onMaximizedChange={(v) => { setHidden(v); onScreenShareMaximizedChange?.(v); }}
          stalled={!featured.isLocal && !!featured.peerId && screenStalledPeerIds?.has(featured.peerId)}
        />
      )}
      {/* QA (Load checklist item 3, "War Room share massal") — this column
          previously had no scroll/max-height at all: enough simultaneous
          screen shares (plus the camera tiles stacked below them) could
          overflow past the bottom of the viewport with genuinely no way to
          reach whatever fell off-screen. overflow-y-auto + max-h bounds it
          to a scrollable strip instead — MeetingView.tsx's own thumbnail
          strip already scrolls the same way, this just brings the ordinary
          HUD view in line with it. pointer-events-auto (was -none) so
          wheel/scrollbar events actually reach this element — a
          pointer-events-none element is excluded from hit-testing
          entirely, including wheel scroll. The column has no real empty
          space of its own beyond its children (flex-col sizes to content),
          so this doesn't reintroduce a dead click-through zone over the map.
          overflow-x-hidden alongside it — CSS forces an axis left at its
          default 'visible' to compute as 'auto' too the moment the OTHER
          axis is anything but 'visible', so leaving x unset here let a
          speaking tile's ring/glow (painted outside its own box, even
          though it doesn't affect layout) trigger a stray horizontal
          scrollbar. This column is never meant to scroll sideways.
          contain:'paint' (measured — see VideoTile's own comment) fixes the
          SAME glow-bleed on the axis that's still active (Y): the glow is
          painted outside each tile's own box on purpose (a soft outer light,
          not a hard-edged ring), and Chromium counts that ink overflow
          toward this container's scrollHeight, so the tile strip briefly
          measured as taller than it actually is and toggled its own
          scrollbar on/off in sync with the pulse — every ~0.6-1s during
          continuous speech (measured: 5 overflow events in a 12s speaking
          window, 0 while silent). contain:paint clips descendant ink
          overflow (box-shadow, outline, filter bleed) to this element's own
          box for the purposes of that overflow calculation, without
          clipping the glow's actual visible bleed onto NEIGHBOURING tiles
          within this same strip — only at the strip's own outer edge, which
          was never visible past the edge anyway. */}
      {/* Gated on !hidden (was unconditional) — this is the column
          ScreenSharePanel's onMaximizedChange is actually asking to hide (see
          the hidden-early-return comment above). Previously the early return
          handled this by skipping this whole component's output instead,
          which also skipped the featured panel above. Now hidden's only job
          is to collapse THIS column; the panel keeps rendering regardless. */}
      {!hidden && (
      // hide-scrollbar (index.css) — reported: a scrollbar sliver still shows
      // up here intermittently despite contain:'paint' above (that fix only
      // covers the speaking-glow's box-shadow bleed; other animated bits in
      // this strip, e.g. the reaction-float emoji's own translateY, are
      // plausible same-class culprits and weren't individually chased down
      // here). This column barely ever has enough tiles to need real
      // scrolling anyway (max-h is a generous overflow guard, not the normal
      // case — see the "War Room share massal" comment above) — hiding the
      // scrollbar itself removes the flicker regardless of which animation
      // is behind any one occurrence, without touching wheel/touch scrolling.
      <div className="absolute top-16 right-4 z-20 flex flex-col items-end gap-1.5 max-h-[calc(100vh-6rem)] overflow-y-auto overflow-x-hidden pointer-events-auto hide-scrollbar" style={{ contain: 'paint' }}>
        {/* Meeting View + hide/show, grouped side by side (was hideButton
            alone) rather than stacked in this otherwise-vertical column. */}
        <div className="flex items-center gap-1.5">
          {meetingViewButton}
          {hideButton}
        </div>
        {/* Every share that isn't currently the focus lives here as a
            thumbnail. An explicit button rather than a click-anywhere tile:
            the whole tile being clickable was invisible, so there was no way
            to tell a shared screen could be opened at all. */}
        {otherScreens.map((s) => (
          <div key={s.key} className="pointer-events-auto relative group/screen">
            <VideoTile name={s.name} stream={s.stream} isLocal={s.isLocal} isScreen screenStalled={!s.isLocal && !!s.peerId && screenStalledPeerIds?.has(s.peerId)} />
            {/* wrapperClassName carries the positioning. `!absolute`
                (important-modifier), not plain `absolute` — Tooltip's own
                wrapper div hardcodes `relative` as a base class, and
                Tailwind resolves a same-element relative/absolute conflict
                by source order in its generated stylesheet (`.relative`
                reliably won — confirmed via getComputedStyle, see
                VideoTile's matching enlarge-button comment below), not by
                which class appears later in this string. Without `!`, this
                silently stayed `position: relative` and rendered wherever it
                fell in normal document flow (below the whole tile, since
                VideoTile is a block sibling before it) instead of pinned to
                this `group/screen` container's top-right corner. */}
            <Tooltip label="Perbesar" detail="Jadikan share layar ini tampilan utama." wrapperClassName="!absolute top-0.5 right-0.5">
              <button
                onClick={() => setFeaturedKey(s.key)}
                className="w-5 h-5 rounded bg-black/60 hover:bg-purple-600 text-white flex items-center justify-center opacity-0 group-hover/screen:opacity-100 transition-opacity cursor-pointer"
              >
                <ArrowsFullscreen size={9} />
              </button>
            </Tooltip>
          </div>
        ))}
        {cameraTiles}
      </div>
      )}
    </>
  );
}

// Exported for MeetingView.tsx (the "Dedicated Meeting View" full-screen
// grid) — same tile, just sized up via `large` instead of a second
// hand-maintained copy of the mirror/PIP logic.
export const VideoTile = memo(function VideoTile({
  name,
  avatarName,
  photoUrl,
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
  speakingId,
  onEnlarge,
  connectionFailed,
  screenStalled,
  isGuest,
}: {
  name: string;
  // The camera-off avatar draws from the person's REAL identity, not the
  // corner label: `avatarName` is their real name (so "Kamu" still initials to
  // "F" for Farrel) and `photoUrl` is their profile photo when they have one.
  // Both default off `name` when omitted, so callers that don't distinguish
  // keep the old behaviour.
  avatarName?: string;
  photoUrl?: string;
  // Optional: a nearby peer with no camera on (or whose media hasn't arrived
  // yet) has no stream, and still gets a tile showing their initials.
  stream?: MediaStream | null;
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
  // The id to look up in the speaking-players store — NOT a plain `speaking`
  // boolean prop any more. Passing a raw boolean meant the parent had to
  // read the store itself (`speakingPlayers.has(id)`) and re-render on every
  // change to ANY player's speaking state, which re-rendered every tile in
  // the grid (VideoGrid/MeetingView both subscribed to the whole Set at
  // their own top level). Reading it here instead — one Zustand selector
  // per tile, returning a plain boolean — means THIS tile only re-renders
  // when ITS OWN speaking value actually flips. Omit entirely for a
  // non-speaking-eligible tile (screen shares); `isLocal` tiles ignore this
  // and read `localSpeaking` from the store directly instead (see below).
  speakingId?: string;
  // Opens this tile's live video full-size in the same focus panel screen
  // shares use (see VideoGrid's featuredKey). Only rendered while there's
  // actually a live picture to enlarge (!showAvatar) — an avatar placeholder
  // has nothing bigger to show.
  onEnlarge?: () => void;
  // QA (Fallback checklist item 9, "Server/A-V down: status jelas") — this
  // peer's WebRTC connection failed permanently (retried once, still
  // failed — see webrtcService's onPeerConnectionStatus). Before this, a
  // permanently-failed peer's tile just silently froze on its last frame
  // with no indication anything was wrong.
  connectionFailed?: boolean;
  // Screen-share stall recovery (see webrtcService's checkScreenStall) —
  // ICE is still nominally connected, but this tile's incoming frames have
  // stopped advancing and an automatic restartIce() recovery is in
  // progress. Only ever set for isScreen tiles (see call sites) — distinct
  // from connectionFailed above, which means "gave up", not "still trying".
  screenStalled?: boolean;
  // QA (Akses tamu checklist item 6, "Label Guest") — already shown in
  // ParticipantPanel's list rows; this is the same signal, just also
  // surfaced on the tile itself (the more commonly glanced-at spot).
  // Never set on the local/isScreen tile — see call sites.
  isGuest?: boolean;
}) {
  // See speakingId's own doc comment above — this is the fix for the tile
  // flicker: a per-tile selector, not a boolean computed by the parent from
  // the whole speakingPlayers Set. isLocal reads localSpeaking directly
  // (ANDed with !micMuted, same as before — a muted mic never shows the
  // ring even if the analyser still detects sound) instead of going through
  // speakingId at all.
  const speaking = useGameStore((s) => (isLocal ? s.localSpeaking && !micMuted : !!speakingId && s.speakingPlayers.has(speakingId)));
  const videoRef = useRef<HTMLVideoElement>(null);
  // Per-listener manual volume (§6) — purely local UI state; the peer's
  // actual manualVolume in webrtcService also starts at 1 (see
  // PeerConnection's default), so initializing to 1 here can't drift out of
  // sync with it on mount. A rebuild of the slider that used to live here:
  // that one flickered and got removed entirely (see commit 1b43b27) — the
  // real causes turned out to be the speaking ring's missing local-mic
  // debounce and a stray scrollbar from an unset overflow axis (both fixed
  // separately, see webrtcService.ts's startSpeakingDetection and the
  // overflow-x/y additions on this tile's ancestor containers), not this
  // slider's own markup — so it's safe to bring back unchanged in shape.
  const [volume, setVolume] = useState(1);
  // A remote peer who turns their camera off doesn't remove the track — it
  // stays attached and goes 'muted', which is the only signal we get. No
  // extra socket event needed, and it also covers "no video track at all"
  // (the audio-only fallback when someone's camera was already in use).
  const [remoteVideoOff, setRemoteVideoOff] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream ?? null;
    // Requested: switching to a different browser tab/app while on a call
    // should auto-float whatever's most relevant into the browser's own
    // native Picture-in-Picture, ZEP-style — set on every live tile (the
    // browser itself picks the one actually worth floating when the tab
    // hides; only one video is ever in PiP at a time). Safe against the
    // exact "stale video for someone who already left" failure a MANUAL
    // per-tile PiP button was removed for (see the removal note further
    // down): this reuses the SAME stream lifecycle already wired below —
    // clearing srcObject on unmount/peer-leave stops the source track, and
    // the browser closes an active PiP window for a video with no track of
    // its own, rather than leaving it frozen open indefinitely.
    video.autoPictureInPicture = stream ? true : false;
    if (stream) video.play().catch(() => {});
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  useEffect(() => {
    if (isLocal) return;
    // No stream (media not arrived / camera off) counts as video-off, so the
    // initials avatar shows instead of a blank black tile.
    const track = stream?.getVideoTracks()[0];
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
  const showAvatar = !isScreen && (isLocal ? !!cameraOff : (!stream || remoteVideoOff));
  // Whether this tile has a volume slider at all (never for local/screen
  // tiles — see the slider block below). Name tag and slider share the same
  // bottom-1 spot and swap on hover rather than stacking (see both below).
  const hasVolumeSlider = !isLocal && !isScreen && !!onVolumeChange;

  return (
    <div
      // Speaking ring: a coloured border plus a soft outer glow. Deliberately
      // green rather than the HUD's usual purple — this app's chrome (badges,
      // buttons, the default tile border itself) is purple almost everywhere,
      // so a purple speaking indicator barely read as distinct; green is also
      // the near-universal "active mic" convention elsewhere (Meet/Zoom/
      // Discord). Border width is now a constant border-2 (was border, 1px)
      // for EVERY tile, speaking or not — bumping it only while speaking
      // would resize the tile and nudge its neighbours every time someone
      // starts talking, the exact shift this ring/border-colour (not an
      // extra element) approach exists to avoid; a permanently thicker
      // border sidesteps that while still reading as more solid than
      // before. The pulsing GLOW itself lives on a separate overlay now —
      // see the .speaking-glow span right below — not this div; see its own
      // comment for why.
      // h-full flex flex-col on the large path: the tile fills the grid cell
      // it was given, and the video area (flex-1 min-h-0, the only flow
      // child) takes 100% of it — the name tag is an absolute overlay now
      // (see below), not a flow sibling competing for the same space, so
      // nothing shrinks the video to make room for it.
      // transition-COLORS, not transition-all — box-shadow (ring) snaps in
      // instantly rather than being interpolated; only the border color
      // fades. Narrows what changes when speaking starts, same spirit as
      // moving the glow out below.
      className={`pointer-events-auto bg-white/90 backdrop-blur-sm rounded-lg overflow-hidden border-2 shadow-lg transition-colors duration-300 animate-fade-in group relative ${large ? 'w-full h-full flex flex-col' : 'w-24'} ${
        speaking ? 'border-green-500 ring-2 ring-green-400/60' : 'border-purple-200'
      }`}
      style={{ opacity: translucent ? 0.5 : 1 }}
    >
      {/* Speaking glow overlay — measured (tile flicker diagnosis): animating
          this box-shadow's own blur/spread directly (the previous
          .animate-speaking-glow keyframe) briefly inflated the ambient
          strip's scrollHeight every time it started, ~300ms per onset, even
          with contain:'paint' on that strip — isolated by disabling just
          this animation with everything else (ring, wave-bar, mount timing)
          unchanged: 0 overflow events with it off, back with it on. The
          box-shadow value here is now CONSTANT (see .speaking-glow in
          index.css) — only THIS element's opacity pulses (.animate-speaking-
          glow, now an opacity keyframe), which can never change its own
          geometry, so there's nothing for the ancestor's scroll-overflow
          calculation to ever recompute. A separate element (not the tile's
          own div above) so the pulse fades only the glow, never the video/
          name/tile content sitting behind it. */}
      {speaking && (
        <span aria-hidden="true" className="absolute inset-0 rounded-lg pointer-events-none speaking-glow animate-speaking-glow" />
      )}
      {/* Mirror the LOCAL self-preview only — raising your right hand should
          show on the right side of YOUR OWN preview, same as a real mirror
          (every video call app does this for the self-view). Remote tiles
          and screen shares stay unmirrored. This is purely a browser-side
          style on the <video> element — it can't touch the actual
          MediaStreamTrack sent to WebRTC peers. */}
      {/* min-h-0 matters: a flex child defaults to min-height:auto, which
          refuses to shrink below its content and would let the video push the
          tile taller than its cell — the overflow this whole change exists to
          remove. */}
      <div className={large ? 'relative flex-1 min-h-0' : 'relative'}>
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
        // No aspect-video on the large path any more. It fought with h-full
        // and won, so the height was computed from the WIDTH — in Meeting
        // View a lone participant's cell spans the entire window, and
        // width×9/16 then exceeded the viewport, forcing a scroll to see your
        // own tile. The wider the window, the worse it got. Height now comes
        // from the cell the tile is placed in; object-cover/contain handles
        // whatever ratio the source happens to be.
        // object-top on the screen path for the same reason as
        // ScreenSharePanel's video: object-contain centers leftover space
        // above AND below by default, and a shared screen's actual content
        // never sits at the bottom of its own frame.
        className={
          isScreen
            ? `w-full object-contain object-top bg-black ${large ? 'h-full' : 'h-16'}`
            : `w-full object-cover bg-purple-100 ${large ? 'h-full' : 'h-16'}`
        }
      />
      {/* Covers the video box (which stays mounted and playing underneath, so
          turning the camera back on is instant) rather than unmounting it —
          a black rectangle tells you nothing, the avatar tells you who. */}
      {showAvatar && (
        <div className="absolute inset-0">
          <TileAvatar name={avatarName ?? name} photoUrl={photoUrl} large={large} />
        </div>
      )}
      {/* QA (Fallback checklist item 9) — sits ON TOP of whatever the tile
          would otherwise show (frozen video or the avatar placeholder), so
          it's never mistaken for a normal connection that's merely quiet. */}
      {connectionFailed && !isScreen && (
        <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-1 text-white">
          <WifiOff size={large ? 22 : 14} />
          {large && <span className="text-xs">Koneksi terputus</span>}
        </div>
      )}
      {/* Screen-share stall recovery (see webrtcService's checkScreenStall) —
          same "sits over whatever the tile would otherwise show" placement
          as connectionFailed above, but its own overlay: this is "still
          trying to recover" (spinner), not "gave up" (WifiOff). */}
      {screenStalled && (
        <div className="absolute inset-0 bg-black/55 flex flex-col items-center justify-center gap-1 text-white">
          <span className={`rounded-full border-2 border-white/40 border-t-white animate-spin ${large ? 'w-6 h-6' : 'w-4 h-4'}`} />
          {large && <span className="text-xs">Menyambung ulang...</span>}
        </div>
      )}
      </div>
      {/* The per-tile picture-in-picture button was removed on request: it sat
          under the cursor on every hover and popped a floating OS window that
          then kept showing a peer's video after they'd walked away, which read
          as the app being broken. Mini Mode in the sidebar remains as the
          deliberate, chosen way to detach the view. */}
      {isScreen && (
        <span className="absolute top-0.5 left-0.5 bg-black/50 text-white rounded p-0.5">
          <DisplayFill size={large ? 10 : 8} />
        </span>
      )}
      {/* Enlarge — opens the live camera picture full-size in the same focus
          panel screen shares use. Only while there's an actual picture to
          enlarge (!showAvatar); a placeholder initials tile has nothing
          bigger to show. Hover-revealed via the tile's own `group`.
          Top-right, matching the screen-thumbnail enlarge button above (same
          corner, same convention everywhere else in this app an "expand"
          action lives). The mic-status badge below is shifted down
          (top-7, not top-1) to leave this corner free — the two are
          independent (hover vs. muted state) and can be visible together on
          a muted tile that's also being hovered. */}
      {onEnlarge && !showAvatar && !isScreen && (
        // wrapperClassName carries the positioning — otherwise it would
        // anchor to Tooltip's own inline wrapper instead of this tile's root
        // div. `!absolute` (important-modifier), not plain `absolute`:
        // Tooltip's own wrapper already hardcodes `relative` as a base
        // class, and Tailwind resolves a same-element relative/absolute
        // conflict by SOURCE ORDER in its generated stylesheet, not by which
        // class appears later in this string — `.relative` reliably won
        // (confirmed via getComputedStyle: position stayed 'relative'),
        // silently turning `top-1 right-1` into an offset from the
        // element's own normal-flow position instead of the tile's corner.
        // The `!` forces this specific declaration through regardless of
        // that ordering.
        <Tooltip label="Perbesar Video" detail="Lihat video orang ini dalam ukuran penuh." wrapperClassName="!absolute top-1 right-1">
          <button
            onClick={onEnlarge}
            className="w-5 h-5 rounded bg-black/60 hover:bg-purple-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
          >
            <ArrowsFullscreen size={9} />
          </button>
        </Tooltip>
      )}
      {/* Quick reaction — a single emoji floating up from the bottom-center
          of the tile, restarting whenever a newer reaction arrives (keyed by
          its timestamp). Shared with the in-world emote system, so a reaction
          here also shows above the avatar and vice-versa. */}
      {reaction && !isScreen && (
        // Centering (translateX) lives on this OUTER span, animation
        // (translateY/scale, via animate-reaction-float) on the INNER one —
        // same element would work for the very first frame, but a CSS
        // `transform` set by @keyframes replaces rather than composes with
        // a static transform utility already on that element, so the
        // horizontal centering was getting silently wiped out once the
        // animation kicked in (same bug, same fix, as EmoteWheel.tsx).
        // Nesting keeps each transform in its own box, so both apply.
        <span key={reaction.ts} className="absolute left-1/2 -translate-x-1/2 bottom-6 pointer-events-none select-none">
          <span
            className={`block animate-reaction-float ${large ? 'text-4xl' : 'text-2xl'}`}
            style={{ textShadow: '0 1px 3px rgba(0,0,0,0.4)' }}
          >
            {reaction.emoji}
          </span>
        </span>
      )}
      {/* Raised-hand cue — amber badge, top-left, gently waving so it draws
          the eye during a meeting (the whole point of "raise hand"). */}
      {handRaised && !isScreen && (
        <span
          className={`absolute left-0.5 bg-amber-400 rounded-full shadow flex items-center justify-center animate-bounce ${isBeingRecorded ? 'top-6' : 'top-0.5'} ${large ? 'w-6 h-6' : 'w-4 h-4'}`}
          title={`${isLocal ? 'You have' : `${name} has`} raised a hand`}
        >
          <img src="/assets/img/raise-hand-icon.png" alt="" className={large ? 'w-3.5 h-3' : 'w-2.5 h-2'} />
        </span>
      )}
      {isBeingRecorded && (
        <span className="absolute top-0.5 left-0.5 bg-red-600/90 text-white text-[9px] font-bold rounded px-1 py-0.5 inline-flex items-center gap-0.5">
          <RecordCircleFill size={9} /> {large && 'REC'}
        </span>
      )}
      {/* "Ethereal Collaboration" — name-tag as a floating glass chip over
          the video (was a full-width bar sharing layout space below it);
          mic/camera-off status moved to its own glass badge top-right (see
          below, and the enlarge button's move to bottom-right above so the
          two don't stack). Same `name`/`speaking` props as before — this is
          a repositioning, not a new signal.
          Name tag and volume slider below share this exact bottom-1 spot
          and swap on hover instead of stacking: hovering a tile that has a
          slider fades this out (group-hover:opacity-0) as the slider fades
          in, so only one is ever showing. Tiles with no slider (local/
          screen) are unaffected — hasVolumeSlider gates it. */}
      <span
        className={`absolute left-1 bottom-1 max-w-[80%] flex items-center gap-1 bg-black/45 backdrop-blur-md text-white rounded-full transition-opacity duration-150 ${
          large ? 'px-2.5 py-1 text-xs' : 'px-1.5 py-0.5 text-[9px]'
        } ${hasVolumeSlider ? 'group-hover:opacity-0' : ''}`}
      >
        <span className="truncate">{name}</span>
        {/* QA (Akses tamu checklist item 6, "Label Guest") — same pairing
            ParticipantPanel already uses (badge right next to the name),
            just also shown here since a tile is glanced at far more during
            an actual meeting. */}
        {isGuest && (
          <span className={`shrink-0 rounded-full bg-purple-500 font-semibold uppercase tracking-wide ${large ? 'px-1.5 py-0.5 text-[9px]' : 'px-1 text-[7px]'}`}>
            Guest
          </span>
        )}
        {speaking && (
          <span className={`flex items-end gap-px shrink-0 ${large ? 'h-2.5' : 'h-1.5'}`}>
            <span className="w-0.5 h-full bg-green-400 rounded-full animate-wave-bar" style={{ animationDelay: '0ms' }} />
            <span className="w-0.5 h-full bg-green-400 rounded-full animate-wave-bar" style={{ animationDelay: '150ms' }} />
            <span className="w-0.5 h-full bg-green-400 rounded-full animate-wave-bar" style={{ animationDelay: '300ms' }} />
          </span>
        )}
      </span>
      {/* §6 — manual per-listener volume, purely client-side (my own
          listening preference; no server sync, no effect on anyone else).
          Not shown for screen-share tiles or my own tile — screen share
          carries no audio track here, and muting yourself already has the
          mic button. Shares the name tag's exact spot and swaps with it on
          hover (see the name tag's own comment above): only hovering
          reveals the slider, and only while hovering, so it's always
          exactly one or the other, never both, never neither.
          step=0.05 (finer than the original 0.1) plus a taller h-1.5 track
          — both purely to make the handle land where you actually drop it;
          native <input type="range"> already maps value<->position exactly,
          so imprecision here was a grab-target/step-size problem, not a
          rendering bug. */}
      {hasVolumeSlider && (
        <div
          className={`absolute left-1 right-1 bottom-1 flex items-center gap-1.5 bg-black/45 backdrop-blur-md rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-150 ${
            large ? 'px-2 py-1' : 'px-1.5 py-0.5'
          }`}
        >
          {volume === 0 ? <VolumeMuteFill size={large ? 11 : 9} className="text-white/80 shrink-0" /> : <VolumeUpFill size={large ? 11 : 9} className="text-white/80 shrink-0" />}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => {
              const v = Number(e.target.value);
              setVolume(v);
              onVolumeChange?.(v);
            }}
            className="flex-1 accent-purple-600 h-1.5 cursor-pointer"
          />
        </div>
      )}
      {/* Mic-muted shown for remote tiles too (broadcast via PLAYER_MIC —
          see Avatar.micMuted), not just the local preview; camera-off stays
          local-only since a remote camera-off already shows as the avatar
          placeholder instead of video. Bumped up on the large path (Meeting
          View's own tiles, much bigger than the ambient strip's w-24 ones).
          The small-tile icon was bumped from 9px to 13px (padding p-1 ->
          p-1.5 to match) — at 9px it was too easy to miss who was muted at
          a glance in the ambient strip, the exact case this exists for.
          top-7 (not top-1) — the enlarge button now owns the top-right
          corner itself (see its own comment above); this sits just below it
          so a muted tile that's also being hovered never overlaps the two. */}
      {(micMuted || (isLocal && cameraOff)) && (
        <span className={`absolute top-7 right-1 flex gap-1 bg-black/45 backdrop-blur-md rounded-full ${large ? 'p-2' : 'p-1.5'}`}>
          {micMuted && <MicMuteFill className="text-red-400" size={large ? 18 : 13} />}
          {isLocal && cameraOff && <CameraVideoOffFill className="text-red-400" size={large ? 18 : 13} />}
        </span>
      )}
    </div>
  );
});
