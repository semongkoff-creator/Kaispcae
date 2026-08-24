import type { RoomTile, TileType } from './types/index';
import type { ImpassableAreaRect } from './mapLayers';

interface ZoneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Single source of truth for "can a player stand on this tile" — used by
// the client's own movement prediction (client/src/utils/createDefaultRoom.ts,
// which re-exports these) AND the server's authoritative validation
// (server/src/socket/movementHandler.ts). Previously only the client had
// this logic, so a modified/malicious client could report any x,y to
// PLAYER_MOVE and the server would broadcast it unquestioned (see the
// "Move" spec's explicit warning: movement must be server-authoritative).
export const BLOCKED_TILES: Set<TileType> = new Set(['wall', 'desk', 'chair', 'blocked']);

export function isTileBlocked(tiles: RoomTile[][], tileX: number, tileY: number): boolean {
  if (tileY < 0 || tileY >= tiles.length) return true;
  const row = tiles[tileY];
  if (!row || tileX < 0 || tileX >= row.length) return true;
  return BLOCKED_TILES.has(row[tileX].type);
}

// Item #9 (precise-collision follow-up) — the sub-tile counterpart to
// isTileBlocked above. A free-resized Impassable Area rectangle is never
// rasterized into the RoomTile grid (see mapLayers.ts's
// getImpassableAreaRects doc comment for why), so it needs its OWN
// collision check, done directly against pixel-space rectangles instead of
// discrete tiles. A single-point test — used for the server's "Door Area"
// locked-door gate (movementHandler.ts), where the target either has or
// hasn't crossed into the area, not for player-body collision. Movement/
// teleport collision against Impassable Areas uses the full-hitbox
// doesRectOverlapImpassableArea below instead (see movementHitboxBounds's
// own doc comment for why a plain point test isn't precise enough there).
export function isPointInImpassableArea(rects: ImpassableAreaRect[], x: number, y: number): boolean {
  for (const r of rects) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
  }
  return false;
}

export function doesRectOverlapImpassableArea(rects: ImpassableAreaRect[], left: number, top: number, right: number, bottom: number): boolean {
  for (const r of rects) {
    if (left < r.x + r.w && right > r.x && top < r.y + r.h && bottom > r.y) return true;
  }
  return false;
}

// Bug 7's narrower hitbox half-width while standing/arriving on a door tile
// (vs. the normal TILE_SIZE / 2 - 2 used everywhere else — see
// useMovement.ts's wouldCollide for the full doorway-alignment rationale).
// A raw literal, not derived from TILE_SIZE, so this file doesn't need a
// runtime import from types/index.ts (which re-exports FROM this file —
// importing TILE_SIZE back here would make that circular).
export const DOOR_HITBOX_HALF_PX = 6;

// The pixel-space box a player's hitbox occupies centered on (px, py), given
// its half-width (TILE_SIZE / 2 - 2 normally, DOOR_HITBOX_HALF_PX on a door
// tile — caller computes which, using its own already-imported TILE_SIZE).
// Factored out of wouldCollide so every caller that needs to test a
// candidate position against Impassable Area rectangles (not just the
// tile-grid loop, which still needs its own per-caller isBlocked callback)
// builds the exact same box rather than a second hand-rolled copy that could
// disagree at an edge — see git history, Item #9 follow-up ("kadang masih
// ada bug ... di atas impassible": the server's teleport/move validation
// used to test only the single target PIXEL against Impassable Area rects,
// not the player's actual hitbox, so a target just outside a rect's edge
// could pass validation while the rendered avatar still visually overlapped
// it).
export function movementHitboxBounds(px: number, py: number, half: number): { left: number; right: number; top: number; bottom: number } {
  return { left: px - half, right: px + half, top: py - half, bottom: py + half };
}

// Bug 7 — doorways are exactly one tile wide, embedded in a wall line, and
// the client's OWN movement hitbox (see useMovement.ts's wouldCollide) is
// nearly as wide as a tile — only ~2px of slack on each side — so lining
// up with a door meant being within a few pixels of dead-center on the
// perpendicular axis or the hitbox's edge clipped the wall tile right next
// to it. Used to shrink that hitbox specifically while standing on a door
// tile, without touching wall collision anywhere else (BLOCKED_TILES,
// isTileBlocked, and every other tile's hitbox size are untouched).
export function isDoorTile(tiles: RoomTile[][], tileX: number, tileY: number): boolean {
  const row = tiles[tileY];
  if (!row || tileX < 0 || tileX >= row.length) return false;
  return row[tileX]?.type === 'door';
}

// Picks a walkable tile inside a zone — used to auto-seed a Team Location
// (§4.1) for every named Zone in a room's own layout ("denah"), so staff
// get a ready-made teleport list instead of an empty one they'd have to
// fill in by walking to each spot manually. Tries the rect's center first
// (usually open floor); falls back to a row-major scan of the rect for any
// room whose center happens to land on furniture (e.g. a meeting table).
export function findZoneEntryTile(tiles: RoomTile[][], zone: ZoneRect): { x: number; y: number } {
  const centerX = zone.x + Math.floor(zone.width / 2);
  const centerY = zone.y + Math.floor(zone.height / 2);
  if (!isTileBlocked(tiles, centerX, centerY)) return { x: centerX, y: centerY };

  for (let y = zone.y; y < zone.y + zone.height; y++) {
    for (let x = zone.x; x < zone.x + zone.width; x++) {
      if (!isTileBlocked(tiles, x, y)) return { x, y };
    }
  }
  return { x: centerX, y: centerY }; // every real zone has floor somewhere; this is a last-resort fallback
}

// Picks a walkable tile immediately next to (tileX, tileY) — used to compute
// where a player should stand up to after teleporting straight into a seat
// via "My Seat" (client/src/hooks/useSocket.ts's PLAYER_TELEPORTED handler),
// which has no real "position they walked from" to return to the way an
// ordinary walk-up-and-sit does (see GameCanvas.tsx's performSit, which
// remembers the player's actual prior tile). Tries below first — this app's
// chair art and the server's teleport landing direction ('down') both put
// the open/seated side facing down — then the other three neighbors, so
// standing up always lands on real floor next to the seat instead of
// snapping back to some unrelated spot on the far side of the map.
export function findAdjacentFreeTile(tiles: RoomTile[][], tileX: number, tileY: number): { x: number; y: number } {
  const candidates = [
    { x: tileX, y: tileY + 1 },
    { x: tileX, y: tileY - 1 },
    { x: tileX - 1, y: tileY },
    { x: tileX + 1, y: tileY },
  ];
  for (const c of candidates) {
    if (!isTileBlocked(tiles, c.x, c.y)) return c;
  }
  return { x: tileX, y: tileY }; // no open neighbor (shouldn't happen for a real seat) — stand on the seat tile itself
}
