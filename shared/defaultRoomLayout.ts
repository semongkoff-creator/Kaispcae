import { MAP_WIDTH, MAP_HEIGHT } from './types/index';
import type { RoomTile, Furniture, Zone, TileType } from './types/index';

// Default office layout used to seed a brand-new room's tilemapData/
// furniture/zones (see server/src/routes/rooms.ts) so a room looks like an
// actual office from the moment it's created, instead of an empty floor.
// Kept here (not client-only) so both the server (room creation) and the
// client (optimistic local room shown before the server round-trip
// completes, see client/src/utils/createDefaultRoom.ts) generate the exact
// same layout.
//
// Palette ids referenced below (desk-*, chair-office, meeting-table,
// sofa-set, wardrobe, plant-*) come from
// client/src/data/tilePaletteManifest.ts — this file only needs their id +
// footprint (tilesW/tilesH), not the actual sprite crop rects, so it stays
// free of any client-only rendering concerns.

// Mirrors the tilesW/tilesH of each palette id used below (see
// client/src/data/tilePaletteManifest.ts — kept in sync manually since this
// package has no dependency on the client's asset manifest).
const FOOTPRINT: Record<string, { w: number; h: number }> = {
  'chair-office': { w: 1, h: 2 },
  'desk-basic': { w: 1, h: 2 },
  'desk-computer-a': { w: 1, h: 2 },
  'desk-computer-b': { w: 1, h: 2 },
  'desk-computer-c': { w: 1, h: 2 },
  'desk-cluster-l': { w: 2, h: 2 },
  'meeting-table': { w: 2, h: 2 },
  'wardrobe': { w: 2, h: 3 },
  'sofa-set': { w: 2, h: 3 },
  'sofa-blue': { w: 1, h: 2 },
  'sofa-gray': { w: 1, h: 2 },
  'plant-tall': { w: 1, h: 3 },
  'plant-small': { w: 1, h: 2 },
  'plant-potted': { w: 1, h: 3 },
  'pinboard': { w: 2, h: 2 },
};

// Palette ids a player can sit on (see Furniture.isInteractable / the sit
// feature in GameCanvas.tsx) — mirrors the `sittable: true` entries in
// client/src/data/tilePaletteManifest.ts, kept in sync manually since this
// package has no dependency on the client's asset manifest (same reasoning
// as FOOTPRINT above).
const SITTABLE_PALETTE_IDS = new Set(['chair-office', 'sofa-set', 'sofa-blue', 'sofa-gray']);

// Same convention as gameStore.addFurniture / client's createDefaultRoom
// placeFurniture: the piece's base row tiles are marked type 'desk' purely
// so the existing collision system (BLOCKED_TILES has 'wall'/'desk'/'chair')
// blocks it — visual identity comes from paletteId, not tile type.
function placeFurniture(tiles: RoomTile[][], furniture: Furniture[], paletteId: string, x: number, y: number) {
  const size = FOOTPRINT[paletteId];
  if (!size) return;
  furniture.push({
    id: `${paletteId}-${x}-${y}`, paletteId, x, y, tilesW: size.w, tilesH: size.h,
    isInteractable: SITTABLE_PALETTE_IDS.has(paletteId) || undefined,
  });
  for (let dx = 0; dx < size.w; dx++) {
    const tx = x + dx;
    if (tiles[y]?.[tx]) tiles[y][tx].type = 'desk';
  }
}

// Places a full row of desks with a matching row of chairs two tiles below
// (leaving a walking gap in between), alternating desk variants for visual
// variety. Returns the number of desks placed.
function placeDeskRow(
  tiles: RoomTile[][],
  furniture: Furniture[],
  startX: number,
  deskY: number,
  chairY: number,
  count: number,
): number {
  const variants = ['desk-computer-a', 'desk-basic', 'desk-computer-c', 'desk-basic', 'desk-computer-b'];
  for (let i = 0; i < count; i++) {
    const x = startX + i;
    placeFurniture(tiles, furniture, variants[i % variants.length], x, deskY);
    placeFurniture(tiles, furniture, 'chair-office', x, chairY);
  }
  return count;
}

function setTile(tiles: RoomTile[][], x: number, y: number, type: TileType) {
  if (tiles[y]?.[x]) tiles[y][x].type = type;
}

function setFloor(tiles: RoomTile[][], x0: number, y0: number, x1: number, y1: number, floorPaletteId: string) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (tiles[y]?.[x]) tiles[y][x].floorPaletteId = floorPaletteId;
    }
  }
}

/**
 * Generates a 42x28 office sized for ~20 concurrent occupants: two desk
 * zones with 10 individually-seated desks each (2 rows of 5), plus an
 * enclosed meeting room and a lounge on the right, mirroring the original
 * 6-desk/30x20 layout's structure just scaled up to fit real team sizes.
 *
 *   ┌───────────────────┬┬───────────────────┬───────────┐
 *   │                   ││                   │  MEETING  │
 *   │    DESK ZONE A    ││    DESK ZONE B    ├───────────┤
 *   │     (10 desks)    ││     (10 desks)    │   LOUNGE  │
 *   │                   ││                   │           │
 *   └───────────────────┴┴───────────────────┴───────────┘
 *                  ^corridor
 *
 * Only the meeting room gets a Zone: zones give everyone inside them full
 * proximity audio/video regardless of distance (see useProximity.ts), which
 * is exactly the "meeting room" semantic, but would be wrong for the desk
 * rooms or the lounge — wrapping those in a zone too would silently change
 * how proximity works there instead of just changing the layout.
 */
