// §10 — Browser Notification. Settings are kept purely in this browser
// (localStorage), not synced server-side — unlike the spec's own
// NotificationSetting{userId,...} model, Notification.permission itself is
// a browser-local grant that never travels across devices anyway, so
// persisting the on/off *intent* server-side would just as often be wrong
// (e.g. synced "on" from device A while device B was never actually
// granted permission) as it would be useful. avatarConfig-style server
// sync is deliberately NOT reused here for that reason.

const STORAGE_KEY = 'vm_notification_settings';

export interface NotificationSettings {
  browserNotifOn: boolean;
  soundOn: boolean;
}

const DEFAULT_SETTINGS: NotificationSettings = { browserNotifOn: false, soundOn: true };

export function getNotificationSettings(): NotificationSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveNotificationSettings(settings: NotificationSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

// Spec §10's own exact state machine: granted → just flip the setting;
// default → ask (browsers only allow this prompt from a real user
// gesture, e.g. a button click, never on page load); denied → there is no
// programmatic way back in, direct them to the browser's own site settings.
export async function enableBrowserNotification(): Promise<{ success: boolean; needsManualEnable: boolean }> {
  if (!isNotificationSupported()) return { success: false, needsManualEnable: false };

  if (Notification.permission === 'granted') {
    saveNotificationSettings({ ...getNotificationSettings(), browserNotifOn: true });
    return { success: true, needsManualEnable: false };
  }

  if (Notification.permission === 'denied') {
    return { success: false, needsManualEnable: true };
  }

  const result = await Notification.requestPermission();
  if (result === 'granted') {
    saveNotificationSettings({ ...getNotificationSettings(), browserNotifOn: true });
    return { success: true, needsManualEnable: false };
  }
  return { success: false, needsManualEnable: true };
}

export function disableBrowserNotification(): void {
  saveNotificationSettings({ ...getNotificationSettings(), browserNotifOn: false });
}

// A short, generated beep — no bundled audio asset needed. Created fresh
// per call since AudioContext instances aren't meant to be reused across a
// long-lived singleton the way webrtcService's is (this one is fire-and-forget).
export function playNotificationSound(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    osc.onended = () => ctx.close();
  } catch {
    // Web Audio unavailable/blocked — not worth surfacing an error for a beep.
  }
}

// Called on every incoming chat message (see useSocket.ts) — the spec's own
// rule: only actually show anything while the tab is in the background,
// never while the user is already looking at it.
export function notifyNewMessage(senderName: string, text: string): void {
  if (document.visibilityState === 'visible') return;
  const settings = getNotificationSettings();
  if (!settings.browserNotifOn || !isNotificationSupported() || Notification.permission !== 'granted') return;

  new Notification(senderName, { body: text, tag: 'meetkai-chat' });
  if (settings.soundOn) playNotificationSound();
}
