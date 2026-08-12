import { Server, Socket } from 'socket.io';
import { SocketEvents, SeatClaimState } from '@kaispace/shared';
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
// is the owner explicitly releasing it (RELEASE_SEAT) — someone else can't
// bump them out either; CLAIM_SEAT only ever redirects a blocked claimant
// to the nearest free seat, never displaces the existing owner.
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

  // QA item #6 — deliberately no DISCONNECT handler here anymore. A claim
  // is a standing grant (see this file's top doc comment); it used to be
  // released automatically here on every disconnect, which silently cost
  // someone their claimed desk on a brief wifi drop. Only RELEASE_SEAT
  // above ever clears one now.
}
