import { useEffect, RefObject } from 'react';

// Closes a popover/dropdown when the user clicks (or Escapes) outside `ref`.
// Pointerdown (not click) so it fires before an inner click handler can
// re-open something; also handles Escape for keyboard users.
export function useClickOutside<T extends HTMLElement>(ref: RefObject<T>, onClose: () => void, active = true): void {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, onClose, active]);
}
