import assert from 'node:assert/strict';
import { serverTimeToClient, resetServerClock, currentClockOffset } from '../client/src/stores/serverClock';
import { proximityUnchanged } from '../client/src/hooks/useProximity';
import { sampleMovementSnapshots } from '../client/src/stores/movementSmoothing';
import {
  pushRemoteSnapshot, snapRemotePosition, forgetRemotePlayer, clearRemotePositions,
  interpolateRemotePositions, livePlayers, remotePos, pendingSnapshotCount,
} from '../client/src/stores/remotePositions';
import { ProximityPlayer } from '../shared/types';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

// ── S1: server clock ──────────────────────────────────────────────────────

test('server timestamps replay evenly despite jittery arrival', () => {
  resetServerClock();
  // Server sends every 50ms on the dot; the network delivers them 80ms,
  // 20ms, then 95ms apart. Before this fix the snapshots inherited those
  // arrival gaps and the avatar lurched.
  const sent = [1000, 1050, 1100, 1150];
  const arrived = [5000, 5080, 5100, 5195];
  const mapped = sent.map((s, i) => serverTimeToClient(s, arrived[i]));

  for (let i = 1; i < mapped.length; i++) {
    assert.equal(mapped[i] - mapped[i - 1], 50, `gap ${i} should stay 50ms`);
  }
});

test('server clock estimates skew from the fastest packet seen', () => {
  resetServerClock();
  // Latencies of 200ms, 40ms, 120ms over a constant skew of 4000ms.
  serverTimeToClient(1000, 1000 + 4000 + 200);
  serverTimeToClient(1050, 1050 + 4000 + 40);
  serverTimeToClient(1100, 1100 + 4000 + 120);
  assert.equal(currentClockOffset(), 4040, 'should settle on skew + minimum latency');
});

test('server clock falls back to arrival time when serverTime is absent', () => {
  resetServerClock();
  assert.equal(serverTimeToClient(undefined, 7777), 7777);
  assert.equal(currentClockOffset(), null, 'a missing timestamp must not pollute the estimate');
});

test('server clock forgets the previous connection on reset', () => {
  resetServerClock();
  serverTimeToClient(1000, 9000); // offset 8000
  assert.equal(currentClockOffset(), 8000);
  resetServerClock();
  serverTimeToClient(1000, 1200); // fresh connection, offset 200
  assert.equal(currentClockOffset(), 200, 'stale skew must not survive a reconnect');
});

// ── S6: teleport snaps instead of sliding ─────────────────────────────────

test('replacing the snapshot buffer lands the avatar at the destination', () => {
  // What resetPlayerTarget builds: one snapshot, stamped now.
  const now = 10_000;
  const buffer = [{ x: 999, y: 42, receivedAt: now }];
  // renderTime trails by REMOTE_MOVEMENT_RENDER_DELAY_MS, so it sits BEFORE
  // the snapshot — the case that must still report the destination.
  const sample = sampleMovementSnapshots(buffer, now - 120);
  assert.equal(sample?.x, 999);
  assert.equal(sample?.y, 42);
});

test('appending instead of replacing would have slid across the map', () => {
  // Guards the regression itself: this is what the old teleport path did.
  const appended = [
    { x: 0, y: 0, receivedAt: 1000 },
    { x: 1000, y: 0, receivedAt: 1100 },
  ];
  const midway = sampleMovementSnapshots(appended, 1050);
  assert.equal(midway?.x, 500, 'appending really does interpolate — hence resetPlayerTarget');
});

// ── Fase 4: proximity change detection ────────────────────────────────────

const peer = (id: string, distanceTiles: number, visibility: ProximityPlayer['visibility'], viaZone?: boolean): ProximityPlayer =>
  ({ id, distanceTiles, visibility, ...(viaZone === undefined ? {} : { viaZone }) });

