import assert from 'node:assert/strict';
import { getKeyboardMovementInput } from '../client/src/hooks/useMovement';

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

test('WASD keyboard input never returns diagonal movement', () => {
  const input = getKeyboardMovementInput(new Set(['w', 'KeyW', 'd', 'KeyD']));

  assert.equal(input.dx, 1);
  assert.equal(input.dy, 0);
  assert.equal(input.direction, 'right');
  assert.equal(input.isMoving, true);
});

test('keyboard movement falls back to the remaining held axis after releasing the latest key', () => {
  const input = getKeyboardMovementInput(new Set(['w', 'KeyW']));

  assert.equal(input.dx, 0);
  assert.equal(input.dy, -1);
  assert.equal(input.direction, 'up');
  assert.equal(input.isMoving, true);
});

test('run key only applies while a cardinal movement key is active', () => {
  assert.equal(getKeyboardMovementInput(new Set(['ShiftLeft'])).isRunning, false);
  assert.equal(getKeyboardMovementInput(new Set(['ArrowLeft', 'ShiftLeft'])).isRunning, true);
});

test('idle keyboard input keeps the last facing direction', () => {
  const input = getKeyboardMovementInput(new Set(), 'left');

  assert.equal(input.dx, 0);
  assert.equal(input.dy, 0);
  assert.equal(input.direction, 'left');
  assert.equal(input.isMoving, false);
});

test('stale raw WASD key aliases do not force movement after keyup casing changes', () => {
  const staleUp = getKeyboardMovementInput(new Set(['W']), 'left');
  const staleDown = getKeyboardMovementInput(new Set(['s']), 'right');

  assert.equal(staleUp.isMoving, false);
  assert.equal(staleUp.direction, 'left');
  assert.equal(staleDown.isMoving, false);
  assert.equal(staleDown.direction, 'right');
});

test('stale raw run key aliases do not force sprint after keyup casing changes', () => {
  const input = getKeyboardMovementInput(new Set(['KeyW', 'R']));

  assert.equal(input.isMoving, true);
  assert.equal(input.isRunning, false);
});

test('stale raw shift alias does not force sprint after shift keyup is lost', () => {
  const input = getKeyboardMovementInput(new Set(['KeyW', 'Shift']));

  assert.equal(input.isMoving, true);
  assert.equal(input.isRunning, false);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} movement input test(s) passed`);
