// Personal "mute a disruptive person" list — purely client-side, never
// synced server-side or visible to anyone else (unlike Kick, which is an
// admin-only room-wide removal). Muting someone just filters THEIR chat
// messages/nudges/slaps out of YOUR OWN view; they can't tell, and nothing
// about their actual room presence changes. Persisted in localStorage
// (same pattern as browserNotifications.ts's settings) so it survives a
// reload — there is no natural "this session only" scope for something
// this preference-like.
const STORAGE_KEY = 'vm_muted_users';

export function getMutedUserIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveMutedUserIds(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage full/disabled — the in-memory store (gameStore's
    // mutedUserIds) still works for the rest of this session, it just
    // won't survive a reload. Not worth surfacing to the user.
  }
}
