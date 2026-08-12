import { EmojiSmile } from 'react-bootstrap-icons';
import { Tooltip } from '@/components/ui/Tooltip';

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
  return (
    <Tooltip
      label="Emoji (B)"
      detail="Tampilkan pilihan reaksi/emote yang muncul di atas avatarmu, terlihat oleh semua orang di ruangan."
    >
      <button
        onClick={onToggle}
        className={`relative flex items-center justify-center w-10 h-10 rounded-full backdrop-blur-xl border shadow-lg transition-all hover:scale-105 cursor-pointer ${
          open
            ? 'bg-purple-600 border-purple-500 shadow-purple-500/30'
            : 'bg-white/90 dark:bg-gray-800/90 border-purple-200/60 dark:border-white/10 shadow-purple-500/10'
        }`}
      >
        <EmojiSmile className={open ? 'text-white' : 'text-purple-700 dark:text-purple-300'} size={16} />
      </button>
    </Tooltip>
  );
}
