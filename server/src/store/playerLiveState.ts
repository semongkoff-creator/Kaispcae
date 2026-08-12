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
