// In-game sound effects, played from bundled audio files rather than
// synthesized Web Audio blips. The old oscillator approach created a fresh
// AudioContext per call from a socket-event callback (not a user gesture),
// which the browser autoplay policy frequently left "suspended" so nothing
// was ever heard — plus Chrome caps the number of live AudioContexts. An
// <audio> element playing a real asset sidesteps both: once the user has
// interacted with the page (they clicked to join the room), .play() works.
import { getNotificationSettings } from './browserNotifications';
import { calcGain } from '@/hooks/useProximity';

const NUDGE_SRC = '/assets/sfx/nudge.wav';
const NUDGE_STRONG_SRC = '/assets/sfx/nudge-strong.wav';

// Preload one element per clip so the file is fetched/decoded up front; we
// clone it per play so rapid repeats overlap instead of cutting each other
// off (a single shared element would restart mid-sound).
const preloaded = new Map<string, HTMLAudioElement>();
function preload(src: string): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null;
  let el = preloaded.get(src);
  if (!el) {
    el = new Audio(src);
    el.preload = 'auto';
    preloaded.set(src, el);
  }
  return el;
}
if (typeof window !== 'undefined') {
  preload(NUDGE_SRC);
  preload(NUDGE_STRONG_SRC);
}

function playClip(src: string, volume: number): void {
  if (!getNotificationSettings().soundOn) return;
  const base = preload(src);
  if (!base) return;
  // cloneNode gives an independent playback that can overlap; falls back to a
  // fresh Audio() if cloning isn't available for some reason.
  const node = (base.cloneNode() as HTMLAudioElement) ?? new Audio(src);
  node.volume = Math.max(0, Math.min(1, volume));
  // Autoplay may still reject if no gesture has happened yet — swallow it,
  // a missed blip isn't worth surfacing.
  node.play().catch(() => {});
}

// `emphasized` = this client is the one actually being nudged: a louder,
// doubled "knock" so it clearly reads as "someone poked YOU", versus the
// quieter single pop everyone else in the room hears. Gated on the user's
// sound setting, same as chat notifications.
export function playNudgeSound(emphasized = false): void {
  if (emphasized) {
    playClip(NUDGE_STRONG_SRC, 0.9);
  } else {
    playClip(NUDGE_SRC, 0.5);
  }
}

// Bug 14 — raise-hand chime for others in the same zone. Reuses the soft nudge
// clip (no separate audio system) at a gentle volume so it reads as a polite
// "someone wants to speak" cue, not an alarming knock. Same sound-setting gate
// as everything else via playClip.
export function playHandRaiseSound(): void {
  playClip(NUDGE_SRC, 0.35);
}

// Soundboard — unlike the fixed clips above, the src here is dynamic (one of
// SOUNDBOARD_DEFAULT_SOUNDS or a room's own uploaded sound), so it can't be
// preloaded up front the same way; a plain Audio() per play is fine since
// these are short (≤5s) one-shot clips, not something played back-to-back
// fast enough to need the clone-node overlap trick.
//
// Bug — this used to share playClip's `soundOn` gate, framed in the UI
// purely as "Notification Sound" (nested under a "Notifications" popover,
// disabled whenever browser notifications themselves are off). Someone
// muting notification pings had no way to know it was ALSO silently
// killing every soundboard click with zero feedback (a swallowed
// .play().catch, same as everywhere else) — indistinguishable from "the
// soundboard is just broken". A soundboard click is always a deliberate,
// visible user action (the button greys out during its own cooldown), not
// a passive background notification, so it doesn't belong behind that
// toggle at all.
// Bug — a soundboard clip's volume was only ever set ONCE, at the instant
// it started playing, from whatever the listener's distance to the sender
// happened to be right then. Walking away mid-clip had zero effect: it
// just kept blasting at that original volume until it finished playing
// (up to SOUNDBOARD_MAX_DURATION_MS, several seconds), completely
// ignoring the listener's real-time movement — unlike mic/camera, which
// already fades continuously via calcGain as you move. Tracked here by
// sender id so updateSoundboardVolumes (called from the same proximity-
// recalculation effect that already drives WebRTC's volume) can keep it
// in sync for as long as it's actually playing.
const activeSoundboardAudio = new Map<string, HTMLAudioElement>();
const SOUNDBOARD_BASE_VOLUME = 0.7;

export function playSoundboardClip(fromId: string, src: string): void {
  if (typeof Audio === 'undefined') return;
  const node = new Audio(src);
  node.volume = SOUNDBOARD_BASE_VOLUME;
  node.play().catch(() => {});
  activeSoundboardAudio.set(fromId, node);
  node.addEventListener('ended', () => {
    if (activeSoundboardAudio.get(fromId) === node) activeSoundboardAudio.delete(fromId);
  }, { once: true });
}

// Called on every proximity recalculation (App.tsx's updateProximity
// effect) — mutes (not pauses) a playing clip once its sender falls out of
// range, and un-mutes it again if the listener walks back within range
// before it finishes, same real-time behavior as a live voice call rather
// than a one-shot decision made at click time.
export function updateSoundboardVolumes(nearby: { id: string; distanceTiles: number; viaZone?: boolean }[]): void {
  if (activeSoundboardAudio.size === 0) return;
  for (const [fromId, node] of activeSoundboardAudio) {
    const p = nearby.find((n) => n.id === fromId);
    const gain = p ? (p.viaZone ? 1 : calcGain(p.distanceTiles)) : 0;
    node.volume = Math.max(0, Math.min(1, SOUNDBOARD_BASE_VOLUME * gain));
  }
}
