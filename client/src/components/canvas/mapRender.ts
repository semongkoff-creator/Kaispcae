import { TILE_SIZE, SOURCE_TILE_SIZE, TileType, RoomTile, Furniture, RoomTheme } from '@kaispace/shared';
import { drawSpriteFrame } from '@/utils/spriteLoader';
import { PALETTE_BY_ID, THEME_TILE_SPRITES } from '@/data/themeAssets';
import { ensureLimezuEntry } from '@/data/limezuInteriors';

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
  // cellWidth/cellHeight (SOURCE_TILE_SIZE) is how much of the spritesheet to
  // READ — fixed to the actual art's 32px grid, never TILE_SIZE. dWidth/
  // dHeight (TILE_SIZE) is how large that crop is drawn on screen. The two
  // used to be the same constant, which was harmless while TILE_SIZE was
  // also 32 but silently reads into the next cell over as soon as they
  // diverge (Fitur 4 upgrade to 48).
  const drew = sprite && drawSpriteFrame(ctx, sprite.src, {
    srcX: sprite.srcX, srcY: sprite.srcY, cellWidth: SOURCE_TILE_SIZE, cellHeight: SOURCE_TILE_SIZE,
    dx: screenX, dy: screenY, dWidth: TILE_SIZE, dHeight: TILE_SIZE,
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
      srcX: entry.srcX, srcY: entry.srcY, cellWidth: SOURCE_TILE_SIZE, cellHeight: SOURCE_TILE_SIZE,
      dx: screenX, dy: screenY, dWidth: TILE_SIZE, dHeight: TILE_SIZE,
    })) return;
  }
  drawTile(ctx, 'floor', screenX, screenY, theme);
}

// Fitur 15 — draws a wall tile, preferring its custom-uploaded skin
// (RoomTile.wallPaletteId, set via the Room Editor) and falling back to the
// theme's default wall art — same fallback pattern as drawFloorTile above.
// Collision is untouched either way: it's driven purely by `type === 'wall'`.
export function drawWallTile(ctx: CanvasRenderingContext2D, tile: RoomTile, screenX: number, screenY: number, theme: RoomTheme) {
  if (tile.wallPaletteId) {
    const entry = PALETTE_BY_ID[tile.wallPaletteId];
    if (entry && drawSpriteFrame(ctx, entry.src, {
      srcX: entry.srcX, srcY: entry.srcY, cellWidth: SOURCE_TILE_SIZE, cellHeight: SOURCE_TILE_SIZE,
      dx: screenX, dy: screenY, dWidth: TILE_SIZE, dHeight: TILE_SIZE,
    })) return;
  }
  drawTile(ctx, 'wall', screenX, screenY, theme);
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
  if (!entry) {
    // A limezu-* id whose category manifest hasn't been fetched yet (lazy
    // pack, see limezuInteriors.ts) — queue the fetch (idempotent) and skip
    // this frame; the canvas redraws continuously, so the piece appears the
    // first frame after its manifest+PNG arrive. Any other unknown id stays
    // a silent skip, exactly as before.
    ensureLimezuEntry(item.paletteId);
    return;
  }
  // Fitur 15B — ZEP-style Rotate & Flip / Size(%) / Reposition(px), generic
  // to any placed piece. offsetPx shifts the draw position; rotation/flip/
  // scale pivot around the piece's own center, applied via a canvas
  // transform around the (otherwise unchanged) drawSpriteFrame call — never
  // touches placement (item.x/y) or collision, purely how it's painted.
  // Rounded — item.x/y * TILE_SIZE and cameraX/Y are already whole pixels,
  // but the Room Editor's Reposition(px) offsetPx is free-form drag input
  // and can land on a fractional pixel; a sub-pixel drawImage destination
  // forces uneven nearest-neighbor sampling that reads as a torn/glitched
  // sprite (same failure mode Avatar sprites are rounded against).
  const screenX = Math.round(item.x * TILE_SIZE - cameraX + (item.offsetPx?.x ?? 0));
  const baseRowScreenY = Math.round(item.y * TILE_SIZE - cameraY + (item.offsetPx?.y ?? 0));
  // Source (spritesheet crop, fixed to the art's real 32px grid) vs
  // destination (on-screen draw, TILE_SIZE) width — these were the same
  // number while TILE_SIZE was also 32; the Fitur 4 upgrade to 48 means
  // reading `pieceWidthPx` worth of SOURCE pixels would bleed into the next
  // piece over in the spritesheet, so the read width must stay tied to
  // SOURCE_TILE_SIZE independent of how large it's then drawn.
  const pieceSourceWidthPx = entry.tilesW * SOURCE_TILE_SIZE;
  const pieceWidthPx = entry.tilesW * TILE_SIZE;
  const scaleW = (item.sizePercent?.w ?? 100) / 100;
  const scaleH = (item.sizePercent?.h ?? 100) / 100;
  const hasTransform = !!item.rotation || !!item.flipH || !!item.flipV || scaleW !== 1 || scaleH !== 1;

  const drawPiece = (srcY: number, sourceHeightPx: number, destHeightPx: number, dy: number) => {
    if (!hasTransform) {
      drawSpriteFrame(ctx, entry.src, {
        srcX: entry.srcX, srcY, cellWidth: pieceSourceWidthPx, cellHeight: sourceHeightPx,
        dx: screenX, dy, dWidth: pieceWidthPx, dHeight: destHeightPx,
      });
      return;
    }
    const cx = screenX + pieceWidthPx / 2, cy = dy + destHeightPx / 2;
    ctx.save();
    ctx.translate(cx, cy);
    if (item.rotation) ctx.rotate((item.rotation * Math.PI) / 180);
    ctx.scale((item.flipH ? -1 : 1) * scaleW, (item.flipV ? -1 : 1) * scaleH);
    drawSpriteFrame(ctx, entry.src, {
      srcX: entry.srcX, srcY, cellWidth: pieceSourceWidthPx, cellHeight: sourceHeightPx,
      dx: -pieceWidthPx / 2, dy: -destHeightPx / 2, dWidth: pieceWidthPx, dHeight: destHeightPx,
    });
    ctx.restore();
  };

  if (layer === 'object') {
    drawPiece(entry.srcY + (entry.tilesH - 1) * SOURCE_TILE_SIZE, SOURCE_TILE_SIZE, TILE_SIZE, baseRowScreenY);
  } else if (entry.tilesH > 1) {
    const overheadSourceHeightPx = (entry.tilesH - 1) * SOURCE_TILE_SIZE;
    const overheadDestHeightPx = (entry.tilesH - 1) * TILE_SIZE;
    drawPiece(entry.srcY, overheadSourceHeightPx, overheadDestHeightPx, baseRowScreenY - overheadDestHeightPx);
  }
}
