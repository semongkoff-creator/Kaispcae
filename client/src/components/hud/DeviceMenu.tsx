import { useState, useEffect, useRef, useCallback } from 'react';
import { ThreeDotsVertical, Check, VolumeUpFill } from 'react-bootstrap-icons';
import { webrtcService } from '@/services/webrtcService';
import { Tooltip } from '@/components/ui/Tooltip';

// Speaker picker — Mic and Camera got their own DeviceCaret.tsx carets back
// (matching the reference design), so this ⋮ menu now only needs to cover
// Speaker, which has no dedicated toolbar button of its own to attach a
// caret to. Selection is applied immediately via webrtcService and
// remembered there, so this component holds no source of truth of its own
// beyond what it last read.
interface Group {
  label: string;
  icon: React.ReactNode;
  devices: MediaDeviceInfo[];
  selectedId: string | null;
  onPick: (id: string) => void;
  fallbackName: string;
}

export function DeviceMenu() {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const { speakers } = await webrtcService.listDevices();
    const sel = webrtcService.getSelectedDevices();
    setGroups([
      {
        label: 'Speaker', icon: <VolumeUpFill size={11} />, devices: speakers,
        selectedId: sel.speakerId, fallbackName: 'Speaker',
        onPick: (id) => webrtcService.switchSpeaker(id),
      },
    ]);
  }, []);

  // Enumerate only when the menu opens — the list is short-lived and device
  // labels can change (plugging in a headset), so a fresh read each time beats
  // a stale cached one.
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Close on outside click or Escape, like every other popover in the HUD.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = async (g: Group, id: string) => {
    await g.onPick(id);
    setOpen(false);
  };

  return (
    // Standalone toolbar control for Speaker only now — Mic/Camera moved to
    // their own DeviceCaret.tsx carets (see this file's header comment).
    <div className="relative" ref={ref}>
      <Tooltip
        label="Pilih Speaker"
        detail="Pilih speaker/output audio yang ingin dipakai."
      >
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center justify-center w-10 h-10 rounded-full bg-white/90 dark:bg-gray-800/90 backdrop-blur-xl border border-login-border-soft dark:border-white/10 shadow-lg shadow-purple-500/10 transition-all hover:scale-105 cursor-pointer text-login-accent dark:text-purple-300"
        >
          <ThreeDotsVertical size={16} />
        </button>
      </Tooltip>

      {open && (
        // bottom-full (not a fixed pixel offset) anchors off this button's
        // own box, so it stays correct regardless of the trigger's size.
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-64 max-h-80 overflow-y-auto bg-white dark:bg-gray-800 border border-login-border-soft dark:border-gray-700 rounded-lg shadow-xl py-1 z-[60]">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                {g.icon} {g.label}
              </div>
              {g.devices.length === 0 && (
                <div className="px-3 py-1.5 text-xs text-gray-400 dark:text-gray-500 italic">
                  Tidak ada perangkat
                </div>
              )}
              {g.devices.map((d, i) => {
                // Default is selected when nothing was explicitly chosen and
                // this is the system-default entry (empty id or the literal
                // 'default'), so the menu still shows a checkmark on join.
                const isSelected = g.selectedId
                  ? d.deviceId === g.selectedId
                  : (d.deviceId === 'default' || d.deviceId === '');
                return (
                  <button
                    key={d.deviceId || i}
                    onClick={() => pick(g, d.deviceId)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 dark:text-gray-200 hover:bg-login-surface dark:hover:bg-gray-700 cursor-pointer"
                  >
                    <span className="w-3.5 shrink-0 text-login-accent dark:text-purple-300">
                      {isSelected && <Check size={14} />}
                    </span>
                    <span className="truncate">{d.label || `${g.fallbackName} ${i + 1}`}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
