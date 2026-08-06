import { LOGIN_STATUSES, PRESENCE_LABEL, PRESENCE_EMOJI } from '@/data/presence';
import type { ManualStatus } from '@/data/presence';

const STATUS_DESCRIPTION: Record<(typeof LOGIN_STATUSES)[number], string> = {
  wfo: 'Kerja dari kantor',
  wfh: 'Kerja dari rumah',
  wfa: 'Kerja dari mana saja',
  cuti: 'Sedang cuti hari ini',
  in_meeting: 'Langsung meeting',
};

interface StatusPickModalProps {
  onPick: (status: ManualStatus) => void;
}

// QA #1 — "Set status saat login": every session start, before entering the
// room, pick one of WFO/WFH/WFA/Cuti/Meeting. Feeds gameStore's manualStatus
// directly (see App.tsx's caller) — the existing zone-vs-manual effect inside
// Game (App.tsx's workMode useEffect) picks it up and broadcasts it the
// moment the socket connects, same as any other manual status change.
export function StatusPickModal({ onPick }: StatusPickModalProps) {
  return (
    <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700 w-full max-w-sm p-6">
        <div className="text-4xl text-center mb-2">👋</div>
        <h2 className="text-lg font-bold text-center text-gray-900 dark:text-gray-100 mb-1">Status kamu hari ini?</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 text-center mb-5">Bisa diganti kapan saja lewat ikon status di sidebar.</p>

        <div className="flex flex-col gap-2">
          {LOGIN_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => onPick(s)}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-purple-300 dark:hover:border-purple-600 hover:bg-purple-50 dark:hover:bg-gray-700 text-left cursor-pointer transition-colors"
            >
              <span className="text-xl shrink-0">{PRESENCE_EMOJI[s]}</span>
              <span>
                <span className="block text-sm font-semibold text-gray-900 dark:text-gray-100">{PRESENCE_LABEL[s]}</span>
                <span className="block text-xs text-gray-500 dark:text-gray-400">{STATUS_DESCRIPTION[s]}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
