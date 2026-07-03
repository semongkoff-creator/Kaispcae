import { useEffect, useCallback } from 'react';

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
      className="flex items-center justify-center w-12 h-12 rounded-full bg-white/90 backdrop-blur-sm border border-purple-200 shadow-lg transition-all hover:scale-105 cursor-pointer"
      title="Toggle Camera (V)"
    >
      <span className="text-xl">{enabled ? '📹' : '📷'}</span>
    </button>
  );
}
