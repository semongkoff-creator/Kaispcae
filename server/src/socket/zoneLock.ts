import { Server, Socket } from 'socket.io';
import { SocketEvents, ZoneLockState } from '@kaispace/shared';
import { getPlayerName } from './roomHandler';
import { getPrisma } from '../lib/prisma';

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

// Potongan A2 — one pending knock per requester (a new knock from the same
// socket replaces whatever it was already waiting on, same "clear before
// set" convention roomHandler.ts's pendingSummons already uses). Tracked
// server-side — not just relayed and forgotten — so a requester can Cancel,
// and so a disconnect/unlock on either side resolves it instead of leaving
// a phantom "waiting for approval" screen with no way to close it.
interface PendingKnock {
  zoneId: string;
  zoneName: string;
  keyholderSocketId: string;
  requesterUserId: string;
}

// room slug → requester's socket id → pending knock
const pendingKnocks = new Map<string, Map<string, PendingKnock>>();

function roomKnocks(room: string): Map<string, PendingKnock> {
  let m = pendingKnocks.get(room);
  if (!m) { m = new Map(); pendingKnocks.set(room, m); }
  return m;
}

// Every pending knock on this zone is moot — the keyholder decided (handled
// by its own caller), the zone unlocked, or its keyholder disconnected.
// Drops the bookkeeping and tells each pending requester's keyholder-side
// card to disappear (reusing ZONE_KNOCK_CANCELLED — same UI effect as an
// explicit Cancel from the client's point of view).
function clearPendingKnocksForZone(io: Server, room: string, zoneId: string): void {
  const m = roomKnocks(room);
  for (const [requesterSocketId, k] of m) {
    if (k.zoneId !== zoneId) continue;
    m.delete(requesterSocketId);
    io.to(k.keyholderSocketId).emit(SocketEvents.ZONE_KNOCK_CANCELLED, { zoneId, userId: k.requesterUserId });
  }
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

// Who currently holds this zone's key, if any — used by summon (roomHandler.ts's
// SUMMON_RESPOND) to verify server-side that a summon claiming to come "from
// the keyholder" really does, before letting it bypass the lock. Never trust
// a client's own claim of who summoned whom; this is the same lockedByUserId
// mayEnterZone already checks, just exposed for a caller outside this file.
export function zoneKeyholderOf(room: string, zoneId: string): string | undefined {
  return roomLocks(room).get(zoneId)?.lockedByUserId;
}

// Admits a user into a locked zone without them having knocked — the
// keyholder-summon path's equivalent of ZONE_KNOCK_DECIDE's admit branch.
// Same allowedUserIds list, same effect (mayEnterZone + the client's own
// isAdmitted mirror both start passing for this user), just a different
// trigger. No-ops if the zone isn't actually locked (nothing to admit into).
export function admitUserToZone(room: string, zoneId: string, userId: string): void {
  roomLocks(room).get(zoneId)?.allowedUserIds.add(userId);
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

  socket.on(SocketEvents.JOIN_ROOM, async (roomId: string) => {
    const slug = roomId || 'main-office';
    // Multi-tenant Fase 3 — this module registers its own independent
    // JOIN_ROOM listener (see mediaHandler.ts's comment on why roomHandler.ts
    // rejecting a cross-org join doesn't stop this one from also running).
    try {
      const room = await getPrisma().room.findUnique({ where: { slug }, select: { organizationId: true } });
      if (!room || room.organizationId !== (socket.data as { organizationId?: string }).organizationId) { currentRoom = null; return; }
    } catch (e) {
      console.error('[zoneLock] org check failed:', e);
      currentRoom = null;
      return;
    }
    currentRoom = slug;
    // Late joiner catches up on which zones are shut.
    socket.emit(SocketEvents.ZONE_LOCK_UPDATED, { zones: zoneLockStates(currentRoom) });

    // Item #2 — re-sync "you're already admitted" on (re)join. allowedUserIds
    // itself was ALREADY correctly persistent (keyed by userId, survives a
    // walk-out/reconnect, cleared only by unlock-then-relock) — the actual
    // gap was that this was never told to a client joining fresh, whose own
    // admittedZoneIds (useZoneLock.ts) starts empty every mount and has no
    // other way to learn it. Reuses ZONE_KNOCK_DECIDED as-is (no new event,
    // no client changes) — the same admitted:true a knock-approval sends.
    // Skipped for the keyholder themselves: isKeyholder() already covers
    // their case independently, this would just be a redundant no-op signal.
    const uid = userId();
    if (uid) {
      for (const [zoneId, lock] of roomLocks(currentRoom)) {
        if (lock.lockedByUserId !== uid && lock.allowedUserIds.has(uid)) {
          socket.emit(SocketEvents.ZONE_KNOCK_DECIDED, { zoneId, admitted: true, byName: lock.lockedByName });
        }
      }
    }
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
      // A2 — unlocking resolves any knock still waiting on this zone: there's
      // nothing left to approve/reject, so the keyholder's own card(s) for
      // it should disappear rather than linger pointed at a door that's now
      // wide open.
      clearPendingKnocksForZone(io, currentRoom, data.zoneId);
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

    // Tracked (not just relayed) so it can later be resolved from three
    // different directions: the keyholder decides, this requester cancels,
    // or either side disconnects/the zone unlocks first. One pending knock
    // per requester — a fresh knock replaces whatever they were already
    // waiting on, same convention as roomHandler.ts's pendingSummons.
    roomKnocks(currentRoom).set(socket.id, {
      zoneId: data.zoneId,
      zoneName: data.zoneName ?? data.zoneId,
      keyholderSocketId: lock.lockedBySocketId,
      requesterUserId: uid,
    });

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
    // Resolved — no longer pending (a stale Cancel arriving after this would
    // otherwise still find an entry and misfire a cancellation to the
    // keyholder for a knock that was already decided).
    roomKnocks(currentRoom).delete(data.playerId);
    io.to(data.playerId).emit(SocketEvents.ZONE_KNOCK_DECIDED, {
      zoneId: data.zoneId,
      admitted: !!data.admit,
      byName: lock.lockedByName,
    });
  });

  // A2 — the requester backs out before the keyholder ever decides. Only
  // their OWN pending knock, matched by this socket's id — nobody can cancel
  // someone else's.
  socket.on(SocketEvents.ZONE_KNOCK_CANCEL, (data: { zoneId: string }) => {
    if (!currentRoom || typeof data?.zoneId !== 'string') return;
    const m = roomKnocks(currentRoom);
    const pending = m.get(socket.id);
    if (!pending || pending.zoneId !== data.zoneId) return;
    m.delete(socket.id);
    io.to(pending.keyholderSocketId).emit(SocketEvents.ZONE_KNOCK_CANCELLED, { zoneId: pending.zoneId, userId: pending.requesterUserId });
  });

  socket.on(SocketEvents.DISCONNECT, () => {
    if (!currentRoom) return;
    // The keyholder left → the zone unlocks. Leaving a room permanently shut
    // because someone closed their laptop would need an admin override that
    // nobody would remember exists.
    const m = roomLocks(currentRoom);
    let changed = false;
    for (const [zoneId, lock] of m) {
      if (lock.lockedBySocketId === socket.id) {
        m.delete(zoneId);
        changed = true;
        // A2 — same reasoning as the explicit-unlock branch above: nothing
        // left to approve for this zone now that it's open again.
        clearPendingKnocksForZone(io, currentRoom, zoneId);
      }
    }
    if (changed) io.to(currentRoom).emit(SocketEvents.ZONE_LOCK_UPDATED, { zones: zoneLockStates(currentRoom) });

    // A2 — this socket's OWN pending knock (as requester, not keyholder) is
    // now moot too — tell the keyholder to drop that card.
    const km = roomKnocks(currentRoom);
    const myPending = km.get(socket.id);
    if (myPending) {
      km.delete(socket.id);
      io.to(myPending.keyholderSocketId).emit(SocketEvents.ZONE_KNOCK_CANCELLED, { zoneId: myPending.zoneId, userId: myPending.requesterUserId });
    }
  });
}
