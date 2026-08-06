import { Server, Socket } from 'socket.io';
import { SocketEvents, SeatClaimState } from '@virtualmeet/shared';
import { getPlayerName } from './roomHandler';
import { getCachedTiles } from '../store/roomStore';

// Claimable-seat ownership — "this seat is mine right now".
//
// The seat MARKER itself (id, position) is admin-authored data living in
// Room.layerData (see mapLayers.ts's TileEffect 'claimableSeat', edited via
// the Room Editor). This file is the OTHER half: who currently owns each
// marker during play. Exactly like zoneLock.ts's zone locks, this is
// in-memory only — "right now, in this session" — and is never written to
// the DB. A claim must not outlive a restart, matching the spec's own
// "owner disconnects → seat auto-releases" requirement: if this were
// persisted, a restart would leave every seat looking permanently taken.

interface SeatClaim {
  userId: string;
  name: string;
  socketId: string;
}

// room slug → seatId → claim
const claims = new Map<string, Map<string, SeatClaim>>();

function roomClaims(room: string): Map<string, SeatClaim> {
  let m = claims.get(room);
  if (!m) { m = new Map(); claims.set(room, m); }
  return m;
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

function assignSeat(room: string, seatId: string, uid: string, socketId: string, name: string): void {
  const m = roomClaims(room);
  // One seat per user: claiming a new one frees whichever one they held.
  for (const [sid, c] of m) {
    if (c.userId === uid) m.delete(sid);
  }
  m.set(seatId, { userId: uid, name, socketId });
}

function claimStates(room: string): SeatClaimState[] {
  return [...roomClaims(room).entries()].map(([seatId, c]) => ({ seatId, userId: c.userId, name: c.name }));
}

export function registerSeatClaimHandlers(io: Server, socket: Socket): void {
  let currentRoom: string | null = null;
  const userId = (): string | undefined => socket.data.userId as string | undefined;

  socket.on(SocketEvents.JOIN_ROOM, (roomId: string) => {
    currentRoom = roomId || 'main-office';
    // Late joiner catches up on who's sitting where.
    socket.emit(SocketEvents.SEAT_CLAIMS_UPDATED, { claims: claimStates(currentRoom) });
  });

  socket.on(SocketEvents.CLAIM_SEAT, (data: { seatId: string }) => {
    if (!currentRoom || typeof data?.seatId !== 'string') return;
    const uid = userId();
    // Anonymous sockets can't own a seat: ownership keyed by nothing would
    // let anyone through after a reconnect, and disconnect cleanup below
    // relies on a real userId.
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
      assignSeat(currentRoom, fallbackSeatId, uid, socket.id, name);
      socket.emit(SocketEvents.SEAT_CLAIM_DENIED, { seatId: data.seatId, byName: existing.name, fallbackSeatId });
      io.to(currentRoom).emit(SocketEvents.SEAT_CLAIMS_UPDATED, { claims: claimStates(currentRoom) });
      return;
    }

    assignSeat(currentRoom, data.seatId, uid, socket.id, name);
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

  socket.on(SocketEvents.DISCONNECT, () => {
    if (!currentRoom) return;
    // No "ghost" seats: whatever this socket held is freed for everyone else.
    const m = roomClaims(currentRoom);
    let changed = false;
    for (const [seatId, c] of m) {
      if (c.socketId === socket.id) { m.delete(seatId); changed = true; }
    }
    if (changed) io.to(currentRoom).emit(SocketEvents.SEAT_CLAIMS_UPDATED, { claims: claimStates(currentRoom) });
  });
}
