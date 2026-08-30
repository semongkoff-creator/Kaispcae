# First-Seen Timestamp for Offline Members Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Participant Panel's Offline list shows when each member first ever actually joined a room in KaiSpace ("Pertama masuk X yang lalu"), or "Belum pernah masuk" if they never have — so a viewer can tell a genuinely-unused account apart from one that's just currently offline.

**Architecture:** A new nullable `User.firstSeenAt` column, backfilled once (as part of the same migration) from each user's earliest existing `StatusInterval.startedAt`, then set going forward — exactly once, atomically — by `openStatusInterval` the first time it ever runs for a user with no `firstSeenAt` yet. `GET /org/members` exposes it; the client renders it with a new native-`Intl`-backed Indonesian relative-time helper.

**Tech Stack:** Prisma (hand-authored migration with an `UPDATE ... FROM` backfill query, no live local Postgres this session), native `Intl.RelativeTimeFormat` (no new client dependency).

## Global Constraints

- "First seen" means the first time a user **actually joined a room** (earliest `StatusInterval.startedAt`) — NOT account creation (`User.createdAt`). Do not use `createdAt` anywhere in this feature.
- Existing users **must** be backfilled from their actual `StatusInterval` history as part of shipping this — not optional, not deferrable. Without it, every veteran user would incorrectly show "first seen: today" the next time they join after deploy.
- A user with genuinely zero `StatusInterval` rows must be left with `firstSeenAt: NULL` — never overwritten with a guess. The client renders this as "Belum pernah masuk."
- Going forward, `firstSeenAt` is set **exactly once** per user — the write must atomically check "is this still null" (not a separate read-then-write, which would race) and never touch it again once set. This must hold for both a freshly-backfilled existing user and a genuinely-new user getting it set for the first time.
- The Offline list's existing org-wide scope (every active `User` in the org minus currently-connected, not room-specific) does not change.
- Do not show this timestamp for online members — offline only.
- Do not add a new client dependency for the relative-time formatting — use native `Intl.RelativeTimeFormat`.
- Do not change `StatusInterval`'s own existing read/write semantics, the room-join flow, or any other behavior of `openStatusInterval` beyond this one additive "set if null" write.
- Guests must never appear in or be affected by this feature — they have no `User` row (already true today; this plan adds no guest-handling code since none is needed).

---

### Task 1: Schema, migration, and one-time backfill

**Files:**
- Modify: `server/prisma/schema.prisma` (User model)
- Create: `server/prisma/migrations/20260821190000_add_user_first_seen_at/migration.sql`

**Interfaces:**
- Produces: `User.firstSeenAt: DateTime | null` — consumed by Task 2.

- [ ] **Step 1: Add the column to the schema**

In `server/prisma/schema.prisma`, find the `User` model's `lastAttendanceCheckOutDate` field (currently line 80):

Current:
```prisma
  // Same idea for check-out (A12): 'YYYY-MM-DD' WIB of the last successful
  // checkout punch from MeetKai — a fast idempotency guard against double
  // checkout. Display/status is read live from Lark (user_tasks/query), which
  // also reflects checkouts done in the Lark app itself.
  lastAttendanceCheckOutDate String?
```

Replace with:
```prisma
  // Same idea for check-out (A12): 'YYYY-MM-DD' WIB of the last successful
  // checkout punch from MeetKai — a fast idempotency guard against double
  // checkout. Display/status is read live from Lark (user_tasks/query), which
  // also reflects checkouts done in the Lark app itself.
  lastAttendanceCheckOutDate String?
  // specs/2026-08-21-first-seen-offline-members-design.md — the first time
  // this user ever actually joined a room (their earliest StatusInterval
  // row's startedAt), NOT when their account was created. Backfilled once
  // for existing users (see this feature's own migration); set exactly
  // once going forward by lib/statusIntervals.ts's openStatusInterval, the
  // first time it ever runs for a user with no value here yet. Null means
  // genuinely "has never joined a room" — never a stale/guessed value.
  firstSeenAt DateTime?
```

- [ ] **Step 2: Write the migration, including the one-time backfill**

Create `server/prisma/migrations/20260821190000_add_user_first_seen_at/migration.sql`:

