# Last-Seen Timestamp for Offline Members Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Pertama masuk" (first-ever-join) timestamp shown for offline members in the Participant Panel with "Terakhir masuk" (last-seen) — a member's most recent room-activity start time — so a viewer can tell "was online recently, now off" apart from "never came online at all."

**Architecture:** Add `User.lastSeenAt` (new, additive column) alongside the existing `User.firstSeenAt` (left untouched, no longer read anywhere). Backfill `lastSeenAt` from `MAX(StatusInterval.startedAt)` per user. Going forward, `openStatusInterval` unconditionally overwrites `lastSeenAt` on every call (room join or work-mode change) — no atomicity guard needed, since every write is meant to win. `GET /org/members` swaps its exposed field from `firstSeenAt` to `lastSeenAt`; the client renames the prop and swaps the Indonesian copy from "Pertama masuk" to "Terakhir masuk", reusing the two existing generic timestamp formatters unchanged.

**Tech Stack:** Prisma (Postgres), Express, React/TypeScript. No new dependency — reuses `formatRelativeTimeId`/`formatExactDateTimeId` from `client/src/utils/relativeTime.ts` exactly as they already exist.

## Global Constraints

- "Terakhir masuk" REPLACES "Pertama masuk" entirely in the UI — never shown alongside it.
- New column `User.lastSeenAt` — do NOT repurpose or rename `User.firstSeenAt`. It stays in the schema with its already-backfilled data, untouched, just no longer selected/exposed via the API or rendered anywhere.
- "Terakhir masuk" = the `startedAt` of the member's most recent `StatusInterval` row — updates on every `openStatusInterval` call (room join OR work-mode change alike), not just genuine room re-entries, and not the moment they went offline (`endedAt`).
- A user with zero `StatusInterval` rows ever stays `lastSeenAt: NULL` forever, rendered as "Belum pernah masuk" (unchanged copy, unchanged null-handling pattern).
- `lastSeenAt` is overwritten UNCONDITIONALLY on every `openStatusInterval` call — no "set if null" guard, since there is no "only once" constraint; last write always wins.
- The Offline list's existing org-wide scope (every active `User` minus currently-connected, not room-scoped) must not change.
- Do not show this timestamp for online members, only offline ones.
- Do not change `StatusInterval`'s own existing read/write semantics, room-join flow, or any other behavior of `openStatusInterval` beyond swapping the `firstSeenAt` write for the new `lastSeenAt` write.
- Guests must never appear in or be affected by this feature (no `User` row) — no guest-handling code needed.
- No new client dependency — reuse `formatRelativeTimeId`/`formatExactDateTimeId` from `client/src/utils/relativeTime.ts` unmodified.

---

### Task 1: Schema + migration (lastSeenAt, backfilled from MAX(StatusInterval.startedAt))

**Files:**
- Modify: `server/prisma/schema.prisma` (User model, right after the existing `firstSeenAt` field, currently at line 88)
- Create: `server/prisma/migrations/20260821200000_add_user_last_seen_at/migration.sql`

**Interfaces:**
- Produces: `User.lastSeenAt` (`DateTime?`, nullable) — Task 2 writes to it, Task 2's `GET /org/members` reads it, Task 3 renders it client-side as `lastSeenAt: number | null`.

- [ ] **Step 1: Add the `lastSeenAt` field to the Prisma schema**

Open `server/prisma/schema.prisma`. Find the existing `firstSeenAt` field (currently lines 81-88):

```prisma
  // specs/2026-08-21-first-seen-offline-members-design.md — the first time
  // this user ever actually joined a room (their earliest StatusInterval
  // row's startedAt), NOT when their account was created. Backfilled once
  // for existing users (see this feature's own migration); set exactly
  // once going forward by lib/statusIntervals.ts's openStatusInterval, the
  // first time it ever runs for a user with no value here yet. Null means
  // genuinely "has never joined a room" — never a stale/guessed value.
  firstSeenAt DateTime?
```

