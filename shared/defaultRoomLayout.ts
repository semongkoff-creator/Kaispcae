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

const MAP_WIDTH = 30;
const MAP_HEIGHT = 20;

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
  'plant-tall': { w: 1, h: 3 },
  'plant-small': { w: 1, h: 2 },
  'plant-potted': { w: 1, h: 3 },
  'pinboard': { w: 2, h: 2 },
};

// Same convention as gameStore.addFurniture / client's createDefaultRoom
// placeFurniture: the piece's base row tiles are marked type 'desk' purely
// so the existing collision system (BLOCKED_TILES has 'wall'/'desk'/'chair')
// blocks it — visual identity comes from paletteId, not tile type.
function placeFurniture(tiles: RoomTile[][], furniture: Furniture[], paletteId: string, x: number, y: number) {
  const size = FOOTPRINT[paletteId];
  if (!size) return;
  furniture.push({
    id: `${paletteId}-${x}-${y}`, paletteId, x, y, tilesW: size.w, tilesH: size.h,
    isInteractable: paletteId === 'chair-office' || undefined,
  });
  for (let dx = 0; dx < size.w; dx++) {
    const tx = x + dx;
    if (tiles[y]?.[tx]) tiles[y][tx].type = 'desk';
  }
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
 * Generates a 30x20 office with two separate walled desk rooms on the left
 * (joined by a 2-tile-wide corridor, not just open floor), and two small
 * enclosed rooms on the right (meeting room, lounge) reached through door
 * openings.
 *
 *   ┌───────────────┬┬───────────────┬─────────┐
 *   │               ││               │ MEETING │
 *   │  DESK ZONE A  ││  DESK ZONE B  ├─────────┤
 *   │               ││               │ LOUNGE  │
 *   │               ││               │         │
 *   └───────────────┴┴───────────────┴─────────┘
 *              ^corridor
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
  setTile(tiles, 15, 0, 'door');

  // Spawn point, in the open desk floor near the entrance
  setTile(tiles, 3, 3, 'spawn');

  // ── Desk zone partition: splits the left half into two separate rooms
  // (not just furniture floating on open floor), joined by a 2-tile-wide
  // corridor so it reads as a deliberate passage, not a random gap.
  for (let y = 1; y <= 18; y++) setTile(tiles, 10, y, 'wall');
  setTile(tiles, 10, 9, 'door');
  setTile(tiles, 10, 10, 'door');

  // ── Right-side partition: meeting room (top) + lounge (bottom) ──────
  // Left wall of both rooms (full height, y 1-18, so it actually meets the
  // top/bottom borders instead of leaving a gap at the last row)
  for (let y = 1; y <= 18; y++) setTile(tiles, 20, y, 'wall');
  // Wall separating meeting room from lounge, with a door between them
  for (let x = 20; x <= 28; x++) setTile(tiles, x, 9, 'wall');
  setTile(tiles, 24, 9, 'door');
  // Doors from the open desk floor into each room
  setTile(tiles, 20, 4, 'door');
  setTile(tiles, 20, 14, 'door');

  // Meeting room interior (x 21-28, y 1-8) — distinct carpet so it reads as
  // its own room even before the banner/zone kicks in
  setFloor(tiles, 21, 1, 28, 8, 'floor-maroon-carpet');

  // Lounge interior (x 21-28, y 10-18) — warm woven carpet, distinct from
  // the plain office floor everywhere else (floor-olive-carpet is actually
  // the SAME source texture as the default floor sprite, so it wouldn't
  // have read as a different area at all).
  setFloor(tiles, 21, 10, 28, 18, 'floor-brown-weave');

  // Desk Zone B gets a plain gray office tile so the two desk rooms read as
  // distinct spaces, not just a copy-pasted duplicate of Zone A.
  setFloor(tiles, 11, 1, 19, 18, 'floor-tile-gray');

  const furniture: Furniture[] = [];

  // Meeting room: table + two flanking chairs + a plant for polish
  placeFurniture(tiles, furniture, 'meeting-table', 23, 6);
  placeFurniture(tiles, furniture, 'chair-office', 22, 4);
  placeFurniture(tiles, furniture, 'chair-office', 26, 4);
  placeFurniture(tiles, furniture, 'plant-small', 27, 3);

  // Lounge: sofa + plants (kept clear of the y=9 partition wall above)
  placeFurniture(tiles, furniture, 'sofa-set', 22, 17);
  placeFurniture(tiles, furniture, 'plant-small', 26, 17);
  placeFurniture(tiles, furniture, 'plant-potted', 27, 13);

  // Desk Zone A (x 1-9, y 1-18): spawn area, one desk cluster, a wardrobe,
  // a plant in the otherwise-empty top-right corner.
  placeFurniture(tiles, furniture, 'desk-computer-a', 5, 5);
  placeFurniture(tiles, furniture, 'desk-basic', 6, 5);
  placeFurniture(tiles, furniture, 'desk-computer-c', 7, 5);
  placeFurniture(tiles, furniture, 'chair-office', 5, 7);
  placeFurniture(tiles, furniture, 'chair-office', 6, 7);
  placeFurniture(tiles, furniture, 'chair-office', 7, 7);
  placeFurniture(tiles, furniture, 'wardrobe', 2, 4);
  placeFurniture(tiles, furniture, 'plant-tall', 2, 16);
  placeFurniture(tiles, furniture, 'plant-potted', 8, 3);

  // Desk Zone B (x 11-19, y 1-18): a second desk cluster plus a combined
  // multi-desk cluster piece for variety, a pinboard (wall art) and a plant
  // in corners that were otherwise bare.
  placeFurniture(tiles, furniture, 'desk-computer-a', 13, 10);
  placeFurniture(tiles, furniture, 'desk-basic', 14, 10);
  placeFurniture(tiles, furniture, 'desk-computer-b', 15, 10);
  placeFurniture(tiles, furniture, 'chair-office', 13, 12);
  placeFurniture(tiles, furniture, 'chair-office', 14, 12);
  placeFurniture(tiles, furniture, 'chair-office', 15, 12);
  placeFurniture(tiles, furniture, 'desk-cluster-l', 16, 16);
  placeFurniture(tiles, furniture, 'plant-potted', 17, 3);
  placeFurniture(tiles, furniture, 'pinboard', 11, 4);
  placeFurniture(tiles, furniture, 'plant-small', 18, 10);

  const zones: Zone[] = [
    {
      id: 'default-meeting-room',
      name: 'Meeting Room',
      x: 21, y: 1, width: 8, height: 8,
      label: 'MEETING ROOM',
      color: '#7c3aed',
      type: 'meeting',
    },
  ];

  return { tiles, furniture, zones };
}
