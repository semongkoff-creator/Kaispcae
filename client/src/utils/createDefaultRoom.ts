import { Avatar, RoomTile, TileType, createDefaultOfficeLayout } from '@virtualmeet/shared';

// Blocking tiles that the player cannot walk through
export const BLOCKED_TILES: Set<TileType> = new Set(['wall', 'desk', 'chair']);

// Shared with GameCanvas.tsx's own movement collision check and the minimap
// click-to-teleport handler (App.tsx) — anywhere a target tile needs
// validating before moving/placing the player there uses this exact rule,
// so a minimap click can't drop someone into a wall/desk tile that normal
// WASD movement would never let them walk into in the first place.
export function isTileBlocked(tiles: RoomTile[][], tileX: number, tileY: number): boolean {
  if (tileY < 0 || tileY >= tiles.length) return true;
  const row = tiles[tileY];
  if (!row || tileX < 0 || tileX >= row.length) return true;
  return BLOCKED_TILES.has(row[tileX].type);
}

// Default avatar colors for generated players
const AVATAR_COLORS = ['#ff6b6b', '#4ecdc4', '#ffe66d', '#a786df', '#6bcb77', '#4d96ff'];

/**
 * Generates the default 30x20 office room (see shared/defaultRoomLayout.ts
 * for the actual layout — walls, desk clusters, meeting room, lounge). This
 * is the optimistic local room shown before the server's real room:state
 * arrives, so it must match what a freshly-created room is seeded with
 * server-side (server/src/routes/rooms.ts), otherwise the layout would
 * visibly change the moment the real state lands.
 */
export function createDefaultRoom(id: string, name: string) {
  const { tiles, furniture, zones } = createDefaultOfficeLayout();

  // Place a default local player on the spawn tile
  const localPlayer: Avatar = {
    id: 'local',
    name: 'You',
    x: 3 * 32 + 16,
    y: 3 * 32 + 16,
    direction: 'down',
    color: AVATAR_COLORS[0],
    isMoving: false,
  };

  return {
    id,
    name,
    tiles,
    furniture,
    zones,
    players: [localPlayer],
    isBlocked: (tileX: number, tileY: number) => isTileBlocked(tiles, tileX, tileY),
  };
}
