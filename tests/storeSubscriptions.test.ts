import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { useGameStore } from '../client/src/stores/gameStore';

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

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

test('walking replaces the localPlayer object, so whole-object selectors re-render at 10Hz', () => {
  // The fact the guard below exists because of: a position write hands React a
  // NEW localPlayer object, so anything selecting the object itself re-renders,
  // even when the field it actually reads is untouched.
  const store = useGameStore.getState();
  store.setLocalPlayer({ name: 'Ravka', direction: 'down', isMoving: false });
  const before = useGameStore.getState().localPlayer;
  store.setLocalPlayerMoving(100, 200, 'left', false); // direction change → flushes immediately
  const after = useGameStore.getState().localPlayer;
  assert.notEqual(before, after, 'a movement write must replace the object (this is the cost being managed)');
  assert.equal(after.name, before.name, 'while the fields a panel actually reads are unchanged');
});

test('heavy components select localPlayer fields, never the whole object', () => {
  // Only components that genuinely track POSITION may take the whole object;
  // for everyone else it means re-rendering ten times a second while any
  // player walks. That measured as 250-470ms keyboard interactions (INP 512ms)
  // in production, because GameCanvas — the heaviest component in the app —
  // was re-rendering purely to copy a value into a ref.
  const allowed = new Set(['ZoneWatcher.tsx', 'TeleportPanel.tsx']);
  const offenders: string[] = [];
  for (const file of walk(resolve('client/src'))) {
    const source = readFileSync(file, 'utf8');
    if (/useGameStore\(\s*\(s\)\s*=>\s*s\.localPlayer\s*\)/.test(source) && !allowed.has(basename(file))) {
      offenders.push(file.replace(resolve('.') + '/', ''));
    }
  }
  assert.deepEqual(offenders, [],
    `select the fields you read instead: ${offenders.join(', ')}`);
});

test('GameCanvas keeps its localPlayer ref fresh without subscribing', () => {
  const source = readFileSync(resolve('client/src/components/canvas/GameCanvas.tsx'), 'utf8');
  assert.ok(
    source.includes('useEffect(() => useGameStore.subscribe((s) => { localPlayerRef.current = s.localPlayer; }), [])'),
    'the ref should be maintained imperatively, so a position write costs no render',
  );
  assert.equal(
    /localPlayerRef\.current = localPlayer;/.test(source), false,
    'assigning during render is what required the re-render in the first place',
  );
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} store subscription test(s) passed`);
