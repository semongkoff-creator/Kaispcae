import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import {
  TILE_SIZE,
  MAP_WIDTH,
  MAP_HEIGHT,
  Avatar,
  TileType,
  Furniture,
  RoomTile,
  Direction,
  ProximityPlayer,
  PROXIMITY_THRESHOLD_PX,
  EMOTE_EMOJI,
  JUMP_DURATION_MS,
  JUMP_HEIGHT_PX,
  NUDGE_DURATION_MS,
  NUDGE_SHAKE_PX,
  ReferenceImageData,
  Zone,
  doesRectOverlapImpassableArea,
  roleAtLeast,
} from '@virtualmeet/shared';
import { useGameStore, OVERVIEW_ZOOM_THRESHOLD } from '@/stores/gameStore';
import { useMovement } from '@/hooks/useMovement';
import { drawAvatar } from './AvatarSprite';
import { drawSpriteFrame, getSpriteImage } from '@/utils/spriteLoader';
import { disableImageSmoothing } from '@/utils/canvasSharpness';
import { PALETTE_BY_ID } from '@/data/themeAssets';
import { isTileBlocked, isDoorTile } from '@/utils/createDefaultRoom';
import { findTilePath, getCardinalWaypointTarget, simplifyPath } from '@/utils/pathfinding';
import { avatarColor } from '@/components/ui/ChatAvatar';
// Bug 16-project (Room Editor) — these map-draw helpers were moved verbatim to
// mapRender.ts so the editor can render the map identically. GameCanvas's usage
// is unchanged.
import { drawTile, drawFloorTile, drawWallTile, drawFurnitureLayer, TILE_COLORS } from './mapRender';
import { drawMiniTileType, drawMiniZoneBackground, MINI_FURNITURE, MINI_WALL_AREA } from './miniRender';

// Kept proportional to TILE_SIZE (same ratio as AvatarSprite.ts's own copy of
// this constant) so decorations positioned relative to it — crown, speaker
// icon, speech bubble, speaking-pulse ring — stay the same relative distance
// from the avatar as the sprite itself scales with TILE_SIZE (Fitur 4).
const AVATAR_RADIUS = TILE_SIZE * (14 / 32);

// Shared by both the legacy (approach-direction) and orientation-aware
// (sitFacing) sit-direction paths in performSit below — one lookup, not two.
const OPPOSITE_DIRECTION: Record<Direction, Direction> = { up: 'down', down: 'up', left: 'right', right: 'left' };

// Which Direction a piece's "front" faces at each Rotate&Flip rotation value
// (mapRender.ts's drawFurnitureLayer applies `ctx.rotate(rotation * PI/180)`,
// which is a CLOCKWISE visual rotation for a positive angle in canvas's
// Y-down coordinate system). 0° art conventionally faces the viewer, i.e.
// 'down' on screen; each +90° of rotation turns that clockwise: down → left
// → up → right → back to down.
const ROTATION_FRONT: Record<0 | 90 | 180 | 270, Direction> = { 0: 'down', 90: 'left', 180: 'up', 270: 'right' };

// Orientation-aware sit direction for a piece with an explicit sitFacing
// (see Furniture.sitFacing's doc comment — pieces without one keep the
// legacy player-approach-direction behavior in performSit instead of calling
// this). Combines the object's CURRENT rotation with sitFacing to get the
// real avatar Direction:
//  - 'front'/'back' read straight off ROTATION_FRONT (back = opposite).
//  - 'side' is perpendicular to the front/back axis — two candidates exist
//    (e.g. front=down → sides are left/right); flipH picks between them.
//    There's no inherent "true" left/right for an arbitrary uploaded image,
//    so the +90°-vs-270°-offset convention below is arbitrary but
//    deterministic, and — the actual requirement — DOES swap which side is
//    used when the object is flipped horizontally.
function computeSitFacingDirection(chair: Furniture): Direction {
  const rotation = (chair.rotation ?? 0) as 0 | 90 | 180 | 270;
  const front = ROTATION_FRONT[rotation];
  if (chair.sitFacing === 'back') return OPPOSITE_DIRECTION[front];
  if (chair.sitFacing === 'side') {
    const sideRotation = ((rotation + (chair.flipH ? 270 : 90)) % 360) as 0 | 90 | 180 | 270;
    return ROTATION_FRONT[sideRotation];
  }
  return front; // 'front' (also the default if sitFacing is somehow unset when this is called)
}

// Floor-plan reference image (see gameStore.ts's liveReferenceImage) — only
// ever set when the admin opted into showInGame, so the photo itself is
// meant to BE the visible map, not a translucent trace guide like in the
// editor. Drawn on top of the floor/wall tiles (which are fully opaque and
// would otherwise hide it) but BELOW furniture/avatars, so any real
// interactive objects or players placed on top stay visible. Camera-offset
// manually since GameCanvas never uses ctx.translate for panning (unlike
// RoomEditorPage.tsx's version of this same helper).
function drawLiveReferenceImage(ctx: CanvasRenderingContext2D, ref: ReferenceImageData | null, cameraX: number, cameraY: number) {
  if (!ref || !ref.visible) return;
  const img = getSpriteImage(ref.url);
  if (!img) return;
  ctx.save();
  ctx.globalAlpha = ref.opacity;
  ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, ref.x - cameraX, ref.y - cameraY, ref.width, ref.height);
  ctx.restore();
}

// Follow (§3): where a follower stands relative to their target, based on
// the target's current facing direction — one tile on the side "behind"
// them, per spec's example ("target menghadap 'right' -> follower taruh di
// 'left'-nya"), not directly on top of them (which would just stack the
// two avatars on the same tile).
const FOLLOW_OFFSET: Record<Direction, { dx: number; dy: number }> = {
  up: { dx: 0, dy: 1 },
  down: { dx: 0, dy: -1 },
  left: { dx: 1, dy: 0 },
  right: { dx: -1, dy: 0 },
};

// ZEP-style spotlight — a "Private Area" drawn in the Room Editor has no
// `effect` field surviving at runtime (Zone only carries `audioIsolated`,
// see mapLayers.ts's layerDataToLegacy), so `audioIsolated !== false` is the
// same signal useProximity.ts's audioZoneAt already uses to decide "is this
// actually isolating" — same convention, not a new one. Meeting rooms are
// excluded even when isolating: they already have their own full-width
// label bar + video-call UI, and stacking this effect on top of that wasn't
// asked for. Focus areas DO get this treatment (label hidden, dimming
// applied) per the room admin — reversed from an earlier "stay visually
// normal" pass once they saw a room full of repeated "Focus" pills in
// practice; see the dimming color split below for why it's not identical
// to Private Area's.
function isPrivateZone(zone: Zone): boolean {
  return zone.audioIsolated !== false && zone.type !== 'meeting';
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width < maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [text.slice(0, 30)];
}

interface GameCanvasProps {
  emitMove: (x: number, y: number, direction: string, isRunning?: boolean) => void;
  emitStop: (x: number, y: number, direction: string) => void;
  emitJump: () => void;
  emitNudge: (targetId: string) => void;
  proximityData: ProximityPlayer[];
  localSpeaking: boolean;
  speakingPlayers: Set<string>;
  micMuted: boolean;
  cameraOn: boolean;
  editorMode: boolean;
  selectedTileType: TileType;
  selectedPaletteId?: string;
  onTilePaint: (x: number, y: number, type: TileType) => void;
  onTileHistoryPush: () => void;
  onFloorPaint: (x: number, y: number, paletteId: string) => void;
  onFurniturePlace: (x: number, y: number, paletteId: string) => void;
  onFurnitureErase: (x: number, y: number) => void;
  zoneDrawMode: boolean;
  onZoneDrawComplete: (x: number, y: number, width: number, height: number) => void;
  bannerPlaceMode: boolean;
  onBannerPlaceComplete: (x: number, y: number) => void;
  onPortalEnter: (target: string) => void;
  emitSit: (sitting: boolean, x: number, y: number, direction: Direction, seatFurnitureId?: string) => void;
  emitFollowUnfollow: () => void;
  // A4 — free double-click teleport.
  emitTeleportTo: (x: number, y: number, direction: Direction) => void;
  // Claimable-seat markers (Room Editor's 'claimableSeat' tile effect) —
  // click an empty one to claim it, click your own to teleport there
  // (reusing emitTeleportTo above, not a second teleport path).
  emitClaimSeat: (seatId: string) => void;
  emitReleaseSeat: (seatId: string) => void;
  onMediaOpen: (mediaId: string) => void;
  // Fitur 15B — fires when the local player triggers an Interactive Object
  // (Press F in range, or automatic on entering range). The parent looks up
  // the Furniture by id (already has the full furniture list) to read its
  // interactiveType/interactiveConfig and show the right modal.
  onInteractiveTrigger: (furnitureId: string) => void;
  // QA #7/#8/#9 — clicking a note marker opens it for viewing/editing (same
  // click-to-open convention as media markers below — a note is placed via
  // Add Media, not tied to any furniture piece).
  onNoteOpen: (noteId: string) => void;
  // ZEP-style door password — fires once per approach (same auto-trigger/
  // re-arm pattern as onInteractiveTrigger's 'automatic' pieces above) when
  // the local player gets adjacent to a password-protected door they
  // haven't unlocked yet this session.
  onDoorPasswordTrigger: (x: number, y: number) => void;
}

const MEDIA_ICON: Record<string, string> = { image: '🖼️', youtube: '▶️', whiteboard: '📝', file: '📎', website: '🔗', bgm: '🎵' };
// Potong 6 — how close (tiles, Chebyshev) a player must be for a YouTube tile to
// auto-embed its player.
const YT_EMBED_RADIUS = 2;

// How long the nudge-impact spark burst stays on screen — longer than
// NUDGE_DURATION_MS (the shake) since the burst reads better lingering a
// bit after the shake itself has settled.
const NUDGE_FX_DURATION_MS = 600;
const NUDGE_SPARK_COUNT = 8;
// Locate ("Temukan") — how long the pulsing ring stays over a searched-for
// player's avatar, giving the searcher time to actually spot them while
// their own avatar walks over.
const LOCATE_HIGHLIGHT_DURATION_MS = 3000;

// Bug 3 — how forgiving the "walk up to interact" hitbox is, in tiles
// (Chebyshev). The old chair logic demanded the player stand on the exact
// adjacent tile AND face the seat dead-on; media used a radius of 1. A radius
// of 2 lets the player be ~1 tile of slack away in any direction (incl.
// diagonals) and still get the prompt, while nearest-wins selection keeps two
// nearby pieces from being confused for one another.
const INTERACT_TILE_RADIUS = 2;
// Fitur 15B — 'animation' Interactive Object overlay: how long a trigger
// plays for (must match the duration App.tsx passes to
// triggerMomentaryReveal for this type) and how fast frames advance (~8fps).
const ANIMATION_OVERLAY_DURATION_MS = 4000;
const ANIMATION_FRAME_MS = 120;
// Chairs are the exception: SPACE means BOTH "sit" and "jump", and sit wins
// whenever a seat is in range — at radius 2 an office map full of desks left
// almost nowhere Space still jumped ("kalo diem gabisa loncat"). Radius 1
// (own tile + the 8 around it, facing still only a tiebreaker) keeps Bug 3's
// no-exact-facing forgiveness without the sit swallowing the jump key from
// two tiles away. Media keeps the wider radius — X isn't overloaded.
const SIT_TILE_RADIUS = 1;

// Hand gesture shown on the NUDGER's own body (not the target) — a fist
// bump reads as the closest match to "senggol" itself, and deliberately
// isn't a single-finger pointing hand (👉).
const NUDGE_GESTURE = '👊';

// A small 4-point star ("spark"), used by the nudge burst effect above —
// plain canvas vector shapes instead of an emoji glyph so the look doesn't
// depend on the browser/OS having a color emoji font installed.
function drawSpark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x + size * 0.35, y - size * 0.35);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x + size * 0.35, y + size * 0.35);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x - size * 0.35, y + size * 0.35);
  ctx.lineTo(x - size, y);
  ctx.lineTo(x - size * 0.35, y - size * 0.35);
  ctx.closePath();
  ctx.fill();
}

// Jump — a one-shot vertical hop (half a sine arc: 0 -> -JUMP_HEIGHT_PX -> 0),
// added on top of the normal walk-bob offset below. Returns 0 once
// JUMP_DURATION_MS has elapsed, so a stale/never-cleared jumpingPlayers
// entry (e.g. its player left mid-jump) just silently stops contributing
// anything rather than needing to be pruned.
function getJumpOffset(startTimestamp: number | undefined, timestamp: number): number {
  if (startTimestamp === undefined) return 0;
  const elapsed = timestamp - startTimestamp;
  if (elapsed < 0 || elapsed > JUMP_DURATION_MS) return 0;
  return -JUMP_HEIGHT_PX * Math.sin((Math.PI * elapsed) / JUMP_DURATION_MS);
}

// Nudge ("senggol") — a one-shot horizontal shake (decaying side-to-side
// wiggle: sin() gives the wiggle, the outer decay factor tapers it to 0 by
// NUDGE_DURATION_MS instead of cutting off mid-swing). Same
// never-explicitly-cleared / just-stops-contributing-once-expired
// convention as getJumpOffset above.
function getNudgeShakeOffset(startTimestamp: number | undefined, timestamp: number): number {
  if (startTimestamp === undefined) return 0;
  const elapsed = timestamp - startTimestamp;
  if (elapsed < 0 || elapsed > NUDGE_DURATION_MS) return 0;
  const decay = 1 - elapsed / NUDGE_DURATION_MS;
  return NUDGE_SHAKE_PX * decay * Math.sin((elapsed / 40) * Math.PI);
}

