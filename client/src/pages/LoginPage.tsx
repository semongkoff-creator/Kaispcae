import { useState, useEffect } from 'react';
import { SunFill, MoonFill } from 'react-bootstrap-icons';
import { Theme } from '@/hooks/useTheme';
import { api } from '@/services/api';

// Google's real 4-color "G" mark — no react-bootstrap-icons equivalent
// exists (checked), and this button has no backend behind it yet (see
// GOOGLE_LOGIN_ENABLED below), so an accurate, recognizable mark matters
// more than usual for signaling "this is a real, familiar option, just not
// wired up yet" rather than a mystery placeholder icon.
function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
      <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
      <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
      <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
    </svg>
  );
}

// Figma's login checkboxes (nodes 4:40/4:43) are a plain square box, not a
// browser checkbox — `appearance-none` swaps out the native box while
// keeping a real <input type="checkbox"> underneath (same checked/onChange
// wiring as before), so this is visual-only, not a custom form control.
function SquareCheckbox({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className={`mt-0.5 w-3.5 h-3.5 shrink-0 cursor-pointer appearance-none rounded-[1.59px] border bg-center bg-no-repeat transition-colors ${
        checked
          ? 'bg-login-accent border-login-accent'
          : 'bg-login-surface dark:bg-gray-700 border-login-text-placeholder dark:border-gray-600'
      }`}
      // Inline style, not a Tailwind arbitrary value — a data: URI this long,
      // with spaces and quotes of its own, is fragile for Tailwind's JIT
      // scanner to parse reliably; a plain style prop has no such risk.
      style={checked ? {
        backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 8l3.5 3.5L13 5'/%3E%3C/svg%3E\")",
        backgroundSize: '10px 10px',
      } : undefined}
    />
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
    <div className="w-screen h-screen bg-white dark:bg-gray-950 flex items-center justify-center relative p-4">
      <button
        onClick={onToggleTheme}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white dark:bg-gray-800 border border-login-border-soft dark:border-gray-700 shadow-sm flex items-center justify-center text-login-accent dark:text-purple-300 cursor-pointer"
      >
        {theme === 'dark' ? <SunFill size={14} /> : <MoonFill size={14} />}
      </button>
      {/* Figma node 5:103 — fixed 638x730 there; kept fluid here (max-w-lg,
          natural height) so the same design holds up on mobile widths, per
          the "responsive wajar" requirement rather than a literal pixel copy. */}
      <div className="bg-white dark:bg-gray-800 rounded-[15px] p-8 sm:p-10 w-full max-w-lg border-[0.5px] border-black/[0.26] dark:border-gray-700 shadow-[0px_-8px_37.4px_5px_rgba(0,0,0,0.1)] dark:shadow-black/40">
        {/* The product mark — the same asset as the browser-tab favicon, the
            only logo this app ships. The wordmark beside it is aria-hidden so
            the name is announced once, by the image's alt, instead of twice. */}
        <div className="flex items-center gap-2 mb-5">
          <img
            src="/assets/img/favico.png"
            alt="KaiSpace"
            width={32}
            height={32}
            className="w-8 h-8 object-contain"
          />
          <span aria-hidden="true" className="text-lg font-semibold text-gray-900 dark:text-white">KaiSpace</span>
        </div>
        <h1 className="font-login-heading text-[36px] leading-[1.2] font-bold tracking-[-1.44px] text-black dark:text-white mb-6">
          {mode === 'login' ? 'Welcome to KaiSpace' : mode === 'createOrg' ? 'Buat organisasi baru' : 'Create your KaiSpace account'}
        </h1>

        {sessionExpiredMessage && (
          <div className="font-login-body bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-xs rounded-lg px-3 py-2 mb-4">
            {sessionExpiredMessage}
          </div>
        )}

        {error && (
          <div className="font-login-body bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-xs rounded-lg px-3 py-2 mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="font-login-body space-y-5">
          {mode === 'createOrg' && (
            <label className="block">
              <span className="block text-sm font-semibold text-login-text-strong dark:text-gray-200 mb-1.5">Nama organisasi</span>
              <input
                type="text" value={orgName} onChange={(e) => setOrgName(e.target.value)}
                placeholder="mis. Acme Corp"
                maxLength={80} required autoFocus
                className="w-full bg-login-surface dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-login-text-placeholder dark:placeholder-gray-500 rounded-login px-4 py-3 outline-none border border-login-text-placeholder dark:border-gray-600 focus:border-login-accent transition-colors text-sm"
              />
            </label>
          )}
          <label className="block">
            <span className="block text-sm font-semibold text-login-text-strong dark:text-gray-200 mb-1.5">Email</span>
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="commitcommunity@gmail.com" required autoFocus
              className="w-full bg-login-surface dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-login-text-placeholder dark:placeholder-gray-500 rounded-login px-4 py-3 outline-none border border-login-text-placeholder dark:border-gray-600 focus:border-login-accent transition-colors text-sm"
            />
          </label>
          <label className="block">
            <span className="block text-sm font-semibold text-login-text-strong dark:text-gray-200 mb-1.5">Password</span>
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••" required minLength={6}
              className="w-full bg-login-surface dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-login-text-placeholder dark:placeholder-gray-500 rounded-login px-4 py-3 outline-none border border-login-text-placeholder dark:border-gray-600 focus:border-login-accent transition-colors text-sm"
            />
          </label>
          {(mode === 'register' || mode === 'createOrg') && (
            <label className="block">
              <span className="block text-sm font-semibold text-login-text-strong dark:text-gray-200 mb-1.5">Display name</span>
              <input
                type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Nama tampilanmu" required maxLength={30}
                className="w-full bg-login-surface dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-login-text-placeholder dark:placeholder-gray-500 rounded-login px-4 py-3 outline-none border border-login-text-placeholder dark:border-gray-600 focus:border-login-accent transition-colors text-sm"
              />
            </label>
          )}

          <div className="space-y-3 pt-1">
            <label className="flex items-start gap-2 cursor-pointer">
              <SquareCheckbox checked={agreedToTerms} onChange={setAgreedToTerms} />
              <span className="text-sm leading-snug text-login-text-muted dark:text-gray-400">
                By signing up, you are creating a KAISPACE account, and you agree to KAISPACE&apos;s{' '}
                <span className="text-login-accent dark:text-purple-400 font-semibold" title="Segera hadir">Term of Use</span>
                {' '}and{' '}
                <span className="text-login-accent dark:text-purple-400 font-semibold" title="Segera hadir">Privacy Policy</span>.
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <SquareCheckbox checked={rememberMe} onChange={setRememberMe} />
              <span className="text-sm leading-snug text-login-text-muted dark:text-gray-400">
                Remember Me as <span className="font-semibold text-login-text-strong dark:text-gray-300">Member</span> of <span className="font-semibold text-login-text-strong dark:text-gray-300">KAISPACE</span>.
              </span>
            </label>
          </div>

          <button
            type="submit" disabled={loading}
            className="w-full bg-login-accent hover:brightness-110 disabled:opacity-50 text-white font-semibold rounded-login py-3 tracking-[-0.16px] transition-all text-base cursor-pointer"
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
            <div className="flex items-center gap-2 my-5">
              <span className="flex-1 h-px bg-login-border-soft dark:bg-gray-700" />
              <span className="font-login-body text-login-text-muted dark:text-gray-500 text-xs">OR</span>
              <span className="flex-1 h-px bg-login-border-soft dark:bg-gray-700" />
            </div>
            <a
              href={googleEnabled ? '/api/auth/google/login' : undefined}
              aria-disabled={!googleEnabled}
              title={googleEnabled ? undefined : 'Segera hadir'}
              className={`font-login-body flex items-center justify-center gap-1.5 bg-white dark:bg-gray-700 border border-login-border-soft dark:border-gray-600 text-login-text-muted dark:text-gray-200 font-medium rounded-login py-2.5 px-1 transition-colors text-sm ${
                googleEnabled
                  ? 'hover:bg-login-surface dark:hover:bg-gray-600 cursor-pointer'
                  : 'opacity-40 cursor-not-allowed pointer-events-none'
              }`}
            >
              <GoogleIcon /> Login with Google
            </a>
          </>
        )}

        {mode !== 'createOrg' && (
          <p className="font-login-body text-login-text-muted dark:text-gray-400 text-sm text-center mt-5">
            {mode === 'login' ? "Don't have account?" : 'Already have an account?'}{' '}
            <button
              onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
              className="text-login-accent dark:text-purple-400 font-semibold hover:brightness-110 cursor-pointer"
            >
              {mode === 'login' ? 'Sign Up here!' : 'Sign in'}
            </button>
          </p>
        )}

        <p className="font-login-body text-login-text-muted dark:text-gray-400 text-sm text-center mt-2">
          {mode === 'createOrg' ? (
            <>
              Sudah punya akun?{' '}
              <button
                type="button"
                onClick={() => setMode('login')}
                className="text-login-accent dark:text-purple-400 font-semibold hover:brightness-110 cursor-pointer"
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
                className="text-login-accent dark:text-purple-400 font-semibold hover:brightness-110 cursor-pointer"
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
