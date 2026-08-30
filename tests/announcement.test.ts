import assert from 'node:assert/strict';
import { useGameStore } from '../client/src/stores/gameStore';
import { RoomBroadcast } from '../shared/types';

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

const msg = (text: string, sentAt: number): RoomBroadcast => ({ text, senderName: 'Admin', sentAt });
const reset = () => useGameStore.setState({ broadcastQueue: [] });
const queue = () => useGameStore.getState().broadcastQueue;

test('announcements queue instead of overwriting each other', () => {
  reset();
  const { enqueueBroadcast } = useGameStore.getState();
  enqueueBroadcast(msg('pertama', 1));
  enqueueBroadcast(msg('kedua', 2));

  assert.equal(queue().length, 2, 'the second must not replace the first');
  assert.equal(queue()[0].text, 'pertama', 'oldest shows first');
});

test('dismissing advances to the next announcement', () => {
  reset();
  const { enqueueBroadcast, dismissCurrentBroadcast } = useGameStore.getState();
  enqueueBroadcast(msg('pertama', 1));
  enqueueBroadcast(msg('kedua', 2));

  dismissCurrentBroadcast();
  assert.equal(queue().length, 1);
  assert.equal(queue()[0].text, 'kedua', 'the queued one takes over');

  dismissCurrentBroadcast();
  assert.equal(queue().length, 0, 'nothing left to show');
});

test('dismissing an empty queue is a no-op, not a crash', () => {
  reset();
  const before = queue();
  useGameStore.getState().dismissCurrentBroadcast();
  assert.equal(queue().length, 0);
  assert.equal(queue(), before, 'must not hand React a new array for no change');
});

test('a message arriving mid-run waits its turn', () => {
  reset();
  const { enqueueBroadcast, dismissCurrentBroadcast } = useGameStore.getState();
  enqueueBroadcast(msg('sedang tayang', 1));
  enqueueBroadcast(msg('menyusul', 2));

  // The ticker only ever renders index 0 — the newcomer must not steal it.
  assert.equal(queue()[0].text, 'sedang tayang');
  dismissCurrentBroadcast();
  assert.equal(queue()[0].text, 'menyusul');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} announcement test(s) passed`);
