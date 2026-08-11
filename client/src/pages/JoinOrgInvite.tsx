import { useState, useEffect, FormEvent } from 'react';
import { api } from '@/services/api';

// Same asset LoginPage.tsx's own LarkIcon uses — duplicated locally rather
// than exported/shared, matching this codebase's established "small
// deliberate duplication for decoupling" precedent (see mediaHandler.ts/
// followHandler.ts's own doc comments on the same pattern).
function LarkIcon() {
  return <img src="/assets/img/lark-logo.png" alt="" width={16} height={16} className="object-contain" />;
}

// Same mark as LoginPage.tsx's own GoogleIcon, duplicated for the same
// reason as LarkIcon above.
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

interface JoinOrgInvitePreview {
  organizationName: string;
  email: string;
  role: string;
}

interface JoinOrgInviteProps {
  inviteToken: string;
  // Delegates the actual accept+login to whoever renders this (App.tsx,
  // wired to useAuth's acceptOrgInvite) — same "component owns the form,
  // caller owns the session" split as LoginPage's onLogin/onRegister props.
  onAccept: (password: string, displayName: string) => Promise<void>;
}

// Fase 5 (org-resolution) — the landing screen for an org-invite link
// (?orgInvite=<token>). Renders INSTEAD of LoginPage, same as GuestEntry
// does for a guest-link token (see App.tsx's MainApp, checked before the
// `!user` gate). Unlike GuestEntry this creates a REAL account, in the
// inviting org, not a guest session.
export function JoinOrgInvite({ inviteToken, onAccept }: JoinOrgInviteProps) {
  const [preview, setPreview] = useState<JoinOrgInvitePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Same fetched-not-hardcoded gate as LoginPage.tsx's Google button.
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getOrgInvite(inviteToken)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((err) => { if (!cancelled) setPreviewError(err instanceof Error ? err.message : 'Undangan tidak valid.'); });
    api.getAuthConfig()
      .then((c) => { if (!cancelled) setGoogleEnabled(c.googleEnabled); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [inviteToken]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = displayName.trim();
    if (!trimmedName || !password) return;
    setLoading(true);
    setError(null);
    try {
      await onAccept(password, trimmedName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal bergabung.');
      setLoading(false);
    }
  };

  return (
    <div className="w-screen h-screen bg-gradient-to-br from-white to-purple-50 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center px-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl p-6 shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 w-full max-w-sm">
        {previewError ? (
          <>
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Undangan tidak berlaku</h1>
            <p className="text-gray-500 dark:text-gray-400 text-sm">{previewError}</p>
          </>
        ) : !preview ? (
          <p className="text-gray-500 dark:text-gray-400 text-sm">Memuat undangan…</p>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Gabung ke {preview.organizationName}</h1>
            <p className="text-gray-500 dark:text-gray-400 text-sm mb-4">
              Anda diundang sebagai <span className="font-medium">{preview.email}</span>. Buat nama tampilan dan password untuk mulai.
            </p>
            <form onSubmit={handleSubmit}>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Nama tampilan"
                maxLength={30}
                autoFocus
                className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-purple-400"
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password (min. 6 karakter)"
                className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-purple-400"
              />
              {error && <p className="text-red-500 dark:text-red-400 text-xs mb-3">{error}</p>}
              <button
                type="submit"
                disabled={loading || !displayName.trim() || !password}
                className="w-full px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium cursor-pointer"
              >
                {loading ? 'Memproses…' : 'Gabung'}
              </button>
            </form>
            <div className="flex items-center gap-2 my-4">
              <span className="flex-1 h-px bg-purple-100 dark:bg-gray-700" />
              <span className="text-gray-400 dark:text-gray-500 text-[11px]">OR</span>
              <span className="flex-1 h-px bg-purple-100 dark:bg-gray-700" />
            </div>
            <div className={googleEnabled ? 'grid grid-cols-2 gap-2' : ''}>
              {googleEnabled && (
                <a
                  href={`/api/auth/google/login?orgInvite=${encodeURIComponent(inviteToken)}`}
                  className="flex items-center justify-center gap-1.5 bg-white dark:bg-gray-700 border border-purple-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-600 font-medium rounded-lg py-2.5 px-1 transition-colors text-[11px] cursor-pointer"
                >
                  <GoogleIcon /> Lanjut dengan Google
                </a>
              )}
              <a
                href={`/api/auth/lark/login?orgInvite=${encodeURIComponent(inviteToken)}`}
                className="flex items-center justify-center gap-1.5 bg-white dark:bg-gray-700 border border-purple-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-600 font-medium rounded-lg py-2.5 px-1 transition-colors text-[11px] cursor-pointer"
              >
                <LarkIcon /> Lanjut dengan Lark
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
