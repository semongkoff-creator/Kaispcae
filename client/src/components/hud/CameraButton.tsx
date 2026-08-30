import { useEffect } from 'react';
import { CameraVideo, CameraVideoOffFill } from 'react-bootstrap-icons';
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
          // Flat/borderless toolbar restyle (see MicButton's own comment).
          className="flex items-center justify-center w-8 h-8 rounded-lg transition-all hover:scale-105 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
        >
          {/* CameraVideo (outline) instead of the camera.svg asset — see
              MicButton's own comment on why this bar switched back to
              react-icons outline glyphs. Same silhouette family as the
              existing "off" icon (CameraVideoOffFill), just outline instead
              of filled, colored to the asset pack's own gray rather than
              react-icons' default. No outline "camera off" glyph swap
              needed — off is meant to stand out, so it keeps its filled red
              look unchanged. */}
          {enabled ? <CameraVideo size={14} className="text-[#6E6D72]" /> : <CameraVideoOffFill className="text-red-500" size={14} />}
        </button>
      </Tooltip>
      <DeviceCaret kind="camera" label="Kamera" />
    </div>
  );
}
