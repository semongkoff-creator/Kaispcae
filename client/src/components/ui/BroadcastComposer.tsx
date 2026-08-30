import { useEffect, useRef, useState } from 'react';
import { VolumeUpFill, XLg } from 'react-bootstrap-icons';

// Mirrors the server's own cap (roomHandler.ts's BROADCAST_SEND slices to
// 500). Enforced here too so the limit is visible while typing instead of
// silently truncating a message the sender thought went out whole.
const MAX_LENGTH = 500;

interface BroadcastComposerProps {
  onSend: (text: string) => void;
  onClose: () => void;
}

/**
 * Admin announcement composer.
 *
 * Replaces a bare showPrompt(), which gave no character budget against the
 * server's 500 cap and no sense of how the message would actually appear.
 * A running-text announcement goes out to everyone at once and can't be
 * recalled, so seeing it before sending matters more here than it does for
 * the app's other one-line prompts.
 */
export function BroadcastComposer({ onSend, onClose }: BroadcastComposerProps) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const trimmed = text.trim();
  const remaining = MAX_LENGTH - text.length;

  const send = () => {
    if (!trimmed) return;
    onSend(trimmed);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
      <div
        className="w-full max-w-lg bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Kirim pengumuman"
      >
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-gray-200 dark:border-gray-700">
          <VolumeUpFill size={16} className="text-teal-600 dark:text-teal-400" />
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex-1">Kirim Pengumuman</h2>
          <button
            onClick={onClose}
            aria-label="Tutup"
            className="p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
          >
            <XLg size={14} />
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Tampil sebagai teks berjalan di layar semua orang di room ini.
          </p>

          <textarea
            ref={inputRef}
            value={text}
            maxLength={MAX_LENGTH}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter for a deliberate line break. The
              // ticker renders on one line either way.
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            rows={3}
            placeholder="Contoh: Standup dimajukan ke jam 10.00 di Meeting Room A."
            className="w-full resize-none rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
          />

          <div className="flex items-center justify-between text-[11px]">
            <span className="text-gray-400">Enter kirim · Shift+Enter baris baru</span>
            <span className={remaining < 50 ? 'text-amber-600 dark:text-amber-400 font-medium tabular-nums' : 'text-gray-400 tabular-nums'}>
              {remaining} karakter tersisa
            </span>
          </div>

          {/* Preview — the same teal strip everyone else will see. Static
              here on purpose: this is for checking wording and length, and a
              looping animation inside a form is a distraction while typing. */}
          <div>
            <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400">Pratinjau</span>
            <div className="mt-1.5 rounded-lg bg-teal-600 text-white px-3 py-2 overflow-hidden">
              <div className="flex items-baseline gap-2.5 whitespace-nowrap overflow-hidden">
                <VolumeUpFill size={13} className="shrink-0 self-center" />
                <span className="text-[11px] font-medium uppercase tracking-wider opacity-75">Pengumuman</span>
                <span className="text-sm font-semibold truncate">
                  {trimmed || <span className="opacity-50">Pesan kamu akan berjalan di sini…</span>}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3.5 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 cursor-pointer"
          >
            Batal
          </button>
          <button
            onClick={send}
            disabled={!trimmed}
            className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            Kirim ke semua
          </button>
        </div>
      </div>
    </div>
  );
}
