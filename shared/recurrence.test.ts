import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { expandOccurrences, truncateRuleBefore, normaliseRule, describeRule } from './recurrence';

// Recurrence tests. This repo has no test runner, so this file is a plain
// self-checking script:
//
//     npx tsx shared/recurrence.test.ts
//
// It exits non-zero on the first failed assertion.

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

// Helper: build a UTC instant from a wall-clock time in a zone.
const at = (zone: string, iso: string) => DateTime.fromISO(iso, { zone }).toJSDate();
// Helper: read an instant back as wall-clock in a zone.
const wall = (d: Date, zone: string) => DateTime.fromJSDate(d, { zone }).toFormat('yyyy-MM-dd HH:mm');

console.log('\n— dasar —');

test('event sekali jalan hanya muncul kalau beririsan dengan jendela', () => {
  const m = { start: at('UTC', '2026-03-10T09:00'), end: at('UTC', '2026-03-10T10:00'), timezone: 'UTC', rrule: null };
  assert.equal(expandOccurrences(m, at('UTC', '2026-03-01T00:00'), at('UTC', '2026-03-31T00:00')).length, 1);
  assert.equal(expandOccurrences(m, at('UTC', '2026-04-01T00:00'), at('UTC', '2026-04-30T00:00')).length, 0);
});

test('mingguan tiap Senin menghasilkan hanya hari Senin', () => {
  const m = {
    start: at('Asia/Jakarta', '2026-03-02T09:00'), // Senin
    end: at('Asia/Jakarta', '2026-03-02T10:00'),
    timezone: 'Asia/Jakarta',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
  };
  const occ = expandOccurrences(m, at('Asia/Jakarta', '2026-03-01T00:00'), at('Asia/Jakarta', '2026-03-31T23:59'));
  assert.equal(occ.length, 5, `dapat ${occ.length}`);
  for (const o of occ) {
    assert.equal(DateTime.fromJSDate(o.start, { zone: 'Asia/Jakarta' }).weekday, 1, 'harus Senin');
    assert.equal(wall(o.start, 'Asia/Jakarta').slice(-5), '09:00');
  }
});

test('durasi occurrence ikut master', () => {
  const m = {
    start: at('UTC', '2026-03-02T09:00'), end: at('UTC', '2026-03-02T10:30'),
    timezone: 'UTC', rrule: 'FREQ=DAILY;COUNT=3',
  };
  for (const o of expandOccurrences(m, at('UTC', '2026-03-01T00:00'), at('UTC', '2026-03-10T00:00'))) {
    assert.equal(o.end.getTime() - o.start.getTime(), 90 * 60 * 1000);
  }
});

test('exdate menghapus occurrence tertentu saja', () => {
  const m = {
    start: at('Asia/Jakarta', '2026-03-02T09:00'), end: at('Asia/Jakarta', '2026-03-02T10:00'),
    timezone: 'Asia/Jakarta', rrule: 'FREQ=WEEKLY;BYDAY=MO',
    exdates: [at('Asia/Jakarta', '2026-03-09T09:00')],
  };
  const occ = expandOccurrences(m, at('Asia/Jakarta', '2026-03-01T00:00'), at('Asia/Jakarta', '2026-03-31T23:59'));
  assert.equal(occ.length, 4);
  assert.ok(!occ.some((o) => wall(o.start, 'Asia/Jakarta').startsWith('2026-03-09')), '9 Maret harus hilang');
});

console.log('\n— DST (kriteria #23) —');

// New York springs forward on 8 March 2026 (02:00 → 03:00).
test('09:00 New York tetap 09:00 setelah DST maju (bukan 08:00 atau 10:00)', () => {
  const m = {
    start: at('America/New_York', '2026-03-02T09:00'), // Senin, sebelum DST
    end: at('America/New_York', '2026-03-02T10:00'),
    timezone: 'America/New_York',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
  };
  const occ = expandOccurrences(m, at('America/New_York', '2026-03-01T00:00'), at('America/New_York', '2026-03-31T23:59'));
  for (const o of occ) {
    assert.equal(wall(o.start, 'America/New_York').slice(-5), '09:00', `melenceng: ${wall(o.start, 'America/New_York')}`);
  }
  // ...dan offset UTC-nya MEMANG berubah — itu buktinya DST benar-benar dilewati
  const before = occ.find((o) => wall(o.start, 'America/New_York').startsWith('2026-03-02'))!;
  const after = occ.find((o) => wall(o.start, 'America/New_York').startsWith('2026-03-09'))!;
  assert.equal(before.start.toISOString(), '2026-03-02T14:00:00.000Z', 'EST = UTC-5');
  assert.equal(after.start.toISOString(), '2026-03-09T13:00:00.000Z', 'EDT = UTC-4');
});

