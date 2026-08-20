// Detects two live connections for one account fighting over it.
//
// JOIN_ROOM enforces "one account, one live socket" by disconnecting whatever
// socket held the uid before. That is correct, and on a client that accepts the
// verdict it costs exactly one takeover. But a client that reconnects after
// being disconnected re-runs JOIN_ROOM, takes the account back, and the socket
// that just won gets disconnected in turn — a ping-pong where every round
// broadcasts a join AND a leave to every other client in the room. Each of
// those makes all of them drop a player record, rebuild it under a fresh socket
// id, refetch a profile photo, and tear down and rebuild a peer connection. Two
// tabs belonging to one person degrade the room for everyone in it.
//
// The client half of this is fixed (a superseded socket stops reconnecting),
// but that fix only helps clients that have loaded it. One person on a stale
// tab is enough to keep the whole room churning, and asking twenty people to
// hard-reload in unison is not a plan. So the server stops honouring a takeover
// that is obviously a fight rather than a handover.
//
// Note what does NOT trip this: an ordinary reload. The old socket is already
// gone by the time the new one joins, so there is no live socket to supersede
// and nothing is recorded. Only genuinely concurrent sockets can flap.

const FLAP_WINDOW_MS = 15_000;
// Opening a second tab causes exactly one takeover. Deliberately generous
// beyond that, because a genuinely bad network can also produce repeated
// takeovers: the old socket has not timed out server-side yet (ping timeout is
// 20s) while the client is already back on a new one. Five inside fifteen
// seconds is no longer a reconnect pattern — it is two live sockets fighting.
const FLAP_LIMIT = 4;

const history = new Map<string, number[]>();

/**
 * Records a takeover for `uid` and reports whether this account is flapping.
 *
 * `now` is injected rather than read from the clock so this is testable
 * without waiting fifteen seconds.
 */
export function recordSupersede(uid: string, now: number = Date.now()): boolean {
  const cutoff = now - FLAP_WINDOW_MS;
  const recent = (history.get(uid) ?? []).filter((t) => t > cutoff);
  recent.push(now);
  history.set(uid, recent);

  // Opportunistic sweep: without it, every uid that ever joined keeps an entry
  // for the lifetime of the process.
  if (history.size > 500) {
    for (const [key, times] of history) {
      if (!times.length || times[times.length - 1] <= cutoff) history.delete(key);
    }
  }

  return recent.length > FLAP_LIMIT;
}

/** Test seam, and the right thing to call if a uid legitimately resets (an
 *  explicit leave, a kick) — the count should not follow them around. */
export function forgetSupersedes(uid?: string): void {
  if (uid === undefined) history.clear();
  else history.delete(uid);
}

export const __flapConfig = { FLAP_WINDOW_MS, FLAP_LIMIT };
