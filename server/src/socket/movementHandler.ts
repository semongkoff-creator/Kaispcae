import { Server, Socket } from 'socket.io';
import { SocketEvents, MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, isTileBlocked, JumpEvent } from '@virtualmeet/shared';
import { updatePlayerPosition, setPlayerStopped, getCachedTiles } from '../store/roomStore';

// Rate limiting: max 20 updates per second per player
const rateLimitMap = new Map<string, number>();
const MIN_UPDATE_INTERVAL = 1000 / 20; // 50ms

interface MoveData {
  x: number;
  y: number;
  direction: string;
  isRunning?: boolean;
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
        if (isTileBlocked(tiles, tileX, tileY)) return;
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

  // Clean up rate limit map on disconnect
  socket.on('disconnect', () => {
    rateLimitMap.delete(socket.id);
  });
}
