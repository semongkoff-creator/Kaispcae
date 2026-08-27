import { Icon } from '@iconify/react';
import { Tooltip } from '@/components/ui/Tooltip';

interface ParticipantsToggleButtonProps {
  open: boolean;
  onToggle: () => void;
}

// Toolbar entry point for ParticipantPanel — previously anchored in the
// bottom meeting-control bar (circular, w-10 h-10, its own separate look),
// now relocated to the top-left rail beside Soundboard/ActivityFeed (see
// App.tsx). Restyled to match that rail's own button convention exactly
// (w-8 h-8 rounded-lg, same open/closed color pair — see
// SoundboardPanel.tsx's identical button) now that this is its only home,
// rather than carrying the old bottom-bar circular style into a row where
// every other icon is a boxy square. Calls the exact same toggle
// (openPanel('participants'), see App.tsx) so open/close behavior is
// unchanged, only the look moved. The online-count badge stays inside
// ParticipantPanel's own header (shown once the panel is open) rather than
// duplicated here from a second store read.
export function ParticipantsToggleButton({ open, onToggle }: ParticipantsToggleButtonProps) {
  return (
    <Tooltip
      label="Peserta"
      detail="Lihat daftar orang yang sedang online di room ini, termasuk siapa saja yang sedang mengangkat tangan."
    >
      <button
        onClick={onToggle}
        className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
          open
            ? 'bg-login-accent text-white'
            : 'bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm text-login-accent dark:text-purple-300 hover:bg-login-surface dark:hover:bg-gray-800 border border-login-border-soft dark:border-gray-700 shadow-sm'
        }`}
      >
        <Icon icon="clarity:users-solid" width={14} height={14} />
      </button>
    </Tooltip>
  );
}
