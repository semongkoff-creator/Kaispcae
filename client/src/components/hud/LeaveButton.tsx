import { useState } from 'react';
import { TelephoneXFill } from 'react-bootstrap-icons';

interface LeaveButtonProps {
  onLeave: () => void;
}

// Meeting toolbars conventionally end in a red "leave" button. This app has
// no discrete hang-up (no single call to disconnect from) — the closest real
// equivalent is leaving this room back to the room list, so onLeave here is
// the exact same handler Sidebar's "Back to room list" already calls.
// Solid red at rest (not just on hover) — marked as destructive per spec,
// separated from the rest of the bar by a divider (see App.tsx).
export function LeaveButton({ onLeave }: LeaveButtonProps) {
  const [showLabel, setShowLabel] = useState(false);

  return (
    <button
      onClick={onLeave}
      onMouseEnter={() => setShowLabel(true)}
      onMouseLeave={() => setShowLabel(false)}
      className="relative flex items-center justify-center w-11 h-11 rounded-full bg-red-500 hover:bg-red-600 backdrop-blur-xl border border-red-400 shadow-lg shadow-red-500/30 transition-all hover:scale-105 cursor-pointer"
      title="Keluar room"
    >
      <TelephoneXFill className="text-white" size={18} />
      {showLabel && (
        <span className="absolute -top-8 whitespace-nowrap text-xs bg-white dark:bg-gray-800 text-red-600 dark:text-red-400 border border-red-100 dark:border-gray-700 shadow-sm px-2 py-0.5 rounded">
          Keluar room
        </span>
      )}
    </button>
  );
}
