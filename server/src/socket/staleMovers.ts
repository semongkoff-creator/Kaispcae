// Detection for players the server still believes are walking, but who have
// stopped telling it so.
//
// A client only ever stops being "moving" by SENDING a stop, and on the web
// client that emit lives inside the requestAnimationFrame loop — which
// browsers suspend entirely for a backgrounded tab. Switch tabs mid-stride
// and the frame that would have sent it never runs: the server keeps the
// player flagged as moving, and every other client keeps cycling their walk
// (or run) animation over a position that never changes again. An avatar
// jogging on the spot forever, with nothing in the system to clean it up —
// the flag only ever cleared on an explicit stop or on disconnect.
//
// Standalone module, no socket.io or @kaispace/shared imports, matching
// movementPayload.ts and movementSequence.ts — that is what keeps this
// directly testable (the shared barrel pulls in an ESM build of rrule that
// the test runner can't load).

export interface MoverEntry {
  room: string;
  lastMoveAt: number;
}

export interface StaleMover {
  socketId: string;
  room: string;
}

// ~16x the client's own 50ms send interval, so ordinary jitter or a brief
// packet-loss burst can never trip it. Being late here costs a second of
// stray animation; being early yanks a genuinely moving player backwards,
// so this deliberately errs long.
export const STALE_MOVE_TIMEOUT_MS = 800;
export const STALE_MOVE_SWEEP_INTERVAL_MS = 400;

/** Movers that have gone quiet long enough to be stopped on their behalf. */
export function collectStaleMovers(
  movers: ReadonlyMap<string, MoverEntry>,
  now: number,
  timeoutMs: number = STALE_MOVE_TIMEOUT_MS,
): StaleMover[] {
  const stale: StaleMover[] = [];
  for (const [socketId, entry] of movers) {
    if (now - entry.lastMoveAt >= timeoutMs) stale.push({ socketId, room: entry.room });
  }
  return stale;
}
