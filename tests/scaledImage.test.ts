import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

const source = readFileSync(resolve('client/src/utils/scaledImage.ts'), 'utf8');
const canvas = readFileSync(resolve('client/src/components/canvas/GameCanvas.tsx'), 'utf8');

test('the reference image prefers a pre-scaled source', () => {
  // Measured: this one drawImage averaged 22ms per frame in a room with zero
  // furniture, and its texture-cache pressure dragged the avatar pass down with
  // it (both phases spiked together; frame times were bimodal, p50 2.7ms /
  // p95 250ms).
  assert.ok(canvas.includes('getScaledImage(ref.url, ref.width, ref.height)'));
});

test('the crop and the pre-scale are both applied, not one instead of the other', () => {
  // The crop stops us sampling off-screen pixels; the pre-scale stops the
  // enormous source texture needing to be resident. Either alone leaves half
  // the cost — so the source rect must be derived from the ACTUAL source
  // dimensions, whichever source won.
  assert.ok(canvas.includes('sourceWidth') && canvas.includes('sourceHeight'));
  assert.ok(
    /const sourceX = \(\(drawLeft - refLeft\) \/ ref\.width\) \* sourceWidth;/.test(canvas),
    'the source crop must scale with the source actually being drawn',
  );
});

test('it still draws the original until the pre-scale is ready', () => {
  // A room must never render blank waiting for an optimisation.
  assert.ok(
    /if \(!source\) \{[\s\S]{0,220}getSpriteImage\(ref\.url\)/.test(canvas),
    'the un-scaled fallback path must remain',
  );
});

test('scaling is skipped when it would not pay for itself', () => {
  assert.ok(source.includes('MIN_SHRINK_RATIO'), 'a mild downscale is not worth a second copy in memory');
  assert.ok(source.includes('MAX_DIMENSION'), 'and the pre-scaled copy must itself be bounded');
  assert.ok(
    /img\.naturalWidth < w \* MIN_SHRINK_RATIO/.test(source),
    'the decision should compare source size against the size actually drawn',
  );
});

test('a failed or in-flight scale is not retried every frame', () => {
  // getScaledImage runs inside the render loop; retrying an impossible scale
  // 60 times a second would be worse than the problem it solves.
  assert.ok(
    /if \(existing\) return existing\.bitmap;/.test(source),
    'an existing entry — even one with a null bitmap — must short-circuit',
  );
  const setAt = source.indexOf('cache.set(key, entry)');
  const asyncAt = source.indexOf('createImageBitmap(img');
  assert.ok(setAt !== -1 && setAt < asyncAt, 'the entry must be registered BEFORE the async work starts');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} scaled image test(s) passed`);
