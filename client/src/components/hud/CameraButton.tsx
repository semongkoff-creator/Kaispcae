import { useEffect, useCallback } from 'react';
import { CameraVideoFill, CameraVideoOffFill } from 'react-bootstrap-icons';

interface CameraButtonProps {
  enabled: boolean;
  onToggle: () => void;
}

export function CameraButton({ enabled, onToggle }: CameraButtonProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
      className="flex items-center justify-center w-12 h-12 rounded-full bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-purple-200 dark:border-gray-600 shadow-lg transition-all hover:scale-105 cursor-pointer"
      title="Toggle Camera (V)"
    >
      {enabled ? <CameraVideoFill className="text-purple-700" size={20} /> : <CameraVideoOffFill className="text-red-500" size={20} />}
    </button>
  );
}
