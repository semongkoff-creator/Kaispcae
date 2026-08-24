import { ReactNode, useEffect } from 'react';
import { useGameStore } from '@/stores/gameStore';

const AUTO_DISMISS_MS = 5000;

interface SpotlightNoticeProps {
  icon: ReactNode;
  message: ReactNode;
}

// Passive "someone just got spotlighted" notice — same glass-card visual
// language as PendingRequestToast (this app's established "something
// happened, look here" style), but with nothing to decide, so no
// Accept/Decline. Self-dismisses after AUTO_DISMISS_MS via its own timer;
// also unmounts early whenever useSocket.ts's SPOTLIGHT_CHANGED handler
// clears spotlightNotice (target's spotlight turned back off, or a newer
// one replaced it) — App.tsx keys this by target id, so a fresh spotlight
// remounts it and restarts the timer.
export function SpotlightNotice({ icon, message }: SpotlightNoticeProps) {
  useEffect(() => {
    const t = setTimeout(() => useGameStore.getState().setSpotlightNotice(null), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="w-72 bg-white/95 dark:bg-gray-900/95 backdrop-blur-xl border border-purple-200/60 dark:border-white/10 shadow-lg shadow-purple-500/10 rounded-xl px-3.5 py-3 pointer-events-none animate-fade-in flex items-start gap-2.5">
      <span className="shrink-0 mt-0.5">{icon}</span>
      <p className="text-xs leading-relaxed text-gray-700 dark:text-gray-300">{message}</p>
    </div>
  );
}
