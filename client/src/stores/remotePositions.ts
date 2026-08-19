import { MovementSnapshot, appendMovementSnapshot, sampleMovementSnapshots } from './movementSmoothing';

// Interpolated positions for everyone else, held outside React.
//
// interpolatePlayers used to write these straight into the store's
// playerRecords, 60 times a second, for as long as ANYONE in the room was
// walking. That handed React a new records object at frame rate and
// re-rendered every subscriber — App.tsx included — even when the local
// player was standing perfectly still. It is the reason the room felt
// heavier the more people were in it.
//
// Positions are read by the render loop and by proximity, neither of which
// is a React subscriber, so none of it needs to live in the store. What
// stays in the store is playerRecords: identity and status (name, colour,
// speaking, sitting, hidden), which change on real events rather than on
// every animation frame.
//
// An entry here always wins over the record's own x/y. Every path that
// moves someone maintains it: normal movement through the snapshot buffer,
// teleports and sits through snapRemotePosition, leaving through
// forgetRemotePlayer. A player with no entry yet (just joined, hasn't moved)
// simply falls back to their record.
export const livePlayers = new Map<string, { x: number; y: number }>();

// Per-player snapshot buffers, feeding the interpolation above.
//
// These lived in the store until now, which cost far more than it looked:
// every PLAYER_MOVED packet ran a zustand set(), and a set() rebuilds the
// whole state object (252 keys) and then re-evaluates every one of the ~207
// selectors subscribed across the app. In a twenty-person room that is ~400
// packets a second — roughly 100k property copies and 83k selector calls per
// second — to update a value NO component ever subscribed to. The store was
// pure overhead on this path.
const targets = new Map<string, MovementSnapshot[]>();

// Rendering trails receipt by this much so there is always a snapshot on
// either side of the render time to interpolate between; without it every
// position would be a hard jump to the newest packet.
const REMOTE_MOVEMENT_RENDER_DELAY_MS = 120;

/** A newly received position for this player, in client-clock time. */
export function pushRemoteSnapshot(id: string, x: number, y: number, at: number): void {
  targets.set(id, appendMovementSnapshot(targets.get(id) ?? [], { x, y, receivedAt: at }));
}

/**
 * Advances every player's interpolated position to now. Called once per
 * animation frame by the render loop, and again from the proximity tick so
 * positions keep moving while the tab is hidden and rAF is parked.
 *
 * `isPresent` prunes buffers belonging to players who are no longer in the
 * room — a stale buffer would otherwise keep writing a live position for
 * someone who left.
 */
export function interpolateRemotePositions(isPresent: (id: string) => boolean): void {
  const renderTime = Date.now() - REMOTE_MOVEMENT_RENDER_DELAY_MS;

  for (const [id, snapshots] of targets) {
    if (!isPresent(id) || !snapshots.length) {
      targets.delete(id);
      continue;
    }
    const sample = sampleMovementSnapshots(snapshots, renderTime);
    if (!sample) {
      targets.delete(id);
      continue;
    }
    // Deliberately NOT deleted once done — the entry stays as this player's
    // resting position so readers keep preferring it over the record's own
    // x/y, which may still be a frame or two behind.
    livePlayers.set(id, { x: sample.x, y: sample.y });
    if (sample.done) targets.delete(id);
  }
}

/** Position to draw this player at — the interpolated one if we have it. */
export function remotePos<T extends { id: string; x: number; y: number }>(player: T): { x: number; y: number } {
  return livePlayers.get(player.id) ?? player;
}

/**
 * Teleport, sit, or any other hard jump: no gliding, just be there.
 *
 * Drops the snapshot buffer as well as setting the position — leaving it in
 * place would let the next interpolation tick drag the avatar back toward
 * wherever it was heading before the jump.
 */
export function snapRemotePosition(id: string, x: number, y: number): void {
  targets.delete(id);
  livePlayers.set(id, { x, y });
}

export function forgetRemotePlayer(id: string): void {
  livePlayers.delete(id);
  targets.delete(id);
}

export function clearRemotePositions(): void {
  livePlayers.clear();
  targets.clear();
}

/** Test seam — how many players still have movement left to play out. */
export function pendingSnapshotCount(): number {
  return targets.size;
}

// Latest proximity result, mirrored outside React.
//
// The canvas reads this every frame to tint/hide distant avatars. It used to
// arrive as a prop, which meant a brand new array on the component every
// time proximity was recomputed — enough on its own to defeat any memo()
// around GameCanvas, however stable the rest of its props were. Mirroring it
// here lets the render loop read it directly (it was already copying it into
// a ref) while React consumers that genuinely re-render on it — the video
// grid, the meeting view — keep using the state copy in App.
let proximity: import('@virtualmeet/shared').ProximityPlayer[] = [];

export function setProximitySnapshot(next: import('@virtualmeet/shared').ProximityPlayer[]): void {
  proximity = next;
}

export function getProximitySnapshot(): import('@virtualmeet/shared').ProximityPlayer[] {
  return proximity;
}
