// Visual tile palette for the "Sci-Fi Office" room theme, sourced from
// client/public/assets/tilesets/scifi-office/ (Space Station 14 assets,
// CC-BY-SA 3.0 — see that folder's ATTRIBUTION.md and the Credits section in
// Lobby.tsx). Parallel to tilePaletteManifest.ts's TILE_PALETTE (the default
// "Modern Interiors" theme) — same PaletteEntry shape, so both themes render
// through the exact same GameCanvas.tsx/RoomEditor.tsx code paths.
//
// This is the curated "quick recommendation" starting set from that folder's
// ASSETS_README.md (10 items), not all 208 asset groups — see that file for
// the full catalog if more get added later.
//
// Every entry crops the (0, 0, 32, 32) cell of its state's PNG — the state's
// static "down-facing, first frame" image, always at that offset regardless
// of the state's actual full pixel size (see client/src/utils/rsiSprite.ts
// for why). srcW/srcH below are each file's own real dimensions, confirmed
// by inspecting the PNGs directly (Python PIL, not guessed) — needed so
// RoomEditor.tsx's thumbnail crop math doesn't assume the LimeZu tileset's
// fixed 64x96 padded-canvas convention.

import { PaletteCategory, PaletteEntry } from './tilePaletteManifest';

const BASE = '/assets/tilesets/scifi-office';

function rsi(folder: string, state: string): string {
  return `${BASE}/${folder}.rsi/${state}.png`;
}

function entry(
  id: string,
  label: string,
  category: PaletteCategory,
  src: string,
  srcW: number,
  srcH: number,
  extra?: Partial<PaletteEntry>,
): PaletteEntry {
  return { id, label, category, src, srcX: 0, srcY: 0, tilesW: 1, tilesH: 1, srcW, srcH, ...extra };
}

export const SCIFI_OFFICE_PALETTE: PaletteEntry[] = [
  // ── Floor textures ────────────────────────────────────────────────
  // Tiles/*.png aren't .rsi folders (no meta.json/states) — some pack a few
  // random-variant swatches side by side (steel.png is 128x32, four 32x32
  // variants); we only take the first (leftmost) variant for a consistent
  // single texture, same "render first frame only" policy as animated states.
  entry('sf-floor-steel', 'Steel Floor', 'floor', `${BASE}/Tiles/steel.png`, 128, 32),
  entry('sf-floor-carpet', 'Office Carpet', 'floor', `${BASE}/Tiles/carpetoffice.png`, 32, 32),

  // ── Furniture ──────────────────────────────────────────────────────
  entry('sf-desk', 'Sci-Fi Desk', 'furniture', rsi('Furniture/Tables/generic', 'state_0'), 64, 64),
  entry('sf-chair-white', 'Office Chair (White)', 'furniture', rsi('Furniture/chairs', 'office-white'), 64, 64, { sittable: true }),
  entry('sf-chair-dark', 'Office Chair (Dark)', 'furniture', rsi('Furniture/chairs', 'office-dark'), 64, 64, { sittable: true }),
  entry('sf-plant', 'Potted Plant', 'furniture', rsi('Furniture/potted_plants', 'plant-01'), 32, 32),
  // Furniture/potted_plants.rsi ships 30 distinct states (plant-01..30) —
  // these 3 extra picks give the layout generator (defaultRoomLayout.ts)
  // real plant variety instead of stamping the same plant-01 look
  // everywhere, matching modern-interiors' 3 visually-distinct plant roles
  // (plant-tall/plant-small/plant-potted).
  entry('sf-plant-b', 'Potted Plant (B)', 'furniture', rsi('Furniture/potted_plants', 'plant-08'), 32, 32),
  entry('sf-plant-c', 'Potted Plant (C)', 'furniture', rsi('Furniture/potted_plants', 'plant-15'), 32, 32),
  entry('sf-plant-d', 'Potted Plant (D)', 'furniture', rsi('Furniture/potted_plants', 'plant-24'), 32, 32),

  // ── Electronics ────────────────────────────────────────────────────
  entry('sf-computer', 'Computer', 'electronics', rsi('Machines/computers', 'computer'), 64, 64),
  entry('sf-server', 'Server Rack', 'electronics', rsi('Machines/server', 'server'), 32, 32),
  entry('sf-arcade', 'Arcade Machine', 'electronics', rsi('Machines/arcade', 'arcade'), 64, 64),
  entry('sf-jukebox', 'Jukebox', 'electronics', rsi('Machines/jukebox', 'on'), 32, 32),
  entry('sf-fridge', 'Smart Fridge', 'electronics', rsi('Machines/smartfridge', 'smartfridge'), 32, 32),
];

export const SCIFI_OFFICE_PALETTE_BY_ID: Record<string, PaletteEntry> = Object.fromEntries(
  SCIFI_OFFICE_PALETTE.map((e) => [e.id, e]),
);
