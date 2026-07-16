import { useState, useEffect } from 'react';

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
      className={`relative flex items-center justify-center w-9 h-9 rounded-full backdrop-blur-sm border shadow-lg transition-all hover:scale-105 cursor-pointer text-base ${
        raised
          ? 'bg-amber-400 border-amber-300'
          : 'bg-white/90 dark:bg-gray-800/90 border-purple-200 dark:border-gray-600'
      }`}
      title="Raise hand (H)"
    >
      <span className={raised ? 'animate-bounce' : 'opacity-70'}>✋</span>
      {showLabel && (
        <span className="absolute -top-8 whitespace-nowrap text-xs bg-white dark:bg-gray-800 text-purple-700 dark:text-purple-300 border border-purple-100 dark:border-gray-700 shadow-sm px-2 py-0.5 rounded">
          {raised ? 'Lower hand (H)' : 'Raise hand (H)'}
        </span>
      )}
    </button>
  );
}