test('proximity comparison ignores sub-threshold drift', () => {
  const a = [peer('a', 1.000, 'full_visible')];
  const b = [peer('a', 1.005, 'full_visible')];
  assert.equal(proximityUnchanged(a, b), true);
});

test('proximity comparison catches a visibility flip', () => {
  const a = [peer('a', 3.0, 'full_visible')];
  const b = [peer('a', 3.1, 'translucent')];
  assert.equal(proximityUnchanged(a, b), false);
});

test('proximity comparison catches real movement', () => {
  const a = [peer('a', 1.0, 'full_visible')];
  const b = [peer('a', 1.4, 'full_visible')];
  assert.equal(proximityUnchanged(a, b), false, 'a 0.4 tile move changes the gain audibly');
});

test('proximity comparison catches someone arriving or leaving', () => {
  const a = [peer('a', 1, 'full_visible')];
  assert.equal(proximityUnchanged(a, [...a, peer('b', 2, 'translucent')]), false);
  assert.equal(proximityUnchanged(a, []), false);
});

test('proximity comparison catches a zone override toggling', () => {
  const a = [peer('a', 9, 'full_visible', true)];
  const b = [peer('a', 9, 'full_visible', false)];
  assert.equal(proximityUnchanged(a, b), false);
});

// ── Remote position buffers, now outside the store ────────────────────────

const present = () => true;

test('interpolation places a player between two buffered snapshots', () => {
  clearRemotePositions();
  const now = Date.now();
  // Straddle the 120ms render delay: one snapshot before it, one after.
  pushRemoteSnapshot('p1', 0, 0, now - 220);
  pushRemoteSnapshot('p1', 100, 200, now - 20);
  interpolateRemotePositions(present);

  const pos = livePlayers.get('p1');
  assert.ok(pos, 'expected an interpolated position');
  assert.ok(pos!.x > 0 && pos!.x < 100, `x should be mid-flight, got ${pos!.x}`);
  assert.ok(pos!.y > 0 && pos!.y < 200, `y should be mid-flight, got ${pos!.y}`);
});

test('a finished movement retires its buffer but keeps the resting position', () => {
  clearRemotePositions();
  const old = Date.now() - 5000;
  pushRemoteSnapshot('p1', 10, 10, old);
  pushRemoteSnapshot('p1', 64, 96, old + 50);
  interpolateRemotePositions(present);

  assert.deepEqual(livePlayers.get('p1'), { x: 64, y: 96 }, 'should settle on the final snapshot');
  assert.equal(pendingSnapshotCount(), 0, 'buffer should be retired once played out');
});

test('a departed player leaves nothing behind', () => {
  clearRemotePositions();
  pushRemoteSnapshot('gone', 5, 5, Date.now() - 500);
  interpolateRemotePositions((id) => id !== 'gone');
  assert.equal(pendingSnapshotCount(), 0, 'buffer for an absent player must be pruned');
});

test('snapping drops the in-flight buffer so a teleport cannot slide', () => {
  clearRemotePositions();
  const now = Date.now();
  pushRemoteSnapshot('p1', 0, 0, now - 220);
  pushRemoteSnapshot('p1', 1000, 0, now - 20);
  snapRemotePosition('p1', 480, 480);
  assert.equal(pendingSnapshotCount(), 0, 'the pre-teleport buffer must be gone');

  // A later tick must not drag the avatar back toward the old destination.
  interpolateRemotePositions(present);
  assert.deepEqual(livePlayers.get('p1'), { x: 480, y: 480 });
});

test('the live position overrides the record it belongs to', () => {
  clearRemotePositions();
  const record = { id: 'p1', x: 0, y: 0 };
  assert.deepEqual(remotePos(record), record, 'no entry yet — fall back to the record');
  snapRemotePosition('p1', 33, 44);
  assert.deepEqual(remotePos(record), { x: 33, y: 44 });
  forgetRemotePlayer('p1');
  assert.deepEqual(remotePos(record), record, 'forgetting restores the fallback');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} movement lag test(s) passed`);
