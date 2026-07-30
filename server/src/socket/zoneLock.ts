import { Server, Socket } from 'socket.io';
import { SocketEvents, ZoneLockState } from '@virtualmeet/shared';
import { getPlayerName } from './roomHandler';

// Per-ZONE lock — "we're in a meeting, don't walk in".
//
// Deliberately NOT the same thing as the room lock in roomHandler.ts:
//   room lock  = the front door of the map, admin-controlled
//   zone lock  = the door of one meeting area, controlled by whoever locked it
// They are independent gates; neither overrides the other.
//
// The keyholder is the person who locked it — not an admin. That's the whole
// point: someone in a meeting shouldn't have to find an admin to keep the
// meeting private, and an admin shouldn't be able to wave themselves in
// silently (they can still see the zone is locked, and still knock).
//
// In-memory on purpose, exactly like the room lock: a zone lock means "right
// now, in this session". It must not outlive a restart, or a meeting from
// last week would keep a room shut with nobody able to open it.

interface ZoneLock {
  lockedByUserId: string;
  lockedByName: string;
  lockedBySocketId: string;
  // Users the keyholder has admitted. Built ONLY by admit decisions on the
  // server — a client can never send this.
  allowedUserIds: Set<string>;
}

// room slug → zoneId → lock
const locks = new Map<string, Map<string, ZoneLock>>();

function roomLocks(room: string): Map<string, ZoneLock> {
  let m = locks.get(room);
  if (!m) { m = new Map(); locks.set(room, m); }
  return m;
}

export function isZoneLocked(room: string, zoneId: string): boolean {
  return roomLocks(room).has(zoneId);
}

// May this user be inside this zone? The keyholder and anyone they admitted.
export function mayEnterZone(room: string, zoneId: string, userId: string | undefined): boolean {
  const lock = roomLocks(room).get(zoneId);
  if (!lock) return true;
  if (!userId) return false; // an unauthenticated guest can't be on an admit list
  return lock.lockedByUserId === userId || lock.allowedUserIds.has(userId);
}

function stateOf(room: string, zoneId: string): ZoneLockState {
  const lock = roomLocks(room).get(zoneId);
  return lock
    ? { zoneId, locked: true, lockedByUserId: lock.lockedByUserId, lockedByName: lock.lockedByName }
    : { zoneId, locked: false };
}

// Every zone lock currently held in a room — sent to a client on join so a
// late arrival sees the padlocks immediately.
export function zoneLockStates(room: string): ZoneLockState[] {
  return [...roomLocks(room).keys()].map((zoneId) => stateOf(room, zoneId));
}

// The lock seals the door BOTH ways: while a zone is locked, EVERYONE inside
// — including the keyholder — stays put until it's unlocked. A keyholder
// exception was tried earlier and turned out to read as "the lock doesn't
// actually work": the person who locked the room could just walk out through
// their own supposedly-shut door. To leave, the keyholder unlocks first (the
// same "Kunci <zona>" toggle they used to lock it), then walks out — one
// extra step, but a locked door that only some people can open from either
// side isn't a locked door.
//
// The safety valve is the keyholder's disconnect (see DISCONNECT below), which
// unlocks the zone: without it, one closed laptop would trap everyone.
export function isSealedIn(room: string, zoneId: string): boolean {
  return roomLocks(room).has(zoneId);
}

// Is this user shut inside a locked zone right now? Used by follow and summon
// to refuse hauling someone out of a locked meeting — a lock that stops people
// walking in but lets an admin teleport its occupants away isn't a lock.
export function isUserInLockedZone(room: string, userId: string | undefined, zoneIdOfUser: string | null | undefined): boolean {
  if (!zoneIdOfUser || !userId) return false;
  return roomLocks(room).has(zoneIdOfUser);
}

