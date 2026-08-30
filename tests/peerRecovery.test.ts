import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isPeerNegotiationStuck, NEGOTIATION_TIMEOUT_MS } from '../client/src/services/peerHealth';
import { screenShareBitrateFor, totalScreenShareUploadBps } from '../client/src/services/mediaBudget';

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

test('a peer that never received a remote description counts as stuck', () => {
  // The glare-avoidance deadlock: we created the peer, we are the higher
  // socket id so we never offered, and their offer never came.
  assert.equal(isPeerNegotiationStuck({ iceConnectionState: 'new', remoteDescSet: false }), true);
});

test('a negotiated peer still checking candidates is left to ICE', () => {
  // ICE has its own escalation for this (checking -> failed -> retry). The
  // watchdog must not race it, or a slow-but-working connection gets torn
  // down mid-handshake.
  assert.equal(isPeerNegotiationStuck({ iceConnectionState: 'checking', remoteDescSet: true }), false);
});

test('a working peer is never considered stuck', () => {
  assert.equal(isPeerNegotiationStuck({ iceConnectionState: 'connected', remoteDescSet: true }), false);
  assert.equal(isPeerNegotiationStuck({ iceConnectionState: 'completed', remoteDescSet: true }), false);
});

test('a connected peer is trusted even if remoteDescSet was never flagged', () => {
  // Media is flowing — whatever the bookkeeping says, this is not a peer to
  // tear down.
  assert.equal(isPeerNegotiationStuck({ iceConnectionState: 'connected', remoteDescSet: false }), false);
});

test('the watchdog waits far longer than a real signalling round trip', () => {
  assert.ok(NEGOTIATION_TIMEOUT_MS >= 5000, `${NEGOTIATION_TIMEOUT_MS}ms is too eager to write off a slow connection`);
});

test('the watchdog cannot tear down the peer that replaced the one it watched', () => {
  const source = readFileSync(resolve('client/src/services/webrtcService.ts'), 'utf8');
  assert.ok(
    source.includes('if (this.peers.get(remoteId) !== peer) return;'),
    'a stale watchdog must verify it still owns the peer under that id',
  );
  assert.ok(
    source.includes('if (peer.negotiationTimer) {'),
    'tearing a peer down must cancel its watchdog',
  );
});

test('a peer the service has dropped is retried rather than assumed connected', () => {
  const source = readFileSync(resolve('client/src/hooks/useWebRTC.ts'), 'utf8');
  assert.ok(
    source.includes('if (!webrtcService.hasPeer(id)) connectedIds.delete(id);'),
    'the connected set must be reconciled against the service, or a dropped peer is never rebuilt',
  );
});

test('a small audience keeps the quality it had before the budget existed', () => {
  assert.equal(screenShareBitrateFor(1), 2_500_000);
  assert.equal(screenShareBitrateFor(3), 2_500_000, 'three viewers still fit inside the budget at full quality');
});

test('a crowd degrades the picture instead of the presenter uplink', () => {
  // The whole point: total upload must stay bounded as the audience grows,
  // because it is the presenter's own upstream link and nothing else can
  // substitute for it.
  const small = totalScreenShareUploadBps(4);
  const large = totalScreenShareUploadBps(12);
  assert.ok(large <= 9_600_000, `12 viewers should stay near the budget, got ${large}`);
  assert.ok(screenShareBitrateFor(12) < screenShareBitrateFor(4), 'per-viewer bitrate must fall as viewers are added');
  assert.ok(small <= large, 'the budget is shared, not per-peer');
});

test('the per-viewer bitrate never drops below readable', () => {
  // Past this the share is pointless, so overshooting the budget is the
  // lesser evil — and a room that big wants an SFU, not a smaller number.
  assert.equal(screenShareBitrateFor(64), 600_000);
});

test('the budget curve never increases with more viewers', () => {
  let previous = Infinity;
  for (let peers = 1; peers <= 32; peers++) {
    const per = screenShareBitrateFor(peers);
    assert.ok(per <= previous, `${peers} viewers got MORE per-viewer bitrate than ${peers - 1}`);
    previous = per;
  }
});

// webrtcService itself cannot be imported here — it reads import.meta.env at
// module scope, which only exists under Vite — so the caps are read from the
// source text, same approach performanceGuards.test.ts already uses.
function peerCaps(): { total: number; video: number } {
  const source = readFileSync(resolve('client/src/services/webrtcService.ts'), 'utf8');
  const total = source.match(/export const MAX_TOTAL_PEERS = (\d+);/);
  const video = source.match(/export const MAX_VIDEO_PEERS = (\d+);/);
  assert.ok(total && video, 'peer caps should still be declared as plain exported constants');
  return { total: Number(total![1]), video: Number(video![1]) };
}

test('audio capacity is well past one crowded desk area, video stays bounded', () => {
  const { total, video } = peerCaps();
  // A 12-person audio-isolated area asks for every member regardless of
  // distance, which is what used to overrun the old cap of 8 and leave the
  // lowest-ranked members silent with no signal anywhere.
  assert.ok(total >= 12, `${total} still starves a full desk area`);
  // Video is the expensive track and must NOT follow the total up.
  assert.ok(video <= 8, `${video} cameras is more uplink than a mesh should ask for`);
  assert.ok(video < total, 'video must stay a subset of the total');
});

test('a half-configured TURN relay is reported, not silently dropped', () => {
  const source = readFileSync(resolve('client/src/services/webrtcService.ts'), 'utf8');
  // The browser rejects a TURN entry missing any of the three, so the ICE
  // config drops it entirely — which is indistinguishable from "no relay was
  // ever wanted" unless something says so out loud. Production shipped with
  // username+credential set and the URL blank for exactly this reason.
  assert.ok(
    source.includes('TURN is only half configured'),
    'setting some but not all TURN vars must warn at the console',
  );
  assert.ok(
    /if \(\(TURN_URL \|\| TURN_USERNAME \|\| TURN_CREDENTIAL\) && !\(TURN_URL && TURN_USERNAME && TURN_CREDENTIAL\)\)/.test(source),
    'the warning must fire on a partial config specifically, not on an absent one',
  );
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} peer recovery test(s) passed`);
