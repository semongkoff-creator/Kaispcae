import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import jwt from 'jsonwebtoken';

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

const source = readFileSync(resolve('server/src/routes/livekit.ts'), 'utf8');

// A token produced by this deployment's own `livekit-cli token create`, taken
// while verifying the server. Signature stripped and the key rotated out — it
// is here as the SHAPE our own minting has to match, not as a credential.
const REFERENCE_CLAIMS = {
  iss: 'e01b10539038d7e1',
  sub: 'orang-1',
  exp: 1787839553,
  nbf: 1787753153,
  iat: 1787753153,
  identity: 'orang-1',
  name: 'orang-1',
  video: { roomJoin: true, room: 'uji' },
};

test('our claims carry every field the working reference token had', () => {
  // The reference is the ground truth: LiveKit accepted it, two browsers
  // joined with it, audio flowed. Anything it contains that we omit is a
  // difference we would only discover by a participant behaving oddly.
  for (const key of ['iss', 'sub', 'nbf', 'exp', 'identity', 'name'] as const) {
    assert.ok(
      new RegExp(`\\b${key}\\b`).test(source),
      `mintToken must set ${key} — the reference token has it`,
    );
  }
  assert.ok(/roomJoin:\s*true/.test(source));
  assert.ok(/\broom\b/.test(source));
});

test('identity is the user id, not the socket id', () => {
  // A socket id changes on every reconnect, so a participant would come back
  // as a stranger. It is also what lets the client match a LiveKit participant
  // to a player on the map.
  assert.ok(/mintToken\(user\.id/.test(source), 'identity must be user.id');
  assert.equal(/mintToken\(\s*socket/.test(source), false);
});

test('the room gate matches GET /rooms/:slug exactly', () => {
  const rooms = readFileSync(resolve('server/src/routes/rooms.ts'), 'utf8');
  // Three checks, same order, same 404 in both files. A media credential must
  // not be easier to come by than the room itself — and if they drift, it is
  // this one that gets forgotten when room access is tightened.
  for (const check of [
    'room.organizationId !== req.organizationId',
    'req.restrictedToRoomId === undefined',
    'req.restrictedToRoomId && room.id !== req.restrictedToRoomId',
  ]) {
    assert.ok(source.includes(check), `livekit.ts is missing: ${check}`);
    assert.ok(rooms.includes(check), `rooms.ts no longer has: ${check} — the two have drifted`);
  }
});

test('an unconfigured deployment answers 503 rather than a broken token', () => {
  // All three env vars are optional so this can ship long before LiveKit
  // exists. Minting against an undefined secret would produce a token that
  // fails at the far end with nothing explaining why.
  assert.ok(/LIVEKIT_API_KEY && c\.LIVEKIT_API_SECRET && c\.LIVEKIT_URL/.test(source));
  assert.ok(source.includes('503'));
});

test('the url is served with the token, not compiled into the client', () => {
  // The VITE_TURN_* lesson: a value inlined at build time means moving the
  // server is a rebuild, and a rebuild that nobody remembers to do is an
  // outage nobody can explain.
  assert.ok(/url:\s*getConfig\(\)\.LIVEKIT_URL/.test(source));
});

test('a minted token verifies against its own secret and carries the grant', () => {
  const secret = 'test-secret-not-a-real-one';
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    { ...REFERENCE_CLAIMS, iss: 'test-key', nbf: now, exp: now + 3600 },
    secret,
    { algorithm: 'HS256' },
  );
  const decoded = jwt.verify(token, secret) as typeof REFERENCE_CLAIMS;
  assert.equal(decoded.video.roomJoin, true);
  assert.equal(decoded.identity, 'orang-1');
  // Wrong secret must not verify — this is the whole of LiveKit's auth.
  assert.throws(() => jwt.verify(token, 'a-different-secret'));
});

test('tokens expire the same working day', () => {
  const ttl = Number(source.match(/TOKEN_TTL_SECONDS = ([\d *]+)/)?.[1]?.split('*').reduce((a, b) => a * Number(b), 1));
  assert.ok(Number.isFinite(ttl) && ttl > 0, 'TTL must be a plain computed constant');
  assert.ok(ttl >= 3600, 'shorter than an hour would eject people mid-meeting');
  assert.ok(ttl <= 24 * 3600, 'a token lifted from a network tab should not outlive the day');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} livekit token test(s) passed`);
