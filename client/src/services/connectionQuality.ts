// Turning "it feels heavy" into a claim someone can act on.
//
// Every failure this app has been chased through — a relay that was never
// configured, peers refused past the connection cap, a negotiation that hung,
// a screen share stalled mid-frame — shares one shape: it fails and nothing
// says so. The user is left to guess between "the app is broken" and "my
// internet is bad", and both sides of that guess are unfalsifiable from where
// they sit.
//
// A mesh makes that guess answerable, which is the one diagnostic advantage it
// has over an SFU: there is no server in the media path, so every measurement
// here is of the real link between two specific people. If EVERY peer looks
// bad the common factor is this machine; if ONE does, it is that pair. A
// client-server topology cannot separate those two without server-side data.
//
// Deliberately a pure module: no getStats, no React, no store. The sampling
// lives in webrtcService (which owns the peer connections) and the publishing
// in stores/connectionQuality.ts. Thresholds are a judgement call, so they are
// named constants that a real measurement can overrule later — see the note on
// each one for what it is actually claiming.

/** Worst-of the individual signals, not an average — one bad axis is enough. */
export type QualityLevel = 'good' | 'fair' | 'poor' | 'unknown';

/**
 * What the browser told us about the limitation, verbatim from
 * RTCOutboundRtpStreamStats.qualityLimitationReason. This is the only field
 * anywhere that distinguishes "your laptop cannot keep up" from "your network
 * cannot", and it comes from the encoder itself rather than being inferred.
 */
export type LimitationReason = 'none' | 'cpu' | 'bandwidth' | 'other';

export interface PeerQualitySample {
  /** candidate-pair currentRoundTripTime, in ms. Null before ICE settles. */
  rttMs: number | null;
  /** inbound-rtp audio jitter, in ms. The best proxy for an unstable link. */
  jitterMs: number | null;
  /** Loss over the LAST sampling window, percent. Not the cumulative figure. */
  lossPct: number | null;
  /** candidate-pair availableOutgoingBitrate — real uplink, not the plan. */
  availableOutgoingBps: number | null;
  limitation: LimitationReason | null;
  /** Either end of the nominated pair is a TURN relay candidate. */
  relayed: boolean;
}

export interface PeerQuality {
  level: QualityLevel;
  relayed: boolean;
  /** 0-3, for the bars. 0 means "no data yet", never "dead". */
  bars: 0 | 1 | 2 | 3;
}

// Thresholds. Chosen to be defensible rather than precise, and every one of
// them should be revisited against a real session on the office network —
// these are what an ordinary VoIP call is expected to hold, not what this
// particular room actually does.
//
// RTT: 150ms one-way is the usual ceiling for conversation to feel immediate;
// past 300ms people start talking over each other.
const RTT_GOOD_MS = 150;
const RTT_FAIR_MS = 300;
// Loss: Opus with inbandfec (see sdpAudio.ts) hides a couple of percent
// convincingly. Past 5% it is audible as clipped words no matter the codec.
const LOSS_GOOD_PCT = 2;
const LOSS_FAIR_PCT = 5;
// Jitter is the WiFi tell. Ethernet sits near zero; a contended access point
// swings tens of milliseconds while its AVERAGE latency still looks fine,
// which is exactly the case a mean-only reading would call healthy.
const JITTER_GOOD_MS = 30;
const JITTER_FAIR_MS = 60;

/**
 * Below this, a screen share to even a handful of viewers cannot work: see
 * mediaBudget.ts, where the per-viewer floor is 600 kbps and the presenter
 * pays it once per viewer. 1.5 Mbps is roughly "two viewers and nothing else".
 */
const UPLINK_TIGHT_BPS = 1_500_000;

function worst(...levels: QualityLevel[]): QualityLevel {
  if (levels.includes('poor')) return 'poor';
  if (levels.includes('fair')) return 'fair';
  if (levels.includes('good')) return 'good';
  return 'unknown';
}

function band(value: number | null, good: number, fair: number): QualityLevel {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  if (value <= good) return 'good';
  if (value <= fair) return 'fair';
  return 'poor';
}

const BARS: Record<QualityLevel, 0 | 1 | 2 | 3> = { good: 3, fair: 2, poor: 1, unknown: 0 };

export function classifyPeer(sample: PeerQualitySample): PeerQuality {
  const level = worst(
    band(sample.rttMs, RTT_GOOD_MS, RTT_FAIR_MS),
    band(sample.lossPct, LOSS_GOOD_PCT, LOSS_FAIR_PCT),
    band(sample.jitterMs, JITTER_GOOD_MS, JITTER_FAIR_MS),
  );
  return { level, relayed: sample.relayed, bars: BARS[level] };
}

