import { useGameStore } from '@/stores/gameStore';
import { Tooltip } from '@/components/ui/Tooltip';

interface ActivityFeedProps {
  open: boolean;
  onToggle: () => void;
}

// Client-only log (see gameStore.ts's activityEvents doc comment) of what's
// happened recently in this room — who joined/left, media added, notices
// pinned, recordings started/ended. Not a durable audit trail: it starts
// empty on every join and only covers this session, same honesty-about-scope
// as chat having no server-side history either.
//
// Fix panel numpuk, round 2 — open/onToggle now come from the parent
// (App.tsx, backed by activePanel==='activityFeed'). No close button needed
// here: reopening the trigger (the same activePanel toggle-off-if-already-
// active openPanel gives every other panel) is this component's only way in
// or out, matching how it behaved before.
//
// Moved from a standalone clock-icon button in the top-left toolbar to the
// notification bell in the top-right toolbar (App.tsx) — the bell used to
// only duplicate the gear icon's Settings > Notifikasi shortcut, so this
// panel's trigger now IS the bell, same open/close state and list markup as
// before. Anchored top-right (`right-0`) instead of top-left (`left-0`) so
// the popover opens toward the middle of the screen instead of off the
// right edge.
export function ActivityFeed({ open, onToggle }: ActivityFeedProps) {
  const activityEvents = useGameStore((s) => s.activityEvents);

  return (
    <div className="relative z-40 pointer-events-auto">
      <Tooltip label="Aktivitas Terbaru" detail="Lihat aktivitas terbaru tim kamu. (Khusus manajer.)" side="bottom" align="end">
        <button
          onClick={onToggle}
          className="w-9 h-9 rounded-lg bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-login-border-soft dark:border-gray-700 shadow-sm flex items-center justify-center cursor-pointer"
        >
          <img src="/assets/img/icons/notif.svg" width={16} height={16} alt="" />
        </button>
      </Tooltip>

      {open && (
        <div
          className="absolute top-full right-0 mt-2 w-64 max-h-[60vh] bg-white/95 dark:bg-gray-900/95 backdrop-blur-md rounded-xl border border-purple-100 dark:border-gray-700 shadow-2xl flex flex-col pointer-events-auto"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="p-3 border-b border-purple-100 dark:border-gray-700">
            <span className="text-gray-900 dark:text-gray-100 text-sm font-medium">Recent Activity</span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {activityEvents.length === 0 ? (
              <p className="text-gray-400 dark:text-gray-500 text-xs px-2 py-3 text-center">Nothing's happened yet this session.</p>
            ) : (
              activityEvents.map((event) => (
                <div key={event.id} className="px-2 py-1.5 rounded bg-purple-50/50 dark:bg-gray-700/50">
                  <p className="text-gray-700 dark:text-gray-300 text-xs">{event.message}</p>
                  <p className="text-gray-400 dark:text-gray-500 text-[10px]">{formatRelativeTime(event.timestamp)}</p>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
