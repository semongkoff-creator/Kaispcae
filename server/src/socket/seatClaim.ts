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
  const tiles = getCachedTiles(room);
  if (!tiles) return false;
  for (const row of tiles) {
    for (const tile of row) {
      if (tile?.claimableSeatId === seatId) return true;
    }
  }
  return false;
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
    if (existing && existing.userId !== uid) {
      socket.emit(SocketEvents.SEAT_CLAIM_DENIED, { seatId: data.seatId, byName: existing.name });
      return;
    }

    // One seat per user: claiming a new one frees whichever one they held.
    for (const [seatId, c] of m) {
      if (c.userId === uid) m.delete(seatId);
    }
    m.set(data.seatId, { userId: uid, name: getPlayerName(socket.id) ?? 'Seseorang', socketId: socket.id });
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
