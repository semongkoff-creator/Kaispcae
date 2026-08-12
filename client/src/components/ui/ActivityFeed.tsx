import { useState } from 'react';
import { ClockHistory, ChevronUp, ChevronDown } from 'react-bootstrap-icons';
import { useGameStore } from '@/stores/gameStore';
import { Tooltip } from '@/components/ui/Tooltip';

// Client-only log (see gameStore.ts's activityEvents doc comment) of what's
// happened recently in this room — who joined/left, media added, notices
// pinned, recordings started/ended. Not a durable audit trail: it starts
// empty on every join and only covers this session, same honesty-about-scope
// as chat having no server-side history either.
export function ActivityFeed() {
  const [open, setOpen] = useState(false);
  const activityEvents = useGameStore((s) => s.activityEvents);

  return (
    <div className="relative z-40 pointer-events-auto">
      <Tooltip label="Aktivitas Terbaru" detail="Lihat aktivitas terbaru tim kamu. (Khusus manajer.)">
        <button
          onClick={() => setOpen(!open)}
          className="bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm px-3 py-2 rounded-lg text-xs text-purple-700 dark:text-purple-300 hover:text-purple-800 border border-purple-200 dark:border-gray-600 shadow-sm cursor-pointer inline-flex items-center gap-1.5"
        >
          <ClockHistory size={13} /> {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        </button>
      </Tooltip>

      {open && (
        <div
          className="absolute top-full left-0 mt-2 w-64 max-h-[60vh] bg-white/95 dark:bg-gray-900/95 backdrop-blur-md rounded-xl border border-purple-100 dark:border-gray-700 shadow-2xl flex flex-col pointer-events-auto"
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