export function createDefaultOfficeLayout(): { tiles: RoomTile[][]; furniture: Furniture[]; zones: Zone[] } {
  const tiles: RoomTile[][] = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const row: RoomTile[] = [];
    for (let x = 0; x < MAP_WIDTH; x++) {
      row.push({ x, y, type: 'floor' });
    }
    tiles.push(row);
  }

  // Outer border walls
  for (let x = 0; x < MAP_WIDTH; x++) {
    setTile(tiles, x, 0, 'wall');
    setTile(tiles, x, MAP_HEIGHT - 1, 'wall');
  }
  for (let y = 0; y < MAP_HEIGHT; y++) {
    setTile(tiles, 0, y, 'wall');
    setTile(tiles, MAP_WIDTH - 1, y, 'wall');
  }

  // Main entrance on the top wall
  setTile(tiles, 21, 0, 'door');

  // Spawn point, in the open desk floor near the entrance
  setTile(tiles, 3, 3, 'spawn');

  // ── Desk zone partition: splits the left area into two separate rooms
  // (not just furniture floating on open floor), joined by a 2-tile-wide
  // corridor so it reads as a deliberate passage, not a random gap.
  for (let y = 1; y <= 26; y++) setTile(tiles, 14, y, 'wall');
  setTile(tiles, 14, 13, 'door');
  setTile(tiles, 14, 14, 'door');

  // ── Right-side partition: meeting room (top) + lounge (bottom) ──────
  // Left wall of both rooms (full height, y 1-26, so it actually meets the
  // top/bottom borders instead of leaving a gap at the last row)
  for (let y = 1; y <= 26; y++) setTile(tiles, 29, y, 'wall');
  // Wall separating meeting room from lounge, with a door between them
  for (let x = 29; x <= 40; x++) setTile(tiles, x, 14, 'wall');
  setTile(tiles, 34, 14, 'door');
  // Doors from the open desk floor into each room
  setTile(tiles, 29, 6, 'door');
  setTile(tiles, 29, 20, 'door');

  // Meeting room interior (x 30-40, y 1-13) — distinct carpet so it reads as
  // its own room even before the banner/zone kicks in
  setFloor(tiles, 30, 1, 40, 13, 'floor-maroon-carpet');

  // Lounge interior (x 30-40, y 15-26) — warm woven carpet, distinct from
  // the plain office floor everywhere else (floor-olive-carpet is actually
  // the SAME source texture as the default floor sprite, so it wouldn't
  // have read as a different area at all).
  setFloor(tiles, 30, 15, 40, 26, 'floor-brown-weave');

  // Desk Zone B gets a plain gray office tile so the two desk rooms read as
  // distinct spaces, not just a copy-pasted duplicate of Zone A.
  setFloor(tiles, 15, 1, 28, 26, 'floor-tile-gray');

  const furniture: Furniture[] = [];

  // Meeting room: table + four chairs around it + plants for polish
  placeFurniture(tiles, furniture, 'meeting-table', 34, 7);
  placeFurniture(tiles, furniture, 'chair-office', 32, 5);
  placeFurniture(tiles, furniture, 'chair-office', 36, 5);
  placeFurniture(tiles, furniture, 'chair-office', 32, 10);
  placeFurniture(tiles, furniture, 'chair-office', 36, 10);
  placeFurniture(tiles, furniture, 'plant-small', 39, 3);
  placeFurniture(tiles, furniture, 'plant-potted', 31, 12);

  // Lounge: three seating pieces (sofa-set + two single sofas) instead of
  // just one, since it's now meant to comfortably fit a handful of people
  // taking a break at once, not just 1-2.
  placeFurniture(tiles, furniture, 'sofa-set', 32, 19);
  placeFurniture(tiles, furniture, 'sofa-blue', 37, 17);
  placeFurniture(tiles, furniture, 'sofa-gray', 39, 17);
  placeFurniture(tiles, furniture, 'plant-small', 37, 24);
  placeFurniture(tiles, furniture, 'plant-potted', 31, 24);

  // Desk Zone A (x 1-13, y 1-26): 10 individually-seated desks in two rows
  // of 5, plus a wardrobe/plants for polish. Spawn sits in the open area
  // above the first desk row.
  placeDeskRow(tiles, furniture, 3, 6, 8, 5);
  placeDeskRow(tiles, furniture, 3, 16, 18, 5);
  placeFurniture(tiles, furniture, 'wardrobe', 11, 4);
  placeFurniture(tiles, furniture, 'plant-tall', 2, 23);
  placeFurniture(tiles, furniture, 'plant-potted', 11, 23);

  // Desk Zone B (x 15-28, y 1-26): a second 10-desk block, mirrored, with
  // its own pinboard/plants so it doesn't read as a copy-pasted duplicate.
  placeDeskRow(tiles, furniture, 17, 6, 8, 5);
  placeDeskRow(tiles, furniture, 17, 16, 18, 5);
  placeFurniture(tiles, furniture, 'pinboard', 16, 4);
  placeFurniture(tiles, furniture, 'plant-small', 27, 3);
  placeFurniture(tiles, furniture, 'plant-potted', 16, 23);
  placeFurniture(tiles, furniture, 'plant-small', 27, 23);

  const zones: Zone[] = [
    {
      id: 'default-meeting-room',
      name: 'Meeting Room',
      x: 30, y: 1, width: 11, height: 13,
      label: 'MEETING ROOM',
      color: '#7c3aed',
      type: 'meeting',
    },
  ];

  return { tiles, furniture, zones };
}
