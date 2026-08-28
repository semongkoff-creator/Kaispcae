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

test('a share is published as one sharp layer, not a set to downgrade from', () => {
  // adaptiveStream picks a layer from the size of the viewer's <video>
  // element. A share in the side strip is a few hundred pixels wide, so it was
  // handed the quarter-resolution layer and small text became unreadable.
  // Right trade for a face, wrong one for a screen.
  assert.ok(/simulcast: false/.test(service), 'no lower layer may exist to fall back to');
  // Pinning quality per subscription loses to adaptiveStream, which recomputes
  // from element size on the next update — so that is deliberately NOT how
  // this is done.
  assert.equal(/setVideoQuality/.test(service), false);
});

test('the share bitrate is raised above the default for text', () => {
  const m = service.match(/maxBitrate: ([0-9_]+)/);
  assert.ok(m, 'the encoding should be explicit, not left to the default');
  assert.ok(Number(m![1].replace(/_/g, '')) >= 3_000_000, 'LiveKit defaults to 2.5 Mbps at 1080p15');
  // Frames are the thing a screen share can afford to lose; resolution is not.
  assert.ok(/maxFramerate: 15/.test(service));
});

test('the signal bars get a reading on this path too', () => {
  // The mesh derived quality from getStats() on every peer connection. None of
  // those connections exist here, so the bars sat at "no measurement" for every
  // LiveKit room — a dash, which reads as a broken feature rather than a
  // missing one.
  assert.ok(/publishConnectionQuality\(peers, self\)/.test(service));
  assert.ok(/RoomEvent\.ConnectionQualityChanged/.test(service), 'reported by the server, not polled');
  // Leaving a room must not carry its peers into the next one.
  assert.ok(/clearConnectionQuality\(\)/.test(service));
});

test('quality is keyed by player id, not account id', () => {
  const app = readFileSync(resolve('client/src/App.tsx'), 'utf8');
  const panel = readFileSync(resolve('client/src/components/ui/MemberListPanel.tsx'), 'utf8');

  // MemberListPanel looks up peerQuality.get(p.id) — a player id. Publishing
  // under the LiveKit identity would miss on every lookup and leave the bars
  // empty while being fully populated: the same symptom this fixes.
  assert.ok(/peerQuality\.get\(p\.id\)/.test(panel), 'the lookup key is the player id');
  assert.ok(/this\.playerIdFor\?\.\(identity\)/.test(service), 'so the service must translate');
  assert.ok(/setPlayerIdResolver\(playerIdFor\)/.test(app), 'and App supplies the translation');
});

test('LiveKit reports that a link is bad, never why', () => {
  // SelfCause carries 'cpu' and 'bandwidth', and the mesh could fill them from
  // the encoder's own limitation reason. Nothing here can, and this is the
  // field that sends somebody off to reset a router.
  assert.ok(/cause: own\.level === 'good' \? 'ok' : own\.level === 'poor' \? 'degraded'/.test(service));
});

// ── Fase D: wired into the app ─────────────────────────────────────────────

test('the branch lives in useWebRTC, so App never sees two implementations', () => {
  const hook = readFileSync(resolve('client/src/hooks/useWebRTC.ts'), 'utf8');
  const app = readFileSync(resolve('client/src/App.tsx'), 'utf8');

  // This hook is already the only door between the app and the media layer.
  // Branching here means every caller keeps using the same six functions and
  // does not have to know there are two implementations behind them.
  assert.ok(/const onLiveKit = usesLiveKit\(roomSlug\)/.test(hook));
  assert.ok(/useWebRTC\(\{ socketRef, roomSlug \}\)/.test(app), 'App must pass the room');

  // Every entry point has to branch, or a room would connect to one path and
  // publish on the other.
  for (const fn of ['initMedia', 'toggleMic', 'toggleCamera', 'toggleScreenShare', 'updateProximity', 'destroy']) {
    const at = hook.indexOf(`const ${fn} = useCallback`);
    assert.ok(at > 0, `${fn} should still exist`);
    assert.ok(
      hook.slice(at, at + 700).includes('onLiveKit'),
      `${fn} must choose a path`,
    );
  }
});

test('identity is translated to a player id at the boundary', () => {
  const app = readFileSync(resolve('client/src/App.tsx'), 'utf8');
  // The two layers key people differently — socket id on the mesh, account id
  // on LiveKit. Translating here means VideoGrid, ParticipantPanel and the
  // signal bars all stay exactly as they are.
  assert.ok(/playerIdFor/.test(app));
  assert.ok(/p\.userId === identity/.test(app));
});

test('the distance curve stays in one place for both paths', () => {
  const hook = readFileSync(resolve('client/src/hooks/useWebRTC.ts'), 'utf8');
  // calcGain is the falloff. Computing it in the hook rather than inside
  // either service is what stops the two paths drifting into different
  // definitions of "how quiet is someone four tiles away".
  assert.ok(/gain: p\.viaZone \? 1 : calcGain\(p\.distanceTiles\)/.test(hook));
});

