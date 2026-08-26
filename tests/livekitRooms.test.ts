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

// ── Fase B: proximity ──────────────────────────────────────────────────────

test('the proximity RULES stay in useProximity, untouched', () => {
  const prox = readFileSync(resolve('client/src/hooks/useProximity.ts'), 'utf8');
  // Zone isolation, Focus/DND, distance, table grouping, Spotlight — the most
  // distinctive logic in the product, and none of it moves. Only what its
  // answer is fed into changes.
  assert.ok(prox.includes('shouldIsolateZoneAudio'), 'zone isolation stays here');
  assert.ok(prox.includes("workMode === 'focus'"), 'Focus/DND stays here');
  assert.equal(/livekit/i.test(prox), false, 'and it must know nothing about the transport');
});

test('proximity drives subscription, not connection', () => {
  // On the mesh, changing who you can hear meant renegotiating — which is
  // where the m-line ordering failure came from. Subscribing touches no SDP,
  // so walking past somebody can no longer break a call.
  assert.ok(/applyProximity/.test(service));
  assert.ok(/setSubscribed\(want\)/.test(service));
  assert.equal(/connectToPlayer|createOffer|setLocalDescription/.test(service), false,
    'no peer-connection plumbing belongs on this path');
});

test('a screen share is never proximity-gated', () => {
  // Someone presenting is addressing the room. The mesh sent a share to every
  // connected peer regardless of distance, and that has to stay true.
  assert.ok(/Track\.Source\.ScreenShare/.test(service));
  assert.ok(/isScreen \|\| !isVideo/.test(service), 'audio and screen are ungated; cameras are ranked');
});

test('zone-mates hear each other at full volume, exactly as on the mesh', () => {
  // Same rule, same source: it is the same useProximity output driving it.
  assert.ok(/entry\.viaZone \? 1 : entry\.gain/.test(service));
});

test('only a bounded number of cameras are pulled at once', () => {
  assert.ok(/MAX_VIDEO_SUBSCRIPTIONS/.test(service));
  // Ranked the way the mesh ranked it: zone-mates first, then closest.
  assert.ok(/viaZone \? -1 : 1/.test(service));
  assert.ok(/distanceTiles - b\.distanceTiles/.test(service));
});

test('an account id, never a socket id, identifies a participant', () => {
  const shared = readFileSync(resolve('shared/types/index.ts'), 'utf8');
  // A socket id changes on reconnect, so a participant would return as a
  // stranger. ProximityPlayer now carries both so the map and the SFU can be
  // matched without a second lookup.
  assert.ok(/userId\?: string;\n  distanceTiles/.test(shared), 'ProximityPlayer must carry userId');
  assert.ok(/p\.userId/.test(service));
});

// ── Fase C: screen share ───────────────────────────────────────────────────

test('a share is published once, not once per viewer', () => {
  // The mesh addTrack'd on every peer connection and renegotiated each one —
  // the origin of both the black-tile bug and the m-line failure, and why the
  // simultaneous-share cap had to be cut to 1.
  assert.ok(/setScreenShareEnabled/.test(service));
  assert.equal(/for \(const peer of this\.peers/.test(service), false, 'no per-peer loop');
});

test('capture bounds match the mesh, and a cancelled picker is not an error', () => {
  assert.ok(/width: 1920, height: 1080, frameRate: 15/.test(service),
    'a shared screen is mostly text: resolution matters, frames can drop');
  assert.ok(/NotAllowedError/.test(service), 'dismissing the OS picker is a choice, not a failure');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} livekit rooms test(s) passed`);
