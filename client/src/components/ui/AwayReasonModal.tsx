import { useEffect, useState } from 'react';
import { AWAY_REASON_MAX_LENGTH, AWAY_REASON_PROMPT_TIMEOUT_MS } from '@kaispace/shared';

interface AwayReasonModalProps {
  open: boolean;
  // Called exactly once per open with the chosen reason, or undefined if the
  // user picked "Lainnya" with no text, or the prompt timed out — a timeout
  // is a deliberate non-blocking default (poin 10): someone who's genuinely
  // AFK won't come back to answer this, so it must resolve on its own rather
  // than sit open forever.
  onResolve: (reason?: string) => void;
}

const QUICK_REASONS = ['External Meeting', 'Makan'];

export function AwayReasonModal({ open, onResolve }: AwayReasonModalProps) {
  const [customText, setCustomText] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);

  useEffect(() => {
    if (!open) {
      setCustomText('');
      setShowCustomInput(false);
      return;
    }
    const timer = setTimeout(() => onResolve(undefined), AWAY_REASON_PROMPT_TIMEOUT_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-arm only on open/close, not on every onResolve identity change
  }, [open]);

  if (!open) return null;

  return (
    // z-[70] — above everything else in the HUD (Summon/Follow toasts sit at
    // z-50, the Soundboard/emote overlays at z-60) since this is a blocking
    // decision, not a passive notification.
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-5 w-80 border border-purple-100 dark:border-gray-700">
        <p className="text-gray-900 dark:text-gray-100 text-sm font-semibold mb-1">🌙 Kamu sepertinya away</p>
        <p className="text-gray-400 dark:text-gray-500 text-[11px] mb-3">
          Kenapa? (tidak dijawab dalam {AWAY_REASON_PROMPT_TIMEOUT_MS / 1000} detik akan otomatis diset Away)
        </p>
        <div className="flex flex-col gap-1.5">
          {QUICK_REASONS.map((reason) => (
            <button
              key={reason}
              onClick={() => onResolve(reason)}
              className="w-full text-left px-3 py-2 rounded-lg bg-purple-50 dark:bg-gray-700 text-purple-700 dark:text-purple-300 text-xs hover:bg-purple-100 dark:hover:bg-gray-600 cursor-pointer"
            >
              {reason}
            </button>
          ))}
          {!showCustomInput ? (
            <button
              onClick={() => setShowCustomInput(true)}
              className="w-full text-left px-3 py-2 rounded-lg bg-purple-50 dark:bg-gray-700 text-purple-700 dark:text-purple-300 text-xs hover:bg-purple-100 dark:hover:bg-gray-600 cursor-pointer"
            >
              Lainnya…
            </button>
          ) : (
            <div className="flex gap-1.5">
              <input
                autoFocus
                value={customText}
                onChange={(e) => setCustomText(e.target.value.slice(0, AWAY_REASON_MAX_LENGTH))}
                onKeyDown={(e) => e.key === 'Enter' && onResolve(customText.trim() || undefined)}
                placeholder="Alasan singkat"
                className="flex-1 bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 text-xs rounded-lg px-3 py-2 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500"
              />
              <button
                onClick={() => onResolve(customText.trim() || undefined)}
                className="px-3 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium cursor-pointer"
              >
                OK
              </button>
            </div>
          )}
        </div>
        <button
          onClick={() => onResolve(undefined)}
          className="w-full mt-3 text-center text-gray-400 dark:text-gray-500 text-[11px] hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
