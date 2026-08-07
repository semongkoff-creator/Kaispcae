import { useState } from 'react';
import { FlagFill, XLg } from 'react-bootstrap-icons';
import { api } from '@/services/api';

// Item 13, "Panic/report user" — the reason-entry step for
// ParticipantPanel.tsx's "Laporkan" action. Deliberately its own small
// modal rather than window.prompt(): a report reason is exactly the kind
// of multi-sentence input a single-line prompt reads poorly for.
export function ReportUserModal({
  target, roomSlug, onClose,
}: {
  target: { userId: string; name: string };
  roomSlug: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const submit = async () => {
    const trimmed = reason.trim();
    if (!trimmed) { setError('Alasan wajib diisi'); return; }
    setBusy(true);
    setError('');
    try {
      await api.reportUser(target.userId, trimmed, roomSlug);
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal mengirim laporan');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onMouseDown={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-red-100 dark:border-gray-700 w-full max-w-sm p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100 inline-flex items-center gap-1.5">
            <FlagFill size={14} className="text-red-500" /> Laporkan {target.name}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer">
            <XLg size={16} />
          </button>
        </div>

        {sent ? (
          <>
            <p className="text-sm text-gray-700 dark:text-gray-200 mb-4">
              Laporan terkirim ke admin. Mereka akan menindaklanjuti secara manual.
            </p>
            <button
              onClick={onClose}
              className="w-full py-2 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-sm font-medium cursor-pointer"
            >
              Tutup
            </button>
          </>
        ) : (
          <>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Jelaskan perilaku yang kamu laporkan. Admin akan mendapat notifikasi dan menindaklanjuti secara manual — laporan
              ini tidak otomatis membatasi akun siapa pun.
            </p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
              rows={4}
              placeholder="Contoh: mengganggu terus-menerus di chat, ucapan tidak pantas..."
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-red-400 mb-2"
              autoFocus
            />
            {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
            <div className="flex gap-2">
              <button
                onClick={onClose}
                disabled={busy}
                className="flex-1 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-sm font-medium cursor-pointer disabled:opacity-50"
              >
                Batal
              </button>
              <button
                onClick={submit}
                disabled={busy || !reason.trim()}
                className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium cursor-pointer"
              >
                {busy ? 'Mengirim…' : 'Kirim laporan'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
