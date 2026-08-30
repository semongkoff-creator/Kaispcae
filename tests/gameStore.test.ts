import assert from 'node:assert/strict';
import { useGameStore } from '../client/src/stores/gameStore';
import { truncateName } from '../client/src/utils/truncateName';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Avatar } from '../shared/types';

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

// ── The crash: a nameless avatar record killed the render loop ────────────

test('a movement packet for an unknown player does not conjure a record', () => {
  const store = useGameStore.getState();
  store.setPlayerRecords({});
  // Exactly what useSocket's PLAYER_MOVED handler sends — a cast, so nothing
  // type-checked that `name` is missing.
  store.upsertPlayer({ id: 'ghost', direction: 'down', isMoving: true, isRunning: false } as Avatar);
  assert.equal(useGameStore.getState().playerRecords.ghost, undefined,
    'a half-record with no name is what the renderer then tried to draw');
});

test('a real join is still accepted, and later movement still updates it', () => {
  const store = useGameStore.getState();
  store.setPlayerRecords({});
  store.upsertPlayer({ id: 'p1', name: 'Ravka', direction: 'down', isMoving: false } as Avatar);
  assert.equal(useGameStore.getState().playerRecords.p1?.name, 'Ravka');

  // Movement for a player we DO know must still apply — the guard must not
  // turn into "status updates never work".
  store.upsertPlayer({ id: 'p1', direction: 'left', isMoving: true, isRunning: true } as Avatar);
  const p1 = useGameStore.getState().playerRecords.p1;
  assert.equal(p1?.direction, 'left');
  assert.equal(p1?.isMoving, true);
  assert.equal(p1?.name, 'Ravka', 'the name must survive a status-only update');
});

test('truncateName survives the missing name that took the canvas down', () => {
  assert.equal(truncateName(undefined, 14), '');
  assert.equal(truncateName(null, 14), '');
  assert.equal(truncateName('', 14), '');
  assert.equal(truncateName('Ravka', 14), 'Ravka');
  assert.equal(truncateName('Muhammad Jordy Pratama', 14), 'Muhammad Jord…');
});

test('a throw inside a frame cannot stop the animation loop', () => {
  const source = readFileSync(resolve('client/src/components/canvas/GameCanvas.tsx'), 'utf8');
  // The reschedule used to be the last statement of the frame body, so any
  // exception in it was permanently fatal: no further frame was ever
  // requested and the canvas froze until reload.
  assert.ok(
    /\} finally \{\s*rafRef\.current = requestAnimationFrame\(draw\);/.test(source),
    'the next frame must be scheduled in a finally, not after the drawing',
  );
  assert.equal(
    /rafRef\.current = requestAnimationFrame\(draw\);\n  \}, \[\]\);/.test(source), false,
    'the frame body must no longer reschedule itself as its final statement',
  );
});

test('stopping the local player clears sprint state', () => {
  const store = useGameStore.getState();

  store.setLocalPlayer({ isMoving: true, isRunning: true });
  store.setLocalPlayer({ isMoving: false });

  assert.equal(useGameStore.getState().localPlayer.isMoving, false);
  assert.equal(useGameStore.getState().localPlayer.isRunning, false);
});

test('stopping a remote player clears sprint state', () => {
  const store = useGameStore.getState();
  const playerId = 'remote-sprint-lock';

  store.upsertPlayer({
    id: playerId,
    name: 'Remote',
    x: 96,
    y: 96,
    direction: 'right',
    color: '#ffffff',
    isMoving: true,
    isRunning: true,
  });
  store.upsertPlayer({ id: playerId, isMoving: false } as Parameters<typeof store.upsertPlayer>[0]);

  assert.equal(useGameStore.getState().playerRecords[playerId].isMoving, false);
  assert.equal(useGameStore.getState().playerRecords[playerId].isRunning, false);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} game store test(s) passed`);
