import { useEffect, useMemo, useRef, useState } from 'react';
import { XLg, PinFill } from 'react-bootstrap-icons';
import { ProximityPlayer, EmoteType, EMOTE_LIST, EMOTE_EMOJI, EMOTE_LABELS } from '@kaispace/shared';
import { useGameStore } from '@/stores/gameStore';
import { useProfiles } from '@/hooks/useProfiles';
import { Tooltip } from '@/components/ui/Tooltip';
import { getVideoTiles, VideoTile, latestReaction } from './VideoGrid';

interface MeetingViewProps {
  nearby: ProximityPlayer[];
  localStream: MediaStream | null;
  localScreenStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  remoteScreenStreams: Map<string, MediaStream>;
  micMuted: boolean;
  cameraOff: boolean;
  onManualVolumeChange: (id: string, volume: number) => void;
  recordedTargetUserId?: string;
  isLocalBeingRecorded?: boolean;
  onClose: () => void;
  onEmote: (emote: EmoteType) => void;
  // Bug fix — the quick-reactions strip below used to render unconditionally
  // whenever Meeting View was open (no visibility check at all), so it sat
  // permanently over the toolbar. Now it follows the same toolbar Emoji
  // button/showEmoteWheel toggle App.tsx already has (see its own note on
  // why the EmoteWheel radial is suppressed while this is shown instead).
  showReactions: boolean;
  // QA (Fallback checklist item 9) — same set VideoGrid.tsx takes; Meeting
  // View is the other place VideoTile is used (via renderTile below), so it
  // needs the same "connection lost" signal, not a second copy of the logic.
  failedPeerIds?: Set<string>;
}

// One normalized descriptor per video surface (local cam, local screen, each
// remote cam, each remote screen) so both the grid and the featured-tile +
// thumbnail-strip layout work off a single list instead of four parallel
// branches.
interface MTile {
  key: string;
  name: string;          // corner label (may be a role word like "Kamu"/"Layarmu")
  avatarName?: string;   // REAL name — drives the camera-off initials (Bug 16)
  photoUrl?: string;     // profile photo for the camera-off avatar, if any
  stream?: MediaStream | null;
  isLocal: boolean;
  isScreen: boolean;
  translucent?: boolean;
  handRaised?: boolean;
  isBeingRecorded?: boolean;
  micMuted?: boolean;
  cameraOff?: boolean;
  speaking?: boolean;
  reactionSourceId?: string; // player id for latestReaction lookup (cam tiles)
  volumeTargetId?: string;   // remote id whose volume this tile's slider adjusts
  // QA (Akses tamu checklist item 6, "Label Guest") — never set on the
  // local-cam/screen entries above, same as VideoGrid.tsx's own tiles.
  isGuest?: boolean;
}

