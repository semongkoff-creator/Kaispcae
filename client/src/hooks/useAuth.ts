import { useState, useEffect, useCallback } from 'react';
import { api, UserProfile } from '@/services/api';

export function useAuth() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('vm_token');
    if (!token) {
      setLoading(false);
      return;
    }
    api.getMe()
      .then((res) => setUser(res.user))
      .catch(() => localStorage.removeItem('vm_token'))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
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

  return { user, loading, error, login, register, logout, setError };
}
