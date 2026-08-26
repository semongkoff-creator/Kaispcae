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

const rooms = readFileSync(resolve('client/src/services/livekitRooms.ts'), 'utf8');
const service = readFileSync(resolve('client/src/services/livekitService.ts'), 'utf8');

test('every room stays on the mesh unless named', () => {
  // The shipped default has to be "nothing changes". A media switch that is on
  // by default is one nobody chose, and mesh and SFU cannot interoperate — a
  // room is entirely on one or entirely on the other.
  assert.ok(/\?\?\s*''/.test(rooms), 'an unset VITE_LIVEKIT_ROOMS must mean no rooms');
  assert.ok(/if \(!roomSlug\) return false/.test(rooms), 'no room means no LiveKit');
});

test('the switch is per room, never global by accident', () => {
  // Landing the m-line fix showed what a media change with no way to stage it
  // costs: every old-bundle and new-bundle pair died on contact and it was
  // reverted within the hour. Per-room is what makes this one survivable.
  assert.ok(/usesLiveKit\(roomSlug/.test(rooms), 'the decision must take a room');
  // '*' exists for the final migration, but has to be spelled out.
  assert.ok(rooms.includes("has('*')"), 'a deliberate all-rooms escape hatch should exist');
  assert.equal(/ALL = true/.test(rooms), false, 'and must never be the default');
});

test('room matching ignores case and whitespace', () => {
  // The value is typed into a .env by hand, and "kaitech, dcm" with a space
  // must not silently enable nothing.
  assert.ok(rooms.includes('.trim()'), 'entries need trimming');
  assert.ok(rooms.includes('.toLowerCase()'), 'and case-folding, on both sides');
  assert.ok(/roomSlug\.toLowerCase\(\)/.test(rooms));
});

test('the LiveKit service never replaces the mesh service', () => {
  // Two files, side by side. Rewriting webrtcService in place would mean
  // every room switches the moment the build ships, which is exactly the
  // thing per-room flagging exists to prevent.
  assert.ok(service.includes('livekit-client'), 'the SDK belongs to the new service only');
  // An IMPORT, not a mention: the comments here refer to webrtcService
  // constantly, and should — this file only makes sense as the other half of
  // a pair, and explaining which decisions were carried across is most of
  // what makes the migration reviewable. What must not exist is a code path
  // from one into the other.
  assert.equal(
    /^import[^\n]*webrtcService/m.test(service), false,
    'the two services must not import each other',
  );
  const webrtc = readFileSync(resolve('client/src/services/webrtcService.ts'), 'utf8');
  assert.equal(
    /^import[^\n]*livekit/mi.test(webrtc), false,
    'and the mesh service must stay unaware LiveKit exists',
  );
});

test('adaptiveStream and dynacast are on', () => {
  // The two things a mesh structurally cannot do, and the reason a 96px
  // thumbnail was decoding a full 1080p screen share: there was only ever one
  // quality to send, to everybody.
  assert.ok(/adaptiveStream:\s*true/.test(service));
  assert.ok(/dynacast:\s*true/.test(service));
});

test('a token is fetched per join, never cached', () => {
  // It is scoped to one room and expires the same day, and the server
  // re-checks access every time it mints one — a cached token would readmit
  // an account whose access was revoked in between.
  assert.ok(/getLiveKitToken\(roomSlug\)/.test(service));
  assert.equal(/localStorage|sessionStorage/.test(service), false, 'a join credential must not be persisted');
});

test('volume is applied per listener, as proximity needs', () => {
  // Proximity falloff drives this, and useProximity does not change in the
  // migration — only what its output is fed into. setVolume is playback-side,
  // so turning someone down costs the speaker nothing and renegotiates
  // nothing.
  assert.ok(/setParticipantVolume/.test(service));
  assert.ok(/setVolume\(Math\.max\(0, Math\.min\(1/.test(service), 'and stays clamped, same as the mesh version');
});

test('identity is the KaiSpace user id end to end', () => {
  // The token endpoint sets identity to user.id deliberately; this is the
  // other half of that decision — a LiveKit participant has to be matchable
  // to a player on the map without a second lookup.
  assert.ok(/participant\.identity/.test(service));
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} livekit rooms test(s) passed`);
