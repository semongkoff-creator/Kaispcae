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
        // Flat/borderless toolbar restyle (see MicButton's own comment) —
        // no purple-when-open pill any more; emoticon.svg is already the
        // same dark gray every other flat icon in this bar uses.
        className="flex items-center justify-center w-10 h-10 rounded-lg transition-all hover:scale-105 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
      >
        <img src="/assets/img/icons/emoticon.svg" width={16} height={16} alt="" />
      </button>
    </Tooltip>
  );
}
