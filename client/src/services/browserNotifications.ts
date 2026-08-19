// §10 — Browser Notification. Settings are kept purely in this browser
// (localStorage), not synced server-side — unlike the spec's own
// NotificationSetting{userId,...} model, Notification.permission itself is
// a browser-local grant that never travels across devices anyway, so
// persisting the on/off *intent* server-side would just as often be wrong
// (e.g. synced "on" from device A while device B was never actually
// granted permission) as it would be useful. avatarConfig-style server
// sync is deliberately NOT reused here for that reason.

import { useGameStore } from '@/stores/gameStore';

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

// Called on every incoming chat message (see useSocket.ts). `title` is the
// notification heading — plain senderName for an ordinary message, or a
// "so-and-so mentioned you in #channel" string (see Potongan C2's mention
// notify call) so a mention reads as distinctly more important than regular
// chat noise. `onClick`, if given, runs when the notification itself is
// clicked (in addition to always focusing the tab) — the mention call site
// uses this to jump straight to the channel that was mentioned in.
//
// Bug fix — a native OS Notification()'s own chrome (icon, gear, close
// button, host header) is entirely browser/OS-controlled; the app can only
// ever set its title/body text, no amount of styling reaches it. While the
// tab is visible there's also no real need for an OS-level interruption —
// so this now shows a proper in-app toast instead (InAppToastStack.tsx),
// matching the rest of the UI, and only falls back to the (unchanged)
// native popup+sound path once the tab is actually backgrounded, the one
// case an in-app toast physically can't reach.
export function notifyNewMessage(title: string, text: string, onClick?: () => void, icon = '💬'): void {
  if (document.visibilityState === 'visible') {
    useGameStore.getState().pushInAppToast(icon, title, text);
    return;
  }
  const settings = getNotificationSettings();
  if (!settings.browserNotifOn || !isNotificationSupported() || Notification.permission !== 'granted') return;

  const n = new Notification(title, { body: text, tag: 'meetkai-chat' });
  n.onclick = () => { window.focus(); onClick?.(); };
  if (settings.soundOn) playNotificationSound();
}

// Called only for the player actually being nudged (see useSocket.ts's
// PLAYER_NUDGE handler). Same in-app-toast-when-visible / native-when-
// hidden split as notifyNewMessage above — a nudge exists specifically to
// pull someone's attention, which a plain in-app toast already does fine
// while they're looking at the tab; the OS popup+sound is reserved for
// when they've actually looked away.
export function notifyNudge(nudgerName: string): void {
  const body = `${nudgerName} menyenggolmu`;
  if (document.visibilityState === 'visible') {
    useGameStore.getState().pushInAppToast('👋', 'Disenggol!', body);
    return;
  }
  const settings = getNotificationSettings();
  if (!settings.browserNotifOn || !isNotificationSupported() || Notification.permission !== 'granted') return;

  const n = new Notification('Disenggol!', { body, tag: 'meetkai-nudge' });
  // Was missing entirely — unlike notifyNewMessage above, clicking the OS
  // popup did nothing at all, not even bring the tab back to front. A nudge
  // exists specifically to pull someone back to the app from another
  // tab/app, so the notification itself doing nothing on click defeated
  // that purpose the moment they actually clicked it instead of alt-tabbing.
  n.onclick = () => window.focus();
  if (settings.soundOn) playNotificationSound();
}
