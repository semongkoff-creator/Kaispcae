import { Server, Socket } from 'socket.io';
import { SocketEvents, SeatClaimState, SeatClaimRequest } from '@kaispace/shared';
import { getPlayerName } from './roomHandler';
import { getCachedTiles } from '../store/roomStore';
import { getPrisma } from '../lib/prisma';

// Claimable-seat ownership — "this seat is mine".
//
// The seat MARKER itself (id, position) is admin-authored data living in
// Room.layerData (see mapLayers.ts's TileEffect 'claimableSeat', edited via
// the Room Editor). This file is the OTHER half: who currently owns each
// marker. In-memory only (never written to the DB, so it doesn't outlive a
// server restart — same caveat as every other in-memory admin/lock state in
// this codebase), but WITHIN a server's lifetime a claim is a standing
// grant, not a session-scoped lock: it survives disconnects, reconnects,
// and leaving/re-entering the room entirely. QA item #6 — this used to
// auto-release on disconnect ("owner disconnects → seat auto-releases"),
// but that meant a brief wifi drop or even just walking out of the room
// silently lost someone their claimed desk. The only way to free a seat now
// is the owner explicitly releasing it (RELEASE_SEAT), or approving someone
// else's SEAT_CLAIM_REQUEST below — CLAIM_SEAT itself still only ever
// redirects a blocked claimant to the nearest free seat, never displaces
// the existing owner on its own.
interface SeatClaim {
  userId: string;
  name: string;
}

// room slug → seatId → claim
const claims = new Map<string, Map<string, SeatClaim>>();

function roomClaims(room: string): Map<string, SeatClaim> {
  let m = claims.get(room);
  if (!m) { m = new Map(); claims.set(room, m); }
  return m;
}

// A request to take over someone else's seat, waiting on that OWNER's own
// decision — same single-keyholder-decides shape as zoneLock.ts's
// pendingKnocks, and resolved from the exact same three directions: the
// owner decides, the requester cancels, or either side disconnects.
interface PendingSeatRequest {
  seatId: string;
  ownerSocketId: string;
  ownerName: string;
  requesterUserId: string;
  requesterName: string;
}

// room slug → requester's socket id → pending request. Keyed by requester,
// same "a fresh request replaces whatever they were already waiting on"
// convention as pendingKnocks — but unlike a zone (one keyholder), nothing
// stops two DIFFERENT people from requesting the SAME seat at once; the
// owner just sees a card for each.
const pendingSeatRequests = new Map<string, Map<string, PendingSeatRequest>>();

function roomSeatRequests(room: string): Map<string, PendingSeatRequest> {
  let m = pendingSeatRequests.get(room);
  if (!m) { m = new Map(); pendingSeatRequests.set(room, m); }
  return m;
}

// Finds the live socket (if any) for a given account userId within a room —
// same lookup recordingHandler.ts's own findSocketByUserId does, duplicated
// locally rather than shared since it's a three-line loop, not shared state.
function findSocketByUserId(io: Server, room: string, uid: string): string | undefined {
  const roomSockets = io.sockets.adapter.rooms.get(room);
  if (!roomSockets) return undefined;
  for (const sid of roomSockets) {
    const s = io.sockets.sockets.get(sid);
    if ((s?.data as { userId?: string })?.userId === uid) return sid;
  }
  return undefined;
}

// A seatId is only valid if it corresponds to a marker the admin actually
// placed. Checked against the same tile cache movementHandler.ts uses for
// collision — no DB round-trip, and it can't be spoofed by a client
// inventing an id that was never stamped in the editor.
function seatExists(room: string, seatId: string): boolean {
  return allSeatMarkers(room).some((m) => m.seatId === seatId);
}

interface SeatMarker { seatId: string; x: number; y: number }

function allSeatMarkers(room: string): SeatMarker[] {
  const tiles = getCachedTiles(room);
  if (!tiles) return [];
  const out: SeatMarker[] = [];
  for (let y = 0; y < tiles.length; y++) {
    const row = tiles[y];
    for (let x = 0; x < (row?.length ?? 0); x++) {
      const id = row[x]?.claimableSeatId;
      if (id) out.push({ seatId: id, x, y });
    }
  }
  return out;
}

// Nearest UNCLAIMED seat to the one someone just tried (and failed) to
// claim — used so a taken desk redirects to the next-best one instead of a
// dead-end "sudah diklaim" toast. Distance is plain tile distance; there's
// no table/desk-cluster grouping in this marker system (see the doc comment
// above), so "physically nearest" is the closest thing to "same area".
function nearestFreeSeat(room: string, fromSeatId: string): string | null {
  const markers = allSeatMarkers(room);
  const from = markers.find((m) => m.seatId === fromSeatId);
  if (!from) return null;
  const taken = roomClaims(room);
  let best: SeatMarker | null = null;
  let bestDist = Infinity;
  for (const m of markers) {
    if (m.seatId === fromSeatId || taken.has(m.seatId)) continue;
    const d = Math.hypot(m.x - from.x, m.y - from.y);
    if (d < bestDist) { bestDist = d; best = m; }
  }
  return best?.seatId ?? null;
}