Replace it with (adds a doc-comment note that it's dormant, plus the new field immediately after):

```prisma
  // specs/2026-08-21-first-seen-offline-members-design.md — the first time
  // this user ever actually joined a room (their earliest StatusInterval
  // row's startedAt), NOT when their account was created. Backfilled once
  // for existing users (see that feature's own migration).
  // DORMANT as of specs/2026-08-21-last-seen-offline-members-design.md — no
  // longer written to or read anywhere; superseded by lastSeenAt below for
  // the Offline list's actual use case. Left in place (not dropped) since
  // its already-backfilled data isn't reproducible from anything else.
  firstSeenAt DateTime?
  // specs/2026-08-21-last-seen-offline-members-design.md — the START time
  // of this user's MOST RECENT StatusInterval row (i.e. the last time they
  // joined a room or changed work-mode), NOT the moment they went offline.
  // Backfilled once for existing users (see this feature's own migration);
  // overwritten UNCONDITIONALLY every time lib/statusIntervals.ts's
  // openStatusInterval runs for this user — unlike firstSeenAt above, there
  // is no "only once" guard, the newest write always wins. Null means
  // genuinely "has never joined a room" — never a stale/guessed value.
  lastSeenAt DateTime?
```

- [ ] **Step 2: Create the migration directory and SQL file**

Create `server/prisma/migrations/20260821200000_add_user_last_seen_at/migration.sql` with exactly this content:

```sql
-- The start time of a user's MOST RECENT StatusInterval row (see
-- specs/2026-08-21-last-seen-offline-members-design.md) — replaces
-- firstSeenAt (added this morning, specs/2026-08-21-first-seen-offline-
-- members-design.md) as the timestamp shown in the Offline list; firstSeenAt
-- itself is left untouched, not dropped. Nullable: a user who's never
-- joined a room stays NULL.

ALTER TABLE "User" ADD COLUMN "lastSeenAt" TIMESTAMP(3);

-- One-time backfill: without this, every EXISTING user would only get
-- lastSeenAt set the next time they join a room or change work-mode after
-- this deploy — incorrectly showing "terakhir masuk: baru saja" for
-- someone who hasn't been active in weeks. This computes each user's
-- actual MOST RECENT StatusInterval row (already indexed on
-- (userId, startedAt), see schema.prisma) and writes its startedAt. A user
-- with zero StatusInterval rows is untouched by this UPDATE and correctly
-- stays NULL — meaning "has never joined a room", not a bug.
UPDATE "User" u
SET "lastSeenAt" = latest."maxStartedAt"
FROM (
  SELECT "userId", MAX("startedAt") AS "maxStartedAt"
  FROM "StatusInterval"
  GROUP BY "userId"
) latest
WHERE u.id = latest."userId";
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate --schema=server/prisma/schema.prisma`

Expected: `✔ Generated Prisma Client` with no errors. This does NOT apply the migration to any database (no live local Postgres in this environment, per this session's established convention) — it only regenerates the TypeScript types so `lastSeenAt` type-checks in later tasks. The actual migration SQL above is hand-verified by reading it against the schema, and gets applied automatically during deploy (see `deploy/deploy.sh`'s `prisma migrate deploy` step, which this repo already runs on every deploy).

- [ ] **Step 4: Typecheck the server workspace**

Run: `npm run typecheck --workspace=server`

Expected: no errors. This is slow on this machine (3-5+ minutes) — wait for it to finish, don't cut it short.

- [ ] **Step 5: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/20260821200000_add_user_last_seen_at
git commit -m "feat: add User.lastSeenAt with a one-time backfill from StatusInterval history"
```

---

### Task 2: Server — unconditional lastSeenAt write + GET /org/members swap

**Files:**
- Modify: `server/src/lib/statusIntervals.ts` (the `openStatusInterval` function)
- Modify: `server/src/routes/orgMembers.ts` (the `GET /org/members` handler)

**Interfaces:**
- Consumes: `User.lastSeenAt` (from Task 1's schema change).
- Produces: `GET /org/members`'s JSON response shape changes from `{ members: Array<{ id, displayName, workspaceRole, firstSeenAt: number | null }> }` to `{ members: Array<{ id, displayName, workspaceRole, lastSeenAt: number | null }> }` — Task 3's client code consumes this new shape.

- [ ] **Step 1: Swap the write in `openStatusInterval`**

Open `server/src/lib/statusIntervals.ts`. The current full function (lines 34-54) is:

```ts
export async function openStatusInterval(
  prisma: PrismaClient,
  userId: string,
  roomSlug: string,
  status: AnalyticsStatus,
  at: Date = new Date(),
  zoneId?: string,
): Promise<void> {
  await closeOpenStatusInterval(prisma, userId, at);
  await prisma.statusInterval.create({ data: { userId, roomSlug, status, startedAt: at, zoneId: zoneId ?? null } });
  // specs/2026-08-21-first-seen-offline-members-design.md — set exactly
  // once per user, the first time they're ever known to be active in a
  // room (this function's own first-ever call for them, or the first call
  // after a backfilled/already-set value). updateMany's own where clause
  // re-checks firstSeenAt is still null AT WRITE TIME (not a separate
  // read-then-write, which would race) — two concurrent room-joins for the
  // same brand-new user can't both "win": whichever write actually reaches
  // the database first sets it, the other's WHERE clause no longer matches
  // and it becomes a no-op, never overwriting an already-set value.
  await prisma.user.updateMany({ where: { id: userId, firstSeenAt: null }, data: { firstSeenAt: at } });
}
```

Replace the whole function body with (deletes the `firstSeenAt` write entirely, replaces it with an unconditional `lastSeenAt` write):

```ts
export async function openStatusInterval(
  prisma: PrismaClient,
  userId: string,
  roomSlug: string,
  status: AnalyticsStatus,
  at: Date = new Date(),
  zoneId?: string,
): Promise<void> {
  await closeOpenStatusInterval(prisma, userId, at);
  await prisma.statusInterval.create({ data: { userId, roomSlug, status, startedAt: at, zoneId: zoneId ?? null } });
  // specs/2026-08-21-last-seen-offline-members-design.md — overwritten
  // UNCONDITIONALLY on every call (room join OR work-mode change alike),
  // unlike firstSeenAt's old "set if null" guard (deleted above): there is
  // no "only once" constraint here, the newest join/mode-change is always
  // the value the Offline list should show, so last write always wins.
  await prisma.user.updateMany({ where: { id: userId }, data: { lastSeenAt: at } });
}
```

- [ ] **Step 2: Swap `firstSeenAt` for `lastSeenAt` in `GET /org/members`**

Open `server/src/routes/orgMembers.ts`. The current handler (lines 13-33) is:

```ts
orgMembers.get('/org/members', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const users = await prisma.user.findMany({
      where: { organizationId: req.organizationId, active: true },
      select: { id: true, displayName: true, workspaceRole: true, firstSeenAt: true },
      orderBy: { displayName: 'asc' },
    });
    // specs/2026-08-21-first-seen-offline-members-design.md — Prisma's
    // Date is converted to epoch milliseconds explicitly here (rather than
    // relying on JSON.stringify's default Date->ISO-string behavior),
    // matching this codebase's existing numeric-timestamp convention for
    // client-facing fields (e.g. larkApproval.ts's submittedAt).
    const members = users.map((u) => ({ ...u, firstSeenAt: u.firstSeenAt ? u.firstSeenAt.getTime() : null }));
    return res.json({ members });
  } catch (err) {
    console.error('[orgMembers] list error:', err);
    return res.status(500).json({ error: 'Gagal memuat anggota organisasi' });
  }
});
```

Replace it with (swaps `firstSeenAt` for `lastSeenAt` in both the `select` and the response mapping — `firstSeenAt` is dropped entirely, not kept alongside):

```ts
orgMembers.get('/org/members', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const users = await prisma.user.findMany({
      where: { organizationId: req.organizationId, active: true },
      select: { id: true, displayName: true, workspaceRole: true, lastSeenAt: true },
      orderBy: { displayName: 'asc' },
    });
    // specs/2026-08-21-last-seen-offline-members-design.md — Prisma's Date
    // is converted to epoch milliseconds explicitly here (rather than
    // relying on JSON.stringify's default Date->ISO-string behavior),
    // matching this codebase's existing numeric-timestamp convention for
    // client-facing fields (e.g. larkApproval.ts's submittedAt).
    const members = users.map((u) => ({ ...u, lastSeenAt: u.lastSeenAt ? u.lastSeenAt.getTime() : null }));
    return res.json({ members });
  } catch (err) {
    console.error('[orgMembers] list error:', err);
    return res.status(500).json({ error: 'Gagal memuat anggota organisasi' });
  }
});
```

- [ ] **Step 3: Typecheck the server workspace**

Run: `npm run typecheck --workspace=server`

Expected: no errors. Slow (3-5+ minutes) — wait for it.

- [ ] **Step 4: Commit**

```bash
git add server/src/lib/statusIntervals.ts server/src/routes/orgMembers.ts
git commit -m "feat: overwrite lastSeenAt on every room join/work-mode change, expose it via GET /org/members"
```

---

### Task 3: Client — rename prop, swap copy to "Terakhir masuk"

**Files:**
- Modify: `client/src/services/api.ts` (the `OrgMember` interface)
- Modify: `client/src/components/ui/ParticipantPanel.tsx` (the `OfflineMemberRow` component and its call site)

**Interfaces:**
- Consumes: `GET /org/members`'s new response shape from Task 2 (`lastSeenAt: number | null` instead of `firstSeenAt`).
- Consumes (unchanged): `formatRelativeTimeId(timestamp: number): string` and `formatExactDateTimeId(timestamp: number): string` from `client/src/utils/relativeTime.ts` — both already generic over any epoch-ms timestamp; this task does not modify that file.

- [ ] **Step 1: Rename the field in `OrgMember`**

Open `client/src/services/api.ts`. The current interface (currently lines 294-297) is:

```ts
// specs/2026-08-21-first-seen-offline-members-design.md — epoch
// milliseconds (matching the server's explicit Date->getTime() conversion
// in routes/orgMembers.ts), null meaning "has never joined a room".
export interface OrgMember { id: string; displayName: string; workspaceRole: 'admin' | 'member'; firstSeenAt: number | null }
```

Replace it with:

```ts
// specs/2026-08-21-last-seen-offline-members-design.md — epoch
// milliseconds (matching the server's explicit Date->getTime() conversion
// in routes/orgMembers.ts), null meaning "has never joined a room". Start
// time of the user's MOST RECENT room activity, not their first-ever join.
export interface OrgMember { id: string; displayName: string; workspaceRole: 'admin' | 'member'; lastSeenAt: number | null }
```

- [ ] **Step 2: Rename the call-site prop**

Open `client/src/components/ui/ParticipantPanel.tsx`. Find the `OfflineMemberRow` call site (currently lines 389-396):

```tsx
                  <OfflineMemberRow
                    key={m.id}
                    name={m.displayName}
                    firstSeenAt={m.firstSeenAt}
                    leaveBadge={activeTodayByUserId.get(m.id)}
                    pendingBadge={mFirstPending}
                    onApproveLeave={mFirstPending?.canDecide ? () => decideLeave(mFirstPending.id, 'approved') : undefined}
                    onRejectLeave={mFirstPending?.canDecide ? () => decideLeave(mFirstPending.id, 'rejected') : undefined}
