import { useEffect, useCallback } from 'react';
import { CameraVideoFill, CameraVideoOffFill } from 'react-bootstrap-icons';
import { isTypingTarget } from '@/utils/hotkeys';

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
    <button
      onClick={onToggle}
      // Same active-state convention as MicButton: camera on = solid purple
      // (the capability is actively broadcasting), off = glass + red icon.
      className={`flex items-center justify-center w-11 h-11 rounded-full backdrop-blur-xl border shadow-lg transition-all hover:scale-105 cursor-pointer ${
        enabled
          ? 'bg-purple-600 border-purple-500 shadow-purple-500/30'
          : 'bg-white/90 dark:bg-gray-800/90 border-purple-200/60 dark:border-white/10 shadow-purple-500/10'
      }`}
      title="Toggle Camera (V)"
    >
      {enabled ? <CameraVideoFill className="text-white" size={18} /> : <CameraVideoOffFill className="text-red-500" size={18} />}
    </button>
  );
}
