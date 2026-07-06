import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { SocketEvents } from '@virtualmeet/shared';
import { registerRoomHandlers, getPlayerName, getPlayerColor } from './socket/roomHandler';
import { registerMovementHandlers } from './socket/movementHandler';
import { registerRtcHandlers } from './socket/rtcHandler';
import { registerChatHandlers } from './socket/chatHandler';
import { registerEmoteHandlers } from './socket/emoteHandler';
import { registerZoneHandlers } from './socket/zoneHandler';
import { registerFurnitureHandlers } from './socket/furnitureHandler';
import { getRedis } from './store/roomStore';
import { loadConfig, getConfig } from './config';
import { rateLimit } from './middleware/rateLimit';
import { verifyToken } from './middleware/auth';
import authRoutes from './routes/auth';
import roomRoutes, { setIo } from './routes/rooms';

loadConfig();
const config = getConfig();

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: config.CORS_ORIGIN.split(',').map((s: string) => s.trim()),
    credentials: true,
  }),
);

// Global rate limiter
app.use(rateLimit(config.RATE_LIMIT_WINDOW_MS, config.RATE_LIMIT_MAX));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: config.CORS_ORIGIN.split(',').map((s: string) => s.trim()),
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Verify the JWT (if any) supplied at connect time and attach the real user
// id to the socket. Handlers must trust socket.data.userId over any
// client-supplied userId param — otherwise anyone can claim to be any
// account (including a room's owner) and take over admin/master-admin
// privileges. Unauthenticated connections are still allowed through (guest
// fallback), they just don't get a verified identity.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (typeof token === 'string' && token) {
    const userId = verifyToken(token);
    if (userId) socket.data.userId = userId;
  }
  next();
});

setIo(io);

// ── REST routes ──────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  const redis = await getRedis();
  res.json({
    status: 'ok',
    dbConnected: true,
    redisConnected: !!redis,
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

app.get('/api/metrics', (_req, res) => {
  const rooms = io.sockets.adapter.rooms.size;
  const connected = io.engine.clientsCount;
  res.json({ activeRooms: rooms, connectedPlayers: connected, uptime: process.uptime() });
});

app.use('/api/auth', authRoutes);
app.use('/api', roomRoutes);

// ── Socket.IO ────────────────────────────────────────────────────
async function start() {
  const redis = await getRedis();
  console.log(`[server] ${redis ? 'Redis connected' : 'Redis unavailable — in-memory mode'}`);
  console.log(`[server] environment: ${config.NODE_ENV}`);

  io.on(SocketEvents.CONNECT, (socket) => {
    console.log(`[server] player connected: ${socket.id}`);

    registerRoomHandlers(io, socket);
    registerMovementHandlers(io, socket);
    registerRtcHandlers(io, socket);
    registerChatHandlers(io, socket, () => getPlayerName(socket.id), () => getPlayerColor(socket.id));
    registerEmoteHandlers(io, socket);
    registerZoneHandlers(io, socket);
    registerFurnitureHandlers(io, socket);
  });

  httpServer.listen(config.PORT, () => {
    console.log(`[server] VirtualMeet running on http://localhost:${config.PORT}`);
  });
}

// ── Graceful shutdown ────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM — shutting down gracefully');
  io.close(() => {
    httpServer.close(() => {
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('[server] SIGINT — shutting down');
  io.close(() => {
    httpServer.close(() => {
      process.exit(0);
    });
  });
});

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
