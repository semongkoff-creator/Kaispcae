import { useState, useCallback, useEffect } from 'react';
import { MicFill, MicMuteFill } from 'react-bootstrap-icons';

interface MicButtonProps {
  muted: boolean;
  onToggle: () => void;
}

export function MicButton({ muted, onToggle }: MicButtonProps) {
  const [showLabel, setShowLabel] = useState(false);

  // M key shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'm' || e.key === 'M') {
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
      onMouseEnter={() => setShowLabel(true)}
      onMouseLeave={() => setShowLabel(false)}
      className="relative flex items-center justify-center w-12 h-12 rounded-full bg-white/90 backdrop-blur-sm border border-purple-200 shadow-lg transition-all hover:scale-105 cursor-pointer"
      title="Toggle Microphone (M)"
    >
      {muted ? <MicMuteFill className="text-red-500" size={20} /> : <MicFill className="text-purple-700" size={20} />}
      {muted && (
        <div className="absolute inset-0 rounded-full border-2 border-red-500 animate-pulse" />
      )}
      {showLabel && (
        <span className="absolute -top-8 whitespace-nowrap text-xs bg-white text-purple-700 border border-purple-100 shadow-sm px-2 py-0.5 rounded">
          Mic {muted ? 'OFF' : 'ON'} (M)
        </span>
      )}
    </button>
  );
}
