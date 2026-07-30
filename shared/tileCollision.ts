import type { RoomTile, TileType } from './types/index';

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
