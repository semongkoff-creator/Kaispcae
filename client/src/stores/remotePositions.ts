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

// When interpolateRemotePositions last ran, for the catch-up limiter below.
let lastInterpolatedAt = 0;

import { PLAYER_RUN_SPEED, TILE_SIZE } from '@virtualmeet/shared';

// Rendering trails receipt by this much so there is always a snapshot on
// either side of the render time to interpolate between; without it every
// position would be a hard jump to the newest packet.
//
// Sized against how far apart packets actually arrive, which is NOT the
// sender's 50ms throttle: a sender only emits from inside its own animation
// frame (see GameCanvas's draw loop), so the real spacing is one frame
// rounded up past 50ms — 50-67ms on a healthy client, and whatever their
// frame time is on a struggling one. At the old 120ms this buffer held
// barely two packets, so a single late or dropped one (PLAYER_MOVE is sent
// volatile — the server may never see it at all) left playback past the end
// of the buffer, and the avatar froze until the next packet landed and then
// jumped to it. 200ms holds three or four, which absorbs one hiccup
// entirely, at the cost of seeing everyone else 80ms further in the past —
// invisible when nothing in this app is aimed or timed against another
// player's exact position.
const REMOTE_MOVEMENT_RENDER_DELAY_MS = 200;

// Ceiling on how fast a rendered position may be dragged toward its
// interpolated target, and the error past which it stops being dragged and
// simply teleports.
//
// Interpolation output is not continuous across every event: playback
// running past the end of the buffer and then resuming, a clock-offset
// correction, a stop packet arriving with an authoritative position — each
// can move the target several pixels in a single frame, which reads as the
// avatar twitching. Catching up at a bounded speed turns each of those into
// a brief glide instead. The ceiling sits ABOVE run speed on purpose: a
// player's own motion is never limited by it (it would otherwise trail
// permanently behind anyone sprinting), only discontinuities are.
const MAX_CATCHUP_SPEED_PX_PER_S = PLAYER_RUN_SPEED * 1.6;
// Past this, catching up smoothly would mean sliding across the room in
// plain view — a teleport, a spawn, or a server correction, all of which
// should just be where they say they are.
const CATCHUP_SNAP_PX = TILE_SIZE * 4;

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
export function interpolateRemotePositions(isPresent: (id: string) => boolean, nowMs?: number): void {
  // nowMs is a test seam — production always passes nothing and gets the
  // wall clock, which is the only thing that can be compared with the
  // snapshot timestamps serverClock.ts produces.
  const now = nowMs ?? Date.now();
  const renderTime = now - REMOTE_MOVEMENT_RENDER_DELAY_MS;
  // Wall clock, not a frame counter: this is driven by the render loop AND by
  // the proximity tick (which is what keeps positions advancing while the tab
  // is hidden), so the interval between calls is anything from 16ms to 200ms.
  const elapsedMs = lastInterpolatedAt === 0 ? 0 : Math.max(0, now - lastInterpolatedAt);
  lastInterpolatedAt = now;
  const maxCatchupPx = (MAX_CATCHUP_SPEED_PX_PER_S * elapsedMs) / 1000;

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
    const next = catchUp(livePlayers.get(id), sample, maxCatchupPx);
    livePlayers.set(id, next);
    // Retired only once the avatar has actually ARRIVED, not merely once
    // playback has run out of snapshots to interpolate — dropping the buffer
    // while catch-up is still closing a gap would freeze the avatar wherever
    // the glide had got to, permanently short of the last position anyone
    // reported for them.
    if (sample.done && next.x === sample.x && next.y === sample.y) targets.delete(id);
  }
}

/** Bounded move from where this player is currently drawn toward where
 *  interpolation says they should be — see MAX_CATCHUP_SPEED_PX_PER_S. */
function catchUp(
  current: { x: number; y: number } | undefined,
  target: { x: number; y: number },
  maxCatchupPx: number,
): { x: number; y: number } {
  // Nothing on screen yet (first packet since joining, or since a teleport
  // dropped the entry) — there is no continuity to preserve.
  if (!current) return { x: target.x, y: target.y };
  // No time has passed — this is the render loop and the proximity tick
  // landing in the same millisecond. Hold, rather than treating a zero
  // budget as permission to jump the whole way.
  if (maxCatchupPx <= 0) return current;

  const dx = target.x - current.x;
  const dy = target.y - current.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return current;
  if (distance > CATCHUP_SNAP_PX || distance <= maxCatchupPx) return { x: target.x, y: target.y };

  const t = maxCatchupPx / distance;
  return { x: current.x + dx * t, y: current.y + dy * t };
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
  lastInterpolatedAt = 0;
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
