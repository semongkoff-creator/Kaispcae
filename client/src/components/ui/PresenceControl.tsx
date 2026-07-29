import { useState } from 'react';
import { useGameStore } from '@/stores/gameStore';
import { PRESENCE_LABEL, PRESENCE_EMOJI, MANUAL_STATUSES } from '@/data/presence';

// A11 — HUD presence control near the local user. Shows the current effective
// status and lets the user pick a MANUAL one (Available/Lunch/Away). While the
// status is auto (in a meeting/focus zone) the manual options are locked — the
// zone decides — with a short note explaining why. The actual broadcast is
// driven by the presence effect in App (which watches manualStatus + zone).
export function PresenceControl() {
  const workMode = useGameStore((s) => s.workMode);
  const manualStatus = useGameStore((s) => s.manualStatus);
  const setManualStatus = useGameStore((s) => s.setManualStatus);
  const [open, setOpen] = useState(false);

  const auto = workMode === 'in_meeting' || workMode === 'focus';
  const glyph = (m: typeof workMode) => (m === 'available' ? '🟢' : PRESENCE_EMOJI[m]);

  return (
    <div className="absolute top-4 left-16 z-40 pointer-events-auto text-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Status kehadiran"
        className="inline-flex items-center gap-1.5 bg-white/90 dark:bg-gray-800/90 backdrop-blur border border-purple-100 dark:border-gray-700 rounded-full px-3 py-1.5 shadow cursor-pointer text-gray-800 dark:text-gray-100"
      >
        <span>{glyph(workMode)}</span>
        <span className="font-medium">{PRESENCE_LABEL[workMode]}</span>
      </button>

      {open && (
        <div className="mt-1 w-56 rounded-lg bg-white dark:bg-gray-800 border border-purple-100 dark:border-gray-700 shadow-xl p-1">
          {auto ? (
            <p className="text-[11px] text-gray-500 dark:text-gray-400 px-2 py-1.5 leading-relaxed">
              Status <span className="font-medium">{PRESENCE_LABEL[workMode]}</span> otomatis dari zona. Keluar dari zona meeting/focus dulu untuk mengubah status manual.
            </p>
          ) : (
            MANUAL_STATUSES.map((st) => (
              <button
                key={st}
                onClick={() => { setManualStatus(st); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left cursor-pointer ${
                  manualStatus === st ? 'bg-purple-50 dark:bg-gray-700 text-purple-700 dark:text-purple-200' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-200'
                }`}
              >
                <span>{glyph(st)}</span> {PRESENCE_LABEL[st]}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
