import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

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

test('KaiSpace favicon asset is wired into the document head', () => {
  // favicon-kaispace.png, the current mark. The tab icon and the browser
  // notification icon both point at it, and they have to agree — a
  // notification carrying a different logo than the tab it came from reads
  // as a different product.
  assert.equal(existsSync('client/public/assets/img/favicon-kaispace.png'), true);

  const html = readFileSync('client/index.html', 'utf8');

  assert.match(html, /rel="icon"/);
  assert.match(html, /href="\/assets\/img\/favicon-kaispace\.png"/);

  const notifications = readFileSync('client/src/services/browserNotifications.ts', 'utf8');
  assert.doesNotMatch(notifications, /favico\.png/, 'notifications must use the same mark as the tab');
  assert.match(notifications, /favicon-kaispace\.png/);
});

test('login page uses the KaiSpace favicon mark, not a legacy horizontal logo', () => {
  assert.equal(existsSync('client/public/assets/img/favico.png'), true);

  const loginPage = readFileSync('client/src/pages/LoginPage.tsx', 'utf8');

  assert.match(loginPage, /src="\/assets\/img\/favico\.png"/);
  assert.match(loginPage, /alt="KaiSpace"/);
  assert.match(loginPage, />\s*KaiSpace\s*</);
  assert.doesNotMatch(loginPage, /inline-flex bg-white rounded-xl p-2/);
  assert.doesNotMatch(loginPage, /-Logo-Horizontal\.png/);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\n${passed} branding asset test(s) passed`);
