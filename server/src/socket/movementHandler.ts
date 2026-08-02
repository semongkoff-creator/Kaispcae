import { Server, Socket } from 'socket.io';
import { SocketEvents, MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, isTileBlocked, RoomTile, JumpEvent, NudgeEvent } from '@virtualmeet/shared';
import { updatePlayerPosition, setPlayerStopped, getCachedTiles } from '../store/roomStore';
import { isDoorUnlocked, clearUnlockedDoors } from './doorLock';

// Rate limiting: max 20 updates per second per player
const rateLimitMap = new Map<string, number>();
const MIN_UPDATE_INTERVAL = 1000 / 20; // 50ms

interface MoveData {
  x: number;
  y: number;
  direction: string;
  isRunning?: boolean;
}

// ZEP-style door password — server-authoritative half of the gate (the
// client also predicts this locally for responsive collision, see
// GameCanvas.tsx's isBlocked). A password-protected door this socket hasn't
// solved yet is treated exactly like any other blocked tile: the move is
// silently dropped, same as walking into a wall. Not in BLOCKED_TILES itself
// since that's a static set keyed only on TileType — this needs per-socket,
// per-room session state isTileBlocked has no way to see.
function isBlockedForSocket(tiles: RoomTile[][], room: string, socketId: string, tileX: number, tileY: number): boolean {
  if (isTileBlocked(tiles, tileX, tileY)) return true;
  const tile = tiles[tileY]?.[tileX];
  if (tile?.type === 'door' && tile.doorPasswordEnabled && tile.doorPassword) {
    return !isDoorUnlocked(socketId, room, tileX, tileY);
  }
  return false;
}

export function registerMovementHandlers(io: Server, socket: Socket) {
  socket.on(SocketEvents.PLAYER_MOVE, (data: MoveData) => {
    // Rate limit: skip if too many updates
    const now = Date.now();
    const lastUpdate = rateLimitMap.get(socket.id) || 0;
    if (now - lastUpdate < MIN_UPDATE_INTERVAL) return;
    rateLimitMap.set(socket.id, now);

    // Server-side bounds validation
    const clampedX = Math.max(TILE_SIZE / 2, Math.min(MAP_WIDTH * TILE_SIZE - TILE_SIZE / 2, data.x));
    const clampedY = Math.max(TILE_SIZE / 2, Math.min(MAP_HEIGHT * TILE_SIZE - TILE_SIZE / 2, data.y));

    // Broadcast to all others in the socket's game room only — a plain
    // socket.broadcast.emit would leak positions to every room on the server.
    const rooms = Array.from(socket.rooms);
    const gameRoom = rooms.find((r) => r !== socket.id);
    if (gameRoom) {
      // Server-authoritative collision check: previously this handler only
      // clamped to the map's outer rectangle and otherwise broadcast
      // whatever x/y the client reported — a modified client could walk
      // through walls/desks since nothing re-validated against the actual
      // room layout. getCachedTiles() is populated by roomHandler.ts on
      // join and on every editor save, so this is a synchronous lookup, no
      // DB round-trip per move. If the room's tiles haven't been cached yet
      // (e.g. a stray move racing the initial ROOM_STATE), fail open rather
      // than silently dropping legitimate early input.
      const tiles = getCachedTiles(gameRoom);
      if (tiles) {
        const tileX = Math.floor(clampedX / TILE_SIZE);
        const tileY = Math.floor(clampedY / TILE_SIZE);
        if (isBlockedForSocket(tiles, gameRoom, socket.id, tileX, tileY)) return;
      }

      socket.to(gameRoom).emit(SocketEvents.PLAYER_MOVED, {
        id: socket.id,
        x: clampedX,
        y: clampedY,
        direction: data.direction,
        isRunning: !!data.isRunning,
      });
      updatePlayerPosition(gameRoom, socket.id, clampedX, clampedY, data.direction, data.isRunning);
    }
  });

  // A4 — free double-click teleport. Same bounds + server-authoritative
  // collision guard as PLAYER_MOVE, but re-broadcast as PLAYER_TELEPORTED so
  // every client SNAPS instead of interpolating a slide across the map.
  socket.on(SocketEvents.PLAYER_TELEPORT_TO, (data: { x: number; y: number; direction?: string }) => {
    if (typeof data?.x !== 'number' || typeof data?.y !== 'number') return;
    const clampedX = Math.max(TILE_SIZE / 2, Math.min(MAP_WIDTH * TILE_SIZE - TILE_SIZE / 2, data.x));
    const clampedY = Math.max(TILE_SIZE / 2, Math.min(MAP_HEIGHT * TILE_SIZE - TILE_SIZE / 2, data.y));
    const rooms = Array.from(socket.rooms);
    const gameRoom = rooms.find((r) => r !== socket.id);
    if (!gameRoom) return;
    const tiles = getCachedTiles(gameRoom);
    if (tiles) {
      const tileX = Math.floor(clampedX / TILE_SIZE);
      const tileY = Math.floor(clampedY / TILE_SIZE);
      if (isBlockedForSocket(tiles, gameRoom, socket.id, tileX, tileY)) return; // refuse teleport into a wall/desk/locked door
    }
    const direction = (data.direction as MoveData['direction']) || 'down';
    socket.to(gameRoom).emit(SocketEvents.PLAYER_TELEPORTED, { id: socket.id, x: clampedX, y: clampedY, direction });
    updatePlayerPosition(gameRoom, socket.id, clampedX, clampedY, direction, false);
  });

  socket.on(SocketEvents.PLAYER_STOP, (data: { direction: string }) => {
    const rooms = Array.from(socket.rooms);
    const gameRoom = rooms.find((r) => r !== socket.id);
    if (gameRoom) {
      socket.to(gameRoom).emit(SocketEvents.PLAYER_STOPPED, {
        id: socket.id,
        direction: data.direction,
      });
      setPlayerStopped(gameRoom, socket.id);
    }
  });

  // Jump — cosmetic, fire-and-forget (same shape/spirit as emoteHandler.ts's
  // EMOTE_PLAY relay), so no rate limit / position validation needed here.
  socket.on(SocketEvents.PLAYER_JUMP, () => {
    const rooms = Array.from(socket.rooms);
    const gameRoom = rooms.find((r) => r !== socket.id);
    if (!gameRoom) return;
    const event: JumpEvent = { playerId: socket.id, timestamp: Date.now() };
    socket.to(gameRoom).emit(SocketEvents.PLAYER_JUMP, event);
  });

  // Nudge ("senggol") — same trust level as Jump above: the client already
  // decided who's standing on the tile it's facing, this just relays it.
  // Worst case of a spoofed targetId is someone's avatar shaking with no
  // real trigger — purely cosmetic, nothing persisted.
  socket.on(SocketEvents.PLAYER_NUDGE, (data: { targetId?: string }) => {
    const targetId = data?.targetId;
    if (!targetId || targetId === socket.id) return;
    const rooms = Array.from(socket.rooms);
    const gameRoom = rooms.find((r) => r !== socket.id);
    if (!gameRoom) return;
    const event: NudgeEvent = { fromId: socket.id, targetId, timestamp: Date.now() };
    io.to(gameRoom).emit(SocketEvents.PLAYER_NUDGE, event);
  });

  // Clean up rate limit map on disconnect
  socket.on('disconnect', () => {
    rateLimitMap.delete(socket.id);
    clearUnlockedDoors(socket.id);
  });
}
