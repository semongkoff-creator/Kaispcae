import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { oauthReturn } from '../server/src/lib/oauthReturn';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { console.error(`  FAIL  ${name}`); console.error(err instanceof Error ? err.message : err); process.exitCode = 1; }
}

test('an OAuth return lands on a path the app actually serves', () => {
  // kaispace.io/ is the marketing site now. nginx routes /login, /logout and
  // /@slug to the app and everything else to the landing, so a code delivered
  // to the root reaches a bundle with no code to read it.
  const nginx = readFileSync(resolve('deploy/kaispace/nginx-host.conf'), 'utf8');
  const target = oauthReturn('x=1').split('?')[0];
  assert.ok(
    new RegExp(`location \\^~ ${target}\\b`).test(nginx),
    `${target} must be one of the prefixes nginx sends to the app`,
  );
});

test('the query survives intact', () => {
  assert.equal(oauthReturn('larkCode=abc'), '/login?larkCode=abc');
  assert.equal(oauthReturn('googleError=exchange'), '/login?googleError=exchange');
});

test('it stays relative, so a stale CLIENT_URL cannot hijack it', () => {
  // The browser already arrived on the right origin. An absolute URL built
  // from config could point somewhere else entirely.
  assert.ok(oauthReturn('a=1').startsWith('/'));
  assert.equal(/^https?:/.test(oauthReturn('a=1')), false);
});

test('neither callback bounces to the root any more', () => {
  // The regression itself: authorization succeeded, a valid one-time code came
  // back, and the browser landed on the landing page holding it. Nothing read
  // it, so from the outside Lark login looked like it silently did nothing.
  for (const name of ['lark', 'google']) {
    const src = readFileSync(resolve(`server/src/routes/${name}.ts`), 'utf8');
    assert.equal(
      /res\.redirect\(`\/\?/.test(src), false,
      `${name}.ts must not send an OAuth code to the root path`,
    );
  }
});

test('the client still reads the codes this sends', () => {
  const useAuth = readFileSync(resolve('client/src/hooks/useAuth.ts'), 'utf8');
  for (const key of ['larkCode', 'larkError', 'googleCode', 'googleError']) {
    assert.ok(useAuth.includes(`params.get('${key}')`), `useAuth must still read ${key}`);
  }
});

if (process.exitCode) process.exit(process.exitCode);
console.log(`\n${passed} oauth return test(s) passed`);
