import { Server, Socket } from 'socket.io';
import { SocketEvents } from '@virtualmeet/shared';
import { mayEnterZone, isZoneLocked, isSealedIn } from './zoneLock';
import { sendMusicStateToSocket } from './musicHandler';
import { getCachedZones } from '../store/roomStore';

// Actual A/V zone restriction is computed client-side (see useProximity.ts —
// every client already knows every player's position and the room's zones,
// so it derives membership locally with no round trip). This handler relays
// enter/exit so other clients in the SAME room can react (e.g. a "so-and-so
// joined the meeting room" indicator), and tracks who's in which zone so
// zone-scoped chat (see chatHandler.ts) can be routed to only those sockets.
const socketZone = new Map<string, { room: string; zoneId: string }>();

export function getSocketIdsInZone(room: string, zoneId: string): string[] {
  const ids: string[] = [];
  for (const [socketId, loc] of socketZone) {
    if (loc.room === room && loc.zoneId === zoneId) ids.push(socketId);
  }
  return ids;
}

// Used by chatHandler.ts to reject a zone-scoped CHAT_MESSAGE from a socket
// that isn't actually tracked as being inside that zone — previously any
// socket could attach any zoneId to a message and it would be routed to
// that zone's chat regardless of whether the sender was really there,
// since only the RECIPIENTS were computed from real zone membership, never
// the sender's own claim (see §1.3's "reject send_chat kalau
// player.currentAreaId tidak sesuai" rule).
// The zone a socket is currently tracked in (null when it's in none).
export function zoneIdOfSocket(socketId: string): string | null {
  return socketZone.get(socketId)?.zoneId ?? null;
}

export function isSocketInZone(room: string, socketId: string, zoneId: string): boolean {
  const loc = socketZone.get(socketId);
  return !!loc && loc.room === room && loc.zoneId === zoneId;
}

export function registerZoneHandlers(io: Server, socket: Socket) {
  let currentRoom: string | null = null;

  socket.on(SocketEvents.JOIN_ROOM, (roomId: string) => {
    currentRoom = roomId || 'main-office';
  });

  socket.on(SocketEvents.ZONE_ENTER, (zoneId: string) => {
    if (!currentRoom) return;
    // A locked zone is enforced HERE, not just drawn in the UI. Without this
    // the padlock would be decoration: zone membership drives zone-scoped
    // chat and A/V, so an uninvited socket could still join the meeting's
    // audio by claiming ZONE_ENTER.
    const uid = socket.data.userId as string | undefined;
    if (isZoneLocked(currentRoom, zoneId) && !mayEnterZone(currentRoom, zoneId, uid)) {
      socket.emit(SocketEvents.ZONE_LOCKED_DENIED, { zoneId, reason: 'locked' });
      return;
    }
    // Item #14 — optional max-occupant cap (Room Editor's "Private area"
    // tool, Zone.capacity). Excludes this socket from the count so a
    // redundant ZONE_ENTER re-fired while already inside (e.g. walking
    // around within the same zone) never locks someone out of a zone
    // they're already standing in.
    const zone = getCachedZones(currentRoom).find((z) => z.id === zoneId);
    if (zone?.capacity) {
      const others = getSocketIdsInZone(currentRoom, zoneId).filter((id) => id !== socket.id);
      if (others.length >= zone.capacity) {
        socket.emit(SocketEvents.ZONE_LOCKED_DENIED, { zoneId, reason: 'zone_full' });
        return;
      }
    }
    socketZone.set(socket.id, { room: currentRoom, zoneId });
    socket.to(currentRoom).emit(SocketEvents.ZONE_ENTER, { playerId: socket.id, zoneId });
    // Fitur 2 correction — a Music Bot track already playing in this zone
    // must start for the joining socket right away, with no click/popup.
    sendMusicStateToSocket(socket, currentRoom, zoneId);
  });

  socket.on(SocketEvents.ZONE_EXIT, (zoneId: string) => {
    if (!currentRoom) return;
    // Locked zones hold everyone in, keyholder included — unlock first, then
    // walk out. The client also blocks the walk, but membership is what
    // drives zone chat and A/V — so it must be refused HERE too, or someone
    // could leave the meeting's audio while still standing in it.
    if (isSealedIn(currentRoom, zoneId)) {
      socket.emit(SocketEvents.ZONE_LOCKED_DENIED, { zoneId, reason: 'sealed_in' });
      return;
    }
    socketZone.delete(socket.id);
    socket.to(currentRoom).emit(SocketEvents.ZONE_EXIT, { playerId: socket.id, zoneId });
  });

  socket.on(SocketEvents.DISCONNECT, () => {
    socketZone.delete(socket.id);
  });
}
