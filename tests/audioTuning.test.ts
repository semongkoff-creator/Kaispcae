import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tuneOpusForVoice } from '../client/src/services/sdpAudio';

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

// Shape Chrome actually produces: dynamic payload number, and an fmtp line
// that already carries parameters of its own.
const CHROME_SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 126',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'a=rtpmap:0 PCMU/8000',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=rtpmap:96 VP8/90000',
].join('\r\n');

function fmtpFor(sdp: string, pt: string): string {
  const line = sdp.split(/\r\n|\n/).find((l) => l.startsWith(`a=fmtp:${pt} `));
  assert.ok(line, `expected an a=fmtp:${pt} line`);
  return line!.slice(`a=fmtp:${pt} `.length);
}

function params(fmtp: string): Record<string, string> {
  return Object.fromEntries(fmtp.split(';').map((p) => {
    const i = p.indexOf('=');
    return i === -1 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)];
  }));
}

test('DTX and a receive ceiling are added to the Opus fmtp', () => {
  const p = params(fmtpFor(tuneOpusForVoice(CHROME_SDP), '111'));
  // The two that actually change behaviour: Chrome enables FEC by default but
  // never DTX, and leaves the bitrate unbounded.
  assert.equal(p.usedtx, '1', 'DTX is the largest saving available across a 16-peer mesh');
  assert.equal(p.maxaveragebitrate, '24000');
  assert.equal(p.stereo, '0');
  assert.equal(p.useinbandfec, '1');
});

test('parameters the browser set for itself are preserved', () => {
  const p = params(fmtpFor(tuneOpusForVoice(CHROME_SDP), '111'));
  assert.equal(p.minptime, '10', 'minptime is the browser\'s own choice and none of our business');
});

test('other codecs are left completely alone', () => {
  const tuned = tuneOpusForVoice(CHROME_SDP);
  assert.equal(fmtpFor(tuned, '63'), '111/111', 'red/48000 must not be touched');
  assert.ok(tuned.includes('a=rtpmap:96 VP8/90000'));
  assert.equal(tuned.includes('a=fmtp:96'), false, 'no fmtp should be invented for VP8');
  assert.equal(tuned.includes('a=fmtp:0'), false, 'nor for PCMU');
});

test('an Opus payload type with no fmtp line gets one, next to its rtpmap', () => {
  const sdp = ['m=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=ptime:20'].join('\r\n');
  const lines = tuneOpusForVoice(sdp).split('\r\n');
  assert.equal(lines[1], 'a=rtpmap:111 opus/48000/2');
  assert.ok(lines[2].startsWith('a=fmtp:111 '), `expected the fmtp right after the rtpmap, got ${lines[2]}`);
  assert.equal(lines[3], 'a=ptime:20', 'nothing else may be displaced');
  assert.equal(params(fmtpFor(tuneOpusForVoice(sdp), '111')).usedtx, '1');
});

test('tuning is idempotent', () => {
  const once = tuneOpusForVoice(CHROME_SDP);
  assert.equal(tuneOpusForVoice(once), once, 'renegotiation re-tunes an already-tuned SDP every time');
});

test('every Opus payload type in the SDP is tuned, not just the first', () => {
  const sdp = [
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10',
    'm=audio 9 UDP/TLS/RTP/SAVPF 120',
    'a=rtpmap:120 opus/48000/2',
    'a=fmtp:120 minptime=10',
  ].join('\r\n');
  const tuned = tuneOpusForVoice(sdp);
  assert.equal(params(fmtpFor(tuned, '111')).usedtx, '1');
  assert.equal(params(fmtpFor(tuned, '120')).usedtx, '1');
});

test('CRLF line endings survive — SDP requires them', () => {
  const tuned = tuneOpusForVoice(CHROME_SDP);
  assert.ok(tuned.includes('\r\n'), 'joined with bare LF, some stacks reject the description outright');
  assert.equal(/[^\r]\n/.test(tuned), false, 'no bare LF may be left behind');
});

