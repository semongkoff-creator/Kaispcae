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
import { registerAnalyticsFeedHandlers } from './socket/analyticsFeed';
import { registerZoneHandlers } from './socket/zoneHandler';
import { registerZoneLockHandlers } from './socket/zoneLock';
import { registerSeatClaimHandlers } from './socket/seatClaim';
import { registerFurnitureHandlers } from './socket/furnitureHandler';
import { registerNoteHandlers } from './socket/noteHandler';
import { registerFollowHandlers } from './socket/followHandler';
import { registerMediaHandlers, startMediaExpirySweep } from './socket/mediaHandler';
import { registerRecordingHandlers } from './socket/recordingHandler';
import { getRedis } from './store/roomStore';
import { loadConfig, getConfig } from './config';
import { rateLimit } from './middleware/rateLimit';
import { verifyTokenClaims, verifyGuestTokenClaims, isSessionSuperseded, SESSION_SUPERSEDED, isInviteRevoked, GUEST_LINK_REVOKED } from './middleware/auth';
import { setSessionKickIo } from './lib/sessionKick';
import authRoutes from './routes/auth';
import roomRoutes, { setIo } from './routes/rooms';
import roomMemberRoutes, { setMembersIo } from './routes/roomMembers';
import guestInviteRoutes, { setIo as setGuestInviteIo } from './routes/guestInvite';
import teleportRoutes from './routes/teleport';
import uploadRoutes from './routes/uploads';
import recordingRoutes from './routes/recordings';
import chatRoutes, { setIo as setChatIo } from './routes/chat';
import adminRoutes, { setAdminIo } from './routes/admin';
import attendanceRoutes from './routes/attendance';
import attendanceAdminRoutes from './routes/attendanceAdmin';
import calendarRoutes, { setCalendarIo } from './routes/calendar';
import meetingRoomRoutes from './routes/meetingRooms';
import userRoutes, { setUsersIo } from './routes/users';
import larkRoutes from './routes/lark';
import attendanceLarkRoutes from './routes/attendanceLark';
import meetingRoutes, { setMeetingIo, startRecordingPoller } from './routes/meeting';
import larkChatMapRoutes from './routes/larkChatMap';
import taskRoutes from './routes/tasks';
import leaveRoutes from './routes/leave';
import analyticsRoutes from './routes/analytics';
import { startLarkEventStream } from './lib/larkWs';
import { subscribeLeaveApproval } from './lib/larkApproval';
import { startReminderSweep } from './socket/reminderSweep';
import { startAttendanceSweep } from './socket/attendanceSweep';
import { startQueueSweep } from './socket/queueSweep';
import { startAnalyticsSweep } from './socket/analyticsSweep';
import { getYoutubeQuotaStatus } from './lib/youtubeService';
import { getTurnRelayStatus } from './socket/rtcHandler';

loadConfig();
const config = getConfig();

// QA (Integrasi checklist item 13, "Kegagalan anggun") — without these, an
// error that escapes every route/handler's own try/catch (a missed .catch()
// on a fire-and-forget call, a bug in a rarely-hit code path) doesn't just
// fail that one request — Node 20's default behaviour is to terminate the
// ENTIRE process on an unhandled promise rejection, and Express 4 (unlike 5)
// never forwards an async handler's thrown/rejected error to error-handling
// middleware in the first place, so it has nowhere else to go. That means a
// single bug in, say, one Lark sub-feature could take down every room's
// live socket connections along with it — the opposite of "1 integrasi down
// → space tetap jalan". These are a last-resort safety net, not a
// substitute for the try/catch each integration module already does at its
// own boundary (see lib/lark*.ts) — just log loudly enough to actually
// find and fix the gap, and keep the space running for everyone already
// connected instead of dropping every live socket over one stray error.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled promise rejection (process kept alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception (process kept alive):', err);
});

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
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (typeof token === 'string' && token) {
    // Guest Link & Ruang Tunggu — checked FIRST and structurally distinct
    // from the real-account claims below (guestId, never userId — see
    // signGuestToken's doc comment). A guest token never touches
    // socket.data.userId at all, so every downstream check that gates on
    // "is this a real account" (DB writes, admin/staff role checks, which
    // all key off socket.data.userId) naturally excludes guest sockets
    // without needing its own special-casing.
    const guestClaims = verifyGuestTokenClaims(token);
    if (guestClaims) {
      // QA (Akses tamu checklist item 7, "Revoke") — a revoked link's JWT
      // is still cryptographically valid until it expires, so this DB
      // check is what actually stops a kicked guest from reconnecting
      // (e.g. on refresh) with their still-stored token.
      if (await isInviteRevoked(guestClaims.inviteId)) {
        return next(new Error(GUEST_LINK_REVOKED));
      }
      socket.data.guestId = guestClaims.guestId;
      socket.data.guestName = guestClaims.name;
      socket.data.guestRoomSlug = guestClaims.roomSlug;
      // QA (Akses tamu checklist item 7, "Revoke") — which invite link this
      // session came from, so a revoke can find and disconnect it (see
      // guestInvite.ts's DELETE handler).
      socket.data.guestInviteId = guestClaims.inviteId;
      return next();
    }
    const claims = verifyTokenClaims(token);
    if (claims) {
      // Bug 1 — single active session: reject a socket whose session has been
      // superseded by a newer login, so the old device is disconnected with a
      // clear reason instead of silently receiving live room state.
      if (await isSessionSuperseded(claims.userId, claims.sessionId)) {
        return next(new Error(SESSION_SUPERSEDED));
      }
      socket.data.userId = claims.userId;
      socket.data.sessionId = claims.sessionId;
    }
  }
  next();
});

