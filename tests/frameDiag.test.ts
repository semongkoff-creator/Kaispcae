import assert from 'node:assert/strict';
import { recordFrame, buildFrameReport, resetFrameDiag } from '../client/src/utils/frameDiag';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

// recordFrame reads the real clock for the GAP between calls, so a synthetic
// frame sequence is produced by busy-waiting the wall clock. Kept short: the
// verdict logic is what matters, not the exact numbers.
function busyWait(ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* spin */ }
}

test('a steady stream of cheap frames reads as smooth', () => {
  resetFrameDiag();
  for (let i = 0; i < 20; i++) {
    busyWait(2);
    recordFrame(1);
  }
  const r = buildFrameReport();
  assert.ok(r.frames >= 20);
  assert.match(r.verdict, /SMOOTH/);
  assert.equal(r.framesOver100ms, 0);
});

test('slow drawing is blamed on the draw', () => {
  resetFrameDiag();
  for (let i = 0; i < 15; i++) {
    busyWait(60);       // the frame took 60ms...
    recordFrame(58);    // ...and the drawing accounted for nearly all of it
  }
  const r = buildFrameReport();
  assert.match(r.verdict, /DRAW-BOUND/, `got: ${r.verdict}`);
  assert.ok(r.draw.p99 >= 50, `draw p99 should reflect the slow draws, got ${r.draw.p99}`);
});

test('a long gap with a fast draw is blamed on something else', () => {
  resetFrameDiag();
  for (let i = 0; i < 15; i++) {
    busyWait(70);      // 70ms between frames...
    recordFrame(2);    // ...but drawing only took 2ms of it
  }
  const r = buildFrameReport();
  assert.match(r.verdict, /BLOCKED/, `got: ${r.verdict}`);
  assert.ok(r.gap.p99 > 33);
});

test('the worst frames are kept with their draw time, worst first', () => {
  resetFrameDiag();
  busyWait(5); recordFrame(1);
  busyWait(120); recordFrame(3);   // one genuinely bad frame
  busyWait(5); recordFrame(1);
  const r = buildFrameReport();
  assert.ok(r.worstFrames.length >= 1);
  assert.ok(r.worstFrames[0].gapMs >= 100, `expected the 120ms frame first, got ${r.worstFrames[0].gapMs}`);
  assert.ok(r.worstFrames[0].drawMs < 10, 'and its draw time must be carried alongside, or the pairing is useless');
});

test('reset clears the sample so a second measurement is independent', () => {
  resetFrameDiag();
  busyWait(80); recordFrame(70);
  resetFrameDiag();
  const r = buildFrameReport();
  assert.equal(r.frames, 0);
  assert.equal(r.gap.max, 0);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} frame diag test(s) passed`);
