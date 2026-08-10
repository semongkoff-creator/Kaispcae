import { useState } from 'react';
import { PeopleFill } from 'react-bootstrap-icons';

interface ParticipantsToggleButtonProps {
  open: boolean;
  onToggle: () => void;
}

// Toolbar entry point for ParticipantPanel — previously ParticipantPanel
// rendered its own top-left trigger button (with an online-count badge
// computed from its own local playerRecords read); this calls the exact
// same toggle (openPanel('participants'), see App.tsx) so open/close
// behaves identically, just from the meeting toolbar instead of a separate
// corner. The count itself is left inside ParticipantPanel's own header
// (still shown once the panel is open) rather than duplicated here from a
// second store read.
export function ParticipantsToggleButton({ open, onToggle }: ParticipantsToggleButtonProps) {
  const [showLabel, setShowLabel] = useState(false);

  return (
    <button
      onClick={onToggle}
      onMouseEnter={() => setShowLabel(true)}
      onMouseLeave={() => setShowLabel(false)}
      className={`relative flex items-center justify-center w-11 h-11 rounded-full backdrop-blur-xl border shadow-lg transition-all hover:scale-105 cursor-pointer ${
        open
          ? 'bg-purple-600 border-purple-500 shadow-purple-500/30'
          : 'bg-white/90 dark:bg-gray-800/90 border-purple-200/60 dark:border-white/10 shadow-purple-500/10'
      }`}
      title="Peserta"
    >
      <PeopleFill className={open ? 'text-white' : 'text-purple-700 dark:text-purple-300'} size={18} />
      {showLabel && (
        <span className="absolute -top-8 whitespace-nowrap text-xs bg-white dark:bg-gray-800 text-purple-700 dark:text-purple-300 border border-purple-100 dark:border-gray-700 shadow-sm px-2 py-0.5 rounded">
          Peserta
        </span>
      )}
    </button>
  );
}
