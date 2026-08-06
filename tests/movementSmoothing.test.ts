import assert from 'node:assert/strict';
import { appendMovementSnapshot, sampleMovementSnapshots } from '../client/src/stores/movementSmoothing';

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

test('movement smoothing interpolates between buffered snapshots', () => {
  let snapshots = appendMovementSnapshot([], { x: 0, y: 0, receivedAt: 1000 });
  snapshots = appendMovementSnapshot(snapshots, { x: 100, y: 50, receivedAt: 1100 });

  const sample = sampleMovementSnapshots(snapshots, 1050);

  assert.equal(sample?.x, 50);
  assert.equal(sample?.y, 25);
  assert.equal(sample?.done, false);
});

test('movement smoothing marks a final lone snapshot done after render time reaches it', () => {
  const snapshots = appendMovementSnapshot([], { x: 96, y: 120, receivedAt: 1000 });

  const sample = sampleMovementSnapshots(snapshots, 1000);

  assert.equal(sample?.x, 96);
  assert.equal(sample?.y, 120);
  assert.equal(sample?.done, true);
});

test('movement smoothing drops out-of-order snapshots', () => {
  let snapshots = appendMovementSnapshot([], { x: 10, y: 10, receivedAt: 1000 });
  snapshots = appendMovementSnapshot(snapshots, { x: 20, y: 20, receivedAt: 900 });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].x, 10);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} movement smoothing test(s) passed`);
