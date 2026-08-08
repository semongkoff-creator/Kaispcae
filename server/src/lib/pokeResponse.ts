import { PrismaClient } from '@prisma/client';

// v2 Bagian B.4's "response time to poke" Vibe component. In-memory only
// (same caveat as every other in-memory cache in this codebase — fine for
// a single server process): `recordPokeReceived` stamps when a poke lands,
// `recordResponseIfPending` closes it out at whichever already-instrumented
// action fires next (chat send, emote, work-mode change — see call sites).
// A poke that never gets a qualifying response within PENDING_TIMEOUT_MS is
// discarded entirely and never written anywhere — silence isn't a signal
// here, only an actual response is.
const PENDING_TIMEOUT_MS = 10 * 60 * 1000;
const pendingPokes = new Map<string, number>();

export function recordPokeReceived(userId: string): void {
  pendingPokes.set(userId, Date.now());
}

export async function recordResponseIfPending(prisma: PrismaClient, userId: string): Promise<void> {
  const receivedAt = pendingPokes.get(userId);
  if (receivedAt === undefined) return;
  // Consumed either way — one qualifying action closes out one pending
  // poke, whether or not it ends up written (stale ones are discarded, not
  // left to be "double closed" by the NEXT action too).
  pendingPokes.delete(userId);
  const latencyMs = Date.now() - receivedAt;
  if (latencyMs > PENDING_TIMEOUT_MS) return;
  await prisma.pokeResponseSample.create({ data: { userId, latencyMs } });
}
