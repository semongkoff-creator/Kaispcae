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
          // Flat/borderless toolbar restyle — no per-button background pill
          // any more (that's now the shared outer bar's job, see App.tsx),
          // just a plain glyph plus a subtle hover tint like every other
          // flat button in this bar. The three-state COLOR distinction this
          // already had is kept exactly (muted=red, speaking=green) — only
          // the *resting* (unmuted, not speaking) color changed, from the
          // old glass-pill gray to the same plain dark gray/black every
          // other flat icon in the bar uses.
          className="relative flex items-center justify-center w-8 h-8 rounded-lg transition-all hover:scale-105 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
        >
          {/* Switched back from the real mic.svg/mic_on.svg raster assets to
              react-bootstrap-icons glyphs — a clearer, higher-res reference
              screenshot showed thin OUTLINE icons throughout this bar, not
              the assets' bolder solid-filled style. Outline (Mic) for the
              neutral resting state, filled (MicFill/MicMuteFill) for the
              two states actually worth calling attention to — same
              "outline = neutral, filled = notable" split the asset pair
              itself used, just with react-icons glyphs instead. Colors kept
              exactly as the asset pack's own hex values (#6E6D72/#54D678),
              not react-icons' default palette. */}
          {muted ? (
            <MicMuteFill size={14} className="text-red-500" />
          ) : speaking ? (
            <MicFill size={14} className="text-[#54D678]" />
          ) : (
            <Mic size={14} className="text-[#6E6D72]" />
          )}
        </button>
      </Tooltip>
      <DeviceCaret kind="mic" label="Mikrofon" />
    </div>
  );
}
