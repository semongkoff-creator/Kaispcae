import { useState, useEffect } from 'react';
import { isTypingTarget } from '@/utils/hotkeys';

interface HandButtonProps {
  raised: boolean;
  onToggle: () => void;
}

// "Raise hand" toggle (ZEP/Gather meeting cue). Sits in the same bottom HUD
// row as Mic/Camera/Screen-share. When raised, the player shows a ✋ badge
// over their avatar in-world and on their video tile in Meeting View (see
// AvatarSprite.ts / VideoGrid.tsx). Keyboard shortcut: H.
export function HandButton({ raised, onToggle }: HandButtonProps) {
  const [showLabel, setShowLabel] = useState(false);

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
    <button
      onClick={onToggle}
      onMouseEnter={() => setShowLabel(true)}
      onMouseLeave={() => setShowLabel(false)}
      className={`relative flex items-center justify-center w-11 h-11 rounded-full backdrop-blur-xl border shadow-lg transition-all hover:scale-105 cursor-pointer ${
        raised
          ? 'bg-amber-400 border-amber-300 shadow-amber-400/30'
          : 'bg-white/90 dark:bg-gray-800/90 border-purple-200/60 dark:border-white/10 shadow-purple-500/10'
      }`}
      title="Raise hand (H)"
    >
      {/* Literal emoji, not a Bootstrap Icons glyph — checked the full icon
          set (HandIndex*, HandThumbs*, PersonRaisedHand) and none of them
          read clearly as "raise hand" at 18px; PersonRaisedHand (tried
          previously) is a person silhouette with an arm up, easy to mistake
          for a generic person icon at a glance. ✋ is unambiguous and needs
          no new icon library (Lucide isn't installed in this project).
          text-* classes don't recolor emoji glyphs, so only the
          animation/opacity carry over from the icon version. */}
      <span className={`text-lg leading-none ${raised ? 'animate-bounce' : 'opacity-70'}`}>✋</span>
      {showLabel && (
        <span className="absolute -top-8 whitespace-nowrap text-xs bg-white dark:bg-gray-800 text-purple-700 dark:text-purple-300 border border-purple-100 dark:border-gray-700 shadow-sm px-2 py-0.5 rounded">
          {raised ? 'Lower hand (H)' : 'Raise hand (H)'}
        </span>
      )}
    </button>
  );
}
