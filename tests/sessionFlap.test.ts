import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { recordSupersede, forgetSupersedes, __flapConfig } from '../server/src/socket/sessionFlap';

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

test('opening a second tab is a handover, not a fight', () => {
  forgetSupersedes();
  assert.equal(recordSupersede('u1', 1_000), false);
});

test('a reconnect or two on a bad network is still not a fight', () => {
  forgetSupersedes();
  // The old socket has not timed out server-side yet (20s ping timeout) while
  // the client is already back — legitimate, and must not be punished.
  assert.equal(recordSupersede('u1', 1_000), false);
  assert.equal(recordSupersede('u1', 2_000), false);
  assert.equal(recordSupersede('u1', 3_000), false);
  assert.equal(recordSupersede('u1', 4_000), false);
});

test('two live sockets trading the account back and forth is caught', () => {
  forgetSupersedes();
  for (let i = 1; i <= __flapConfig.FLAP_LIMIT; i++) recordSupersede('u1', i * 1_000);
  assert.equal(recordSupersede('u1', 5_500), true, 'past the limit inside the window this is a ping-pong');
});

test('the count ages out, so a flap does not follow an account around', () => {
  forgetSupersedes();
  for (let i = 1; i <= __flapConfig.FLAP_LIMIT + 1; i++) recordSupersede('u1', i * 1_000);
  const wellLater = 1_000 + __flapConfig.FLAP_WINDOW_MS + 5_000;
  assert.equal(recordSupersede('u1', wellLater), false, 'a quiet window must clear it');
});

test('accounts are counted independently', () => {
  forgetSupersedes();
  for (let i = 1; i <= __flapConfig.FLAP_LIMIT + 1; i++) recordSupersede('noisy', i * 1_000);
  assert.equal(recordSupersede('quiet', 2_000), false);
});

test('a refused newcomer is never announced to the room', () => {
  const source = readFileSync(resolve('server/src/socket/roomHandler.ts'), 'utf8');
  // The whole point is to broadcast NOTHING: the disconnect handler bails on a
  // null room, so clearing currentRoom is what keeps a leave from going out for
  // a player who was never announced.
  assert.ok(source.includes('if (recordSupersede(uid))'), 'the guard must be wired into the supersede path');
  const guard = source.slice(source.indexOf('if (recordSupersede(uid))'), source.indexOf('if (recordSupersede(uid))') + 1200);
  assert.ok(guard.includes('currentRoom = null'), 'without this the refusal broadcasts a leave, which is the churn being prevented');
  assert.ok(guard.includes('socket.disconnect(true)'));
  assert.ok(guard.includes('playerNames.delete(socket.id)'), 'and it must not leak a roster entry for the refused socket');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} session flap test(s) passed`);
