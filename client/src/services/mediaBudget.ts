// How much bitrate one screen-share sender gets, given how many peers it is
// being sent to.
//
// In a mesh there is no server relaying anything: a screen share is encoded
// and uploaded SEPARATELY to every peer. So the cost to the presenter is
// per-peer bitrate x peer count, and that lands entirely on their own
// UPLOAD link — the one resource no amount of server capacity or client CPU
// can substitute for. A fixed 2.5 Mbps per peer (what this replaces) meant
// sharing to 4 people cost 10 Mbps up, and to 16 people 40 Mbps: far past
// what an ordinary office or home connection can send, at which point the
// congestion does not politely degrade the screen share — it takes the
// AUDIO down with it, for everyone, because it is all the same uplink.
//
// So the presenter gets a total budget instead, split across whoever is
// actually watching. Sharing to a handful of people keeps today's quality
// exactly; sharing to a crowd degrades the picture instead of the call.
//
// 9 Mbps as the aggregate: comfortably within a business fibre uplink while
// leaving room for the mic (~40 kbps/peer) and camera alongside it.
const SCREEN_SHARE_TOTAL_BUDGET_BPS = 9_000_000;
// Per-peer ceiling — the old fixed value. Screen content at 1080p/15fps has
// nothing to gain past this, so a small audience gets exactly what it got
// before rather than a bigger number.
const SCREEN_SHARE_MAX_PER_PEER_BPS = 2_500_000;
// Per-peer floor. Below roughly this, screen text stops being readable and
// the share is pointless — better to overshoot the budget than to send
// something nobody can use. A crowd big enough to hit this floor is a sign
// the room needs an SFU, not a smaller number.
const SCREEN_SHARE_MIN_PER_PEER_BPS = 600_000;

export function screenShareBitrateFor(peerCount: number): number {
  if (peerCount <= 1) return SCREEN_SHARE_MAX_PER_PEER_BPS;
  const share = Math.floor(SCREEN_SHARE_TOTAL_BUDGET_BPS / peerCount);
  return Math.min(SCREEN_SHARE_MAX_PER_PEER_BPS, Math.max(SCREEN_SHARE_MIN_PER_PEER_BPS, share));
}

// Aggregate upload a presenter is asking of their own connection — what the
// budget above exists to bound. Exported for the tests, which assert the
// shape of the curve rather than individual magic numbers.
export function totalScreenShareUploadBps(peerCount: number): number {
  return screenShareBitrateFor(peerCount) * Math.max(0, peerCount);
}
