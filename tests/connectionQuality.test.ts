import assert from 'node:assert/strict';
import {
  classifyPeer,
  classifySelf,
  selfVerdictMessage,
  QUALITY_THRESHOLDS,
  type PeerQualitySample,
} from '../client/src/services/connectionQuality';

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

function sample(over: Partial<PeerQualitySample> = {}): PeerQualitySample {
  return {
    rttMs: 40,
    jitterMs: 5,
    lossPct: 0,
    availableOutgoingBps: 10_000_000,
    limitation: 'none',
    relayed: false,
    ...over,
  };
}

test('a healthy peer reads as three bars', () => {
  const q = classifyPeer(sample());
  assert.equal(q.level, 'good');
  assert.equal(q.bars, 3);
});

test('one bad axis is enough — the level is the worst, not the average', () => {
  // Latency and loss both perfect, jitter alone terrible. Averaging would call
  // this healthy, which is exactly the WiFi case that must not be missed.
  const q = classifyPeer(sample({ jitterMs: 200 }));
  assert.equal(q.level, 'poor');
});

test('missing measurements read as unknown, never as good', () => {
  const q = classifyPeer({
    rttMs: null, jitterMs: null, lossPct: null,
    availableOutgoingBps: null, limitation: null, relayed: false,
  });
  assert.equal(q.level, 'unknown');
  // Zero bars means "no data", and must be distinguishable from a bad link.
  assert.equal(q.bars, 0);
});

test('a relayed peer is flagged even while its quality is fine', () => {
  const q = classifyPeer(sample({ relayed: true }));
  assert.equal(q.level, 'good');
  assert.equal(q.relayed, true, 'TURN explains added latency and should stay visible');
});

test('a single bad peer does not accuse the local side', () => {
  const v = classifySelf([sample(), sample(), sample({ rttMs: 900, lossPct: 30 })]);
  assert.equal(v.cause, 'ok', 'one bad peer out of three is a statement about THEM');
  assert.equal(v.affected, 1);
});

test('most peers bad with high jitter reads as an unstable link', () => {
  const bad = sample({ jitterMs: 180, rttMs: 400 });
  const v = classifySelf([bad, bad, bad, sample()]);
  assert.equal(v.cause, 'unstable');
  assert.match(selfVerdictMessage(v) ?? '', /LAN|router/i, 'the advice has to name an action');
});

test('most peers bad with a tight uplink reads as bandwidth, not instability', () => {
  const bad = sample({ rttMs: 500, lossPct: 12, jitterMs: 8, availableOutgoingBps: 400_000 });
  const v = classifySelf([bad, bad, bad]);
  assert.equal(v.cause, 'bandwidth');
});

test('a cpu limitation outranks everything and needs no quorum', () => {
  // One peer reporting it is conclusive: the encoder is describing THIS
  // machine, not the link to that particular person.
  const v = classifySelf([sample(), sample(), sample({ limitation: 'cpu' })]);
  assert.equal(v.cause, 'cpu');
  assert.match(selfVerdictMessage(v) ?? '', /kamera|aplikasi/i);
});

test('a lone peer never produces a self verdict', () => {
  // With one connection there is no way to tell whose end is at fault, and
  // guessing sends someone to reset a router that was fine.
  const v = classifySelf([sample({ rttMs: 800, lossPct: 20, jitterMs: 150 })]);
  assert.equal(v.cause, 'unknown');
  assert.equal(selfVerdictMessage(v), null);
});

test('no peers at all is unknown, not healthy', () => {
  const v = classifySelf([]);
  assert.equal(v.cause, 'unknown');
  assert.equal(v.total, 0);
});

test('the blame ratio needs more than a bare majority', () => {
  // Exactly half bad must NOT accuse the local side: two people with genuinely
  // bad WiFi would otherwise convict the one whose connection is fine.
  const bad = sample({ rttMs: 700, lossPct: 20, jitterMs: 120 });
  const v = classifySelf([bad, bad, sample(), sample()]);
  assert.equal(v.cause, 'ok');
  assert.ok(QUALITY_THRESHOLDS.SELF_BLAME_RATIO > 0.5, 'a bare majority is not enough to blame the local end');
});

test('thresholds stay ordered, so a band can never be unreachable', () => {
  const t = QUALITY_THRESHOLDS;
  assert.ok(t.RTT_GOOD_MS < t.RTT_FAIR_MS, 'good must be stricter than fair');
  assert.ok(t.LOSS_GOOD_PCT < t.LOSS_FAIR_PCT);
  assert.ok(t.JITTER_GOOD_MS < t.JITTER_FAIR_MS);
  assert.ok(t.MIN_PEERS_FOR_SELF_VERDICT >= 2, 'one peer cannot separate local from remote');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} connection quality test(s) passed`);
