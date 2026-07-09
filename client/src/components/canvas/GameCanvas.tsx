import { useRef, useEffect, useCallback } from 'react';
import {
  TILE_SIZE,
  MAP_WIDTH,
  MAP_HEIGHT,
  Avatar,
  TileType,
  RoomTile,
  Furniture,
  Direction,
  ProximityPlayer,
  PROXIMITY_THRESHOLD_PX,
  EMOTE_EMOJI,
  RoomTheme,
  JUMP_DURATION_MS,
  JUMP_HEIGHT_PX,
} from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { useMovement } from '@/hooks/useMovement';
import { drawAvatar } from './AvatarSprite';
import { drawSpriteFrame } from '@/utils/spriteLoader';
import { PALETTE_BY_ID, THEME_TILE_SPRITES } from '@/data/themeAssets';
import { isTileBlocked } from '@/utils/createDefaultRoom';

// Fallback solid colors, used only while the real tileset image is still loading.
const TILE_COLORS: Record<TileType, string> = {
  floor: '#e8d5b0',
  wall: '#4a3728',
  door: '#d4a056',
  desk: '#8B6914',
  chair: '#5b8dd9',
  portal: '#e8d5b0',
  spawn: '#e8d5b0',
};

// Real tileset art for each generic TileType (used when a tile has no
// `floorPaletteId` / no matching Furniture entry — legacy rooms, or fallback
// while richer data hasn't loaded) now varies by the room's theme — see
// client/src/data/themeAssets.ts's THEME_TILE_SPRITES for the actual crops
// (verified the same alpha-channel-scan / real-pixel-dimensions way as
// before theming existed, not guessed).
function drawTile(ctx: CanvasRenderingContext2D, type: TileType, screenX: number, screenY: number, theme: RoomTheme) {
  const sprite = THEME_TILE_SPRITES[theme][type];
  const drew = sprite && drawSpriteFrame(ctx, sprite.src, {
    srcX: sprite.srcX, srcY: sprite.srcY, cellWidth: TILE_SIZE, cellHeight: TILE_SIZE,
    dx: screenX, dy: screenY,
  });
  if (!drew) {
    ctx.fillStyle = TILE_COLORS[type] || '#e8d5b0';
    ctx.fillRect(screenX, screenY, TILE_SIZE, TILE_SIZE);
  }
}

// Draws a floor tile, preferring its palette-picked texture (set via the
// Room Editor's visual palette) and falling back to the generic floor sprite.
function drawFloorTile(ctx: CanvasRenderingContext2D, tile: RoomTile, screenX: number, screenY: number, theme: RoomTheme) {
  if (tile.floorPaletteId) {
    const entry = PALETTE_BY_ID[tile.floorPaletteId];
    if (entry && drawSpriteFrame(ctx, entry.src, {
      srcX: entry.srcX, srcY: entry.srcY, cellWidth: TILE_SIZE, cellHeight: TILE_SIZE,
      dx: screenX, dy: screenY,
    })) return;
  }
  drawTile(ctx, 'floor', screenX, screenY, theme);
}

// Furniture is anchored at its bottom-left tile. The bottom tile row (the
// piece's "base") draws on the object layer, before avatars. Anything above
// that (tilesH > 1) draws on the overhead layer, after avatars, so players
// can walk visually behind tall pieces (a chair back, a wardrobe, etc).
function drawFurnitureLayer(
  ctx: CanvasRenderingContext2D,
  item: Furniture,
  cameraX: number,
  cameraY: number,
  layer: 'object' | 'overhead',
) {
  const entry = PALETTE_BY_ID[item.paletteId];
  if (!entry) return;
  const screenX = item.x * TILE_SIZE - cameraX;
  const baseRowScreenY = item.y * TILE_SIZE - cameraY;
  const pieceWidthPx = entry.tilesW * TILE_SIZE;

  if (layer === 'object') {
    const baseSrcY = entry.srcY + (entry.tilesH - 1) * TILE_SIZE;
    drawSpriteFrame(ctx, entry.src, {
      srcX: entry.srcX, srcY: baseSrcY, cellWidth: pieceWidthPx, cellHeight: TILE_SIZE,
      dx: screenX, dy: baseRowScreenY,
    });
  } else if (entry.tilesH > 1) {
    const overheadHeightPx = (entry.tilesH - 1) * TILE_SIZE;
    drawSpriteFrame(ctx, entry.src, {
      srcX: entry.srcX, srcY: entry.srcY, cellWidth: pieceWidthPx, cellHeight: overheadHeightPx,
      dx: screenX, dy: baseRowScreenY - overheadHeightPx,
    });
  }
}

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
  emitSit: (sitting: boolean, x: number, y: number, direction: Direction) => void;
  emitFollowUnfollow: () => void;
  onMediaOpen: (mediaId: string) => void;
}

const MEDIA_ICON: Record<string, string> = { image: '🖼️', youtube: '▶️', whiteboard: '📝', file: '📎' };

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

