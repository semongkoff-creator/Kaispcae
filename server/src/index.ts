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
import { registerChannelChatHandlers } from './socket/channelChatHandler';
import { registerEmoteHandlers } from './socket/emoteHandler';
import { registerZoneHandlers } from './socket/zoneHandler';
import { registerZoneLockHandlers } from './socket/zoneLock';
import { registerFurnitureHandlers } from './socket/furnitureHandler';
import { registerFollowHandlers } from './socket/followHandler';
import { registerMediaHandlers, startMediaExpirySweep } from './socket/mediaHandler';
import { registerRecordingHandlers } from './socket/recordingHandler';
import { getRedis } from './store/roomStore';
import { loadConfig, getConfig } from './config';
import { rateLimit } from './middleware/rateLimit';
import { verifyToken } from './middleware/auth';
import authRoutes from './routes/auth';
import roomRoutes, { setIo } from './routes/rooms';
import roomMemberRoutes, { setMembersIo } from './routes/roomMembers';
import teleportRoutes from './routes/teleport';
import uploadRoutes from './routes/uploads';
import recordingRoutes from './routes/recordings';
import chatRoutes, { setIo as setChatIo } from './routes/chat';
import baseRoutes, { setBaseIo } from './routes/bases';
import baseCommentRoutes, { setCommentsIo } from './routes/baseComments';
import adminRoutes, { setAdminIo } from './routes/admin';
import attendanceRoutes from './routes/attendance';
import attendanceAdminRoutes from './routes/attendanceAdmin';
import calendarRoutes, { setCalendarIo } from './routes/calendar';
import meetingRoomRoutes from './routes/meetingRooms';
import baseShareRoutes from './routes/baseShare';
import userRoutes from './routes/users';
import { registerBaseHandlers } from './socket/baseHandler';
import { startReminderSweep } from './socket/reminderSweep';
import { startAttendanceSweep } from './socket/attendanceSweep';

loadConfig();
const config = getConfig();

const app = express();
// 512kb (up from the 100kb default) so profile-photo data-URLs fit — the
// route itself caps the photo at ~150KB, this is just headroom for the JSON
// envelope. Large binary uploads still go through multipart (routes/uploads),
// never JSON, so this ceiling isn't a general large-payload allowance.
app.use(express.json({ limit: '512kb' }));

// Allow the configured origin(s) PLUS any localhost / private-LAN address on
// any port, so friends on the same WiFi can join by opening this machine's
// LAN URL (http://192.168.x.x:5173) without needing that exact IP added to
// CORS_ORIGIN by hand. Private ranges only (10/172.16-31/192.168 + loopback)
// — this never opens the server to arbitrary public origins.
const LAN_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?$/;
const configuredOrigins = config.CORS_ORIGIN.split(',').map((s: string) => s.trim());
const corsOrigin = (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
  // No Origin header (curl, same-origin, native socket clients) → allow.
  if (!origin || configuredOrigins.includes(origin) || LAN_ORIGIN.test(origin)) return cb(null, true);
  return cb(null, false);
};

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  }),
);

// Global rate limiter
app.use(rateLimit(config.RATE_LIMIT_WINDOW_MS, config.RATE_LIMIT_MAX));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
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
setMembersIo(io);
setChatIo(io);
setBaseIo(io);
setCommentsIo(io);
setAdminIo(io);
setCalendarIo(io);

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
app.use('/api', roomMemberRoutes);
app.use('/api', teleportRoutes);
app.use('/api', uploadRoutes);
app.use('/api', recordingRoutes);
app.use('/api', chatRoutes);
app.use('/api', baseRoutes);
app.use('/api', baseCommentRoutes);
app.use('/api', baseShareRoutes);
app.use('/api', userRoutes);
app.use('/api', adminRoutes);
app.use('/api', attendanceRoutes);
app.use('/api', attendanceAdminRoutes);
app.use('/api', calendarRoutes);
app.use('/api', meetingRoomRoutes);

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
    registerChannelChatHandlers(io, socket);
    registerEmoteHandlers(io, socket);
    registerZoneHandlers(io, socket);
    registerZoneLockHandlers(io, socket);
    registerFurnitureHandlers(io, socket);
    registerFollowHandlers(io, socket);
    registerMediaHandlers(io, socket);
    registerRecordingHandlers(io, socket);
    registerBaseHandlers(io, socket);
  });

  startMediaExpirySweep(io);
  startReminderSweep(io);
  startAttendanceSweep(io);

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
