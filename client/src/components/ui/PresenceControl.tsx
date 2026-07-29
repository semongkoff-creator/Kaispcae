import { useEffect, useRef, useState } from 'react';
import type { WorkMode } from '@virtualmeet/shared';
import { useGameStore } from '@/stores/gameStore';
import { PRESENCE_LABEL, PRESENCE_EMOJI, MANUAL_STATUSES } from '@/data/presence';

// Bug 15 — single status system. The EFFECTIVE status (workMode: auto
// 'in_meeting'/'focus' while inside a zone, else the manual pick) is already
// shown on the badge over the avatar and in the Participant panel. This control
// is now just the MANUAL picker, living in the Sidebar rail — the old separate
// top-left box is gone. The manual choice stays editable at all times: changing
// it while inside a zone simply sets what you'll return to when you leave (no
// lock, no "leave the zone first" message).
export function PresenceControl() {
  const workMode = useGameStore((s) => s.workMode);
  const manualStatus = useGameStore((s) => s.manualStatus);
  const setManualStatus = useGameStore((s) => s.setManualStatus);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape. Capture phase so a parent that stops
  // mousedown propagation can't swallow it (same pattern as the attach menu).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const auto = workMode === 'in_meeting' || workMode === 'focus';
  const glyph = (m: WorkMode) => (m === 'available' ? '🟢' : PRESENCE_EMOJI[m]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={`Status: ${PRESENCE_LABEL[workMode]}`}
        className="w-8 h-8 rounded-lg flex items-center justify-center text-base transition-all cursor-pointer text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-gray-700"
      >
        <span>{glyph(workMode)}</span>
      </button>

      {open && (
        <div
          className="absolute top-0 left-full ml-2 w-56 bg-white dark:bg-gray-800 rounded-xl border border-purple-100 dark:border-gray-700 shadow-xl p-2 z-40"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {auto && (
            <p className="text-[11px] text-gray-500 dark:text-gray-400 px-2 py-1.5 leading-relaxed">
              Sekarang <span className="font-medium">{PRESENCE_LABEL[workMode]}</span> otomatis dari zona. Pilihan di bawah dipakai lagi begitu kamu keluar zona.
            </p>
          )}
          {MANUAL_STATUSES.map((st) => (
            <button
              key={st}
              onClick={() => { setManualStatus(st); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left cursor-pointer ${
                manualStatus === st
                  ? 'bg-purple-50 dark:bg-gray-700 text-purple-700 dark:text-purple-200'
                  : 'hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-200'
              }`}
            >
              <span>{glyph(st)}</span> {PRESENCE_LABEL[st]}
              {manualStatus === st && <span className="ml-auto text-[10px] text-purple-500">dipilih</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