export function GameCanvas({ emitMove, emitStop, emitJump, proximityData, localSpeaking, speakingPlayers, micMuted, cameraOn, editorMode, selectedTileType, selectedPaletteId, onTilePaint, onTileHistoryPush, onFloorPaint, onFurniturePlace, onFurnitureErase, zoneDrawMode, onZoneDrawComplete, bannerPlaceMode, onBannerPlaceComplete, onPortalEnter, emitSit, emitFollowUnfollow, onMediaOpen }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const prevTimeRef = useRef<number>(0);
  const wasMovingRef = useRef<boolean>(false);

  const emitMoveRef = useRef(emitMove); emitMoveRef.current = emitMove;
  const emitStopRef = useRef(emitStop); emitStopRef.current = emitStop;
  const emitJumpRef = useRef(emitJump); emitJumpRef.current = emitJump;
  const emitSitRef = useRef(emitSit); emitSitRef.current = emitSit;
  const emitFollowUnfollowRef = useRef(emitFollowUnfollow); emitFollowUnfollowRef.current = emitFollowUnfollow;

  const tiles = useGameStore((s) => s.tiles);
  const localPlayer = useGameStore((s) => s.localPlayer);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const theme = useGameStore((s) => s.theme);
  const followInfo = useGameStore((s) => s.followInfo);

  const tilesRef = useRef(tiles);
  const themeRef = useRef(theme);
  const followInfoRef = useRef(followInfo);
  const playerRecordsRef = useRef(useGameStore.getState().playerRecords);
  const localPlayerRef = useRef(localPlayer);
  const localPlayerIdRef = useRef(localPlayerId);
  const bubblesRef = useRef(useGameStore.getState().speechBubbles);
  const emotesRef = useRef(useGameStore.getState().emoteEvents);
  const jumpingPlayersRef = useRef(useGameStore.getState().jumpingPlayers);
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
  const lastPortalTileRef = useRef<string | null>(null);

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

  // ── Sit-in-chair ─────────────────────────────────────────────────────
  // Updated every frame in draw() below (cheap — furniture lists are small)
  // so both the "press SPACE" indicator and the keydown handler read the
  // same up-to-date value without recomputing it twice.
  const nearbyChairRef = useRef<{ furniture: Furniture; tileX: number; tileY: number } | null>(null);

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
      (p) => p.isSitting && p.x === chairCenterX && p.y === chairCenterY,
    );
    if (occupied) return;

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
    state.setLocalPlayer({ x: chairCenterX, y: chairCenterY, direction: sitDirection, isMoving: false, isSitting: true });
    emitSitRef.current(true, chairCenterX, chairCenterY, sitDirection);
  }, []);

  const performStandUp = useCallback(() => {
    const state = useGameStore.getState();
    const returnPos = state.sitReturnPos;
    const x = returnPos?.x ?? state.localPlayer.x;
    const y = returnPos?.y ?? state.localPlayer.y;
    const direction = state.localPlayer.direction;
    state.setLocalPlayer({ x, y, isSitting: false });
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
  }, [performSit, performStandUp]);

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

    // Sit-in-chair: is there a sittable chair on the tile the player is
    // currently facing? Uses the STORED direction, not moveResult.direction
    // — the latter resets to a hardcoded 'down' the instant no movement key
    // is held (fine for movement, wrong for "which way am I facing").
    {
      const facingDir = localPlayerRef.current.direction;
      const baseTileX = Math.floor(playerX / TILE_SIZE);
      const baseTileY = Math.floor(playerY / TILE_SIZE);
      const facingTileX = baseTileX + (facingDir === 'left' ? -1 : facingDir === 'right' ? 1 : 0);
      const facingTileY = baseTileY + (facingDir === 'up' ? -1 : facingDir === 'down' ? 1 : 0);
      // Match anywhere across the piece's base-row width, not just its
      // anchor tile — a 2-wide sofa is still one seat, so facing its right
      // half must trigger the sit prompt exactly like facing its left half.
      if (localPlayerRef.current.isSitting) {
        nearbyChairRef.current = null;
      } else {
        const chair = furnitureRef.current.find((f) =>
          f.isInteractable && f.y === facingTileY && facingTileX >= f.x && facingTileX < f.x + f.tilesW,
        );
        nearbyChairRef.current = chair ? { furniture: chair, tileX: facingTileX, tileY: facingTileY } : null;
      }
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
      const key = `${pTileX},${pTileY}`;
      if (pTile?.type === 'portal' && pTile.portalTarget) {
        if (lastPortalTileRef.current !== key) {
          lastPortalTileRef.current = key;
          onPortalEnterRef.current(pTile.portalTarget);
        }
      } else {
        lastPortalTileRef.current = null;
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
        if (tile.type !== 'floor' && tile.type !== 'portal' && tile.type !== 'spawn') {
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
      drawAvatar(ctx, { avatar, x: sx, y: sy, isLocal, timestamp,
        walkAnimOffset: bobOffset + jumpOffset,
      });

      // Crown for admin players
      if (avatar.isAdmin) {
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('👑', sx, sy - AVATAR_RADIUS - 24);
      }

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

    // Furniture — overhead layer (drawn after avatars, so tall pieces let
    // players walk visually behind their upper portion)
    for (const item of furnitureList) {
      if (item.kind === 'banner') continue;
      if (item.x < startCol - 2 || item.x > endCol + 2 || item.y < startRow - 3 || item.y > endRow + 1) continue;
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
              <button
                onClick={() => onMediaOpen(media.id)}
                title={media.type}
                className={isThumbnail && thumbnailSrc
                  ? 'w-16 h-16 -mt-16 -ml-4 rounded-lg overflow-hidden shadow-md border border-purple-200 cursor-pointer hover:scale-105 transition-transform bg-white/90 relative'
                  : 'w-8 h-8 -mt-8 flex items-center justify-center text-lg bg-white/90 backdrop-blur-sm rounded-full shadow-md border border-purple-200 cursor-pointer hover:scale-110 transition-transform'}
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
