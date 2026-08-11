import { ReactNode, useState } from 'react';
import { useGameStore } from '@/stores/gameStore';

interface TooltipProps {
  // Short line, mirrors what the old per-button `title`/showLabel text said
  // (often includes the hotkey, e.g. "Mikrofon (M)").
  label: string;
  // Longer function + when-to-use copy, only rendered when both hovered AND
  // the "Tampilkan tooltip" preference (Settings → Tampilan) is on.
  detail?: string;
  children: ReactNode;
  // Anchors the popover to the trigger's right edge instead of centering it
  // — for triggers that sit near the right edge of the screen (Chat), where
  // a centered popover would overflow the viewport.
  align?: 'center' | 'end';
}

// Replaces the 5x-copy-pasted hover-label pattern previously inline in each
// HUD button (MicButton/HandButton/EmojiButton/ParticipantsToggleButton/
// LeaveButton) and adds the same affordance to the 3 that only had a native
// `title` (CameraButton/ScreenShareButton/DeviceMenu) plus the floating Chat
// button — one place to gate all of them on the tooltipsEnabled preference.
export function Tooltip({ label, detail, children, align = 'center' }: TooltipProps) {
  const [hover, setHover] = useState(false);
  const tooltipsEnabled = useGameStore((s) => s.tooltipsEnabled);
  const show = hover && tooltipsEnabled;

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {children}
      {show && (
        <div
          className={`absolute bottom-full mb-2 ${align === 'end' ? 'right-0' : 'left-1/2 -translate-x-1/2'} w-max max-w-[220px] text-xs bg-white dark:bg-gray-800 text-purple-700 dark:text-purple-300 border border-purple-100 dark:border-gray-700 shadow-lg px-2.5 py-1.5 rounded-lg z-[60] pointer-events-none`}
        >
          <div className="font-semibold">{label}</div>
          {detail && (
            <div className="mt-0.5 text-[11px] font-normal text-gray-500 dark:text-gray-400 leading-snug whitespace-normal">
              {detail}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
