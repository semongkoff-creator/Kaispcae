import { Avatar } from '@kaispace/shared';

type LivePlayerMovement = Pick<Avatar, 'x' | 'y' | 'direction' | 'isMoving' | 'isRunning'>;

const liveMovementByRoom = new Map<string, Map<string, LivePlayerMovement>>();

function roomMovement(roomId: string): Map<string, LivePlayerMovement> {
  let room = liveMovementByRoom.get(roomId);
  if (!room) {
    room = new Map();
    liveMovementByRoom.set(roomId, room);
  }
  return room;
}

export function setLivePlayerMovement(roomId: string, playerId: string, movement: LivePlayerMovement): void {
  roomMovement(roomId).set(playerId, movement);
}

/**
 * What this player is actually doing right now, or undefined if still.
 *
 * The cached roster is NOT this: setPlayerMoved writes movement here and
 * returns a merged copy, deliberately leaving the stored roster untouched, so
 * a roster row's own isMoving stays false for a player's entire session. Any
 * code that asks the roster "is this person moving?" gets false forever.
 */
export function getLivePlayerMovement(roomId: string, playerId: string): LivePlayerMovement | undefined {
  return liveMovementByRoom.get(roomId)?.get(playerId);
}

export function clearLivePlayerMovement(roomId: string, playerId: string): void {
  const room = liveMovementByRoom.get(roomId);
  if (!room) return;
  room.delete(playerId);
  if (!room.size) liveMovementByRoom.delete(roomId);
}

export function mergeLivePlayerMovement(roomId: string, players: Avatar[]): Avatar[] {
  const room = liveMovementByRoom.get(roomId);
  if (!room?.size) return players;

  return players.map((player) => {
    const movement = room.get(player.id);
    return movement ? { ...player, ...movement } : player;
  });
}
