import { useState } from 'react';
import { BellFill, BellSlashFill } from 'react-bootstrap-icons';
import {
  getNotificationSettings,
  saveNotificationSettings,
  enableBrowserNotification,
  disableBrowserNotification,
  isNotificationSupported,
} from '@/services/browserNotifications';

// §10 — Browser Notification settings. Kept as a small popover (same
// pattern as ParticipantPanel's toggle button) rather than a full settings
// page, since there are only two controls.
export function NotificationSettings() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(getNotificationSettings);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    isNotificationSupported() ? Notification.permission : 'unsupported',
  );
  const [needsManualEnable, setNeedsManualEnable] = useState(permission === 'denied');

  const handleEnable = async () => {
    const result = await enableBrowserNotification();
    setPermission(isNotificationSupported() ? Notification.permission : 'unsupported');
    setNeedsManualEnable(result.needsManualEnable);
    setSettings(getNotificationSettings());
  };

  const handleDisable = () => {
    disableBrowserNotification();
    setSettings(getNotificationSettings());
  };

  // §10's explicit rule: Sound stays disabled in the UI whenever
  // notifications themselves are off — a dependency check in state, not
  // just a visual toggle that'd silently do nothing.
  const handleSoundToggle = () => {
    const next = { ...settings, soundOn: !settings.soundOn };
    saveNotificationSettings(next);
    setSettings(next);
  };

  if (permission === 'unsupported') return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        // w-8 h-8 rounded-lg (was rounded-full) — now lives in Sidebar.tsx's
        // rail among square SidebarIcon rows, matches their shape.
        className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/90 dark:bg-gray-800/90 backdrop-blur-xl border border-purple-200/60 dark:border-white/10 shadow-lg shadow-purple-500/10 transition-all hover:scale-105 cursor-pointer"
        title="Notification settings"
      >
        {settings.browserNotifOn ? <BellFill className="text-purple-700 dark:text-purple-300" size={14} /> : <BellSlashFill className="text-gray-400 dark:text-gray-500" size={14} />}
      </button>

      {open && (
        <div
          className="absolute bottom-full mb-2 right-0 w-64 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-purple-100 dark:border-gray-700 p-3 z-50"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <h3 className="text-gray-900 dark:text-gray-100 text-sm font-bold mb-2">Notifications</h3>

          {permission === 'denied' || needsManualEnable ? (
            <p className="text-red-500 text-[11px] leading-relaxed">
              Notifikasi diblokir di pengaturan browser. Aktifkan manual lewat site settings browser Anda, lalu{' '}
              <strong>refresh halaman ini</strong> — aplikasi tidak bisa mendeteksi perubahan izin secara otomatis.
            </p>
          ) : (
            <label className="flex items-center justify-between mb-2 cursor-pointer">
              <span className="text-gray-700 dark:text-gray-300 text-xs">Enable browser notifications</span>
              <input
                type="checkbox"
                checked={settings.browserNotifOn}
                onChange={(e) => (e.target.checked ? handleEnable() : handleDisable())}
                className="accent-purple-600 w-4 h-4 cursor-pointer"
              />
            </label>
          )}

          <label className={`flex items-center justify-between ${!settings.browserNotifOn ? 'opacity-40' : 'cursor-pointer'}`}>
            <span className="text-gray-700 dark:text-gray-300 text-xs">Sound</span>
            <input
              type="checkbox"
              checked={settings.soundOn}
              disabled={!settings.browserNotifOn}
              onChange={handleSoundToggle}
              className="accent-purple-600 w-4 h-4 cursor-pointer disabled:cursor-not-allowed"
            />
          </label>

          <p className="text-gray-400 dark:text-gray-500 text-[10px] mt-2 leading-relaxed">
            Notifikasi cuma muncul saat tab ini tidak sedang aktif dilihat. Mode Do Not Disturb di OS tidak bisa dideteksi browser — cek pengaturan OS Anda kalau notifikasi tetap tidak terdengar/muncul.
          </p>
        </div>
      )}
    </div>
  );
}
