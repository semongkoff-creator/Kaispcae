import { TILE_SIZE, TileType, RoomTile, Furniture, RoomTheme } from '@virtualmeet/shared';
import { drawSpriteFrame } from '@/utils/spriteLoader';
import { PALETTE_BY_ID, THEME_TILE_SPRITES } from '@/data/themeAssets';

// Shared, pure map-drawing helpers — extracted verbatim from GameCanvas so the
// game view AND the new Room Editor render tiles/furniture identically off one
// source of truth (no store/player dependency here). Behaviour is unchanged
// from when these lived inline in GameCanvas.

// Fallback solid colors, used only while the real tileset image is still loading.
export const TILE_COLORS: Record<TileType, string> = {
  floor: '#e8d5b0',
  wall: '#4a3728',
  door: '#d4a056',
  desk: '#8B6914',
  chair: '#5b8dd9',
  portal: '#e8d5b0',
  spawn: '#e8d5b0',
  // Invisible impassable tile — never actually drawn (GameCanvas skips it); the
  // key exists only to satisfy Record<TileType>. Floor shows through.
  blocked: '#e8d5b0',
};

// Real tileset art for each generic TileType (used when a tile has no
// `floorPaletteId` / no matching Furniture entry — legacy rooms, or fallback
// while richer data hasn't loaded), varying by the room's theme.
export function drawTile(ctx: CanvasRenderingContext2D, type: TileType, screenX: number, screenY: number, theme: RoomTheme) {
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
export function drawFloorTile(ctx: CanvasRenderingContext2D, tile: RoomTile, screenX: number, screenY: number, theme: RoomTheme) {
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
export function drawFurnitureLayer(
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
