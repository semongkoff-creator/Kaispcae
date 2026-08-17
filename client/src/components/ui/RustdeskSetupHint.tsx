import { useState } from 'react';
import { ChevronDown, ChevronUp, ClipboardCheck, Clipboard } from 'react-bootstrap-icons';

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
      className="w-full flex items-center justify-between gap-2 text-left"
    >
      <span className="min-w-0">
        <span className="block text-[10px] text-gray-500 dark:text-gray-400">{label}</span>
        <span className="block font-mono text-[11px] text-gray-800 dark:text-gray-100 truncate">{value}</span>
      </span>
      {copied ? (
        <ClipboardCheck size={13} className="text-emerald-500 shrink-0" />
      ) : (
        <Clipboard size={13} className="text-gray-400 shrink-0" />
      )}
    </button>
  );
}

export function RustdeskSetupHint() {
  const [open, setOpen] = useState(false);
  if (!ID_SERVER && !RELAY_SERVER && !KEY) return null;

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 pt-2 mt-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-purple-600 dark:text-purple-400 font-medium cursor-pointer"
      >
        {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        Belum atur RustDesk ke server sendiri?
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2 bg-gray-50 dark:bg-gray-800/60 rounded-lg p-2.5">
          <p className="text-[10px] text-gray-500 dark:text-gray-400 leading-snug">
            Sekali saja: buka RustDesk → Settings → Network, isi 3 nilai ini, lalu Simpan. Klik tiap baris untuk copy.
          </p>
          {ID_SERVER && <CopyRow label="ID Server" value={ID_SERVER} />}
          {RELAY_SERVER && <CopyRow label="Relay Server" value={RELAY_SERVER} />}
          {KEY && <CopyRow label="Key" value={KEY} />}
        </div>
      )}
    </div>
  );
}
