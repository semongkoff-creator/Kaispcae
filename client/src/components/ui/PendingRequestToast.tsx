import { ReactNode } from 'react';

interface PendingRequestToastProps {
  icon: ReactNode;
  message: ReactNode;
  onAccept: () => void;
  onDecline: () => void;
}

// Shared Accept/Decline toast for Summon and Follow — both now require the
// target's consent before anything happens (see roomHandler.ts's
// SUMMON_REQUEST/SUMMON_RESPOND and followHandler.ts's FOLLOW_INCOMING/
// FOLLOW_RESPOND), and there was no existing "someone is asking you
// something" UI pattern anywhere in this app to reuse — see the doc comment
// in App.tsx where this is rendered for how it auto-clears.
export function PendingRequestToast({ icon, message, onAccept, onDecline }: PendingRequestToastProps) {
  return (
    <div className="bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm border border-purple-200 dark:border-gray-600 shadow-lg rounded-lg px-3 py-2 flex items-center gap-2 text-xs pointer-events-auto">
      {icon}
      <span className="text-gray-700 dark:text-gray-300">{message}</span>
      <button
        onClick={onAccept}
        className="px-2 py-1 rounded-md bg-purple-600 hover:bg-purple-700 text-white text-[11px] font-medium cursor-pointer"
      >
        Accept
      </button>
      <button
        onClick={onDecline}
        className="px-2 py-1 rounded-md bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 text-[11px] font-medium cursor-pointer"
      >
        Decline
      </button>
    </div>
  );
}