function assignSeat(room: string, seatId: string, uid: string, name: string): void {
  const m = roomClaims(room);
  // One seat per user: claiming a new one frees whichever one they held.
  for (const [sid, c] of m) {
    if (c.userId === uid) m.delete(sid);
  }
  m.set(seatId, { userId: uid, name });
}

function claimStates(room: string): SeatClaimState[] {
  return [...roomClaims(room).entries()].map(([seatId, c]) => ({ seatId, userId: c.userId, name: c.name }));
}

// Bug fix — a claimed seat previously had no bearing on where its owner
// spawns on refresh/rejoin at all; only the separate, ALSO in-memory
// `lastKnownPosition` (roomStore.ts) happened to coincidentally land them
// back there, and only if they were standing exactly on the seat the
// moment they disconnected. Exported so roomHandler.ts's JOIN_ROOM spawn
// logic can give a claimed seat its own real priority tier, the same way
// findAssignedSeat's admin-granted desk already does. Still in-memory only
// (see this file's own top doc comment) — a server restart clears claims
// the same way it clears lastKnownPosition, so this closes the common
// "refresh mid-session" case, not "after the server itself restarted".
export function getClaimedSeatPosition(room: string, uid: string): { x: number; y: number } | null {
  for (const [seatId, c] of roomClaims(room)) {
    if (c.userId === uid) {
      const marker = allSeatMarkers(room).find((m) => m.seatId === seatId);
      return marker ? { x: marker.x, y: marker.y } : null;
    }
  }
  return null;
}

