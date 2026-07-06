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

export type PaletteCategory = 'floor' | 'furniture' | 'decor' | 'electronics';

export interface PaletteEntry {
  id: string;
  label: string;
  category: PaletteCategory;
  src: string;
  srcX: number;
  srcY: number;
  tilesW: number;
  tilesH: number;
  // Chairs a player can sit in (see Furniture.isInteractable / the sit
  // feature in GameCanvas.tsx) — set automatically when this entry is
  // placed, not a Room Editor toggle.
  sittable?: boolean;
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
  // Verified seamless the same way as the entries above (rendered a 4x4
  // repeat against a magenta background before adding).
  { id: 'floor-tile-gray', label: 'Gray Office Tile', category: 'floor', src: single(88), srcX: 0, srcY: 64, tilesW: 1, tilesH: 1 },
  { id: 'floor-brown-weave', label: 'Brown Woven Carpet', category: 'floor', src: single(89), srcX: 0, srcY: 64, tilesW: 1, tilesH: 1 },

  // ── Furniture (multi-cell, bottom-anchored) ───────────────────────
  // `sittable: true` on chair entries drives the sit-down interaction (see
  // GameCanvas.tsx) — every other field here works exactly as before.
  { id: 'chair-office', label: 'Office Chair', category: 'furniture', src: single(101), srcX: 0, srcY: 32, tilesW: 1, tilesH: 2, sittable: true },
  { id: 'desk-basic', label: 'Desk', category: 'furniture', src: single(211), srcX: 0, srcY: 32, tilesW: 1, tilesH: 2 },
  { id: 'desk-computer-a', label: 'Desk w/ Monitor', category: 'furniture', src: single(109), srcX: 0, srcY: 32, tilesW: 1, tilesH: 2 },
  { id: 'desk-computer-b', label: 'Desk w/ Laptop', category: 'furniture', src: single(270), srcX: 0, srcY: 32, tilesW: 1, tilesH: 2 },
  { id: 'desk-computer-c', label: 'Desk w/ Printer', category: 'furniture', src: single(307), srcX: 0, srcY: 32, tilesW: 1, tilesH: 2 },
  { id: 'desk-cluster-l', label: 'Desk Cluster (L)', category: 'furniture', src: single(249), srcX: 0, srcY: 32, tilesW: 2, tilesH: 2 },
  { id: 'desk-cluster-b', label: 'Desk Cluster (B)', category: 'furniture', src: single(300), srcX: 0, srcY: 32, tilesW: 2, tilesH: 2 },
  { id: 'meeting-table', label: 'Meeting Table', category: 'furniture', src: single(205), srcX: 0, srcY: 32, tilesW: 2, tilesH: 2 },
  { id: 'wardrobe', label: 'Wardrobe', category: 'furniture', src: single(195), srcX: 0, srcY: 0, tilesW: 2, tilesH: 3 },
  { id: 'sofa-set', label: 'Sofa Set', category: 'furniture', src: single(201), srcX: 0, srcY: 0, tilesW: 2, tilesH: 3 },
  { id: 'sofa-blue', label: 'Blue Sofa', category: 'furniture', src: single(196), srcX: 0, srcY: 32, tilesW: 1, tilesH: 2 },
  { id: 'sofa-gray', label: 'Gray Sofa', category: 'furniture', src: single(197), srcX: 0, srcY: 32, tilesW: 1, tilesH: 2 },
  { id: 'pinboard', label: 'Pinboard', category: 'furniture', src: single(164), srcX: 0, srcY: 32, tilesW: 2, tilesH: 2 },
  { id: 'plant-tall', label: 'Tall Plant', category: 'furniture', src: single(98), srcX: 0, srcY: 0, tilesW: 1, tilesH: 3 },
  { id: 'plant-small', label: 'Small Plant', category: 'furniture', src: single(99), srcX: 0, srcY: 32, tilesW: 1, tilesH: 2 },
  { id: 'plant-potted', label: 'Potted Plant', category: 'furniture', src: single(100), srcX: 0, srcY: 0, tilesW: 1, tilesH: 3 },

  // ── Decor (pictures, art, small accents) ──────────────────────────
  // Bounding boxes for everything below were computed programmatically
  // (draw each source file to a canvas, scan alpha channel for the true
  // opaque region) rather than eyeballed — same rigor as the floor/wall
  // fixes earlier, to avoid re-introducing the "sliver crop" class of bug.
  { id: 'picture-portrait-a', label: 'Portrait Photo', category: 'decor', src: single(157), srcX: 0, srcY: 64, tilesW: 1, tilesH: 1 },
  { id: 'picture-portrait-b', label: 'Portrait Photo (B)', category: 'decor', src: single(159), srcX: 0, srcY: 64, tilesW: 1, tilesH: 1 },
  { id: 'picture-frame-tall', label: 'Framed Photo', category: 'decor', src: single(156), srcX: 0, srcY: 32, tilesW: 1, tilesH: 2 },
  { id: 'picture-abstract', label: 'Abstract Art', category: 'decor', src: single(163), srcX: 0, srcY: 32, tilesW: 1, tilesH: 1 },
  { id: 'picture-landscape', label: 'Landscape Art', category: 'decor', src: single(164), srcX: 0, srcY: 32, tilesW: 2, tilesH: 2 },
  { id: 'picture-map', label: 'Wall Map', category: 'decor', src: single(171), srcX: 0, srcY: 32, tilesW: 2, tilesH: 2 },
  { id: 'wall-frame-a', label: 'Small Frame', category: 'decor', src: single(96), srcX: 0, srcY: 32, tilesW: 1, tilesH: 2 },
  { id: 'wall-frame-b', label: 'Small Frame (B)', category: 'decor', src: single(97), srcX: 0, srcY: 32, tilesW: 1, tilesH: 2 },
  { id: 'desk-lamp', label: 'Desk Lamp', category: 'decor', src: single(237), srcX: 0, srcY: 64, tilesW: 1, tilesH: 1 },

  // ── Electronics ────────────────────────────────────────────────────
  { id: 'printer', label: 'Printer', category: 'electronics', src: single(166), srcX: 0, srcY: 64, tilesW: 2, tilesH: 1 },
  { id: 'tv-monitor', label: 'TV / Monitor', category: 'electronics', src: single(170), srcX: 0, srcY: 32, tilesW: 2, tilesH: 2 },
  { id: 'electronics-console', label: 'AV Console', category: 'electronics', src: single(240), srcX: 0, srcY: 64, tilesW: 2, tilesH: 1 },
  { id: 'electronics-small', label: 'Small Device', category: 'electronics', src: single(241), srcX: 0, srcY: 64, tilesW: 1, tilesH: 1 },
];

export const TILE_PALETTE_BY_ID: Record<string, PaletteEntry> = Object.fromEntries(
  TILE_PALETTE.map((entry) => [entry.id, entry]),
);