```

Replace the `firstSeenAt={m.firstSeenAt}` line with:

```tsx
                    lastSeenAt={m.lastSeenAt}
```

(every other line in that call site is unchanged).

- [ ] **Step 3: Rename the prop and swap the copy in `OfflineMemberRow`**

In the same file, find the `OfflineMemberRow` component (currently lines 809-826):

```tsx
function OfflineMemberRow({ name, firstSeenAt, leaveBadge, pendingBadge, pendingCount, onApproveLeave, onRejectLeave }: {
  name: string;
  // specs/2026-08-21-first-seen-offline-members-design.md — null means
  // this account has never actually joined a room (not "unknown"/"loading").
  firstSeenAt: number | null;
  leaveBadge?: ActiveLeaveDto;
  pendingBadge?: PendingLeaveDto;
  pendingCount?: number;
  onApproveLeave?: () => void;
  onRejectLeave?: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-2 py-1 rounded bg-gray-50/50 dark:bg-gray-800/50">
      <div className="min-w-0 flex flex-col">
        <span className="text-gray-500 dark:text-gray-400 text-xs truncate">{name}</span>
        <span className="text-gray-400 dark:text-gray-500 text-[10px] truncate">
          {firstSeenAt ? `Pertama masuk ${formatRelativeTimeId(firstSeenAt)} (${formatExactDateTimeId(firstSeenAt)})` : 'Belum pernah masuk'}
        </span>
      </div>
```

Replace it with:

```tsx
function OfflineMemberRow({ name, lastSeenAt, leaveBadge, pendingBadge, pendingCount, onApproveLeave, onRejectLeave }: {
  name: string;
  // specs/2026-08-21-last-seen-offline-members-design.md — null means this
  // account has never actually joined a room (not "unknown"/"loading").
  // Start of the user's MOST RECENT room activity, not their first-ever join.
  lastSeenAt: number | null;
  leaveBadge?: ActiveLeaveDto;
  pendingBadge?: PendingLeaveDto;
  pendingCount?: number;
  onApproveLeave?: () => void;
  onRejectLeave?: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-2 py-1 rounded bg-gray-50/50 dark:bg-gray-800/50">
      <div className="min-w-0 flex flex-col">
        <span className="text-gray-500 dark:text-gray-400 text-xs truncate">{name}</span>
        <span className="text-gray-400 dark:text-gray-500 text-[10px] truncate">
          {lastSeenAt ? `Terakhir masuk ${formatRelativeTimeId(lastSeenAt)} (${formatExactDateTimeId(lastSeenAt)})` : 'Belum pernah masuk'}
        </span>
      </div>
```

(the rest of the component body — the `leaveBadge`/`pendingBadge` rendering below — is unchanged; the `formatRelativeTimeId`/`formatExactDateTimeId` import at the top of the file needs no change, both names are reused as-is).

- [ ] **Step 4: Typecheck the client workspace**

Run: `npm run typecheck --workspace=client`

Expected: no errors. Slow (3-5+ minutes) — wait for it.

- [ ] **Step 5: Typecheck the server workspace (confirms nothing else broke)**

Run: `npm run typecheck --workspace=server`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/services/api.ts client/src/components/ui/ParticipantPanel.tsx
git commit -m "feat: rename Offline list's timestamp to last-seen (Terakhir masuk)"
```

---

## Final Verification

- [ ] `npm run typecheck --workspace=server` passes.
- [ ] `npm run typecheck --workspace=client` passes.
- [ ] `git log --oneline -3` shows exactly the 3 commits from Tasks 1-3, in order.
- [ ] Grep the diff for any remaining `firstSeenAt` reference in `server/src/` or `client/src/` — there should be none (the column stays in `schema.prisma` only).
- [ ] Grep the diff for any remaining "Pertama masuk" string anywhere in `client/src/` — there should be none.

## Manual Testing After Deploy

1. **Backfill correctness:** for a couple of KNOWN existing users, confirm `lastSeenAt` reflects their actual most-recent `StatusInterval.startedAt` (cross-check against a user you know was active recently vs. one who hasn't been in a while) — not their first-ever join time.
2. **New activity updates it:** a currently-online user goes offline — confirm their `lastSeenAt` reflects that session's start time (check the Offline list after they disconnect, or query the DB).
3. **Repeated activity keeps updating it (the core behavioral difference from this morning's firstSeenAt):** that same user comes back online and goes offline again in a NEW session — confirm `lastSeenAt` UPDATES to the new session's start time rather than staying frozen at the first value (unlike `firstSeenAt`, which deliberately never changed after being set once).
4. **Copy:** the Offline list shows "Terakhir masuk X yang lalu (tanggal, jam)" for a user with a non-null `lastSeenAt`, and "Belum pernah masuk" for one that's still null.
5. **No leftover "Pertama masuk":** confirm that string no longer appears anywhere in the UI.
6. **Online list unaffected:** confirm the Online list and the rest of the Participant Panel's existing behavior is unchanged.
7. **Guests unaffected:** confirm a guest still never appears in this list at all.
