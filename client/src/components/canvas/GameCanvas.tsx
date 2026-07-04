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
} from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { useMovement } from '@/hooks/useMovement';
import { drawAvatar } from './AvatarSprite';
import { drawSpriteFrame } from '@/utils/spriteLoader';
import { TILE_PALETTE_BY_ID } from '@/data/tilePaletteManifest';

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

// Real tileset art for each generic TileType, used when a tile has no
// `floorPaletteId` / no matching Furniture entry (legacy rooms, or fallback
// while richer data hasn't loaded). Modern_Office_Singles files are exported
// on a padded 64x96 canvas with content bottom-anchored — srcX/srcY here
// crop just the bottom-most 32x32 slice of that real content (see
// tilePaletteManifest.ts for the full multi-cell-aware version of this data).
const OFFICE_SINGLES = '/assets/tilesets/modern-office/Modern_Office_Singles_32x32';
const ROOM_BUILDER_OFFICE = '/assets/tilesets/modern-office/Room_Builder_Office_32x32.png';

interface TileSpriteDef {
  src: string;
  srcX: number;
  srcY: number;
}

// portal/spawn render as plain floor — their special meaning is conveyed by
// the pulsing ring markers drawn in the tile loop below, not a distinct sprite.
//
// BUG FIX: this used to point at Singles_28.png, whose actual opaque content
// (verified by rendering the crop against a magenta background) is only a
// 30x14px sliver at the bottom of its 32x32 cell — not a full tile. Drawing
// that meant ~55% of every floor tile was transparent, so the dark canvas
// background showed through as a "thin strip with gaps" for every row.
// Singles_6.png looked right in a one-off crop check but turned out to have
// a 2px transparent inset on its left edge (bbox x:[2,31] of 32) — invisible
// in a single tile, but tiling it repeats that gap as a faint vertical seam
// every 32px. Singles_36.png fixed that (full [0,31]x[0,31] bbox, no margin)
// but rendering a 4x4 block of it revealed a DIFFERENT problem: its texture
// itself isn't horizontally seamless, so repeating it draws a visible line
// down every tile boundary regardless of crop correctness. Singles_86.png's
// fine crosshatch pattern tiles cleanly in both directions (verified by
// rendering a 4x4 repeat) — no code fix can make a non-tileable texture
// tileable, so the fix here is picking a texture that actually is one.
const FLOOR_SPRITE: TileSpriteDef = { src: `${OFFICE_SINGLES}/Modern_Office_Singles_32x32_86.png`, srcX: 0, srcY: 64 };

const TILE_SPRITES: Record<TileType, TileSpriteDef> = {
  floor: FLOOR_SPRITE,
  wall: { src: ROOM_BUILDER_OFFICE, srcX: 0, srcY: 0 },
  door: { src: ROOM_BUILDER_OFFICE, srcX: 7 * TILE_SIZE, srcY: 1 * TILE_SIZE },
  desk: { src: `${OFFICE_SINGLES}/Modern_Office_Singles_32x32_211.png`, srcX: 0, srcY: 64 },
  chair: { src: `${OFFICE_SINGLES}/Modern_Office_Singles_32x32_101.png`, srcX: 0, srcY: 64 },
  portal: FLOOR_SPRITE,
  spawn: FLOOR_SPRITE,
};