// Bug 16 — Google-Meet-style layout, with a second pass fixing the default
// state: a single large "featured" surface + bottom thumbnail strip only
// appears once something has EARNED it — a pinned tile (click one, in the
// strip or the grid below) or an active screen share (auto-pins, so
// presenting still auto-focuses without a click). Otherwise every tile
// renders in one even grid — nobody is spotlighted just for being the first
// remote, or the loudest, when nobody actually asked to feature them. The
// bottom Mic/Camera/Hand/Share control row floats over this from App.tsx
// (unchanged); this is purely a layout/view mode — no WebRTC changes, and
// leaving it drops you right back onto the map where you already are.
export function MeetingView({
  nearby, localStream, localScreenStream, remoteStreams, remoteScreenStreams,
  micMuted, cameraOff, onManualVolumeChange, recordedTargetUserId, isLocalBeingRecorded, onClose, onEmote, failedPeerIds, showReactions,
}: MeetingViewProps) {
  const playerRecords = useGameStore((s) => s.playerRecords);
  const localHandRaised = useGameStore((s) => s.localPlayer.handRaised);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const localUserId = useGameStore((s) => s.localUserId);
  const localName = useGameStore((s) => s.localPlayer.name);
  const emoteEvents = useGameStore((s) => s.emoteEvents);
  const localSpeaking = useGameStore((s) => s.localSpeaking);
  const speakingPlayers = useGameStore((s) => s.speakingPlayers);
  const now = Date.now();

  const videoTiles = getVideoTiles(nearby, playerRecords, remoteStreams, remoteScreenStreams, recordedTargetUserId);
  const screenTiles = videoTiles.filter((t) => t.screenStream);

  // Profile photos for the camera-off avatars — resolved by userId, the SAME
  // hook/source chat uses (Bug 8), so a tile shows the person's current photo
  // and real-name initials instead of "K" from the label "Kamu" (Bug 16).
  const profileIds = useMemo(() => {
    const ids = [localUserId];
    for (const t of videoTiles) { const uid = playerRecords[t.id]?.userId; if (uid) ids.push(uid); }
    return ids.filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localUserId, videoTiles.map((t) => t.id).join(','), playerRecords]);
  const profiles = useProfiles(profileIds);
  const profileSig = profileIds.map((id) => { const p = profiles.get(id); return `${id}:${p?.name ?? ''}:${p?.photo ?? ''}`; }).join(',');

  // Build the unified tile list. Order matters: screens first, since a new
  // one auto-pins (see prevScreenKeysRef below) and the grid reads top-left
  // to bottom-right in this same order.
  const tiles = useMemo<MTile[]>(() => {
    const out: MTile[] = [];
    if (localScreenStream) out.push({ key: 'local-screen', name: 'Layarmu', stream: localScreenStream, isLocal: true, isScreen: true });
    for (const t of screenTiles) out.push({ key: `${t.id}-screen`, name: `Layar ${t.name}`, stream: t.screenStream, isLocal: false, isScreen: true });
    if (localStream) out.push({ key: 'local-cam', name: 'You', avatarName: profiles.get(localUserId)?.name || localName, photoUrl: profiles.get(localUserId)?.photo ?? undefined, stream: localStream, isLocal: true, isScreen: false, micMuted, cameraOff, handRaised: localHandRaised, isBeingRecorded: isLocalBeingRecorded, speaking: localSpeaking && !micMuted, reactionSourceId: localPlayerId ?? undefined });
    for (const t of videoTiles) { const uid = playerRecords[t.id]?.userId; out.push({ key: t.id, name: t.name, avatarName: (uid ? profiles.get(uid)?.name : '') || t.name, photoUrl: uid ? profiles.get(uid)?.photo ?? undefined : undefined, stream: t.stream, isLocal: false, isScreen: false, translucent: t.translucent, handRaised: t.handRaised, isBeingRecorded: t.isBeingRecorded, speaking: speakingPlayers.has(t.id), reactionSourceId: t.id, volumeTargetId: t.id, isGuest: t.isGuest }); }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localStream, localScreenStream, micMuted, cameraOff, localHandRaised, isLocalBeingRecorded, localSpeaking, localPlayerId, localUserId, localName, profileSig,
      videoTiles.map((t) => `${t.id}:${!!t.stream}:${t.translucent}:${t.handRaised}`).join(','),
      screenTiles.map((t) => t.id).join(',')]);

  const keys = tiles.map((t) => t.key);
  const screenKeys = tiles.filter((t) => t.isScreen).map((t) => t.key);

  const [pinnedKey, setPinnedKey] = useState<string | null>(null);

  // A brand-new screen share auto-takes the stage (clears any prior pin), like
  // Google Meet — this is what keeps "screen share becomes the main content"
  // automatic even if the user had pinned someone.
  const prevScreenKeysRef = useRef<string[]>([]);
  useEffect(() => {
    const added = screenKeys.find((k) => !prevScreenKeysRef.current.includes(k));
    if (added) setPinnedKey(added);
    prevScreenKeysRef.current = screenKeys;
  }, [screenKeys.join(',')]);

  // Drop a pin whose tile has gone away (peer left / stopped sharing) so the
  // stage falls back to auto instead of showing an empty featured area.
  useEffect(() => {
    if (pinnedKey && !keys.includes(pinnedKey)) setPinnedKey(null);
  }, [keys.join(','), pinnedKey]);

  // Single-featured-tile layout is now earned, not default: only an explicit
  // pin (click a tile) or an active screen share promotes someone to the big
  // stage. It used to ALSO auto-promote whoever was speaking, or failing
  // that the first remote/local tile, which meant a lone big tile + a cramped
  // thumbnail strip was what 3 people just standing around chatting saw —
  // nobody asked to be "featured", so nothing should be. Absent, the stage
  // below renders every tile in one even grid instead (Meet's default
  // "Tiled" view), and clicking any tile there pins it same as the strip.
  const featuredKey = (pinnedKey && keys.includes(pinnedKey)) ? pinnedKey : (screenKeys[0] ?? null);
  const featured = tiles.find((t) => t.key === featuredKey) ?? null;
  const thumbnails = featured ? tiles.filter((t) => t.key !== featuredKey) : [];
  const isPinned = !!pinnedKey && pinnedKey === featuredKey;

  // Explicit columns/rows from participant count — NOT CSS auto-fit, which
  // picked column count purely from container WIDTH. On a normal-width
  // window that let 4 tiles all fit in one row, and since the old
  // gridAutoRows only ever produced that ONE row, it then stretched to fill
  // the container's full height — every tile came out tall and narrow
  // instead of an even 2x2. Column count now follows headcount directly
  // (1→1, 2→2, 3-4→2, 5-9→3, beyond that ceil(sqrt(n))), and row count is a
  // fixed track count too, so height always splits across the actual number
  // of rows rather than however many CSS happened to wrap to.
  const gridColumns = tiles.length <= 1 ? 1 : tiles.length <= 4 ? 2 : tiles.length <= 9 ? 3 : Math.ceil(Math.sqrt(tiles.length));
  const gridRows = Math.max(1, Math.ceil(tiles.length / gridColumns));

  // Bug fix (regression report) — onVolumeChange used to be gated on `main`
  // (the single featured/spotlighted tile only), so grid and thumbnail-strip
  // tiles never got a volume slider at all. volumeTargetId is already set on
  // every tile (see MTile below), so this was just an unnecessary
  // restriction, not a technical requirement — every remote tile gets the
  // slider now, matching VideoGrid.tsx's ambient-HUD tiles (which never had
  // this restriction).
  const renderTile = (t: MTile) => (
    <VideoTile
      name={t.name}
      avatarName={t.avatarName}
      photoUrl={t.photoUrl}
      stream={t.stream}
      isLocal={t.isLocal}
      isScreen={t.isScreen}
      micMuted={t.micMuted}
      cameraOff={t.cameraOff}
      translucent={t.translucent}
      handRaised={t.handRaised}
      isBeingRecorded={t.isBeingRecorded}
      speaking={t.speaking}
      reaction={t.reactionSourceId ? latestReaction(emoteEvents, t.reactionSourceId, now) : null}
      onVolumeChange={t.volumeTargetId ? (v) => onManualVolumeChange(t.volumeTargetId!, v) : undefined}
      connectionFailed={!t.isLocal && !t.isScreen && !!t.reactionSourceId && failedPeerIds?.has(t.reactionSourceId)}
      isGuest={t.isGuest}
      large
    />
  );

  return (
    // font-ethereal scopes Inter to this dedicated screen only (Tahap 1's
    // token) — the rest of the app (ambient HUD, login, admin) keeps the
    // default system-sans look untouched.
    // pb-24 (96px) reserves room for the persistent bottom-center HUD control
    // row (App.tsx: `absolute bottom-6 ... z-50`, MicButton etc. are w-11/44px
    // inside a py-2 + border container — bottom-6(24) + 44 + py-2(16) +
    // border(2) = 86px from the viewport's bottom edge, so 96px leaves a
    // real margin rather than just barely clearing it). Previously only the
    // quick-reactions strip below had its own ad-hoc pb-20 (80px — a few px
    // short of that same 86px) for this reason; the tile grid and thumbnail
    // strip had none at all, so a bottom row of tiles (or the whole
    // thumbnail strip) could end up hidden under the toolbar. Reserving it
    // once here, on the outer container, covers every branch uniformly
    // instead of requiring each one to remember it.
    <div className="absolute inset-0 z-40 bg-gray-900/97 backdrop-blur-sm flex flex-col pointer-events-auto font-ethereal pb-24">
      {/* pl-20 clears the fixed Sidebar rail (z-50) pinned to the left edge. */}
      <div className="flex items-center justify-between pl-20 pr-6 py-3 shrink-0">
        <p className="text-white/70 text-sm font-medium">Meeting View — {tiles.length} {tiles.length === 1 ? 'peserta' : 'peserta'}</p>
        {/* Closest real equivalent to a "leave" action in this app — KaiSpace
            has no discrete hang-up/disconnect (you leave by proximity or by
            closing this view), so the spec's "leave merah" is applied here:
            neutral at rest, red on hover/focus to signal what it does. */}
        <Tooltip label="Keluar Meeting View" detail="Kembali ke tampilan peta biasa.">
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-white/10 hover:bg-red-500/80 text-white flex items-center justify-center cursor-pointer transition-colors"
          >
            <XLg size={16} />
          </button>
        </Tooltip>
      </div>

      {/* Featured stage — fills the bulk of the screen. */}
      <div className="flex-1 min-h-0 flex items-center justify-center pl-20 pr-6">
        {featured ? (
          // 16:9 box driven by the available height, so the tile keeps Google-
          // Meet proportions and the dark stage letterboxes around it instead of
          // the video stretching to fill the whole panel. max-w-full guards the
          // rare taller-than-16:9 container.
          <div className="relative h-full aspect-video max-w-full mx-auto">
            {renderTile(featured)}
            {isPinned && (
              // wrapperClassName carries the absolute positioning — Tooltip's
              // own wrapper div is `position: relative`, so it would
              // otherwise anchor `absolute top-2 right-2` to itself (and
              // collapse to 0×0, since it has no in-flow content) instead of
              // the featured-stage container.
              <Tooltip label="Lepas Sorotan" detail="Jadikan orang ini tampilan utama, atau kembali ke mode otomatis." wrapperClassName="absolute top-2 right-2 z-10">
                <button
                  onClick={() => setPinnedKey(null)}
                  className="inline-flex items-center gap-1 rounded-full bg-black/50 hover:bg-black/70 text-white text-[11px] px-2.5 py-1 backdrop-blur cursor-pointer"
                >
                  <PinFill size={11} /> Lepas
                </button>
              </Tooltip>
            )}
          </div>
        ) : tiles.length > 0 ? (
          // Nobody pinned and nobody's sharing — an even grid, everyone the
          // same size (Meet's default "Tiled" view), rather than forcing one
          // person into a spotlight nobody asked for. Columns/rows are the
          // explicit gridColumns/gridRows above, not CSS auto-fit — see that
          // comment for why. Click any tile to pin it.
          <div
            // overflow-x-hidden alongside overflow-y-auto — otherwise CSS
            // computes the unset x-axis as 'auto' too (an axis left at
            // 'visible' is forced to 'auto' the moment the other one isn't),
            // letting a speaking tile's ring/glow trigger a stray horizontal
            // scrollbar in a grid that only ever needs to scroll vertically.
            className="w-full h-full grid gap-3 place-content-center overflow-y-auto overflow-x-hidden py-1"
            style={{ gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${gridRows}, minmax(120px, 1fr))` }}
          >
            {tiles.map((t) => (
              <Tooltip key={t.key} label="Sorot Peserta Ini" detail="Jadikan orang ini tampilan utama, atau kembali ke mode otomatis." wrapperClassName="w-full h-full">
                <button
                  onClick={() => setPinnedKey(t.key)}
                  className="relative rounded-lg overflow-hidden cursor-pointer ring-1 ring-white/10 hover:ring-purple-400/70 transition-all w-full h-full"
                >
                  {renderTile(t)}
                </button>
              </Tooltip>
            ))}
          </div>
        ) : (
          <p className="text-white/40 text-sm">Belum ada yang on-camera — dekati seseorang untuk mulai video chat.</p>
        )}
      </div>

      {/* Thumbnail strip — everyone else; click one to pin it as the stage.
          Only alongside an actual featured tile — the grid above already
          covers "nobody's featured". */}
      {thumbnails.length > 0 && (
        <div className="shrink-0 flex justify-center pl-20 pr-6 pt-3">
          {/* overflow-y-hidden alongside overflow-x-auto, same reasoning as
              the tiled grid above — this row never scrolls vertically. */}
          <div className="flex gap-2 overflow-x-auto overflow-y-hidden max-w-full pb-1">
            {thumbnails.map((t) => (
              <Tooltip key={t.key} label="Sorot Peserta Ini" detail="Jadikan orang ini tampilan utama, atau kembali ke mode otomatis." wrapperClassName="shrink-0">
                <button
                  onClick={() => setPinnedKey(t.key)}
                  className="shrink-0 w-40 h-24 rounded-lg overflow-hidden cursor-pointer ring-1 ring-white/10 hover:ring-purple-400/70 transition-all"
                >
                  {renderTile(t)}
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      )}

      {/* Quick-reactions strip (reuses the in-world emote pipeline). Bottom
          clearance for the floating toolbar now comes from the outer
          container's own pb-20 above, not a local one here. Only shown while
          toggled on via the toolbar's Emoji button (showReactions) — it used
          to render unconditionally, permanently covering that spot. Selecting
          an emote does NOT auto-close the strip, matching the EmoteWheel
          radial picker's existing behavior (repeat reactions without
          reopening). */}
      {showReactions && (
        <div className="shrink-0 flex justify-center pt-2 animate-fade-in">
          <div className="flex items-center gap-1 bg-white/10 border border-white/15 rounded-full px-2 py-1.5 backdrop-blur-sm pointer-events-auto">
            {EMOTE_LIST.map((emote) => (
              <Tooltip key={emote} label="Kirim Reaksi" detail="Kirim reaksi emoji cepat, kelihatan oleh semua orang di meeting.">
                <button
                  onClick={() => onEmote(emote)}
                  className="w-9 h-9 rounded-full flex items-center justify-center text-xl hover:bg-white/20 hover:scale-110 active:scale-95 transition-all cursor-pointer"
                >
                  {EMOTE_EMOJI[emote]}
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
