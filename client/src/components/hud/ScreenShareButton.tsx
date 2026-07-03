import { useEffect } from 'react';

interface ScreenShareButtonProps {
  sharing: boolean;
  onToggle: () => void;
}

export function ScreenShareButton({ sharing, onToggle }: ScreenShareButtonProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 's' || e.key === 'S') {
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
      className={`relative flex items-center justify-center w-12 h-12 rounded-full backdrop-blur-sm border shadow-lg transition-all hover:scale-105 cursor-pointer ${
        sharing ? 'bg-purple-600 border-purple-500' : 'bg-white/90 border-purple-200'
      }`}
      title="Toggle Screen Share (S)"
    >
      <span className="text-xl">{sharing ? '🟪' : '🖥️'}</span>
      {sharing && (
        <div className="absolute inset-0 rounded-full border-2 border-purple-400 animate-pulse" />
      )}
    </button>
  );
}
