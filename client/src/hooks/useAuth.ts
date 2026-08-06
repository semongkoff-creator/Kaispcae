import { useState, useEffect, useCallback } from 'react';
import { api, ApiError, UserProfile } from '@/services/api';

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
      // Lark OAuth return: the callback bounced back to "/?larkCode=…" (a
      // single-use code, never the raw JWT). Swap it for the token and store
      // it under the SAME key manual login uses, then fall through to the
      // normal getMe() path — so nothing downstream knows or cares that this
      // session came from Lark.
      const params = new URLSearchParams(window.location.search);
      const larkCode = params.get('larkCode');
      const larkError = params.get('larkError');
      if (larkCode || larkError) {
        // Strip the query so a refresh doesn't re-run this with a dead code.
        window.history.replaceState({}, '', window.location.pathname);
      }
      if (larkError) {
        setError('Login Lark gagal. Silakan coba lagi.');
      } else if (larkCode) {
        try {
          const { token } = await api.exchangeLarkCode(larkCode);
          localStorage.setItem('vm_token', token);
        } catch {
          setError('Login Lark gagal menukar kode. Silakan coba lagi.');
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

  return { user, loading, error, sessionExpiredMessage, login, register, logout, setError };
}
