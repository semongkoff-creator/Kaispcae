import { useEffect } from 'react';
import { XLg, BarChartFill } from 'react-bootstrap-icons';
import { AnalyticsPanel } from './AnalyticsPanel';

// Productivity Analytics — Bagian B.1's Individual tier, self-view only
// (no userId prop passed to AnalyticsPanel). Open to every real employee,
// unlike AdminConsole which re-gates on workspaceRole — see PanelId's doc
// comment in gameStore.ts. Same full-screen chrome shape as AdminConsole's
// own header, minus the tab nav (nothing else to switch to here — Team/
// All-Kaitech tiers live inside AdminConsole instead).
export function MyAnalyticsPanel({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    // pl-14 clears the room's Sidebar rail (w-14, z-50), same as AdminConsole.
    <div className="absolute inset-0 z-40 flex flex-col bg-white dark:bg-gray-900 overflow-hidden pl-14">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-700 shrink-0">
        <button onClick={onClose} aria-label="Tutup Analitik Saya" className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 cursor-pointer">
          <XLg size={14} />
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <BarChartFill size={15} className="text-purple-600 shrink-0" />
          <h1 className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">Analitik Saya</h1>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        <AnalyticsPanel />
      </div>
    </div>
  );
}
