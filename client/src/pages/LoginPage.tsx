import { useState } from 'react';

interface LoginPageProps {
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (email: string, password: string, displayName: string) => Promise<void>;
  error: string | null;
  // Set instead of `error` when auto-login on mount found a token the
  // server actively rejected (expired/invalid/deleted user) — distinct
  // styling on purpose, since this isn't something the user did wrong.
  sessionExpiredMessage?: string | null;
}

export function LoginPage({ onLogin, onRegister, error, sessionExpiredMessage }: LoginPageProps) {
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
    <div className="w-screen h-screen bg-gradient-to-br from-white to-purple-50 flex items-center justify-center">
      <div className="bg-white rounded-2xl p-8 w-full max-w-sm shadow-xl shadow-purple-100/50 border border-purple-100">
        <h1 className="text-gray-900 text-2xl font-bold mb-1">VirtualMeet</h1>
        <p className="text-gray-500 text-sm mb-6">{mode === 'login' ? 'Welcome back' : 'Create your account'}</p>

        {sessionExpiredMessage && (
          <div className="bg-amber-50 border border-amber-200 text-amber-700 text-xs rounded-lg px-3 py-2 mb-4">
            {sessionExpiredMessage}
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-600 text-xs rounded-lg px-3 py-2 mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="Email" required autoFocus
            className="w-full bg-purple-50/50 text-gray-900 placeholder-gray-400 rounded-lg px-3 py-2.5 outline-none border border-purple-100 focus:border-purple-500 transition-colors text-sm"
          />
          <input
            type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="Password" required minLength={6}
            className="w-full bg-purple-50/50 text-gray-900 placeholder-gray-400 rounded-lg px-3 py-2.5 outline-none border border-purple-100 focus:border-purple-500 transition-colors text-sm"
          />
          {mode === 'register' && (
            <input
              type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Display name" required maxLength={30}
              className="w-full bg-purple-50/50 text-gray-900 placeholder-gray-400 rounded-lg px-3 py-2.5 outline-none border border-purple-100 focus:border-purple-500 transition-colors text-sm"
            />
          )}
          <button
            type="submit" disabled={loading}
            className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white font-semibold rounded-lg py-2.5 transition-colors text-sm cursor-pointer"
          >
            {loading ? 'Please wait...' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <p className="text-gray-500 text-xs text-center mt-5">
          {mode === 'login' ? "Don't have an account?" : 'Already have an account?'}{' '}
          <button
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
            className="text-purple-600 hover:text-purple-700 cursor-pointer"
          >
            {mode === 'login' ? 'Sign up' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
