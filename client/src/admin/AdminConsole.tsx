import { useEffect, useState } from 'react';
import { XLg, People, ShieldLock, ClockHistory, Sliders, BarChartFill, GraphUp, CalendarEvent, PersonCheck, CloudDownload } from 'react-bootstrap-icons';
import { WORKSPACE_ROLE_LABELS } from '@virtualmeet/shared';
import { CurrentUser } from '@/hooks/useCurrentUser';
import { ApprovalPanel } from './ApprovalPanel';
import { MembersPanel } from './MembersPanel';
import { PolicyPanel } from './PolicyPanel';
import { AuditLogViewer } from './AuditLogViewer';
import { AttendanceReport } from './AttendanceReport';
import { CalendarSettings } from './CalendarSettings';
import { BackupPanel } from './BackupPanel';
import { AnalyticsTiersPanel } from './AnalyticsTiersPanel';
import { DepartmentsPanel } from './DepartmentsPanel';
import { AttendanceSettings } from './AttendanceSettings';

// Departemen/Absensi were hidden here while an external workspace suite owned
// the org chart and the attendance clock. It doesn't any more, and these are
// now the ONLY places to define a shift, assign one, or add a leave type —
// without them attendance is switched on but unusable, since clock-in refuses
// with "Kamu belum punya shift" and nothing can create one. The components
// were never deleted, so this is just remounting them.
type Tab = 'members' | 'departments' | 'attendance' | 'approvals' | 'report' | 'analytics' | 'calendar' | 'policy' | 'audit' | 'backup';

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'members', label: 'Anggota', icon: <People size={14} /> },
  { id: 'departments', label: 'Departemen', icon: <People size={14} /> },
  { id: 'attendance', label: 'Absensi', icon: <ClockHistory size={14} /> },
  { id: 'approvals', label: 'Persetujuan', icon: <PersonCheck size={14} /> },
  { id: 'report', label: 'Laporan', icon: <BarChartFill size={14} /> },
  // Productivity Analytics — Team/All-Kaitech tiers (Bagian B.1). Separate
  // from "Laporan" (attendance-only) above; see AnalyticsTiersPanel.tsx's
  // own doc comment for why the Individual tier here is self-view only.
  { id: 'analytics', label: 'Analitik', icon: <GraphUp size={14} /> },
  { id: 'calendar', label: 'Ruang & Kalender', icon: <CalendarEvent size={14} /> },
  { id: 'policy', label: 'Kebijakan', icon: <Sliders size={14} /> },
  { id: 'audit', label: 'Audit log', icon: <ClockHistory size={14} /> },
  { id: 'backup', label: 'Backup', icon: <CloudDownload size={14} /> },
];

// The workspace admin console. Rendering is gated here AND every route it
// calls is gated server-side — a member who forces their way to this
// component still gets 403 from every request it makes (finish criterion #19).
export function AdminConsole({ currentUser, onClose }: { currentUser: CurrentUser; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('members');
  const isAdmin = currentUser.workspaceRole === 'admin';

  // Escape closes, matching the other full-screen panels in this app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!isAdmin) {
    return (
      <div className="absolute inset-0 z-40 flex items-center justify-center bg-white dark:bg-gray-900 pl-14">
        <div className="text-center max-w-sm px-6">
          <ShieldLock size={32} className="mx-auto text-gray-300 dark:text-gray-600 mb-3" />
          <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">Halaman ini khusus admin workspace</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Peran kamu saat ini: {WORKSPACE_ROLE_LABELS[currentUser.workspaceRole]}. Minta admin kalau kamu butuh akses.
          </p>
          <button onClick={onClose} className="mt-4 px-3 py-1.5 rounded-lg bg-purple-600 text-white text-xs font-medium cursor-pointer hover:bg-purple-700">
            Kembali
          </button>
        </div>
      </div>
    );
  }

  return (
    // pl-14 clears the room's Sidebar rail (w-14, z-50).
    <div className="absolute inset-0 z-40 flex flex-col bg-white dark:bg-gray-900 overflow-hidden pl-14">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-700 shrink-0">
        <button onClick={onClose} aria-label="Tutup konsol admin" className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 cursor-pointer">
          <XLg size={14} />
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <ShieldLock size={15} className="text-purple-600 shrink-0" />
          <h1 className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">Konsol Admin</h1>
        </div>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 font-medium">
          Workspace
        </span>
      </header>

      <nav className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-100 dark:border-gray-700 shrink-0 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer whitespace-nowrap transition-colors ${
              tab === t.id
                ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300'
                : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'members' && <MembersPanel currentUser={currentUser} />}
        {tab === 'departments' && <DepartmentsPanel />}
        {tab === 'attendance' && <AttendanceSettings />}
        {tab === 'approvals' && <ApprovalPanel />}
        {tab === 'report' && <AttendanceReport />}
        {tab === 'analytics' && <AnalyticsTiersPanel />}
        {tab === 'calendar' && <CalendarSettings />}
        {tab === 'policy' && <PolicyPanel />}
        {tab === 'audit' && <AuditLogViewer />}
        {tab === 'backup' && <BackupPanel />}
      </div>
    </div>
  );
}
