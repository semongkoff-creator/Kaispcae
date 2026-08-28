import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { console.error(`  FAIL  ${name}`); console.error(err instanceof Error ? err.message : err); process.exitCode = 1; }
}

const ticker = readFileSync(resolve('client/src/components/ui/AnnouncementTicker.tsx'), 'utf8');
const sfx = readFileSync(resolve('client/src/services/soundEffects.ts'), 'utf8');

test('the chime asset ships with the app', () => {
  // Under client/public, so it is served verbatim at the path the code names.
  // A missing file here fails silently at runtime: play() rejects and the
  // catch swallows it, so the announcement just appears with no sound.
  const file = 'client/public/assets/sounds/announce/airport-call.mp3';
  assert.equal(existsSync(file), true, `${file} must exist`);
  assert.ok(statSync(file).size > 1000, 'and not be a placeholder');
  assert.ok(sfx.includes("'/assets/sounds/announce/airport-call.mp3'"), 'the path must match');
});

test('it is preloaded, like every other clip', () => {
  // Fetched up front rather than at play time — a 150 KB download starting
  // the moment an announcement lands would delay the very thing it announces.
  assert.ok(/preload\(ANNOUNCE_SRC\)/.test(sfx));
});

test('sound comes first, text second', () => {
  assert.ok(/playAnnouncementSound\(\)/.test(ticker), 'the ticker plays it');
  assert.ok(/ANNOUNCE_LEAD_IN_MS/.test(ticker), 'and holds the text back');
  assert.ok(/if \(!current \|\| !revealed\) return null/.test(ticker), 'nothing renders during the lead-in');
});

test('the lead-in is shorter than the clip', () => {
  // The clip runs 4.8s. Holding a blank screen that long to finish a jingle
  // gets an announcement backwards: the chime rings out under the text
  // instead, which is what a real PA system does.
  const m = ticker.match(/ANNOUNCE_LEAD_IN_MS = (\d+)/);
  assert.ok(m, 'the lead-in should be a named constant');
  const ms = Number(m![1]);
  assert.ok(ms >= 800, `${ms}ms is too short for the chime to register`);
  assert.ok(ms <= 2500, `${ms}ms holds the message back too long`);
});

test('a queued announcement chimes when its own turn comes', () => {
  // Keyed on the CURRENT message, not on the socket event. Chiming on arrival
  // would fire while the previous message is still scrolling, so the sound
  // and the text would be describing different announcements.
  const at = ticker.indexOf('playAnnouncementSound()');
  const effect = ticker.slice(Math.max(0, at - 400), at + 300);
  assert.ok(effect.includes('messageKey'), 'the chime effect must key on the current message');
  assert.equal(
    /socket\.on|BROADCAST_RECEIVED/.test(ticker), false,
    'and must not be wired to the socket event directly',
  );
});

test('measurement waits for the strip to exist', () => {
  // Nothing is in the DOM during the lead-in, so a measurement that ran then
  // would read null refs once and never run again — leaving travel null and
  // the text unscrolled.
  assert.ok(/reduced \|\| !revealed\) \{ setTravel\(null\); return; \}/.test(ticker));
  assert.ok(/\}, \[messageKey, reduced, revealed\]\)/.test(ticker));
});

test('the dismiss timers do not start before the text is visible', () => {
  // Both exits are sized to reading time. Starting either during the lead-in
  // would eat 1.8s of it.
  const timers = ticker.match(/if \(!current \|\| [^)]*reduced\)? *(\|\||&&)[^\n]*revealed\) return;/g) ?? [];
  assert.ok(timers.length >= 2, 'both the reduced-motion and animated exits must wait');
});

if (process.exitCode) process.exit(process.exitCode);
console.log(`\n${passed} announcement chime test(s) passed`);
