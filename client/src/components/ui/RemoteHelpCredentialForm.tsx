import { useState } from 'react';
import { Display } from 'react-bootstrap-icons';

interface RemoteHelpCredentialFormProps {
  helperName: string;
  onSubmit: (credential: string) => void;
  // Final-review Fix 3 — authoritative "the server actually relayed this to
  // the helper" signal (REMOTE_HELP_CREDENTIAL_ACK), NOT a local "I clicked
  // submit" flag. The server has several silent early-return paths (no
  // active session, empty credential, unroutable helper) — a "Terkirim"
  // confirmation that fires on click alone would lie about delivery in
  // exactly those cases.
  acked: boolean;
}

// Shown ONLY to the target, once, right after they approve a remote-help
// request. This is the entire "KaiSpace as a door" mechanism: KaiSpace
// never generates or knows a RustDesk ID/password — the target types their
// own in here, it is relayed to the helper exactly once, and this
// component's own local state is the only place it ever lives client-side
// (never localStorage/sessionStorage — see the design spec's Security
// section). The field clears itself immediately after submit.
export function RemoteHelpCredentialForm({ helperName, onSubmit, acked }: RemoteHelpCredentialFormProps) {
  const [value, setValue] = useState('');
  // Purely a local "I already clicked submit" flag for an immediate
  // "Mengirim…" pending indicator between click and the server's ack — the
  // real "Terkirim" confirmation below is gated on `acked`, not this.
  const [sent, setSent] = useState(false);

  if (acked) {
    return (
      <div className="fixed top-32 right-4 z-50 w-72 bg-white/95 dark:bg-gray-900/95 rounded-xl shadow-lg px-3.5 py-3 text-xs text-gray-600 dark:text-gray-300">
        Terkirim ke {helperName}.
      </div>
    );
  }

  if (sent) {
    return (
      <div className="fixed top-32 right-4 z-50 w-72 bg-white/95 dark:bg-gray-900/95 rounded-xl shadow-lg px-3.5 py-3 text-xs text-gray-600 dark:text-gray-300">
        Mengirim…
      </div>
    );
  }

  return (
    <div className="fixed top-32 right-4 z-50 w-72 bg-white/95 dark:bg-gray-900/95 rounded-xl shadow-lg px-3.5 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs font-semibold text-gray-800 dark:text-gray-100">
        <Display size={14} className="text-purple-600 dark:text-purple-400" />
        Buka RustDesk, kirim ID+password kamu
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="mis. 123 456 789  password"
        className="w-full px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs text-gray-800 dark:text-gray-100 outline-none focus:border-purple-400"
      />
      <button
        onClick={() => {
          if (!value.trim()) return;
          onSubmit(value.trim());
          setValue('');
          setSent(true);
        }}
        className="self-end px-3 py-1 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium cursor-pointer transition-colors"
      >
        Kirim
      </button>
    </div>
  );
}
