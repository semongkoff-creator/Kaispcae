import { Avatar, TileType, MAP_WIDTH, MAP_HEIGHT, createDefaultOfficeLayout } from '@virtualmeet/shared';

// Blocking tiles that the player cannot walk through
const BLOCKED_TILES: Set<TileType> = new Set(['wall', 'desk', 'chair']);

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
    isBlocked: (tileX: number, tileY: number) => {
      if (tileX < 0 || tileX >= MAP_WIDTH || tileY < 0 || tileY >= MAP_HEIGHT) {
        return true;
      }
      return BLOCKED_TILES.has(tiles[tileY][tileX].type);
    },
  };
}
