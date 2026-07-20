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
      className="flex items-center justify-center w-9 h-9 rounded-full bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-purple-200 dark:border-gray-600 shadow-lg transition-all hover:scale-105 cursor-pointer"
      title="Toggle Camera (V)"
    >
      {enabled ? <CameraVideoFill className="text-purple-700 dark:text-purple-300" size={15} /> : <CameraVideoOffFill className="text-red-500" size={15} />}
    </button>
  );
}