function drawTile(ctx: CanvasRenderingContext2D, type: TileType, screenX: number, screenY: number) {
  const sprite = TILE_SPRITES[type];
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
function drawFloorTile(ctx: CanvasRenderingContext2D, tile: RoomTile, screenX: number, screenY: number) {
  if (tile.floorPaletteId) {
    const entry = TILE_PALETTE_BY_ID[tile.floorPaletteId];
    if (entry && drawSpriteFrame(ctx, entry.src, {
      srcX: entry.srcX, srcY: entry.srcY, cellWidth: TILE_SIZE, cellHeight: TILE_SIZE,
      dx: screenX, dy: screenY,
    })) return;
  }
  drawTile(ctx, 'floor', screenX, screenY);
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
  const entry = TILE_PALETTE_BY_ID[item.paletteId];
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

const BLOCKED_TILES: Set<TileType> = new Set(['wall', 'desk', 'chair']);

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
  emitMove: (x: number, y: number, direction: string) => void;
  emitStop: (direction: string) => void;
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
  onPortalEnter: (target: string) => void;
}

export function GameCanvas({ emitMove, emitStop, proximityData, localSpeaking, speakingPlayers, micMuted, cameraOn, editorMode, selectedTileType, selectedPaletteId, onTilePaint, onTileHistoryPush, onFloorPaint, onFurniturePlace, onFurnitureErase, zoneDrawMode, onZoneDrawComplete, onPortalEnter }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const prevTimeRef = useRef<number>(0);
  const wasMovingRef = useRef<boolean>(false);

  const emitMoveRef = useRef(emitMove); emitMoveRef.current = emitMove;
  const emitStopRef = useRef(emitStop); emitStopRef.current = emitStop;

  const tiles = useGameStore((s) => s.tiles);
  const localPlayer = useGameStore((s) => s.localPlayer);
  const localPlayerId = useGameStore((s) => s.localPlayerId);

  const tilesRef = useRef(tiles);
  const playerRecordsRef = useRef(useGameStore.getState().playerRecords);
  const localPlayerRef = useRef(localPlayer);
  const localPlayerIdRef = useRef(localPlayerId);
  const bubblesRef = useRef(useGameStore.getState().speechBubbles);
  const emotesRef = useRef(useGameStore.getState().emoteEvents);
  const zones = useGameStore((s) => s.zones);
  const zonesRef = useRef(zones);
  // Labeled zones render a DOM banner positioned imperatively (via transform,
  // inside the rAF loop below) instead of React state, so following the
  // camera at 60fps doesn't trigger a re-render for every frame.
  const zoneBannerRefs = useRef(new Map<string, HTMLDivElement>());
  const furniture = useGameStore((s) => s.furniture);
  const furnitureRef = useRef(furniture);

  useEffect(() => {
    tilesRef.current = tiles;
    playerRecordsRef.current = useGameStore.getState().playerRecords;
    localPlayerRef.current = localPlayer;
    localPlayerIdRef.current = localPlayerId;
    bubblesRef.current = useGameStore.getState().speechBubbles;
    emotesRef.current = useGameStore.getState().emoteEvents;
    zonesRef.current = zones;
    furnitureRef.current = furniture;
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
  const onPortalEnterRef = useRef(onPortalEnter); onPortalEnterRef.current = onPortalEnter;
  const zoneDragStartRef = useRef<{ x: number; y: number } | null>(null);
  const zoneDragCurrentRef = useRef<{ x: number; y: number } | null>(null);
  const lastPortalTileRef = useRef<string | null>(null);

  const isBlocked = useCallback((tileX: number, tileY: number) => {
    if (tileX < 0 || tileX >= MAP_WIDTH || tileY < 0 || tileY >= MAP_HEIGHT) return true;
    const t = tilesRef.current;
    if (t.length === 0) return false;
    return BLOCKED_TILES.has(t[tileY]?.[tileX]?.type);
  }, []);

  const onMoveRef = useRef((x: number, y: number, direction: Direction) => {
    useGameStore.getState().setLocalPlayer({ x, y, direction, isMoving: true });
  });

  const { update, setPosition } = useMovement({
    isBlocked,
    onMove: onMoveRef.current,
  });

  useEffect(() => {
    setPosition(localPlayer.x, localPlayer.y);
  }, [localPlayer.x, localPlayer.y, setPosition]);

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

    if (moveResult.isMoving) {
      emitMoveRef.current(moveResult.x, moveResult.y, moveResult.direction);
      wasMovingRef.current = true;
    } else if (wasMovingRef.current) {
      emitStopRef.current(moveResult.direction);
      useGameStore.getState().setLocalPlayer({ isMoving: false });
      wasMovingRef.current = false;
    }

    const playerX = moveResult.x;
    const playerY = moveResult.y;
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
        drawFloorTile(ctx, tile, screenX, screenY);
        if (tile.type !== 'floor' && tile.type !== 'portal' && tile.type !== 'spawn') {
          drawTile(ctx, tile.type, screenX, screenY);
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

    // Furniture — object layer (base row, drawn before avatars)
    const furnitureList = furnitureRef.current;
    for (const item of furnitureList) {
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
        const paletteEntry = activePaletteId ? TILE_PALETTE_BY_ID[activePaletteId] : undefined;
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
    const walkOffset = moveResult.isMoving ? Math.sin(timestamp * 0.008) * 2 : 0;
    const localAvatar: Avatar = {
      ...localPlayer, x: playerX, y: playerY, isMoving: moveResult.isMoving,
      direction: moveResult.direction, id: localPlayerId,
    };
    const remoteAvatars = Object.values(playerRecords).filter((p) => p.id !== localPlayerId);
    const allAvatars: Avatar[] = [localAvatar, ...remoteAvatars];

    for (const avatar of allAvatars) {
      const sx = avatar.x - cameraX;
      const sy = avatar.y - cameraY;
      if (sx < -AVATAR_RADIUS - 30 || sx > logicalW + AVATAR_RADIUS + 30 ||
          sy < -AVATAR_RADIUS - 40 || sy > logicalH + AVATAR_RADIUS + 30) continue;

      const isLocal = avatar.id === localPlayerId;
      drawAvatar(ctx, { avatar, x: sx, y: sy, isLocal, timestamp,
        walkAnimOffset: isLocal ? walkOffset : avatar.isMoving ? Math.sin(timestamp * 0.008 + (avatar.id.charCodeAt(0) || 0) * 0.1) * 2 : 0,
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
      const inProx = proximityRef.current.find((p) => p.id === avatar.id)?.inProximity ?? false;

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
      if (item.x < startCol - 2 || item.x > endCol + 2 || item.y < startRow - 3 || item.y > endRow + 1) continue;
      drawFurnitureLayer(ctx, item, cameraX, cameraY, 'overhead');
    }

    // Speech bubbles
    const bubbles = bubblesRef.current;
    const now = Date.now();
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

    const paletteId = selectedPaletteRef.current;
    if (paletteId) {
      const entry = TILE_PALETTE_BY_ID[paletteId];
      if (entry?.category === 'floor') {
        isPaintingRef.current = true;
        onFloorPaint(tile.x, tile.y, paletteId);
      } else if (entry?.category === 'furniture') {
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
        const entry = TILE_PALETTE_BY_ID[paletteId];
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
    onFurnitureErase(tile.x, tile.y);
    onTileHistoryPush();
    onTilePaint(tile.x, tile.y, 'floor');
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
    </div>
  );
}