export function registerSeatClaimHandlers(io: Server, socket: Socket): void {
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
      console.error('[seatClaim] org check failed:', e);
      currentRoom = null;
      return;
    }
    currentRoom = slug;
    // Late joiner catches up on who's sitting where.
    socket.emit(SocketEvents.SEAT_CLAIMS_UPDATED, { claims: claimStates(currentRoom) });
  });

  socket.on(SocketEvents.CLAIM_SEAT, (data: { seatId: string }) => {
    if (!currentRoom || typeof data?.seatId !== 'string') return;
    const uid = userId();
    // Anonymous sockets can't own a seat: ownership keyed by nothing would
    // let anyone through after a reconnect.
    if (!uid) return;

    if (!seatExists(currentRoom, data.seatId)) return; // spoofed/stale id — ignore

    const m = roomClaims(currentRoom);
    const existing = m.get(data.seatId);
    const name = getPlayerName(socket.id) ?? 'Seseorang';

    if (existing && existing.userId !== uid) {
      // Taken — redirect to the nearest free desk instead of a dead end.
      // Only a genuinely full room (no free seat anywhere) falls back to a
      // plain denial with no fallbackSeatId.
      const fallbackSeatId = nearestFreeSeat(currentRoom, data.seatId);
      if (!fallbackSeatId) {
        socket.emit(SocketEvents.SEAT_CLAIM_DENIED, { seatId: data.seatId, byName: existing.name });
        return;
      }
      assignSeat(currentRoom, fallbackSeatId, uid, name);
      socket.emit(SocketEvents.SEAT_CLAIM_DENIED, { seatId: data.seatId, byName: existing.name, fallbackSeatId });
      io.to(currentRoom).emit(SocketEvents.SEAT_CLAIMS_UPDATED, { claims: claimStates(currentRoom) });
      return;
    }

    assignSeat(currentRoom, data.seatId, uid, name);
    io.to(currentRoom).emit(SocketEvents.SEAT_CLAIMS_UPDATED, { claims: claimStates(currentRoom) });
  });

  socket.on(SocketEvents.RELEASE_SEAT, (data: { seatId: string }) => {
    if (!currentRoom || typeof data?.seatId !== 'string') return;
    const uid = userId();
    if (!uid) return;

    const m = roomClaims(currentRoom);
    const existing = m.get(data.seatId);
    // Only the owner may release — not a passer-by, not an admin.
    if (!existing || existing.userId !== uid) return;
    m.delete(data.seatId);
    io.to(currentRoom).emit(SocketEvents.SEAT_CLAIMS_UPDATED, { claims: claimStates(currentRoom) });
  });

  // Someone tried to claim a seat that's already taken and, unlike a plain
  // CLAIM_SEAT, chose to ask the owner instead of silently redirecting to
  // the nearest free desk.
  socket.on(SocketEvents.SEAT_CLAIM_REQUEST, (data: { seatId: string }) => {
    if (!currentRoom || typeof data?.seatId !== 'string') return;
    const uid = userId();
    if (!uid) return;
    if (!seatExists(currentRoom, data.seatId)) return;

    const m = roomClaims(currentRoom);
    const existing = m.get(data.seatId);
    const name = getPlayerName(socket.id) ?? 'Seseorang';

    // No longer taken by anyone else (freed, or the confirm dialog was
    // stale) — nothing to ask; claim it directly, same as CLAIM_SEAT would.
    if (!existing || existing.userId === uid) {
      assignSeat(currentRoom, data.seatId, uid, name);
      io.to(currentRoom).emit(SocketEvents.SEAT_CLAIMS_UPDATED, { claims: claimStates(currentRoom) });
      return;
    }

    const ownerSocketId = findSocketByUserId(io, currentRoom, existing.userId);
    if (!ownerSocketId) {
      // Owner isn't connected right now (a claim is a standing grant that
      // survives disconnects — see this file's top doc comment) — nobody to
      // ask, so fall back to the old silent-redirect rather than leaving the
      // requester waiting on a decision that will never come.
      const fallbackSeatId = nearestFreeSeat(currentRoom, data.seatId);
      if (!fallbackSeatId) {
        socket.emit(SocketEvents.SEAT_CLAIM_DENIED, { seatId: data.seatId, byName: existing.name });
        return;
      }
      assignSeat(currentRoom, fallbackSeatId, uid, name);
      socket.emit(SocketEvents.SEAT_CLAIM_DENIED, { seatId: data.seatId, byName: existing.name, fallbackSeatId });
      io.to(currentRoom).emit(SocketEvents.SEAT_CLAIMS_UPDATED, { claims: claimStates(currentRoom) });
      return;
    }

    roomSeatRequests(currentRoom).set(socket.id, {
      seatId: data.seatId,
      ownerSocketId,
      ownerName: existing.name,
      requesterUserId: uid,
      requesterName: name,
    });

    const req: SeatClaimRequest = { seatId: data.seatId, requesterUserId: uid, playerId: socket.id, requesterName: name };
    io.to(ownerSocketId).emit(SocketEvents.SEAT_CLAIM_REQUESTED, req);
  });

  socket.on(SocketEvents.SEAT_CLAIM_DECIDE, (data: { seatId: string; playerId: string; approve: boolean }) => {
    if (!currentRoom || typeof data?.seatId !== 'string' || typeof data?.playerId !== 'string') return;
    const m = roomSeatRequests(currentRoom);
    const pending = m.get(data.playerId);
    if (!pending || pending.seatId !== data.seatId) return;
    // Re-checked server-side: only the seat's CURRENT owner may decide. A
    // client faking this event for someone else's seat gets nothing.
    const currentOwner = roomClaims(currentRoom).get(data.seatId);
    if (!currentOwner || currentOwner.userId !== userId()) return;

    m.delete(data.playerId);
    if (data.approve) {
      assignSeat(currentRoom, data.seatId, pending.requesterUserId, pending.requesterName);
      io.to(currentRoom).emit(SocketEvents.SEAT_CLAIMS_UPDATED, { claims: claimStates(currentRoom) });
    }
    io.to(data.playerId).emit(SocketEvents.SEAT_CLAIM_DECIDED, {
      seatId: data.seatId,
      approved: !!data.approve,
      byName: pending.ownerName,
    });
  });

  // The requester backs out before the owner ever decides. Only their OWN
  // pending request, matched by this socket's id — nobody can cancel
  // someone else's.
  socket.on(SocketEvents.SEAT_CLAIM_REQUEST_CANCEL, (data: { seatId: string }) => {
    if (!currentRoom || typeof data?.seatId !== 'string') return;
    const m = roomSeatRequests(currentRoom);
    const pending = m.get(socket.id);
    if (!pending || pending.seatId !== data.seatId) return;
    m.delete(socket.id);
    io.to(pending.ownerSocketId).emit(SocketEvents.SEAT_CLAIM_REQUEST_CANCELLED, { seatId: pending.seatId, requesterUserId: pending.requesterUserId });
  });

  // No DISCONNECT handler releases an actual seat claim (see this file's top
  // doc comment) — this one only resolves PENDING requests, which can't
  // outlive either party's connection the way a claim itself does.
  socket.on(SocketEvents.DISCONNECT, () => {
    if (!currentRoom) return;
    const m = roomSeatRequests(currentRoom);

    // This socket was the REQUESTER on some pending ask — moot now, tell the
    // owner to drop that card.
    const myPending = m.get(socket.id);
    if (myPending) {
      m.delete(socket.id);
      io.to(myPending.ownerSocketId).emit(SocketEvents.SEAT_CLAIM_REQUEST_CANCELLED, { seatId: myPending.seatId, requesterUserId: myPending.requesterUserId });
    }

    // This socket was the OWNER one or more pending asks are waiting on —
    // nobody left to decide; resolve each as a denial so the requester's
    // "menunggu persetujuan" card doesn't hang forever.
    for (const [requesterSocketId, pending] of m) {
      if (pending.ownerSocketId !== socket.id) continue;
      m.delete(requesterSocketId);
      io.to(requesterSocketId).emit(SocketEvents.SEAT_CLAIM_DECIDED, { seatId: pending.seatId, approved: false, byName: pending.ownerName });
    }
  });

  // QA item #6 — deliberately no DISCONNECT handler here anymore. A claim
  // is a standing grant (see this file's top doc comment); it used to be
  // released automatically here on every disconnect, which silently cost
  // someone their claimed desk on a brief wifi drop. Only RELEASE_SEAT
  // above ever clears one now.
}
