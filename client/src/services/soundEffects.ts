// In-game sound effects, played from bundled audio files rather than
// synthesized Web Audio blips. The old oscillator approach created a fresh
// AudioContext per call from a socket-event callback (not a user gesture),
// which the browser autoplay policy frequently left "suspended" so nothing
// was ever heard — plus Chrome caps the number of live AudioContexts. An
// <audio> element playing a real asset sidesteps both: once the user has
// interacted with the page (they clicked to join the room), .play() works.
import { getNotificationSettings } from './browserNotifications';

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
