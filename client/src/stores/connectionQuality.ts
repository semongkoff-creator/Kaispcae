// Published connection quality, kept OUT of gameStore on purpose.
//
// This updates every few seconds for every connected peer, and gameStore is
// subscribed to by most of the app. Putting it there would re-render the whole
// tree on a tick that only two or three components care about — the same
// mistake remotePositions.ts documents for the proximity snapshot, which used
// to live in App state and re-rendered App's entire tree several times a
// second. Same fix, same shape: module state plus explicit subscribers.

import type { PeerQuality, SelfVerdict } from '@/services/connectionQuality';

const EMPTY: ReadonlyMap<string, PeerQuality> = new Map();
const UNKNOWN_SELF: SelfVerdict = { cause: 'unknown', level: 'unknown', affected: 0, total: 0 };

let peerQuality: ReadonlyMap<string, PeerQuality> = EMPTY;
let selfVerdict: SelfVerdict = UNKNOWN_SELF;

const listeners = new Set<() => void>();

export function subscribeConnectionQuality(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// useSyncExternalStore compares snapshots by REFERENCE and re-renders — then
// re-reads — whenever it changes. Returning a fresh object here would loop
// forever, so both getters hand back the stored value and publish() below is
// the only thing that ever swaps it.
export function getPeerQualitySnapshot(): ReadonlyMap<string, PeerQuality> {
  return peerQuality;
}

export function getSelfVerdictSnapshot(): SelfVerdict {
  return selfVerdict;
}

function peersUnchanged(next: ReadonlyMap<string, PeerQuality>): boolean {
  if (next.size !== peerQuality.size) return false;
  for (const [id, q] of next) {
    const prev = peerQuality.get(id);
    if (!prev || prev.level !== q.level || prev.relayed !== q.relayed) return false;
  }
  return true;
}

function selfUnchanged(next: SelfVerdict): boolean {
  return next.cause === selfVerdict.cause
    && next.level === selfVerdict.level
    && next.affected === selfVerdict.affected
    && next.total === selfVerdict.total;
}

/**
 * Swaps in a new sample and wakes subscribers — but only when something a
 * human could see actually moved. The sampler runs on a timer whether or not
 * anything changed, and a room sitting quietly at three bars should cost zero
 * renders. `bars` is not compared because it is derived from `level`.
 */
export function publishConnectionQuality(peers: ReadonlyMap<string, PeerQuality>, self: SelfVerdict): void {
  const same = peersUnchanged(peers) && selfUnchanged(self);
  peerQuality = peers;
  selfVerdict = self;
  if (same) return;
  for (const listener of listeners) listener();
}

/** Leaving a room must not carry the previous room's peers into the next one. */
export function clearConnectionQuality(): void {
  if (peerQuality === EMPTY && selfVerdict === UNKNOWN_SELF) return;
  peerQuality = EMPTY;
  selfVerdict = UNKNOWN_SELF;
  for (const listener of listeners) listener();
}
