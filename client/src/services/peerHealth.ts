// Is this peer connection stuck before it ever got off the ground?
//
// The recovery paths in webrtcService only watch ICE: 'failed' retries once,
// and 'disconnected' escalates to the same thing if it doesn't clear. Both
// assume negotiation SUCCEEDED and the media path later broke. Nothing
// watched the case where the offer/answer exchange never completed at all —
// and in that state ICE has nothing to do (no remote candidates to check
// against), so it sits in 'new' forever and neither ICE branch ever fires.
//
// The peer object stays in the service's map, which means:
//   - connectToPlayer early-returns `true` for it (it "has" the peer), so
//     the proximity tick never retries,
//   - useWebRTC keeps it in connectedRef for the same reason,
//   - and it holds one of the MAX_TOTAL_PEERS slots for the rest of the
//     session.
// The result is a pair that is silent both ways, with no error, no UI
// signal, and no path back — while every other pair in the same room works,
// which is exactly what "some people just can't hear each other" looks like.
//
// Three ways in, all seen in production logs:
//  1. Glare avoidance means only the lower socket id sends the initial offer
//     (connectToPlayer). If that side never offers — its own connectToPlayer
//     returned false because ITS peer cap was full, or because its mic
//     permission hadn't resolved yet so there was no local stream — then the
//     higher-id side waits for an offer that is never coming, while
//     believing it is connected.
//  2. An answer that outlived the connection it belonged to (a peer torn
//     down and rebuilt under the same id mid-negotiation) is ignored by
//     handleAnswer, correctly — but the live pc still never gets one.
//  3. Every peer stuck this way permanently occupies a slot, so a long
//     session degrades: the more stuck pairs accumulate, the more NEW
//     neighbours get refused by MAX_TOTAL_PEERS and stay silent too.
//
// Deliberately narrow: only "no remote description ever arrived" counts.
// A peer that negotiated and is merely still checking candidates is ICE's
// business, and it has its own timeouts — this must not race them.
export function isPeerNegotiationStuck(peer: {
  iceConnectionState: RTCIceConnectionState;
  remoteDescSet: boolean;
}): boolean {
  if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') return false;
  return !peer.remoteDescSet;
}

// How long to give a fresh peer connection to complete its offer/answer
// exchange before writing it off and rebuilding. Generously above any real
// signalling round trip (two socket hops plus SDP work — tens of
// milliseconds, even on a bad connection) so this can only ever fire on a
// negotiation that is genuinely never going to finish.
export const NEGOTIATION_TIMEOUT_MS = 8000;
