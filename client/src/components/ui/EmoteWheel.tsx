import { useCallback, useEffect } from 'react';
import { isTypingTarget } from '@/utils/hotkeys';
import { EMOTE_LIST, EMOTE_LABELS, EMOTE_EMOJI, EmoteType } from '@kaispace/shared';

interface EmoteWheelProps {
  open: boolean;
  onSelect: (emote: EmoteType) => void;
  onClose: () => void;
}

export function EmoteWheel({ open, onSelect, onClose }: EmoteWheelProps) {
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'b' || e.key === 'B') {
      // Same guard as App.tsx's opener — see utils/hotkeys.ts.
      if (isTypingTarget(e.target)) return;
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    if (open) {
      window.addEventListener('keydown', handleKey);
      return () => window.removeEventListener('keydown', handleKey);
    }
  }, [open, handleKey]);

  if (!open) return null;

  return (
    // Straight horizontal row anchored above the bottom-center HUD toolbar
    // (mb-24 clears the toolbar's own ~64px pill + gap) — was a ring of
    // buttons centered on the whole screen (cx/cy/r trig), which visually
    // surrounded the avatar rather than reading as a toolbar menu. Same
    // full-screen click-outside-to-close backdrop as before; z-[60] — above
    // the persistent HUD's z-50, since this is a transient overlay the HUD
    // shouldn't render in front of while it's open (unlike MeetingView,
    // deliberately z-40 so the HUD stays usable during that mode).
    //
    // Centered via the OUTER flex container (justify-center), not the usual
    // left-1/2 -translate-x-1/2 on this row itself — animate-fade-in's own
    // keyframes set `transform: translateY(...)`, which replaces rather than
    // combines with a translateX already on the same element, so the row's
    // LEFT EDGE (not its center) ended up pinned to the viewport's midpoint
    // once the animation settled. Flexbox centering needs no transform at
    // all, so it's immune to that clash — confirmed via a live bounding-box
    // measurement (row was starting exactly at viewport-center-x, not
    // centered on it) before landing on this fix.
    <div className="absolute inset-0 z-[60] flex items-end justify-center" onClick={onClose}>
      <div
        className="mb-24 flex items-center gap-1.5 bg-white/90 dark:bg-gray-800/90 backdrop-blur-xl border border-purple-200/60 dark:border-white/10 shadow-lg shadow-purple-500/10 rounded-full px-3 py-2 pointer-events-auto animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        {EMOTE_LIST.map((emote) => (
          // Real emoji glyph, not a Bootstrap icon standing in for it — this
          // used to show a themed-but-different icon per emote (e.g. a
          // pointing hand for "wave", a balloon for "party"), which didn't
          // match the actual EMOTE_EMOJI glyph the canvas-drawn bubble shows
          // above your avatar once picked. Same fix already used by
          // MeetingView.tsx's own reaction strip — render EMOTE_EMOJI
          // directly so the picker always shows exactly what you'll get.
          <button
            key={emote}
            onClick={() => onSelect(emote)}
            className="w-9 h-9 rounded-full flex items-center justify-center text-xl hover:bg-purple-100 dark:hover:bg-gray-700 hover:scale-110 transition-all cursor-pointer"
            title={EMOTE_LABELS[emote]}
          >
            {EMOTE_EMOJI[emote]}
          </button>
        ))}
      </div>
    </div>
  );
}
