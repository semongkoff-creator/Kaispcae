import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

const socketSource = readFileSync(resolve('client/src/hooks/useSocket.ts'), 'utf8');

// A bounded window starting at the handler's registration, so these
// assertions are about the RIGHT handler rather than the file as a whole.
// Deliberately not brace-matching: braces inside the comments and strings of
// these handlers make that unreliable, and a fixed window is enough to tell
// "this handler does X" from "some other handler does X".
function handlerBody(needle: string, chars = 2000): string {
  const start = socketSource.indexOf(needle);
  assert.notEqual(start, -1, `expected a handler registered with ${needle}`);
  return socketSource.slice(start, start + chars);
}

test('every connect re-emits JOIN_ROOM — which is why a reconnect must be stopped', () => {
  // Not a wish: this is the fact the two tests below exist because of. The
  // 'connect' handler fires on reconnects too, so any socket that reconnects
  // rejoins the room and supersedes whoever holds the account.
  const body = handlerBody('socket.on(SocketEvents.CONNECT');
  assert.ok(body.includes('SocketEvents.JOIN_ROOM'), 'connect handler should still be the thing that joins');
});

test('a superseded tab stops reconnecting instead of taking the account back', () => {
  const body = handlerBody('socket.on(SocketEvents.SESSION_TAKEN_OVER');
  assert.ok(body.includes('socket.io.reconnection(false)'),
    'without this the socket reconnects, re-joins, and supersedes the tab that just took over — endlessly');
  assert.ok(body.includes('socket.disconnect()'), 'and it should not sit in a half-open state either');
  // Ordering matters: disabling reconnection after an await/emit would leave a
  // window for the automatic reconnect to fire first.
  assert.ok(
    body.indexOf('socket.io.reconnection(false)') < body.indexOf('setSessionTakenOverNotice'),
    'reconnection must be disabled before anything else in the handler',
  );
});

test('a session superseded by a real login elsewhere also stops retrying', () => {
  const body = handlerBody("socket.on('SESSION_SUPERSEDED'");
  assert.ok(body.includes('socket.io.reconnection(false)'));
  assert.ok(body.includes('socket.disconnect()'));
});

test('the takeover path still leaves the login token alone', () => {
  const body = handlerBody('socket.on(SocketEvents.SESSION_TAKEN_OVER');
  // localStorage is shared across tabs of one origin, so clearing the token
  // here would log the WINNING tab out too.
  assert.equal(/removeItem\(['"]vm_token/.test(body), false);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} session takeover test(s) passed`);
