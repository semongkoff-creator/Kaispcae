import { TelephoneXFill } from 'react-bootstrap-icons';
import { Tooltip } from '@/components/ui/Tooltip';

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
  return (
    <Tooltip
      label="Keluar Room"
      detail="Kembali ke daftar Space. Ini tidak menutup akunmu — kamu tetap login."
    >
      <button
        onClick={onLeave}
        className="relative flex items-center justify-center w-10 h-10 rounded-full bg-red-500 hover:bg-red-600 backdrop-blur-xl border border-red-400 shadow-lg shadow-red-500/30 transition-all hover:scale-105 cursor-pointer"
      >
        <TelephoneXFill className="text-white" size={16} />
      </button>
    </Tooltip>
  );
}