export function registerZoneLockHandlers(io: Server, socket: Socket): void {
  let currentRoom: string | null = null;
  const userId = (): string | undefined => socket.data.userId as string | undefined;

  socket.on(SocketEvents.JOIN_ROOM, (roomId: string) => {
    currentRoom = roomId || 'main-office';
    // Late joiner catches up on which zones are shut.
    socket.emit(SocketEvents.ZONE_LOCK_UPDATED, { zones: zoneLockStates(currentRoom) });
  });

  socket.on(SocketEvents.ZONE_LOCK_SET, (data: { zoneId: string; locked: boolean; zoneName?: string }) => {
    if (!currentRoom || typeof data?.zoneId !== 'string') return;
    const uid = userId();
    // Anonymous sockets can't hold a key: an admit list keyed by nothing
    // would let anyone through after a reconnect.
    if (!uid) return;

    const m = roomLocks(currentRoom);
    const existing = m.get(data.zoneId);

    if (data.locked) {
      // Already locked by someone else → refuse rather than steal the key.
      if (existing && existing.lockedByUserId !== uid) {
        socket.emit(SocketEvents.ZONE_LOCKED_DENIED, { zoneId: data.zoneId, reason: 'already_locked', lockedByName: existing.lockedByName });
        return;
      }
      m.set(data.zoneId, {
        lockedByUserId: uid,
        lockedByName: getPlayerName(socket.id) ?? 'Seseorang',
        lockedBySocketId: socket.id,
        allowedUserIds: existing?.allowedUserIds ?? new Set(),
      });
    } else {
      // Only the keyholder may unlock. Not an admin, not a passer-by.
      if (existing && existing.lockedByUserId !== uid) {
        socket.emit(SocketEvents.ZONE_LOCKED_DENIED, { zoneId: data.zoneId, reason: 'not_keyholder', lockedByName: existing.lockedByName });
        return;
      }
      m.delete(data.zoneId);
    }
    io.to(currentRoom).emit(SocketEvents.ZONE_LOCK_UPDATED, { zones: zoneLockStates(currentRoom) });
  });

  // Someone bounced off a locked zone asks to be let in.
  socket.on(SocketEvents.ZONE_KNOCK, (data: { zoneId: string; zoneName?: string }) => {
    if (!currentRoom || typeof data?.zoneId !== 'string') return;
    const lock = roomLocks(currentRoom).get(data.zoneId);
    if (!lock) return; // not locked (any more) — nothing to knock on
    const uid = userId();
    if (!uid) return;
    if (mayEnterZone(currentRoom, data.zoneId, uid)) return; // already allowed

    // The knock goes to the KEYHOLDER only — not to every admin, and not to
    // everyone in the zone.
    io.to(lock.lockedBySocketId).emit(SocketEvents.ZONE_KNOCK_REQUEST, {
      zoneId: data.zoneId,
      zoneName: data.zoneName ?? data.zoneId,
      userId: uid,
      playerId: socket.id,
      playerName: getPlayerName(socket.id) ?? 'Seseorang',
    });
  });

  socket.on(SocketEvents.ZONE_KNOCK_DECIDE, (data: { zoneId: string; userId: string; playerId: string; admit: boolean }) => {
    if (!currentRoom || typeof data?.zoneId !== 'string' || typeof data?.userId !== 'string') return;
    const lock = roomLocks(currentRoom).get(data.zoneId);
    if (!lock) return;
    // Re-checked server-side: only the keyholder decides. A client that fakes
    // this event on someone else's zone gets nothing.
    if (lock.lockedByUserId !== userId()) return;

    if (data.admit) lock.allowedUserIds.add(data.userId);
    io.to(data.playerId).emit(SocketEvents.ZONE_KNOCK_DECIDED, {
      zoneId: data.zoneId,
      admitted: !!data.admit,
      byName: lock.lockedByName,
    });
  });

  socket.on(SocketEvents.DISCONNECT, () => {
    if (!currentRoom) return;
    // The keyholder left → the zone unlocks. Leaving a room permanently shut
    // because someone closed their laptop would need an admin override that
    // nobody would remember exists.
    const m = roomLocks(currentRoom);
    let changed = false;
    for (const [zoneId, lock] of m) {
      if (lock.lockedBySocketId === socket.id) { m.delete(zoneId); changed = true; }
    }
    if (changed) io.to(currentRoom).emit(SocketEvents.ZONE_LOCK_UPDATED, { zones: zoneLockStates(currentRoom) });
  });
}
