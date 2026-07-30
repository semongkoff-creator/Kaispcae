import { Avatar, RoomTheme, RoomTemplateId, createRoomLayoutFromTemplate, findSpawnPixel, BLOCKED_TILES, isTileBlocked, isDoorTile } from '@virtualmeet/shared';

// Re-exported for existing consumers (GameCanvas.tsx's movement collision
// check, App.tsx's minimap click-to-teleport handler) — the actual
// definition now lives in shared/tileCollision.ts so the server's
// movementHandler.ts can enforce the exact same rule authoritatively
// instead of only trusting client-reported positions.
export { BLOCKED_TILES, isTileBlocked, isDoorTile };

// Default avatar colors for generated players
const AVATAR_COLORS = ['#ff6b6b', '#4ecdc4', '#ffe66d', '#a786df', '#6bcb77', '#4d96ff'];

/**
 * Generates a room from one of shared/defaultRoomLayout.ts's ROOM_TEMPLATES.
 * Two callers: App.tsx's optimistic local room shown before the server's
 * real room:state arrives (now gated behind gameStore.ts's
 * roomStateReceived so this mismatching the real room's actual template
 * only matters for a moment, not a visible flash — see that flag's doc
 * comment), and RoomEditor.tsx's "Reset to Default", which passes the
 * room's own actual template so resetting doesn't silently discard it.
 */
export function createDefaultRoom(templateId: RoomTemplateId, name: string, theme: RoomTheme = 'scifi-office') {
  const { tiles, furniture, zones } = createRoomLayoutFromTemplate(templateId, theme);

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
    id: templateId,
    name,
    tiles,
    furniture,
    zones,
    players: [localPlayer],
    isBlocked: (tileX: number, tileY: number) => isTileBlocked(tiles, tileX, tileY),
  };
}
