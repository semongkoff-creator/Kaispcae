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
              className="absolute w-9 h-9 rounded-full bg-white/90 border border-purple-200 shadow-sm flex items-center justify-center text-lg hover:bg-purple-50 hover:scale-110 transition-all cursor-pointer"
              style={{ left: bx, top: by }}
              title={EMOTE_LABELS[emote]}
            >
              {EMOTE_EMOJI[emote]}
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
