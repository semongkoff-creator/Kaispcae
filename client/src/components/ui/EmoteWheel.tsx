import { useCallback, useEffect } from 'react';
import { EMOTE_LIST, EMOTE_EMOJI, EMOTE_LABELS, EmoteType } from '@virtualmeet/shared';

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
          return (
            <button
              key={emote}
              onClick={() => onSelect(emote)}
              className="absolute w-9 h-9 rounded-full bg-gray-800/90 border border-white/10 flex items-center justify-center text-lg hover:bg-gray-700 hover:scale-110 transition-all cursor-pointer"
              style={{ left: bx, top: by }}
              title={EMOTE_LABELS[emote]}
            >
              {EMOTE_EMOJI[emote]}
            </button>
          );
        })}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white/30 text-xs">
          Press Z
        </div>
      </div>
    </div>
  );
}
