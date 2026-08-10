import { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronUp, Check, MicFill, VolumeUpFill, CameraVideoFill } from 'react-bootstrap-icons';
import { webrtcService } from '@/services/webrtcService';

// The little caret that sits next to the Mic / Camera buttons and opens a
// device picker — the same affordance Zoom/Meet/Zep use. 'audio' lists both
// microphones and speakers (input + output live together, as in the reference
// design); 'video' lists cameras. Selection is applied immediately via
// webrtcService and remembered there (localStorage), so this component holds
// no source of truth of its own beyond what it last read.
interface DeviceMenuProps {
  kind: 'audio' | 'video';
}

interface Group {
  label: string;
  icon: React.ReactNode;
  devices: MediaDeviceInfo[];
  selectedId: string | null;
  onPick: (id: string) => void;
  fallbackName: string;
}

export function DeviceMenu({ kind }: DeviceMenuProps) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const { mics, cameras, speakers } = await webrtcService.listDevices();
    const sel = webrtcService.getSelectedDevices();
    if (kind === 'audio') {
      setGroups([
        {
          label: 'Mikrofon', icon: <MicFill size={11} />, devices: mics,
          selectedId: sel.micId, fallbackName: 'Mikrofon',
          onPick: (id) => webrtcService.switchMic(id),
        },
        {
          label: 'Speaker', icon: <VolumeUpFill size={11} />, devices: speakers,
          selectedId: sel.speakerId, fallbackName: 'Speaker',
          onPick: (id) => webrtcService.switchSpeaker(id),
        },
      ]);
    } else {
      setGroups([
        {
          label: 'Kamera', icon: <CameraVideoFill size={11} />, devices: cameras,
          selectedId: sel.cameraId, fallbackName: 'Kamera',
          onPick: (id) => webrtcService.switchCamera(id),
        },
      ]);
    }
  }, [kind]);

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
    // self-center: this sits next to the 44px main buttons as a deliberately
    // smaller "mini circle" utility control (device picker, not a primary
    // action) — self-center keeps it vertically centered in the toolbar row
    // regardless of the row's own stretch behavior.
    <div className="relative self-center" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center w-5 h-5 rounded-full bg-white/90 dark:bg-gray-800/90 backdrop-blur-xl border border-purple-200/60 dark:border-white/10 shadow-lg shadow-purple-500/10 transition-all hover:scale-105 cursor-pointer text-purple-700 dark:text-purple-300"
        title={kind === 'audio' ? 'Pilih mikrofon / speaker' : 'Pilih kamera'}
      >
        <ChevronUp size={10} />
      </button>

      {open && (
        // bottom-full instead of a fixed bottom-11 — that pixel value
        // assumed the old h-9 trigger's height; bottom-full anchors off
        // this button's OWN box regardless of its (now smaller) size.
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-64 max-h-80 overflow-y-auto bg-white dark:bg-gray-800 border border-purple-100 dark:border-gray-700 rounded-lg shadow-xl py-1 z-[60]">
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
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 dark:text-gray-200 hover:bg-purple-50 dark:hover:bg-gray-700 cursor-pointer"
                  >
                    <span className="w-3.5 shrink-0 text-purple-600 dark:text-purple-300">
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
