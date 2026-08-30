// Converts server timestamps into this client's own clock.
//
// Every movement broadcast already carries `serverTime` (see
// movementHandler.ts), but the interpolation buffer used to timestamp
// snapshots with Date.now() at the moment the packet ARRIVED. That bakes
// network jitter straight into the playback timeline: two positions sent
// 50ms apart but delivered 15ms apart get replayed 3x too fast and then
// stall — which is exactly what "orang lain patah-patah walau ping bagus"
// looks like. The server's own send times are evenly spaced by
// construction, so replaying against them removes the jitter instead of
// rendering it.
//
// The two clocks aren't the same clock, so server times have to be shifted
// onto ours before they can be compared with Date.now():
//
//   receivedAt = serverTime + oneWayLatency + clockSkew
//   offset    := receivedAt - serverTime = oneWayLatency + clockSkew
//
// Every sample of `offset` is inflated by that packet's own latency, so the
// SMALLEST observed offset is the best available estimate of the true skew
// (it's the sample that got through fastest). A rolling window, rather than
// an all-time minimum, so the estimate can still follow genuine clock drift
// and route changes instead of being pinned forever by one lucky packet.

// ~10s of movement traffic at 20 packets/sec. Long enough that a fast
// packet almost certainly appears in it, short enough to track drift.
const WINDOW_SIZE = 200;

let offsets: number[] = [];
let cachedOffset: number | null = null;

// The estimate above can move in a step — the moment a faster-than-ever
// packet lands, the minimum drops by however much faster it was. Applying
// that step directly rewrites the playback timeline underneath the
// interpolation buffer: every snapshot that arrives after it is mapped
// EARLIER than the ones already buffered, so playback (which trails real
// time by a fixed delay) suddenly finds itself past the newest snapshot —
// the avatar freezes until fresh packets catch up. A large enough step also
// maps a new snapshot before the previous one, and appendMovementSnapshot
// correctly rejects it as out-of-order, so the position is simply lost.
//
// So the estimate is tracked exactly (currentClockOffset, and it is what
// eventually gets applied) while what's APPLIED slews toward it at a bounded
// rate. 50ms per second is far quicker than any real clock drift, and slow
// enough that within one player's ~30-67ms packet spacing the timeline never
// moves more than a couple of milliseconds — comfortably order-preserving.
const OFFSET_SLEW_PER_MS = 0.05;
let appliedOffset: number | null = null;
let appliedAt = 0;

/** Forget everything — the server clock is no longer comparable after a
 *  reconnect (possibly a different server process entirely). */
export function resetServerClock(): void {
  offsets = [];
  cachedOffset = null;
  appliedOffset = null;
  appliedAt = 0;
}

/**
 * Places a server timestamp on the client's clock.
 *
 * Falls back to `receivedAt` when the packet carries no usable serverTime
 * (an older server, or an event that never had the field) — that's the old
 * jitter-prone behaviour, but it's strictly better than dropping the
 * snapshot, and it keeps this safe to roll out against a server that hasn't
 * been redeployed yet.
 */
export function serverTimeToClient(serverTime: number | undefined, receivedAt: number): number {
  if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) return receivedAt;

  const offset = receivedAt - serverTime;
  offsets.push(offset);
  const evicted = offsets.length > WINDOW_SIZE ? offsets.shift() : undefined;

  // A plain running minimum would only ever decrease, so one anomalously
  // low sample (a clock step, a tab resuming from suspend) would pin the
  // timeline for the rest of the session. Letting samples age out fixes
  // that, but only if the minimum is recomputed when the reigning one is
  // the sample that just left — hence the two branches. Recomputing
  // unconditionally would mean an O(WINDOW_SIZE) scan on every packet of
  // every player, which is exactly the kind of per-packet cost this whole
  // effort is trying to remove.
  if (cachedOffset === null || offset < cachedOffset) {
    cachedOffset = offset;
  } else if (evicted !== undefined && evicted === cachedOffset) {
    cachedOffset = Math.min(...offsets);
  }

  // First sample of a connection has nothing to slew from — a brand-new
  // timeline can start wherever it likes, there is no buffered playback for
  // it to disagree with yet.
  if (appliedOffset === null) {
    appliedOffset = cachedOffset;
  } else if (appliedOffset !== cachedOffset) {
    const maxStep = Math.max(1, (receivedAt - appliedAt) * OFFSET_SLEW_PER_MS);
    const delta = cachedOffset - appliedOffset;
    appliedOffset += Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
  }
  appliedAt = receivedAt;

  return serverTime + appliedOffset;
}

/** Test seam — the current skew estimate, or null before any sample. */
export function currentClockOffset(): number | null {
  return cachedOffset;
}

/** Test seam — the offset actually in use, which slews toward the estimate
 *  rather than snapping to it (see OFFSET_SLEW_PER_MS). */
export function appliedClockOffset(): number | null {
  return appliedOffset;
}
