import assert from 'node:assert/strict';
import { findTilePath, getCardinalWaypointTarget, simplifyPath, TileNode } from '../client/src/utils/pathfinding';

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

function assertNoDiagonalSegments(route: TileNode[]) {
  for (let i = 1; i < route.length; i++) {
    const prev = route[i - 1];
    const cur = route[i];
    const dx = Math.abs(cur.x - prev.x);
    const dy = Math.abs(cur.y - prev.y);
    assert.ok(dx === 0 || dy === 0, `diagonal segment from ${prev.x},${prev.y} to ${cur.x},${cur.y}`);
  }
}

test('click-to-move pathfinding avoids diagonal tile steps', () => {
  const path = findTilePath(0, 0, 2, 2, () => false, 4, 4);

  assert.ok(path);
  assert.equal(path.length, 4);
  assertNoDiagonalSegments([{ x: 0, y: 0 }, ...path]);
  assertNoDiagonalSegments([{ x: 0, y: 0 }, ...simplifyPath(path)]);
});

test('click-to-move targets one waypoint axis at a time', () => {
  assert.deepEqual(
    getCardinalWaypointTarget(34, 24, { x: 24, y: 120 }),
    { x: 34, y: 120 },
  );
  assert.deepEqual(
    getCardinalWaypointTarget(34, 117, { x: 24, y: 120 }),
    { x: 24, y: 117 },
  );
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} pathfinding test(s) passed`);