/**
 * Why the local side is struggling, if it is.
 *
 * 'cpu' outranks everything: the encoder reporting a CPU limitation is a
 * statement about THIS machine, so a single peer saying it is conclusive and
 * no majority is needed. Every other cause is inferred from agreement across
 * peers, which is what makes it a claim about the local link rather than about
 * one unlucky pair.
 */
export type SelfCause = 'ok' | 'cpu' | 'bandwidth' | 'unstable' | 'degraded' | 'unknown';

export interface SelfVerdict {
  cause: SelfCause;
  level: QualityLevel;
  /** How many connected peers currently look bad. */
  affected: number;
  total: number;
}

/**
 * A single peer can never be blamed on the local side. With one connection
 * there is no way to tell "my uplink is saturated" from "theirs is" — the
 * measurements are identical. Below this count the verdict stays 'unknown'
 * rather than guessing, since guessing wrong here sends someone to reset a
 * router that was never the problem.
 */
const MIN_PEERS_FOR_SELF_VERDICT = 2;

/**
 * The share of peers that must look bad before the local end is implicated.
 * Not a bare majority: in a room where two people genuinely do have bad WiFi,
 * 50% would wrongly accuse the one person whose connection is fine.
 */
const SELF_BLAME_RATIO = 0.6;

export function classifySelf(samples: PeerQualitySample[]): SelfVerdict {
  const total = samples.length;
  if (total === 0) return { cause: 'unknown', level: 'unknown', affected: 0, total: 0 };

  // CPU first, and without a quorum: the encoder is describing this machine.
  if (samples.some((s) => s.limitation === 'cpu')) {
    const affected = samples.filter((s) => s.limitation === 'cpu').length;
    return { cause: 'cpu', level: 'poor', affected, total };
  }

  const judged = samples.map((s) => ({ s, q: classifyPeer(s) }));
  const bad = judged.filter(({ q }) => q.level === 'poor');
  const affected = bad.length;

  if (total < MIN_PEERS_FOR_SELF_VERDICT) {
    return { cause: 'unknown', level: judged[0].q.level, affected, total };
  }
  if (affected / total < SELF_BLAME_RATIO) {
    // Some peers may still be bad — that is a statement about THEM, surfaced
    // per-peer rather than here.
    return { cause: 'ok', level: 'good', affected, total };
  }

  // Most peers are bad, so the common factor is this end. Now say which end
  // of "this end" — the advice differs completely.
  const jitterBad = bad.filter(({ s }) => band(s.jitterMs, JITTER_GOOD_MS, JITTER_FAIR_MS) === 'poor').length;
  const uplinkTight = samples.some(
    (s) => s.limitation === 'bandwidth'
      || (s.availableOutgoingBps !== null && s.availableOutgoingBps < UPLINK_TIGHT_BPS),
  );

  // Jitter is checked before bandwidth on purpose. A saturated link produces
  // both, but an unstable one produces only jitter — and "move closer to the
  // router" is useless advice to someone whose pipe is simply too small,
  // while "your connection is unstable" is at least true of both.
  if (jitterBad / bad.length >= 0.5) return { cause: 'unstable', level: 'poor', affected, total };
  if (uplinkTight) return { cause: 'bandwidth', level: 'poor', affected, total };
  return { cause: 'degraded', level: 'poor', affected, total };
}

/** Indonesian copy, kept beside the rules so the two cannot drift apart. */
export function selfVerdictMessage(v: SelfVerdict): string | null {
  switch (v.cause) {
    case 'cpu':
      return 'Perangkat kamu kewalahan. Coba matikan kamera atau tutup aplikasi lain.';
    case 'unstable':
      return 'Koneksi kamu tidak stabil. Kalau pakai WiFi, coba kabel LAN atau dekati router.';
    case 'bandwidth':
      return 'Upload kamu sedang tidak cukup. Share layar dan kamera akan menurun kualitasnya.';
    case 'degraded':
      return 'Koneksi kamu sedang bermasalah.';
    case 'ok':
    case 'unknown':
    default:
      return null;
  }
}

export const QUALITY_THRESHOLDS = {
  RTT_GOOD_MS,
  RTT_FAIR_MS,
  LOSS_GOOD_PCT,
  LOSS_FAIR_PCT,
  JITTER_GOOD_MS,
  JITTER_FAIR_MS,
  UPLINK_TIGHT_BPS,
  MIN_PEERS_FOR_SELF_VERDICT,
  SELF_BLAME_RATIO,
};
