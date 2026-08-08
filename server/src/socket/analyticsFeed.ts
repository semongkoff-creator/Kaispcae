import { Server, Socket } from 'socket.io';
import { SocketEvents, AnalyticsActivityType, AnalyticsActivityPayload } from '@virtualmeet/shared';
import { getPrisma } from '../lib/prisma';

// v2 Bagian B.2 #5 — Office Activity Feed. In-memory userId -> managerId
// cache (null = confirmed no manager), refreshed once at JOIN_ROOM (see
// roomHandler.ts's hook) and read SYNCHRONOUSLY everywhere else — a live
// event must never wait on a DB round trip just to know who to push to.
// Same "fine for a single server process" caveat as every other in-memory
// cache in this codebase.
const managerIdCache = new Map<string, string | null>();

export async function refreshManagerCache(userId: string): Promise<void> {
  try {
    const prisma = getPrisma();
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { managerId: true } });
    managerIdCache.set(userId, user?.managerId ?? null);
  } catch (e) {
    console.error('[analyticsFeed] failed to refresh manager cache:', e);
  }
}

// A manager subscribes to THEIR OWN feed room — `analytics-feed:<their own
// userId>` — not a per-report subscription; every direct report's events
// land in the one room keyed by the manager who should see them (see
// broadcastAnalyticsActivity below).
export function registerAnalyticsFeedHandlers(_io: Server, socket: Socket): void {
  socket.on(SocketEvents.ANALYTICS_FEED_SUBSCRIBE, () => {
    const uid = (socket.data as { userId?: string }).userId;
    if (!uid) return; // guests/unauthenticated sockets can't be managers
    socket.join(`analytics-feed:${uid}`);
  });
  socket.on(SocketEvents.ANALYTICS_FEED_UNSUBSCRIBE, () => {
    const uid = (socket.data as { userId?: string }).userId;
    if (!uid) return;
    socket.leave(`analytics-feed:${uid}`);
  });
}

// Called from the 4 instrumented hook points (WORK_MODE_CHANGE, the
// proximity sweep, chat send, PLAYER_NUDGE). Fire-and-forget, best-effort —
// a no-op if this user's manager isn't cached (either genuinely has none,
// or hasn't joined a room yet this server lifetime) rather than a DB
// round trip on the hot path.
export function broadcastAnalyticsActivity(
  io: Server,
  userId: string,
  userName: string,
  type: AnalyticsActivityType,
  detail?: string,
  other?: { userId: string; userName: string },
): void {
  const managerId = managerIdCache.get(userId);
  if (!managerId) return;
  const payload: AnalyticsActivityPayload = {
    type, userId, userName, timestamp: Date.now(), detail,
    otherUserId: other?.userId, otherUserName: other?.userName,
  };
  io.to(`analytics-feed:${managerId}`).emit(SocketEvents.ANALYTICS_ACTIVITY, payload);
}
