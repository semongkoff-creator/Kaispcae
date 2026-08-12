import { DisplayFill, WindowDesktop } from 'react-bootstrap-icons';
import { Tooltip } from '@/components/ui/Tooltip';

interface ScreenShareButtonProps {
  sharing: boolean;
  onToggle: () => void;
}

// No keyboard shortcut here on purpose — every free letter key doubles as a
// WASD movement key (S in particular collides directly with "move down"),
// so this button is click-only.
//
// §6 — most mobile browsers don't implement getDisplayMedia at all, so
// feature-detecting it (rather than user-agent sniffing, which the spec
// offers as an alternative) hides the button wherever it could never work,
// instead of showing it and failing only once tapped.
const SCREEN_SHARE_SUPPORTED = typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

export function ScreenShareButton({ sharing, onToggle }: ScreenShareButtonProps) {
  if (!SCREEN_SHARE_SUPPORTED) return null;

  return (
    <Tooltip
      label={`Bagikan Layar — ${sharing ? 'Aktif' : 'Mati'}`}
      detail="Bagikan layar atau jendela aplikasimu ke semua orang yang sedang di zone/meeting yang sama."
    >
      <button
        onClick={onToggle}
        className={`relative flex items-center justify-center w-10 h-10 rounded-full backdrop-blur-xl border shadow-lg transition-all hover:scale-105 cursor-pointer ${
          sharing ? 'bg-purple-600 border-purple-500 shadow-purple-500/30' : 'bg-white/90 dark:bg-gray-800/90 border-purple-200/60 dark:border-white/10 shadow-purple-500/10'
        }`}
      >
        {sharing ? <DisplayFill className="text-white" size={16} /> : <WindowDesktop className="text-purple-700 dark:text-purple-300" size={16} />}
        {sharing && (
          <div className="absolute inset-0 rounded-full border-2 border-purple-400 animate-pulse" />
        )}
      </button>
    </Tooltip>
  );
}
