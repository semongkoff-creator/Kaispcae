import { ReactNode, useState, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
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
  // Which edge of the trigger the popover opens from. Default 'top' matches
  // every existing caller (HUD buttons in a horizontal row, popping the
  // tooltip up above them). 'right' is for the left Sidebar's narrow icon
  // rail, where popping upward would overlap the row above/below in a
  // tightly-stacked vertical list — same problem a VS Code/Slack-style icon
  // rail solves by opening its labels sideways instead.
  side?: 'top' | 'right';
  // Extra classes for the wrapper div — needed when the trigger itself is
  // `w-full`/block-level (e.g. a full-width menu row): the wrapper defaults
  // to `inline-flex`, which shrinks to content width and would otherwise
  // collapse a w-full child instead of letting it fill its row.
  wrapperClassName?: string;
}

const TOOLTIP_MARGIN = 8;

// Replaces the 5x-copy-pasted hover-label pattern previously inline in each
// HUD button (MicButton/HandButton/EmojiButton/ParticipantsToggleButton/
// LeaveButton) and adds the same affordance to the 3 that only had a native
// `title` (CameraButton/ScreenShareButton/DeviceMenu) plus the floating Chat
// button — one place to gate all of them on the tooltipsEnabled preference.
//
// Rendered via a portal to document.body, positioned with real viewport
// coordinates (getBoundingClientRect) instead of `position: absolute`
// relative to the trigger. The old absolute approach got silently clipped
// whenever a caller sat inside a scrollable/overflow container — the
// Sidebar's long Room Features menu (`overflow-y-auto`) is exactly that, so
// its `side="right"` tooltips were rendering half-cut-off, still inside the
// menu panel's own clip box instead of beside it. A portal escapes that
// clip entirely, and since every caller goes through this one component,
// fixing it here fixes all ~90 existing tooltips at once — no call site
// needs to change.
export function Tooltip({ label, detail, children, align = 'center', side = 'top', wrapperClassName = '' }: TooltipProps) {
  const [hover, setHover] = useState(false);
  const tooltipsEnabled = useGameStore((s) => s.tooltipsEnabled);
  const show = hover && tooltipsEnabled;
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<{ top: number; left: number } | null>(null);

  // Measures the trigger AND the (already-mounted, pre-paint) tooltip node
  // itself, so positioning accounts for the tooltip's real width/height
  // rather than a guess — a multi-line `detail` can be taller than a
  // one-liner, and that changes how far up/left it needs to sit to stay
  // clear of the viewport edge. Runs before the browser paints
  // (useLayoutEffect), so the very first frame the tooltip is visible in is
  // already correctly placed — no flash-then-jump.
  useLayoutEffect(() => {
    if (!show) { setStyle(null); return; }

    const reposition = () => {
      const trigger = triggerRef.current;
      const tip = tooltipRef.current;
      if (!trigger || !tip) return;
      const rect = trigger.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      let top: number;
      let left: number;
      if (side === 'right') {
        const preferredLeft = rect.right + TOOLTIP_MARGIN;
        const overflowsRight = preferredLeft + tipRect.width > vw - TOOLTIP_MARGIN;
        left = overflowsRight ? rect.left - TOOLTIP_MARGIN - tipRect.width : preferredLeft;
        top = rect.top + rect.height / 2 - tipRect.height / 2;
      } else {
        left = align === 'end' ? rect.right - tipRect.width : rect.left + rect.width / 2 - tipRect.width / 2;
        top = rect.top - TOOLTIP_MARGIN - tipRect.height;
      }

      // Clamp into the viewport on both axes — an edge-hugging trigger
      // (top/bottom of a scrolled list, or near the left/right edge) never
      // pushes the tooltip off-screen, regardless of which side it opened
      // from or how it was aligned.
      left = Math.min(Math.max(left, TOOLTIP_MARGIN), vw - tipRect.width - TOOLTIP_MARGIN);
      top = Math.min(Math.max(top, TOOLTIP_MARGIN), vh - tipRect.height - TOOLTIP_MARGIN);
      setStyle({ top, left });
    };

    reposition();
    // capture: true — scroll events don't bubble, but they DO reach a
    // window listener registered for the capture phase regardless of which
    // nested scrollable ancestor (e.g. the Sidebar menu panel) actually
    // scrolled. Keeps the tooltip following the hovered item instead of
    // drifting away from it while the list underneath scrolls.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [show, side, align]);

  return (
    <div
      ref={triggerRef}
      className={`relative inline-flex ${wrapperClassName}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {children}
      {show && createPortal(
        <div
          ref={tooltipRef}
          style={style ? { position: 'fixed', top: style.top, left: style.left } : { position: 'fixed', top: -9999, left: -9999 }}
          className="w-max max-w-[220px] text-xs bg-white dark:bg-gray-800 text-purple-700 dark:text-purple-300 border border-purple-100 dark:border-gray-700 shadow-lg px-2.5 py-1.5 rounded-lg z-[9999] pointer-events-none"
        >
          <div className="font-semibold">{label}</div>
          {detail && (
            <div className="mt-0.5 text-[11px] font-normal text-gray-500 dark:text-gray-400 leading-snug whitespace-normal">
              {detail}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
