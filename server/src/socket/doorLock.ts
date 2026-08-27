// ZEP-style door password — per-socket, per-session unlock tracking.
//
// "Session" here means THIS socket connection: once a player enters the
// right password for a given door, that door stays open for them until they
// disconnect — a fresh reconnect (or a different tab/account) must solve it
// again, same as the room-lock knock allowlist elsewhere in this codebase.
// In-memory on purpose, exactly like that allowlist: it must not outlive a
// restart or leak across rooms, so the key is room-scoped (a door at the
// same x,y in a different room is a different door).

import { RoomTile, DoorAreaRect, isPointInImpassableArea } from '@virtualmeet/shared';

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

// Bug fix — TELEPORT_REQUEST (roomHandler.ts) had no door-lock awareness at
// all, so a password door only stopped someone who WALKED up to it; a
// Team Location/bookmark placed anywhere past one skipped the password
// entirely. Extracted from movementHandler.ts's isBlockedForSocket (which
// still calls this) so the ONE door-lock predicate serves both regular
// movement and teleport, rather than drifting into two copies.
//
// Deliberately narrower than isBlockedForSocket — this checks ONLY door
// locks, not walls/impassable-areas/private-area occupancy, so a caller can
// tell "blocked because of a locked door" (which TELEPORT_REQUEST redirects
// around, matching a real locked door — you can't skip the password, but
// you're not refused outright either) apart from "blocked for any other
// reason" (which stays a flat refusal there).
//
// overrideActive is passed in rather than imported — isDoorOverrideActive
// lives in roomHandler.ts, which itself imports FROM this file
// (unlockDoor/unlockDoorArea/clearUnlockedDoorsForRoom); importing it back
// here would be circular.
export function isDoorLockedForSocket(
  socketId: string,
  room: string,
  tiles: RoomTile[][],
  tileX: number,
  tileY: number,
  pixelX: number,
  pixelY: number,
  doorAreas: DoorAreaRect[],
  overrideActive: boolean,
): boolean {
  // Item #9 — emergency override lets everyone through every door in this
  // room, bypassing the normal per-socket unlock entirely.
  if (overrideActive) return false;
  const tile = tiles[tileY]?.[tileX];
  if (tile?.type === 'door' && tile.doorPasswordEnabled && tile.doorPassword) {
    return !isDoorUnlocked(socketId, room, tileX, tileY);
  }
  // "Door Area" — the resizable-area sibling of the per-tile check above.
  // Reuses isPointInImpassableArea AS-IS (same pixel-space rect shape) against
  // only the subset of door areas that are actually still locked for THIS
  // socket — an unlocked one is simply left out of the list.
  const lockedDoorAreas = doorAreas.filter((r) => r.doorPasswordEnabled && r.doorPassword && !isDoorAreaUnlocked(socketId, room, r.id));
  return lockedDoorAreas.length > 0 && isPointInImpassableArea(lockedDoorAreas, pixelX, pixelY);
}

// Meeting Zone password (CalendarEvent.meetkaiPassword) — same per-socket,
// per-session unlock tracking, reusing the SAME underlying map as the door
// functions above (key `${room}:zonepw:${zoneId}`, distinguishable from a
// tile key's `${room}:${x}:${y}` and an area key's `${room}:area:${id}` by
// the literal "zonepw" segment). clearUnlockedDoors/clearUnlockedDoorsForRoom
// above already clear this with no changes needed — both still start with
// the same `${room}:` prefix.
function zonePasswordKey(room: string, zoneId: string): string {
  return `${room}:zonepw:${zoneId}`;
}

export function isZonePasswordUnlocked(socketId: string, room: string, zoneId: string): boolean {
  return unlockedDoors.get(socketId)?.has(zonePasswordKey(room, zoneId)) ?? false;
}

export function unlockZonePassword(socketId: string, room: string, zoneId: string): void {
  let set = unlockedDoors.get(socketId);
  if (!set) { set = new Set(); unlockedDoors.set(socketId, set); }
  set.add(zonePasswordKey(room, zoneId));
}
