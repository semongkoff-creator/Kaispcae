import { useRef, useEffect, useCallback, useState } from 'react';
import {
  TILE_SIZE,
  MAP_WIDTH,
  MAP_HEIGHT,
  Avatar,
  TileType,
  Furniture,
  Direction,
  ProximityPlayer,
  PROXIMITY_THRESHOLD_PX,
  EMOTE_EMOJI,
  JUMP_DURATION_MS,
  JUMP_HEIGHT_PX,
  NUDGE_DURATION_MS,
  NUDGE_SHAKE_PX,
} from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { useMovement } from '@/hooks/useMovement';
import { drawAvatar } from './AvatarSprite';
import { drawSpriteFrame } from '@/utils/spriteLoader';
import { PALETTE_BY_ID } from '@/data/themeAssets';
import { isTileBlocked } from '@/utils/createDefaultRoom';
// Bug 16-project (Room Editor) — these map-draw helpers were moved verbatim to
// mapRender.ts so the editor can render the map identically. GameCanvas's usage
// is unchanged.
import { drawTile, drawFloorTile, drawFurnitureLayer, TILE_COLORS } from './mapRender';

const AVATAR_RADIUS = 14;

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

function hexToRgb(hex: string | undefined): [number, number, number] | null {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
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
  emitStop: (direction: string) => void;
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
  onMediaOpen: (mediaId: string) => void;
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

// Bug 3 — how forgiving the "walk up to interact" hitbox is, in tiles
// (Chebyshev). The old chair logic demanded the player stand on the exact
// adjacent tile AND face the seat dead-on; media used a radius of 1. A radius
// of 2 lets the player be ~1 tile of slack away in any direction (incl.
// diagonals) and still get the prompt, while nearest-wins selection keeps two
// nearby pieces from being confused for one another.
const INTERACT_TILE_RADIUS = 2;

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

export function GameCanvas({ emitMove, emitStop, emitJump, emitNudge, proximityData, localSpeaking, speakingPlayers, micMuted, cameraOn, editorMode, selectedTileType, selectedPaletteId, onTilePaint, onTileHistoryPush, onFloorPaint, onFurniturePlace, onFurnitureErase, zoneDrawMode, onZoneDrawComplete, bannerPlaceMode, onBannerPlaceComplete, onPortalEnter, emitSit, emitFollowUnfollow, emitTeleportTo, onMediaOpen }: GameCanvasProps) {
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
  const emitSitRef = useRef(emitSit); emitSitRef.current = emitSit;
  const emitFollowUnfollowRef = useRef(emitFollowUnfollow); emitFollowUnfollowRef.current = emitFollowUnfollow;

  const tiles = useGameStore((s) => s.tiles);
  const localPlayer = useGameStore((s) => s.localPlayer);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const theme = useGameStore((s) => s.theme);
  const followInfo = useGameStore((s) => s.followInfo);
  // Reactive (not just useGameStore.getState()) so a nudge landing while
  // nothing else on screen happens to be re-rendering still triggers one —
  // otherwise the ref below (and the shake/pop effect it drives) can go
  // stale until some unrelated state change happens to re-render GameCanvas.
  const nudgedPlayers = useGameStore((s) => s.nudgedPlayers);
  const nudgerPlayers = useGameStore((s) => s.nudgerPlayers);

  const tilesRef = useRef(tiles);
  const themeRef = useRef(theme);
  const followInfoRef = useRef(followInfo);
  const playerRecordsRef = useRef(useGameStore.getState().playerRecords);
  const localPlayerRef = useRef(localPlayer);
  const localPlayerIdRef = useRef(localPlayerId);
  const bubblesRef = useRef(useGameStore.getState().speechBubbles);
  const emotesRef = useRef(useGameStore.getState().emoteEvents);
  const jumpingPlayersRef = useRef(useGameStore.getState().jumpingPlayers);
  const nudgedPlayersRef = useRef(nudgedPlayers);
  const nudgerPlayersRef = useRef(nudgerPlayers);
  const zones = useGameStore((s) => s.zones);
  const zonesRef = useRef(zones);
  // Labeled zones render a DOM banner positioned imperatively (via transform,
  // inside the rAF loop below) instead of React state, so following the
  // camera at 60fps doesn't trigger a re-render for every frame.
  const zoneBannerRefs = useRef(new Map<string, HTMLDivElement>());
  const furniture = useGameStore((s) => s.furniture);
  const furnitureRef = useRef(furniture);
  // Banner furniture (Furniture.kind === 'banner') renders as a DOM overlay
  // too, positioned the same imperative way as zone banners above.
  const bannerRefs = useRef(new Map<string, HTMLDivElement>());
  const mediaObjects = useGameStore((s) => s.mediaObjects);
  const mediaObjectsRef = useRef(mediaObjects);
  // Potong 6 — which YouTube tile is close enough to auto-embed (proximity).
  const [ytEmbedId, setYtEmbedId] = useState<string | null>(null);
  const ytEmbedRef = useRef<string | null>(null);
  // §6 — Add Media markers: same DOM-overlay-positioned-via-transform
  // pattern as zone/banner above, one small clickable pin per object.
  const mediaMarkerRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    tilesRef.current = tiles;
    themeRef.current = theme;
    followInfoRef.current = followInfo;
    playerRecordsRef.current = useGameStore.getState().playerRecords;
    localPlayerRef.current = localPlayer;
    localPlayerIdRef.current = localPlayerId;
    bubblesRef.current = useGameStore.getState().speechBubbles;
    emotesRef.current = useGameStore.getState().emoteEvents;
    jumpingPlayersRef.current = useGameStore.getState().jumpingPlayers;
    nudgedPlayersRef.current = nudgedPlayers;
    nudgerPlayersRef.current = nudgerPlayers;
    zonesRef.current = zones;
    furnitureRef.current = furniture;
    mediaObjectsRef.current = mediaObjects;
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
    return isTileBlocked(t, tileX, tileY);
  }, []);

  const onMoveRef = useRef((x: number, y: number, direction: Direction) => {
    useGameStore.getState().setLocalPlayer({ x, y, direction, isMoving: true });
  });

  const { update, setPosition, updateFollow } = useMovement({
    isBlocked,
    onMove: onMoveRef.current,
    isFrozen: () => useGameStore.getState().localPlayer.isSitting === true,
  });

  useEffect(() => {
    setPosition(localPlayer.x, localPlayer.y);
  }, [localPlayer.x, localPlayer.y, setPosition]);

  // A4 — double-click a non-blocked tile to teleport there instantly. Refs so
  // the once-attached listener always reads current values without re-binding.
  const emitTeleportToRef = useRef(emitTeleportTo); emitTeleportToRef.current = emitTeleportTo;
  const setPositionRef = useRef(setPosition); setPositionRef.current = setPosition;
  // Transient fade rings at teleport source + destination (performance.now()
  // timestamps), drawn + expired in the render loop.
  const teleportFlashRef = useRef<{ x: number; y: number; start: number }[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onDblClick = (e: MouseEvent) => {
      if (editorModeRef.current) return; // never teleport while editing the room
      const store = useGameStore.getState();
      if (store.localPlayer.isSitting) return; // stand up first (movement is frozen)
      const rect = canvas.getBoundingClientRect();
      const worldX = (e.clientX - rect.left) + cameraXRef.current;
      const worldY = (e.clientY - rect.top) + cameraYRef.current;
      const tileX = Math.floor(worldX / TILE_SIZE);
      const tileY = Math.floor(worldY / TILE_SIZE);
      if (tileX < 0 || tileY < 0) return;
      if (isBlocked(tileX, tileY)) return; // can't land inside a wall/desk
      const cx = tileX * TILE_SIZE + TILE_SIZE / 2;
      const cy = tileY * TILE_SIZE + TILE_SIZE / 2;
      const from = store.localPlayer;
      const now = performance.now();
      teleportFlashRef.current.push({ x: from.x, y: from.y, start: now }, { x: cx, y: cy, start: now });
      setPosition(cx, cy); // move the movement source-of-truth immediately — no snap-back
      store.setLocalPlayer({ x: cx, y: cy, isMoving: false });
      emitTeleportToRef.current(cx, cy, from.direction); // others snap via PLAYER_TELEPORTED
    };
    canvas.addEventListener('dblclick', onDblClick);
    return () => canvas.removeEventListener('dblclick', onDblClick);
  }, [isBlocked, setPosition]);

  // ── Sit-in-chair ─────────────────────────────────────────────────────
  // Updated every frame in draw() below (cheap — furniture lists are small)
  // so both the "press SPACE" indicator and the keydown handler read the
  // same up-to-date value without recomputing it twice.
  const nearbyChairRef = useRef<{ furniture: Furniture; tileX: number; tileY: number } | null>(null);
  // Gather-style "press X to interact" — the nearest placed media object
  // (image/youtube/whiteboard/file) within one tile of the player, if any.
  // Recomputed each frame in the draw loop (same pattern as nearbyChairRef).
  const nearbyMediaRef = useRef<{ id: string; tileX: number; tileY: number } | null>(null);

  const performSit = useCallback((chair: Furniture, tileX: number, tileY: number) => {
    // Seat at the exact tile faced, not always the furniture's anchor tile —
    // a multi-tile sofa is one seat spanning several tiles, so sitting from
    // its right half shouldn't visually snap the player over to its left end.
    const chairCenterX = tileX * TILE_SIZE + TILE_SIZE / 2;
    const chairCenterY = tileY * TILE_SIZE + TILE_SIZE / 2;

    // Refuse if another player is already seated on this exact tile —
    // without this check, two players could both sit at the same spot and
    // their avatars would render fully overlapping each other.
    const occupied = Object.values(playerRecordsRef.current).some(
      (p) => p.isSitting && (p.seatFurnitureId === chair.id || (p.x === chairCenterX && p.y === chairCenterY)),
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
    state.setSittingFurnitureId(chair.id);
    const OPPOSITE: Record<Direction, Direction> = { up: 'down', down: 'up', left: 'right', right: 'left' };
    // Face away from the chair — outward into the room, like someone
    // sitting down rather than facing into the seat back.
    const sitDirection = OPPOSITE[player.direction];
    state.setLocalPlayer({ x: chairCenterX, y: chairCenterY, direction: sitDirection, isMoving: false, isSitting: true, seatFurnitureId: chair.id });
    emitSitRef.current(true, chairCenterX, chairCenterY, sitDirection, chair.id);
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
          const { furniture, tileX, tileY } = nearbyChairRef.current;
          performSit(furniture, tileX, tileY);
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
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Resizing canvas.width/height resets all context state, including this
      // — must re-set every resize, not just once. Without it the browser's
      // default bilinear smoothing blurs every scaled sprite drawImage() call
      // (avatars drawn at 40px from a 32px source, in particular).
      ctx.imageSmoothingEnabled = false;
    }
  }, []);

  const draw = useCallback((timestamp: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    if (prevTimeRef.current === 0) prevTimeRef.current = timestamp;
    const rawDt = (timestamp - prevTimeRef.current) / 1000;
    const dt = Math.min(rawDt, 0.05);
    prevTimeRef.current = timestamp;

    const logicalW = canvas.width / (window.devicePixelRatio || 1);
    const logicalH = canvas.height / (window.devicePixelRatio || 1);

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

    if (effectiveMoveResult.isMoving) {
      emitMoveRef.current(effectiveMoveResult.x, effectiveMoveResult.y, effectiveMoveResult.direction, effectiveMoveResult.isRunning);
      wasMovingRef.current = true;
    } else if (wasMovingRef.current) {
      emitStopRef.current(effectiveMoveResult.direction);
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
        let best: { furniture: Furniture; tileX: number; tileY: number } | null = null;
        let bestScore = Infinity;
        for (const f of furnitureRef.current) {
          if (!f.isInteractable) continue;
          let nearFx = f.x;
          let nearDist = Infinity;
          for (let fx = f.x; fx < f.x + f.tilesW; fx++) {
            const d = Math.max(Math.abs(fx - baseTileX), Math.abs(f.y - baseTileY));
            if (d < nearDist) { nearDist = d; nearFx = fx; }
          }
          if (nearDist > INTERACT_TILE_RADIUS) continue;
          const faced = f.y === facingTileY && nearFx === facingTileX ? 0 : 0.5;
          const score = nearDist + faced;
          if (score < bestScore) { bestScore = score; best = { furniture: f, tileX: nearFx, tileY: f.y }; }
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
    // seams between adjacent tiles instead of a clean shared edge.
    const cameraX = Math.round(playerX - logicalW / 2);
    const cameraY = Math.round(playerY - logicalH / 2);

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

    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, logicalW, logicalH);

    const tiles = tilesRef.current;
    const startCol = Math.max(0, Math.floor(cameraX / TILE_SIZE));
    const endCol = Math.min(MAP_WIDTH, Math.ceil((cameraX + logicalW) / TILE_SIZE) + 1);
    const startRow = Math.max(0, Math.floor(cameraY / TILE_SIZE));
    const endRow = Math.min(MAP_HEIGHT, Math.ceil((cameraY + logicalH) / TILE_SIZE) + 1);

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
        if (tile.type !== 'floor' && tile.type !== 'portal' && tile.type !== 'spawn' && tile.type !== 'blocked') {
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

    // Furniture — object layer (base row, drawn before avatars). Banners
    // are DOM overlays (see bannerRefs below), not tileset sprites.
    const furnitureList = furnitureRef.current;
    for (const item of furnitureList) {
      if (item.kind === 'banner') continue;
      // Top-layer objects (ZEP editor) draw entirely AFTER avatars — skip them
      // in this before-avatars pass; the overhead pass below draws them whole.
      if (item.topLayer) continue;
      if (item.x < startCol - 2 || item.x > endCol + 2 || item.y < startRow - 3 || item.y > endRow + 1) continue;
      drawFurnitureLayer(ctx, item, cameraX, cameraY, 'object');
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

    // Zone overlays — boundary fill/outline only. The name/label text itself
    // is a DOM overlay (see zoneBannerRefs below), not drawn on canvas, so it
    // stays crisp and easy to restyle; zones without a `label` still get the
    // plain centered canvas text they always had, for backward compatibility.
    const zones = zonesRef.current;
    for (const zone of zones) {
      const zx = zone.x * TILE_SIZE - cameraX;
      const zy = zone.y * TILE_SIZE - cameraY;
      const zw = zone.width * TILE_SIZE;
      const zh = zone.height * TILE_SIZE;
      const [zr, zg, zb] = hexToRgb(zone.color) ?? [100, 149, 237];
      ctx.fillStyle = `rgba(${zr}, ${zg}, ${zb}, 0.08)`;
      ctx.fillRect(zx, zy, zw, zh);
      ctx.strokeStyle = `rgba(${zr}, ${zg}, ${zb}, 0.35)`;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(zx, zy, zw, zh);
      ctx.setLineDash([]);
      if (!zone.label) {
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
    for (const zone of zones) {
      if (!zone.label) continue;
      const el = zoneBannerRefs.current.get(zone.id);
      if (!el) continue;
      const zx = zone.x * TILE_SIZE - cameraX;
      const zy = zone.y * TILE_SIZE - cameraY;
      const zw = zone.width * TILE_SIZE;
      if (zone.type === 'meeting') {
        el.style.transform = `translate(${zx}px, ${zy}px)`;
        el.style.width = `${zw}px`;
      } else {
        el.style.transform = `translate(${zx + 6}px, ${zy - 12}px)`;
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
      const bx = item.x * TILE_SIZE - cameraX;
      const by = item.y * TILE_SIZE - cameraY;
      el.style.transform = `translate(${bx}px, ${by}px)`;
      el.style.width = `${item.tilesW * TILE_SIZE}px`;
      el.style.opacity = isAvatarUnderLabel(item.x, item.y, item.tilesW) ? '0' : '1';
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
      // Image/YouTube render as a much bigger inline thumbnail below (see
      // the marker JSX) than the small pin whiteboard/file still use, so
      // they need a wider stacking gap to avoid overlapping.
      const stackOffsetPx = media.type === 'image' || media.type === 'youtube' ? 40 : 18;
      const mx = media.x * TILE_SIZE - cameraX + stackIndex * stackOffsetPx;
      const my = media.y * TILE_SIZE - cameraY;
      el.style.transform = `translate(${mx}px, ${my}px)`;
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

    for (const avatar of allAvatars) {
      const sx = avatar.x - cameraX;
      const sy = avatar.y - cameraY;
      if (sx < -AVATAR_RADIUS - 30 || sx > logicalW + AVATAR_RADIUS + 30 ||
          sy < -AVATAR_RADIUS - 40 || sy > logicalH + AVATAR_RADIUS + 30) continue;

      const isLocal = avatar.id === localPlayerId;
      const bobOffset = isLocal ? walkOffset : avatar.isMoving ? Math.sin(timestamp * 0.008 + (avatar.id.charCodeAt(0) || 0) * 0.1) * 2 : 0;
      const jumpOffset = getJumpOffset(jumpingPlayersRef.current.get(avatar.id), now);
      const nudgeStart = nudgedPlayersRef.current.get(avatar.id);
      const nudgeOffset = getNudgeShakeOffset(nudgeStart, now);
      drawAvatar(ctx, { avatar, x: sx + nudgeOffset, y: sy, isLocal, timestamp,
        walkAnimOffset: bobOffset + jumpOffset,
      });

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
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
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
        {zones.filter((z) => z.label).map((zone) => (
          <div
            key={zone.id}
            ref={(el) => {
              if (el) zoneBannerRefs.current.set(zone.id, el);
              else zoneBannerRefs.current.delete(zone.id);
            }}
            className="absolute top-0 left-0 will-change-transform"
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
            className="absolute top-0 left-0 will-change-transform"
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
          return (
            <div
              key={media.id}
              ref={(el) => {
                if (el) mediaMarkerRefs.current.set(media.id, el);
                else mediaMarkerRefs.current.delete(media.id);
              }}
              className="absolute top-0 left-0 will-change-transform pointer-events-auto"
            >
              {/* Potong 6 — YouTube auto-embeds (muted) when the player is near;
                  website opens a new tab; bgm shows a non-interactive marker. */}
              {media.type === 'youtube' && ytEmbedId === media.id && media.payload.videoId ? (
                <iframe
                  title="yt"
                  src={`https://www.youtube.com/embed/${media.payload.videoId}?mute=1&rel=0`}
                  allow="autoplay; encrypted-media; picture-in-picture"
                  className="w-56 h-32 -mt-32 -ml-4 rounded-lg shadow-lg border border-purple-300 bg-black"
                />
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
    </div>
  );
}
