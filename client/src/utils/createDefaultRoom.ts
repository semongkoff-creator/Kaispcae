import { Avatar, RoomTile, TileType, MAP_WIDTH, MAP_HEIGHT } from '@virtualmeet/shared';

// Color mapping per tile type
const TILE_COLORS: Record<TileType, string> = {
  floor: '#e8d5b0',
  wall: '#4a3728',
  door: '#d4a056',
  desk: '#8B6914',
  chair: '#5b8dd9',
};

// Blocking tiles that the player cannot walk through
const BLOCKED_TILES: Set<TileType> = new Set(['wall', 'desk', 'chair']);

// Default avatar colors for generated players
const AVATAR_COLORS = ['#ff6b6b', '#4ecdc4', '#ffe66d', '#a786df', '#6bcb77', '#4d96ff'];

/**
 * Generates a default 30x20 room with:
 * - Walls on all borders
 * - Floor interior
 * - A 3x2 desk cluster roughly centered
 * - A circle of chairs in the bottom-right quadrant
 */
export function createDefaultRoom(id: string, name: string) {
  const tiles: RoomTile[][] = [];

  for (let y = 0; y < MAP_HEIGHT; y++) {
    const row: RoomTile[] = [];
    for (let x = 0; x < MAP_WIDTH; x++) {
      let type: TileType = 'floor';

      // Border walls
      if (x === 0 || y === 0 || x === MAP_WIDTH - 1 || y === MAP_HEIGHT - 1) {
        type = 'wall';
      }

      // Desk cluster in the center: a 3x2 area
      // Center is at (15, 10) for a 30x20 grid, we place 3x2 around it
      const deskStartX = 14;
      const deskStartY = 9;
      if (x >= deskStartX && x < deskStartX + 3 && y >= deskStartY && y < deskStartY + 2) {
        type = 'desk';
      }

      // Door opening on the top wall at x=15
      if (x === 15 && y === 0) {
        type = 'door';
      }

      // Chairs in a circle in the bottom-right quadrant
      // Circle center at (22, 15), radius ~3 tiles
      const chairCenterX = 22;
      const chairCenterY = 15;
      const dx = x - chairCenterX;
      const dy = y - chairCenterY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= 2.5 && dist <= 3.5) {
        type = 'chair';
      }

      row.push({ x, y, type });
    }
    tiles.push(row);
  }

  // Place a default local player near the top-left interior
  const localPlayer: Avatar = {
    id: 'local',
    name: 'You',
    x: 80, // pixels: tile 3 * 32 + half tile offset
    y: 64,
    direction: 'down',
    color: AVATAR_COLORS[0],
    isMoving: false,
  };

  return {
    id,
    name,
    tiles,
    players: [localPlayer],
    isBlocked: (tileX: number, tileY: number) => {
      if (tileX < 0 || tileX >= MAP_WIDTH || tileY < 0 || tileY >= MAP_HEIGHT) {
        return true;
      }
      return BLOCKED_TILES.has(tiles[tileY][tileX].type);
    },
  };
}