```sql
-- The first time a user ever actually joined a room (see
-- specs/2026-08-21-first-seen-offline-members-design.md) — separate from
-- User.createdAt (account creation), which can happen before someone ever
-- opens a room. Nullable: a user who's never joined a room stays NULL.

ALTER TABLE "User" ADD COLUMN "firstSeenAt" TIMESTAMP(3);

-- One-time backfill: without this, every EXISTING user (who may have used
-- KaiSpace for months) would only get firstSeenAt set the next time they
-- join a room after this deploy — incorrectly reporting "first seen:
-- today". This computes each user's actual earliest StatusInterval row
-- (already indexed on (userId, startedAt), see schema.prisma) and writes
-- it. A user with zero StatusInterval rows is untouched by this UPDATE and
-- correctly stays NULL — meaning "has never joined a room", not a bug.
UPDATE "User" u
SET "firstSeenAt" = earliest."minStartedAt"
FROM (
  SELECT "userId", MIN("startedAt") AS "minStartedAt"
  FROM "StatusInterval"
  GROUP BY "userId"
) earliest
WHERE u.id = earliest."userId";
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate --schema=server/prisma/schema.prisma`
Expected: `Generated Prisma Client` message, no errors.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS. Slow on this machine — 3-5+ minutes.

- [ ] **Step 5: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/20260821190000_add_user_first_seen_at
git commit -m "feat: add User.firstSeenAt with a one-time backfill from StatusInterval history"
```

---

### Task 2: Server — set `firstSeenAt` going forward, expose it in the members list

**Files:**
- Modify: `server/src/lib/statusIntervals.ts`
- Modify: `server/src/routes/orgMembers.ts`

**Interfaces:**
- Consumes: `User.firstSeenAt` (Task 1).
- Produces: `GET /api/org/members` response's `members[].firstSeenAt: number | null` (epoch milliseconds) — consumed by Task 3.

- [ ] **Step 1: Set `firstSeenAt` exactly once, atomically, in `openStatusInterval`**

Current (`server/src/lib/statusIntervals.ts`, full current file):
```ts
import { PrismaClient } from '@prisma/client';
import { WorkMode } from '@virtualmeet/shared';

// Productivity Analytics — Bagian A.3's status-time distribution + Bagian
// B.3.1's Focus/Meeting-time cards, backed by StatusInterval rows (see
// schema.prisma). Two simplifications, both deliberate and documented at the
// call sites: 'quick_chat' (proximity chat) has no clean start/end signal
// today, so its COUNT comes from ConnectionEvent instead of a duration here;
// 'offline' is never written explicitly — any time NOT covered by a row for
// a user is offline by definition, computed at query time as a gap.
export type AnalyticsStatus = 'available' | 'focus' | 'in_meeting' | 'busy' | 'away';

// wfh/wfo/wfa are work-LOCATION flags layered on top of "available" (see
// AvatarSprite.ts's presence-pill list — none of the three render a distinct
// badge, same as plain 'available'). lunch/break/cuti collapse to 'busy' —
// not interruptible, not a formal meeting, and there's no direct WorkMode
// equivalent of the brief's generic manual Busy/DND.
export function resolveEffectiveStatus(mode: WorkMode): AnalyticsStatus {
  switch (mode) {
    case 'in_meeting': return 'in_meeting';
    case 'focus': return 'focus';
    case 'away': return 'away';
    case 'lunch':
    case 'break':
    case 'cuti': return 'busy';
    default: return 'available'; // available | wfh | wfo | wfa
  }
}

// Closes whatever interval is currently open for this user (there is never
// more than one — every open() call closes-before-opening) then opens a new
// one. Fire-and-forget from call sites — analytics bookkeeping must never
// block or fail the live feature it's hooked into.
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
}

export async function closeOpenStatusInterval(
  prisma: PrismaClient,
  userId: string,
  at: Date = new Date(),
): Promise<void> {
  await prisma.statusInterval.updateMany({
    where: { userId, endedAt: null },
    data: { endedAt: at },
  });
}
```

Replace the `openStatusInterval` function only:
```ts
// Closes whatever interval is currently open for this user (there is never
// more than one — every open() call closes-before-opening) then opens a new
// one. Fire-and-forget from call sites — analytics bookkeeping must never
// block or fail the live feature it's hooked into.
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

(The rest of the file — `AnalyticsStatus`, `resolveEffectiveStatus`, `closeOpenStatusInterval` — is unchanged.)

- [ ] **Step 2: Expose `firstSeenAt` in `GET /org/members`**

Current (`server/src/routes/orgMembers.ts`, full current file):
```ts
import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const orgMembers = Router();

// GET /api/org/members — the full org roster, open to any authenticated
// member (not admin-gated, unlike admin.ts's GET /admin/members, which
// includes email/department/manager and is workspace-admin only). This is
// just id/name/role, needed by ParticipantPanel.tsx to render the
// "Offline" section — everyone in the org NOT currently connected via
// socket right now.
orgMembers.get('/org/members', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const users = await prisma.user.findMany({
      where: { organizationId: req.organizationId, active: true },
      select: { id: true, displayName: true, workspaceRole: true },
      orderBy: { displayName: 'asc' },
    });
    return res.json({ members: users });
  } catch (err) {
    console.error('[orgMembers] list error:', err);
    return res.status(500).json({ error: 'Gagal memuat anggota organisasi' });
  }
});

export default orgMembers;
```

