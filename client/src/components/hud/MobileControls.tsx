import { useCallback, useEffect, useRef, useState } from 'react';
import { LightningChargeFill, HandIndexThumbFill } from 'react-bootstrap-icons';

// On-screen touch controls for phones/tablets — the game is otherwise
// keyboard-only (WASD/Space/Z). Rather than teach useMovement.ts/GameCanvas
// a second input path, this just dispatches the SAME synthetic keyboard
// events those already listen for on `window` (see useMovement's
// keydown/keyup handlers and GameCanvas's Space/KeyZ handlers), so touch
// input flows through the identical movement/sit/nudge pipeline with zero
// changes to that code. Only rendered on touch devices (pointer: coarse).

type Dir = 'up' | 'down' | 'left' | 'right';
const DIR_KEYS: Record<Dir, { key: string; code: string }> = {
  up: { key: 'w', code: 'KeyW' },
  down: { key: 's', code: 'KeyS' },
  left: { key: 'a', code: 'KeyA' },
  right: { key: 'd', code: 'KeyD' },
};

function keydown(k: { key: string; code: string }) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k.key, code: k.code, bubbles: true }));
}
function keyup(k: { key: string; code: string }) {
  window.dispatchEvent(new KeyboardEvent('keyup', { key: k.key, code: k.code, bubbles: true }));
}
// A discrete press (down then up) — for one-shot actions like jump/nudge.
function tap(k: { key: string; code: string }) {
  keydown(k);
  setTimeout(() => keyup(k), 60);
}

const RADIUS = 46; // px the knob can travel from center
const DEADZONE = 14; // px before a direction registers

export function MobileControls() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    const update = () => setShow(mq.matches || 'ontouchstart' in window);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);

  const baseRef = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const activeRef = useRef<Set<Dir>>(new Set());
  const [running, setRunning] = useState(false);

  // Diff the newly-active directions against the held set: press the ones
  // that just became active, release the ones that just stopped.
  const applyDirs = useCallback((dx: number, dy: number) => {
    const next = new Set<Dir>();
    if (dy < -DEADZONE) next.add('up');
    else if (dy > DEADZONE) next.add('down');
    if (dx < -DEADZONE) next.add('left');
    else if (dx > DEADZONE) next.add('right');

    for (const d of activeRef.current) if (!next.has(d)) keyup(DIR_KEYS[d]);
    for (const d of next) if (!activeRef.current.has(d)) keydown(DIR_KEYS[d]);
    activeRef.current = next;
  }, []);

  const releaseAll = useCallback(() => {
    for (const d of activeRef.current) keyup(DIR_KEYS[d]);
    activeRef.current = new Set();
    setKnob({ x: 0, y: 0 });
  }, []);

  const moveKnob = useCallback((clientX: number, clientY: number) => {
    const base = baseRef.current;
    if (!base) return;
    const r = base.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > RADIUS) {
      dx = (dx / dist) * RADIUS;
      dy = (dy / dist) * RADIUS;
    }
    setKnob({ x: dx, y: dy });
    applyDirs(dx, dy);
  }, [applyDirs]);

  // Release everything if this component ever unmounts mid-press (leaving
  // room, etc.) so a key doesn't get stuck "held" in useMovement's keysRef.
  useEffect(() => () => {
    releaseAll();
    if (running) keyup({ key: 'r', code: 'KeyR' });
  }, [releaseAll, running]);

  const toggleRun = () => {
    setRunning((prev) => {
      const nextVal = !prev;
      if (nextVal) keydown({ key: 'r', code: 'KeyR' });
      else keyup({ key: 'r', code: 'KeyR' });
      return nextVal;
    });
  };

  if (!show) return null;

  return (
    <>
      {/* Joystick — bottom-left, clear of the sidebar rail (w-12). */}
      <div
        ref={baseRef}
        data-testid="mc-joystick"
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); moveKnob(e.clientX, e.clientY); }}
        onPointerMove={(e) => { if (e.buttons || e.pointerType === 'touch') moveKnob(e.clientX, e.clientY); }}
        onPointerUp={releaseAll}
        onPointerCancel={releaseAll}
        className="fixed bottom-8 left-20 z-40 w-32 h-32 rounded-full bg-black/25 backdrop-blur-sm border border-white/25 touch-none select-none pointer-events-auto"
        style={{ touchAction: 'none' }}
      >
        <div
          className="absolute top-1/2 left-1/2 w-14 h-14 rounded-full bg-white/80 border border-white shadow-lg"
          style={{ transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))` }}
        />
      </div>

      {/* Action buttons — bottom-right, above the center mic/camera HUD. */}
      <div className="fixed bottom-10 right-6 z-40 flex flex-col items-center gap-3 pointer-events-auto select-none">
        <div className="flex gap-3">
          <button
            onPointerDown={(e) => { e.preventDefault(); tap({ key: 'z', code: 'KeyZ' }); }}
            title="Nudge"
            className="w-12 h-12 rounded-full bg-white/85 border border-white shadow-lg flex items-center justify-center text-purple-600 active:scale-95 transition-transform"
          >
            <HandIndexThumbFill size={18} />
          </button>
          <button
            onPointerDown={toggleRun}
            title="Run"
            className={`w-12 h-12 rounded-full border shadow-lg flex items-center justify-center active:scale-95 transition-transform ${running ? 'bg-amber-400 border-amber-300 text-white' : 'bg-white/85 border-white text-amber-500'}`}
          >
            <LightningChargeFill size={18} />
          </button>
        </div>
        {/* Big primary action: sit / stand / jump (Space). */}
        <button
          data-testid="mc-action"
          onPointerDown={(e) => { e.preventDefault(); tap({ key: ' ', code: 'Space' }); }}
          title="Sit / Jump"
          className="w-16 h-16 rounded-full bg-purple-600 border-2 border-purple-300 text-white text-xs font-bold shadow-xl flex items-center justify-center active:scale-95 transition-transform"
        >
          Sit / Jump
        </button>
      </div>
    </>
  );
}
