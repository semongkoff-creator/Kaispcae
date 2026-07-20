import { useRef, useState } from 'react';
import { BellFill } from 'react-bootstrap-icons';
import { useServerBase } from '../serverStore';
import { useClickOutside } from '../components/useClickOutside';

// Notification bell — unread count + dropdown. Fed live over WS ('base:notif'
// → refreshNotifications in the store). Clicking a mention notification opens
// its record; "Tandai semua dibaca" clears the badge.
export function NotificationsBell({ onOpenRecord }: { onOpenRecord: (recordId: string) => void }) {
  const notifications = useServerBase((s) => s.notifications);
  const markNotifRead = useServerBase((s) => s.markNotifRead);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);
  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} aria-label={`Notifikasi${unread ? ` (${unread} belum dibaca)` : ''}`} className="relative p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-300 cursor-pointer">
        <BellFill size={15} />
        {unread > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="absolute z-50 top-full right-0 mt-1 w-72 max-h-80 overflow-y-auto bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-100 dark:border-gray-700">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-gray-700 sticky top-0 bg-white dark:bg-gray-800">
            <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">Notifikasi</span>
            {unread > 0 && <button onClick={() => markNotifRead()} className="text-[11px] text-purple-600 hover:text-purple-800 cursor-pointer">Tandai semua dibaca</button>}
          </div>
          {notifications.length === 0 ? (
            <p className="text-xs text-gray-400 px-3 py-4 text-center">Belum ada notifikasi.</p>
          ) : (
            notifications.map((n) => (
              <button
                key={n.id}
                onClick={() => { markNotifRead(n.id); if (n.recordId) onOpenRecord(n.recordId); setOpen(false); }}
                className={`w-full text-left px-3 py-2 border-b border-gray-50 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer ${n.read ? '' : 'bg-purple-50/40 dark:bg-purple-900/10'}`}
              >
                <p className="text-xs text-gray-700 dark:text-gray-200 break-words">{n.body}</p>
                <p className="text-[10px] text-gray-400 mt-0.5">{new Date(n.createdAt).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
