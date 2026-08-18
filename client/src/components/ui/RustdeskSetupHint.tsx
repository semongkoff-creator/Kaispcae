import { useState } from 'react';
import { XLg, ClipboardCheck, Clipboard, Display } from 'react-bootstrap-icons';

// One-time RustDesk client config (ID Server / Relay Server / Key) that
// every user needs to paste into RustDesk's own Settings -> Network once,
// so "Minta Bantuan Remote" sessions resolve through a server both sides
// can actually reach — see .env.example's own doc comment for why this is
// env-configured rather than hardcoded. Renders nothing if unset (same
// "degrades cleanly, optional" convention as VITE_TURN_URL).
//
// This is pure reference text — KaiSpace never applies this config to
// RustDesk itself (there's no API for that in the self-hosted, non-Pro
// version); the user still does the paste manually, this just removes the
// error-prone "retype a 44-character key by hand" step via copy buttons.
const ID_SERVER = import.meta.env.VITE_RUSTDESK_ID_SERVER as string | undefined;
const RELAY_SERVER = import.meta.env.VITE_RUSTDESK_RELAY_SERVER as string | undefined;
const KEY = import.meta.env.VITE_RUSTDESK_KEY as string | undefined;

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }}
      className="w-full flex items-center justify-between gap-3 text-left px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors cursor-pointer"
    >
      <span className="min-w-0">
        <span className="block text-[11px] text-gray-500 dark:text-gray-400">{label}</span>
        {/* break-all, not truncate — the whole point of this popup (vs. the
            cramped inline version it replaced) is that a 44-character key
            must stay fully visible, not cut off. */}
        <span className="block font-mono text-xs text-gray-800 dark:text-gray-100 break-all">{value}</span>
      </span>
      {copied ? (
        <ClipboardCheck size={16} className="text-emerald-500 shrink-0" />
      ) : (
        <Clipboard size={16} className="text-gray-400 shrink-0" />
      )}
    </button>
  );
}

// Bug fix — this used to be a collapsible section rendered INLINE inside
// the (narrow, w-72) credential form/display panels, which cut off the
// 44-character key and left everything cramped. Now a real popup —
// separate from and layered above whichever narrow panel the trigger link
// sits in (z-[200], same layer as GlobalModal, so it always renders on top
// rather than being squeezed into the panel that opened it).
export function RustdeskSetupHint() {
  const [open, setOpen] = useState(false);
  if (!ID_SERVER && !RELAY_SERVER && !KEY) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-[11px] text-purple-600 dark:text-purple-400 font-medium underline decoration-dotted cursor-pointer"
      >
        Belum atur RustDesk ke server sendiri?
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onMouseDown={() => setOpen(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-purple-100 dark:border-gray-700 w-full max-w-sm p-5"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="flex items-center gap-2 text-sm font-bold text-gray-900 dark:text-gray-100">
                <Display size={15} className="text-purple-600 dark:text-purple-400" />
                Setup RustDesk (sekali saja)
              </h2>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer">
                <XLg size={16} />
              </button>
            </div>
            <p className="text-xs text-gray-600 dark:text-gray-300 mb-4 leading-relaxed">
              Buka RustDesk → Settings → Network, isi 3 nilai di bawah, lalu Simpan. Klik tiap baris untuk copy.
            </p>
            <div className="flex flex-col gap-2">
              {ID_SERVER && <CopyRow label="ID Server" value={ID_SERVER} />}
              {RELAY_SERVER && <CopyRow label="Relay Server" value={RELAY_SERVER} />}
              {KEY && <CopyRow label="Key" value={KEY} />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
