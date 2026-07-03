import { Avatar, RoomTile, TileType, Furniture, MAP_WIDTH, MAP_HEIGHT } from '@virtualmeet/shared';
import { TILE_PALETTE_BY_ID } from '@/data/tilePaletteManifest';

// Blocking tiles that the player cannot walk through
const BLOCKED_TILES: Set<TileType> = new Set(['wall', 'desk', 'chair']);

// Default avatar colors for generated players
const AVATAR_COLORS = ['#ff6b6b', '#4ecdc4', '#ffe66d', '#a786df', '#6bcb77', '#4d96ff'];

// Places a palette furniture piece and marks its base row as blocked, exactly
// like gameStore.addFurniture does — so the seeded demo room behaves the same
// as furniture placed live through the Room Editor.
function placeFurniture(tiles: RoomTile[][], furniture: Furniture[], paletteId: string, x: number, y: number) {
  const entry = TILE_PALETTE_BY_ID[paletteId];
  if (!entry) return;
  furniture.push({ id: `${paletteId}-${x}-${y}`, paletteId, x, y, tilesW: entry.tilesW, tilesH: entry.tilesH });
  for (let dx = 0; dx < entry.tilesW; dx++) {
    const tx = x + dx;
    if (tiles[y]?.[tx]) tiles[y][tx].type = 'desk';
  }
}

/**
 * Generates a default 30x20 room with:
 * - Walls on all borders, a door opening on the top wall
 * - Floor interior
 * - A row of desks (with a chair row behind each) and a few decorative
 *   furniture pieces, placed via the visual tile palette system
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

      // Door opening on the top wall at x=15
      if (x === 15 && y === 0) {
        type = 'door';
      }

      // Spawn point — where newly-joined players appear (see roomHandler.ts
      // findSpawnPixel, which scans the saved tilemap for this tile type)
      if (x === 3 && y === 3) {
        type = 'spawn';
      }

      row.push({ x, y, type });
    }
    tiles.push(row);
  }

  const furniture: Furniture[] = [];
  placeFurniture(tiles, furniture, 'desk-computer-a', 13, 10);
  placeFurniture(tiles, furniture, 'desk-basic', 14, 10);
  placeFurniture(tiles, furniture, 'desk-computer-b', 15, 10);
  placeFurniture(tiles, furniture, 'chair-office', 13, 12);
  placeFurniture(tiles, furniture, 'chair-office', 14, 12);
  placeFurniture(tiles, furniture, 'chair-office', 15, 12);
  placeFurniture(tiles, furniture, 'meeting-table', 21, 14);
  placeFurniture(tiles, furniture, 'wardrobe', 5, 6);
  placeFurniture(tiles, furniture, 'sofa-set', 21, 5);
  placeFurniture(tiles, furniture, 'plant-tall', 25, 5);
  placeFurniture(tiles, furniture, 'plant-small', 26, 10);

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
    players: [localPlayer],
    isBlocked: (tileX: number, tileY: number) => {
      if (tileX < 0 || tileX >= MAP_WIDTH || tileY < 0 || tileY >= MAP_HEIGHT) {
        return true;
      }
      return BLOCKED_TILES.has(tiles[tileY][tileX].type);
    },
  };
}
