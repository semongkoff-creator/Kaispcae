import { useEffect } from 'react';
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
        className={`relative flex items-center justify-center w-10 h-10 rounded-full backdrop-blur-xl border shadow-lg transition-all hover:scale-105 cursor-pointer ${
          muted
            ? 'bg-white/90 dark:bg-gray-800/90 border-login-border-soft dark:border-white/10 shadow-purple-500/10'
            : 'bg-login-accent border-login-accent shadow-purple-500/30'
        }`}
      >
        {/* mic.svg (neutral) / mic_on.svg (green, both fixed-color real
            assets) — the pulsing red ring below stays the primary "you're
            muted" signal since the icon itself can't be recolored to red. */}
        <img src={`/assets/img/icons/${muted ? 'mic' : 'mic_on'}.svg`} width={16} height={16} alt="" />
        {muted && (
          <div className="absolute inset-0 rounded-full border-2 border-red-500 animate-pulse" />
        )}
      </button>
    </Tooltip>
  );
}
