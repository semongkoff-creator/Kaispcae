import assert from 'node:assert/strict';
import { useGameStore } from '../client/src/stores/gameStore';

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
