import { useState, useEffect } from 'react';
import { SunFill, MoonFill } from 'react-bootstrap-icons';
import { Theme } from '@/hooks/useTheme';
import { api } from '@/services/api';

// Figma "kaispace" reference — closest reading off the screenshot (no exact
// hex was given). The button below hardcodes this same value in a Tailwind
// arbitrary-value class instead of referencing this constant (Tailwind's
// JIT scanner reads className as literal source text at build time, so a
// template-interpolated class never resolves) — update both spots together
// if Figma Dev Mode's Inspect tab gives an exact hex later.
const FIGMA_PURPLE = '#3B1E54';

// Google's real 4-color "G" mark — no react-bootstrap-icons equivalent
// exists (checked), and this button has no backend behind it yet (see
// GOOGLE_LOGIN_ENABLED below), so an accurate, recognizable mark matters
// more than usual for signaling "this is a real, familiar option, just not
// wired up yet" rather than a mystery placeholder icon.
function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
      <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
      <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
      <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
    </svg>
  );
}

interface LoginPageProps {
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (email: string, password: string, displayName: string) => Promise<void>;
  // Self-serve org creation — a third entry point alongside login/register,
  // NOT a replacement for onRegister: the existing "Sign Up here!" flow
  // still joins the single default org, unchanged. This one creates a
  // brand-new org and lands the caller as its founding admin.
  onCreateOrganization: (orgName: string, email: string, password: string, displayName: string) => Promise<void>;
  error: string | null;
  // Set instead of `error` when auto-login on mount found a token the
  // server actively rejected (expired/invalid/deleted user) — distinct
  // styling on purpose, since this isn't something the user did wrong.
  sessionExpiredMessage?: string | null;
  theme: Theme;
  onToggleTheme: () => void;
}

