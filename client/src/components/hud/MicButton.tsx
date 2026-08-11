import { useEffect } from 'react';
import { MicFill, MicMuteFill } from 'react-bootstrap-icons';
import { isTypingTarget } from '@/utils/hotkeys';
import { Tooltip } from '@/components/ui/Tooltip';

interface MicButtonProps {
  muted: boolean;
  onToggle: () => void;
}

export function MicButton({ muted, onToggle }: MicButtonProps) {
  // M key shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't fire while the user is typing — the Docs editor is
      // contenteditable, so this key would be swallowed mid-word.
      if (isTypingTarget(e.target)) return;
      if (e.key === 'm' || e.key === 'M') {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        onToggle();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onToggle]);

  return (
    <Tooltip
      label={`Mikrofon (M) — ${muted ? 'Mati' : 'Aktif'}`}
      detail="Nyalakan/matikan mikrofonmu. Orang lain di zone/meeting yang sama akan mendengarmu saat aktif."
    >
      <button
        onClick={onToggle}
        // "Ethereal Collaboration" — live/unmuted now reads as the primary
        // solid-purple action state (same treatment ScreenShareButton already
        // uses for "currently sharing"), not just a neutral glass icon. Muted
        // keeps the glass surface with a red icon/ring — that part was already
        // on-spec, untouched.
        className={`relative flex items-center justify-center w-11 h-11 rounded-full backdrop-blur-xl border shadow-lg transition-all hover:scale-105 cursor-pointer ${
          muted
            ? 'bg-white/90 dark:bg-gray-800/90 border-purple-200/60 dark:border-white/10 shadow-purple-500/10'
            : 'bg-purple-600 border-purple-500 shadow-purple-500/30'
        }`}
      >
        {muted ? <MicMuteFill className="text-red-500" size={18} /> : <MicFill className="text-white" size={18} />}
        {muted && (
          <div className="absolute inset-0 rounded-full border-2 border-red-500 animate-pulse" />
        )}
      </button>
    </Tooltip>
  );
}
