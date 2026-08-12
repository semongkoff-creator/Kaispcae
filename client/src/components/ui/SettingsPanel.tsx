import { ReactNode, useState } from 'react';
import { XLg, Sliders, BellFill, PersonCircle, BoxArrowRight } from 'react-bootstrap-icons';
import { UserPreferences } from '@/services/api';
import { useGameStore } from '@/stores/gameStore';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  getNotificationSettings,
  saveNotificationSettings,
  enableBrowserNotification,
  disableBrowserNotification,
  isNotificationSupported,
} from '@/services/browserNotifications';

// Settings — Tahap 4 absorbed NotificationSettings.tsx's two master toggles
// (moved here verbatim, same functions reused — not duplicated) and added
// per-kind toggles on top. Tahap 5 adds Akun's Logout — same `logout()`
// function every caller already had (App.tsx's real logout, or
// handleGuestLeave for guests), just always confirmed first here, unlike
// Lobby's separate pre-existing dropdown Logout entry which this doesn't
// touch. Mounted identically from both Sidebar.tsx (in-room) and Lobby.tsx
// (room list) — same overlay pattern BookingForm.tsx already uses (backdrop
// click / X to close).
interface SettingsPanelProps {
  onClose: () => void;
  // Undefined for guests (no account to persist to) — toggles below still
  // work for the current tab via the store, they just won't survive a reload.
  // See Tooltip.tsx / gameStore.ts's tooltipsEnabled/notifKinds.
  onUpdatePreferences?: (patch: UserPreferences) => void;
  onLogout: () => void;
}

type NotifKind = keyof NonNullable<UserPreferences['notifKinds']>;

// Labels/hints verified against each kind's actual trigger in useSocket.ts —
// same accuracy bar as the toolbar tooltip copy in Tahap 3.
const NOTIF_KIND_OPTIONS: { key: NotifKind; label: string; hint: string }[] = [
  { key: 'chat', label: 'Pesan chat', hint: 'Notifikasi & suara untuk pesan channel/DM biasa.' },
  { key: 'mention', label: 'Disebut (@mention)', hint: 'Notifikasi & suara saat namamu disebut di chat.' },
  { key: 'nudge', label: 'Disenggol (Nudge)', hint: 'Suara & notifikasi saat ada yang menyenggolmu.' },
  { key: 'slap', label: 'Dicolek (Slap)', hint: 'Suara saat ada yang mencolekmu.' },
  { key: 'handRaise', label: 'Angkat tangan', hint: 'Suara chime saat ada yang angkat tangan di zone-mu.' },
];

