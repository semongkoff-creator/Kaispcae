// Theme → asset-set lookup tables, the single place GameCanvas.tsx and
// RoomEditor.tsx go to find "which art do I draw for this room". Adding a
// future theme means adding one entry to each map below — nothing else in
// this file, or its callers, needs to change per-theme special-casing.

import { RoomTheme, TileType } from '@virtualmeet/shared';
import { PaletteEntry, TILE_PALETTE, TILE_PALETTE_BY_ID } from './tilePaletteManifest';
import { SCIFI_OFFICE_PALETTE, SCIFI_OFFICE_PALETTE_BY_ID } from './scifiOfficePaletteManifest';

// Base folder for each theme's asset set — informational (every actual path
// used below/elsewhere is already fully-qualified in the two palette
// manifests + THEME_TILE_SPRITES), kept here so it's obvious at a glance
// where a theme's files live on disk when adding a new one.
export const THEME_ASSET_PATHS: Record<RoomTheme, { base: string }> = {
  'modern-interiors': { base: '/assets/tilesets/modern-office' },
  'scifi-office': { base: '/assets/tilesets/scifi-office' },
};

// Placeable furniture/floor/decor/electronics palette, keyed by theme — feeds
// RoomEditor.tsx's palette panel and GameCanvas.tsx's furniture renderer.
export const PALETTE_BY_THEME: Record<RoomTheme, PaletteEntry[]> = {
  'modern-interiors': TILE_PALETTE,
  'scifi-office': SCIFI_OFFICE_PALETTE,
};

// Every palette entry across every theme, merged by id. Palette ids are
// globally unique (scifi-office entries are all prefixed "sf-"), so a single
// merged lookup is simpler and just as correct as threading the room's
// current theme through every furniture-by-id call site — once a piece is
// placed, its paletteId alone is enough to find its art regardless of which
// theme's palette it was placed from.
export const PALETTE_BY_ID: Record<string, PaletteEntry> = {
  ...TILE_PALETTE_BY_ID,
  ...SCIFI_OFFICE_PALETTE_BY_ID,
};

export interface TileSpriteDef {
  src: string;
  srcX: number;
  srcY: number;
}

const OFFICE_SINGLES = '/assets/tilesets/modern-office/Modern_Office_Singles_32x32';
const ROOM_BUILDER_OFFICE = '/assets/tilesets/modern-office/Room_Builder_Office_32x32.png';
const SCIFI_BASE = '/assets/tilesets/scifi-office';

// See GameCanvas.tsx's original TILE_SPRITES comment for how these
// modern-interiors crops were verified (alpha-channel bounding-box scan, not
// guessed) — unchanged from before theming existed.
const MODERN_INTERIORS_FLOOR: TileSpriteDef = { src: `${OFFICE_SINGLES}/Modern_Office_Singles_32x32_86.png`, srcX: 0, srcY: 64 };

const MODERN_INTERIORS_TILE_SPRITES: Record<TileType, TileSpriteDef> = {
  floor: MODERN_INTERIORS_FLOOR,
  wall: { src: ROOM_BUILDER_OFFICE, srcX: 0, srcY: 10 * 32 },
  door: { src: ROOM_BUILDER_OFFICE, srcX: 8 * 32, srcY: 0 * 32 },
  desk: { src: `${OFFICE_SINGLES}/Modern_Office_Singles_32x32_211.png`, srcX: 0, srcY: 64 },
  chair: { src: `${OFFICE_SINGLES}/Modern_Office_Singles_32x32_101.png`, srcX: 0, srcY: 64 },
  portal: MODERN_INTERIORS_FLOOR,
  spawn: MODERN_INTERIORS_FLOOR,
  blocked: MODERN_INTERIORS_FLOOR, // invisible impassable — never drawn (see GameCanvas)
};

// Sci-fi office generic tile sprites — used for the room's underlying
// wall/floor/door/desk/chair TileTypes (as opposed to placed Furniture,
// which renders through PALETTE_BY_ID above). Every crop is (0,0,32,32) —
// each state's static "down-facing, first frame" cell, see rsiSprite.ts.
const SCIFI_OFFICE_FLOOR: TileSpriteDef = { src: `${SCIFI_BASE}/Tiles/steel.png`, srcX: 0, srcY: 0 };

const SCIFI_OFFICE_TILE_SPRITES: Record<TileType, TileSpriteDef> = {
  floor: SCIFI_OFFICE_FLOOR,
  wall: { src: `${SCIFI_BASE}/Walls/solid.rsi/solid0.png`, srcX: 0, srcY: 0 },
  door: { src: `${SCIFI_BASE}/Doors/Airlocks/Standard/basic.rsi/closed.png`, srcX: 0, srcY: 0 },
  desk: { src: `${SCIFI_BASE}/Furniture/Tables/generic.rsi/state_0.png`, srcX: 0, srcY: 0 },
  chair: { src: `${SCIFI_BASE}/Furniture/chairs.rsi/office-white.png`, srcX: 0, srcY: 0 },
  portal: SCIFI_OFFICE_FLOOR,
  spawn: SCIFI_OFFICE_FLOOR,
  blocked: SCIFI_OFFICE_FLOOR, // invisible impassable — never drawn (see GameCanvas)
};

export const THEME_TILE_SPRITES: Record<RoomTheme, Record<TileType, TileSpriteDef>> = {
  'modern-interiors': MODERN_INTERIORS_TILE_SPRITES,
  'scifi-office': SCIFI_OFFICE_TILE_SPRITES,
};
