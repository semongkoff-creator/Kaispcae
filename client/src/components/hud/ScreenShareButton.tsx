import { DisplayFill, WindowDesktop } from 'react-bootstrap-icons';

interface ScreenShareButtonProps {
  sharing: boolean;
  onToggle: () => void;
}

// No keyboard shortcut here on purpose — every free letter key doubles as a
// WASD movement key (S in particular collides directly with "move down"),
// so this button is click-only.
export function ScreenShareButton({ sharing, onToggle }: ScreenShareButtonProps) {
  return (
    <button
      onClick={onToggle}
      className={`relative flex items-center justify-center w-12 h-12 rounded-full backdrop-blur-sm border shadow-lg transition-all hover:scale-105 cursor-pointer ${
        sharing ? 'bg-purple-600 border-purple-500' : 'bg-white/90 border-purple-200'
      }`}
      title="Toggle Screen Share"
    >
      {sharing ? <DisplayFill className="text-white" size={20} /> : <WindowDesktop className="text-purple-700" size={20} />}
      {sharing && (
        <div className="absolute inset-0 rounded-full border-2 border-purple-400 animate-pulse" />
      )}
    </button>
  );
}
