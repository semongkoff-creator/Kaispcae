import { useCallback, useEffect } from 'react';
import {
  HandIndexThumbFill,
  HandThumbsUpFill,
  EmojiLaughingFill,
  HeartFill,
  BalloonFill,
  EmojiNeutralFill,
  MoonStarsFill,
  Fire,
} from 'react-bootstrap-icons';
import { EMOTE_LIST, EMOTE_LABELS, EmoteType } from '@virtualmeet/shared';

// Bootstrap Icon for each emote's picker button. The floating bubble that
// appears above the avatar in the game world is drawn on the <canvas> 2D
// context (see GameCanvas.tsx), which can only render text/glyphs — not SVG
// React components — so that bubble keeps using EMOTE_EMOJI (shared/types)
// unchanged; this map only covers this picker's on-screen DOM buttons.
const EMOTE_ICONS: Record<EmoteType, typeof HeartFill> = {
  wave: HandIndexThumbFill,
  clap: HandThumbsUpFill,
  laugh: EmojiLaughingFill,
  heart: HeartFill,
  party: BalloonFill,
  think: EmojiNeutralFill,
  sleep: MoonStarsFill,
  fire: Fire,
};

interface EmoteWheelProps {
  open: boolean;
  onSelect: (emote: EmoteType) => void;
  onClose: () => void;
}

export function EmoteWheel({ open, onSelect, onClose }: EmoteWheelProps) {
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'z' || e.key === 'Z') {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    if (open) {
      window.addEventListener('keydown', handleKey);
      return () => window.removeEventListener('keydown', handleKey);
    }
  }, [open, handleKey]);

  if (!open) return null;

  const cx = 50;
  const cy = 50;
  const r = 36;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center" onClick={onClose}>
      <div className="relative w-[220px] h-[220px]" onClick={(e) => e.stopPropagation()}>
        {EMOTE_LIST.map((emote, i) => {
          const angle = (i / EMOTE_LIST.length) * Math.PI * 2 - Math.PI / 2;
          const bx = cx + r * Math.cos(angle) - 18;
          const by = cy + r * Math.sin(angle) - 18;
          const EmoteIcon = EMOTE_ICONS[emote];
          return (
            <button
              key={emote}
              onClick={() => onSelect(emote)}
              className="absolute w-9 h-9 rounded-full bg-white/90 border border-purple-200 shadow-sm flex items-center justify-center text-purple-600 hover:bg-purple-50 hover:scale-110 transition-all cursor-pointer"
              style={{ left: bx, top: by }}
              title={EMOTE_LABELS[emote]}
            >
              <EmoteIcon size={18} />
            </button>
          );
        })}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white/80 text-purple-700 text-xs px-2 py-1 rounded-full shadow-sm">
          Press Z
        </div>
      </div>
    </div>
  );
}
