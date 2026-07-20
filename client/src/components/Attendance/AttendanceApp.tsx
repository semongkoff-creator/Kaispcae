import { useEffect, useState } from 'react';
import { XLg, ClockHistory, CalendarCheck, InboxFill } from 'react-bootstrap-icons';
import { ClockWidget } from './ClockWidget';
import { MyAttendance } from './MyAttendance';
import { LeavePanel, ApprovalsPanel } from './LeavePanel';
import { attendanceApi } from './api';

type Tab = 'me' | 'leave' | 'approvals';

export function AttendanceApp({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('me');
  const [refreshKey, setRefreshKey] = useState(0);
  const [isApprover, setIsApprover] = useState(false);

  // The approvals tab is shown only to someone who actually has something to
  // approve — the server 403s the endpoint for everyone else, so this probe
  // decides visibility rather than a guessed role.
  useEffect(() => {
    attendanceApi.pendingLeaves()
      .then(() => setIsApprover(true))
      .catch(() => attendanceApi.pendingCorrections().then(() => setIsApprover(true)).catch(() => setIsApprover(false)));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'me', label: 'Absensi saya', icon: <ClockHistory size={13} /> },
    { id: 'leave', label: 'Cuti', icon: <CalendarCheck size={13} /> },
    ...(isApprover ? [{ id: 'approvals' as Tab, label: 'Persetujuan', icon: <InboxFill size={13} /> }] : []),
  ];

  return (
    // pl-14 clears the room's Sidebar rail — same as the other modules.
    <div className="absolute inset-0 z-40 flex flex-col bg-white dark:bg-gray-900 overflow-hidden pl-14">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-700 shrink-0">
        <button onClick={onClose} aria-label="Kembali" className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 cursor-pointer"><XLg size={14} /></button>
        <h1 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Absensi</h1>
      </header>

      <nav className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-100 dark:border-gray-700 shrink-0">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer ${
              tab === t.id ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}>
            {t.icon} {t.label}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'me' && (
          <div className="grid gap-4 lg:grid-cols-[320px_1fr] max-w-5xl">
            <ClockWidget onChanged={() => setRefreshKey((k) => k + 1)} />
            <MyAttendance refreshKey={refreshKey} />
          </div>
        )}
        {tab === 'leave' && <div className="max-w-3xl"><LeavePanel onChanged={() => setRefreshKey((k) => k + 1)} /></div>}
        {tab === 'approvals' && <div className="max-w-3xl"><ApprovalsPanel onChanged={() => setRefreshKey((k) => k + 1)} /></div>}
      </div>
    </div>
  );
}
