import { useState, FormEvent } from 'react';
import { api } from '@/services/api';

export interface GuestSession {
  token: string;
  roomSlug: string;
  roomName: string;
  name: string;
}

interface GuestEntryProps {
  inviteToken: string;
  onEntered: (session: GuestSession) => void;
}

// Guest Link & Ruang Tunggu — the ONE screen an unauthenticated invite-link
// visitor sees before entering: no email/password, just a name. Renders
// INSTEAD of LoginPage (see App.tsx's MainApp, which checks for a pending
// guest invite token before ever reaching the `!user` gate).
export function GuestEntry({ inviteToken, onEntered }: GuestEntryProps) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      const session = await api.guestJoin(inviteToken, trimmed);
      onEntered(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal bergabung sebagai tamu.');
      setLoading(false);
    }
  };

  return (
    <div className="w-screen h-screen bg-gradient-to-br from-white to-purple-50 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center px-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl p-6 shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 w-full max-w-sm">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Masuk sebagai Tamu</h1>
        <p className="text-gray-500 dark:text-gray-400 text-sm mb-4">
          Anda diundang untuk bergabung. Masukkan nama Anda untuk melanjutkan — admin akan menyetujui sebelum Anda masuk.
        </p>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nama Anda"
            maxLength={40}
            autoFocus
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-purple-400"
          />
          {error && <p className="text-red-500 dark:text-red-400 text-xs mb-3">{error}</p>}
          <button
            type="submit"
            disabled={loading || !name.trim()}
            className="w-full px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium cursor-pointer"
          >
            {loading ? 'Memproses…' : 'Gabung'}
          </button>
        </form>
      </div>
    </div>
  );
}
