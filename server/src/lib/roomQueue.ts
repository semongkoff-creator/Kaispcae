import { PrismaClient, Prisma } from '@prisma/client';

// "Ngobrol dengan CEO" queue — DB-only mechanics (see schema.prisma's
// RoomQueueEntry doc comment for the full status lifecycle). Deliberately
// has no `io`/socket dependency: callers that need to notify/kick a live
// socket (roomHandler.ts, queueSweep.ts, routes/roomMembers.ts) do that
// themselves after calling into here, keeping this file a pure DB layer
// that's trivial to unit-test and can't accidentally import roomHandler.ts
// (which itself imports resolveEntry, which will soon import this file).

// The requester picks their own duration when filling the form — not the
// admin (explicit product decision) — but an unbounded pick would let one
// person book the room for the whole day and starve everyone behind them.
export const QUEUE_MIN_MINUTES = 5;
export const QUEUE_MAX_MINUTES = 120;

// How long a "called" ticket stays valid before counting as a no-show and
// getting skipped. Generous on purpose — this is "walk from your desk to
// the room," not "be at your keyboard right now."
export const QUEUE_CALL_GRACE_MS = 5 * 60 * 1000;

// Transition a 'called' entry to 'active' the moment its holder actually
// enters the room/zone (called from roomHandler.ts's JOIN_ROOM for a
// room-level queue, or zoneHandler.ts's ZONE_ENTER for a zone-level one,
// right after the entry check grants them in) — NOT the moment they were
// called. The gap between being called and actually walking in must not eat
// into their paid time. A no-op if the entry is already 'active' (a
// reconnect mid-session must never reset the clock) or gone entirely
// (skipped/cancelled out from under them — the caller's own entry check
// would have already denied that case before this is ever reached).
//
// `zoneId`: null for a room-level queue, a Zone.id for a zone-level one —
// see RoomQueueEntry's own doc comment for why the two never collide.
export async function admitCalledEntry(prisma: PrismaClient, roomId: string, zoneId: string | null, userId: string): Promise<void> {
  const entry = await prisma.roomQueueEntry.findFirst({ where: { roomId, zoneId, userId, status: 'called' } });
  if (!entry) return;
  const now = new Date();
  await prisma.roomQueueEntry.update({
    where: { id: entry.id },
    data: { status: 'active', startedAt: now, endsAt: new Date(now.getTime() + entry.durationMin * 60000) },
  });
}

// Pull the next 'waiting' entry into 'called' if the room/zone's single slot
// is currently free. Call this after anything that could free or fill the
// slot: a session ending (naturally, early, or skipped), a no-show
// expiring, or a fresh join landing in an empty queue. Returns the
// newly-called entry (for a caller that wants to best-effort notify them)
// or null if the slot is still occupied / nobody is waiting.
//
// Bug fix — two people submitting the join form (or two independent
// triggers, e.g. the 20s sweep firing right as someone leaves early) around
// the same moment could both read "nobody occupied" before either write
// landed, then each call a DIFFERENT waiting entry — letting two people
// think they were admitted into a slot that's only supposed to hold one.
// The occupied-check + call-next now run inside a single SERIALIZABLE
// transaction, so Postgres itself aborts whichever of two racing callers
// would have double-booked the slot (caught below and treated as a no-op —
// same "opportunistic, the next sweep tick will catch it" posture this
// function already had, not a real failure worth surfacing to the caller).
export async function advanceQueue(prisma: PrismaClient, roomId: string, zoneId: string | null): Promise<{ userId: string; name: string } | null> {
  // "Ngobrol dengan CEO" queue, zone-level — now requires an explicit admin
  // approval (see routes/roomMembers.ts's new /queue/:entryId/approve)
  // instead of being auto-promoted, so this is a no-op for every zone-level
  // queue. Room-level (zoneId === null) is untouched — it still auto-
  // advances FCFS exactly as before.
  if (zoneId !== null) return null;
  try {
    return await prisma.$transaction(async (tx) => {
      const occupied = await tx.roomQueueEntry.findFirst({ where: { roomId, zoneId, status: { in: ['called', 'active'] } } });
      if (occupied) return null;
      const next = await tx.roomQueueEntry.findFirst({
        where: { roomId, zoneId, status: 'waiting' },
        orderBy: { requestedAt: 'asc' },
      });
      if (!next) return null;
      await tx.roomQueueEntry.update({ where: { id: next.id }, data: { status: 'called', calledAt: new Date() } });
      return { userId: next.userId, name: next.name };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (e) {
    console.warn('[queue] advanceQueue lost a race (safe to ignore, sweep will retry):', e);
    return null;
  }
}
