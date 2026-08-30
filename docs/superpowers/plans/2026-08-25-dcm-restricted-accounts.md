# DCM Restricted Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create ~26 real login accounts (from `DCM_Password_List.xlsx`) that can only ever see and enter one specific room ("DCM") in the existing Kaitech organization, and never see any Lark-linked Sidebar feature — enforced server-side at every boundary, not just hidden in the UI.

**Architecture:** One additive nullable `User.restrictedToRoomId` field, checked at three server boundaries (`GET /rooms`, `GET /rooms/:slug`, the `JOIN_ROOM` socket handler) that already have an identical "wrong access reads as not-found" pattern for cross-org rejection — this new check slots in right beside each one. Exposed to the client via the existing shared `publicUser()` projection so it rides along on every auth response (register, login, `/me`, org-invite accept), driving four new Sidebar gates. Accounts are created by a one-off script mirroring the existing `seedKaitechRoom.ts` precedent, reading credentials directly from the untracked spreadsheet at run time.

**Tech Stack:** TypeScript, Express, Socket.IO, Prisma/Postgres, React, `exceljs`, `bcryptjs`, `tsx` (already available in the production container).

## Global Constraints

- Accounts stay in the EXISTING Kaitech/default organization (`DEFAULT_ORG_ID`) — not a new, separate Organization.
- Restriction is to exactly ONE room per account — no multi-room allowlist.
- Enforcement is real server-side rejection at three boundaries (Lobby list, direct slug fetch, `JOIN_ROOM`) — not merely hidden in the UI.
- ALL FOUR Lark-linked Sidebar items (Chat/Messenger, Absensi, Daily Task, Cuti/Izin) are hidden uniformly for a restricted account — not a partial subset.
- Account creation is a ONE-OFF SCRIPT, not a new reusable bulk-import admin feature.
- The script reads credentials directly from `DCM_Password_List.xlsx` at run time — the plaintext password must NEVER be embedded in any committed source file or logged by the script.
- `DCM_Password_List.xlsx` must never be committed (already added to `.gitignore` — see Task 1).
- `restrictedToRoomId: null` (every existing account) must be completely unaffected by every change in this plan.

---

### Task 1: Schema — `User.restrictedToRoomId` + migration

**Files:**
- Modify: `server/prisma/schema.prisma` (`User` model, `Room` model)
- Create: `server/prisma/migrations/<timestamp>_dcm_restricted_accounts/migration.sql`

**Interfaces:**
- Produces: `User.restrictedToRoomId: string | null` — consumed by every later task.

- [ ] **Step 1: Add the field to `User`**

In `server/prisma/schema.prisma`, the `User` model currently has this pair (around line 147-148), the exact style to mirror:

```prisma
  departmentId            String?
  department              Department?               @relation(fields: [departmentId], references: [id], onDelete: SetNull)
```

Add a new pair immediately after it:

```prisma
  departmentId            String?
  department              Department?               @relation(fields: [departmentId], references: [id], onDelete: SetNull)
  // DCM restricted accounts (specs/2026-08-25-dcm-restricted-accounts-design.md)
  // — null (every account today) means completely unrestricted, no behavior
  // change. Set = this account may only see/enter this one Room (enforced
  // in rooms.ts's GET /rooms and GET /rooms/:slug, and roomHandler.ts's
  // JOIN_ROOM) and never sees a Lark-linked Sidebar item (Sidebar.tsx).
  // onDelete: SetNull — if the room is ever deleted, the account falls back
  // to unrestricted rather than pointing at a dangling id; re-restricting
  // it in that edge case is a separate, later admin decision.
  restrictedToRoomId      String?
  restrictedToRoom        Room?                     @relation(fields: [restrictedToRoomId], references: [id], onDelete: SetNull)
```

- [ ] **Step 2: Add the reverse relation to `Room`**

In `server/prisma/schema.prisma`, the `Room` model currently ends with (around line 1070):

```prisma
  lastPositions     RoomLastPosition[]
}
```

Change to:

```prisma
  lastPositions     RoomLastPosition[]
  // Reverse side of User.restrictedToRoomId above — Prisma requires both
  // directions of a named relation to be declared.
  restrictedUsers   User[]
}
```

- [ ] **Step 3: Write the migration SQL by hand**

This repo's established convention (local Docker access is unreliable from this shell) — hand-author `migration.sql`, then verify against the local dev Postgres container.

```bash
ls server/prisma/migrations | tail -3
```

Create `server/prisma/migrations/<next-timestamp>_dcm_restricted_accounts/migration.sql` (timestamp one later than the most recent existing migration — at time of writing that's `20260825010000_calendar_meetkai_zone_index`, so `20260825020000` is the next free slot; confirm against the real directory listing before picking the final value):

```sql
-- AlterTable
ALTER TABLE "User" ADD COLUMN "restrictedToRoomId" TEXT;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_restrictedToRoomId_fkey" FOREIGN KEY ("restrictedToRoomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 4: Apply and verify against the local dev Postgres container**

```bash
docker exec -i meetkai-dev-postgres psql -U postgres -d virtualmeet -c '\d "User"'
```

Confirm `restrictedToRoomId` is NOT yet present, then apply:

```bash
cd server && npx prisma migrate deploy
```

Re-run `\d "User"` and confirm `restrictedToRoomId` (text, nullable) and its new foreign-key constraint are present. (If the container name isn't `meetkai-dev-postgres` on this machine, find the right one — check `server/.env`'s `DATABASE_URL` for the port and match it against `docker ps`.)

- [ ] **Step 5: Regenerate the Prisma client and typecheck**

```bash
cd server && npx prisma generate
npm run typecheck --workspace=server
```

Expected: PASS (no code references the new column yet — this just confirms the generated client compiles).

- [ ] **Step 6: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations
git commit -m "feat: add User.restrictedToRoomId for DCM restricted accounts"
```

(`.gitignore`'s `DCM_Password_List.xlsx` entry was already added and does not need a separate commit here — confirm with `git status` that the file itself still shows as untracked/ignored, not staged.)

---

### Task 2: Server — enforce the restriction at three boundaries

**Files:**
- Modify: `server/src/middleware/auth.ts` (`AuthRequest`, `authenticateToken`)
- Modify: `server/src/index.ts` (`io.use()` handshake)
- Modify: `server/src/socket/roomHandler.ts` (`JOIN_ROOM` handler)
- Modify: `server/src/routes/rooms.ts` (`GET /rooms`, `GET /rooms/:slug`)
- Modify: `server/src/lib/publicUser.ts` (`PublicUserFields`, `publicUser`)
- Modify: `server/src/routes/auth.ts` (`GET /me`'s `select`)

**Interfaces:**
- Consumes: `User.restrictedToRoomId` (Task 1).
- Produces: `AuthRequest.restrictedToRoomId: string | null | undefined` (REST requests), `socket.data.restrictedToRoomId: string | null | undefined` (sockets), and `restrictedToRoomId` on every `publicUser()`-shaped response — all consumed by Task 3 (client).

- [ ] **Step 1: Thread `restrictedToRoomId` through `AuthRequest`/`authenticateToken`**

In `server/src/middleware/auth.ts`, the `AuthRequest` interface currently ends with (right before the closing brace, after `sessionId?: string;`):

```typescript
  // Bug 1 — the token's sessionId claim; /auth/me preserves it on refresh so
  // the same device keeps one session across sliding-refresh.
  sessionId?: string;
}
```

Add a new field:

```typescript
  // Bug 1 — the token's sessionId claim; /auth/me preserves it on refresh so
  // the same device keeps one session across sliding-refresh.
  sessionId?: string;
  // DCM restricted accounts — resolved fresh from the DB by authenticateToken
  // below, same "never from the token" posture as organizationId above (the
  // token predates this field and isn't reissued just to add a claim).
  restrictedToRoomId?: string | null;
}
```

In the same file, `authenticateToken`'s current combined query:

```typescript
  let organizationId: string | undefined;
  try {
    const user = await getPrisma().user.findUnique({ where: { id: decoded.userId }, select: { currentSessionId: true, organizationId: true } });
    if (user?.currentSessionId && decoded.sessionId !== user.currentSessionId) {
      return res.status(401).json({ error: SESSION_SUPERSEDED, message: SESSION_SUPERSEDED_MESSAGE });
    }
    organizationId = user?.organizationId;
  } catch (e) {
    console.error('[auth] session/org lookup error:', e);
  }
  req.userId = decoded.userId;
  req.organizationId = organizationId;
  req.tokenExp = decoded.exp;
  req.sessionId = decoded.sessionId;
  next();
```

Change to:

```typescript
  let organizationId: string | undefined;
  let restrictedToRoomId: string | null | undefined;
  try {
    const user = await getPrisma().user.findUnique({ where: { id: decoded.userId }, select: { currentSessionId: true, organizationId: true, restrictedToRoomId: true } });
    if (user?.currentSessionId && decoded.sessionId !== user.currentSessionId) {
      return res.status(401).json({ error: SESSION_SUPERSEDED, message: SESSION_SUPERSEDED_MESSAGE });
    }
    organizationId = user?.organizationId;
    restrictedToRoomId = user?.restrictedToRoomId;
  } catch (e) {
    console.error('[auth] session/org lookup error:', e);
  }
  req.userId = decoded.userId;
  req.organizationId = organizationId;
  req.restrictedToRoomId = restrictedToRoomId;
  req.tokenExp = decoded.exp;
  req.sessionId = decoded.sessionId;
  next();
```

- [ ] **Step 2: Thread it through the socket handshake**

In `server/src/index.ts`, the `io.use()` handshake's combined query currently reads (around line 198-210):

```typescript
      let organizationId: string | undefined;
      try {
        const user = await getPrisma().user.findUnique({ where: { id: claims.userId }, select: { currentSessionId: true, organizationId: true } });
        if (user?.currentSessionId && claims.sessionId !== user.currentSessionId) {
          return next(new Error(SESSION_SUPERSEDED));
        }
        organizationId = user?.organizationId;
      } catch (e) {
        console.error('[auth] socket session/org lookup error:', e);
      }
      socket.data.userId = claims.userId;
      socket.data.sessionId = claims.sessionId;
      socket.data.organizationId = organizationId;
```

Change to:

```typescript
      let organizationId: string | undefined;
      let restrictedToRoomId: string | null | undefined;
      try {
        const user = await getPrisma().user.findUnique({ where: { id: claims.userId }, select: { currentSessionId: true, organizationId: true, restrictedToRoomId: true } });
        if (user?.currentSessionId && claims.sessionId !== user.currentSessionId) {
          return next(new Error(SESSION_SUPERSEDED));
        }
        organizationId = user?.organizationId;
        restrictedToRoomId = user?.restrictedToRoomId;
      } catch (e) {
        console.error('[auth] socket session/org lookup error:', e);
      }
      socket.data.userId = claims.userId;
      socket.data.sessionId = claims.sessionId;
      socket.data.organizationId = organizationId;
      socket.data.restrictedToRoomId = restrictedToRoomId;
```

- [ ] **Step 3: Reject `JOIN_ROOM` for any room other than the allowed one**

In `server/src/socket/roomHandler.ts`, the `JOIN_ROOM` handler's existing cross-org rejection (the exact pattern this mirrors) currently reads:

```typescript
      if (enteringUid && approvalRoom && enteringOrgId !== approvalRoom.organizationId) {
        socket.emit(SocketEvents.JOIN_DENIED, { roomSlug: room, reason: 'not-found' });
        return;
      }
```

Add a new check immediately after it, still before the `restrictedAccess` block that follows:

```typescript
      if (enteringUid && approvalRoom && enteringOrgId !== approvalRoom.organizationId) {
        socket.emit(SocketEvents.JOIN_DENIED, { roomSlug: room, reason: 'not-found' });
        return;
      }

      // DCM restricted accounts — same "reads as not-found, never a distinct
      // reason that would confirm the room exists" posture as the org check
      // just above. approvalRoom is already fetched; if the lookup itself
      // failed (approvalRoom null), fail CLOSED here specifically for a
      // restricted account — unlike the general "can't tell, treat as
      // walk-in" fallback a few lines up, a restricted account must never
      // get the benefit of the doubt on an unreadable room.
      const enteringRestrictedToRoomId = (socket.data as { restrictedToRoomId?: string | null }).restrictedToRoomId;
      if (enteringUid && enteringRestrictedToRoomId && approvalRoom?.id !== enteringRestrictedToRoomId) {
        socket.emit(SocketEvents.JOIN_DENIED, { roomSlug: room, reason: 'not-found' });
        return;
      }
```

Read the surrounding function in full before editing to confirm `approvalRoom`'s exact current type/nullability (`{ id: string; ownerId: string; requiresApproval: boolean; restrictedAccess: boolean; restrictedMinRole: string; queueEnabled: boolean; slug: string; name: string; organizationId: string } | null`, per the current code) still matches what's shown here — this plan's citations reflect the file as read during planning; confirm nothing has shifted before inserting.

- [ ] **Step 4: `GET /rooms` — show only the allowed room**

In `server/src/routes/rooms.ts`, the current handler:

```typescript
rooms.get('/rooms', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
    const prisma = getPrisma();
    const roomList = await prisma.room.findMany({
      where: { isPublic: true, organizationId: req.organizationId },
      include: {
        owner: { select: { displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
```

Change the `where` clause:

```typescript
rooms.get('/rooms', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
    const prisma = getPrisma();
    // DCM restricted accounts — a restricted account's Lobby shows exactly
    // one room (or zero, if it's since been deleted), never the org's full
    // public list.
    const roomList = await prisma.room.findMany({
      where: req.restrictedToRoomId
        ? { id: req.restrictedToRoomId, organizationId: req.organizationId }
        : { isPublic: true, organizationId: req.organizationId },
      include: {
        owner: { select: { displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
```

- [ ] **Step 5: `GET /rooms/:slug` — 404 for any room other than the allowed one**

Current handler:

```typescript
    if (!room || room.organizationId !== req.organizationId) {
      return res.status(404).json({ error: 'Room not found' });
    }
```

Change to:

```typescript
    if (!room || room.organizationId !== req.organizationId) {
      return res.status(404).json({ error: 'Room not found' });
    }
    // DCM restricted accounts — same "can't tell 404 from wrong-access"
    // posture as the org check just above.
    if (req.restrictedToRoomId && room.id !== req.restrictedToRoomId) {
      return res.status(404).json({ error: 'Room not found' });
    }
```

- [ ] **Step 6: Expose it on every auth response via the shared `publicUser()` projection**

In `server/src/lib/publicUser.ts`, the current file:

```typescript
import { User } from '@prisma/client';

// The client-safe projection of a User row — every auth response (register,
// login, /me, org-invite accept) building its own shape inline meant the
// shape had quietly drifted (login/`/me` included avatarConfig, the others
// didn't) instead of being a single decision.

type PublicUserFields = Pick<
  User,
  'id' | 'email' | 'displayName' | 'fullName' | 'accountRole' | 'workspaceRole' | 'timezone' | 'tutorialCompletedAt' | 'preferences'
>;

export function publicUser(user: PublicUserFields) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    fullName: user.fullName,
    accountRole: user.accountRole,
    workspaceRole: user.workspaceRole,
    timezone: user.timezone,
    tutorialCompletedAt: user.tutorialCompletedAt,
    preferences: user.preferences,
  };
}
```

Change to:

```typescript
import { User } from '@prisma/client';

// The client-safe projection of a User row — every auth response (register,
// login, /me, org-invite accept) building its own shape inline meant the
// shape had quietly drifted (login/`/me` included avatarConfig, the others
// didn't) instead of being a single decision.

type PublicUserFields = Pick<
  User,
  'id' | 'email' | 'displayName' | 'fullName' | 'accountRole' | 'workspaceRole' | 'timezone' | 'tutorialCompletedAt' | 'preferences' | 'restrictedToRoomId'
>;

export function publicUser(user: PublicUserFields) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    fullName: user.fullName,
    accountRole: user.accountRole,
    workspaceRole: user.workspaceRole,
    timezone: user.timezone,
    tutorialCompletedAt: user.tutorialCompletedAt,
    preferences: user.preferences,
    // DCM restricted accounts — null for every account except the ones this
    // feature creates; drives Sidebar.tsx's four Lark-feature gates and the
    // room-visibility restriction enforced server-side elsewhere.
    restrictedToRoomId: user.restrictedToRoomId,
  };
}
```

There are exactly 4 call sites of `publicUser`/`publicUserWithAvatar` across the codebase (confirmed via `grep -rln "publicUser(" server/src/routes/` — only `auth.ts` and `orgInvite.ts` match). Only ONE of the four needs a code change:

- `auth.ts`'s `POST /register` (`publicUser(user)`, around line 146) — `user` comes from `prisma.user.create({ data: {...} })` with **no** explicit `select`, so Prisma already returns the full row. No change needed; `restrictedToRoomId` (always `null` for a fresh registration) arrives automatically once the Prisma client is regenerated (Task 1 Step 5 already did this).
- `auth.ts`'s `POST /login` (`publicUserWithAvatar(user)`, around line 180) — `user` comes from `prisma.user.findUnique({ where: { email } })`, also with no explicit `select` — same as above, no change needed.
- `orgInvite.ts`'s org-invite-accept (`publicUser(user)`, around line 156) — `user` comes from `prisma.user.create({ data: {...} })`, also no explicit `select` — no change needed.
- `auth.ts`'s `GET /me` (`publicUserWithAvatar(user)`, around line 291) — THIS ONE has an explicit narrow `select` (around line 202-220) that currently lists `id, email, displayName, fullName, avatarConfig, preferences, accountRole, workspaceRole, timezone, active, larkOpenId, currentSessionId, tutorialCompletedAt, organizationId`. Add `restrictedToRoomId: true` to that same list — this is the only required code change in this step.

Confirm this reasoning still holds by reading each of the three "no change needed" call sites' actual current query before skipping them — this plan's citations reflect the file as read during planning.

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck --workspace=server
```

- [ ] **Step 8: Commit**

```bash
git add server/src/middleware/auth.ts server/src/index.ts server/src/socket/roomHandler.ts server/src/routes/rooms.ts server/src/lib/publicUser.ts server/src/routes/auth.ts
git commit -m "feat: enforce DCM restricted-account room boundary at GET /rooms, GET /rooms/:slug, and JOIN_ROOM"
```

---

### Task 3: Client — hide Lark-linked Sidebar items for a restricted account

**Files:**
- Modify: `client/src/services/api.ts` (`UserProfile`)
- Modify: `client/src/components/ui/Sidebar.tsx` (four gating conditions)
- Modify: `client/src/App.tsx` (the `<Sidebar>` render call site)

**Interfaces:**
- Consumes: `restrictedToRoomId` on every auth response (Task 2).
- Produces: nothing consumed by a later task — this is the leaf UI for Task 2's server work.

- [ ] **Step 1: Add the field to `UserProfile`**

In `client/src/services/api.ts`, the current `isDefaultOrg` field:

```typescript
  isDefaultOrg?: boolean;
```

Add immediately after it:

```typescript
  isDefaultOrg?: boolean;
  // DCM restricted accounts — null/undefined for every account except the
  // ones that feature creates. Drives Sidebar.tsx's four Lark-feature gates;
  // the actual room-visibility restriction is enforced server-side
  // (server/src/routes/rooms.ts, server/src/socket/roomHandler.ts).
  restrictedToRoomId?: string | null;
```

- [ ] **Step 2: Add the new prop to `Sidebar`**

In `client/src/components/ui/Sidebar.tsx`, `SidebarProps` currently has (around line 127):

```typescript
  isDefaultOrg: boolean;
```

Add immediately after it:

```typescript
  isDefaultOrg: boolean;
  isRestrictedAccount?: boolean;
```

Where the component destructures its props (around line 267, alongside `isDefaultOrg,`), add `isRestrictedAccount,` to the same destructure list.

- [ ] **Step 3: Gate the four Lark-linked items**

Four conditions in this file need `!isRestrictedAccount` added. Read the current file first to confirm these line numbers haven't shifted, then apply each:

Daily Task (currently `{!isGuest && isDefaultOrg && (` around line 411):
```typescript
            {!isGuest && isDefaultOrg && !isRestrictedAccount && (
```

Chat/Messenger (currently `{!isGuest && (` around line 416, immediately before the `ChatDotsFill`/"Chat" `MenuRow`):
```typescript
            {!isGuest && !isRestrictedAccount && (
```

Cuti/Izin (currently `{!isGuest && isDefaultOrg && (` around line 436, immediately before the `Airplane`/"Cuti" `MenuRow` — a SEPARATE block from Daily Task above, both share the same condition text but are two different `{...}` blocks; edit both, not just the first match):
```typescript
            {!isGuest && isDefaultOrg && !isRestrictedAccount && (
```

Absensi/Lark attendance (currently `{!isGuest && (` around line 450, immediately before the `ClockHistory`/"Absensi" `MenuRow` tagged "A12 — new Lark-backed attendance panel" in the comment just above it — do NOT touch the OTHER, currently-flag-disabled `ATTENDANCE_MENU_ENABLED &&` block a few lines above this one, which renders for nobody today regardless of this change):
```typescript
            {!isGuest && !isRestrictedAccount && (
```

- [ ] **Step 4: Pass the prop from `App.tsx`**

In `client/src/App.tsx`, the current `<Sidebar>` render (around line 2208):

```typescript
        isDefaultOrg={currentUser.isDefaultOrg}
```

Add immediately after it:

```typescript
        isDefaultOrg={currentUser.isDefaultOrg}
        isRestrictedAccount={!!currentUser.restrictedToRoomId}
```

(Confirm `currentUser` here is the same `UserProfile`-typed value Task 3 Step 1 added the field to — read the surrounding code first if the variable name differs from what this plan assumes.)

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck --workspace=client
```

- [ ] **Step 6: Commit**

```bash
git add client/src/services/api.ts client/src/components/ui/Sidebar.tsx client/src/App.tsx
git commit -m "feat: hide Lark-linked Sidebar items for a DCM restricted account"
```

---

### Task 4: Server — `seedDcmAccounts.ts` script

**Files:**
- Create: `server/scripts/seedDcmAccounts.ts`

**Interfaces:**
- Consumes: `User.restrictedToRoomId` (Task 1), `createRoomLayoutFromTemplate` (`@virtualmeet/shared`), `DCM_Password_List.xlsx` (repo root, gitignored).
- Produces: the `dcm` Room and ~26 `User`/`RoomMember` rows — nothing else in this plan consumes this script's output at the code level (it's a one-time operational step, verified manually).

- [ ] **Step 1: Confirm the spreadsheet's real row count and column layout before writing the script**

```bash
cd "$(git rev-parse --show-toplevel)" && node -e "
const ExcelJS = require('exceljs');
const wb = new ExcelJS.Workbook();
wb.xlsx.readFile('DCM_Password_List.xlsx').then(() => {
  wb.eachSheet((sheet) => {
    console.log('sheet:', sheet.name, 'rows:', sheet.rowCount);
  });
});
"
```

Note the actual row count (expected ~27 including the header row = ~26 accounts) and confirm the sheet name and column order (email in column 2, password in column 3, per a manual check already done during this feature's design — column 1 is blank) still match before writing Step 3's parsing code. Do not print any row's actual email/password to the terminal in this step or any later one — count only.

- [ ] **Step 2: Write the script's room-creation half, adapted from `seedKaitechRoom.ts`**

`server/scripts/seedKaitechRoom.ts` (read the whole file — reproduced here for reference) is the direct structural template: idempotent by fixed slug, `dotenv/config` for env loading, `getPrisma()` for the DB connection, logs a summary at the end, `main().catch(...)` with a non-zero exit on failure. This script uses a GENERIC layout (`createRoomLayoutFromTemplate`, not the Kaitech-specific `createKaitechOfficeLayout`) since there's no bespoke DCM office design — `main-office`/default template, matching what `POST /rooms` itself defaults to for an unspecified template.

```typescript
// One-off, idempotent creator for the "DCM" room + its ~26 restricted
// accounts (specs/2026-08-25-dcm-restricted-accounts-design.md). Reads
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
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import { getPrisma } from '../src/lib/prisma';
import { ensureGroupConversation } from '../src/lib/conversations';
import { DEFAULT_ORG_ID } from '../src/lib/defaultOrg';
import { createRoomLayoutFromTemplate } from '@virtualmeet/shared';

const SLUG = 'dcm';
const ROOM_NAME = 'DCM';
const XLSX_PATH = path.resolve(__dirname, '../../DCM_Password_List.xlsx');

async function loadCredentials(): Promise<{ email: string; password: string }[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(XLSX_PATH);
  const sheet = workbook.worksheets[0];
  const rows: { email: string; password: string }[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header row
    const email = String(row.getCell(2).value ?? '').trim().toLowerCase();
    const password = String(row.getCell(3).value ?? '');
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
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck --workspace=server
```

(This checks the script compiles; it does NOT run it — running against a real database is Manual Testing's job, not this step's.)

- [ ] **Step 4: Commit**

```bash
git add server/scripts/seedDcmAccounts.ts
git commit -m "feat: add one-off script to create the DCM room and its restricted accounts"
```

Confirm `git status` shows `DCM_Password_List.xlsx` as ignored (not untracked-and-about-to-be-added) before this commit — it must never appear in `git add`'s output.

---

## Manual Testing After Deploy

Run these AFTER all four tasks are deployed to production — the seed script (Task 4) must only ever run against real production data, once, as a deliberate manual step (not part of any automated task verification above).

1. SSH into the production server, run the seed script once inside the server container: `docker exec office-server-1 npx tsx server/scripts/seedDcmAccounts.ts` (the spreadsheet must already be present at the repo root on the VPS — copy it there first if it isn't, e.g. via `scp`; never commit it). Confirm the log reports creating the `dcm` room and the same account count Task 4 Step 1 confirmed in the spreadsheet (0 skipped on this first run).
2. Run the exact same command again. Confirm it reports the `dcm` room already exists, and every account is now "already existed (skipped)" — 0 newly created.
3. Log in as one of the created accounts (using its real email + the shared password from the spreadsheet). Confirm the Lobby shows ONLY the `dcm` room — no other room appears, even ones this account's org would normally see.
4. Still logged in as that account, confirm none of Chat/Messenger, Absensi, Daily Task, or Cuti/Izin appear anywhere in the Sidebar.
5. Still logged in as that account, attempt to navigate directly to a KNOWN other room's URL/slug (e.g. `kaitech`). Confirm it's rejected (404 from the REST fetch, and/or a denied join if you also try connecting the socket) — not silently allowed in.
6. Still logged in as that account, actually enter and use the `dcm` room itself — confirm normal movement, chat, and other in-room features all work exactly as they would for any unrestricted account. The restriction is about OTHER rooms, not about `dcm` itself.
7. Log in as a normal, unrestricted existing account (e.g. your own). Confirm the Lobby shows the full room list exactly as before, and every Sidebar item that was visible before this deploy is still visible — this feature must not have changed anything for an account with `restrictedToRoomId: null`.
8. Re-run the seed script a third time and confirm the account from step 3 can still log in with the SAME password afterward — the idempotent upsert-by-email in Task 4 must never silently overwrite an already-active account's password.