export function LoginPage({ onLogin, onRegister, onCreateOrganization, error, sessionExpiredMessage, theme, onToggleTheme }: LoginPageProps) {
  const [mode, setMode] = useState<'login' | 'register' | 'createOrg'>('login');
  const [orgName, setOrgName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  // Figma reference checkboxes — purely decorative (unchecked default,
  // never read by handleSubmit below; requiring them would change what
  // register() actually gates on, which is auth LOGIC, out of scope here).
  // Shown regardless of mode: the Figma reference itself pairs them with
  // the "Login" button, not a separate sign-up screen, so matching that
  // literally wins over the (reasonable but not what was asked for) UX
  // argument that "you are creating an account" reads oddly during login.
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);

  // Fase 5 — Google login now has a real backend behind it (routes/google.ts),
  // gated server-side by GOOGLE_LOGIN_ENABLED. Defaults to hidden so the
  // button never flashes "enabled" before this resolves.
  const [googleEnabled, setGoogleEnabled] = useState(false);
  useEffect(() => {
    api.getAuthConfig().then((c) => setGoogleEnabled(c.googleEnabled)).catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === 'login') {
        await onLogin(email, password);
      } else if (mode === 'createOrg') {
        await onCreateOrganization(orgName, email, password, displayName);
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
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 w-full max-w-md shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700">
        <h1 className="text-[28px] leading-tight font-bold text-gray-900 dark:text-white mb-6">
          {mode === 'login' ? 'Welcome to KaiSpace' : mode === 'createOrg' ? 'Buat organisasi baru' : 'Create your KaiSpace account'}
        </h1>

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
          {mode === 'createOrg' && (
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Nama organisasi</span>
              <input
                type="text" value={orgName} onChange={(e) => setOrgName(e.target.value)}
                placeholder="mis. DCM"
                maxLength={80} required autoFocus
                className="w-full bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg px-3 py-2.5 outline-none border border-purple-100 dark:border-gray-600 focus:border-purple-500 transition-colors text-sm"
              />
            </label>
          )}
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Email</span>
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="commitcommunity@gmail.com" required autoFocus
              className="w-full bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg px-3 py-2.5 outline-none border border-purple-100 dark:border-gray-600 focus:border-purple-500 transition-colors text-sm"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Password</span>
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••" required minLength={6}
              className="w-full bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg px-3 py-2.5 outline-none border border-purple-100 dark:border-gray-600 focus:border-purple-500 transition-colors text-sm"
            />
          </label>
          {(mode === 'register' || mode === 'createOrg') && (
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Display name</span>
              <input
                type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Nama tampilanmu" required maxLength={30}
                className="w-full bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg px-3 py-2.5 outline-none border border-purple-100 dark:border-gray-600 focus:border-purple-500 transition-colors text-sm"
              />
            </label>
          )}

          <div className="space-y-2 pt-1">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox" checked={agreedToTerms}
                onChange={(e) => setAgreedToTerms(e.target.checked)}
                className="mt-0.5 w-3.5 h-3.5 accent-[#3B1E54] cursor-pointer shrink-0"
              />
              <span className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
                By signing up, you are creating a KAISPACE account, and you agree to KAISPACE&apos;s{' '}
                <span className="text-[#3B1E54] dark:text-purple-400 font-semibold" title="Segera hadir">Term of Use</span>
                {' '}and{' '}
                <span className="text-[#3B1E54] dark:text-purple-400 font-semibold" title="Segera hadir">Privacy Policy</span>.
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox" checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="w-3.5 h-3.5 accent-[#3B1E54] cursor-pointer shrink-0"
              />
              <span className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
                Remember Me as <span className="font-semibold text-gray-700 dark:text-gray-300">Member</span> of <span className="font-semibold text-gray-700 dark:text-gray-300">KAISPACE</span>.
              </span>
            </label>
          </div>

          {/* Tailwind's JIT scanner reads this className as literal source
              text at build time — it can't resolve a template-interpolated
              class (`bg-[${FIGMA_PURPLE}]` would never match anything), so
              the hex has to be hardcoded here rather than referencing the
              FIGMA_PURPLE constant above. Update both places together if the
              color changes. */}
          <button
            type="submit" disabled={loading}
            className="w-full bg-[#3B1E54] hover:bg-[#4A1E6D] disabled:opacity-50 text-white font-semibold rounded-lg py-2.5 transition-colors text-sm cursor-pointer"
          >
            {loading ? 'Please wait...' : mode === 'login' ? 'Login' : mode === 'createOrg' ? 'Buat organisasi' : 'Create Account'}
          </button>
        </form>

        {/* Google OAuth — an ADDITIONAL option beside the manual form above,
            which is untouched. A plain full-page navigation (not fetch): the
            server issues a 302 to Google's consent screen. Gated by
            GOOGLE_LOGIN_ENABLED (see above); when off the button stays
            visible but inert rather than vanishing, so the layout doesn't
            shift between deployments. */}
        {mode !== 'createOrg' && (
          <>
            <div className="flex items-center gap-2 my-4">
              <span className="flex-1 h-px bg-purple-100 dark:bg-gray-700" />
              <span className="text-gray-400 dark:text-gray-500 text-[11px]">OR</span>
              <span className="flex-1 h-px bg-purple-100 dark:bg-gray-700" />
            </div>
            <a
              href={googleEnabled ? '/api/auth/google/login' : undefined}
              aria-disabled={!googleEnabled}
              title={googleEnabled ? undefined : 'Segera hadir'}
              className={`flex items-center justify-center gap-1.5 bg-white dark:bg-gray-700 border border-purple-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 font-medium rounded-lg py-2.5 px-1 transition-colors text-[11px] ${
                googleEnabled
                  ? 'hover:bg-purple-50 dark:hover:bg-gray-600 cursor-pointer'
                  : 'opacity-40 cursor-not-allowed pointer-events-none'
              }`}
            >
              <GoogleIcon /> Login with Google
            </a>
          </>
        )}

        {mode !== 'createOrg' && (
          <p className="text-gray-500 dark:text-gray-400 text-xs text-center mt-5">
            {mode === 'login' ? "Don't have account?" : 'Already have an account?'}{' '}
            <button
              onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
              style={{ color: FIGMA_PURPLE }}
              className="font-semibold hover:brightness-110 cursor-pointer"
            >
              {mode === 'login' ? 'Sign Up here!' : 'Sign in'}
            </button>
          </p>
        )}

        <p className="text-gray-500 dark:text-gray-400 text-xs text-center mt-2">
          {mode === 'createOrg' ? (
            <>
              Sudah punya akun?{' '}
              <button
                type="button"
                onClick={() => setMode('login')}
                style={{ color: FIGMA_PURPLE }}
                className="font-semibold hover:brightness-110 cursor-pointer"
              >
                Login di sini
              </button>
            </>
          ) : (
            <>
              Mau bikin organisasi sendiri?{' '}
              <button
                type="button"
                onClick={() => setMode('createOrg')}
                style={{ color: FIGMA_PURPLE }}
                className="font-semibold hover:brightness-110 cursor-pointer"
              >
                Buat di sini
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