export function SettingsPanel({ onClose, onUpdatePreferences, onLogout }: SettingsPanelProps) {
  const [confirmingLogout, setConfirmingLogout] = useState(false);

  const tooltipsEnabled = useGameStore((s) => s.tooltipsEnabled);
  const setTooltipsEnabled = useGameStore((s) => s.setTooltipsEnabled);
  const toggleTooltips = () => {
    const next = !tooltipsEnabled;
    setTooltipsEnabled(next);
    onUpdatePreferences?.({ tooltipsEnabled: next });
  };

  const notifKinds = useGameStore((s) => s.notifKinds);
  const setNotifKinds = useGameStore((s) => s.setNotifKinds);
  const toggleKind = (key: NotifKind) => {
    const next = notifKinds[key] === false; // currently off -> turn on, else turn off
    setNotifKinds({ ...notifKinds, [key]: next });
    onUpdatePreferences?.({ notifKinds: { [key]: next } });
  };

  // Browser Notification master toggles — moved verbatim from
  // NotificationSettings.tsx (same state shape/functions), which now just
  // renders nothing (see Sidebar.tsx). Deliberately kept in localStorage,
  // not preferences: Notification.permission is a per-browser grant that
  // never travels across devices, so syncing the on/off intent server-side
  // would as often be wrong (synced "on" from a device that was never
  // actually granted permission) as it would be useful.
  const [browserSettings, setBrowserSettings] = useState(getNotificationSettings);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    isNotificationSupported() ? Notification.permission : 'unsupported',
  );
  const [needsManualEnable, setNeedsManualEnable] = useState(permission === 'denied');

  const handleEnable = async () => {
    const result = await enableBrowserNotification();
    setPermission(isNotificationSupported() ? Notification.permission : 'unsupported');
    setNeedsManualEnable(result.needsManualEnable);
    setBrowserSettings(getNotificationSettings());
  };
  const handleDisable = () => {
    disableBrowserNotification();
    setBrowserSettings(getNotificationSettings());
  };
  const handleSoundToggle = () => {
    const next = { ...browserSettings, soundOn: !browserSettings.soundOn };
    saveNotificationSettings(next);
    setBrowserSettings(next);
  };

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
          <Tooltip label="Tutup" detail="Tutup Pengaturan.">
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-700 cursor-pointer"
            >
              <XLg size={14} />
            </button>
          </Tooltip>
        </div>

        <div className="p-5 space-y-6">
          <SettingsSection icon={<Sliders size={14} />} title="Tampilan">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-xs text-gray-700 dark:text-gray-300 pr-3">
                Tampilkan tooltip
                <span className="block text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
                  Penjelasan detail saat kursor diarahkan ke tombol-tombol toolbar meeting.
                </span>
              </span>
              <Tooltip
                label="Tampilkan Tooltip"
                detail="Nyalakan/matikan penjelasan saat hover ke tombol-tombol di seluruh aplikasi."
              >
                <input
                  type="checkbox"
                  checked={tooltipsEnabled}
                  onChange={toggleTooltips}
                  className="accent-purple-600 w-4 h-4 cursor-pointer shrink-0"
                />
              </Tooltip>
            </label>
          </SettingsSection>

          <SettingsSection icon={<BellFill size={14} />} title="Notifikasi">
            <div className="space-y-3">
              {permission === 'unsupported' ? (
                <p className="text-xs text-gray-400 dark:text-gray-500">Browser ini tidak mendukung notifikasi.</p>
              ) : (
                <>
                  {permission === 'denied' || needsManualEnable ? (
                    <p className="text-red-500 text-[11px] leading-relaxed">
                      Notifikasi diblokir di pengaturan browser. Aktifkan manual lewat site settings browser Anda, lalu{' '}
                      <strong>refresh halaman ini</strong> — aplikasi tidak bisa mendeteksi perubahan izin secara otomatis.
                    </p>
                  ) : (
                    <label className="flex items-center justify-between cursor-pointer">
                      <span className="text-xs text-gray-700 dark:text-gray-300">Aktifkan notifikasi browser</span>
                      <Tooltip label="Notifikasi Browser" detail="Terima notifikasi meski tab KaiSpace tidak aktif.">
                        <input
                          type="checkbox"
                          checked={browserSettings.browserNotifOn}
                          onChange={(e) => (e.target.checked ? handleEnable() : handleDisable())}
                          className="accent-purple-600 w-4 h-4 cursor-pointer shrink-0"
                        />
                      </Tooltip>
                    </label>
                  )}

                  <label className={`flex items-center justify-between ${!browserSettings.browserNotifOn ? 'opacity-40' : 'cursor-pointer'}`}>
                    <span className="text-xs text-gray-700 dark:text-gray-300">Suara notifikasi</span>
                    <Tooltip label="Suara Notifikasi" detail="Nyalakan bunyi saat ada notifikasi baru.">
                      <input
                        type="checkbox"
                        checked={browserSettings.soundOn}
                        disabled={!browserSettings.browserNotifOn}
                        onChange={handleSoundToggle}
                        className="accent-purple-600 w-4 h-4 cursor-pointer disabled:cursor-not-allowed shrink-0"
                      />
                    </Tooltip>
                  </label>
                </>
              )}

              <div className="pt-2 border-t border-purple-50 dark:border-gray-700">
                <p className="text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-2">Per jenis kejadian</p>
                <div className="space-y-2">
                  {NOTIF_KIND_OPTIONS.map((opt) => (
                    <label key={opt.key} className="flex items-center justify-between cursor-pointer">
                      <span className="text-xs text-gray-700 dark:text-gray-300 pr-3">
                        {opt.label}
                        <span className="block text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">{opt.hint}</span>
                      </span>
                      <Tooltip
                        label={`Notifikasi ${opt.label}`}
                        detail="Nyala/matikan notifikasi khusus untuk jenis kejadian ini, terpisah dari yang lain."
                      >
                        <input
                          type="checkbox"
                          checked={notifKinds[opt.key] !== false}
                          onChange={() => toggleKind(opt.key)}
                          className="accent-purple-600 w-4 h-4 cursor-pointer shrink-0"
                        />
                      </Tooltip>
                    </label>
                  ))}
                </div>
              </div>

              <p className="text-gray-400 dark:text-gray-500 text-[10px] leading-relaxed">
                Notifikasi browser cuma muncul saat tab ini tidak sedang aktif dilihat. Toggle per jenis di atas berlaku untuk suara di dalam room juga, dan tersimpan ke akunmu (ikut kalau login di perangkat lain).
              </p>
            </div>
          </SettingsSection>

          <SettingsSection icon={<PersonCircle size={14} />} title="Akun">
            {confirmingLogout ? (
              <div className="rounded-lg border border-red-100 dark:border-red-900/40 bg-red-50 dark:bg-red-900/20 p-3">
                <p className="text-xs text-gray-700 dark:text-gray-200 mb-3">Yakin mau logout?</p>
                <div className="flex gap-2">
                  <Tooltip label="Batal" detail="Batalkan, tetap login." wrapperClassName="flex-1">
                    <button
                      onClick={() => setConfirmingLogout(false)}
                      className="flex-1 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 text-xs cursor-pointer"
                    >
                      Batal
                    </button>
                  </Tooltip>
                  <Tooltip label="Ya, Logout" detail="Keluar dari akunmu sekarang." wrapperClassName="flex-1">
                    <button
                      onClick={() => { setConfirmingLogout(false); onLogout(); }}
                      className="flex-1 px-3 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white text-xs cursor-pointer"
                    >
                      Logout
                    </button>
                  </Tooltip>
                </div>
              </div>
            ) : (
              <Tooltip label="Logout" detail="Keluar dari akunmu.">
                <button
                  onClick={() => setConfirmingLogout(true)}
                  className="flex items-center gap-2 text-xs text-red-500 hover:text-red-600 cursor-pointer"
                >
                  <BoxArrowRight size={14} /> Logout
                </button>
              </Tooltip>
            )}
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
