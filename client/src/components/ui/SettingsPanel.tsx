import { ReactNode } from 'react';
import { XLg, Sliders, BellFill, PersonCircle } from 'react-bootstrap-icons';

// Settings — Tahap 2: just the frame (three empty sections). Tampilan gets
// the tooltip toggle in Tahap 3, Notifikasi absorbs NotificationSettings.tsx's
// two existing toggles + per-kind ones in Tahap 4 (that bell icon stays put
// until then — removing it before its replacement exists would be a real
// regression), Akun gets the Logout button in Tahap 5. Mounted identically
// from both Sidebar.tsx (in-room) and Lobby.tsx (room list) — same overlay
// pattern BookingForm.tsx already uses (backdrop click / X to close).
interface SettingsPanelProps {
  onClose: () => void;
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  return (
    // Fixed, not absolute — this mounts from both App.tsx's Game view (a
    // non-scrolling full-screen canvas, where `absolute` would have been
    // fine) AND Lobby.tsx's room list (a normally-scrolling page, where an
    // `absolute` overlay would scroll away with the page instead of staying
    // put over the viewport). `fixed` is correct in both contexts, so this
    // needs no `relative` ancestor from whichever page mounts it.
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="w-full max-w-md max-h-[85vh] overflow-y-auto bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-purple-100 dark:border-gray-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-purple-100 dark:border-gray-700 sticky top-0 bg-white dark:bg-gray-800 rounded-t-2xl">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Settings</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-700 cursor-pointer"
          >
            <XLg size={14} />
          </button>
        </div>

        <div className="p-5 space-y-6">
          <SettingsSection icon={<Sliders size={14} />} title="Tampilan">
            <p className="text-xs text-gray-400 dark:text-gray-500">Belum ada pengaturan di sini.</p>
          </SettingsSection>

          <SettingsSection icon={<BellFill size={14} />} title="Notifikasi">
            <p className="text-xs text-gray-400 dark:text-gray-500">Belum ada pengaturan di sini.</p>
          </SettingsSection>

          <SettingsSection icon={<PersonCircle size={14} />} title="Akun">
            <p className="text-xs text-gray-400 dark:text-gray-500">Belum ada pengaturan di sini.</p>
          </SettingsSection>
        </div>
      </div>
    </div>
  );
}

function SettingsSection({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100 mb-2.5">
        <span className="text-purple-600 dark:text-purple-400">{icon}</span>
        {title}
      </h3>
      <div className="pl-6">{children}</div>
    </div>
  );
}
