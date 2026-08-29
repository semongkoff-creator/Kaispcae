import { useEffect } from 'react';
import { CameraVideoOffFill } from 'react-bootstrap-icons';
import { isTypingTarget } from '@/utils/hotkeys';
import { Tooltip } from '@/components/ui/Tooltip';
import { DeviceCaret } from './DeviceCaret';

interface CameraButtonProps {
  enabled: boolean;
  onToggle: () => void;
}

export function CameraButton({ enabled, onToggle }: CameraButtonProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't fire while the user is typing — the Docs editor is
      // contenteditable, so this key would be swallowed mid-word.
      if (isTypingTarget(e.target)) return;
      if (e.key === 'v' || e.key === 'V') {
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
        label={`Kamera (V) — ${enabled ? 'Aktif' : 'Mati'}`}
        detail="Nyalakan/matikan kameramu. Video hanya terlihat oleh orang yang sedang satu zone/meeting denganmu."
      >
        <button
          onClick={onToggle}
          // Flat/borderless toolbar restyle (see MicButton's own comment) —
          // no per-button background pill any more. camera.svg is already
          // the same dark gray (#6E6D72) every other flat icon in this bar
          // uses, so "on" needs no extra styling; "off" keeps its existing
          // red icon (no background color to lose here — it was never
          // colored by state, only "on" had the purple pill).
          className="flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:scale-105 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
        >
          {/* No "camera off" variant exists in the real asset set — kept the
              existing red react-bootstrap-icons glyph for that state. */}
          {enabled ? <img src="/assets/img/icons/camera.svg" width={15} height={15} alt="" /> : <CameraVideoOffFill className="text-red-500" size={15} />}
        </button>
      </Tooltip>
      <DeviceCaret kind="camera" label="Kamera" />
    </div>
  );
}
