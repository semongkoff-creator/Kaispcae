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
    const token = localStorage.getItem('vm_token');
    if (!token) {
      setLoading(false);
      return;
    }
    api.getMe()
      .then((res) => {
        setUser(res.user);
        // Sliding-expiry refresh: the server only sends a new token back
        // when the current one is close to expiring (see routes/auth.ts).
        if (res.token) localStorage.setItem('vm_token', res.token);
      })
      .catch((err) => {
        localStorage.removeItem('vm_token');
        if (err instanceof ApiError && AUTH_REJECTED_STATUSES.has(err.status)) {
          setSessionExpiredMessage('Your session has expired. Please log in again.');
        }
        // Any other failure (network offline, server down) fails silently
        // here — there's no session to blame, so there's nothing accurate
        // to tell the user yet. They'll just land on the login screen.
      })
      .finally(() => setLoading(false));
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
    localStorage.removeItem('vm_token');
    setUser(null);
  }, []);

  return { user, loading, error, sessionExpiredMessage, login, register, logout, setError };
}
