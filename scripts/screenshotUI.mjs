// Walks through MeetKai/VirtualMeet's UI and saves one screenshot per
// screen/panel/feature, so they can be handed to Claude (or pasted into
// Google Stitch) as a visual inventory for a redesign pass.
//
// Usage:
//   UI_EMAIL=you@example.com UI_PASSWORD=yourpass npm run screenshot-ui
//
// Env vars:
//   UI_BASE_URL   default: http://localhost:5173
//   UI_EMAIL      required — an existing account's login email
//   UI_PASSWORD   required — that account's password
//   UI_ROOM_SLUG  optional — a specific room's slug/join-code to open;
//                 if omitted, the script joins whichever room the account
//                 opened last (falls back to the first room in the Lobby).
//   UI_HEADLESS   default: true — set to "false" to watch it run
//
// First run needs the Chromium binary once:
//   npx playwright install chromium
//
// Output: ui-screenshots/<timestamp>/NN-name.png (gitignored — these are
// working reference images for the redesign, not something to version).
//
// This is a best-effort tour, not a full test suite: some panels need
// server-side conditions this script can't fake alone (another player in
// the room for Meeting View with 2+ tiles, an admin account for Konsol
// Admin, standing inside a zone for the zone-lock row, an existing chat
// attachment for the lightbox, etc). Anything not reachable with the given
// account/room is logged as "skipped" and the tour continues — re-run
// against a different account/room to fill in the gaps.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const BASE_URL = (process.env.UI_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
const EMAIL = process.env.UI_EMAIL;
const PASSWORD = process.env.UI_PASSWORD;
const ROOM_SLUG = process.env.UI_ROOM_SLUG || '';
const HEADLESS = process.env.UI_HEADLESS !== 'false';