Replace with:
```ts
import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const orgMembers = Router();

// GET /api/org/members — the full org roster, open to any authenticated
// member (not admin-gated, unlike admin.ts's GET /admin/members, which
// includes email/department/manager and is workspace-admin only). This is
// just id/name/role, needed by ParticipantPanel.tsx to render the
// "Offline" section — everyone in the org NOT currently connected via
// socket right now.
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

export default orgMembers;
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS. Slow on this machine — 3-5+ minutes. If the Prisma client seems stale (errors about `firstSeenAt` not existing on `User`), re-run Task 1's Step 3 (`npx prisma generate --schema=server/prisma/schema.prisma`) and retype.

- [ ] **Step 4: Commit**

```bash
git add server/src/lib/statusIntervals.ts server/src/routes/orgMembers.ts
git commit -m "feat: set firstSeenAt on a user's first room join, expose it via GET /org/members"
```

---

### Task 3: Client — Indonesian relative-time helper and the Offline row's new display

**Files:**
- Create: `client/src/utils/relativeTime.ts`
- Modify: `client/src/services/api.ts` (`OrgMember` interface)
- Modify: `client/src/components/ui/ParticipantPanel.tsx` (`OfflineMemberRow` and its call site)

**Interfaces:**
- Consumes: `GET /api/org/members`'s `firstSeenAt: number | null` (Task 2).
- Produces: `formatRelativeTimeId(timestamp: number): string` (exported from the new file) — consumed within this same task.

- [ ] **Step 1: Create the relative-time helper**

Create `client/src/utils/relativeTime.ts`:
```ts
// specs/2026-08-21-first-seen-offline-members-design.md — a "first seen"
// timestamp can realistically be months or years old, unlike
// ActivityFeed.tsx's own local formatRelativeTime (seconds/minutes/hours
// only, English, not shared/exported) — this is a separate, broader
// helper rather than extending that one, since the two callers' actual
// time ranges don't overlap in any way sharing would help with. Uses the
// browser's native Intl.RelativeTimeFormat — no new dependency, and it's
// already locale-aware (Indonesian "X yang lalu" phrasing) for free.
const rtf = new Intl.RelativeTimeFormat('id', { numeric: 'auto' });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60],
  ['month', 30 * 24 * 60 * 60],
  ['week', 7 * 24 * 60 * 60],
  ['day', 24 * 60 * 60],
  ['hour', 60 * 60],
  ['minute', 60],
];

export function formatRelativeTimeId(timestamp: number): string {
  const diffSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  if (absSeconds < 60) return 'baru saja';
  for (const [unit, secondsInUnit] of UNITS) {
    if (absSeconds >= secondsInUnit) {
      const value = Math.round(diffSeconds / secondsInUnit);
      return rtf.format(value, unit);
    }
  }
  return 'baru saja';
}
```

- [ ] **Step 2: Add `firstSeenAt` to the `OrgMember` client type**

Current (`client/src/services/api.ts`):
```ts
export interface OrgMember { id: string; displayName: string; workspaceRole: 'admin' | 'member' }
```

Replace with:
```ts
// specs/2026-08-21-first-seen-offline-members-design.md — epoch
// milliseconds (matching the server's explicit Date->getTime() conversion
// in routes/orgMembers.ts), null meaning "has never joined a room".
export interface OrgMember { id: string; displayName: string; workspaceRole: 'admin' | 'member'; firstSeenAt: number | null }
```

- [ ] **Step 3: Pass `firstSeenAt` through to `OfflineMemberRow` and render it**

Current (`client/src/components/ui/ParticipantPanel.tsx`, the `OfflineMemberRow` call site):
```tsx
              {filteredOfflineMembers.map((m) => {
                const mPending = pendingByUserId.get(m.id);
                const mFirstPending = mPending?.[0];
                return (
                  <OfflineMemberRow
                    key={m.id}
                    name={m.displayName}
                    leaveBadge={activeTodayByUserId.get(m.id)}
                    pendingBadge={mFirstPending}
                    pendingCount={mPending?.length}
                    onApproveLeave={mFirstPending?.canDecide ? () => decideLeave(mFirstPending.id, 'approved') : undefined}
                    onRejectLeave={mFirstPending?.canDecide ? () => decideLeave(mFirstPending.id, 'rejected') : undefined}
                  />
                );
              })}
