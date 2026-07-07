import { Avatar, RoomTheme, createDefaultOfficeLayout, findSpawnPixel, BLOCKED_TILES, isTileBlocked } from '@virtualmeet/shared';

// Re-exported for existing consumers (GameCanvas.tsx's movement collision
// check, App.tsx's minimap click-to-teleport handler) — the actual
// definition now lives in shared/tileCollision.ts so the server's
// movementHandler.ts can enforce the exact same rule authoritatively
// instead of only trusting client-reported positions.
export { BLOCKED_TILES, isTileBlocked };

// Default avatar colors for generated players
const AVATAR_COLORS = ['#ff6b6b', '#4ecdc4', '#ffe66d', '#a786df', '#6bcb77', '#4d96ff'];

/**
 * Generates the default "Main Office" room (see shared/defaultRoomLayout.ts
 * for the actual layout). This is the optimistic local room shown before
 * the server's real room:state arrives, so it must match what a
 * freshly-created room is seeded with server-side
 * (server/src/routes/rooms.ts), otherwise the layout would visibly change
 * the moment the real state lands.
 */
export function createDefaultRoom(id: string, name: string, theme: RoomTheme = 'modern-interiors') {
  const { tiles, furniture, zones } = createDefaultOfficeLayout(theme);

  // Place a default local player on the layout's actual spawn tile — not a
  // hardcoded guess, since a mismatch here would show the player standing
  // somewhere else entirely for the instant before the real room:state
  // (which the server computes via its own equivalent scan) arrives and
  // corrects it (see useSocket.ts's ROOM_STATE handler).
  const spawn = findSpawnPixel(tiles);
  const localPlayer: Avatar = {
    id: 'local',
    name: 'You',
    x: spawn.x,
    y: spawn.y,
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
