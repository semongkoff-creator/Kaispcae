import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { VolumeUpFill } from 'react-bootstrap-icons';
import { useGameStore } from '@/stores/gameStore';
import { playAnnouncementSound } from '@/services/soundEffects';

// Pixels per second the text travels. Slow enough to read comfortably at a
// glance, brisk enough that a short announcement doesn't linger. Reading
// speed is a constant here — length changes the DURATION, never the speed.
const SCROLL_SPEED_PX_PER_SEC = 110;
// Once to catch the eye, once to actually read.
const LOOPS = 2;
// Roughly how long a static (reduced-motion) card needs to stay up. Average
// silent reading is ~4 words/second; the floor covers very short messages
// that would otherwise flash past.
const STATIC_MS_PER_WORD = 260;
const STATIC_MIN_MS = 4000;
const STATIC_MAX_MS = 25000;

// How long the chime rings before the text appears.
//
// Not the clip's full 4.8 seconds. An announcement is usually the thing
// somebody most needs to read, and holding a blank screen for five seconds to
// finish playing a jingle gets that backwards. This is the length of the
// attention-getting part; the rest of the chime rings out underneath the text,
// which is what a real PA system does — the voice starts while the bell is
// still fading.
const ANNOUNCE_LEAD_IN_MS = 1800;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Room-wide admin announcement, shown as a running text strip across the top
 * of the screen.
 *
 * Only ever renders the head of the queue, and removes it once it has had its
 * run — which is what lets the next one start. See gameStore's broadcastQueue
 * for why announcements queue rather than overwrite.
 */
export function AnnouncementTicker() {
  const current = useGameStore((s) => s.broadcastQueue[0]);
  const dismiss = useGameStore((s) => s.dismissCurrentBroadcast);

  const stripRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [travel, setTravel] = useState<number | null>(null);
  const [reduced, setReduced] = useState(prefersReducedMotion);
  // Whether this message's chime has had its head start yet.
  const [revealed, setRevealed] = useState(false);

  // A preference can change mid-session (OS setting, or a browser toggle).
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const messageKey = current ? `${current.sentAt}:${current.text}` : null;

  // Chime first, text second.
  //
  // Driven by which message is CURRENT rather than by the socket event, so a
  // queued announcement chimes when its own turn comes. Chiming on arrival
  // would fire it while the previous message is still scrolling — sound and
  // text describing different announcements at the same moment.
  useEffect(() => {
    if (!messageKey) { setRevealed(false); return; }
    setRevealed(false);
    playAnnouncementSound();
    const timer = setTimeout(() => setRevealed(true), ANNOUNCE_LEAD_IN_MS);
    return () => clearTimeout(timer);
  }, [messageKey]);

  // Measure before paint, so the strip never shows a frame at the wrong
  // offset. Re-measured per message because the distance depends on that
  // message's own width — and on the viewport, which is why a resize has to
  // redo it too.
  useLayoutEffect(() => {
    // Nothing is in the DOM until the chime's lead-in is over, so measuring
    // before that would read null refs once and never run again.
    if (!messageKey || reduced || !revealed) { setTravel(null); return; }
    const measure = () => {
      const strip = stripRef.current;
      const text = textRef.current;
      if (!strip || !text) return;
      // Text starts flush against the right edge (translateX(0) with a
      // left margin of 100%) and must travel its own width plus the strip's
      // before it has completely left on the other side.
      setTravel(text.offsetWidth + strip.offsetWidth);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [messageKey, reduced, revealed]);

  // Reduced motion has no animation to end, so its dismissal is on a timer
  // sized to how long the text takes to read.
  useEffect(() => {
    if (!current || !reduced || !revealed) return;
    const words = current.text.trim().split(/\s+/).length;
    const ms = Math.min(STATIC_MAX_MS, Math.max(STATIC_MIN_MS, words * STATIC_MS_PER_WORD));
    const timer = setTimeout(dismiss, ms);
    return () => clearTimeout(timer);
  }, [current, reduced, revealed, dismiss]);

  // Safety net for the animated path. `animationend` is the normal exit, but
  // it never fires if the element is display:none'd by a background tab
  // throttling animations, or if the measurement somehow yielded nothing —
  // and a stuck head-of-queue would block every later announcement forever.
  useEffect(() => {
    if (!current || reduced || !revealed) return;
    const seconds = travel ? (travel / SCROLL_SPEED_PX_PER_SEC) * LOOPS : 0;
    const timer = setTimeout(dismiss, (seconds + 5) * 1000);
    return () => clearTimeout(timer);
  }, [current, reduced, revealed, travel, dismiss]);

  // The chime is playing; the strip arrives when it has had its head start.
  if (!current || !revealed) return null;

  const body = (
    <>
      <span className="text-[11px] font-medium uppercase tracking-wider opacity-75">
        Pengumuman · {current.senderName}
      </span>
      <span className="font-semibold">{current.text}</span>
    </>
  );

  // Static, wrapped, centred — readable without any motion at all.
  if (reduced) {
    return (
      <div className="fixed top-0 left-0 right-0 z-[55] bg-teal-600 text-white shadow-lg pointer-events-none">
        <div className="max-w-3xl mx-auto px-4 py-2 flex items-start gap-2.5">
          <VolumeUpFill size={15} className="shrink-0 mt-1" />
          <div className="flex flex-col gap-0.5 text-sm">{body}</div>
        </div>
      </div>
    );
  }

  const durationSec = travel ? travel / SCROLL_SPEED_PX_PER_SEC : 0;

  return (
    <div
      ref={stripRef}
      className="fixed top-0 left-0 right-0 z-[55] bg-teal-600 text-white shadow-lg overflow-hidden pointer-events-none"
      // Announced once to assistive tech as a whole, rather than letter by
      // letter as it scrolls past.
      role="status"
      aria-live="polite"
    >
      <div className="py-1.5 flex items-center">
        <VolumeUpFill size={15} className="shrink-0 ml-3 mr-1" />
        <div className="flex-1 overflow-hidden">
          <span
            // Forces a remount per message. Without it React reuses this same
            // element for the next announcement, and a running CSS animation
            // does NOT restart on a style change — message two would pick up
            // wherever message one left off, appearing mid-scroll or already
            // finished. The key is also what makes the measurement below
            // re-run against the new text.
            key={messageKey}
            ref={textRef}
            // ml-[100%] parks the text just past the right edge at
            // translateX(0), so the keyframes only ever need to move it one
            // direction — no negative start offset to keep in sync.
            className={`inline-flex items-baseline gap-3 whitespace-nowrap ml-[100%] text-sm ${travel ? 'animate-announcement' : 'invisible'}`}
            style={travel ? {
              // Consumed by the @keyframes in index.css.
              ['--announce-travel' as string]: `${travel}px`,
              ['--announce-duration' as string]: `${durationSec}s`,
              ['--announce-loops' as string]: String(LOOPS),
            } : undefined}
            onAnimationEnd={dismiss}
          >
            {body}
          </span>
        </div>
      </div>
    </div>
  );
}