```

Replace with:
```tsx
              {filteredOfflineMembers.map((m) => {
                const mPending = pendingByUserId.get(m.id);
                const mFirstPending = mPending?.[0];
                return (
                  <OfflineMemberRow
                    key={m.id}
                    name={m.displayName}
                    firstSeenAt={m.firstSeenAt}
                    leaveBadge={activeTodayByUserId.get(m.id)}
                    pendingBadge={mFirstPending}
                    pendingCount={mPending?.length}
                    onApproveLeave={mFirstPending?.canDecide ? () => decideLeave(mFirstPending.id, 'approved') : undefined}
                    onRejectLeave={mFirstPending?.canDecide ? () => decideLeave(mFirstPending.id, 'rejected') : undefined}
                  />
                );
              })}
```

Current (`client/src/components/ui/ParticipantPanel.tsx`, `OfflineMemberRow`'s full definition):
```tsx
function OfflineMemberRow({ name, leaveBadge, pendingBadge, pendingCount, onApproveLeave, onRejectLeave }: {
  name: string;
  leaveBadge?: ActiveLeaveDto;
  pendingBadge?: PendingLeaveDto;
  pendingCount?: number;
  onApproveLeave?: () => void;
  onRejectLeave?: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-2 py-1 rounded bg-gray-50/50 dark:bg-gray-800/50">
      <span className="text-gray-500 dark:text-gray-400 text-xs truncate">{name}</span>
      <div className="flex items-center gap-1 shrink-0">
```

Replace with:
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
          {firstSeenAt ? `Pertama masuk ${formatRelativeTimeId(firstSeenAt)}` : 'Belum pernah masuk'}
        </span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
```

(Only the opening `<span>{name}</span>` line is being replaced with the new two-line `<div className="min-w-0 flex flex-col">...</div>` wrapper — the rest of the function body, starting from `{leaveBadge && (...)}` through the closing tags, is unchanged.)

- [ ] **Step 4: Import the new helper**

Current (`client/src/components/ui/ParticipantPanel.tsx`, top of file — find the existing import block; the exact surrounding imports will vary slightly, add this alongside them):
```ts
import { api, OrgMember } from '@/services/api';
```

Replace with:
```ts
import { api, OrgMember } from '@/services/api';
import { formatRelativeTimeId } from '@/utils/relativeTime';
```

(If another import already sits on the line immediately after `api`/`OrgMember`'s import in the actual current file, add this as its own new import line rather than replacing an unrelated one — the point is just that `formatRelativeTimeId` needs to be imported somewhere near the top of this file.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --workspace=client`
Expected: PASS. Slow on this machine — 3-5+ minutes.

- [ ] **Step 6: Also run the server typecheck once more from a clean state**

Run: `npm run typecheck --workspace=server`
Expected: PASS (no server files touched by this task, but confirms Task 1 + Task 2 + this task's combined state is still clean).

- [ ] **Step 7: Commit**

```bash
git add client/src/utils/relativeTime.ts client/src/services/api.ts client/src/components/ui/ParticipantPanel.tsx
git commit -m "feat: show first-seen timestamp for offline members in the Participant Panel"
```

---

## Final Verification

- [ ] `npm run typecheck --workspace=server` — PASS, zero errors.
- [ ] `npm run typecheck --workspace=client` — PASS, zero errors.
- [ ] `git log --oneline -3` — confirm the 3 commits above exist in order.

## Manual Testing After Deploy

1. After deploy, confirm the backfill actually ran: check `firstSeenAt` for a handful of KNOWN existing users (e.g. via the Offline list, or a DB query if available) — it should be non-null and roughly match when you know they first started using KaiSpace, and null only for an account you know has genuinely never joined any room.
2. A BRAND NEW user account joins a room for the very first time. Confirm their `firstSeenAt` gets set at that moment — check the Offline list after they disconnect again, or query the DB directly.
3. An EXISTING/veteran user (already backfilled, non-null `firstSeenAt`) joins another room. Confirm `firstSeenAt` does NOT change — it should stay at their original first-ever join, proving the "set only if null" guard actually holds and a backfilled value is never silently overwritten.
4. The Offline list shows "Pertama masuk X hari/minggu/bulan/tahun yang lalu" (Indonesian relative phrasing) for a user with `firstSeenAt` set, and "Belum pernah masuk" for one that's still null.
5. Confirm the Online list and every other part of the Participant Panel behaves exactly as it did before this feature.
6. If a guest can be present in the same test, confirm they never appear in this Offline list at all — unaffected by this change, same as before.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-21-first-seen-offline-members-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
