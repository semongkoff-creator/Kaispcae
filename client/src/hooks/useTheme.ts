import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'vm_theme';

function getInitialTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  // No explicit choice yet — default to the OS/browser preference once,
  // same as Tailwind's own 'media' strategy would, but as a one-time
  // starting point rather than something that keeps overriding the
  // in-app toggle on every OS-level change.
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

// Single source of truth for the app's light/dark mode — every component
// that needs to know or change it should go through this hook rather than
// touching localStorage/documentElement directly, so they never drift out
// of sync with each other (e.g. the toggle button in Lobby vs. the one in
// the in-room Sidebar).
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return { theme, setTheme, toggleTheme };
}
