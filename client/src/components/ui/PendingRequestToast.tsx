import { ReactNode } from 'react';

interface PendingRequestToastProps {
  icon: ReactNode;
  message: ReactNode;
  onAccept: () => void;
  onDecline: () => void;
}

// Shared Accept/Decline card for Summon, Follow and Knock — all three require
// the target's consent before anything happens (see roomHandler.ts's
// SUMMON_REQUEST/SUMMON_RESPOND, followHandler.ts's FOLLOW_INCOMING/
// FOLLOW_RESPOND), and there was no existing "someone is asking you
// something" pattern in this app to reuse. See App.tsx where this is
// rendered for how it auto-clears.
//
// Laid out as two rows, not one. The original packed icon, message and both
// buttons into a single flex row, which meant a long display name stretched
// the card far across the screen and pushed the buttons off to one side. A
// fixed width with the question on top and the actions beneath keeps the card
// the same size whoever is asking.
export function PendingRequestToast({ icon, message, onAccept, onDecline }: PendingRequestToastProps) {
  return (
    // Already rendered top-center by its App.tsx wrapper
    // (`top-16 left-1/2 -translate-x-1/2`) — the "toast dari atas-tengah"
    // spec was already true positionally; this is just the glass upgrade.
    <div className="w-72 bg-white/95 dark:bg-gray-900/95 backdrop-blur-xl border border-purple-200/60 dark:border-white/10 shadow-lg shadow-purple-500/10 rounded-xl px-3.5 py-3 pointer-events-auto animate-fade-in">
      <div className="flex items-start gap-2.5">
        <span className="shrink-0 mt-0.5">{icon}</span>
        <p className="text-xs leading-relaxed text-gray-700 dark:text-gray-300">{message}</p>
      </div>
      {/* Decline sits left and stays visually quiet; Accept is the purple the
          rest of the app uses for a primary action. Both are full-height
          targets with real space between them — at the previous 24px tall and
          8px apart, two irreversible and opposite actions were a mis-tap
          away from each other. */}
      <div className="flex items-center justify-end gap-2.5 mt-3">
        <button
          onClick={onDecline}
          className="px-3.5 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 text-xs font-medium cursor-pointer transition-colors"
        >
          Tolak
        </button>
        <button
          onClick={onAccept}
          className="px-3.5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium cursor-pointer transition-colors"
        >
          Terima
        </button>
      </div>
    </div>
  );
}
