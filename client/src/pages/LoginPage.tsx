import { useState } from 'react';
import { SunFill, MoonFill } from 'react-bootstrap-icons';
import { Theme } from '@/hooks/useTheme';

interface LoginPageProps {
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (email: string, password: string, displayName: string) => Promise<void>;
  error: string | null;
  // Set instead of `error` when auto-login on mount found a token the
  // server actively rejected (expired/invalid/deleted user) — distinct
  // styling on purpose, since this isn't something the user did wrong.
  sessionExpiredMessage?: string | null;
  theme: Theme;
  onToggleTheme: () => void;
}

export function LoginPage({ onLogin, onRegister, error, sessionExpiredMessage, theme, onToggleTheme }: LoginPageProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === 'login') {
        await onLogin(email, password);
      } else {
        await onRegister(email, password, displayName);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-screen h-screen bg-gradient-to-br from-white to-purple-50 dark:from-purple-950 dark:to-gray-950 flex items-center justify-center relative">
      <button
        onClick={onToggleTheme}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/90 dark:bg-gray-800/90 border border-purple-100 dark:border-gray-700 shadow-sm flex items-center justify-center text-purple-700 dark:text-purple-300 cursor-pointer"
      >
        {theme === 'dark' ? <SunFill size={14} /> : <MoonFill size={14} />}
      </button>
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 w-full max-w-sm shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700">
        <div className="inline-flex bg-white rounded-xl p-2 mb-3 shadow-sm">
          <img
            src="/assets/img/favico.png"
            alt="KaiSpace"
            className="block w-16 h-16 object-contain"
            decoding="async"
          />
        </div>
        <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">{mode === 'login' ? 'Welcome back' : 'Create your account'}</p>

        {sessionExpiredMessage && (
          <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-xs rounded-lg px-3 py-2 mb-4">
            {sessionExpiredMessage}
          </div>
        )}

        {error && (
          <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-xs rounded-lg px-3 py-2 mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="Email" required autoFocus
            className="w-full bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg px-3 py-2.5 outline-none border border-purple-100 dark:border-gray-600 focus:border-purple-500 transition-colors text-sm"
          />
          <input
            type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="Password" required minLength={6}
            className="w-full bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg px-3 py-2.5 outline-none border border-purple-100 dark:border-gray-600 focus:border-purple-500 transition-colors text-sm"
          />
          {mode === 'register' && (
            <input
              type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Display name" required maxLength={30}
              className="w-full bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg px-3 py-2.5 outline-none border border-purple-100 dark:border-gray-600 focus:border-purple-500 transition-colors text-sm"
            />
          )}
          <button
            type="submit" disabled={loading}
            className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white font-semibold rounded-lg py-2.5 transition-colors text-sm cursor-pointer"
          >
            {loading ? 'Please wait...' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        {/* Lark OAuth — an ADDITIONAL option beside the manual form above,
            which is untouched. A plain full-page navigation (not fetch): the
            server issues a 302 to Lark's consent screen. */}
        <div className="flex items-center gap-2 my-4">
          <span className="flex-1 h-px bg-purple-100 dark:bg-gray-700" />
          <span className="text-gray-400 dark:text-gray-500 text-[11px]">atau</span>
          <span className="flex-1 h-px bg-purple-100 dark:bg-gray-700" />
        </div>
        <a
          href="/api/auth/lark/login"
          className="w-full flex items-center justify-center gap-2 bg-white dark:bg-gray-700 border border-purple-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-600 font-medium rounded-lg py-2.5 transition-colors text-sm cursor-pointer"
        >
          Login dengan Lark
        </a>

        <p className="text-gray-500 dark:text-gray-400 text-xs text-center mt-5">
          {mode === 'login' ? "Don't have an account?" : 'Already have an account?'}{' '}
          <button
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
            className="text-purple-600 dark:text-purple-400 hover:text-purple-700 cursor-pointer"
          >
            {mode === 'login' ? 'Sign up' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