export function GameCanvas({ emitMove, emitStop, emitJump, emitNudge, proximityData, localSpeaking, speakingPlayers, micMuted, cameraOn, editorMode, selectedTileType, selectedPaletteId, onTilePaint, onTileHistoryPush, onFloorPaint, onFurniturePlace, onFurnitureErase, zoneDrawMode, onZoneDrawComplete, bannerPlaceMode, onBannerPlaceComplete, onPortalEnter, emitSit, emitFollowUnfollow, emitTeleportTo, emitClaimSeat, emitReleaseSeat, onMediaOpen, onInteractiveTrigger, onNoteOpen, onDoorPasswordTrigger }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const prevTimeRef = useRef<number>(0);
  const wasMovingRef = useRef<boolean>(false);

  const emitMoveRef = useRef(emitMove); emitMoveRef.current = emitMove;
  const emitStopRef = useRef(emitStop); emitStopRef.current = emitStop;
  const emitJumpRef = useRef(emitJump); emitJumpRef.current = emitJump;
  const emitNudgeRef = useRef(emitNudge); emitNudgeRef.current = emitNudge;
  const onMediaOpenRef = useRef(onMediaOpen); onMediaOpenRef.current = onMediaOpen;
  const onInteractiveTriggerRef = useRef(onInteractiveTrigger); onInteractiveTriggerRef.current = onInteractiveTrigger;
  const onDoorPasswordTriggerRef = useRef(onDoorPasswordTrigger); onDoorPasswordTriggerRef.current = onDoorPasswordTrigger;
  const emitSitRef = useRef(emitSit); emitSitRef.current = emitSit;
  const emitFollowUnfollowRef = useRef(emitFollowUnfollow); emitFollowUnfollowRef.current = emitFollowUnfollow;

  const tiles = useGameStore((s) => s.tiles);
  // Item #9 (precise-collision follow-up) — see useMovement.ts's wouldCollide;
  // checked every animation-loop frame regardless of React re-renders, so
  // this doesn't need to be reactive the way nudgedPlayers/speechBubbles
  // below do — synced into a ref the same way tiles already is.
  const impassableAreaRects = useGameStore((s) => s.impassableAreaRects);
  // Room Editor's "Wall Area" tool — drawn every frame in the render loop
  // below (the one impassable-rect flavor that's actually visible), same
  // ref-mirroring as impassableAreaRects above so the draw loop reads a
  // fresh value every frame without depending on React re-renders.
  const wallAreaRects = useGameStore((s) => s.wallAreaRects);
  const localPlayer = useGameStore((s) => s.localPlayer);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const theme = useGameStore((s) => s.theme);
  const followInfo = useGameStore((s) => s.followInfo);
  // Reactive for the same reason as nudgedPlayers below — a Locate click
  // fired while the local player is standing still (nothing else forcing a
  // re-render) still needs to be picked up promptly by the frame loop.
  const locateRequest = useGameStore((s) => s.locateRequest);
  // Reactive (not just useGameStore.getState()) so a nudge landing while
  // nothing else on screen happens to be re-rendering still triggers one —
  // otherwise the ref below (and the shake/pop effect it drives) can go
  // stale until some unrelated state change happens to re-render GameCanvas.
  const nudgedPlayers = useGameStore((s) => s.nudgedPlayers);
  const nudgerPlayers = useGameStore((s) => s.nudgerPlayers);
  // Bug 21 — same reason as nudgedPlayers above: a chat bubble landing while
  // the local avatar (and everyone else on screen) is standing still never
  // got picked up until some unrelated re-render happened to sync bubblesRef.
  // That's exactly the "bubble shows for others nearby but not for the
  // sender" symptom — nearby users are usually still moving (re-rendering
  // often), while the sender is stationary composing/sending the message.
  const speechBubbles = useGameStore((s) => s.speechBubbles);
  // Same reason as nudgedPlayers/speechBubbles above: a jump triggered while
  // standing still (nothing else on screen re-rendering) never got picked up
  // by jumpingPlayersRef below until some unrelated state change happened to
  // re-render GameCanvas — which read as "the jump button does nothing at
  // all" whenever the presser (or anyone visible) wasn't already moving.
  const jumpingPlayers = useGameStore((s) => s.jumpingPlayers);
  // Soundboard — same reactive-not-lazy reason as jumpingPlayers/nudgedPlayers
  // above: the blinking speaker indicator must appear even for a sender
  // standing still.
  const playingSoundboard = useGameStore((s) => s.playingSoundboard);
  // ZEP-style door password — reactive for the same reason as the others
  // above: solving one must immediately unblock movement/stop re-prompting,
  // which the collision check (running every frame during active movement)
  // needs read fresh, not stale until an unrelated re-render.
  const unlockedDoors = useGameStore((s) => s.unlockedDoors);
  // Item #9 — emergency door override; same reactive-for-collision reasoning
  // as unlockedDoors above.
  const doorOverride = useGameStore((s) => s.doorOverride);

  const tilesRef = useRef(tiles);
  const impassableAreaRectsRef = useRef(impassableAreaRects);
  const wallAreaRectsRef = useRef(wallAreaRects);
  const themeRef = useRef(theme);
  const followInfoRef = useRef(followInfo);
  const locateRequestRef = useRef(locateRequest);
  // Guards against re-processing the SAME locate request every frame while
  // it sits in the store — only the arrival of a NEW requestId should
  // trigger a fresh pathfind + highlight.
  const handledLocateRequestIdRef = useRef<number | null>(null);
  // Pulsing ring drawn over the located player's avatar for a few seconds
  // (see the draw loop below) — purely a "look, it's them" visual cue, no
  // gameplay effect.
  const locateHighlightRef = useRef<{ playerId: string; start: number } | null>(null);
  const playerRecordsRef = useRef(useGameStore.getState().playerRecords);
  const localPlayerRef = useRef(localPlayer);
  const localPlayerIdRef = useRef(localPlayerId);
  const bubblesRef = useRef(speechBubbles);
  // Fitur 15B — momentary display Interactive Object reveals ('show_name',
  // 'show_word_balloon'), same lazy-resync pattern as bubblesRef above
  // (re-read from the store whenever this component next re-renders for any
  // reason, not a reactive subscription).
  const momentaryRevealsRef = useRef(useGameStore.getState().momentaryReveals);
  const emotesRef = useRef(useGameStore.getState().emoteEvents);
  const jumpingPlayersRef = useRef(jumpingPlayers);
  const unlockedDoorsRef = useRef(unlockedDoors);
  const doorOverrideRef = useRef(doorOverride);
  // Re-arm the auto-trigger on leaving/re-entering range, same as
  // autoTriggeredIdsRef below for 'automatic' Interactive Objects.
  const doorAutoTriggeredRef = useRef(new Set<string>());
  const nudgedPlayersRef = useRef(nudgedPlayers);
  const nudgerPlayersRef = useRef(nudgerPlayers);
  const playingSoundboardRef = useRef(playingSoundboard);
  const zones = useGameStore((s) => s.zones);
  const zonesRef = useRef(zones);
  // Reactive (unlike the raw draw loop's own getState() zoom read) purely to
  // gate the zone-label DOM banners below — they're redundant with Overview
  // mode's in-canvas block labels, and zoom only changes on an actual user
  // action (button/wheel), so this re-render is cheap/rare, not per-frame.
  const mapZoomReactive = useGameStore((s) => s.mapZoom);
  const isOverviewReactive = mapZoomReactive <= OVERVIEW_ZOOM_THRESHOLD;
  // Labeled zones render a DOM banner positioned imperatively (via transform,
  // inside the rAF loop below) instead of React state, so following the
  // camera at 60fps doesn't trigger a re-render for every frame.
  const zoneBannerRefs = useRef(new Map<string, HTMLDivElement>());
  const furniture = useGameStore((s) => s.furniture);
  const furnitureRef = useRef(furniture);
  // QA #7/#8/#9 — desk notes, placed freeform via Add Media (not attached to
  // furniture). Ref-mirrors `notes` the same way mediaObjects does below, so
  // the per-frame position-sync loop reads a stable snapshot without
  // re-subscribing every frame.
  const notes = useGameStore((s) => s.notes);
  const notesRef = useRef(notes);
  const noteMarkerRefs = useRef(new Map<string, HTMLDivElement>());
  // Banner furniture (Furniture.kind === 'banner') renders as a DOM overlay
  // too, positioned the same imperative way as zone banners above.
  const bannerRefs = useRef(new Map<string, HTMLDivElement>());
  const mediaObjects = useGameStore((s) => s.mediaObjects);
  const mediaObjectsRef = useRef(mediaObjects);
  // Claimable-seat markers (Room Editor's 'claimableSeat' tile effect) —
  // same DOM-overlay pattern as media markers above. Derived from `tiles`
  // (RoomTile.claimableSeatId, set by mapLayers.ts's layerDataToLegacy)
  // rather than a separate fetch: the marker's existence/position is just
  // "a tile has this id", already delivered over the normal tiles channel.
  const claimableSeats = useMemo(() => {
    const seats: { id: string; x: number; y: number }[] = [];
    for (let y = 0; y < tiles.length; y++) {
      for (let x = 0; x < (tiles[y]?.length ?? 0); x++) {
        const id = tiles[y][x]?.claimableSeatId;
        if (id) seats.push({ id, x, y });
      }
    }
    return seats;
  }, [tiles]);
  const claimableSeatsRef = useRef(claimableSeats);
  const claimSeatMarkerRefs = useRef(new Map<string, HTMLDivElement>());
  // ZEP-style confirm-before-claim — clicking a seat that isn't already
  // yours used to fire emitClaimSeat immediately on click; per the room
  // admin, EVERY claim (whether the seat looks free or is shown taken by
  // someone else) should show a confirm popup first, not claim on a bare
  // click. Null = no popup showing. ownerName is only set for the
  // "already taken" wording; a free-looking seat gets the plain variant.
  const [pendingSeatClaim, setPendingSeatClaim] = useState<{ seatId: string; ownerName: string | null } | null>(null);
  // Live ownership — reactive (not just .getState()) so a marker's label/
  // click-behavior updates the instant someone else claims or releases it.
  const seatClaims = useGameStore((s) => s.seatClaims);
  const localUserId = useGameStore((s) => s.localUserId);
  // Floor-plan reference image (see gameStore.ts) — only ever non-null when
  // the admin opted into showInGame; drawn as an overlay, see the draw loop.
  const liveReferenceImage = useGameStore((s) => s.liveReferenceImage);
  const liveReferenceImageRef = useRef(liveReferenceImage);
  // Room-wide avatar size (see gameStore.ts) — read via ref, same pattern as
  // every other per-frame draw-loop value on this page.
  const avatarScale = useGameStore((s) => s.avatarScale);
  const avatarScaleRef = useRef(avatarScale);
  // Potong 6 — which YouTube tile is close enough to auto-embed (proximity).
  const [ytEmbedId, setYtEmbedId] = useState<string | null>(null);
  const ytEmbedRef = useRef<string | null>(null);
  // Bug 11 — the auto-embed starts muted (autoplay without mute is blocked by
  // every modern browser's autoplay policy anyway), so it needs a LOUD,
  // obvious unmute affordance: this tracks whether the currently-embedded
  // video has been unmuted (via the YT IFrame postMessage API — enablejsapi=1
  // on the embed URL). Reset whenever the embedded tile changes, so walking
  // away and back starts muted again, exactly like the fresh embed it is.
  const [ytUnmuted, setYtUnmuted] = useState(false);
  const ytIframeRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => { setYtUnmuted(false); }, [ytEmbedId]);
  // Bug media #1 — "Perbesar" on the LIVE embed used to open MediaViewerModal,
  // which renders a completely SEPARATE, freshly-created <iframe> (no
  // autoplay/no start position) — the video the user was just watching kept
  // playing invisibly behind the modal while a brand-new, unstarted player
  // showed up front, reading as "the video stopped". Fixed by never creating
  // a second iframe at all: this just grows the SAME marker (see the media
  // render loop below and the per-frame transform loop) to fill the screen —
  // the <iframe> element itself is never unmounted, so playback/mute state
  // carries over untouched. Reset whenever the embedded tile changes (walked
  // away, or someone deleted it) so a stale fullscreen view can't outlive the
  // player it was showing.
  const [maximizedYtId, setMaximizedYtId] = useState<string | null>(null);
  useEffect(() => { setMaximizedYtId(null); }, [ytEmbedId]);
  // §6 — Add Media markers: same DOM-overlay-positioned-via-transform
  // pattern as zone/banner above, one small clickable pin per object.
  const mediaMarkerRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    tilesRef.current = tiles;
    impassableAreaRectsRef.current = impassableAreaRects;
    wallAreaRectsRef.current = wallAreaRects;
    themeRef.current = theme;
    followInfoRef.current = followInfo;
    locateRequestRef.current = locateRequest;
    playerRecordsRef.current = useGameStore.getState().playerRecords;
    localPlayerRef.current = localPlayer;
    localPlayerIdRef.current = localPlayerId;
    bubblesRef.current = speechBubbles;
    momentaryRevealsRef.current = useGameStore.getState().momentaryReveals;
    emotesRef.current = useGameStore.getState().emoteEvents;
    jumpingPlayersRef.current = jumpingPlayers;
    unlockedDoorsRef.current = unlockedDoors;
    doorOverrideRef.current = doorOverride;
    nudgedPlayersRef.current = nudgedPlayers;
    nudgerPlayersRef.current = nudgerPlayers;
    playingSoundboardRef.current = playingSoundboard;
    zonesRef.current = zones;
    furnitureRef.current = furniture;
    notesRef.current = notes;
    mediaObjectsRef.current = mediaObjects;
    claimableSeatsRef.current = claimableSeats;
    liveReferenceImageRef.current = liveReferenceImage;
    avatarScaleRef.current = avatarScale;
  });

  const proximityRef = useRef(proximityData); proximityRef.current = proximityData;
  const localSpeakingRef = useRef(localSpeaking); localSpeakingRef.current = localSpeaking;
  const speakingPlayersRef = useRef(speakingPlayers); speakingPlayersRef.current = speakingPlayers;
  const micMutedRef = useRef(micMuted); micMutedRef.current = micMuted;
  const cameraOnRef = useRef(cameraOn); cameraOnRef.current = cameraOn;

  const editorModeRef = useRef(editorMode); editorModeRef.current = editorMode;
  const selectedTileRef = useRef(selectedTileType); selectedTileRef.current = selectedTileType;
  const selectedPaletteRef = useRef(selectedPaletteId); selectedPaletteRef.current = selectedPaletteId;
  const isPaintingRef = useRef(false);
  const hoverTileRef = useRef<{ x: number; y: number } | null>(null);
  const cameraXRef = useRef(0);
  const cameraYRef = useRef(0);
  // The zoom actually used to render the last frame — equals mapZoom
  // outside Overview, but Overview's dynamically-computed fit-to-viewport
  // value while active (see the draw loop). Click/dblclick handlers read
  // this instead of raw mapZoom so their coordinate math matches the screen.
  const effectiveZoomRef = useRef(1);

  const zoneDrawModeRef = useRef(zoneDrawMode); zoneDrawModeRef.current = zoneDrawMode;
  const onZoneDrawCompleteRef = useRef(onZoneDrawComplete); onZoneDrawCompleteRef.current = onZoneDrawComplete;
  const bannerPlaceModeRef = useRef(bannerPlaceMode); bannerPlaceModeRef.current = bannerPlaceMode;
  const onBannerPlaceCompleteRef = useRef(onBannerPlaceComplete); onBannerPlaceCompleteRef.current = onBannerPlaceComplete;
  const onPortalEnterRef = useRef(onPortalEnter); onPortalEnterRef.current = onPortalEnter;
  const zoneDragStartRef = useRef<{ x: number; y: number } | null>(null);
  const zoneDragCurrentRef = useRef<{ x: number; y: number } | null>(null);
  // ZEP portal (Potong 5) — the portal tile the local player is standing on
  // (if any), driving the "Press F" prompt + trigger. Replaces the old
  // step-on auto-travel. Cooldown timestamp blocks instant back-and-forth.
  const nearbyPortalRef = useRef<{ tileX: number; tileY: number; target?: string; targetX?: number; targetY?: number; label?: string } | null>(null);
  const portalCooldownRef = useRef(0);

  const isBlocked = useCallback((tileX: number, tileY: number) => {
    const t = tilesRef.current;
    if (t.length === 0) return false; // room state not loaded yet — don't block movement
    if (isTileBlocked(t, tileX, tileY)) return true;
    // ZEP-style door password — client-side prediction only (the server
    // independently enforces the same thing authoritatively, see
    // movementHandler.ts's isBlockedForSocket). A door is never in
    // BLOCKED_TILES itself, so this is the only place that treats an
    // unsolved one as impassable.
    const tile = t[tileY]?.[tileX];
    if (tile?.type === 'door' && tile.doorPasswordEnabled) {
      // Item #9 — emergency override mirrors the server's own bypass.
      if (doorOverrideRef.current) return false;
      return !unlockedDoorsRef.current.has(`${tileX},${tileY}`);
    }
    return false;
  }, []);

  // Bug 7 — feeds useMovement's door-hitbox leniency (see its wouldCollide).
  const isDoor = useCallback((tileX: number, tileY: number) => {
    const t = tilesRef.current;
    if (t.length === 0) return false;
    return isDoorTile(t, tileX, tileY);
  }, []);

  const onMoveRef = useRef((x: number, y: number, direction: Direction) => {
    useGameStore.getState().setLocalPlayer({ x, y, direction, isMoving: true });
  });

  const { update, setPosition, updateFollow } = useMovement({
    isBlocked,
    onMove: onMoveRef.current,
    isFrozen: () => useGameStore.getState().localPlayer.isSitting === true,
    isDoor,
    getImpassableAreas: () => impassableAreaRectsRef.current,
  });

  useEffect(() => {
    setPosition(localPlayer.x, localPlayer.y);
  }, [localPlayer.x, localPlayer.y, setPosition]);

  // Click a non-blocked tile. Refs so the once-attached listener
  // always reads current values without re-binding.
  const emitTeleportToRef = useRef(emitTeleportTo); emitTeleportToRef.current = emitTeleportTo;
  const setPositionRef = useRef(setPosition); setPositionRef.current = setPosition;
  // Transient fade rings at teleport source + destination (performance.now()
  // timestamps), drawn + expired in the render loop. Only used by the
  // GENUINELY instant teleports left (Portal via F, clicking your claimed
  // seat) — click-to-move below no longer pushes to this, since it's
  // walking there now, not blinking.
  const teleportFlashRef = useRef<{ x: number; y: number; start: number }[]>([]);
  // Follow-up — click now WALKS to the tile (reusing useMovement's
  // updateFollow/tryMoveToward, the exact primitive Follow already uses to
  // approach an arbitrary point) instead of teleporting there instantly.
  // Read/driven every frame in the animation loop below, same pattern as
  // followInfoRef. Cleared on arrival, on getting stuck (tryMoveToward stops
  // reporting movement either way), or the instant a REAL movement key is
  // pressed — same "manual input always wins" rule Follow already uses.
  //
  // A real waypoint QUEUE now, not a single point — see findTilePath
  // (utils/pathfinding.ts). Straight-line-toward-a-single-target used to
  // just stop dead the moment a desk sat between the player and the click,
  // rather than routing around it; the click handler below now runs A* over
  // the tile grid once and hands back a list of waypoints tracing an actual
  // route, walked one at a time (front of the array = current sub-target,
  // shifted off on arrival).
  const walkTargetRef = useRef<{ x: number; y: number }[] | null>(null);

  // Shared by click-to-move AND Locate (ParticipantPanel's "Temukan"
  // action, driven by locateRequestRef further down) — both ultimately just
  // need "a waypoint route from here to this tile", so there's one A* call
  // site, not two copies that could drift apart on what counts as blocked.
  // Same walkability real movement collision uses — isBlocked (tile grid +
  // door-password state) PLUS furniture Impassable Area rects, which are
  // sub-tile and never rasterized into the tile grid itself (see
  // wouldCollide's own separate check in useMovement.ts).
  const computeWalkWaypoints = useCallback((targetTileX: number, targetTileY: number) => {
    const areas = impassableAreaRectsRef.current;
    const pathBlocked = (tx: number, ty: number) => {
      if (isBlocked(tx, ty)) return true;
      if (areas.length === 0) return false;
      const left = tx * TILE_SIZE;
      const top = ty * TILE_SIZE;
      return doesRectOverlapImpassableArea(areas, left, top, left + TILE_SIZE, top + TILE_SIZE);
    };
    const startTileX = Math.floor(localPlayerRef.current.x / TILE_SIZE);
    const startTileY = Math.floor(localPlayerRef.current.y / TILE_SIZE);
    // QA follow-up — MAP_WIDTH/MAP_HEIGHT are only the default grid size; a
    // resized room (Room Editor's Resize tool, up to 200x200) is bigger than
    // that, so bounding the pathfind to the fixed constants made any
    // click/Locate target past the old edge unreachable (findTilePath
    // rejects any out-of-bounds target outright) even though it's real,
    // walkable floor. Same real-size derivation as the Overview-mode fix.
    const cols = tilesRef.current[0]?.length || MAP_WIDTH;
    const rows = tilesRef.current.length || MAP_HEIGHT;
    const tilePath = findTilePath(startTileX, startTileY, targetTileX, targetTileY, pathBlocked, cols, rows);
    if (!tilePath) return null; // no route exists
    const waypoints = simplifyPath(tilePath).map((n) => ({
      x: n.x * TILE_SIZE + TILE_SIZE / 2,
      y: n.y * TILE_SIZE + TILE_SIZE / 2,
    }));
    return waypoints.length > 0 ? waypoints : null;
  }, [isBlocked]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onCanvasClick = (e: MouseEvent) => {
      if (editorModeRef.current) return; // never move while editing the room
      const store = useGameStore.getState();
      if (store.localPlayer.isSitting) return; // stand up first (movement is frozen)
      const rect = canvas.getBoundingClientRect();
      const zoom = effectiveZoomRef.current;
      const worldX = (e.clientX - rect.left) / zoom + cameraXRef.current;
      const worldY = (e.clientY - rect.top) / zoom + cameraYRef.current;
      const tileX = Math.floor(worldX / TILE_SIZE);
      const tileY = Math.floor(worldY / TILE_SIZE);
      if (tileX < 0 || tileY < 0) return;
      if (isBlocked(tileX, tileY)) return; // can't walk onto a wall/desk
      walkTargetRef.current = computeWalkWaypoints(tileX, tileY);
    };
    canvas.addEventListener('click', onCanvasClick);
    return () => canvas.removeEventListener('click', onCanvasClick);
  }, [isBlocked, computeWalkWaypoints]);

  // Mouse wheel / trackpad zoom — same factor-per-notch convention as the
  // Room Editor's own wheel handler. preventDefault stops the page itself
  // from scrolling while the cursor is over the canvas (there's nothing
  // else here to scroll). No pivot/pan compensation needed here (unlike
  // the Room Editor) since the main view's camera is always centered on
  // the player, never freely panned.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      useGameStore.getState().stepMapZoom(e.deltaY < 0 ? 1 : -1);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  // ── Sit-in-chair ─────────────────────────────────────────────────────
  // Updated every frame in draw() below (cheap — furniture lists are small)
  // so both the "press SPACE" indicator and the keydown handler read the
  // same up-to-date value without recomputing it twice. Two seat sources
  // share this: an isInteractable Furniture piece, or a bare 'sittable'
  // TileEffect-tagged tile (RoomTile.isSittable — no Furniture piece at
  // all, for rooms traced entirely over a reference-image photo). Both
  // funnel into the same performSit below.
  type NearbySeat =
    | { kind: 'furniture'; furniture: Furniture; tileX: number; tileY: number }
    | { kind: 'tile'; tile: RoomTile; tileX: number; tileY: number };
  const nearbyChairRef = useRef<NearbySeat | null>(null);
  // Gather-style "press X to interact" — the nearest placed media object
  // (image/youtube/whiteboard/file) within one tile of the player, if any.
  // Recomputed each frame in the draw loop (same pattern as nearbyChairRef).
  const nearbyMediaRef = useRef<{ id: string; tileX: number; tileY: number } | null>(null);
  // Fitur 15B — nearest press_f-type Interactive Object within ITS OWN
  // triggerRange (unlike media's fixed INTERACT_TILE_RADIUS, this is
  // per-piece — see the recompute below). Drives the "Press F" prompt;
  // KeyF fires it same as the portal branch does, whichever is present.
  const nearbyInteractiveRef = useRef<{ id: string; tileX: number; tileY: number } | null>(null);
  // 'automatic' pieces fire once per range-ENTRY, not once ever and not every
  // frame while still inside — tracked as a set of currently-inside ids so
  // leaving and re-entering fires it again, matching "Automatically trigger"'s
  // plain-English meaning.
  const autoTriggeredIdsRef = useRef<Set<string>>(new Set());

  const performSit = useCallback((seat: NearbySeat, tileX: number, tileY: number) => {
    // Seat at the exact tile faced, not always the furniture's anchor tile —
    // a multi-tile sofa is one seat spanning several tiles, so sitting from
    // its right half shouldn't visually snap the player over to its left end.
    const chairCenterX = tileX * TILE_SIZE + TILE_SIZE / 2;
    const chairCenterY = tileY * TILE_SIZE + TILE_SIZE / 2;
    // A bare sittable tile has no Furniture id to key occupancy/rendering
    // off of — synthesize one from its coordinate, stable across re-scans.
    const seatId = seat.kind === 'furniture' ? seat.furniture.id : `tile:${tileX},${tileY}`;

    // Refuse if another player is already seated on this exact tile —
    // without this check, two players could both sit at the same spot and
    // their avatars would render fully overlapping each other.
    const occupied = Object.values(playerRecordsRef.current).some(
      (p) => p.isSitting && (p.seatFurnitureId === seatId || (p.x === chairCenterX && p.y === chairCenterY)),
    );
    if (occupied) {
      // Was a silent no-op before — say why, so a taken seat doesn't read as
      // "sit is broken". Transient banner, same pattern as other HUD notices.
      useGameStore.getState().setSitNotice('Kursi ini sedang dipakai.');
      return;
    }

    const state = useGameStore.getState();
    const player = state.localPlayer;
    // The chair's own tile is movement-blocked, so simply leaving the
    // player there on stand-up would strand them inside a wall-like tile —
    // remember where they were so standing up can put them back.
    state.setSitReturnPos({ x: player.x, y: player.y });
    state.setSittingFurnitureId(seatId);
    // Furniture with an explicit sitFacing (see its doc comment) faces
    // however that + its current rotation/flipH resolve to; a sittable tile
    // uses its own absolute sitDirection directly (no rotation to combine
    // with — there's no object). Everything else (every built-in chair
    // placed before sitFacing existed) keeps the original behavior — face
    // away from the chair, outward into the room, like someone sitting down
    // rather than facing into the seat back.
    const sitDirection = seat.kind === 'furniture'
      ? (seat.furniture.sitFacing ? computeSitFacingDirection(seat.furniture) : OPPOSITE_DIRECTION[player.direction])
      : (seat.tile.sitDirection ?? OPPOSITE_DIRECTION[player.direction]);
    state.setLocalPlayer({ x: chairCenterX, y: chairCenterY, direction: sitDirection, isMoving: false, isSitting: true, seatFurnitureId: seatId });
    emitSitRef.current(true, chairCenterX, chairCenterY, sitDirection, seatId);
  }, []);

  // Nudge ("senggol", Z key) — finds whoever's closest to the local player
  // and asks the server to relay a nudge at them. No local trigger here:
  // unlike Jump (which animates the presser's own avatar and so needs
  // zero-latency local feedback), the visual effect lands on the TARGET, so
  // waiting for the server's broadcast — which reaches the nudger too, see
  // movementHandler.ts's io.to() — is both simpler (one code path drives
  // the animation for everyone, including the nudger) and in practice
  // instant on a same-room socket round trip.
  //
  // Deliberately NOT direction-gated: an earlier version only counted
  // someone standing strictly ahead of the local player's facing direction,
  // but two people who've walked up to chat almost always end up standing
  // SIDE BY SIDE facing the same way (e.g. both facing the camera), not one
  // behind the other — that layout has zero "forward" distance between
  // them, so the direction check silently found no target every time.
  // Plain nearest-within-range matches how "senggol" actually gets used.
  const performNudge = useCallback(() => {
    const player = localPlayerRef.current;
    const NUDGE_RANGE_PX = TILE_SIZE * 1.5;

    let target: Avatar | null = null;
    let bestDist = Infinity;
    for (const p of Object.values(playerRecordsRef.current)) {
      const dist = Math.hypot(p.x - player.x, p.y - player.y);
      if (dist > NUDGE_RANGE_PX) continue;
      if (dist < bestDist) { bestDist = dist; target = p; }
    }
    if (!target) return;
    emitNudgeRef.current(target.id);
  }, []);

  const performStandUp = useCallback(() => {
    const state = useGameStore.getState();
    const returnPos = state.sitReturnPos;
    const x = returnPos?.x ?? state.localPlayer.x;
    const y = returnPos?.y ?? state.localPlayer.y;
    const direction = state.localPlayer.direction;
    state.setLocalPlayer({ x, y, isSitting: false, seatFurnitureId: undefined });
    state.setSittingFurnitureId(null);
    state.setSitReturnPos(null);
    emitSitRef.current(false, x, y, direction);
  }, []);

  useEffect(() => {
    const handleSitKey = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      // Ignore the OS's own key-repeat while Space is held — otherwise
      // holding it down would fire a new jump (or re-toggle sit/stand)
      // every repeat tick instead of once per physical press.
      if (e.repeat) return;

      if (e.code === 'Space') {
        e.preventDefault();
        // A focused HUD button (Mic/Camera/Chat/Edit Avatar/etc. — clicking
        // any of them leaves it focused) still fires its own native click on
        // Space *keyup*, regardless of preventDefault() here on *keydown*
        // (browsers treat "scroll on Space" and "activate the focused
        // button on Space" as two separate default actions tied to two
        // separate events). That reactivated the last-clicked button
        // whenever Space was pressed to sit — e.g. re-toggling the mic —
        // which read as something randomly "jumping"/changing. Blurring now
        // removes the focus before that keyup fires, so nothing's left to
        // reactivate.
        const active = document.activeElement as HTMLElement | null;
        if (active && active !== document.body) active.blur();
        const state = useGameStore.getState();
        if (state.localPlayer.isSitting) {
          performStandUp();
        } else if (nearbyChairRef.current) {
          const seat = nearbyChairRef.current;
          performSit(seat, seat.tileX, seat.tileY);
        } else {
          // Jump — cosmetic only, no chair nearby and not already sitting.
          state.triggerJump(localPlayerIdRef.current, Date.now());
          emitJumpRef.current();
        }
        return;
      }

      if (e.code === 'KeyZ') {
        performNudge();
        return;
      }

      // Open the nearest media object (Gather-style interact). Only does
      // anything when standing next to one — see nearbyMediaRef above.
      if (e.code === 'KeyX') {
        if (nearbyMediaRef.current) {
          e.preventDefault();
          onMediaOpenRef.current(nearbyMediaRef.current.id);
        }
        return;
      }

      // ZEP portal (Potong 5) — F travels. Internal portals teleport within the
      // room (reusing the double-click teleport path); cross-room portals go
      // through the existing room-travel path (onPortalEnter). A short cooldown
      // stops an instant bounce back through a return portal.
      if (e.code === 'KeyF') {
        const np = nearbyPortalRef.current;
        if (np && portalCooldownRef.current <= performance.now()) {
          e.preventDefault();
          portalCooldownRef.current = performance.now() + 1500;
          if (np.targetX != null && np.targetY != null) {
            const cx = np.targetX * TILE_SIZE + TILE_SIZE / 2;
            const cy = np.targetY * TILE_SIZE + TILE_SIZE / 2;
            const store = useGameStore.getState();
            teleportFlashRef.current.push({ x: store.localPlayer.x, y: store.localPlayer.y, start: performance.now() }, { x: cx, y: cy, start: performance.now() });
            setPositionRef.current(cx, cy);
            store.setLocalPlayer({ x: cx, y: cy, isMoving: false });
            emitTeleportToRef.current(cx, cy, store.localPlayer.direction);
          } else if (np.target) {
            onPortalEnterRef.current(np.target);
          }
          return;
        }
        // Fitur 15B — no portal claiming F this tile: press_f Interactive
        // Objects get it instead.
        if (nearbyInteractiveRef.current) {
          e.preventDefault();
          onInteractiveTriggerRef.current(nearbyInteractiveRef.current.id);
        }
        return;
      }

      // Pressing a movement key while sitting stands you up first, instead
      // of silently eating the input (useMovement's isFrozen check would
      // otherwise just ignore it with no feedback).
      const MOVE_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'W', 'A', 'S', 'D'];
      if (MOVE_KEYS.includes(e.key) && useGameStore.getState().localPlayer.isSitting) {
        performStandUp();
      }
    };
    window.addEventListener('keydown', handleSitKey);
    return () => window.removeEventListener('keydown', handleSitKey);
  }, [performSit, performStandUp, performNudge]);

  const resizeCanvas = useCallback(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const rect = container.getBoundingClientRect();
    // Bug — a fluid (w-full h-full) container's getBoundingClientRect() is
    // routinely fractional (e.g. 843.66px), and canvas.width/height (the
    // backing store) always truncates to an integer regardless. Multiplying
    // the RAW fractional rect by dpr before that truncation let the backing
    // store and the CSS box (canvas.style.width/height, set from the same
    // raw fractional rect) drift by a sub-pixel from each other — the
    // browser then has to resample the canvas to fit its actual laid-out
    // box, softening every already-crisp nearest-neighbor pixel. Rounding
    // FIRST makes both sides agree exactly, so no implicit resampling ever
    // happens between backing store and display box.
    const cssWidth = Math.round(rect.width);
    const cssHeight = Math.round(rect.height);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Resizing canvas.width/height resets all context state, including this
      // — must re-set every resize, not just once. Without it the browser's
      // default bilinear smoothing blurs every scaled sprite drawImage() call
      // (avatars drawn at 40px from a 32px source, in particular).
      disableImageSmoothing(ctx);
    }
  }, []);

  const draw = useCallback((timestamp: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    disableImageSmoothing(ctx);

    // Map zoom — read fresh via getState() every frame (like every other
    // fast-changing value in this loop) rather than as a reactive dependency,
    // so a zoom change takes effect on the very next animation frame with no
    // extra re-render. Folded into the SAME dpr transform already in use —
    // every existing screenX/screenY draw call below is written in pre-zoom
    // "logical" pixels and needs no change; this one setTransform call is
    // the only thing that actually scales them to the zoomed-in/out size.
    const dpr = window.devicePixelRatio || 1;
    const rawZoom = useGameStore.getState().mapZoom;
    const logicalW = canvas.width / dpr;
    const logicalH = canvas.height / dpr;
    // QA follow-up (Full-office view still cropped after the first fit-zoom
    // fix) — MAP_WIDTH/MAP_HEIGHT (50x36) are only the DEFAULT grid size. The
    // Room Editor's Resize tool lets an admin grow a room up to 200x200
    // (editorStore.ts's resizeMap, routes/rooms.ts accepts up to 200), and
    // the server ships whatever size the room ACTUALLY is — layerDataToLegacy
    // builds `tiles` from the room's own stored width/height, not the fixed
    // constants. A room bigger than 50x36 was silently both under-fit
    // (Overview's zoom math assumed the smaller default box) AND cropped
    // (tile culling below was ALSO clamped to the fixed constants, so
    // anything past column 50 / row 36 was never even drawn) — two symptoms
    // of the same root cause. Deriving the real size from the loaded tiles
    // array itself — the same source of truth the server and every other
    // correct consumer in this file already use — fixes both at once, for
    // every room regardless of whether it was ever resized.
    const tiles = tilesRef.current;
    const mapCols = tiles[0]?.length || MAP_WIDTH;
    const mapRows = tiles.length || MAP_HEIGHT;
    // Overview mode — zoomed out past this, the detailed pixel-art tile/
    // furniture/sprite rendering below gives way to a simplified floor-plan
    // view (rooms as flat colored blocks, players as initial bubbles) —
    // see the isOverview branches further down.
    const isOverview = rawZoom <= OVERVIEW_ZOOM_THRESHOLD;
    // QA (Full-office view) — Overview used to render at the raw, FIXED
    // OVERVIEW_ZOOM_THRESHOLD (0.3) regardless of actual screen size. That
    // value only guarantees the map is never BIGGER than the viewport; on
    // any typical desktop window it's far smaller than needed, leaving most
    // of the screen empty lavender background around a small chunk of the
    // office instead of the "whole office at a glance" the feature is
    // supposed to be. While in Overview, replace the raw zoom with one
    // computed to fit the WHOLE (real-size) map exactly into THIS viewport
    // (recomputed every frame, so it also self-corrects on window resize) —
    // the normal, non-overview zoom range (the +/- control, wheel/trackpad)
    // is untouched, still driven by the raw mapZoom value.
    const zoom = isOverview
      ? Math.min(logicalW / (mapCols * TILE_SIZE), logicalH / (mapRows * TILE_SIZE))
      : rawZoom;
    ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, 0, 0);
    // Read by the click-to-move and click-to-teleport handlers
    // (outside this render loop) so their screen→world coordinate math
    // matches whatever's actually on screen right now, Overview's computed
    // fit-zoom included — otherwise a click while zoomed out to Overview
    // would resolve against the wrong (raw mapZoom) scale and land on the
    // wrong tile.
    effectiveZoomRef.current = zoom;

    if (prevTimeRef.current === 0) prevTimeRef.current = timestamp;
    const rawDt = (timestamp - prevTimeRef.current) / 1000;
    const dt = Math.min(rawDt, 0.05);
    prevTimeRef.current = timestamp;

    // World-space extent actually visible on screen at the current zoom —
    // MORE world becomes visible when zoomed out (zoom<1), less when zoomed
    // in (zoom>1). Camera centering, background fill, and tile/avatar
    // culling all need this (not the raw logical size) once zoom isn't 1.
    const worldViewW = logicalW / zoom;
    const worldViewH = logicalH / zoom;

    const moveResult = update(dt);
    let effectiveMoveResult = moveResult;

    // Follow (§3): while an active follow target exists, drive movement
    // toward a trailing position behind them instead of waiting for
    // keyboard input — but the instant a REAL key press produces movement
    // (moveResult.isMoving, which only ever reflects keyboard input — see
    // useMovement's tryMove), that's a manual move and immediately cancels
    // the follow, per spec. Frozen (sitting) is left alone either way —
    // follow just pauses until standing back up, same as keyboard input does.
    const activeFollow = followInfoRef.current;
    if (activeFollow) {
      if (moveResult.isMoving) {
        useGameStore.getState().setFollowInfo(null);
        emitFollowUnfollowRef.current();
      } else if (activeFollow.status === 'active' && !localPlayerRef.current.isSitting) {
        const targetPlayer = Object.values(playerRecordsRef.current).find((p) => p.userId === activeFollow.targetUserId);
        if (targetPlayer) {
          const offset = FOLLOW_OFFSET[targetPlayer.direction] ?? FOLLOW_OFFSET.down;
          const desiredX = targetPlayer.x + offset.dx * TILE_SIZE;
          const desiredY = targetPlayer.y + offset.dy * TILE_SIZE;
          effectiveMoveResult = updateFollow(desiredX, desiredY, dt);
        }
      }
    }

    // Locate ("Temukan") — ParticipantPanel's search-by-name action (see
    // gameStore's locateRequest doc comment). A fresh requestId feeds the
    // exact same pathfinding walkTargetRef below drives, plus a brief
    // highlight ring on the target's avatar (drawn further down the loop).
    const lr = locateRequestRef.current;
    if (lr && handledLocateRequestIdRef.current !== lr.requestId) {
      handledLocateRequestIdRef.current = lr.requestId;
      const target = playerRecordsRef.current[lr.playerId];
      if (target) {
        const targetTileX = Math.floor(target.x / TILE_SIZE);
        const targetTileY = Math.floor(target.y / TILE_SIZE);
        walkTargetRef.current = computeWalkWaypoints(targetTileX, targetTileY);
        locateHighlightRef.current = { playerId: lr.playerId, start: performance.now() };
      }
    }

    // Follow-up — click-to-walk, reusing the exact same "approach an
    // arbitrary point" primitive as Follow above (tryMoveToward/updateFollow)
    // to walk toward the CURRENT waypoint (front of the A*-computed queue —
    // see findTilePath in utils/pathfinding.ts and the click handler
    // above). A real key press ALWAYS wins and cancels the whole route
    // outright (checked against the RAW keyboard result, not
    // effectiveMoveResult, so this can't be left half-cancelled by Follow
    // happening to be active too). Skipped for a frame Follow is already
    // driving, rather than fighting it for control of effectiveMoveResult.
    if (walkTargetRef.current) {
      if (moveResult.isMoving) {
        walkTargetRef.current = null;
      } else if (!activeFollow || !effectiveMoveResult.isMoving) {
        const path = walkTargetRef.current;
        const wt = path[0];
        const axisTarget = getCardinalWaypointTarget(effectiveMoveResult.x, effectiveMoveResult.y, wt);
        const walkResult = updateFollow(axisTarget.x, axisTarget.y, dt);
        if (walkResult.isMoving) {
          effectiveMoveResult = walkResult;
        } else if (path.length > 1 && Math.hypot(wt.x - walkResult.x, wt.y - walkResult.y) < 4) {
          // Reached this waypoint (not stuck — see the distance check) with
          // more still queued: advance to the next one. One frame's pause
          // at a route corner is imperceptible at 60fps; next frame picks
          // the new sub-target straight back up.
          walkTargetRef.current = path.slice(1);
        } else {
          walkTargetRef.current = null; // arrived at the final waypoint, or genuinely stuck
        }
      }
    }

    if (effectiveMoveResult.isMoving) {
      emitMoveRef.current(effectiveMoveResult.x, effectiveMoveResult.y, effectiveMoveResult.direction, effectiveMoveResult.isRunning);
      wasMovingRef.current = true;
    } else if (wasMovingRef.current) {
      emitStopRef.current(effectiveMoveResult.x, effectiveMoveResult.y, effectiveMoveResult.direction);
      useGameStore.getState().setLocalPlayer({ isMoving: false });
      wasMovingRef.current = false;
    }

    const playerX = effectiveMoveResult.x;
    const playerY = effectiveMoveResult.y;

    // Sit-in-chair: is there a sittable chair NEAR the player? (Bug 3 — was:
    // only the single tile the player faced dead-on.) Now we take the nearest
    // interactable seat within INTERACT_TILE_RADIUS, using the STORED facing
    // direction only as a tiebreaker so two seats side-by-side still resolve to
    // the one the player is turned toward. Uses the stored direction, not
    // moveResult.direction — the latter resets to a hardcoded 'down' the
    // instant no movement key is held (fine for movement, wrong for facing).
    {
      const facingDir = localPlayerRef.current.direction;
      const baseTileX = Math.floor(playerX / TILE_SIZE);
      const baseTileY = Math.floor(playerY / TILE_SIZE);
      const facingTileX = baseTileX + (facingDir === 'left' ? -1 : facingDir === 'right' ? 1 : 0);
      const facingTileY = baseTileY + (facingDir === 'up' ? -1 : facingDir === 'down' ? 1 : 0);
      if (localPlayerRef.current.isSitting) {
        nearbyChairRef.current = null;
      } else {
        // Seats span the piece's base row (y = f.y, x in [f.x, f.x+tilesW)).
        // For each interactable piece find its seat tile nearest the player;
        // keep the closest overall. Score = Chebyshev distance, minus a small
        // bias toward a seat that sits exactly on the tile the player faces —
        // so facing disambiguates ties without being required. Snapping later
        // uses this nearest seat tile, which is always on the piece, so the
        // avatar still lands ON the chair (never on an empty gap tile).
        let best: NearbySeat | null = null;
        let bestScore = Infinity;
        for (const f of furnitureRef.current) {
          if (!f.isInteractable) continue;
          let nearFx = f.x;
          let nearDist = Infinity;
          for (let fx = f.x; fx < f.x + f.tilesW; fx++) {
            const d = Math.max(Math.abs(fx - baseTileX), Math.abs(f.y - baseTileY));
            if (d < nearDist) { nearDist = d; nearFx = fx; }
          }
          if (nearDist > SIT_TILE_RADIUS) continue;
          const faced = f.y === facingTileY && nearFx === facingTileX ? 0 : 0.5;
          const score = nearDist + faced;
          if (score < bestScore) { bestScore = score; best = { kind: 'furniture', furniture: f, tileX: nearFx, tileY: f.y }; }
        }
        // Bare sittable tiles (RoomTile.isSittable, no Furniture piece at
        // all — see the ref's own doc comment) — same scoring, scanned over
        // the small SIT_TILE_RADIUS window around the player rather than
        // every piece on the map, since there's no pre-filtered list to
        // iterate like furnitureRef.
        for (let ty = baseTileY - SIT_TILE_RADIUS; ty <= baseTileY + SIT_TILE_RADIUS; ty++) {
          for (let tx = baseTileX - SIT_TILE_RADIUS; tx <= baseTileX + SIT_TILE_RADIUS; tx++) {
            const tile = tilesRef.current[ty]?.[tx];
            if (!tile?.isSittable) continue;
            const dist = Math.max(Math.abs(tx - baseTileX), Math.abs(ty - baseTileY));
            const faced = ty === facingTileY && tx === facingTileX ? 0 : 0.5;
            const score = dist + faced;
            if (score < bestScore) { bestScore = score; best = { kind: 'tile', tile, tileX: tx, tileY: ty }; }
          }
        }
        nearbyChairRef.current = best;
      }

      // Nearest interactable media within INTERACT_TILE_RADIUS (Chebyshev) of
      // where the player is standing — drives the "press X to open" prompt
      // below. (Bug 3 — widened from 1 tile to match the chair hitbox.)
      let best: { id: string; tileX: number; tileY: number } | null = null;
      let bestDist = Infinity;
      for (const m of mediaObjectsRef.current) {
        // website = clicked pin (opens a tab); bgm = ambient area — neither uses
        // the "Press X to open" modal, so don't offer it for them.
        if (m.type === 'website' || m.type === 'bgm') continue;
        const d = Math.max(Math.abs(m.x - baseTileX), Math.abs(m.y - baseTileY));
        if (d <= INTERACT_TILE_RADIUS && d < bestDist) { bestDist = d; best = { id: m.id, tileX: m.x, tileY: m.y }; }
      }
      nearbyMediaRef.current = best;

      // Fitur 15B — Interactive Objects. Each piece's OWN triggerRange gates
      // it (unlike media's fixed INTERACT_TILE_RADIUS), and press_f/automatic
      // are handled differently: press_f only arms the prompt (KeyF fires
      // it); automatic fires immediately on entry, tracked so it fires once
      // per entry rather than every frame while still in range.
      let bestInteractive: { id: string; tileX: number; tileY: number } | null = null;
      let bestInteractiveDist = Infinity;
      const stillInRange = new Set<string>();
      for (const f of furnitureRef.current) {
        if (!f.interactiveType) continue;
        const d = Math.max(Math.abs(f.x - baseTileX), Math.abs(f.y - baseTileY));
        const range = f.triggerRange ?? 1;
        if (d > range) continue;
        stillInRange.add(f.id);
        if (f.triggerMethod === 'automatic') {
          if (!autoTriggeredIdsRef.current.has(f.id)) {
            autoTriggeredIdsRef.current.add(f.id);
            onInteractiveTriggerRef.current(f.id);
          }
        } else if (d < bestInteractiveDist) {
          bestInteractiveDist = d; bestInteractive = { id: f.id, tileX: f.x, tileY: f.y };
        }
      }
      // Drop ids that fell out of range, so re-entering fires 'automatic' again.
      for (const id of autoTriggeredIdsRef.current) if (!stillInRange.has(id)) autoTriggeredIdsRef.current.delete(id);
      nearbyInteractiveRef.current = bestInteractive;

      // ZEP-style door password — same auto-trigger/re-arm shape as
      // 'automatic' Interactive Objects above, checked over the 3x3
      // neighborhood (a door is a single tile, not a scannable list like
      // furniture) instead of iterating the whole map every frame.
      const stillNearDoor = new Set<string>();
      const doorTiles = tilesRef.current;
      for (let ty = baseTileY - 1; ty <= baseTileY + 1; ty++) {
        for (let tx = baseTileX - 1; tx <= baseTileX + 1; tx++) {
          const dt = doorTiles[ty]?.[tx];
          // Item #9 — emergency override means there's nothing to prompt for.
          if (dt?.type !== 'door' || !dt.doorPasswordEnabled || doorOverrideRef.current) continue;
          const doorKey = `${tx},${ty}`;
          if (unlockedDoorsRef.current.has(doorKey)) continue;
          stillNearDoor.add(doorKey);
          if (!doorAutoTriggeredRef.current.has(doorKey)) {
            doorAutoTriggeredRef.current.add(doorKey);
            onDoorPasswordTriggerRef.current(tx, ty);
          }
        }
      }
      for (const k of doorAutoTriggeredRef.current) if (!stillNearDoor.has(k)) doorAutoTriggeredRef.current.delete(k);

      // Potong 6 — nearest YouTube tile within YT_EMBED_RADIUS auto-embeds its
      // player (muted). Toggled via React state only when it changes, so the
      // overlay swaps thumbnail↔iframe without re-rendering every frame.
      let ytId: string | null = null; let ytDist = Infinity;
      for (const m of mediaObjectsRef.current) {
        if (m.type !== 'youtube') continue;
        const d = Math.max(Math.abs(m.x - baseTileX), Math.abs(m.y - baseTileY));
        if (d <= YT_EMBED_RADIUS && d < ytDist) { ytDist = d; ytId = m.id; }
      }
      if (ytId !== ytEmbedRef.current) { ytEmbedRef.current = ytId; setYtEmbedId(ytId); }
    }
    // Rounded to whole CSS pixels — every tile/avatar screen position is
    // `n * TILE_SIZE - camera`, so a fractional camera offset put every draw
    // call at a fractional pixel, which the canvas antialiases into faint
    // seams between adjacent tiles instead of a clean shared edge. Centered
    // on worldViewW/H (not logicalW/H) so the player stays exactly centered
    // regardless of zoom — more/less world is visible, but always the same
    // amount to either side of the player.
    //
    // Overview is the one exception: centering on the MAP instead of the
    // player is the whole point of "zoom out to see the whole office" — a
    // player-centered camera still crops one side or the other whenever
    // they're standing anywhere off-center, which defeated a full-office
    // view for exactly the players it matters most for (someone tucked in a
    // corner room). worldViewW/H is now derived from the fit-computed zoom
    // above, so it matches the viewport almost exactly (not just "bigger
    // than the map on any reasonable screen" like the old fixed-threshold
    // version) — this puts the entire map in view, filling the screen,
    // regardless of where the local player is.
    const centerX = isOverview ? (mapCols * TILE_SIZE) / 2 : playerX;
    const centerY = isOverview ? (mapRows * TILE_SIZE) / 2 : playerY;
    const cameraX = Math.round(centerX - worldViewW / 2);
    const cameraY = Math.round(centerY - worldViewH / 2);

    cameraXRef.current = cameraX;
    cameraYRef.current = cameraY;

    // Portal detection — travel when the local player's tile changes to a
    // portal tile. Keyed by "x,y" so re-entering after leaving fires again,
    // but standing still on the tile doesn't re-trigger every frame.
    {
      const pTileX = Math.floor(playerX / TILE_SIZE);
      const pTileY = Math.floor(playerY / TILE_SIZE);
      const pTile = tilesRef.current[pTileY]?.[pTileX];
      // ZEP portal: no longer auto-travel on step. Just note the portal the
      // player is standing on so the "Press F" prompt shows and F can trigger it.
      if (pTile?.type === 'portal' && (pTile.portalTarget || (pTile.portalTargetX != null && pTile.portalTargetY != null))) {
        nearbyPortalRef.current = { tileX: pTileX, tileY: pTileY, target: pTile.portalTarget, targetX: pTile.portalTargetX, targetY: pTile.portalTargetY, label: pTile.portalLabel };
      } else {
        nearbyPortalRef.current = null;
      }
    }

    // Same light-purple tint Minimap.tsx's own background uses (opaque here,
    // unlike the minimap's 0.9 alpha, since this fills the WHOLE screen and
    // has nothing behind it to blend with).
    ctx.fillStyle = isOverview ? '#ede9fe' : '#1a1a2e';
    ctx.fillRect(0, 0, worldViewW, worldViewH);

    const startCol = Math.max(0, Math.floor(cameraX / TILE_SIZE));
    const endCol = Math.min(mapCols, Math.ceil((cameraX + worldViewW) / TILE_SIZE) + 1);
    const startRow = Math.max(0, Math.floor(cameraY / TILE_SIZE));
    const endRow = Math.min(mapRows, Math.ceil((cameraY + worldViewH) / TILE_SIZE) + 1);
    // Declared unconditionally — still read further down (overhead furniture
    // pass, assigned-seat labels) regardless of isOverview, which only skips
    // the DRAWING below, not this list itself.
    const furnitureList = furnitureRef.current;

    if (isOverview) {
      // Zoomed out past OVERVIEW_ZOOM_THRESHOLD — swap the whole detailed
      // pixel-art pass (tiles/wall-skins/furniture) for the SAME flat-color
      // floor-plan rendering Minimap.tsx's corner panel already uses (see
      // miniRender.ts) — the whole point of this mode is to read like a
      // bigger version of the minimap the player already knows, not a
      // second, differently-styled abstraction (this used to draw each Zone
      // as one flat colored block instead, which didn't show any of the
      // actual wall/furniture layout the minimap does).
      //
      // Bug — a single flat background tint for the WHOLE map read as
      // monotone next to a Gather.town-style floor plan where every room is
      // its own pastel color. Each zone's own background tint is drawn
      // FIRST, underneath the wall/furniture blocks below, so distinct
      // rooms are visually distinguishable at a glance without competing
      // with the structural blocks for attention.
      for (const zone of zonesRef.current) {
        const zx = zone.x * TILE_SIZE - cameraX;
        const zy = zone.y * TILE_SIZE - cameraY;
        const zw = zone.width * TILE_SIZE;
        const zh = zone.height * TILE_SIZE;
        if (zx + zw < 0 || zx > worldViewW || zy + zh < 0 || zy > worldViewH) continue;
        drawMiniZoneBackground(ctx, zone, zx, zy, zw, zh);
      }
      for (let row = startRow; row < endRow; row++) {
        for (let col = startCol; col < endCol; col++) {
          const tile = tiles[row]?.[col];
          if (!tile) continue;
          drawMiniTileType(ctx, tile.type, col * TILE_SIZE - cameraX, row * TILE_SIZE - cameraY, TILE_SIZE, TILE_SIZE);
        }
      }
      for (const item of furnitureList) {
        if (item.kind === 'banner') continue;
        const fx = item.x * TILE_SIZE - cameraX;
        const fy = (item.y - item.tilesH + 1) * TILE_SIZE - cameraY;
        const fw = item.tilesW * TILE_SIZE;
        const fh = item.tilesH * TILE_SIZE;
        if (fx + fw < 0 || fx > worldViewW || fy + fh < 0 || fy > worldViewH) continue;
        ctx.fillStyle = MINI_FURNITURE;
        ctx.fillRect(fx, fy, fw, fh);
      }
      for (const rect of wallAreaRectsRef.current) {
        const rsx = rect.x - cameraX;
        const rsy = rect.y - cameraY;
        if (rsx + rect.w < 0 || rsx > worldViewW || rsy + rect.h < 0 || rsy > worldViewH) continue;
        ctx.fillStyle = MINI_WALL_AREA;
        ctx.fillRect(rsx, rsy, rect.w, rect.h);
      }
    } else {
      for (let row = startRow; row < endRow; row++) {
        for (let col = startCol; col < endCol; col++) {
          const tile = tiles[row]?.[col];
          if (!tile) continue;
          const screenX = col * TILE_SIZE - cameraX;
          const screenY = row * TILE_SIZE - cameraY;

          // Furniture/wall tiles have transparent sprite margins, so paint the
          // floor underneath first — otherwise gaps show the dark canvas backdrop.
          drawFloorTile(ctx, tile, screenX, screenY, themeRef.current);
          // 'blocked' (ZEP impassable effect) blocks movement but renders nothing
          // — only the floor shows. 'portal'/'spawn' draw their own markers below.
          if (tile.type === 'wall') {
            // Fitur 15 — a wall tile may carry a custom-uploaded skin.
            drawWallTile(ctx, tile, screenX, screenY, themeRef.current);
          } else if (tile.type !== 'floor' && tile.type !== 'portal' && tile.type !== 'spawn' && tile.type !== 'blocked') {
            drawTile(ctx, tile.type, screenX, screenY, themeRef.current);
          }

          if (tile.type === 'portal') {
            const pulse = Math.sin(timestamp * 0.005) * 0.3 + 0.7;
            ctx.beginPath();
            ctx.arc(screenX + TILE_SIZE / 2, screenY + TILE_SIZE / 2, TILE_SIZE / 2 - 3, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(124, 58, 237, ${pulse})`;
            ctx.lineWidth = 2.5;
            ctx.stroke();
          } else if (tile.type === 'spawn') {
            ctx.beginPath();
            ctx.arc(screenX + TILE_SIZE / 2, screenY + TILE_SIZE / 2, TILE_SIZE / 2 - 5, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(16, 185, 129, 0.6)';
            ctx.setLineDash([3, 3]);
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }

      // Room Editor's "Wall Area" tool — the one impassable-rect flavor that's
      // actually meant to be seen (a plain Impassable Area stays invisible on
      // purpose, see its own doc comment in shared/mapLayers.ts). Drawn here,
      // alongside the tile/floor layer and before furniture/avatars, so it
      // reads as solid architecture — the same z-order a real 'wall' tile
      // above already renders at. Solid fill + diagonal hazard stripes so it's
      // unmistakable even sitting on a plain floor tile with nothing else
      // drawn there.
      for (const rect of wallAreaRectsRef.current) {
        const rsx = rect.x - cameraX;
        const rsy = rect.y - cameraY;
        if (rsx + rect.w < 0 || rsx > worldViewW || rsy + rect.h < 0 || rsy > worldViewH) continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(rsx, rsy, rect.w, rect.h);
        ctx.clip();
        ctx.fillStyle = 'rgba(55,65,81,0.92)';
        ctx.fillRect(rsx, rsy, rect.w, rect.h);
        ctx.strokeStyle = 'rgba(250,204,21,0.85)';
        ctx.lineWidth = 4;
        const stripeGap = 14;
        for (let sx = rsx - rect.h; sx < rsx + rect.w; sx += stripeGap) {
          ctx.beginPath();
          ctx.moveTo(sx, rsy + rect.h);
          ctx.lineTo(sx + rect.h, rsy);
          ctx.stroke();
        }
        ctx.restore();
        ctx.strokeStyle = 'rgba(17,24,39,0.9)';
        ctx.lineWidth = 2;
        ctx.strokeRect(rsx, rsy, rect.w, rect.h);
      }

      drawLiveReferenceImage(ctx, liveReferenceImageRef.current, cameraX, cameraY);

      // Furniture — object layer (base row, drawn before avatars). Banners
      // are DOM overlays (see bannerRefs below), not tileset sprites.
      for (const item of furnitureList) {
        if (item.kind === 'banner') continue;
        // Top-layer objects (ZEP editor) draw entirely AFTER avatars — skip them
        // in this before-avatars pass; the overhead pass below draws them whole.
        if (item.topLayer) continue;
        if (item.x < startCol - 2 || item.x > endCol + 2 || item.y < startRow - 3 || item.y > endRow + 1) continue;
        drawFurnitureLayer(ctx, item, cameraX, cameraY, 'object');
      }
    }

    // Editor overlay
    if (editorModeRef.current) {
      for (let row = startRow; row < endRow; row++) {
        for (let col = startCol; col < endCol; col++) {
          const sx = col * TILE_SIZE - cameraX;
          const sy = row * TILE_SIZE - cameraY;
          ctx.strokeStyle = 'rgba(255,255,255,0.1)';
          ctx.lineWidth = 0.5;
          ctx.strokeRect(sx, sy, TILE_SIZE, TILE_SIZE);
        }
      }
      const hover = hoverTileRef.current;
      if (hover && hover.x >= 0 && hover.x < MAP_WIDTH && hover.y >= 0 && hover.y < MAP_HEIGHT) {
        const hsx = hover.x * TILE_SIZE - cameraX;
        const hsy = hover.y * TILE_SIZE - cameraY;
        const activePaletteId = selectedPaletteRef.current;
        const paletteEntry = activePaletteId ? PALETTE_BY_ID[activePaletteId] : undefined;
        ctx.fillStyle = paletteEntry ? 'rgba(124,58,237,0.35)' : TILE_COLORS[selectedTileRef.current] + '80';
        const hw = paletteEntry ? paletteEntry.tilesW * TILE_SIZE : TILE_SIZE;
        const hh = paletteEntry ? TILE_SIZE : TILE_SIZE;
        ctx.fillRect(hsx, hsy, hw, hh);
        ctx.strokeStyle = 'rgba(124,58,237,0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(hsx, hsy, hw, hh);
      }
    }

    // Proximity ring
    ctx.beginPath();
    ctx.arc(playerX - cameraX, playerY - cameraY, PROXIMITY_THRESHOLD_PX, 0, Math.PI * 2);
    ctx.setLineDash([6, 8]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // Zone name fallback — the name/label text itself is a DOM overlay (see
    // zoneBannerRefs below), not drawn on canvas, so it stays crisp and easy
    // to restyle; zones without a `label` still get the plain centered
    // canvas text they always had, for backward compatibility.
    //
    // Bug — this used to ALSO draw a tinted fill + dashed outline rectangle
    // for every zone's full boundary, unconditionally, during real gameplay.
    // That box is genuinely useful in the Room Editor (RoomEditorPage.tsx
    // has its own, separate copy of this same idea, admin-only) so an admin
    // can see exactly where an area's edges are while drawing it — but
    // players were seeing it too, permanently, behind every desk cluster
    // zone with no explicit color (defaulting to a cornflower-blue tint),
    // which read as a leftover debug overlay rather than an intentional
    // effect. Removed for gameplay; the editor's own overlay is untouched.
    const zones = zonesRef.current;
    for (const zone of zones) {
      const zx = zone.x * TILE_SIZE - cameraX;
      const zy = zone.y * TILE_SIZE - cameraY;
      const zw = zone.width * TILE_SIZE;
      const zh = zone.height * TILE_SIZE;
      // ZEP-style spotlight follow-up — Private Area never shows a name
      // (see isPrivateZone's own doc comment); this is the legacy no-label
      // fallback text, so it needs the same exclusion the DOM pill below
      // already has, or an unlabeled private zone would show its raw
      // `zone.name` here instead.
      if (!zone.label && !isPrivateZone(zone)) {
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(zone.name, zx + zw / 2, zy + zh / 2);
      }
    }

    // Zone/banner labels are DOM overlays (see below), painted as siblings
    // after the canvas — so by plain DOM stacking they always render in
    // front of it, with no regard for the canvas's own Y-sorted depth.
    // Since these signs are anchored at the row they mark (a doorway, an
    // entrance corridor), any avatar standing at or just below that row has
    // its head — the top of the 32px sprite — sitting exactly in the sign's
    // on-screen space, so the sign visually slices through it. Hiding the
    // sign outright while an avatar is right there approximates proper
    // Y-sorting without a full rewrite of these labels into canvas draw
    // calls — no CSS opacity transition here on purpose: fading it out over
    // a couple hundred ms means it sits at partial opacity for a few frames
    // right as the avatar reaches it, which reads as the head rendering
    // "half, then filling in" rather than a clean disappearance.
    const isAvatarUnderLabel = (tileX: number, tileY: number, tilesW: number) => {
      const local = localPlayerRef.current;
      const avatars: { x: number; y: number }[] = [local, ...Object.values(playerRecordsRef.current)];
      return avatars.some((a) => {
        const row = Math.floor(a.y / TILE_SIZE);
        const col = Math.floor(a.x / TILE_SIZE);
        return row >= tileY && row <= tileY + 1 && col >= tileX - 1 && col <= tileX + tilesW;
      });
    };

    // Zone banners (DOM overlay) — position each labeled zone's floating
    // element every frame via transform, matching the canvas camera exactly.
    // These sit OUTSIDE the canvas's own zoom transform (they're plain DOM,
    // not canvas-drawn), so both the translate offset AND a `scale(zoom)`
    // are applied here explicitly — width stays the unscaled tile-width
    // value, with `scale()` (from the top-left corner, see the `origin-*`
    // class on these elements) doing the visual resize, same as the canvas
    // content right underneath it.
    for (const zone of zones) {
      // ZEP-style spotlight follow-up — Private Area zones (isolating,
      // non-meeting) never show a name at all now, replaced by the
      // dim/spotlight effect below instead. Map Location/meeting labels are
      // untouched — this only affects zones the ROOM ADMIN drew as Private
      // Area (see isPrivateZone's own comment below for the exact signal).
      if (!zone.label || isPrivateZone(zone)) continue;
      const el = zoneBannerRefs.current.get(zone.id);
      if (!el) continue;
      const zx = (zone.x * TILE_SIZE - cameraX) * zoom;
      const zy = (zone.y * TILE_SIZE - cameraY) * zoom;
      const zw = zone.width * TILE_SIZE;
      if (zone.type === 'meeting') {
        el.style.transform = `translate(${zx}px, ${zy}px) scale(${zoom})`;
        el.style.width = `${zw}px`;
      } else {
        el.style.transform = `translate(${zx + 6 * zoom}px, ${zy - 12 * zoom}px) scale(${zoom})`;
        el.style.width = 'auto';
      }
      el.style.opacity = isAvatarUnderLabel(zone.x, zone.y, zone.width) ? '0' : '1';
    }

    // Banner furniture (DOM overlay) — same imperative positioning as zone
    // banners above, anchored at the furniture's tile position.
    for (const item of furnitureList) {
      if (item.kind !== 'banner') continue;
      const el = bannerRefs.current.get(item.id);
      if (!el) continue;
      const bx = (item.x * TILE_SIZE - cameraX) * zoom;
      const by = (item.y * TILE_SIZE - cameraY) * zoom;
      el.style.transform = `translate(${bx}px, ${by}px) scale(${zoom})`;
      el.style.width = `${item.tilesW * TILE_SIZE}px`;
      el.style.opacity = isAvatarUnderLabel(item.x, item.y, item.tilesW) ? '0' : '1';
    }

    // QA #7/#8/#9 — Note markers (DOM overlay), same imperative positioning
    // as media markers below (notes are placed via Add Media, at whatever
    // tile the player was standing on — no furniture involved).
    for (const note of notesRef.current) {
      const el = noteMarkerRefs.current.get(note.id);
      if (!el) continue;
      const nx = (note.x * TILE_SIZE - cameraX) * zoom;
      const ny = (note.y * TILE_SIZE - cameraY) * zoom;
      el.style.transform = `translate(${nx}px, ${ny}px) scale(${zoom})`;
    }

    // §6 — Media markers (DOM overlay), same imperative positioning.
    // Staggered horizontally when multiple objects share a tile (e.g.
    // several added without moving in between) — otherwise they'd stack
    // exactly on top of each other and only the last-added one would ever
    // be clickable, with everything under it permanently unreachable.
    const mediaTileCounts = new Map<string, number>();
    for (const media of mediaObjectsRef.current) {
      const tileKey = `${media.x},${media.y}`;
      const stackIndex = mediaTileCounts.get(tileKey) ?? 0;
      mediaTileCounts.set(tileKey, stackIndex + 1);
      const el = mediaMarkerRefs.current.get(media.id);
      if (!el) continue;
      // Bug media #1 — the maximized marker fills the screen via its own
      // `fixed inset-0` className (see the marker JSX) instead of tracking
      // world position; clearing the transform here (rather than feeding it
      // a camera-relative translate) is what lets that `position: fixed`
      // actually size against the VIEWPORT — any transform on an ancestor
      // (even a no-op one) would otherwise trap it to this element's own box.
      if (media.id === maximizedYtId) { if (el.style.transform) el.style.transform = ''; continue; }
      // Image/YouTube render as a much bigger inline thumbnail below (see
      // the marker JSX) than the small pin whiteboard/file still use, so
      // they need a wider stacking gap to avoid overlapping.
      const stackOffsetPx = media.type === 'image' || media.type === 'youtube' ? 40 : 18;
      const mx = (media.x * TILE_SIZE - cameraX + stackIndex * stackOffsetPx) * zoom;
      const my = (media.y * TILE_SIZE - cameraY) * zoom;
      el.style.transform = `translate(${mx}px, ${my}px) scale(${zoom})`;
    }

    // Claimable-seat markers (DOM overlay), same imperative positioning,
    // centered on the marker's tile.
    for (const seat of claimableSeatsRef.current) {
      const el = claimSeatMarkerRefs.current.get(seat.id);
      if (!el) continue;
      const sx = (seat.x * TILE_SIZE + TILE_SIZE / 2 - cameraX) * zoom;
      const sy = (seat.y * TILE_SIZE + TILE_SIZE / 2 - cameraY) * zoom;
      el.style.transform = `translate(${sx}px, ${sy}px) scale(${zoom})`;
    }

    // Zone draw preview (while dragging out a new zone rectangle)
    if (zoneDragStartRef.current && zoneDragCurrentRef.current) {
      const a = zoneDragStartRef.current;
      const b = zoneDragCurrentRef.current;
      const rx = Math.min(a.x, b.x);
      const ry = Math.min(a.y, b.y);
      const rw = Math.abs(b.x - a.x) + 1;
      const rh = Math.abs(b.y - a.y) + 1;
      const zx = rx * TILE_SIZE - cameraX;
      const zy = ry * TILE_SIZE - cameraY;
      ctx.fillStyle = 'rgba(124, 58, 237, 0.15)';
      ctx.fillRect(zx, zy, rw * TILE_SIZE, rh * TILE_SIZE);
      ctx.strokeStyle = 'rgba(124, 58, 237, 0.8)';
      ctx.lineWidth = 2;
      ctx.strokeRect(zx, zy, rw * TILE_SIZE, rh * TILE_SIZE);
    }

    // Avatars
    const playerRecords = playerRecordsRef.current;
    const localPlayerId = localPlayerIdRef.current;
    const localPlayer = localPlayerRef.current;
    const now = Date.now();
    const walkOffset = effectiveMoveResult.isMoving ? Math.sin(timestamp * 0.008) * 2 : 0;
    const localAvatar: Avatar = {
      ...localPlayer, x: playerX, y: playerY, isMoving: effectiveMoveResult.isMoving,
      // effectiveMoveResult.direction resets to a hardcoded 'down' the
      // instant no movement key is held (or, while following, the instant
      // the follower reaches the target and stops) — fine for movement
      // itself, but wrong to draw from while idle/sitting, where the
      // stored direction (last real heading, or the sit-facing direction
      // set in performSit) is correct.
      direction: effectiveMoveResult.isMoving ? effectiveMoveResult.direction : localPlayer.direction,
      id: localPlayerId,
      isRunning: effectiveMoveResult.isMoving && effectiveMoveResult.isRunning,
    };
    const remoteAvatars = Object.values(playerRecords).filter((p) => p.id !== localPlayerId);
    const allAvatars: Avatar[] = [localAvatar, ...remoteAvatars];
    // "Hide myself" (Avatar.hidden) — admin+ sees a hidden avatar regardless;
    // everyone else, including anyone who just hasn't toggled it themselves,
    // does not. Read once per frame, not per avatar — role can't change
    // mid-frame.
    const canSeeHidden = roleAtLeast(useGameStore.getState().localRole, 'admin');

    for (const avatar of allAvatars) {
      if (avatar.hidden && avatar.id !== localPlayerId && !canSeeHidden) continue;
      const sx = avatar.x - cameraX;
      const sy = avatar.y - cameraY;
      // Never culled in Overview — "see the whole office + everyone in it"
      // means literally everyone, not just whoever the ordinary in-game
      // viewport cull would have kept on an edge case (a screen smaller
      // than the map even at max zoom-out). The map-centered camera above
      // already keeps the map itself fully in frame; this keeps every
      // player in frame right along with it.
      if (!isOverview && (sx < -AVATAR_RADIUS - 30 || sx > worldViewW + AVATAR_RADIUS + 30 ||
          sy < -AVATAR_RADIUS - 40 || sy > worldViewH + AVATAR_RADIUS + 30)) continue;

      if (isOverview) {
        // Overview mode — a colored initial bubble instead of the full
        // sprite (nudge/jump/speech-bubble effects skipped too, same
        // "legible at a glance" reasoning as the simplified room blocks
        // above). Radius divided by zoom so the bubble reads as the SAME
        // on-screen size at either overview zoom step (25% or 30%), rather
        // than shrinking right along with everything else.
        const bubbleRadius = 14 / zoom;
        ctx.beginPath();
        ctx.arc(sx, sy, bubbleRadius, 0, Math.PI * 2);
        ctx.fillStyle = avatarColor(avatar.userId ?? avatar.id);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2 / zoom;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = `600 ${Math.round(14 / zoom)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((avatar.name?.trim()?.[0] ?? '?').toUpperCase(), sx, sy);
        // Online-status dot — every rendered avatar is a live connected
        // player by definition (there's no "offline" entry in playerRecords).
        ctx.beginPath();
        ctx.arc(sx + bubbleRadius * 0.72, sy + bubbleRadius * 0.72, bubbleRadius * 0.32, 0, Math.PI * 2);
        ctx.fillStyle = '#22c55e';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5 / zoom;
        ctx.stroke();
        continue;
      }

      const isLocal = avatar.id === localPlayerId;
      const bobOffset = isLocal ? walkOffset : avatar.isMoving ? Math.sin(timestamp * 0.008 + (avatar.id.charCodeAt(0) || 0) * 0.1) * 2 : 0;
      const jumpOffset = getJumpOffset(jumpingPlayersRef.current.get(avatar.id), now);
      const nudgeStart = nudgedPlayersRef.current.get(avatar.id);
      const nudgeOffset = getNudgeShakeOffset(nudgeStart, now);
      drawAvatar(ctx, { avatar, x: sx + nudgeOffset, y: sy, isLocal, timestamp,
        walkAnimOffset: bobOffset + jumpOffset,
        scale: avatarScaleRef.current,
      });

      // Locate ("Temukan") highlight — a pulsing ring so the searcher can
      // visually confirm who they're walking toward, same finite-lifetime
      // pattern as the nudge burst below.
      const locateHl = locateHighlightRef.current;
      if (locateHl && locateHl.playerId === avatar.id) {
        const locateElapsed = performance.now() - locateHl.start;
        if (locateElapsed >= 0 && locateElapsed <= LOCATE_HIGHLIGHT_DURATION_MS) {
          const t = locateElapsed / LOCATE_HIGHLIGHT_DURATION_MS;
          const pulse = (Math.sin(locateElapsed * 0.006) + 1) / 2;
          ctx.save();
          ctx.globalAlpha = 1 - t;
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(sx, sy, AVATAR_RADIUS + 6 + pulse * 6, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }

      // Nudge ("senggol") impact effect — a burst of small orange sparks
      // radiating outward AROUND the target (not a single icon floating
      // above the head), separate from (but driven by the same timestamp
      // as) the shake offset above since the burst reads better lasting a
      // bit longer than the shake itself.
      if (nudgeStart !== undefined) {
        const nudgeElapsed = now - nudgeStart;
        if (nudgeElapsed >= 0 && nudgeElapsed <= NUDGE_FX_DURATION_MS) {
          const t = nudgeElapsed / NUDGE_FX_DURATION_MS;
          const burstRadius = AVATAR_RADIUS + 4 + t * 20;
          ctx.save();
          ctx.globalAlpha = 1 - t;
          ctx.fillStyle = '#FFA726';
          for (let i = 0; i < NUDGE_SPARK_COUNT; i++) {
            const angle = (i / NUDGE_SPARK_COUNT) * Math.PI * 2 + t * 1.2;
            const px = sx + Math.cos(angle) * burstRadius;
            const py = sy + Math.sin(angle) * burstRadius * 0.8;
            drawSpark(ctx, px, py, 5 * (1 - t * 0.5));
          }
          ctx.restore();
        }
      }

      // The gesture itself shows on the NUDGER's own body (whoever pressed
      // Z), not floating above the target's head — a fist-bump right over
      // their torso, popping/fading on the same timeline as the burst.
      const nudgerStart = nudgerPlayersRef.current.get(avatar.id);
      if (nudgerStart !== undefined) {
        const nudgerElapsed = now - nudgerStart;
        if (nudgerElapsed >= 0 && nudgerElapsed <= NUDGE_FX_DURATION_MS) {
          const t = nudgerElapsed / NUDGE_FX_DURATION_MS;
          const gestureScale = 1 + 0.4 * Math.sin(t * Math.PI);
          ctx.save();
          ctx.globalAlpha = 1 - t;
          ctx.font = `${Math.round(20 * gestureScale)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(NUDGE_GESTURE, sx, sy - 4);
          ctx.restore();
        }
      }

      // Crown for admin players
      if (avatar.isAdmin) {
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('👑', sx, sy - AVATAR_RADIUS - 24);
      }

      // Soundboard — blinking speaker above whoever's sound is currently
      // playing, so nearby players can tell who the source is. Offset to the
      // side of the crown spot rather than sharing it, so an admin playing a
      // sound doesn't lose one icon to the other. Expired entries are simply
      // ignored here, never pruned (same convention as momentaryReveals).
      const soundboardExpireAt = playingSoundboardRef.current.get(avatar.id);
      if (soundboardExpireAt !== undefined && now < soundboardExpireAt) {
        if (Math.floor(now / 300) % 2 === 0) {
          ctx.font = '14px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('🔊', sx + 16, sy - AVATAR_RADIUS - 24);
        }
      }

      // (Presence status now shows as ONE unified pill above the avatar — the
      // custom-status pill in AvatarSprite.ts, which falls back to the work-mode
      // label when no custom text is set. The separate bare emoji badge that
      // used to sit here was removed to avoid two overlapping status cues.)

      const sp = speakingPlayersRef.current;
      const isSpeaking = isLocal ? localSpeakingRef.current : sp.has(avatar.id);
      const isMuted = isLocal && micMutedRef.current;
      const inProx = (proximityRef.current.find((p) => p.id === avatar.id)?.visibility ?? 'not_visible') !== 'not_visible';

      if (isMuted || isLocal) {
        const iconY = sy + AVATAR_RADIUS + 18;
        ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
        if (isMuted) ctx.fillText('🔇', sx, iconY);
        else if (isSpeaking) ctx.fillText('🔊', sx, iconY);
        if (inProx && cameraOnRef.current) ctx.fillText('📹', sx, iconY + 14);
      }

      if (isSpeaking) {
        const pulse = Math.sin(timestamp * 0.01) * 0.3 + 0.7;
        ctx.beginPath();
        ctx.arc(sx, sy, AVATAR_RADIUS + 3, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(74, 222, 128, ${pulse * 0.6})`;
        ctx.lineWidth = 2; ctx.stroke();
      }
    }

    // A4 — teleport fade rings at the source + destination tiles, so a teleport
    // reads as a deliberate blink rather than a glitch. Expired entries pruned.
    {
      const flashes = teleportFlashRef.current;
      const FLASH_MS = 450;
      for (let i = flashes.length - 1; i >= 0; i--) {
        const age = timestamp - flashes[i].start;
        if (age >= FLASH_MS || age < 0) { flashes.splice(i, 1); continue; }
        const t = age / FLASH_MS;
        ctx.save();
        ctx.globalAlpha = (1 - t) * 0.7;
        ctx.strokeStyle = '#a855f7';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(flashes[i].x - cameraX, flashes[i].y - cameraY, AVATAR_RADIUS + 4 + t * 18, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    if (!isOverview) {
      // Furniture — overhead layer (drawn after avatars, so tall pieces let
      // players walk visually behind their upper portion)
      for (const item of furnitureList) {
        if (item.kind === 'banner') continue;
        if (item.x < startCol - 2 || item.x > endCol + 2 || item.y < startRow - 3 || item.y > endRow + 1) continue;
        // Top-layer objects draw whole here (base + overhead) so the avatar
        // passes BEHIND them; ordinary objects only draw their overhead rows.
        if (item.topLayer) drawFurnitureLayer(ctx, item, cameraX, cameraY, 'object');
        drawFurnitureLayer(ctx, item, cameraX, cameraY, 'overhead');
      }

      // Permanently-assigned seat labels — unlike the "SPACE to sit" prompt
      // below, these are always visible (not just while facing the piece), so
      // everyone can see whose desk is whose at a glance, ZEP-style.
      for (const item of furnitureList) {
        if (!item.assignedToUserId) continue;
        if (item.x < startCol - 2 || item.x > endCol + 2 || item.y < startRow - 3 || item.y > endRow + 1) continue;
        const asx = item.x * TILE_SIZE - cameraX + TILE_SIZE / 2;
        const asy = item.y * TILE_SIZE - cameraY - (item.tilesH - 1) * TILE_SIZE;
        const label = `🪑 ${item.assignedToName || 'Reserved'}`;
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(76, 29, 149, 0.85)';
        ctx.beginPath();
        ctx.roundRect(asx - tw / 2 - 5, asy - 20, tw + 10, 14, 6);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillText(label, asx, asy - 9);
      }

      // QA #6 — "jelas mana bisa 'X'" (or F, for this Fitur 15B family):
      // before this, an interactive object gave NO hint it was interactive
      // until you'd already walked up and the F-prompt appeared — a player
      // could only find one by bumping into it. This badge is the opposite:
      // always visible (like the assigned-seat label above and the portal's
      // own pulsing ring), pinned to the piece's top-right corner so it
      // doesn't collide with a seat label sharing the same top-center spot.
      // One shared icon for every interactiveType, not a type-specific one —
      // "this does something" is the gap, not "here's exactly what".
      for (const item of furnitureList) {
        if (!item.interactiveType) continue;
        if (item.x < startCol - 2 || item.x > endCol + 2 || item.y < startRow - 3 || item.y > endRow + 1) continue;
        const ibx = item.x * TILE_SIZE - cameraX + item.tilesW * TILE_SIZE - 6;
        const iby = item.y * TILE_SIZE - cameraY - (item.tilesH - 1) * TILE_SIZE - 2;
        const pulse = Math.sin(timestamp * 0.005) * 0.15 + 0.85;
        ctx.beginPath();
        ctx.arc(ibx, iby, 8, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(245, 158, 11, ${pulse})`;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.fillText('!', ibx, iby + 1);
        ctx.textBaseline = 'alphabetic';
      }

    }

    // Sit-in-chair prompt — a small floating chair icon + hint over the
    // chair the player is currently facing, only while not already sitting.
    if (nearbyChairRef.current) {
      const { tileX, tileY } = nearbyChairRef.current;
      const csx = tileX * TILE_SIZE - cameraX + TILE_SIZE / 2;
      const csy = tileY * TILE_SIZE - cameraY;
      const bob = Math.sin(timestamp * 0.005) * 2;
      ctx.font = '16px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('🪑', csx, csy - 8 + bob);
      ctx.font = 'bold 9px sans-serif';
      ctx.fillStyle = 'rgba(124, 58, 237, 0.9)';
      ctx.fillText('SPACE to sit', csx, csy - 22 + bob);
    }

    // "Press X to open" prompt over the nearest interactable media object
    // (Gather-style) — walk up to a poster/video/whiteboard and a hint
    // appears, no hunting for a tiny clickable pin.
    if (nearbyMediaRef.current) {
      const { tileX, tileY } = nearbyMediaRef.current;
      const msx = tileX * TILE_SIZE - cameraX + TILE_SIZE / 2;
      const msy = tileY * TILE_SIZE - cameraY;
      const bob = Math.sin(timestamp * 0.005) * 2;
      const label = 'X';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      const tw = ctx.measureText('X  Buka').width;
      const bx = msx - tw / 2 - 8;
      const by = msy - 40 + bob;
      // pill background
      ctx.fillStyle = 'rgba(124, 58, 237, 0.95)';
      ctx.beginPath();
      const bw = tw + 16, bh = 18, rr = 9;
      ctx.moveTo(bx + rr, by); ctx.lineTo(bx + bw - rr, by);
      ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + rr); ctx.lineTo(bx + bw, by + bh - rr);
      ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - rr, by + bh); ctx.lineTo(bx + rr, by + bh);
      ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - rr); ctx.lineTo(bx, by + rr);
      ctx.quadraticCurveTo(bx, by, bx + rr, by); ctx.closePath(); ctx.fill();
      // "X" key cap + label
      ctx.fillStyle = '#ffffff';
      ctx.fillText(`${label}  Buka`, msx, by + 13);
    }

    // ZEP portal (Potong 5) — "Press F — <name>" prompt over the portal tile.
    if (nearbyPortalRef.current) {
      const { tileX, tileY, label, target } = nearbyPortalRef.current;
      const psx = tileX * TILE_SIZE - cameraX + TILE_SIZE / 2;
      const psy = tileY * TILE_SIZE - cameraY;
      const bob = Math.sin(timestamp * 0.005) * 2;
      const name = label || (target ? 'room lain' : 'titik lain');
      const text = `F — ${name}`;
      ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
      const tw = ctx.measureText(text).width;
      const bx = psx - tw / 2 - 8, by = psy - 40 + bob, bw = tw + 16, bh = 18, rr = 9;
      ctx.fillStyle = 'rgba(124, 58, 237, 0.95)';
      ctx.beginPath();
      ctx.moveTo(bx + rr, by); ctx.lineTo(bx + bw - rr, by);
      ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + rr); ctx.lineTo(bx + bw, by + bh - rr);
      ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - rr, by + bh); ctx.lineTo(bx + rr, by + bh);
      ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - rr); ctx.lineTo(bx, by + rr);
      ctx.quadraticCurveTo(bx, by, bx + rr, by); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, psx, by + 13);
    }

    // Fitur 15B — "Press F" prompt over a press_f-type Interactive Object in
    // range (only shown when no portal already claimed F this frame — see
    // nearbyInteractiveRef's own comment on why the two never actually
    // overlap in practice).
    if (!nearbyPortalRef.current && nearbyInteractiveRef.current) {
      const { tileX, tileY } = nearbyInteractiveRef.current;
      const isx = tileX * TILE_SIZE - cameraX + TILE_SIZE / 2;
      const isy = tileY * TILE_SIZE - cameraY;
      const bob = Math.sin(timestamp * 0.005) * 2;
      const text = 'F — Buka';
      ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
      const tw = ctx.measureText(text).width;
      const bx = isx - tw / 2 - 8, by = isy - 40 + bob, bw = tw + 16, bh = 18, rr = 9;
      ctx.fillStyle = 'rgba(124, 58, 237, 0.95)';
      ctx.beginPath();
      ctx.moveTo(bx + rr, by); ctx.lineTo(bx + bw - rr, by);
      ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + rr); ctx.lineTo(bx + bw, by + bh - rr);
      ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - rr, by + bh); ctx.lineTo(bx + rr, by + bh);
      ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - rr); ctx.lineTo(bx, by + rr);
      ctx.quadraticCurveTo(bx, by, bx + rr, by); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, isx, by + 13);
    }

    // Fitur 15B — 'show_name' Interactive Object: floating name label for
    // any piece with an active reveal (momentaryRevealsRef — set by App.tsx's
    // handleInteractiveTrigger, itself fired by the same press_f/automatic
    // proximity dispatch every other Interactive Object already uses).
    for (const f of furnitureRef.current) {
      if (f.interactiveType !== 'show_name' || !f.name) continue;
      const reveal = momentaryRevealsRef.current.get(f.id);
      if (!reveal || now > reveal.expireAt) continue;
      const nsx = f.x * TILE_SIZE - cameraX + TILE_SIZE / 2;
      const nsy = f.y * TILE_SIZE - cameraY;
      const bob = Math.sin(timestamp * 0.005) * 2;
      ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
      const tw = ctx.measureText(f.name).width;
      const bx = nsx - tw / 2 - 8, by = nsy - 40 + bob, bw = tw + 16, bh = 18, rr = 9;
      ctx.fillStyle = 'rgba(30,41,59,0.9)';
      ctx.beginPath();
      ctx.moveTo(bx + rr, by); ctx.lineTo(bx + bw - rr, by);
      ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + rr); ctx.lineTo(bx + bw, by + bh - rr);
      ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - rr, by + bh); ctx.lineTo(bx + rr, by + bh);
      ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - rr); ctx.lineTo(bx, by + rr);
      ctx.quadraticCurveTo(bx, by, bx + rr, by); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(f.name, nsx, by + 13);
    }

    // Fitur 15B — 'show_word_balloon' Interactive Object: same
    // proper speech-bubble-with-tail shape (+ wrapText) as player chat
    // bubbles below, anchored over the OBJECT's tile instead of a player.
    // 'variant' (a hex color, only set for the "Random" style) was chosen
    // ONCE at trigger time in App.tsx — never re-rolled here, or it would
    // flicker a new color every frame while the balloon is shown.
    for (const f of furnitureRef.current) {
      if (f.interactiveType !== 'show_word_balloon') continue;
      const text = f.interactiveConfig?.wordBalloonText;
      if (!text) continue;
      const reveal = momentaryRevealsRef.current.get(f.id);
      if (!reveal || now > reveal.expireAt) continue;
      const wsx = f.x * TILE_SIZE - cameraX + TILE_SIZE / 2;
      const wsy = f.y * TILE_SIZE - cameraY;
      const alpha = Math.max(0, 1 - (now - reveal.expireAt + 1000) / 1000);
      ctx.save(); ctx.globalAlpha = alpha;
      ctx.font = '10px sans-serif';
      const lines = wrapText(ctx, text, 100);
      const lineH = 13; const pad = 5;
      const wbw = Math.min(110, ctx.measureText(text).width + pad * 2);
      const wbh = lines.length * lineH + pad * 2;
      const wbx = wsx - wbw / 2;
      const wby = wsy - 40 - wbh;
      ctx.fillStyle = reveal.variant || 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.moveTo(wbx + 4, wby); ctx.lineTo(wbx + wbw - 4, wby);
      ctx.quadraticCurveTo(wbx + wbw, wby, wbx + wbw, wby + 4);
      ctx.lineTo(wbx + wbw, wby + wbh - 4);
      ctx.quadraticCurveTo(wbx + wbw, wby + wbh, wbx + wbw - 4, wby + wbh);
      ctx.lineTo(wbx + 4 + 6, wby + wbh); ctx.lineTo(wbx + 6, wby + wbh + 6);
      ctx.lineTo(wbx + 2, wby + wbh); ctx.lineTo(wbx + 4, wby + wbh);
      ctx.quadraticCurveTo(wbx, wby + wbh, wbx, wby + wbh - 4);
      ctx.lineTo(wbx, wby + 4); ctx.quadraticCurveTo(wbx, wby, wbx + 4, wby);
      ctx.fill();
      ctx.fillStyle = '#333'; ctx.textAlign = 'center';
      for (let li = 0; li < lines.length; li++) {
        ctx.fillText(lines[li], wbx + wbw / 2, wby + pad + lineH * (li + 1) - 2);
      }
      ctx.restore();
    }

    // Fitur 15B — 'animation' Interactive Object: floating animated
    // sprite-sheet overlay for any piece with an active reveal (frames laid
    // out left-to-right in one image; see the config's own doc comment for
    // why this is an overlay above the piece rather than a base-sprite
    // replacement — that would need touching the two-pass object/overhead
    // furniture draw order elsewhere in this file).
    for (const f of furnitureRef.current) {
      if (f.interactiveType !== 'animation') continue;
      const cfg = f.interactiveConfig;
      if (!cfg?.spriteFile || !cfg.spriteFrameWidth || !cfg.spriteFrameHeight || !cfg.spriteFrameCount) continue;
      const reveal = momentaryRevealsRef.current.get(f.id);
      if (!reveal || now > reveal.expireAt) continue;
      const elapsed = ANIMATION_OVERLAY_DURATION_MS - (reveal.expireAt - now);
      const frameIndex = Math.floor(elapsed / ANIMATION_FRAME_MS) % cfg.spriteFrameCount;
      const asx = f.x * TILE_SIZE - cameraX + TILE_SIZE / 2;
      const asy = f.y * TILE_SIZE - cameraY;
      const scale = Math.min(TILE_SIZE / cfg.spriteFrameWidth, TILE_SIZE / cfg.spriteFrameHeight, 1.5);
      const dw = cfg.spriteFrameWidth * scale, dh = cfg.spriteFrameHeight * scale;
      drawSpriteFrame(ctx, cfg.spriteFile, {
        srcX: frameIndex * cfg.spriteFrameWidth, srcY: 0, cellWidth: cfg.spriteFrameWidth, cellHeight: cfg.spriteFrameHeight,
        dx: asx - dw / 2, dy: asy - dh - 8, dWidth: dw, dHeight: dh,
      });
    }

    // ZEP-style Private Area spotlight — everything OUTSIDE the private
    // zone the LOCAL player is currently standing in gets dimmed (tiles,
    // furniture, other avatars — everything drawn so far this frame);
    // inside the zone stays fully lit. Drawn as 4 plain dark rectangles
    // framing the zone's box rather than a canvas-composite cutout — much
    // simpler, and there's nothing else on this layer that needs a true
    // hole punched through it. Purely local: computed from THIS client's
    // own position against the same `zones` array everyone already has, the
    // exact same "no server round trip" pattern the existing audio
    // isolation check already uses (see useProximity.ts's audioZoneAt) — no
    // one else's screen is affected by this, and nothing here is broadcast.
    // Placed after avatars/overhead furniture (so people standing outside
    // the room read as dimmed too) but before speech bubbles/prompts below
    // (so in-world UI text stays legible either way).
    const spotlightZone = isOverview ? undefined : zones.find((z) =>
      isPrivateZone(z) &&
      playerX / TILE_SIZE >= z.x && playerX / TILE_SIZE < z.x + z.width &&
      playerY / TILE_SIZE >= z.y && playerY / TILE_SIZE < z.y + z.height,
    );
    if (spotlightZone) {
      const pzx = spotlightZone.x * TILE_SIZE - cameraX;
      const pzy = spotlightZone.y * TILE_SIZE - cameraY;
      const pzw = spotlightZone.width * TILE_SIZE;
      const pzh = spotlightZone.height * TILE_SIZE;
      // Focus area asked for a noticeably lighter dim than Private Area's —
      // "abu-abu, sekitar 50%" (grayish, ~50%) rather than the near-black
      // 0.55 private areas already use.
      ctx.fillStyle = spotlightZone.type === 'focus' ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, worldViewW, pzy); // above the zone
      ctx.fillRect(0, pzy + pzh, worldViewW, worldViewH - (pzy + pzh)); // below
      ctx.fillRect(0, pzy, pzx, pzh); // left of the zone
      ctx.fillRect(pzx + pzw, pzy, worldViewW - (pzx + pzw), pzh); // right
    }

    // Speech bubbles
    const bubbles = bubblesRef.current;
    for (const [pid, bubble] of Object.entries(bubbles)) {
      if (now > bubble.expireAt) continue;
      const records = playerRecordsRef.current;
      const p = pid === localPlayerId ? localPlayerRef.current : records[pid];
      if (!p) continue;
      const bsx = p.x - cameraX;
      const bsy = p.y - cameraY;
      const alpha = Math.max(0, 1 - (now - bubble.expireAt + 1000) / 1000);
      ctx.save(); ctx.globalAlpha = alpha;
      const lines = wrapText(ctx, bubble.text, 100);
      const lineH = 13; const pad = 5;
      const bw = Math.min(110, ctx.measureText(bubble.text).width + pad * 2);
      const bh = lines.length * lineH + pad * 2;
      const bx = bsx - bw / 2;
      const by = bsy - AVATAR_RADIUS - 40 - bh;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.moveTo(bx + 4, by); ctx.lineTo(bx + bw - 4, by);
      ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + 4);
      ctx.lineTo(bx + bw, by + bh - 4);
      ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - 4, by + bh);
      ctx.lineTo(bx + 4 + 6, by + bh); ctx.lineTo(bx + 6, by + bh + 6);
      ctx.lineTo(bx + 2, by + bh); ctx.lineTo(bx + 4, by + bh);
      ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - 4);
      ctx.lineTo(bx, by + 4); ctx.quadraticCurveTo(bx, by, bx + 4, by);
      ctx.fill();
      ctx.fillStyle = '#333'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
      for (let li = 0; li < lines.length; li++) {
        ctx.fillText(lines[li], bx + bw / 2, by + pad + lineH * (li + 1) - 2);
      }
      ctx.restore();
    }

    // Floating emotes
    const emotes = emotesRef.current;
    for (const ev of emotes) {
      const elapsed = now - ev.timestamp;
      if (elapsed > 3000) continue;
      const alpha = 1 - elapsed / 3000;
      const px = ev.x - cameraX;
      const py = (ev.y - cameraY) - elapsed * 0.02;
      ctx.save(); ctx.globalAlpha = alpha;
      ctx.font = `${18 + elapsed * 0.01}px sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(EMOTE_EMOJI[ev.emote] || '👋', px, py);
      ctx.restore();
    }

    rafRef.current = requestAnimationFrame(draw);
  }, []);

  // Editor mouse handlers
  const getTileFromMouse = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const zoom = useGameStore.getState().mapZoom;
    const mx = (clientX - rect.left) / zoom;
    const my = (clientY - rect.top) / zoom;
    const tileX = Math.floor((mx + cameraXRef.current) / TILE_SIZE);
    const tileY = Math.floor((my + cameraYRef.current) / TILE_SIZE);
    return { x: tileX, y: tileY };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!editorModeRef.current) return;
    e.stopPropagation();
    const tile = getTileFromMouse(e.clientX, e.clientY);
    if (!tile) return;
    if (tile.x <= 0 || tile.x >= MAP_WIDTH - 1 || tile.y <= 0 || tile.y >= MAP_HEIGHT - 1) return;

    if (zoneDrawModeRef.current) {
      zoneDragStartRef.current = tile;
      zoneDragCurrentRef.current = tile;
      return;
    }

    if (bannerPlaceModeRef.current) {
      onBannerPlaceCompleteRef.current(tile.x, tile.y);
      return;
    }

    const paletteId = selectedPaletteRef.current;
    if (paletteId) {
      const entry = PALETTE_BY_ID[paletteId];
      if (entry?.category === 'floor') {
        isPaintingRef.current = true;
        onFloorPaint(tile.x, tile.y, paletteId);
      } else if (entry?.category === 'furniture' || entry?.category === 'decor' || entry?.category === 'electronics') {
        onFurniturePlace(tile.x, tile.y, paletteId);
      }
      return;
    }

    // Portal placement prompts for a target room — don't let a drag repeat it.
    isPaintingRef.current = selectedTileRef.current !== 'portal';
    onTileHistoryPush();
    onTilePaint(tile.x, tile.y, selectedTileRef.current);
  }, [getTileFromMouse, onTilePaint, onTileHistoryPush, onFloorPaint, onFurniturePlace]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!editorModeRef.current) return;
    e.stopPropagation();
    const tile = getTileFromMouse(e.clientX, e.clientY);
    hoverTileRef.current = tile;

    if (zoneDragStartRef.current && tile) {
      zoneDragCurrentRef.current = tile;
      return;
    }

    if (isPaintingRef.current && tile) {
      if (tile.x <= 0 || tile.x >= MAP_WIDTH - 1 || tile.y <= 0 || tile.y >= MAP_HEIGHT - 1) return;
      const paletteId = selectedPaletteRef.current;
      if (paletteId) {
        const entry = PALETTE_BY_ID[paletteId];
        if (entry?.category === 'floor') onFloorPaint(tile.x, tile.y, paletteId);
        return;
      }
      onTilePaint(tile.x, tile.y, selectedTileRef.current);
    }
  }, [getTileFromMouse, onTilePaint, onFloorPaint]);

  const handleMouseUp = useCallback(() => {
    isPaintingRef.current = false;
    if (zoneDragStartRef.current && zoneDragCurrentRef.current) {
      const a = zoneDragStartRef.current;
      const b = zoneDragCurrentRef.current;
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const width = Math.abs(b.x - a.x) + 1;
      const height = Math.abs(b.y - a.y) + 1;
      onZoneDrawCompleteRef.current(x, y, width, height);
    }
    zoneDragStartRef.current = null;
    zoneDragCurrentRef.current = null;
  }, []);
  const handleMouseLeave = useCallback(() => { hoverTileRef.current = null; }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!editorModeRef.current) return;
    e.preventDefault(); e.stopPropagation();
    const tile = getTileFromMouse(e.clientX, e.clientY);
    if (!tile) return;
    if (tile.x <= 0 || tile.x >= MAP_WIDTH - 1 || tile.y <= 0 || tile.y >= MAP_HEIGHT - 1) return;
    // Banners never touched the tile underneath (they can decorate a wall,
    // not just floor — see gameStore addFurniture/removeFurnitureAt), so
    // erasing one must NOT force it back to 'floor' like normal furniture.
    const erasedBanner = furnitureRef.current.some(
      (f) => f.kind === 'banner' && f.y === tile.y && tile.x >= f.x && tile.x < f.x + f.tilesW
    );
    onFurnitureErase(tile.x, tile.y);
    onTileHistoryPush();
    if (!erasedBanner) onTilePaint(tile.x, tile.y, 'floor');
  }, [getTileFromMouse, onTilePaint, onTileHistoryPush, onFurnitureErase]);

  useEffect(() => {
    resizeCanvas();
    const observer = new ResizeObserver(() => resizeCanvas());
    const container = containerRef.current;
    if (container) observer.observe(container);
    prevTimeRef.current = 0;
    rafRef.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(rafRef.current); observer.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={containerRef} className={`w-full h-full absolute inset-0 ${editorMode ? 'ring-2 ring-orange-500 ring-inset z-10' : ''}`}>
      <canvas
        ref={canvasRef}
        id="game-canvas"
        className={`block ${editorMode ? 'cursor-crosshair' : ''}`}
        style={{ imageRendering: 'pixelated' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onContextMenu={handleContextMenu}
      />
      {/* Zone banners — positioned imperatively in the draw() loop above via
          style.transform, not React state, so they track the camera at 60fps
          without re-rendering. */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {zones.filter((z) => z.label && !isPrivateZone(z) && !isOverviewReactive).map((zone) => (
          <div
            key={zone.id}
            ref={(el) => {
              if (el) zoneBannerRefs.current.set(zone.id, el);
              else zoneBannerRefs.current.delete(zone.id);
            }}
            className="absolute top-0 left-0 will-change-transform origin-top-left"
          >
            {zone.type === 'meeting' ? (
              <div
                className="px-3 py-1.5 text-center text-white font-bold text-sm tracking-wide shadow-md"
                style={{ backgroundColor: zone.color || '#7c3aed' }}
              >
                {zone.label}
              </div>
            ) : (
              <div
                className="px-2 py-0.5 rounded-full text-[10px] font-semibold text-white shadow whitespace-nowrap"
                style={{ backgroundColor: zone.color || '#7c3aed' }}
              >
                {zone.label}
              </div>
            )}
          </div>
        ))}
      </div>
      {/* Banner furniture — decorative signage placed via the Room Editor,
          same imperative-transform pattern as zone banners above. */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {furniture.filter((f) => f.kind === 'banner').map((item) => (
          <div
            key={item.id}
            ref={(el) => {
              if (el) bannerRefs.current.set(item.id, el);
              else bannerRefs.current.delete(item.id);
            }}
            className="absolute top-0 left-0 will-change-transform origin-top-left"
          >
            {item.imageUrl ? (
              <img src={item.imageUrl} alt={item.text || 'Banner'} className="w-full h-auto shadow-md" />
            ) : (
              <div
                className="px-3 py-1.5 text-center font-bold text-sm tracking-wide shadow-md"
                style={{ backgroundColor: item.bgColor || '#7c3aed', color: item.textColor || '#ffffff' }}
              >
                {item.text || 'Banner'}
              </div>
            )}
          </div>
        ))}
      </div>
      {/* QA #7/#8/#9 — Note markers, same imperative-transform pattern as
          the media markers below. A note is placed via Add Media at the
          player's current tile (see AddMediaPanel.tsx) — not tied to any
          furniture piece. Always visible to everyone in the room (delivered
          via ROOM_STATE.notes); clicking opens NoteModal for the full text,
          author-only edit/delete. */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {notes.map((note) => {
          const preview = note.text.length > 40 ? `${note.text.slice(0, 40)}…` : note.text;
          return (
            <div
              key={note.id}
              ref={(el) => {
                if (el) noteMarkerRefs.current.set(note.id, el);
                else noteMarkerRefs.current.delete(note.id);
              }}
              className="absolute top-0 left-0 will-change-transform origin-top-left pointer-events-auto"
            >
              <button
                onClick={() => onNoteOpen(note.id)}
                title={`Catatan oleh ${note.authorName}`}
                className="-mt-6 -ml-4 max-w-[140px] rounded-md border border-amber-700/30 bg-amber-300/95 px-2 py-1 text-left text-[10px] leading-tight text-amber-950 shadow-md cursor-pointer hover:scale-105 transition-transform"
              >
                📝 {preview}
              </button>
            </div>
          );
        })}
      </div>
      {/* §6 — Media markers, same imperative-transform pattern as the
          overlays above. Image/YouTube show their actual content directly
          (a real thumbnail, not just an icon) — no extra click needed to
          see what's there; clicking it still opens MediaViewerModal for the
          full-size image / actual video playback / delete. Whiteboard/file
          stay a small icon pin: a whiteboard needs its own interactive
          canvas either way (no "preview" that isn't also the real thing),
          and a file has no visual content to show at all before opening it. */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {mediaObjects.map((media) => {
          const isThumbnail = media.type === 'image' || media.type === 'youtube';
          const thumbnailSrc = media.type === 'image'
            ? media.payload.url
            : media.payload.videoId
              ? `https://img.youtube.com/vi/${media.payload.videoId}/mqdefault.jpg`
              : undefined;
          const isMaximized = media.id === maximizedYtId;
          return (
            <div
              key={media.id}
              ref={(el) => {
                if (el) mediaMarkerRefs.current.set(media.id, el);
                else mediaMarkerRefs.current.delete(media.id);
              }}
              className={isMaximized ? 'absolute top-0 left-0 pointer-events-auto' : 'absolute top-0 left-0 will-change-transform origin-top-left pointer-events-auto'}
            >
              {/* Potong 6 — YouTube auto-embeds (muted) when the player is near;
                  website opens a new tab; bgm shows a non-interactive marker. */}
              {media.type === 'youtube' && ytEmbedId === media.id && media.payload.videoId ? (
                // Bug 9 — the auto-embed iframe swallows every click (play/
                // pause land INSIDE the player), so while it was showing
                // there was no clickable way to enlarge to the lightbox at
                // all (only the non-obvious X key). A small overlay button
                // gives the embed the same clear click-to-enlarge affordance
                // the thumbnail state already has, without covering the
                // player's own controls.
                //
                // Bug media #1 — maximized uses `fixed inset-0` instead of
                // opening a second modal/iframe (MediaViewerModal). This only
                // works because the marker's own transform/will-change was
                // dropped above (see className and the per-frame transform
                // loop) — a `fixed` element is trapped to its nearest
                // transformed ancestor's box otherwise, which would make this
                // fill the tiny marker instead of the real viewport.
                <div
                  className={isMaximized ? 'fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-6' : 'relative w-56 h-32 -mt-32 -ml-4'}
                  onMouseDown={isMaximized ? () => setMaximizedYtId(null) : undefined}
                >
                  <div
                    className={isMaximized ? 'relative w-full h-full max-w-5xl max-h-[85vh] aspect-video' : 'relative w-full h-full'}
                    onMouseDown={isMaximized ? (e) => e.stopPropagation() : undefined}
                  >
                  {/* Bug 11 — autoplay=1&mute=1: modern browsers only permit
                      autoplay when muted, so the video starts playing
                      silently the moment the player walks near, and the
                      prominent button below is the sanctioned user gesture
                      that turns sound on (unMute via the IFrame postMessage
                      API — enablejsapi=1 — plus playVideo, in case the user
                      had paused it). Maximizing keeps this SAME iframe (see
                      above) rather than swapping to a fresh, unstarted one —
                      mute state carries over untouched either way. */}
                  <iframe
                    ref={ytIframeRef}
                    title="yt"
                    src={`https://www.youtube.com/embed/${media.payload.videoId}?autoplay=1&mute=1&rel=0&enablejsapi=1`}
                    allow="autoplay; encrypted-media; picture-in-picture"
                    className="w-full h-full rounded-lg shadow-lg border border-purple-300 bg-black"
                  />
                  {isMaximized ? (
                    <button
                      onClick={() => setMaximizedYtId(null)}
                      title="Kecilkan"
                      className="absolute top-1 right-1 w-8 h-8 rounded bg-black/60 hover:bg-black/80 text-white text-sm flex items-center justify-center cursor-pointer"
                    >
                      ✕
                    </button>
                  ) : (
                  <button
                    onClick={() => setMaximizedYtId(media.id)}
                    title="Perbesar"
                    className="absolute top-1 right-1 w-6 h-6 rounded bg-black/60 hover:bg-black/80 text-white text-xs flex items-center justify-center cursor-pointer"
                  >
                    ⛶
                  </button>
                  )}
                  {!ytUnmuted && (
                    <button
                      onClick={() => {
                        const w = ytIframeRef.current?.contentWindow;
                        if (!w) return;
                        w.postMessage(JSON.stringify({ event: 'command', func: 'unMute', args: [] }), '*');
                        w.postMessage(JSON.stringify({ event: 'command', func: 'playVideo', args: [] }), '*');
                        setYtUnmuted(true);
                      }}
                      className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-red-600 hover:bg-red-700 text-white text-[11px] font-semibold px-3 py-1 shadow-lg cursor-pointer animate-pulse"
                    >
                      🔇 Nyalakan suara
                    </button>
                  )}
                  </div>
                </div>
              ) : (
                <button
                  onClick={
                    media.type === 'website'
                      ? () => { const u = media.payload.websiteUrl; if (u) window.open(u, '_blank', 'noopener'); }
                      : media.type === 'bgm'
                        ? undefined
                        : () => onMediaOpen(media.id)
                  }
                  title={media.type === 'website' ? (media.payload.websiteUrl ?? 'website') : media.type}
                  className={isThumbnail && thumbnailSrc
                    ? 'w-16 h-16 -mt-16 -ml-4 rounded-lg overflow-hidden shadow-md border border-purple-200 cursor-pointer hover:scale-105 transition-transform bg-white/90 relative'
                    : `w-8 h-8 -mt-8 flex items-center justify-center text-lg bg-white/90 backdrop-blur-sm rounded-full shadow-md border border-purple-200 ${media.type === 'bgm' ? '' : 'cursor-pointer hover:scale-110'} transition-transform`}
                >
                  {isThumbnail && thumbnailSrc ? (
                    <>
                      <img src={thumbnailSrc} alt="" className="w-full h-full object-cover" />
                      {media.type === 'youtube' && (
                        <span className="absolute inset-0 flex items-center justify-center text-white text-xl drop-shadow">▶️</span>
                      )}
                    </>
                  ) : (
                    MEDIA_ICON[media.type] ?? '📌'
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {/* Claimable-seat markers (Room Editor's 'claimableSeat' tile effect) —
          same DOM-overlay pattern as media markers above. Unclaimed → click
          to claim (server validates + broadcasts SEAT_CLAIMS_UPDATED, or
          denies via SEAT_CLAIM_DENIED if someone beat you to it). Yours →
          click teleports there (reuses emitTeleportTo, the same primitive
          the existing double-click-to-move feature uses — no second
          teleport path), plus a small ✕ to release manually. Someone
          else's → shown with their name, click attempts to claim anyway and
          lets the server deny it (single source of truth, no client-side
          "is this taken" guess to keep in sync). */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {claimableSeats.map((seat) => {
          const owner = seatClaims[seat.id];
          const isMine = !!owner && owner.userId === localUserId;
          return (
            <div
              key={seat.id}
              ref={(el) => {
                if (el) claimSeatMarkerRefs.current.set(seat.id, el);
                else claimSeatMarkerRefs.current.delete(seat.id);
              }}
              className="absolute top-0 left-0 will-change-transform origin-top-left pointer-events-auto flex flex-col items-center -mt-3.5 -ml-3.5 group"
            >
              <button
                data-seat-id={seat.id}
                onClick={() => {
                  if (isMine) {
                    // Follow-up — this used to be a plain teleport (stand at
                    // the tile, no sit state at all). Now performs a REAL
                    // sit, same state/emit performSit uses for an ordinary
                    // chair with no sitFacing configured: face the OPPOSITE
                    // of whichever way the player was walking/facing right
                    // before the click — i.e. away from the seat, back
                    // toward the room they approached from, exactly the
                    // "face away from the chair" convention every other
                    // chair in the game already defaults to. setPosition
                    // (movement source-of-truth) + setLocalPlayer both still
                    // needed for the SAME reason as before (emitSit alone
                    // only reaches OTHER clients — socket.to excludes the
                    // sender).
                    const cx = seat.x * TILE_SIZE + TILE_SIZE / 2;
                    const cy = seat.y * TILE_SIZE + TILE_SIZE / 2;
                    const store = useGameStore.getState();
                    const from = store.localPlayer;
                    const sitDirection = OPPOSITE_DIRECTION[from.direction];
                    setPosition(cx, cy);
                    store.setSitReturnPos({ x: from.x, y: from.y });
                    store.setSittingFurnitureId(seat.id);
                    store.setLocalPlayer({ x: cx, y: cy, direction: sitDirection, isMoving: false, isSitting: true, seatFurnitureId: seat.id });
                    emitSit(true, cx, cy, sitDirection, seat.id);
                  } else {
                    // ZEP-style confirm — see pendingSeatClaim's own doc
                    // comment; a bare click no longer claims directly.
                    setPendingSeatClaim({ seatId: seat.id, ownerName: owner?.name ?? null });
                  }
                }}
                title={owner ? (isMine ? 'Kursimu — klik untuk duduk di sini' : `Diklaim ${owner.name}`) : 'Klaim kursi ini'}
                // Unclaimed — deliberately invisible (no bg/border/icon, per
                // the room admin): the hit area still works exactly like an
                // Impassable tile's invisible barrier, just with no shape
                // drawn. Once claimed, this same button also carries the
                // "Kamu"/owner-name text (merged in — see the follow-up
                // comment below) instead of a separate stacked pill, so a
                // claimed seat is ONE small label, not three stacked pieces.
                className={`h-7 px-2 flex items-center justify-center gap-1 text-xs font-semibold rounded-full transition-transform cursor-pointer whitespace-nowrap ${
                  owner ? `shadow-md border-2 hover:scale-105 text-white ${isMine ? 'bg-emerald-500/95 border-emerald-600' : 'bg-amber-500/95 border-amber-600'}` : 'w-7'
                }`}
              >
                {owner ? `🪑 ${isMine ? 'Kamu' : owner.name}` : ''}
              </button>
              {/* Follow-up — used to be a separate always-visible "Kamu" pill
                  PLUS this release button stacked below it, permanently in
                  view over every claimed seat. Merged the pill's text into
                  the seat button itself above, and this release control now
                  only exists in the DOM/is only clickable while the marker
                  group is hovered (group-hover, opacity-0 by default) —
                  the release action is still one click away, just not a
                  permanent fixture cluttering the view of a seat you're not
                  even looking at right now. */}
              {isMine && (
                <button
                  data-release-seat-id={seat.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    // Follow-up — releasing while actually sitting there now
                    // also stands the player up (claiming it now sits them
                    // down for real, see the seat button's onClick above),
                    // rather than leaving them visually seated in a chair
                    // that's no longer theirs.
                    if (useGameStore.getState().localPlayer.isSitting && useGameStore.getState().localPlayer.seatFurnitureId === seat.id) {
                      performStandUp();
                    }
                    emitReleaseSeat(seat.id);
                  }}
                  title="Lepas kursi"
                  className="mt-0.5 w-4 h-4 flex items-center justify-center text-[9px] rounded-full bg-black/50 hover:bg-black/70 text-white cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>

      {pendingSeatClaim && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-auto">
          <div className="bg-white dark:bg-gray-900 rounded-xl p-6 shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 text-center max-w-xs">
            <p className="text-gray-900 dark:text-gray-100 text-sm mb-4">
              {pendingSeatClaim.ownerName
                ? <>Kursi ini sudah diklaim <span className="font-semibold">{pendingSeatClaim.ownerName}</span>. Tetap ingin menjadikannya kursimu?</>
                : 'Klaim kursi ini sebagai milikmu?'}
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => setPendingSeatClaim(null)}
                className="px-4 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm cursor-pointer"
              >
                Batal
              </button>
              <button
                onClick={() => { emitClaimSeat(pendingSeatClaim.seatId); setPendingSeatClaim(null); }}
                className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-sm cursor-pointer"
              >
                Konfirmasi
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
