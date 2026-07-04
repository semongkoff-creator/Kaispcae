// Visual tile palette for the Room Editor, sourced from
// client/public/assets/tilesets/modern-office/Modern_Office_Singles_32x32.
//
// Every file in that folder is exported on a fixed 64x96 (2x3 tile) canvas
// with the real artwork bottom-anchored inside it — a 1x1 floor swatch sits
// in the bottom-right 32x32 cell, a tall wardrobe fills the whole canvas,
// etc. srcX/srcY/tilesW/tilesH below were derived by scanning each file's
// alpha channel for its true bounding box and snapping to the 32px grid
// (see scratchpad singles_bbox.json from the Tahap 3 investigation) — they
// are NOT arbitrary guesses.
//
// tilesW x tilesH is the piece's visual footprint. Furniture pieces are
// anchored at their bottom-left tile: the bottom tile row renders on the
// "object" layer (before avatars) and occupies collision; any rows above
// that render on the "overhead" layer (after avatars) so players can walk
// visually behind tall pieces.

export type PaletteCategory = 'floor' | 'furniture';

export interface PaletteEntry {
  id: string;
  label: string;
  category: PaletteCategory;
  src: string;
  srcX: number;
  srcY: number;
  tilesW: number;
  tilesH: number;
}

const SINGLES_BASE = '/assets/tilesets/modern-office/Modern_Office_Singles_32x32';

function single(file: number): string {
  return `${SINGLES_BASE}/Modern_Office_Singles_32x32_${file}.png`;
}

export const TILE_PALETTE: PaletteEntry[] = [
  // ── Floor textures (1x1) ──────────────────────────────────────────
  // Only entries whose bounding box was verified (by rendering the crop
  // against a magenta background) to fill the FULL 32x32 cell with no
  // transparent margin are listed here. Singles_6/28/40 all looked like
  // plausible floor swatches in a quick contact-sheet glance but turned out
  // to have partial-cell content (a thin sliver, or a few px inset on one
  // edge) that tiles into visible seams/gaps — dropped rather than shipping
  // a texture that's subtly broken when repeated across a whole room.
  // gray/lavender's own texture has an asymmetric left/right edge, so tiling
  // them repeatedly (rendered a 4x4 block to confirm) draws a visible line
  // down every tile boundary — a property of the source art, not the crop.
  // Still usable if that grid look is wanted; olive/maroon tile seamlessly.
  { id: 'floor-gray', label: 'Gray Floor (visible grid seam)', category: 'floor', src: single(36), srcX: 0, srcY: 64, tilesW: 1, tilesH: 1 },
  { id: 'floor-lavender', label: 'Lavender Carpet (visible grid seam)', category: 'floor', src: single(70), srcX: 0, srcY: 64, tilesW: 1, tilesH: 1 },
  { id: 'floor-olive-carpet', label: 'Olive Carpet', category: 'floor', src: single(86), srcX: 0, srcY: 64, tilesW: 1, tilesH: 1 },
  { id: 'floor-maroon-carpet', label: 'Maroon Carpet', category: 'floor', src: single(90), srcX: 0, srcY: 64, tilesW: 1, tilesH: 1 },

  // ── Furniture (multi-cell, bottom-anchored) ───────────────────────
  { id: 'chair-office', label: 'Office Chair', category: 'furniture', src: single(101), srcX: 0, srcY: 32, tilesW: 1, tilesH: 2 },
  { id: 'desk-basic', label: 'Desk', category: 'furniture', src: single(211), srcX: 0, srcY: 32, tilesW: 1, tilesH: 2 },
  { id: 'desk-computer-a', label: 'Desk w/ Monitor', category: 'furniture', src: single(109), srcX: 0, srcY: 32, tilesW: 1, tilesH: 2 },
  { id: 'desk-computer-b', label: 'Desk w/ Laptop', category: 'furniture', src: single(270), srcX: 0, srcY: 32, tilesW: 1, tilesH: 2 },
  { id: 'desk-computer-c', label: 'Desk w/ Printer', category: 'furniture', src: single(307), srcX: 0, srcY: 32, tilesW: 1, tilesH: 2 },
  { id: 'desk-cluster-l', label: 'Desk Cluster (L)', category: 'furniture', src: single(249), srcX: 0, srcY: 32, tilesW: 2, tilesH: 2 },
  { id: 'desk-cluster-b', label: 'Desk Cluster (B)', category: 'furniture', src: single(300), srcX: 0, srcY: 32, tilesW: 2, tilesH: 2 },
  { id: 'meeting-table', label: 'Meeting Table', category: 'furniture', src: single(205), srcX: 0, srcY: 32, tilesW: 2, tilesH: 2 },
  { id: 'wardrobe', label: 'Wardrobe', category: 'furniture', src: single(195), srcX: 0, srcY: 0, tilesW: 2, tilesH: 3 },
  { id: 'sofa-set', label: 'Sofa Set', category: 'furniture', src: single(201), srcX: 0, srcY: 0, tilesW: 2, tilesH: 3 },
  { id: 'pinboard', label: 'Pinboard', category: 'furniture', src: single(164), srcX: 0, srcY: 32, tilesW: 2, tilesH: 2 },
  { id: 'plant-tall', label: 'Tall Plant', category: 'furniture', src: single(98), srcX: 0, srcY: 0, tilesW: 1, tilesH: 3 },
  { id: 'plant-small', label: 'Small Plant', category: 'furniture', src: single(99), srcX: 0, srcY: 32, tilesW: 1, tilesH: 2 },
  { id: 'plant-potted', label: 'Potted Plant', category: 'furniture', src: single(100), srcX: 0, srcY: 0, tilesW: 1, tilesH: 3 },
];

export const TILE_PALETTE_BY_ID: Record<string, PaletteEntry> = Object.fromEntries(
  TILE_PALETTE.map((entry) => [entry.id, entry]),
);
