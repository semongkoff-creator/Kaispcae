import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isPeerNegotiationStuck, NEGOTIATION_TIMEOUT_MS } from '../client/src/services/peerHealth';

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

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} peer recovery test(s) passed`);