test('the credentials the token endpoint needs actually reach the container', () => {
  // Twice now this repo has shipped a variable that exists in .env.example, is
  // read correctly by the code, and never reaches the process: VITE_TURN_* to
  // the client build, and then LIVEKIT_* to the server. Both presented as the
  // feature simply not working, with nothing in any log saying why.
  //
  // routes/livekit.ts refuses to mint a token unless all three are set, so
  // without them every room on the LiveKit path fails to join regardless of
  // what VITE_LIVEKIT_ROOMS says.
  const compose = readFileSync(resolve('docker-compose.yml'), 'utf8');
  const server = compose.slice(compose.indexOf('\n  server:'), compose.indexOf('\n  nginx:'));
  for (const key of ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_URL']) {
    assert.ok(
      new RegExp(`^\\s+${key}:`, 'm').test(server),
      `${key} must be passed to the server container, not only documented in .env.example`,
    );
  }
  // And the client half, whose absence is just as silent: Vite inlines
  // import.meta.env at build time, so a value missing from the Dockerfile's
  // ARG/ENV pair is simply an empty string in the bundle.
  const dockerfile = readFileSync(resolve('client/Dockerfile'), 'utf8');
  assert.ok(/ARG VITE_LIVEKIT_ROOMS/.test(dockerfile), 'the build arg must be declared');
  assert.ok(/VITE_LIVEKIT_ROOMS=\$VITE_LIVEKIT_ROOMS/.test(dockerfile), 'and forwarded to the build');
});

test('a screen share never evicts the voice beside it', () => {
  // The reported symptom: "suara hilang saat sharescreen". Every subscribed
  // track used to be wrapped in a fresh MediaStream and handed over, and the
  // app holds one stream per player — so the camera replaced the microphone,
  // and the screen replaced both.
  assert.ok(/private mediaStreams = new Map/.test(service), 'streams must be held, not rebuilt');
  assert.ok(/private screenStreams = new Map/.test(service), 'and a share kept apart from the camera');
  assert.ok(/stream\.addTrack\(track\.mediaStreamTrack\)/.test(service), 'tracks are added');
  assert.equal(
    /new MediaStream\(\[track\.mediaStreamTrack\]\)/.test(service), false,
    'never a new single-track stream per arrival',
  );
  // ScreenShareAudio is a separate source from ScreenShare — a shared tab's
  // sound would otherwise land in the microphone's stream.
  assert.ok(/Track\.Source\.ScreenShareAudio/.test(service));
});

test('stopping a share leaves the microphone subscribed', () => {
  // TrackUnsubscribed used to end everything for that participant regardless
  // of which track stopped, so ending a share also dropped their voice.
  assert.ok(/stream\.removeTrack\(track\.mediaStreamTrack\)/.test(service));
  assert.ok(/getTracks\(\)\.length === 0/.test(service), 'ended only when nothing is left');
});

test('App feeds a share into the screen map, as the mesh does', () => {
  const app = readFileSync(resolve('client/src/App.tsx'), 'utf8');
  assert.ok(/setOnRemoteScreenStream\(\(identity/.test(app));
  assert.ok(/setOnRemoteScreenEnded\(\(identity/.test(app));
  // The two paths must key the same two maps, or VideoGrid sees a share on one
  // and not the other.
  for (const svc of ['webrtcService', 'livekitService']) {
    assert.ok(
      new RegExp(`${svc}\\.setOnRemoteScreenStream`).test(app),
      `${svc} must feed remoteScreenStreams`,
    );
  }
});

test('you can see yourself on both paths', () => {
  const app = readFileSync(resolve('client/src/App.tsx'), 'utf8');
  const hook = readFileSync(resolve('client/src/hooks/useWebRTC.ts'), 'utf8');

  // App reached past the hook and called webrtcService directly for its own
  // preview tile. webrtcService is never initialised on the LiveKit path, so
  // that returned null for every LiveKit room and nobody could see themselves
  // in Meeting View.
  assert.equal(
    /webrtcService\.get(Local|Screen)Stream\(\)/.test(app), false,
    'App must not read a stream straight off the mesh service',
  );
  assert.ok(/getLocalStream,\n\s+getScreenStream,/.test(app), 'both come from the hook');
  for (const fn of ['getLocalStream', 'getScreenStream']) {
    assert.ok(
      new RegExp(`${fn}: \\(\\) => \\(onLiveKit \\?`).test(hook),
      `${fn} must choose a path like every other function here`,
    );
  }
});

test('your own tile does not wait for media to exist', () => {
  const grid = readFileSync(resolve('client/src/components/ui/VideoGrid.tsx'), 'utf8');

  // The mesh captured a getUserMedia stream on join and merely disabled its
  // tracks, so localStream was non-null from the first frame. On the LiveKit
  // path a muted mic publishes no track at all, so localStream is genuinely
  // null until the user unmutes — and a `{localStream && <VideoTile …>}` guard
  // hid your own tile for the whole session while everyone else's showed.
  assert.equal(
    /\{localStream && \(\s*<VideoTile/.test(grid), false,
    'the local tile must not be gated on having a stream',
  );
  // Being in the room earns a tile; VideoTile picks video or initials from
  // cameraOff. Same rule buildVideoTiles already applies to remote tiles.
  assert.ok(/const showAvatar = .*isLocal \? !!cameraOff/.test(grid));
  // And it has to count, or a room where nobody has media yet totals zero and
  // the grid returns null — taking the tile with it.
  assert.ok(/const totalTiles = 1 \+/.test(grid));
});

test('a local preview stream keeps its identity across renders', () => {
  // App reads these during render. A fresh MediaStream per call gives the
  // <video> a new object every frame, which resets srcObject and leaves the
  // tile flickering or black.
  assert.ok(/private localStream = new MediaStream\(\)/.test(service));
  assert.ok(/private localScreenStream = new MediaStream\(\)/.test(service));
  assert.ok(/private syncLocal\(/.test(service), 'held streams are mutated, not rebuilt');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} livekit rooms test(s) passed`);