test('an SDP with no Opus is returned untouched', () => {
  const sdp = ['m=audio 9 UDP/TLS/RTP/SAVPF 0', 'a=rtpmap:0 PCMU/8000'].join('\r\n');
  assert.equal(tuneOpusForVoice(sdp), sdp);
});

test('a rejected tuning falls back to the untuned description', () => {
  const source = readFileSync(resolve('client/src/services/webrtcService.ts'), 'utf8');
  // Browsers have tightened what setLocalDescription accepts over time. Losing
  // a tuning parameter is acceptable; losing the call is not.
  assert.ok(source.includes('Opus tuning rejected by the browser, using untuned SDP'));
  assert.ok(
    /catch \(err\) \{[\s\S]{0,400}await pc\.setLocalDescription\(description\);/.test(source),
    'the catch path must still set the original description',
  );
});

test('audio outranks video and screen share on a saturated uplink', () => {
  const source = readFileSync(resolve('client/src/services/webrtcService.ts'), 'utf8');
  // One connection carries mic, camera and screen through the same congestion
  // controller; equal priority means a screen share degrades the voice call.
  // Asserted against the transceiver's sender rather than an addTrack return
  // value: the tracks are no longer added as they appear, because doing so
  // renegotiated every time and let the two sides' m-line order drift apart.
  // The guarantee is unchanged — audio high, camera low — only where the
  // sender comes from.
  assert.ok(/prioritiseSender\(audioTx\.sender, 'high'\)/.test(source));
  assert.ok(/prioritiseSender\(cameraTx\.sender, 'low', 'maintain-framerate'\)/.test(source));
  assert.ok(source.includes("WebRTCService.setSenderPriority(params, 'low')"), 'the screen sender must yield too');
  assert.ok(source.includes("params.degradationPreference = 'maintain-resolution'"), 'screen text should stay legible, frames can drop');
  // Both spellings of the same knob — browsers read one or the other.
  assert.ok(source.includes('params.encodings[0].networkPriority = priority'));
  assert.ok(source.includes('params.encodings[0].priority = priority'));
});

test('the m-line layout is fixed at connection and never changed after', () => {
  const source = readFileSync(resolve('client/src/services/webrtcService.ts'), 'utf8');

  // The bug this guards against was not subtle in its effects: an offer whose
  // media sections are ordered differently from the previous one is rejected
  // with InvalidAccessError, and that pair is finished — every rebuild
  // reproduces the same disagreement. It presented as a black screen share,
  // and as one person being audible to some listeners but not others.
  //
  // It happened because m-lines were created implicitly by whichever
  // addTrack() ran first across several call sites, so two sides could end up
  // with different orders. Three transceivers up front, in a fixed order, on
  // both sides, is what makes that impossible.
  assert.ok(/addTransceiver\('audio'/.test(source), 'audio must be m-line 0');
  assert.equal((source.match(/addTransceiver\('video'/g) ?? []).length, 2, 'camera and screen each need their own fixed slot');

  // Adding a track later renegotiates, and renegotiation is what allowed the
  // order to drift. Every later change has to be a replaceTrack on a slot
  // that already exists.
  assert.equal(/pc\.addTrack\(/.test(source), false, 'tracks must be attached with replaceTrack, never added');

  // removeTrack renegotiates AND releases the transceiver for reuse, and the
  // two sides do not necessarily agree which slot got recycled next time.
  assert.equal(/pc\.removeTrack\(/.test(source), false, 'a slot is emptied with replaceTrack(null), never removed');

  // Which transceiver a track arrived on is the only camera-or-screen test
  // that cannot be wrong. Stream grouping cannot work at all now, since
  // replaceTrack carries no MediaStream.
  assert.ok(source.includes('event.transceiver === cameraTx'), 'classify by transceiver, not by inference');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} audio tuning test(s) passed`);
