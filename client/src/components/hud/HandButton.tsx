import { useEffect } from 'react';
import { isTypingTarget } from '@/utils/hotkeys';
import { Tooltip } from '@/components/ui/Tooltip';

interface HandButtonProps {
  raised: boolean;
  onToggle: () => void;
}

// "Raise hand" toggle (ZEP/Gather meeting cue). Sits in the same bottom HUD
// row as Mic/Camera/Screen-share. When raised, the player shows the same
// raise-hand icon over their avatar in-world and on their video tile in
// Meeting View (see AvatarSprite.ts / VideoGrid.tsx). Keyboard shortcut: H.
export function HandButton({ raised, onToggle }: HandButtonProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't fire while the user is typing — the Docs editor is
      // contenteditable, so this key would be swallowed mid-word.
      if (isTypingTarget(e.target)) return;
      if (e.key === 'h' || e.key === 'H') {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        onToggle();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onToggle]);

  return (
    <Tooltip
      label={raised ? 'Turunkan Tangan (H)' : 'Angkat Tangan (H)'}
      detail="Tandai kalau kamu ingin bicara atau butuh perhatian. Ikon muncul di avatar & video tile-mu, disertai suara notifikasi untuk peserta lain."
    >
      <button
        onClick={onToggle}
        className={`relative flex items-center justify-center w-10 h-10 rounded-full backdrop-blur-xl border shadow-lg transition-all hover:scale-105 cursor-pointer ${
          raised
            ? 'bg-amber-400 border-amber-300 shadow-amber-400/30'
            : 'bg-white/90 dark:bg-gray-800/90 border-purple-200/60 dark:border-white/10 shadow-purple-500/10'
        }`}
      >
        {/* User-supplied icon (checked react-bootstrap-icons' full hand set
            previously — HandIndex*, HandThumbs*, PersonRaisedHand — none read
            clearly at 18px; a plain ✋ emoji worked but looked inconsistent
            once this custom icon replaced it everywhere else raised-hand
            shows, see AvatarSprite.ts/VideoGrid.tsx/ParticipantPanel.tsx).
            A flat-colored PNG can't be recolored via text-* classes the way
            every sibling button's react-bootstrap-icons SVG can (ScreenShare/
            People/DeviceMenu all use `size={16}` + a `text-purple-700
            dark:text-purple-300` className) — used it as a CSS mask instead
            of an <img> so bg-* classes tint it the same way, same color
            language as those siblings rather than a fixed-tint image.
            Matched exactly to the siblings' 16px now (w-4 = 16px) after
            three rounds of "still too big" (w-8/32px, w-7/28px, w-5/20px) —
            the extra box for the thin outline art to stay legible mattered
            less than just matching the rest of the bar. */}
        <span
          role="img"
          aria-label=""
          className={`w-4 h-4 ${raised ? 'bg-white animate-bounce' : 'bg-purple-700 dark:bg-purple-300'}`}
          style={{
            maskImage: 'url(/assets/img/raise-hand-icon.png)',
            maskSize: 'contain',
            maskPosition: 'center',
            maskRepeat: 'no-repeat',
            WebkitMaskImage: 'url(/assets/img/raise-hand-icon.png)',
            WebkitMaskSize: 'contain',
            WebkitMaskPosition: 'center',
            WebkitMaskRepeat: 'no-repeat',
          }}
        />
      </button>
    </Tooltip>
  );
}
