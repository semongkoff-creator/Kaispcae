import assert from 'node:assert/strict';
import { createStoppedPayload } from './movementPayload';

// Movement tests. This repo has no test runner, so this file is a plain
// self-checking script:
//
//     npx tsx server/src/socket/movementHandler.test.ts
//
// It exits non-zero on the first failed assertion.

const TILE_SIZE = 48;

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

test('player stop payload includes authoritative final position', () => {
  const payload = createStoppedPayload(
    'socket-a',
    { x: TILE_SIZE * 2, y: TILE_SIZE * 3, direction: 'right' },
    { mapWidth: 50, mapHeight: 36, tileSize: TILE_SIZE },
  );

  assert.deepEqual(payload, { id: 'socket-a', x: TILE_SIZE * 2, y: TILE_SIZE * 3, direction: 'right' });
});

test('player stop payload clamps impossible positions to map bounds', () => {
  const payload = createStoppedPayload(
    'socket-a',
    { x: -999, y: 99999, direction: 'left' },
    { mapWidth: 50, mapHeight: 36, tileSize: TILE_SIZE },
  );

  assert.deepEqual(payload, {
    id: 'socket-a',
    x: TILE_SIZE / 2,
    y: 36 * TILE_SIZE - TILE_SIZE / 2,
    direction: 'left',
  });
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} movement test(s) passed`);
