// Frame-timing instrument for "it still stutters" reports.
//
// Every stutter hypothesis so far has been reasoned from reading code, which
// works right up until it doesn't. This measures the one distinction that
// separates every remaining explanation:
//
//   - a LONG DRAW means the canvas work itself is over budget (too many
//     avatars/labels/tiles, too many pixels at this dpr and zoom), and the
//     fix is in the render loop;
//   - a LONG GAP with a SHORT DRAW means the canvas is innocent and something
//     else owned the main thread while the frame waited — React re-renders,
//     socket handlers, WebRTC negotiation, garbage collection. The fix is
//     nowhere near the drawing code.
//
// Reading the two numbers apart is the whole point: they look identical from
// the outside (the avatar moves in jumps either way) and have nothing in
// common as problems.
//
// Cost when nobody is looking: two performance.now() calls and a few array
// writes per frame. The long-task observer is passive — the browser reports
// tasks it was already timing.

const RING = 900; // ~15s at 60fps
const BUDGET_MS = 1000 / 60;

let intervals: number[] = [];
let draws: number[] = [];
let worst: { gapMs: number; drawMs: number; sinceStartMs: number }[] = [];
let longTasks: { durationMs: number; name: string; sinceStartMs: number }[] = [];
let startedAt = 0;
let lastFrameAt = 0;
let frameCount = 0;

function push(arr: number[], v: number): void {
  arr.push(v);
  if (arr.length > RING) arr.shift();
}

/** Called once per animation frame from the render loop's own wrapper. */
export function recordFrame(drawMs: number): void {
  const now = performance.now();
  if (!startedAt) startedAt = now;
  frameCount++;
  if (lastFrameAt) {
    const gap = now - lastFrameAt;
    push(intervals, gap);
    push(draws, drawMs);
    // Anything past two frames' worth of budget is visible as a jump. Keep
    // the worst offenders WITH their draw time, since that pairing is what
    // says whose fault the frame was.
    if (gap > BUDGET_MS * 2) {
      worst.push({ gapMs: round(gap), drawMs: round(drawMs), sinceStartMs: Math.round(now - startedAt) });
      worst.sort((a, b) => b.gapMs - a.gapMs);
      if (worst.length > 40) worst.length = 40;
    }
  }
  lastFrameAt = now;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * sorted.length) - 1));
  return round(sorted[i]);
}

// ── Phase breakdown ───────────────────────────────────────────────────────
// A 250ms frame tells you the canvas is the problem; it does not tell you
// WHICH of ~1700 lines of drawing spent it. These are cumulative per-phase
// totals, reported as a mean per frame, plus a snapshot of how much scenery
// each phase was asked to draw — because "slow" and "asked to draw 40,000
// things" are different diagnoses with different fixes.
const phaseTotals = new Map<string, number>();
let phaseFrames = 0;
let sceneCounts: Record<string, number> = {};

export function recordPhases(phases: Record<string, number>): void {
  phaseFrames++;
  for (const [name, ms] of Object.entries(phases)) {
    phaseTotals.set(name, (phaseTotals.get(name) ?? 0) + ms);
  }
}

export function recordSceneCounts(counts: Record<string, number>): void {
  sceneCounts = counts;
}

export interface FrameReport {
  seconds: number;
  frames: number;
  fps: number;
  gap: { p50: number; p95: number; p99: number; max: number };
  draw: { p50: number; p95: number; p99: number; max: number };
  framesOver33ms: number;
  framesOver100ms: number;
  // The diagnosis, stated rather than left to be inferred.
  verdict: string;
  worstFrames: { gapMs: number; drawMs: number; sinceStartMs: number }[];
  longTasks: { durationMs: number; name: string; sinceStartMs: number }[];
  // Mean milliseconds per frame, per phase of the draw, worst first.
  phasesAvgMs: Record<string, number>;
  // What the last frame was asked to draw.
  scene: Record<string, number>;
}

export function buildFrameReport(): FrameReport {
  const gaps = [...intervals].sort((a, b) => a - b);
  const drawSorted = [...draws].sort((a, b) => a - b);
  const elapsed = (lastFrameAt - startedAt) / 1000;
  const over33 = intervals.filter((g) => g > 33).length;
  const over100 = intervals.filter((g) => g > 100).length;

  // A long frame whose draw was short means the time went somewhere else.
  const gapP99 = percentile(gaps, 99);
  const drawP99 = percentile(drawSorted, 99);
  let verdict: string;
  if (gapP99 <= 33) {
    verdict = 'SMOOTH — no meaningful long frames in this sample';
  } else if (drawP99 >= gapP99 * 0.6) {
    verdict = 'DRAW-BOUND — the canvas work itself is over budget (look at the render loop, or try Simplify mode)';
  } else {
    verdict = 'BLOCKED — frames waited on something other than drawing (React re-render, socket handler, WebRTC, GC). See longTasks.';
  }

  return {
    seconds: round(elapsed),
    frames: frameCount,
    fps: elapsed > 0 ? round(frameCount / elapsed) : 0,
    gap: { p50: percentile(gaps, 50), p95: percentile(gaps, 95), p99: gapP99, max: round(gaps[gaps.length - 1] ?? 0) },
    draw: { p50: percentile(drawSorted, 50), p95: percentile(drawSorted, 95), p99: drawP99, max: round(drawSorted[drawSorted.length - 1] ?? 0) },
    framesOver33ms: over33,
    framesOver100ms: over100,
    verdict,
    worstFrames: worst.slice(0, 10),
    longTasks: [...longTasks].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10),
    phasesAvgMs: Object.fromEntries(
      [...phaseTotals.entries()]
        .map(([name, total]) => [name, round(total / Math.max(1, phaseFrames))] as const)
        .sort((a, b) => (b[1] as number) - (a[1] as number)),
    ),
    scene: sceneCounts,
  };
}

export function resetFrameDiag(): void {
  phaseTotals.clear();
  phaseFrames = 0;
  sceneCounts = {};
  intervals = [];
  draws = [];
  worst = [];
  longTasks = [];
  startedAt = 0;
  lastFrameAt = 0;
  frameCount = 0;
}

// Long tasks are the other half of the answer: the browser already measures
// every task that blocks the main thread for 50ms+, and those are exactly the
// ones a frame can do nothing about. Not supported everywhere (Safari), hence
// the try/catch — its absence just means this half of the report is empty.
if (typeof PerformanceObserver !== 'undefined') {
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({
          durationMs: round(entry.duration),
          name: entry.name,
          sinceStartMs: startedAt ? Math.round(entry.startTime - startedAt) : 0,
        });
        if (longTasks.length > 60) longTasks.shift();
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    // Not available — the frame numbers above still stand on their own.
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { frameDiag: () => FrameReport }).frameDiag = () => {
    const report = buildFrameReport();
    // Logged AND returned: the console shows it expanded, and the return value
    // is what gets copied out of DevTools with right-click → Copy object.
    console.log('[frame-diag]', report);
    return report;
  };
  (window as unknown as { frameDiagReset: () => void }).frameDiagReset = () => {
    resetFrameDiag();
    console.log('[frame-diag] reset — walk around for ~20s, then run frameDiag()');
  };
}
