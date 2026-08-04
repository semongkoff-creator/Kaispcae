import { useRef, useEffect, useState, useMemo } from 'react';
import { MicMuteFill, CameraVideoOffFill, ArrowsFullscreen, FullscreenExit, PlusLg, DashLg, ArrowCounterclockwise, XLg, VolumeUpFill, VolumeMuteFill, DisplayFill, RecordCircleFill, EyeSlashFill, CameraVideoFill } from 'react-bootstrap-icons';
import { ProximityPlayer, EmoteEvent, EMOTE_EMOJI } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { useProfiles } from '@/hooks/useProfiles';
import { ChatAvatar, avatarColor } from './ChatAvatar';

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
      stream: remoteStreams.get(p.id),
      screenStream: remoteScreenStreams.get(p.id),
      translucent: p.visibility === 'translucent',
      isBeingRecorded: !!recordedTargetUserId && playerRecords[p.id]?.userId === recordedTargetUserId,
      handRaised: !!playerRecords[p.id]?.handRaised,
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

function ScreenSharePanel({ name, stream, isLocal, onClose, onMaximizedChange }: { name: string; stream: MediaStream; isLocal: boolean; onClose: () => void; onMaximizedChange?: (maximized: boolean) => void }) {
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
        <button
          onClick={() => applyZoom(zoom / 1.25, 0, 0)}
          disabled={zoom <= MIN_ZOOM}
          title="Perkecil isi"
          className={`shrink-0 cursor-pointer p-0.5 rounded disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent ${dim}`}
        >
          <DashLg size={12} />
        </button>
        <button
          onClick={() => applyZoom(zoom * 1.25, 0, 0)}
          disabled={zoom >= MAX_ZOOM}
          title="Perbesar isi"
          className={`shrink-0 cursor-pointer p-0.5 rounded disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent ${dim}`}
        >
          <PlusLg size={12} />
        </button>
        {zoom > 1 && (
          <button
            onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}
            title="Kembalikan ke 100%"
            className={`shrink-0 cursor-pointer p-0.5 rounded ${dim}`}
          >
            <ArrowCounterclockwise size={12} />
          </button>
        )}
        {/* Named for what it does. It used to say "Perbesar", which collided
            with the enlarge button on the thumbnail — two different actions
            wearing the same word. */}
        <button
          onClick={() => setMaximized((v) => !v)}
          title={maximized ? 'Keluar layar penuh (Esc)' : 'Layar penuh'}
          className={`shrink-0 cursor-pointer p-0.5 rounded ${dim}`}
        >
          {maximized ? <FullscreenExit size={12} /> : <ArrowsFullscreen size={12} />}
        </button>
        {/* Back to a thumbnail. Without this there is no way out of the focus
            panel short of the presenter stopping — a dead end the spec
            explicitly forbids. */}
        <button
          onClick={onClose}
          title="Kecilkan ke kolom peserta"
          className={`shrink-0 cursor-pointer p-0.5 rounded ${variant === 'dark' ? 'text-white/70 hover:text-red-300 hover:bg-white/20' : 'text-gray-500 hover:text-red-500 dark:text-gray-300 hover:bg-red-50 dark:hover:bg-gray-600'}`}
        >
          <XLg size={11} />
        </button>
      </>
    );
  };

  return (
    <div
      // Pinned top-centre, sized by whichever of three limits bites first.
      // aspect-video on the video box below turns this one width into the
      // height too, so the ratio can never distort — the panel just stops
      // growing.
      //
      //   1280px        — an upper bound so it doesn't become absurd on an
      //                   ultrawide monitor.
      //   100vw - 14rem — horizontal room. 14rem, not 7rem: the panel is
      //                   CENTRED, so the leftover space splits evenly across
      //                   both sides and only half of whatever is reserved
      //                   actually lands next to the camera rail. The rail
      //                   itself needs 7rem (a 6rem tile at right-4), so the
      //                   reservation has to be doubled. The previous value
      //                   reserved 9rem total — half of that is 4.5rem, less
      //                   than the rail needs, so on any window under ~864px
      //                   the panel was already sliding underneath the
      //                   participant tiles.
      //   (100vh - 13rem) * 16/9
      //                 — vertical room, converted to a width through the
      //                   16:9 ratio. 13rem covers top-16 (4rem), the title
      //                   bar, and clearance for the HUD toolbar at the
      //                   bottom. Without this the panel would grow past the
      //                   bottom edge on short windows.
      // Centred with left-0 right-0 mx-auto, NOT left-1/2 + -translate-x-1/2.
      // animate-fade-in animates `transform`, and its `both` fill-mode makes
      // the final keyframe stick permanently — an animation beats a normal
      // declaration in the cascade, so translateY(0) silently wiped out the
      // -50% horizontal shift. The panel kept left:50% with no shift back,
      // putting its LEFT EDGE at screen centre and hanging off to the right.
      // Auto margins centre it without touching transform at all, so the two
      // can't fight.
      // Enlarged drops the 1280px cap and the room reserved for the camera
      // rail, growing to whatever the window allows while the same three-way
      // min() still keeps the 16:9 box inside the viewport. Position, aspect
      // ratio and object-contain are identical in both states — only the
      // ceiling moves — so enlarging can never crop or stretch the picture.
      // Fills the viewport, leaving only a thin frame — the user chose max
      // size over map visibility. The 16:9 aspect-lock is deliberately gone:
      // on a 16:9 monitor an aspect-locked panel can't grow past the height
      // budget without hiding the map entirely anyway, so the lock capped the
      // size for no gain. Instead the panel is a flex column filling its box,
      // the content flexes to fill it, and object-contain letterboxes whatever
      // ratio the shared screen has — a bigger box that never crops/stretches.
      //
      // left-14, not a symmetric inset: the left nav (Sidebar.tsx) is a
      // w-12 (48px) z-50 rail that sits ON TOP of this z-30 panel, so a
      // flush-left panel had its title and left edge hidden under it and the
      // visible picture pushed off-centre. Clearing 56px on the left puts the
      // panel in the space actually visible beside the rail.
      className={`absolute z-30 flex flex-col pointer-events-auto overflow-hidden border border-purple-200 dark:border-gray-600 shadow-xl bg-white/95 dark:bg-gray-800/95 backdrop-blur-sm animate-fade-in ${
        maximized
          ? 'left-14 right-1 top-1 bottom-1 rounded-md'
          : 'left-14 right-2 top-1 bottom-2 rounded-lg'
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
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
          className="absolute inset-0 w-full h-full object-contain object-top"
        />
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

export function VideoGrid({ nearby, localStream, localScreenStream, remoteStreams, remoteScreenStreams, micMuted, cameraOff, onManualVolumeChange, recordedTargetUserId, isLocalBeingRecorded }: VideoGridProps) {
  const playerRecords = useGameStore((s) => s.playerRecords);
  const localPlayer = useGameStore((s) => s.localPlayer);
  const localHandRaised = localPlayer.handRaised;
  // The same two pieces of state the map already uses to ring a speaking
  // avatar (see GameCanvas) — the tile just renders them differently. No
  // second source of truth for who is talking.
  const speakingPlayers = useGameStore((s) => s.speakingPlayers);
  const localSpeaking = useGameStore((s) => s.localSpeaking);
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
  // stops sharing (or walks out of range) their key simply stops matching, the
  // panel closes on its own, and nothing needs cleaning up. Holding it in
  // state would strand the layout on a stream that no longer exists until
  // something else forced an update.
  //
  // No `?? screenEntries[0]` fallback any more. That silently promoted the
  // first share straight to a full focus panel, so the thumbnail step never
  // existed for a single presenter — a screen appeared over the map without
  // anyone asking for it. Now every share starts as a thumbnail in the
  // column and only becomes the focus panel when its enlarge button is used.
  const featured = screenEntries.find((s) => s.key === featuredKey) ?? null;
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
        <VideoTile name="You" avatarName={profiles.get(localUserId)?.name || localPlayer.name} photoUrl={profiles.get(localUserId)?.photo ?? undefined} stream={localStream} isLocal micMuted={micMuted} cameraOff={cameraOff} isBeingRecorded={isLocalBeingRecorded} handRaised={localHandRaised} reaction={latestReaction(emoteEvents, localPlayerId, now)} speaking={localSpeaking && !micMuted} />
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
            speaking={speakingPlayers.has(tile.id)}
            translucent={tile.translucent}
            onVolumeChange={(v) => onManualVolumeChange(tile.id, v)}
            isBeingRecorded={tile.isBeingRecorded}
            handRaised={tile.handRaised}
            reaction={latestReaction(emoteEvents, tile.id, now)}
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
        <ScreenSharePanel key={featured.key} name={featured.name} stream={featured.stream} isLocal={featured.isLocal} onClose={() => setFeaturedKey(null)} onMaximizedChange={setHidden} />
      )}
      <div className="absolute top-16 right-4 z-20 flex flex-col items-end gap-1.5 pointer-events-none">
        {hideButton}
        {/* Every share that isn't currently the focus lives here as a
            thumbnail. An explicit button rather than a click-anywhere tile:
            the whole tile being clickable was invisible, so there was no way
            to tell a shared screen could be opened at all. */}
        {otherScreens.map((s) => (
          <div key={s.key} className="pointer-events-auto relative group/screen">
            <VideoTile name={s.name} stream={s.stream} isLocal={s.isLocal} isScreen />
            <button
              onClick={() => setFeaturedKey(s.key)}
              title={`Perbesar ${s.name}`}
              className="absolute top-0.5 right-0.5 w-5 h-5 rounded bg-black/60 hover:bg-purple-600 text-white flex items-center justify-center opacity-0 group-hover/screen:opacity-100 transition-opacity cursor-pointer"
            >
              <ArrowsFullscreen size={9} />
            </button>
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
  speaking,
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
  speaking?: boolean;
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
    video.srcObject = stream ?? null;
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


  return (
    <div
      // Speaking ring: a coloured border plus a soft outer glow, in the same
      // purple the rest of the HUD uses for "active". Drawn with ring/border
      // colour rather than an extra element so it can't shift the tile's size
      // and nudge its neighbours every time someone starts talking.
      // h-full flex flex-col on the large path: the tile fills the grid cell
      // it was given, and the video area takes whatever is left after the
      // name/volume rows. That is what lets the cell decide the size instead
      // of the video deciding it and overflowing.
      className={`pointer-events-auto bg-white/90 backdrop-blur-sm rounded-lg overflow-hidden border shadow-lg transition-all duration-300 animate-fade-in group relative ${large ? 'w-full h-full flex flex-col' : 'w-24'} ${
        speaking ? 'border-purple-500 ring-2 ring-purple-400/60 shadow-purple-400/40' : 'border-purple-200'
      }`}
      style={{ opacity: translucent ? 0.5 : 1 }}
    >
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
      {/* Revealed on hover once it's at full volume, but kept visible the
          moment it isn't: a turned-down or silenced person whose slider is
          hidden looks identical to a normal one, so you'd have no way to tell
          why they've gone quiet — and no reason to suspect you did it.
          //
          Faded rather than unmounted/collapsed. These tiles stack in a
          vertical column, so removing the row would shorten the tile and jerk
          every tile below it upward on hover — chasing a target that moves
          because you pointed at it. Reserving the space costs a thin strip
          and keeps the column still. */}
      {!isLocal && !isScreen && onVolumeChange && (
        <div
          className={`flex items-center gap-1 transition-opacity duration-200 ${large ? 'px-2 pb-1.5 gap-1.5' : 'px-1 pb-1'} ${
            volume < 1 ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
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
