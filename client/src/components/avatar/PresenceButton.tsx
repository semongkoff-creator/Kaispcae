import { useRef, useEffect } from 'react';
import { CircleFill } from 'react-bootstrap-icons';
import { MANUAL_STATUSES, ManualStatus, PRESENCE_LABEL, PRESENCE_EMOJI } from '@/data/presence';

interface PresenceButtonProps {
  manualStatus: ManualStatus;
  // 'away' is handled by the caller (opens the Away-reason popup instead of
  // applying immediately) — every other status applies straight away, no
  // reason needed (see App.tsx's handlePresencePick).
  onPick: (status: ManualStatus) => void;
  // Bug panel numpuk — open/onToggle now come from the parent (App.tsx,
  // backed by activePanel === 'status'), same controlled shape as
  // ActivityFeed. This used to own an independent useState(false), closed
  // only by its own outside-click listener below — confirmed live stacking
  // behind/alongside Room Features (or any other panel): opening one never
  // closed the other. onToggle is reused for the outside-click dismissal
  // too (it's a toggle, and this dropdown is only ever mounted while it's
  // already open, so calling it there always means "close").
  open: boolean;
  onToggle: () => void;
  variant?: 'sidebar';
}

// Fitur 3B — the manual presence picker. MANUAL_STATUSES/PRESENCE_LABEL/
// PRESENCE_EMOJI (client/data/presence.ts) drive both this dropdown and the
// avatar/participant-list badges, so every surface renders the same
// label/emoji per status. Absorbed the old free-text Custom Status feature's
// quick-pick presets (WFH/Focus/In a meeting/Break) as real entries here.
export function PresenceButton({ manualStatus, onPick, open, onToggle, variant = 'sidebar' }: PresenceButtonProps) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onToggle();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open, onToggle]);

  const isSidebar = variant === 'sidebar';

  return (
    <div ref={wrapRef} className={isSidebar ? 'relative' : ''}>
      <button
        onClick={onToggle}
        title={PRESENCE_LABEL[manualStatus]}
        className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
          manualStatus !== 'available' ? 'bg-purple-50 dark:bg-gray-700' : 'hover:bg-purple-50 dark:hover:bg-gray-700'
        } text-purple-700 dark:text-purple-300`}
      >
        {manualStatus === 'available' ? <CircleFill size={10} className="text-green-500" /> : <span className="text-xs leading-none">{PRESENCE_EMOJI[manualStatus]}</span>}
      </button>

      {open && (
        <div
          className="absolute top-0 left-full ml-2 w-44 bg-white dark:bg-gray-800 rounded-xl border border-purple-100 dark:border-gray-700 shadow-xl p-2 z-40"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <p className="text-gray-500 dark:text-gray-400 text-[10px] uppercase tracking-wider mb-1 px-1">Status</p>
          {MANUAL_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => { onPick(s); onToggle(); }}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-left cursor-pointer ${
                manualStatus === s ? 'bg-purple-600 text-white' : 'text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-700'
              }`}
            >
              <span className="w-4 text-center shrink-0">{s === 'available' ? '🟢' : PRESENCE_EMOJI[s]}</span>
              {PRESENCE_LABEL[s]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
