import { useState } from 'react';
import { PersonPlusFill, XLg, Clipboard } from 'react-bootstrap-icons';
import { adminApi } from './api';

// Fase 5 (org-resolution) — the client-side counterpart to
// POST /admin/org-invites. Same "generate a link, admin copies and shares
// it themselves" delivery as the existing Guest Link feature
// (App.tsx's handleCreateGuestLink) — this codebase has no email-sending
// infrastructure, so there's no "send" step, only "copy".
export function InviteMemberModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) { setError('Email wajib diisi'); return; }
    setBusy(true);
    setError('');
    try {
      const invite = await adminApi.createOrgInvite(trimmed, role);
      setLink(`${window.location.origin}/?orgInvite=${encodeURIComponent(invite.token!)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal membuat undangan');
    } finally {
      setBusy(false);
    }
  };

  const copyLink = () => {
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onMouseDown={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-purple-100 dark:border-gray-700 w-full max-w-sm p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100 inline-flex items-center gap-1.5">
            <PersonPlusFill size={14} className="text-purple-500" /> Undang anggota
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer">
            <XLg size={16} />
          </button>
        </div>

        {link ? (
          <>
            <p className="text-sm text-gray-700 dark:text-gray-200 mb-3">
              Undangan dibuat. Kirim link ini ke orang yang diundang — berlaku 7 hari.
            </p>
            <div className="flex items-center gap-2 mb-4">
              <input
                readOnly
                value={link}
                onFocus={(e) => e.target.select()}
                className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-700 dark:text-gray-200 text-xs truncate"
              />
              <button
                onClick={copyLink}
                className="shrink-0 px-2.5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium cursor-pointer inline-flex items-center gap-1"
              >
                <Clipboard size={12} /> {copied ? 'Tersalin' : 'Salin'}
              </button>
            </div>
            <button
              onClick={onClose}
              className="w-full py-2 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-sm font-medium cursor-pointer"
            >
              Tutup
            </button>
          </>
        ) : (
          <>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email orang yang diundang"
              autoFocus
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 text-sm mb-2 focus:outline-none focus:ring-1 focus:ring-purple-400"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'member' | 'admin')}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm mb-2 cursor-pointer"
            >
              <option value="member">Anggota</option>
              <option value="admin">Admin</option>
            </select>
            {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
            <div className="flex gap-2 mt-2">
              <button
                onClick={onClose}
                disabled={busy}
                className="flex-1 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-sm font-medium cursor-pointer disabled:opacity-50"
              >
                Batal
              </button>
              <button
                onClick={submit}
                disabled={busy || !email.trim()}
                className="flex-1 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-medium cursor-pointer"
              >
                {busy ? 'Membuat…' : 'Buat undangan'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