if (!EMAIL || !PASSWORD) {
  console.error('Missing UI_EMAIL / UI_PASSWORD. Example:\n  UI_EMAIL=you@example.com UI_PASSWORD=yourpass npm run screenshot-ui');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = path.join(REPO_ROOT, 'ui-screenshots', stamp);
fs.mkdirSync(OUT_DIR, { recursive: true });

let shotIndex = 0;
async function shot(page, name) {
  shotIndex += 1;
  const file = path.join(OUT_DIR, `${String(shotIndex).padStart(2, '0')}-${name}.png`);
  // Let animations/transitions settle so the shot isn't mid-fade.
  await page.waitForTimeout(350);
  await page.screenshot({ path: file });
  console.log(`  saved ${path.relative(REPO_ROOT, file)}`);
}

// Best-effort click: many rows only exist for certain roles/zones/states.
// Logs and moves on instead of aborting the whole tour over one missing row.
async function tryClick(page, locator, label) {
  try {
    await locator.first().click({ timeout: 2500 });
    return true;
  } catch {
    console.log(`  (skipped — not present: ${label})`);
    return false;
  }
}

async function openFeaturesMenu(page) {
  await tryClick(page, page.getByTitle('Room Features'), 'Room Features menu');
  await page.waitForTimeout(200);
}

// The "Room Features" flyout, scoped by its distinctive class combo (not
// just any button on screen) — several rows share a word with something
// else entirely (e.g. the flyout's "Chat" row vs. the separate floating
// 💬 Chat button MessengerApp shows elsewhere), so an unscoped `hasText`
// match could click the wrong element.
function featuresMenuScope(page) {
  return page.locator('div.w-64.overflow-y-auto.rounded-xl');
}

// A feature row's label changes once its panel is open ("Chat" → "Tutup
// Chat"), so match on either half rather than hardcoding one.
async function clickMenuRow(page, closedLabel, openLabel) {
  const scope = featuresMenuScope(page);
  const locator = scope.locator('button', { hasText: closedLabel }).or(scope.locator('button', { hasText: openLabel }));
  return tryClick(page, locator, closedLabel);
}

async function main() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  // Native window.prompt/confirm (the Room Editor's portal/private-area/copy
  // flows use these) would otherwise hang the script waiting for input the
  // browser never gets from a script — auto-dismiss anything that pops up
  // outside the explicit editor steps below, which handle their own dialogs.
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Output:   ${path.relative(REPO_ROOT, OUT_DIR)}\n`);

  // ── Login ────────────────────────────────────────────────────────────
  console.log('Login page');
  await page.goto(`${BASE_URL}/${ROOM_SLUG ? `?join=${encodeURIComponent(ROOM_SLUG)}` : ''}`, { waitUntil: 'networkidle' });
  await shot(page, 'login');

  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();

  // Lands on the Lobby (no room joined) or straight into a room (an
  // auto-join is pending via ?join=, or the account has a last-room memory).
  await page.waitForSelector('canvas, text=Create Room, text=Buat Room', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);

  const inLobby = await page.locator('canvas').count() === 0;
  if (inLobby) {
    console.log('Lobby');
    await shot(page, 'lobby');

    // Create-room modal, if a button for it exists — pure UI reference, not
    // actually submitted.
    const createBtn = page.getByRole('button', { name: /create room|buat room/i });
    if (await tryClick(page, createBtn, 'Create Room button')) {
      await shot(page, 'lobby-create-room-modal');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }

    // Enter whichever room the Lobby lists first — its name is the only
    // <h3> on this page (see Lobby.tsx), and clicking it bubbles up to the
    // card's onClick(handleJoinClick) same as a real click would.
    const roomCard = page.locator('h3').first();
    await tryClick(page, roomCard, 'a room card');
    await page.waitForSelector('canvas', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
  }

  if (await page.locator('canvas').count() === 0) {
    console.error('Never reached a room (no canvas found) — check UI_ROOM_SLUG / the account has access to at least one room.');
    await browser.close();
    return;
  }

  console.log('Main room view');
  await shot(page, 'room-main-view');

  // ── Sidebar rail + Room Features flyout ─────────────────────────────
  await openFeaturesMenu(page);
  await shot(page, 'sidebar-features-menu');

  // Each entry: [closed-state label, open-state label]. Every click reopens
  // the flyout first since selecting a row closes it (see Sidebar.tsx's
  // closeAnd).
  const FEATURE_ROWS = [
    ['Meeting View', 'Exit Meeting View'],
    ['Mini Mode', 'Mini Mode'],
    ['Daily Task', 'Tutup Daily Task'],
    ['Chat', 'Tutup Chat'],
    ['Permintaan bergabung', 'Permintaan bergabung'],
    ['Kalender', 'Tutup Kalender'],
    ['Cuti', 'Tutup Cuti'],
    ['Absensi', 'Tutup Absensi'],
    ['Konsol Admin', 'Tutup Konsol Admin'],
    ['Teleport', 'Teleport'],
    ['Add Media', 'Add Media'],
  ];
  for (const [closed, open] of FEATURE_ROWS) {
    await openFeaturesMenu(page);
    const clicked = await clickMenuRow(page, closed, open);
    if (!clicked) continue;
    await shot(page, `panel-${closed.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
  }
  // Simplify toggles simplified view — shoot it last since it hides the rail.
  await openFeaturesMenu(page);
  if (await clickMenuRow(page, 'Simplify', 'Simplify')) {
    await shot(page, 'simplified-view');
    await page.getByTitle('Show UI').click().catch(() => {});
    await page.waitForTimeout(200);
  }

  // ── Avatar editor + status ───────────────────────────────────────────
  if (await tryClick(page, page.getByTitle('Edit Avatar'), 'Edit Avatar button')) {
    await shot(page, 'avatar-editor');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }

  // ── Room Editor (admin only — silently skipped otherwise since the page
  // itself renders an "akses ditolak" message rather than throwing) ────
  console.log('Room Editor');
  const editorUrl = new URL(page.url());
  const roomSlugFromUrl = editorUrl.searchParams.get('join') || ROOM_SLUG;
  // The slug actually joined may differ from what was requested (Lobby
  // fallback) — read it back from the room's own "Copy room code" affordance
  // isn't reliable to automate, so this only works when UI_ROOM_SLUG was
  // given explicitly. Otherwise this step is skipped with a note.
  if (roomSlugFromUrl) {
    const editorPage = await context.newPage();
    await editorPage.goto(`${BASE_URL}/?roomEditor=${encodeURIComponent(roomSlugFromUrl)}`, { waitUntil: 'networkidle' });
    await editorPage.waitForTimeout(800);
    if (await editorPage.locator('canvas').count() > 0) {
      // Same numbered-file convention as shot(), on the editor's own tab —
      // shotIndex is shared so file numbers stay in one continuous sequence
      // across both pages instead of restarting at 01.
      const layerShot = async (name) => { await editorPage.waitForTimeout(350); shotIndex += 1; const f = path.join(OUT_DIR, `${String(shotIndex).padStart(2, '0')}-${name}.png`); await editorPage.screenshot({ path: f }); console.log(`  saved ${path.relative(REPO_ROOT, f)}`); };
      for (const layer of ['Floor', 'Wall', 'Objects', 'Top objects', 'Tile effects']) {
        if (await tryClick(editorPage, editorPage.getByTitle(layer, { exact: false }).or(editorPage.locator('button', { hasText: layer })), `editor layer ${layer}`)) {
          await layerShot(`editor-layer-${layer.toLowerCase().replace(/\s+/g, '-')}`);
        }
      }
      await tryClick(editorPage, editorPage.getByTitle('Resize map'), 'Resize map button');
      await layerShot('editor-resize-modal');
    } else {
      console.log('  (skipped — this account is not admin on this room, or the room slug could not be resolved)');
    }
    await editorPage.close();
  } else {
    console.log('  (skipped — pass UI_ROOM_SLUG explicitly to capture the Room Editor)');
  }

  console.log(`\nDone. ${shotIndex} screenshots in ${path.relative(REPO_ROOT, OUT_DIR)}`);
  await browser.close();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
