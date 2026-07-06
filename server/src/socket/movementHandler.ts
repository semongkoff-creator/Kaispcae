import { Server, Socket } from 'socket.io';
import { SocketEvents, MAP_WIDTH, MAP_HEIGHT, TILE_SIZE } from '@virtualmeet/shared';
import { updatePlayerPosition, setPlayerStopped } from '../store/roomStore';

// Rate limiting: max 20 updates per second per player
const rateLimitMap = new Map<string, number>();
const MIN_UPDATE_INTERVAL = 1000 / 20; // 50ms

interface MoveData {
  x: number;
  y: number;
  direction: string;
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
      socket.to(gameRoom).emit(SocketEvents.PLAYER_MOVED, {
        id: socket.id,
        x: clampedX,
        y: clampedY,
        direction: data.direction,
      });
      updatePlayerPosition(gameRoom, socket.id, clampedX, clampedY, data.direction);
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

  // Clean up rate limit map on disconnect
  socket.on('disconnect', () => {
    rateLimitMap.delete(socket.id);
  });
}