setIo(io);
setSessionKickIo(io);
setMembersIo(io);
setChatIo(io);
setAdminIo(io);
setUsersIo(io);
setGuestInviteIo(io);
setCalendarIo(io);
setMeetingIo(io);

// ── REST routes ──────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  const redis = await getRedis();
  // QA (Stabilitas checklist item 12, "Kuota biaya API") — previously this
  // endpoint reported nothing about which paid/metered integrations were
  // even configured, let alone their usage — an operator had to grep
  // startup logs to know what was active at all, and nothing tracked usage
  // trend over a day. `configured` is a cheap presence check (env vars
  // set); the quota/relay fields are the actual in-memory counters (see
  // youtubeService.ts / rtcHandler.ts — Lark itself has no per-call quota
  // to track, it's an enterprise SSO/workspace API, not billed per
  // request, so it only gets a configured flag here, not a usage counter).
  res.json({
    status: 'ok',
    dbConnected: true,
    redisConnected: !!redis,
    uptime: process.uptime(),
    timestamp: Date.now(),
    integrations: {
      lark: { configured: !!(config.LARK_APP_ID && config.LARK_APP_SECRET) },
      youtube: { configured: !!config.YOUTUBE_API_KEY, ...getYoutubeQuotaStatus() },
      turn: getTurnRelayStatus(),
    },
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
app.use('/api', guestInviteRoutes);
app.use('/api', teleportRoutes);
app.use('/api', uploadRoutes);
app.use('/api', recordingRoutes);
app.use('/api', chatRoutes);
app.use('/api', userRoutes);
// Mounted at /api → routes resolve to /api/auth/lark/* (see nginx audit: only
// /api/ is proxied to the backend).
app.use('/api', larkRoutes);
app.use('/api', attendanceLarkRoutes);
app.use('/api', larkChatMapRoutes);
app.use('/api', taskRoutes);
app.use('/api', leaveRoutes);
app.use('/api', meetingRoutes);
app.use('/api', adminRoutes);
app.use('/api', attendanceRoutes);
app.use('/api', attendanceAdminRoutes);
app.use('/api', calendarRoutes);
app.use('/api', meetingRoomRoutes);
app.use('/api', analyticsRoutes);

// ── Socket.IO ────────────────────────────────────────────────────
async function start() {
  const redis = await getRedis();
  console.log(`[server] ${redis ? 'Redis connected' : 'Redis unavailable — in-memory mode'}`);
  console.log(`[server] environment: ${config.NODE_ENV}`);

  io.on(SocketEvents.CONNECT, (socket) => {
    console.log(`[server] player connected: ${socket.id}`);

    // Guest Link & Ruang Tunggu — a guest socket (see io.use() above) only
    // ever gets the minimal set of handlers it actually needs (join/leave,
    // movement, WebRTC signaling, the zone-scoped CHAT_MESSAGE/CHAT_BUBBLE
    // pair, zone membership tracking, cosmetic emotes). Everything else is
    // simply never registered on this socket at all — not role-gated, not
    // reachable — which is a stronger guarantee than a per-handler check:
    // internal Channel/DM chat (FK-writes a synthetic guest id would violate
    // Postgres on), furniture assignment, media/soundboard, seat claims,
    // follow, zone locking, and recording are all admin/member-tier features
    // an external, unauthenticated visitor has no business touching.
    const isGuest = !!(socket.data as { guestId?: string }).guestId;

    registerRoomHandlers(io, socket);
    registerMovementHandlers(io, socket);
    registerRtcHandlers(io, socket);
    registerChatHandlers(io, socket, () => getPlayerName(socket.id), () => getPlayerColor(socket.id));
    registerZoneHandlers(io, socket);
    registerEmoteHandlers(io, socket);
    if (!isGuest) {
      registerAnalyticsFeedHandlers(io, socket);
      registerChannelChatHandlers(io, socket);
      registerZoneLockHandlers(io, socket);
      registerSeatClaimHandlers(io, socket);
      registerFurnitureHandlers(io, socket);
      registerNoteHandlers(io, socket);
      registerFollowHandlers(io, socket);
      registerMediaHandlers(io, socket);
      registerRecordingHandlers(io, socket);
    }
  });

  startMediaExpirySweep(io);
  startReminderSweep(io);
  startAttendanceSweep(io);
  startQueueSweep(io);
  startAnalyticsSweep(io);

  httpServer.listen(config.PORT, () => {
    console.log(`[server] VirtualMeet running on http://localhost:${config.PORT}`);
    // A5 — background poll for finished Lark VC recordings.
    startRecordingPoller();
    // Bagian 4 — open the Lark persistent connection for inbound chat events.
    startLarkEventStream(io);
    // A9 — subscribe to the Cuti approval's events (once) so status changes flow.
    void subscribeLeaveApproval();
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
