import { useState } from 'react';
import { EyeSlashFill, EyeFill } from 'react-bootstrap-icons';

interface HiddenButtonProps {
  hidden: boolean;
  onToggle: () => void;
}

// "Hide myself" toggle — sits in the same bottom HUD row as Mic/Camera/Hand.
// While on, this player's avatar is skipped entirely by regular members'
// render loop (see GameCanvas.tsx and Minimap.tsx); admin+ can always still
// see it. No keyboard shortcut (deliberately — every obvious single-letter
// key in this HUD row is already claimed by another toggle).
export function HiddenButton({ hidden, onToggle }: HiddenButtonProps) {
  const [showLabel, setShowLabel] = useState(false);

  return (
    <button
      onClick={onToggle}
      onMouseEnter={() => setShowLabel(true)}
      onMouseLeave={() => setShowLabel(false)}
      className={`relative flex items-center justify-center w-9 h-9 rounded-full backdrop-blur-sm border shadow-lg transition-all hover:scale-105 cursor-pointer ${
        hidden
          ? 'bg-slate-700 border-slate-500'
          : 'bg-white/90 dark:bg-gray-800/90 border-purple-200 dark:border-gray-600'
      }`}
      title="Sembunyikan diri"
    >
      {hidden ? <EyeSlashFill className="text-white" size={15} /> : <EyeFill className="text-purple-700 dark:text-purple-300" size={15} />}
      {showLabel && (
        <span className="absolute -top-8 whitespace-nowrap text-xs bg-white dark:bg-gray-800 text-purple-700 dark:text-purple-300 border border-purple-100 dark:border-gray-700 shadow-sm px-2 py-0.5 rounded">
          {hidden ? 'Tampilkan diri' : 'Sembunyikan diri'}
        </span>
      )}
    </button>
  );
}
