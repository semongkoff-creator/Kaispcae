import { CustomAssetEntry } from '@kaispace/shared';
import { PaletteEntry } from './tilePaletteManifest';
import { PALETTE_BY_ID } from './themeAssets';

// Fitur 15 — a room's uploaded custom Floor/Wall/Object assets. Unlike
// limezuInteriors.ts's lazy per-category fetch, these entries already travel
// inline with the room's own data (ROOM_STATE for normal play, editor-data
// for the Room Editor) — there's nothing to fetch, just register. Mutating
// PALETTE_BY_ID is the same established pattern loadLimezuCategory uses: it's
// the one shared registry every renderer (GameCanvas, mapRender, PieceThumb)
// already reads from, so once registered a custom entry behaves exactly like
// a built-in one.
export function registerCustomAssets(entries: CustomAssetEntry[] | undefined | null): void {
  if (!entries || entries.length === 0) return;
  for (const e of entries) {
    const entry: PaletteEntry = {
      id: e.id,
      label: e.label,
      // PaletteCategory has no 'wall'/'object' member — wall entries are
      // resolved via RoomTile.wallPaletteId directly (never through
      // `category`), and 'object' just needs any valid bucket since custom
      // Object entries get their own dedicated palette section, not the
      // built-in Furniture/Decor/Electronics tabs.
      category: e.category === 'floor' ? 'floor' : 'furniture',
      src: e.src,
      srcX: 0,
      srcY: 0,
      tilesW: e.tilesW,
      tilesH: e.tilesH,
      srcW: e.tilesW * 32,
      srcH: e.tilesH * 32,
    };
    PALETTE_BY_ID[entry.id] = entry;
  }
}
