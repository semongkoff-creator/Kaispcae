import { useEffect } from 'react';
import { Mic, MicFill, MicMuteFill } from 'react-bootstrap-icons';
import { isTypingTarget } from '@/utils/hotkeys';
import { Tooltip } from '@/components/ui/Tooltip';
import { DeviceCaret } from './DeviceCaret';
import { useGameStore } from '@/stores/gameStore';

interface MicButtonProps {
  muted: boolean;
  onToggle: () => void;
}

export function MicButton({ muted, onToggle }: MicButtonProps) {
  // Isolated selector (not read in App.tsx — see that file's own comment on
  // why localSpeaking was pulled out of the top-level component after a
  // flicker diagnosis): this button re-renders on every speaking edge, but
  // nothing above it does. Same defensive `&& !muted` VideoGrid's speaking
  // selector uses, even though muted/speaking shouldn't overlap in practice.
  const speaking = useGameStore((s) => s.localSpeaking) && !muted;

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
          // Three distinct states, not two — clarified after the first pass
          // (a ring around an always-green icon) turned out unclear live:
          // idle/unmuted is neutral gray (glass surface, no ring), actively
          // speaking fills the icon in green (MicFill, matching MicMuteFill's
          // already-established "outline vs filled" pairing elsewhere in the
          // app — MiniMode/MemberListPanel/VideoGrid/ParticipantActionsMenu
          // all use MicMuteFill for muted), and muted swaps to the same
          // slashed MicMuteFill glyph everywhere else uses, in red — not the
          // plain mic.svg + red ring this used before.
          className={`relative flex items-center justify-center w-10 h-10 rounded-full backdrop-blur-xl border shadow-lg transition-all hover:scale-105 cursor-pointer bg-white/90 dark:bg-gray-800/90 ${
            muted
              ? 'border-login-border-soft dark:border-white/10 shadow-purple-500/10'
              : speaking
              ? 'border-green-500 shadow-green-500/40'
              : 'border-login-border-soft dark:border-white/10 shadow-purple-500/10'
          }`}
        >
          {muted ? (
            <MicMuteFill size={16} className="text-red-500" />
          ) : speaking ? (
            <MicFill size={16} className="text-green-500" />
          ) : (
            <Mic size={16} className="text-gray-500 dark:text-gray-400" />
          )}
          {muted && <div className="absolute inset-0 rounded-full border-2 border-red-500 animate-pulse" />}
          {speaking && <div className="absolute inset-0 rounded-full border-2 border-green-500 animate-pulse" />}
        </button>
      </Tooltip>
      <DeviceCaret kind="mic" label="Mikrofon" />
    </div>
  );
}
