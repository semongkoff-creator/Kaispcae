// ZEP-style door password — per-socket, per-session unlock tracking.
//
// "Session" here means THIS socket connection: once a player enters the
// right password for a given door, that door stays open for them until they
// disconnect — a fresh reconnect (or a different tab/account) must solve it
// again, same as the room-lock knock allowlist elsewhere in this codebase.
// In-memory on purpose, exactly like that allowlist: it must not outlive a
// restart or leak across rooms, so the key is room-scoped (a door at the
// same x,y in a different room is a different door).

const unlockedDoors = new Map<string, Set<string>>(); // socketId -> Set of "room:x:y"

function key(room: string, x: number, y: number): string {
  return `${room}:${x}:${y}`;
}

export function isDoorUnlocked(socketId: string, room: string, x: number, y: number): boolean {
  return unlockedDoors.get(socketId)?.has(key(room, x, y)) ?? false;
}

export function unlockDoor(socketId: string, room: string, x: number, y: number): void {
  let set = unlockedDoors.get(socketId);
  if (!set) { set = new Set(); unlockedDoors.set(socketId, set); }
  set.add(key(room, x, y));
}

// Called on disconnect — a new connection (even the same account rejoining)
// starts with every password door locked again.
export function clearUnlockedDoors(socketId: string): void {
  unlockedDoors.delete(socketId);
}

// Called from handleLeave (roomHandler.ts) — same "revoke the instant they
// leave, for ANY reason" rule as the room-lock knock allowlist: leaving THIS
// room (LEAVE_ROOM, disconnect, or PLAYER_KICK) forgets only doors scoped to
// it, so re-entering later needs the password again. Only clears this room's
// entries — a socket that's somehow tracked across two rooms keeps the other.
export function clearUnlockedDoorsForRoom(socketId: string, room: string): void {
  const set = unlockedDoors.get(socketId);
  if (!set) return;
  const prefix = `${room}:`;
  for (const k of set) if (k.startsWith(prefix)) set.delete(k);
}

// "Door Area" — same per-socket, per-session unlock tracking as the
// tile-keyed functions above, deliberately reusing the SAME underlying map
// (key `${room}:area:${areaId}`, distinguishable from a tile key's
// `${room}:${x}:${y}` by the literal "area" segment) rather than a parallel
// Map — clearUnlockedDoors/clearUnlockedDoorsForRoom above already clear
// every key for a socket/room with no changes needed, since both still
// start with the same `${room}:` prefix.
function areaKey(room: string, areaId: string): string {
  return `${room}:area:${areaId}`;
}

export function isDoorAreaUnlocked(socketId: string, room: string, areaId: string): boolean {
  return unlockedDoors.get(socketId)?.has(areaKey(room, areaId)) ?? false;
}

export function unlockDoorArea(socketId: string, room: string, areaId: string): void {
  let set = unlockedDoors.get(socketId);
  if (!set) { set = new Set(); unlockedDoors.set(socketId, set); }
  set.add(areaKey(room, areaId));
}
