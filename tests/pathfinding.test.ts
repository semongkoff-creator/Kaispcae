import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findFollowRouteTarget, findTilePath, getCardinalWaypointTarget, simplifyPath, TileNode } from '../client/src/utils/pathfinding';

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

test('waypoint targeting stops inside the snap box instead of taking a diagonal cleanup step', () => {
  assert.deepEqual(
    getCardinalWaypointTarget(77, 45, { x: 80, y: 48 }),
    { x: 77, y: 45 },
  );
});

test('follow route targets the trailing tile through cardinal pathfinding', () => {
  const result = findFollowRouteTarget({
    currentX: 16,
    currentY: 16,
    targetX: 80,
    targetY: 80,
    targetDirection: 'down',
    blocked: (tileX, tileY) => tileX === 1 && tileY === 0,
    cols: 4,
    rows: 4,
    tileSize: 32,
    route: { targetTile: null, waypoints: null },
  });

  assert.deepEqual(result.route.targetTile, { x: 2, y: 1 });
  assert.deepEqual(result.route.waypoints, [
    { x: 16, y: 48 },
    { x: 80, y: 48 },
  ]);
  assert.deepEqual(result.axisTarget, { x: 16, y: 48 });
});

test('follow route caches unreachable paths briefly instead of pathfinding every frame', () => {
  let blockedCalls = 0;
  const blocked = (tileX: number, tileY: number) => {
    blockedCalls++;
    return (tileX === 1 && tileY === 0) || (tileX === 0 && tileY === 1);
  };

  const first = findFollowRouteTarget({
    currentX: 16,
    currentY: 16,
    targetX: 80,
    targetY: 80,
    targetDirection: 'down',
    blocked,
    cols: 4,
    rows: 4,
    tileSize: 32,
    route: { targetTile: null, waypoints: null },
    nowMs: 1000,
    failedRetryMs: 500,
  });
  const afterFirst = blockedCalls;

  const second = findFollowRouteTarget({
    currentX: 16,
    currentY: 16,
    targetX: 80,
    targetY: 80,
    targetDirection: 'down',
    blocked,
    cols: 4,
    rows: 4,
    tileSize: 32,
    route: first.route,
    nowMs: 1100,
    failedRetryMs: 500,
  });
  assert.equal(blockedCalls, afterFirst);
  assert.equal(second.axisTarget, null);

  findFollowRouteTarget({
    currentX: 16,
    currentY: 16,
    targetX: 80,
    targetY: 80,
    targetDirection: 'down',
    blocked,
    cols: 4,
    rows: 4,
    tileSize: 32,
    route: second.route,
    nowMs: 1600,
    failedRetryMs: 500,
  });
  assert.ok(blockedCalls > afterFirst);
});

test('click-to-move starts from a single canvas click', () => {
  const gameCanvas = readFileSync('client/src/components/canvas/GameCanvas.tsx', 'utf8');

  assert.match(gameCanvas, /addEventListener\('click', onCanvasClick\)/);
  assert.match(gameCanvas, /removeEventListener\('click', onCanvasClick\)/);
  assert.doesNotMatch(gameCanvas, /addEventListener\('dblclick'/);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} pathfinding test(s) passed`);
