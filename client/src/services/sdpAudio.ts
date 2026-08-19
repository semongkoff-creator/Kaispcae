// Opus parameters, applied to our own local SDP before it goes out.
//
// These are DECLARATIVE, and the direction matters: per RFC 7587, the values
// in an SDP describe what the SENDER OF THAT SDP wants to RECEIVE. So putting
// `usedtx=1` in our offer/answer asks the REMOTE side to use DTX when sending
// to us. Both ends run this same code, so each asks the other, and both
// directions end up tuned — there is nothing to negotiate or agree on beyond
// that.
//
// Why it matters here specifically: this is a mesh, so a client encodes and
// uploads its microphone SEPARATELY to every peer. At 16 peers, anything
// per-stream is multiplied by 16 on a single home or office uplink, and when
// that link saturates the browser's congestion control does not politely
// degrade one stream — everyone's audio starts breaking up at once.
//
//  - usedtx=1: stop sending during silence (send comfort noise instead).
//    Conversation is mostly silence per participant, so across 16 peers this
//    is the single largest saving available, and it costs nothing audible.
//  - useinbandfec=1: carry a low-bitrate copy of the previous frame, so a
//    single lost packet is reconstructed instead of heard as a dropout. This
//    is the one that turns "audio is choppy" into "audio is fine" on a lossy
//    link. Chrome already sets this by default; being explicit means it also
//    holds on browsers that do not.
//  - maxaveragebitrate: a receive-side ceiling. Speech at 24 kbps is
//    transparent enough for conversation, and it bounds the mesh total
//    predictably rather than letting each stream negotiate its own maximum.
//  - stereo=0: voice is mono. Stereo would double the payload for nothing.
//
// Deliberately NOT touching ptime/maxptime: larger packets would cut packet
// rate (real overhead at 16 peers) but add latency to every conversation, and
// latency is not the problem being solved here.
const OPUS_PARAMS: Record<string, string> = {
  usedtx: '1',
  useinbandfec: '1',
  maxaveragebitrate: '24000',
  stereo: '0',
};

const EOL_CRLF = '\r\n';

/**
 * Returns `sdp` with the Opus fmtp parameters above set on every Opus payload
 * type, preserving any parameters already there (Chrome's own `minptime=10`,
 * for one) and leaving every other codec untouched.
 *
 * Pure and idempotent: running it on its own output changes nothing.
 */
export function tuneOpusForVoice(sdp: string): string {
  if (!sdp) return sdp;
  const eol = sdp.includes(EOL_CRLF) ? EOL_CRLF : '\n';
  const lines = sdp.split(/\r\n|\r|\n/);

  // Opus can legitimately appear more than once in one SDP (multiple m=audio
  // sections, or a second payload type for a different clock rate), and the
  // payload numbers are dynamic — they have to be read out, never assumed.
  const opusPayloadTypes: string[] = [];
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+)\s+opus\//i.exec(line);
    if (m) opusPayloadTypes.push(m[1]);
  }
  if (!opusPayloadTypes.length) return sdp;

  const out: string[] = [];
  const handled = new Set<string>();

  for (const line of lines) {
    const fmtp = /^a=fmtp:(\d+)\s+(.*)$/.exec(line);
    if (fmtp && opusPayloadTypes.includes(fmtp[1])) {
      out.push(`a=fmtp:${fmtp[1]} ${mergeParams(fmtp[2])}`);
      handled.add(fmtp[1]);
      continue;
    }
    out.push(line);
    // No fmtp line for this payload type yet — the parameters have to live
    // somewhere, so one is created directly after its rtpmap (where a browser
    // would have put it).
    const rtpmap = /^a=rtpmap:(\d+)\s+opus\//i.exec(line);
    if (rtpmap && !handled.has(rtpmap[1])) {
      const pt = rtpmap[1];
      const hasFmtp = lines.some((l) => new RegExp(`^a=fmtp:${pt}\\s`).test(l));
      if (!hasFmtp) {
        out.push(`a=fmtp:${pt} ${mergeParams('')}`);
        handled.add(pt);
      }
    }
  }

  return out.join(eol);
}

/** Existing `key=value;key=value` list with OPUS_PARAMS applied over the top,
 *  keeping the original order and anything we do not set ourselves. */
function mergeParams(existing: string): string {
  const parts = existing.split(';').map((p) => p.trim()).filter(Boolean);
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const part of parts) {
    const eq = part.indexOf('=');
    const key = eq === -1 ? part : part.slice(0, eq);
    if (key in OPUS_PARAMS) {
      if (seen.has(key)) continue; // a duplicate key in the input, drop it
      merged.push(`${key}=${OPUS_PARAMS[key]}`);
    } else {
      merged.push(part);
    }
    seen.add(key);
  }

  for (const [key, value] of Object.entries(OPUS_PARAMS)) {
    if (!seen.has(key)) merged.push(`${key}=${value}`);
  }

  return merged.join(';');
}
