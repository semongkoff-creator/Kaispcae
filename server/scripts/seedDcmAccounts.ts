// One-off, idempotent creator for the "DCM" room + its ~26 restricted
// accounts (docs/superpowers/specs/2026-08-25-dcm-restricted-accounts-design.md). Reads
// credentials directly from DCM_Password_List.xlsx (repo root, gitignored —
// see that file's own comment in .gitignore) at run time — the plaintext
// password is NEVER embedded in this file or logged.
//
// Idempotent: the room is created-or-reused by a fixed slug ('dcm'), and
// each account is created-or-skipped by email — a second run does not
// duplicate the room or overwrite an already-active account's password.
//
// Run with: npx tsx server/scripts/seedDcmAccounts.ts
// (tsx is already a project dependency, confirmed available in the
// production container the same way server/scripts/seedKaitechRoom.ts
// already runs there.)

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import { getPrisma } from '../src/lib/prisma';
import { ensureGroupConversation } from '../src/lib/conversations';
import { DEFAULT_ORG_ID } from '../src/lib/defaultOrg';
import { createRoomLayoutFromTemplate } from '@kaispace/shared';

const SLUG = 'dcm';
const ROOM_NAME = 'DCM';
// server/package.json has "type": "module", so this file runs as ESM under
// tsx — __dirname is not defined there. fileURLToPath(new URL('.', import.meta.url))
// is the ESM-safe equivalent of __dirname (resolves to this file's directory).
const XLSX_PATH = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../DCM_Password_List.xlsx');

async function loadCredentials(): Promise<{ email: string; password: string }[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(XLSX_PATH);
  const sheet = workbook.worksheets[0];
  const rows: { email: string; password: string }[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) {
      // Validate the header instead of blindly skipping it — if the real
      // spreadsheet's columns were ever reordered (e.g. a Name column
      // inserted before Email), every data row below would still pass the
      // non-empty check and we'd silently create accounts with wrong data.
      const col1 = String(row.getCell(1).value ?? '').trim().toLowerCase();
      const col2 = String(row.getCell(2).value ?? '').trim().toLowerCase();
      if (col1 !== 'email' || col2 !== 'password') {
        // Never interpolate column 2's raw value here — it's the password
        // column, and if row 1 turns out to be a data row rather than a
        // real header (the most likely way this check ever fires), that
        // value is a real plaintext password. Report which columns failed
        // to match, never what they actually contained.
        throw new Error(
          `[seedDcmAccounts] unexpected header row — expected columns 1,2 to be "Email","Password" but ${col1 !== 'email' ? 'column 1 did not read as "Email"' : 'column 1 is fine'} and ${col2 !== 'password' ? 'column 2 did not read as "Password"' : 'column 2 is fine'}. Refusing to proceed.`
        );
      }
      return;
    }
    // ExcelJS can hand back an object (not a string) for rich-text/formula/
    // hyperlink cells. Coercing that straight to a string would silently
    // produce the literal "[object Object]", which then gets bcrypt-hashed
    // as if it were a real password — skip and warn instead.
    const cell1Value = row.getCell(1).value;
    const cell2Value = row.getCell(2).value;
    if ((typeof cell1Value === 'object' && cell1Value !== null) || (typeof cell2Value === 'object' && cell2Value !== null)) {
      console.warn(`[seedDcmAccounts] row ${rowNumber}: cell value is a rich object (not plain text), skipped`);
      return;
    }
    const email = String(cell1Value ?? '').trim().toLowerCase();
    const password = String(cell2Value ?? '');
    if (!email || !password) {
      console.warn(`[seedDcmAccounts] row ${rowNumber}: missing email or password, skipped`);
      return;
    }
    rows.push({ email, password });
  });
  return rows;
}

async function main() {
  const prisma = getPrisma();

  const credentials = await loadCredentials();
  console.log(`[seedDcmAccounts] loaded ${credentials.length} credential row(s) from ${XLSX_PATH}`);

  const owner = await prisma.user.findFirst({ where: { organizationId: DEFAULT_ORG_ID, accountRole: 'admin' } });
  if (!owner) {
    throw new Error('No admin-role user found in the default organization — needed as the new room\'s owner.');
  }

  let room = await prisma.room.findUnique({ where: { slug: SLUG } });
  if (!room) {
    // No bespoke DCM office design exists — use the same generic layout
    // ('main-office', i.e. templateId=undefined) and default theme
    // ('scifi-office') that POST /api/rooms itself falls back to when a
    // caller doesn't specify a template (see routes/rooms.ts).
    const layout = createRoomLayoutFromTemplate(undefined, 'scifi-office');
    room = await prisma.room.create({
      data: {
        name: ROOM_NAME,
        slug: SLUG,
        maxPlayers: 50,
        isPublic: true,
        organizationId: DEFAULT_ORG_ID,
        ownerId: owner.id,
        tilemapData: layout.tiles as any,
        furniture: layout.furniture as any,
        zones: layout.zones as any,
      },
    });
    await prisma.roomMember.create({ data: { userId: owner.id, roomId: room.id, role: 'admin' } });
    const general = await prisma.channel.create({ data: { roomId: room.id, name: 'general', isDefault: true } });
    await ensureGroupConversation(prisma, general);
    console.log(`[seedDcmAccounts] Created room '${SLUG}' (id=${room.id}), owner=${owner.email}`);
  } else {
    console.log(`[seedDcmAccounts] Room '${SLUG}' already exists (id=${room.id}) — reusing, layout untouched`);
  }

  let created = 0;
  let skipped = 0;
  for (const cred of credentials) {
    const existing = await prisma.user.findUnique({ where: { email: cred.email } });
    if (existing) {
      // Surface WHICH email collided (never the password) — the existing
      // account may already be in the org unrestricted, and this script
      // would otherwise leave it that way with no visible signal.
      console.warn(`[seedDcmAccounts] ${cred.email}: account already exists, skipped (left as-is, not restricted)`);
      skipped++;
      continue;
    }
    const hashed = await bcrypt.hash(cred.password, 12);
    const user = await prisma.user.create({
      data: {
        organizationId: DEFAULT_ORG_ID,
        email: cred.email,
        password: hashed,
        displayName: cred.email.split('@')[0],
        restrictedToRoomId: room.id,
      },
    });
    await prisma.roomMember.create({ data: { userId: user.id, roomId: room.id, role: 'member' } });
    created++;
  }

  console.log(`[seedDcmAccounts] Done — ${created} account(s) created, ${skipped} already existed (skipped).`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[seedDcmAccounts] FAILED:', err);
  process.exit(1);
});
