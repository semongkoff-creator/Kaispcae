import { useEffect } from 'react';
import { CameraVideoOffFill } from 'react-bootstrap-icons';
import { Icon } from '@iconify/react';
import { isTypingTarget } from '@/utils/hotkeys';
import { Tooltip } from '@/components/ui/Tooltip';

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
    <Tooltip
      label={`Kamera (V) — ${enabled ? 'Aktif' : 'Mati'}`}
      detail="Nyalakan/matikan kameramu. Video hanya terlihat oleh orang yang sedang satu zone/meeting denganmu."
    >
      <button
        onClick={onToggle}
        // Same active-state convention as MicButton: camera on = solid purple
        // (the capability is actively broadcasting), off = glass + red icon.
        className={`flex items-center justify-center w-10 h-10 rounded-full backdrop-blur-xl border shadow-lg transition-all hover:scale-105 cursor-pointer ${
          enabled
            ? 'bg-login-accent border-login-accent shadow-purple-500/30'
            : 'bg-white/90 dark:bg-gray-800/90 border-login-border-soft dark:border-white/10 shadow-purple-500/10'
        }`}
      >
        {enabled ? <Icon icon="akar-icons:video-camera" width={16} height={16} className="text-white" /> : <CameraVideoOffFill className="text-red-500" size={16} />}
      </button>
    </Tooltip>
  );
}
