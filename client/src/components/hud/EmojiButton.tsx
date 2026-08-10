import { useState } from 'react';
import { EmojiSmile } from 'react-bootstrap-icons';

interface EmojiButtonProps {
  open: boolean;
  onToggle: () => void;
}

// Surfaces the emote wheel (see App.tsx's showEmoteWheel/setShowEmoteWheel) as
// a click target — that toggle previously had no button at all, only the "B"
// keyboard shortcut (a deliberate choice per its own comment, since guests
// can't use emotes). onToggle here is the exact same setter the hotkey
// already calls; no new state or behavior, just a second way to reach it.
export function EmojiButton({ open, onToggle }: EmojiButtonProps) {
  const [showLabel, setShowLabel] = useState(false);

  return (
    <button
      onClick={onToggle}
      onMouseEnter={() => setShowLabel(true)}
      onMouseLeave={() => setShowLabel(false)}
      className={`relative flex items-center justify-center w-11 h-11 rounded-full backdrop-blur-xl border shadow-lg transition-all hover:scale-105 cursor-pointer ${
        open
          ? 'bg-purple-600 border-purple-500 shadow-purple-500/30'
          : 'bg-white/90 dark:bg-gray-800/90 border-purple-200/60 dark:border-white/10 shadow-purple-500/10'
      }`}
      title="Emoji reaction (B)"
    >
      <EmojiSmile className={open ? 'text-white' : 'text-purple-700 dark:text-purple-300'} size={18} />
      {showLabel && (
        <span className="absolute -top-8 whitespace-nowrap text-xs bg-white dark:bg-gray-800 text-purple-700 dark:text-purple-300 border border-purple-100 dark:border-gray-700 shadow-sm px-2 py-0.5 rounded">
          Emoji reaction (B)
        </span>
      )}
    </button>
  );
}
