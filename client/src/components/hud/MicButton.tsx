import { useEffect } from 'react';
import { isTypingTarget } from '@/utils/hotkeys';
import { Tooltip } from '@/components/ui/Tooltip';
import { DeviceCaret } from './DeviceCaret';

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
    <div className="flex items-center">
      <Tooltip
        label={`Mikrofon (M) — ${muted ? 'Mati' : 'Aktif'}`}
        detail="Nyalakan/matikan mikrofonmu. Orang lain di zone/meeting yang sama akan mendengarmu saat aktif."
      >
        <button
          onClick={onToggle}
          // Live/unmuted = green ring (matches the reference design's
          // green "mic is live" state, and the mic_on.svg icon itself is
          // already green-tinted) instead of the purple "Ethereal
          // Collaboration" active fill other toolbar buttons use — mic is
          // the one control where "on" needs its own distinct color, not
          // the generic active-panel purple. Muted keeps the glass
          // surface + red icon/ring, unchanged.
          className={`relative flex items-center justify-center w-10 h-10 rounded-full backdrop-blur-xl border shadow-lg transition-all hover:scale-105 cursor-pointer bg-white/90 dark:bg-gray-800/90 ${
            muted ? 'border-login-border-soft dark:border-white/10 shadow-purple-500/10' : 'border-green-500 shadow-green-500/20'
          }`}
        >
          <img src={`/assets/img/icons/${muted ? 'mic' : 'mic_on'}.svg`} width={16} height={16} alt="" />
          {muted ? (
            <div className="absolute inset-0 rounded-full border-2 border-red-500 animate-pulse" />
          ) : (
            <div className="absolute inset-0 rounded-full border-2 border-green-500" />
          )}
        </button>
      </Tooltip>
      <DeviceCaret kind="mic" label="Mikrofon" />
    </div>
  );
}
