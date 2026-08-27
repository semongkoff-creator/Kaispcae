import assert from 'node:assert/strict';
import { rateLimit } from '../server/src/middleware/rateLimit';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { console.error(`  FAIL  ${name}`); console.error(err instanceof Error ? err.message : err); process.exitCode = 1; }
}

// Minimal express-ish doubles: the middleware only touches req.ip, res.status,
// res.json and res.on('finish').
function run(mw: any, ip: string, status: number) {
  const finish: Array<() => void> = [];
  let sent: number | null = null;
  const res: any = {
    statusCode: status,
    status(code: number) { sent = code; this.statusCode = code; return this; },
    json() { return this; },
    on(evt: string, cb: () => void) { if (evt === 'finish') finish.push(cb); },
  };
  let passedThrough = false;
  mw({ ip, socket: {} }, res, () => { passedThrough = true; });
  if (passedThrough) finish.forEach((f) => f());   // the handler answered
  return { allowed: passedThrough, rejectedWith: sent };
}

test('wrong guesses still exhaust the budget', () => {
  // The ceiling that actually matters. An attacker only ever produces
  // failures, so this is the number that bounds them, refund or not.
  const mw = rateLimit(60_000, 3, { refundOnSuccess: true });
  for (let i = 0; i < 3; i++) assert.equal(run(mw, '1.1.1.1', 401).allowed, true);
  const fourth = run(mw, '1.1.1.1', 401);
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.rejectedWith, 429);
});

test('correct passwords do not consume it', () => {
  // The regression this exists for: one office, one NAT IP, everyone asked to
  // reload at once. Before the refund, the Nth coworker was refused despite
  // typing a password that works.
  const mw = rateLimit(60_000, 3, { refundOnSuccess: true });
  for (let i = 0; i < 50; i++) {
    assert.equal(run(mw, '2.2.2.2', 200).allowed, true, `sign-in ${i + 1} should be allowed`);
  }
});

test('a few failures among many successes do not lock the office out', () => {
  const mw = rateLimit(60_000, 3, { refundOnSuccess: true });
  run(mw, '3.3.3.3', 401);                      // one typo
  for (let i = 0; i < 20; i++) assert.equal(run(mw, '3.3.3.3', 200).allowed, true);
  run(mw, '3.3.3.3', 401);                      // another typo
  assert.equal(run(mw, '3.3.3.3', 200).allowed, true);
});

test('without the option nothing changes', () => {
  const mw = rateLimit(60_000, 2);
  assert.equal(run(mw, '4.4.4.4', 200).allowed, true);
  assert.equal(run(mw, '4.4.4.4', 200).allowed, true);
  assert.equal(run(mw, '4.4.4.4', 200).allowed, false);
});

test('one IP exhausting its budget does not affect another', () => {
  const mw = rateLimit(60_000, 1, { refundOnSuccess: true });
  run(mw, '5.5.5.5', 401);
  assert.equal(run(mw, '5.5.5.5', 401).allowed, false);
  assert.equal(run(mw, '6.6.6.6', 401).allowed, true);
});

if (process.exitCode) process.exit(process.exitCode);
console.log(`\n${passed} login rate limit test(s) passed`);
