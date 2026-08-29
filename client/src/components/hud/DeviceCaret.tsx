import { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronDown, Check } from 'react-bootstrap-icons';
import { webrtcService } from '@/services/webrtcService';
import { Tooltip } from '@/components/ui/Tooltip';

interface DeviceCaretProps {
  kind: 'mic' | 'camera';
  label: string;
}

// Small per-button device picker — reunites the caret that used to sit
// directly on Mic/Camera before DeviceMenu.tsx merged them into one ⋮ menu
// (see that file's own history comment). Speaker selection stays in
// DeviceMenu since there's no dedicated Speaker button to attach it to.
export function DeviceCaret({ kind, label }: DeviceCaretProps) {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const { mics, cameras } = await webrtcService.listDevices();
    const sel = webrtcService.getSelectedDevices();
    if (kind === 'mic') {
      setDevices(mics);
      setSelectedId(sel.micId);
    } else {
      setDevices(cameras);
      setSelectedId(sel.cameraId);
    }
  }, [kind]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

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

  const pick = async (id: string) => {
    if (kind === 'mic') await webrtcService.switchMic(id);
    else await webrtcService.switchCamera(id);
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <Tooltip label={`Pilih ${label}`} detail={`Pilih ${label.toLowerCase()} yang ingin dipakai, tanpa perlu mematikan dulu.`}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          // Flat/borderless toolbar restyle — this used to visually fuse
          // onto its sibling Mic/Camera button as one glass pill (rounded
          // only on the right, no left border, negative margin closing the
          // gap). That pill doesn't exist any more (see MicButton's own
          // comment), so this is just its own small flat hit target now.
          className="flex items-center justify-center w-5 h-9 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer -ml-1.5"
        >
          <ChevronDown size={10} />
        </button>
      </Tooltip>

      {open && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-56 max-h-72 overflow-y-auto bg-white dark:bg-gray-800 border border-login-border-soft dark:border-gray-700 rounded-lg shadow-xl py-1 z-[60]">
          {devices.length === 0 && (
            <div className="px-3 py-1.5 text-xs text-gray-400 dark:text-gray-500 italic">Tidak ada perangkat</div>
          )}
          {devices.map((d, i) => {
            const isSelected = selectedId ? d.deviceId === selectedId : d.deviceId === 'default' || d.deviceId === '';
            return (
              <button
                key={d.deviceId || i}
                onClick={() => pick(d.deviceId)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 dark:text-gray-200 hover:bg-login-surface dark:hover:bg-gray-700 cursor-pointer"
              >
                <span className="w-3.5 shrink-0 text-login-accent dark:text-purple-300">{isSelected && <Check size={14} />}</span>
                <span className="truncate">{d.label || `${label} ${i + 1}`}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
