import { useState, useEffect, useCallback } from 'react';
import { api, ApiError, UserProfile, UserPreferences } from '@/services/api';

// Statuses that mean "the server actively rejected this token" (bad
// signature, expired, or the user id it points to no longer exists) as
// opposed to a network failure (offline, server unreachable) — only the
// former should tell the user their session expired and clear the token;
// a network blip on mount shouldn't silently sign someone out.
const AUTH_REJECTED_STATUSES = new Set([401, 403, 404]);

export function useAuth() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpiredMessage, setSessionExpiredMessage] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      // Google OAuth return: the callback bounced back to "/?googleCode=…" (a
      // single-use code, never the raw JWT). Swap it for the token and store
      // it under the SAME key manual login uses, then fall through to the
      // normal getMe() path — so nothing downstream knows or cares that this
      // session came from Google.
      const params = new URLSearchParams(window.location.search);
      const googleCode = params.get('googleCode');
      const googleError = params.get('googleError');
      if (googleCode || googleError) {
        window.history.replaceState({}, '', window.location.pathname);
      }
      if (googleError) {
        // 'no-invite' is the multi-tenant-aware rejection (see
        // routes/google.ts): a Google account with no matching existing
        // user AND no valid org-invite backing it — deliberately NOT
        // landed in any default org. Every other reason collapses to a
        // generic message.
        setError(
          googleError === 'no-invite'
            ? 'Akun Google ini belum terdaftar di organisasi mana pun. Minta admin mengirim undangan terlebih dahulu.'
            : 'Login Google gagal. Silakan coba lagi.',
        );
      } else if (googleCode) {
        try {
          const { token } = await api.exchangeGoogleCode(googleCode);
          localStorage.setItem('vm_token', token);
        } catch {
          setError('Login Google gagal menukar kode. Silakan coba lagi.');
        }
      }

      const token = localStorage.getItem('vm_token');
      if (!token) {
        setLoading(false);
        return;
      }
      try {
        const res = await api.getMe();
        setUser(res.user);
        // Sliding-expiry refresh: the server only sends a new token back
        // when the current one is close to expiring (see routes/auth.ts).
        if (res.token) localStorage.setItem('vm_token', res.token);
      } catch (err) {
        localStorage.removeItem('vm_token');
        if (err instanceof ApiError && AUTH_REJECTED_STATUSES.has(err.status)) {
          setSessionExpiredMessage('Your session has expired. Please log in again.');
        }
        // Any other failure (network offline, server down) fails silently
        // here — there's no session to blame, so there's nothing accurate
        // to tell the user yet. They'll just land on the login screen.
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Bug 1 — a login on another device superseded this session. api.ts (REST)
  // and useSocket (socket) both dispatch 'vm-session-superseded'; here we end
  // the session and surface the reason on the login screen (reusing the
  // existing sessionExpiredMessage banner) instead of a stuck/confusing UI.
  useEffect(() => {
    const onSuperseded = (e: Event) => {
      localStorage.removeItem('vm_token');
      setUser(null);
      const msg = (e as CustomEvent).detail as string | undefined;
      setSessionExpiredMessage(msg || 'Akun ini baru saja login di perangkat lain. Sesi ini telah berakhir.');
    };
    window.addEventListener('vm-session-superseded', onSuperseded);
    return () => window.removeEventListener('vm-session-superseded', onSuperseded);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    setSessionExpiredMessage(null);
    try {
      const res = await api.login(email, password);
      localStorage.setItem('vm_token', res.token);
      setUser(res.user);
      return res.user;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      throw err;
    }
  }, []);

  const register = useCallback(async (email: string, password: string, displayName: string) => {
    setError(null);
    setSessionExpiredMessage(null);
    try {
      const res = await api.register(email, password, displayName);
      localStorage.setItem('vm_token', res.token);
      setUser(res.user);
      return res.user;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
      throw err;
    }
  }, []);

  // Self-serve org creation — same shape as register above, landing the
  // new account as the founding admin of a brand-new org instead of the
  // single default org register() always uses.
  const createOrganization = useCallback(async (orgName: string, email: string, password: string, displayName: string) => {
    setError(null);
    setSessionExpiredMessage(null);
    try {
      const res = await api.createOrganization(orgName, email, password, displayName);
      localStorage.setItem('vm_token', res.token);
      setUser(res.user);
      return res.user;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membuat organisasi');
      throw err;
    }
  }, []);

  // Fase 5 (org-resolution) — same shape as register above, landing the new
  // account in whichever org the invite belongs to instead of the single
  // default org register() always uses.
  const acceptOrgInvite = useCallback(async (inviteToken: string, password: string, displayName: string) => {
    setError(null);
    setSessionExpiredMessage(null);
    try {
      const res = await api.acceptOrgInvite(inviteToken, password, displayName);
      localStorage.setItem('vm_token', res.token);
      setUser(res.user);
      return res.user;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal bergabung');
      throw err;
    }
  }, []);

  // QA #1/#6 — called once the first-run tutorial's last slide is dismissed.
  // Updates local state immediately (so the gate in App.tsx doesn't need a
  // round trip before letting the user into the room) and persists it
  // server-side so it stays gone on future logins. Fire-and-forget on the
  // network call: worst case (request fails) the tutorial just shows again
  // next login, which is annoying but never blocking.
  const markTutorialSeen = useCallback(() => {
    setUser((prev) => (prev ? { ...prev, tutorialCompletedAt: new Date().toISOString() } : prev));
    api.markTutorialCompleted().catch(() => {});
  }, []);

  // Settings feature — same optimistic-update pattern as markTutorialSeen
  // above: local state updates immediately so a toggle feels instant, then
  // persists server-side (NOT localStorage, per the cross-device requirement)
  // fire-and-forget. Shallow-merged locally to mirror the server's own
  // shallow-merge in PATCH /users/me/preferences.
  const updatePreferences = useCallback((patch: UserPreferences) => {
    setUser((prev) => (prev ? { ...prev, preferences: { ...prev.preferences, ...patch } } : prev));
    api.updatePreferences(patch).catch(() => {});
  }, []);

  const logout = useCallback(() => {
    // Captured BEFORE removing it — the server needs the outgoing token to
    // know WHICH session to invalidate (see auth.ts's /logout), so it must
    // still be readable at the moment the request is built, not after.
    const token = localStorage.getItem('vm_token');
    localStorage.removeItem('vm_token');
    setUser(null);
    // The upload-session cookie is HttpOnly, so only the server can clear it.
    // Fire-and-forget: a failed call must not keep the user on a screen they
    // just asked to leave, and the cookie expires with the token regardless.
    api.logout(token).catch(() => {});
  }, []);

  return { user, loading, error, sessionExpiredMessage, login, register, acceptOrgInvite, createOrganization, logout, setError, markTutorialSeen, updatePreferences };
}
