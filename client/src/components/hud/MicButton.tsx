import { useEffect } from 'react';
import { MicMuteFill } from 'react-bootstrap-icons';
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
          // Flat/borderless toolbar restyle — no per-button background pill
          // any more (that's now the shared outer bar's job, see App.tsx),
          // just a plain glyph plus a subtle hover tint like every other
          // flat button in this bar. The three-state COLOR distinction this
          // already had is kept exactly (muted=red, speaking=green) — only
          // the *resting* (unmuted, not speaking) color changed, from the
          // old glass-pill gray to the same plain dark gray/black every
          // other flat icon in the bar uses.
          className="relative flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:scale-105 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
        >
          {muted ? (
            // No dedicated "muted" asset exists in the real icon pack (only
            // mic.svg/mic_on.svg, gray/green — see the other two branches),
            // so this one stays a react-bootstrap-icons glyph in red — the
            // same MicMuteFill every other muted-mic indicator in this app
            // already uses (MiniMode/MemberListPanel/VideoGrid/
            // ParticipantActionsMenu).
            <MicMuteFill size={15} className="text-red-500" />
          ) : speaking ? (
            // mic_on.svg is already the exact green (#54D678) this app's own
            // asset pack uses for "on/active" — using the real file instead
            // of a react-icons approximation.
            <img src="/assets/img/icons/mic_on.svg" width={15} height={15} alt="" />
          ) : (
            // mic.svg is already the same dark gray (#6E6D72) every other
            // resting icon in this bar uses.
            <img src="/assets/img/icons/mic.svg" width={15} height={15} alt="" />
          )}
        </button>
      </Tooltip>
      <DeviceCaret kind="mic" label="Mikrofon" />
    </div>
  );
}