test('DST mundur (Nov) juga tidak menggeser jam lokal', () => {
  const m = {
    start: at('America/New_York', '2026-10-26T09:00'),
    end: at('America/New_York', '2026-10-26T10:00'),
    timezone: 'America/New_York',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
  };
  const occ = expandOccurrences(m, at('America/New_York', '2026-10-01T00:00'), at('America/New_York', '2026-11-30T23:59'));
  for (const o of occ) assert.equal(wall(o.start, 'America/New_York').slice(-5), '09:00');
});

test('dua orang beda zona melihat instant yang sama pada jam lokalnya masing-masing', () => {
  const m = {
    start: at('Asia/Jakarta', '2026-03-02T09:00'), end: at('Asia/Jakarta', '2026-03-02T10:00'),
    timezone: 'Asia/Jakarta', rrule: 'FREQ=WEEKLY;BYDAY=MO',
  };
  const o = expandOccurrences(m, at('UTC', '2026-03-01T00:00'), at('UTC', '2026-03-08T00:00'))[0];
  assert.equal(wall(o.start, 'Asia/Jakarta'), '2026-03-02 09:00');
  assert.equal(wall(o.start, 'America/New_York'), '2026-03-01 21:00'); // WIB = UTC+7, EST = UTC-5
});

console.log('\n— edit "ini dan seterusnya" —');

test('truncate memotong seri sebelum titik pisah, masa lalu utuh', () => {
  const zone = 'Asia/Jakarta';
  const master = {
    start: at(zone, '2026-03-02T09:00'), end: at(zone, '2026-03-02T10:00'),
    timezone: zone, rrule: 'FREQ=WEEKLY;BYDAY=MO',
  };
  const splitAt = at(zone, '2026-03-16T09:00');
  const truncated = truncateRuleBefore(master.rrule, splitAt, zone);
  const occ = expandOccurrences({ ...master, rrule: truncated }, at(zone, '2026-03-01T00:00'), at(zone, '2026-04-30T00:00'));
  const days = occ.map((o) => wall(o.start, zone).slice(0, 10));
  assert.deepEqual(days, ['2026-03-02', '2026-03-09'], `dapat ${days.join(',')}`);
});

test('truncate membuang COUNT (RFC 5545: COUNT dan UNTIL tidak boleh bareng)', () => {
  const rule = truncateRuleBefore('FREQ=WEEKLY;BYDAY=MO;COUNT=10', at('UTC', '2026-03-16T09:00'), 'UTC');
  assert.ok(!rule.includes('COUNT'), rule);
  assert.ok(rule.includes('UNTIL'), rule);
});

console.log('\n— validasi —');

test('rule ngawur ditolak (null), bukan melempar', () => {
  assert.equal(normaliseRule('FREQ=NGAWUR;BYDAY=XX'), null);
  assert.equal(normaliseRule('bukan rrule sama sekali'), null);
});

test('rule sah dinormalisasi', () => {
  assert.equal(normaliseRule('FREQ=WEEKLY;BYDAY=MO'), 'FREQ=WEEKLY;BYDAY=MO');
  assert.equal(normaliseRule('RRULE:FREQ=DAILY;COUNT=3'), 'FREQ=DAILY;COUNT=3');
});

test('describeRule berbahasa Indonesia dan tidak melempar untuk input rusak', () => {
  assert.equal(describeRule(null), 'Tidak berulang');
  assert.ok(describeRule('FREQ=WEEKLY;BYDAY=MO').includes('Senin'));
  assert.ok(describeRule('FREQ=DAILY;INTERVAL=3').includes('3'));
  assert.doesNotThrow(() => describeRule('FREQ=NGAWUR'));
});

console.log(`\n${process.exitCode ? 'ADA YANG GAGAL' : `SEMUA LULUS (${passed})`}\n`);
