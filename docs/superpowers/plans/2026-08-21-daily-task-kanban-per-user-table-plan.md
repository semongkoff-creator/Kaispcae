# Daily Task Kanban View + Per-User Lark Base Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Daily Task gains a second view — a Kanban board — alongside its existing checklist, and a user can optionally bind their own Lark Base (App Token + Table ID) so their tasks come from a different table than the organization's default one.

**Architecture:** Two new nullable `User` columns hold a per-user Lark Base override. `server/src/lib/larkTasks.ts`'s existing `ids()` resolver is widened to check that override first, before falling back to the existing per-org resolution — every task function threads an optional override parameter through unchanged otherwise. A new `GET /tasks/all` route (owner-filtered, no date restriction) feeds a new Kanban board component (`@hello-pangea/dnd`), whose columns mirror whatever Status options the active table actually has. A new small settings form inside `DailyTaskPanel.tsx` lets a user paste/clear their own App Token + Table ID, validated against Lark's live API before being persisted.

**Tech Stack:** Zod (`server/src/middleware/validate.ts`) for the new save endpoint's validation, Prisma (hand-authored migration, no live local Postgres this session), `@hello-pangea/dnd` (new client dependency) for Kanban drag-and-drop.

## Global Constraints

- The per-user override is App Token + Table ID **together** — never just one. Enforced at the Zod schema layer (both fields required) for the save endpoint.
- A user with **no** personal override keeps using the org-wide default table — completely unchanged behavior for anyone who never touches this feature.
- The "Hubungkan tabel saya" affordance lives **inside `DailyTaskPanel.tsx` itself** — not a separate Settings page.
- Kanban view scope is **ALL of the user's own tasks, any due date** — NOT restricted to today like the List view.
- Kanban columns are derived **dynamically from the resolved table's actual Status options** — never manually nameable/reorderable. A task whose current Status value isn't one of those options falls into an extra "Tanpa Status" column rather than being silently dropped.
- Dragging a card to a different column **writes through immediately** to Lark Base (same effect as the List view's existing status controls), with **optimistic-update-then-rollback-on-failure**.
- "+ Tambah Task" must be reachable from the Kanban view too, **as a modal** — not List-view-only. List view's own existing inline form placement stays unchanged.
- The List/Kanban view toggle is **manual and explicitly NOT persisted** across panel opens — resets to List every time the panel is opened.
- Use **`@hello-pangea/dnd`** for drag-and-drop — not a hand-rolled native-HTML5-drag implementation.
- Saving an App Token/Table ID must be **validated with a real Lark API call BEFORE persisting** — never store an unvalidated pointer.
- App Token and Table ID are **user-controlled strings sent to Lark's own API** as path segments in every subsequent fetch/write for that account. This codebase's own existing convention for these exact identifiers (`routes/integrations.ts`'s admin-level `bitableAppToken`/`bitableTableId` save) validates only that they contain no whitespace — Lark's own app_token/table_id formats aren't documented rigidly enough to hardcode a stricter pattern, so this plan does not invent one. This plan's user-level endpoint goes further than that existing admin-level precedent by ALSO validating against Lark's live API before persisting (the admin-level endpoint does not). Both values are always used as plain data values interpolated into a URL path exactly like the existing `ids()`-resolved `app`/`table` already are — never used to construct a filesystem path, never treated as pre-sanitized.
- Do not change the existing org-wide default table mechanism (`isDailyTaskAvailable`, Integrasi's admin-set Bitable config) at all.
- Do not add per-room or per-team shared table bindings — this is a single override per USER account only.

---

### Task 1: Schema + migration for the per-user table override

**Files:**
- Modify: `server/prisma/schema.prisma` (User model)
- Create: `server/prisma/migrations/20260821180000_add_user_lark_task_table/migration.sql`

**Interfaces:**
- Produces: `User.larkTaskAppToken: string | null`, `User.larkTaskTableId: string | null` — consumed by every later task.

- [ ] **Step 1: Add the columns to the schema**

In `server/prisma/schema.prisma`, find the `User` model's `larkUserId` field (currently line 62):

Current:
```prisma
  larkUserId              String?
  // Idempotency marker ONLY (not the source of truth — that's Lark Attendance):
  // 'YYYY-MM-DD' in WIB of the last day we successfully punched check-in for
  // this user, so repeated /auth/me hits the same day don't re-punch.
  lastAttendanceCheckInDate String?
```

Replace with:
```prisma
  larkUserId              String?
  // specs/2026-08-21-daily-task-kanban-per-user-table-design.md — a
  // user's OWN Lark Base (Bitable) table override for Daily Task, separate
  // from the org-wide default (OrgIntegration.bitableAppToken/bitableTableId,
  // see lib/orgIntegration.ts's getOrgTaskBitableConfig). Both null or both
  // set — never one without the other (enforced at the save endpoint, not
  // here). Null for every account that hasn't used this feature — Daily
  // Task falls back to the org default in that case, unchanged from today.
  larkTaskAppToken        String?
  larkTaskTableId         String?
  // Idempotency marker ONLY (not the source of truth — that's Lark Attendance):
  // 'YYYY-MM-DD' in WIB of the last day we successfully punched check-in for
  // this user, so repeated /auth/me hits the same day don't re-punch.
  lastAttendanceCheckInDate String?
```

- [ ] **Step 2: Write the migration**

Create `server/prisma/migrations/20260821180000_add_user_lark_task_table/migration.sql`:

```sql
-- A user's own Lark Base (Bitable) table override for Daily Task (see
-- specs/2026-08-21-daily-task-kanban-per-user-table-design.md) — separate
-- from the org-wide default table. Nullable, no backfill: existing users
-- get NULL and keep using the org default until they set their own.

ALTER TABLE "User" ADD COLUMN "larkTaskAppToken" TEXT;
ALTER TABLE "User" ADD COLUMN "larkTaskTableId" TEXT;
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate --schema=server/prisma/schema.prisma`
Expected: `Generated Prisma Client` message, no errors.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS. This is slow on this machine — 3-5+ minutes.

- [ ] **Step 5: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/20260821180000_add_user_lark_task_table
git commit -m "feat: add User.larkTaskAppToken/larkTaskTableId for per-user Daily Task table override"
```

---

### Task 2: Widen `larkTasks.ts` to accept a per-user table override, add the "all tasks" and validation functions

**Files:**
- Modify: `server/src/lib/larkTasks.ts`

**Interfaces:**
- Consumes: `TaskBitableConfig` (already exported from `server/src/lib/orgIntegration.ts` — `{ appToken: string; tableId: string }`, the exact shape the org-level override already uses).
- Produces: `ids(organizationId, override?: TaskBitableConfig)`; `listTodayTasks(ownerOpenId, organizationId, override?: TaskBitableConfig)`; `getTaskOptions(organizationId, override?: TaskBitableConfig)`; `createTask(input, ownerOpenId, organizationId, override?: TaskBitableConfig)`; `updateTaskStatus(recordId, status, organizationId, override?: TaskBitableConfig)`; new `listAllTasksForOwner(ownerOpenId, organizationId, override?: TaskBitableConfig): Promise<DailyTask[]>`; new `validateTaskTable(appToken, tableId, organizationId): Promise<boolean>` — all consumed by Task 3.

`listTasksInRange` is deliberately NOT touched — it's the company-wide analytics sweep function, unrelated to any one user's override, and this plan's Global Constraints forbid adding team/shared bindings.

- [ ] **Step 1: Import `TaskBitableConfig`**

Current (`server/src/lib/larkTasks.ts`, top of file):
```ts
import { getConfig } from '../config';
import { getTenantToken, LARK_OPENAPI_BASE } from './larkToken';
import { getOrgTaskBitableConfig } from './orgIntegration';
import { DEFAULT_ORG_ID } from './defaultOrg';
```

Replace with:
```ts
import { getConfig } from '../config';
import { getTenantToken, LARK_OPENAPI_BASE } from './larkToken';
import { getOrgTaskBitableConfig, TaskBitableConfig } from './orgIntegration';
import { DEFAULT_ORG_ID } from './defaultOrg';
```

- [ ] **Step 2: Widen `ids()` to check a per-user override first**

Current (`server/src/lib/larkTasks.ts`):
```ts
async function ids(organizationId: string): Promise<{ app: string; table: string; project: string }> {
  const c = getConfig();
  const override = await getOrgTaskBitableConfig(organizationId);
  if (override) return { app: override.appToken, table: override.tableId, project: c.LARK_TASK_PROJECT_TABLE_ID };
  if (organizationId === DEFAULT_ORG_ID) {
    return { app: c.LARK_TASK_APP_TOKEN, table: c.LARK_TASK_TABLE_ID, project: c.LARK_TASK_PROJECT_TABLE_ID };
  }
  throw new Error('daily-task-not-configured');
}
```

Replace with:
```ts
// specs/2026-08-21-daily-task-kanban-per-user-table-design.md — a
// per-USER override (userOverride, resolved by the caller from
// User.larkTaskAppToken/larkTaskTableId) takes priority over the per-ORG
// override, which in turn takes priority over the env-var default — same
// precedence a more-specific setting always wins over a less-specific one
// elsewhere in this codebase. `project` (the linked Project table) stays
// env-only/global regardless of either override, unchanged from before —
// out of this feature's scope, per its own design doc's Non-goals.
async function ids(organizationId: string, userOverride?: TaskBitableConfig): Promise<{ app: string; table: string; project: string }> {
  const c = getConfig();
  if (userOverride) return { app: userOverride.appToken, table: userOverride.tableId, project: c.LARK_TASK_PROJECT_TABLE_ID };
  const orgOverride = await getOrgTaskBitableConfig(organizationId);
  if (orgOverride) return { app: orgOverride.appToken, table: orgOverride.tableId, project: c.LARK_TASK_PROJECT_TABLE_ID };
  if (organizationId === DEFAULT_ORG_ID) {
    return { app: c.LARK_TASK_APP_TOKEN, table: c.LARK_TASK_TABLE_ID, project: c.LARK_TASK_PROJECT_TABLE_ID };
  }
  throw new Error('daily-task-not-configured');
}
```

- [ ] **Step 3: Thread the override through `listTodayTasks`**

Current:
```ts
export async function listTodayTasks(ownerOpenId: string, organizationId: string): Promise<DailyTask[]> {
  const t = await token(organizationId);
  const { app, table } = await ids(organizationId);
```

Replace with:
```ts
export async function listTodayTasks(ownerOpenId: string, organizationId: string, override?: TaskBitableConfig): Promise<DailyTask[]> {
  const t = await token(organizationId);
  const { app, table } = await ids(organizationId, override);
```

(The rest of the function body is unchanged.)

- [ ] **Step 4: Add `listAllTasksForOwner`, right after `listTasksInRange`**

Current (`server/src/lib/larkTasks.ts`, immediately after `listTasksInRange`'s closing brace, before `getTaskOptions`):
```ts
export async function getTaskOptions(organizationId: string): Promise<TaskOptions> {
```

Insert immediately before that line:
```ts
// specs/2026-08-21-daily-task-kanban-per-user-table-design.md — the
// Kanban view's data source: ALL of this owner's tasks, any due date
// (unlike listTodayTasks, which Lark's own search API pre-filters to "Due
// Date is Today"). Paginated like listTasksInRange above (a full-table
// fetch can exceed one page), same MAX_PAGES safety cap — but filtered by
// Owner instead of a date range, and unlike listTasksInRange (the
// company-wide analytics sweep function), this DOES accept a per-user
// table override, since it's driven by one specific user opening the
// Kanban view.
export async function listAllTasksForOwner(ownerOpenId: string, organizationId: string, override?: TaskBitableConfig): Promise<DailyTask[]> {
  const t = await token(organizationId);
  const { app, table } = await ids(organizationId, override);
  const all: any[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const res = await fetch(
      `${LARK_OPENAPI_BASE}/bitable/v1/apps/${app}/tables/${table}/records/search?page_size=200`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(pageToken ? { page_token: pageToken } : {}),
      },
    );
    const j: any = await res.json();
    if (j.code !== 0) throw new Error(`lark-search-failed:${j.code}:${j.msg}`);
    all.push(...(j.data?.items ?? []));
    pages += 1;
    pageToken = j.data?.has_more ? j.data?.page_token : undefined;
    if (pageToken && pages >= MAX_PAGES) {
      console.warn(`[larkTasks] listAllTasksForOwner hit the ${MAX_PAGES}-page cap — truncating, results may be incomplete`);
      break;
    }
  } while (pageToken);

  return all
    .map(mapRecord)
    .filter((task) => task.ownerOpenIds.includes(ownerOpenId));
}

export async function getTaskOptions(organizationId: string): Promise<TaskOptions> {
```

(`MAX_PAGES` is already defined a few lines above `listTasksInRange` in this same file — no new constant needed.)

- [ ] **Step 5: Thread the override through `getTaskOptions`**

Current:
```ts
export async function getTaskOptions(organizationId: string): Promise<TaskOptions> {
  const t = await token(organizationId);
  const { app, table, project } = await ids(organizationId);
```

Replace with:
```ts
export async function getTaskOptions(organizationId: string, override?: TaskBitableConfig): Promise<TaskOptions> {
  const t = await token(organizationId);
  const { app, table, project } = await ids(organizationId, override);
```

- [ ] **Step 6: Thread the override through `createTask`**

Current:
```ts
export async function createTask(input: CreateTaskInput, ownerOpenId: string, organizationId: string): Promise<DailyTask> {
  const t = await token(organizationId);
  const { app, table } = await ids(organizationId);
```

Replace with:
```ts
export async function createTask(input: CreateTaskInput, ownerOpenId: string, organizationId: string, override?: TaskBitableConfig): Promise<DailyTask> {
  const t = await token(organizationId);
  const { app, table } = await ids(organizationId, override);
```

- [ ] **Step 7: Thread the override through `updateTaskStatus`**

Current:
```ts
export async function updateTaskStatus(recordId: string, status: string, organizationId: string): Promise<void> {
  const t = await token(organizationId);
  const { app, table } = await ids(organizationId);
```

Replace with:
```ts
export async function updateTaskStatus(recordId: string, status: string, organizationId: string, override?: TaskBitableConfig): Promise<void> {
  const t = await token(organizationId);
  const { app, table } = await ids(organizationId, override);
```

- [ ] **Step 8: Add `validateTaskTable`, at the end of the file**

Current end of file:
```ts
export async function updateTaskStatus(recordId: string, status: string, organizationId: string, override?: TaskBitableConfig): Promise<void> {
  const t = await token(organizationId);
  const { app, table } = await ids(organizationId, override);
  const res = await fetch(`${LARK_OPENAPI_BASE}/bitable/v1/apps/${app}/tables/${table}/records/${recordId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { Status: status } }),
  });
  const j: any = await res.json();
  if (j.code !== 0) throw new Error(`lark-update-failed:${j.code}:${j.msg}`);
}
```

Add immediately after:
```ts

// specs/2026-08-21-daily-task-kanban-per-user-table-design.md — validates
// a user-submitted app_token/table_id pair BEFORE it's ever persisted, via
// a real (cheap, page_size=1) call against Lark's own fields endpoint —
// the same endpoint getTaskOptions already calls. A tenant-token failure
// or any non-zero Lark response code (wrong ids, no access, table doesn't
// exist) surfaces as `false`, never a thrown exception — the caller
// (routes/tasks.ts) turns that into a clear 400 for the user, never a
// silently-stored broken pointer.
export async function validateTaskTable(appToken: string, tableId: string, organizationId: string): Promise<boolean> {
  try {
    const t = await token(organizationId);
    const res = await fetch(`${LARK_OPENAPI_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=1`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    const j: any = await res.json();
    return j.code === 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS. Slow on this machine — 3-5+ minutes.

- [ ] **Step 10: Commit**

```bash
git add server/src/lib/larkTasks.ts
git commit -m "feat: widen larkTasks.ts for a per-user table override, add listAllTasksForOwner and validateTaskTable"
```

---

### Task 3: New routes — `GET /tasks/all`, `GET/PUT/DELETE /tasks/my-table` — and wire the override into every existing route

**Files:**
- Modify: `server/src/middleware/validate.ts` (new Zod schema)
- Modify: `server/src/routes/tasks.ts`

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces: `GET /api/tasks/all` (`{ tasks: DailyTask[] }`); `GET /api/tasks/my-table` (`{ appToken: string | null; tableId: string | null }`); `PUT /api/tasks/my-table` (body `{ appToken, tableId }`, response `{ success: true }` or a 400 `{ error: 'invalid-table', message }`); `DELETE /api/tasks/my-table` (`{ success: true }`) — all consumed by Task 4.

- [ ] **Step 1: Add the Zod schema**

In `server/src/middleware/validate.ts`, after the existing `roomDisplayNameSchema` (at the end of the file):

Current end of file:
```ts
export const roomDisplayNameSchema = z.object({
  name: z.string().min(1).max(20),
});
```

Replace with:
```ts
export const roomDisplayNameSchema = z.object({
  name: z.string().min(1).max(20),
});

// specs/2026-08-21-daily-task-kanban-per-user-table-design.md — a user's
// own Lark Base table override. Both fields required together (never just
// one) — enforced here at the schema layer, so routes/tasks.ts's handler
// never has to check for a half-filled pair itself. No format regex —
// Lark's own app_token/table_id shapes aren't documented rigidly enough to
// hardcode a pattern; this mirrors the existing admin-level equivalent
// (routes/integrations.ts's bitableAppToken/bitableTableId save), which
// only rejects embedded whitespace. This endpoint goes further than that
// existing precedent by ALSO validating against Lark's own live API before
// ever persisting (see routes/tasks.ts's PUT /tasks/my-table).
export const myTaskTableSchema = z.object({
  appToken: z.string().min(1).max(100).refine((v) => !/\s/.test(v), { message: 'Tidak boleh mengandung spasi' }),
  tableId: z.string().min(1).max(100).refine((v) => !/\s/.test(v), { message: 'Tidak boleh mengandung spasi' }),
});
```

- [ ] **Step 2: Replace `routes/tasks.ts` in full**

Current (`server/src/routes/tasks.ts`, full file):
```ts
import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { listTodayTasks, getTaskOptions, createTask, updateTaskStatus, isDailyTaskAvailable } from '../lib/larkTasks';

// A7 — Daily Task API. Thin bridge to the Lark Base table (see lib/larkTasks);
// stores nothing locally. Every handler returns a clear error the widget can
// show — a Lark outage/scope issue must never surface as a silently empty list.
//
// Per-org (specs/2026-08-16, Addendum A2 -> Bagian 3 follow-up) — Daily
// Task's Lark Base resource ids (LARK_TASK_APP_TOKEN/TABLE_ID) were
// originally global-only (Addendum A2's Non-goal), so this feature was
// restricted to the default org only. An admin can now paste their own
// org's app_token/table_id (Konsol Admin -> Integrasi), so the guard below
// checks per-org availability (isDailyTaskAvailable: DEFAULT_ORG_ID always,
// any other org only once it has its own Bitable config saved) instead of
// a hardcoded DEFAULT_ORG_ID-only check. LARK_TASK_PROJECT_TABLE_ID (the
// linked Project table) stays global/env-only for every org — out of this
// task's scope.
const router = Router();

const NOT_AVAILABLE_FOR_ORG = { error: 'not-available-for-org', message: 'Daily Task belum dikonfigurasi untuk organisasi ini — admin bisa mengatur ID tabel Lark Base di Konsol Admin → Integrasi.' };

// The Owner (Lark User) field keys on open_id, so a manual-login user with no
// larkOpenId can't own or be filtered by tasks. Surfaced as a distinct 409 so
// the widget can prompt "connect Lark" instead of showing a generic error.
async function requireLarkOpenId(userId: string): Promise<string | null> {
  const u = await getPrisma().user.findUnique({ where: { id: userId }, select: { larkOpenId: true } });
  return u?.larkOpenId ?? null;
}

const NO_LARK = { error: 'no-lark', message: 'Hubungkan akun Lark dulu (login lewat Lark) untuk memakai Daily Task.' };
const LARK_FAIL = { error: 'lark', message: 'Gagal terhubung ke Lark. Coba lagi sebentar.' };

router.get('/tasks/today', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId || !(await isDailyTaskAvailable(req.organizationId))) return res.status(403).json(NOT_AVAILABLE_FOR_ORG);
  const openId = await requireLarkOpenId(req.userId!);
  if (!openId) return res.status(409).json(NO_LARK);
  try {
    return res.json({ tasks: await listTodayTasks(openId, req.organizationId!) });
  } catch (e) {
    console.error('[tasks] today error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

router.get('/tasks/options', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId || !(await isDailyTaskAvailable(req.organizationId))) return res.status(403).json(NOT_AVAILABLE_FOR_ORG);
  try {
    return res.json(await getTaskOptions(req.organizationId!));
  } catch (e) {
    console.error('[tasks] options error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

router.post('/tasks', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId || !(await isDailyTaskAvailable(req.organizationId))) return res.status(403).json(NOT_AVAILABLE_FOR_ORG);
  const openId = await requireLarkOpenId(req.userId!);
  if (!openId) return res.status(409).json(NO_LARK);
  const task = String(req.body?.task ?? '').trim();
  if (!task) return res.status(400).json({ error: 'bad-request', message: 'Judul tugas wajib diisi.' });
  try {
    const created = await createTask(
      {
        task: task.slice(0, 500),
        workstream: req.body?.workstream || undefined,
        priority: req.body?.priority || undefined,
        status: req.body?.status || undefined,
        notes: typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 2000) : undefined,
        dueDate: typeof req.body?.dueDate === 'number' ? req.body.dueDate : undefined,
        projectRecordId: req.body?.projectRecordId || undefined,
      },
      openId,
      req.organizationId!,
    );
    return res.status(201).json({ task: created });
  } catch (e) {
    console.error('[tasks] create error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

router.patch('/tasks/:recordId', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId || !(await isDailyTaskAvailable(req.organizationId))) return res.status(403).json(NOT_AVAILABLE_FOR_ORG);
  const status = String(req.body?.status ?? '').trim();
  if (!status) return res.status(400).json({ error: 'bad-request', message: 'Status wajib diisi.' });
  try {
    await updateTaskStatus(req.params.recordId, status, req.organizationId!);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[tasks] update error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

export default router;
```

Replace with:
```ts
import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { validate, myTaskTableSchema } from '../middleware/validate';
import {
  listTodayTasks,
  listAllTasksForOwner,
  getTaskOptions,
  createTask,
  updateTaskStatus,
  isDailyTaskAvailable,
  validateTaskTable,
} from '../lib/larkTasks';
import { TaskBitableConfig } from '../lib/orgIntegration';

// A7 — Daily Task API. Thin bridge to the Lark Base table (see lib/larkTasks);
// stores nothing locally. Every handler returns a clear error the widget can
// show — a Lark outage/scope issue must never surface as a silently empty list.
//
// Per-org (specs/2026-08-16, Addendum A2 -> Bagian 3 follow-up) — Daily
// Task's Lark Base resource ids (LARK_TASK_APP_TOKEN/TABLE_ID) were
// originally global-only (Addendum A2's Non-goal), so this feature was
// restricted to the default org only. An admin can now paste their own
// org's app_token/table_id (Konsol Admin -> Integrasi), so the guard below
// checks per-org availability (isDailyTaskAvailable: DEFAULT_ORG_ID always,
// any other org only once it has its own Bitable config saved) instead of
// a hardcoded DEFAULT_ORG_ID-only check. LARK_TASK_PROJECT_TABLE_ID (the
// linked Project table) stays global/env-only for every org — out of this
// task's scope.
//
// specs/2026-08-21-daily-task-kanban-per-user-table-design.md — ON TOP of
// the per-org resolution above, a user can now ALSO bind their own Lark
// Base table (larkTaskAppToken/larkTaskTableId), which wins over the org
// default when set. getTaskUserContext below resolves both the caller's
// Lark identity AND their own override in one query, since every route
// needs the override now (even /tasks/options and PATCH, which never
// needed the caller's identity before this feature).
const router = Router();

const NOT_AVAILABLE_FOR_ORG = { error: 'not-available-for-org', message: 'Daily Task belum dikonfigurasi untuk organisasi ini — admin bisa mengatur ID tabel Lark Base di Konsol Admin → Integrasi.' };

interface TaskUserContext {
  openId: string | null;
  override: TaskBitableConfig | null;
}

// The Owner (Lark User) field keys on open_id, so a manual-login user with no
// larkOpenId can't own or be filtered by tasks. `openId` null is surfaced as a
// distinct 409 so the widget can prompt "connect Lark" instead of a generic
// error. `override` is null (half-filled or never set) means "use the org
// default" — ids() in lib/larkTasks.ts already treats undefined/null the
// same way.
async function getTaskUserContext(userId: string): Promise<TaskUserContext> {
  const u = await getPrisma().user.findUnique({
    where: { id: userId },
    select: { larkOpenId: true, larkTaskAppToken: true, larkTaskTableId: true },
  });
  return {
    openId: u?.larkOpenId ?? null,
    override: u?.larkTaskAppToken && u?.larkTaskTableId ? { appToken: u.larkTaskAppToken, tableId: u.larkTaskTableId } : null,
  };
}

const NO_LARK = { error: 'no-lark', message: 'Hubungkan akun Lark dulu (login lewat Lark) untuk memakai Daily Task.' };
const LARK_FAIL = { error: 'lark', message: 'Gagal terhubung ke Lark. Coba lagi sebentar.' };

router.get('/tasks/today', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId || !(await isDailyTaskAvailable(req.organizationId))) return res.status(403).json(NOT_AVAILABLE_FOR_ORG);
  const { openId, override } = await getTaskUserContext(req.userId!);
  if (!openId) return res.status(409).json(NO_LARK);
  try {
    return res.json({ tasks: await listTodayTasks(openId, req.organizationId!, override ?? undefined) });
  } catch (e) {
    console.error('[tasks] today error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

// specs/2026-08-21-daily-task-kanban-per-user-table-design.md — the Kanban
// view's data source: ALL of the caller's own tasks, any due date (unlike
// /tasks/today, which stays deliberately restricted to today).
router.get('/tasks/all', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId || !(await isDailyTaskAvailable(req.organizationId))) return res.status(403).json(NOT_AVAILABLE_FOR_ORG);
  const { openId, override } = await getTaskUserContext(req.userId!);
  if (!openId) return res.status(409).json(NO_LARK);
  try {
    return res.json({ tasks: await listAllTasksForOwner(openId, req.organizationId!, override ?? undefined) });
  } catch (e) {
    console.error('[tasks] all error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

router.get('/tasks/options', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId || !(await isDailyTaskAvailable(req.organizationId))) return res.status(403).json(NOT_AVAILABLE_FOR_ORG);
  const { override } = await getTaskUserContext(req.userId!);
  try {
    return res.json(await getTaskOptions(req.organizationId!, override ?? undefined));
  } catch (e) {
    console.error('[tasks] options error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

router.post('/tasks', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId || !(await isDailyTaskAvailable(req.organizationId))) return res.status(403).json(NOT_AVAILABLE_FOR_ORG);
  const { openId, override } = await getTaskUserContext(req.userId!);
  if (!openId) return res.status(409).json(NO_LARK);
  const task = String(req.body?.task ?? '').trim();
  if (!task) return res.status(400).json({ error: 'bad-request', message: 'Judul tugas wajib diisi.' });
  try {
    const created = await createTask(
      {
        task: task.slice(0, 500),
        workstream: req.body?.workstream || undefined,
        priority: req.body?.priority || undefined,
        status: req.body?.status || undefined,
        notes: typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 2000) : undefined,
        dueDate: typeof req.body?.dueDate === 'number' ? req.body.dueDate : undefined,
        projectRecordId: req.body?.projectRecordId || undefined,
      },
      openId,
      req.organizationId!,
      override ?? undefined,
    );
    return res.status(201).json({ task: created });
  } catch (e) {
    console.error('[tasks] create error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

router.patch('/tasks/:recordId', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId || !(await isDailyTaskAvailable(req.organizationId))) return res.status(403).json(NOT_AVAILABLE_FOR_ORG);
  const status = String(req.body?.status ?? '').trim();
  if (!status) return res.status(400).json({ error: 'bad-request', message: 'Status wajib diisi.' });
  const { override } = await getTaskUserContext(req.userId!);
  try {
    await updateTaskStatus(req.params.recordId, status, req.organizationId!, override ?? undefined);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[tasks] update error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

// specs/2026-08-21-daily-task-kanban-per-user-table-design.md — reads the
// caller's own current binding, for the "Hubungkan tabel saya" form to
// pre-fill/display. Gated the same as every other route here for
// consistency, even though it's a harmless read.
router.get('/tasks/my-table', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId || !(await isDailyTaskAvailable(req.organizationId))) return res.status(403).json(NOT_AVAILABLE_FOR_ORG);
  const u = await getPrisma().user.findUnique({ where: { id: req.userId! }, select: { larkTaskAppToken: true, larkTaskTableId: true } });
  return res.json({ appToken: u?.larkTaskAppToken ?? null, tableId: u?.larkTaskTableId ?? null });
});

// specs/2026-08-21-daily-task-kanban-per-user-table-design.md — save the
// caller's own Daily Task table binding. Validated against Lark's own live
// API (validateTaskTable) BEFORE persisting — never stores an unverified
// pointer. myTaskTableSchema already enforces both fields present together.
router.put('/tasks/my-table', authenticateToken, validate(myTaskTableSchema), async (req: AuthRequest, res: Response) => {
  if (!req.organizationId || !(await isDailyTaskAvailable(req.organizationId))) return res.status(403).json(NOT_AVAILABLE_FOR_ORG);
  const { appToken, tableId } = req.body as { appToken: string; tableId: string };
  try {
    const valid = await validateTaskTable(appToken, tableId, req.organizationId);
    if (!valid) {
      return res.status(400).json({ error: 'invalid-table', message: 'Tidak bisa mengakses tabel Lark Base tersebut — periksa kembali App Token dan Table ID-nya.' });
    }
    await getPrisma().user.update({
      where: { id: req.userId! },
      data: { larkTaskAppToken: appToken, larkTaskTableId: tableId },
    });
    return res.json({ success: true });
  } catch (e) {
    console.error('[tasks] my-table save error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

// specs/2026-08-21-daily-task-kanban-per-user-table-design.md — clears the
// caller's own binding; Daily Task falls back to the org default again.
router.delete('/tasks/my-table', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    await getPrisma().user.update({
      where: { id: req.userId! },
      data: { larkTaskAppToken: null, larkTaskTableId: null },
    });
    return res.json({ success: true });
  } catch (e) {
    console.error('[tasks] my-table clear error:', e);
    return res.status(502).json(LARK_FAIL);
  }
});

export default router;
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS. Slow on this machine — 3-5+ minutes.

- [ ] **Step 4: Commit**

```bash
git add server/src/middleware/validate.ts server/src/routes/tasks.ts
git commit -m "feat: add GET /tasks/all and my-table binding endpoints, thread per-user override through every route"
```

---

### Task 4: Client `api.ts` additions + install `@hello-pangea/dnd`

**Files:**
- Modify: `client/src/services/api.ts`
- Modify: `client/package.json` (via `npm install`, not a hand-edit)

**Interfaces:**
- Consumes: everything Task 3 produced.
- Produces: `api.getAllTasks(): Promise<{ tasks: DailyTask[] }>`; `MyTaskTableBinding` type; `api.getMyTaskTable(): Promise<MyTaskTableBinding>`; `api.saveMyTaskTable(appToken: string, tableId: string): Promise<{ success: boolean }>`; `api.clearMyTaskTable(): Promise<{ success: boolean }>` — consumed by Task 6. The `@hello-pangea/dnd` package — consumed by Task 5.

- [ ] **Step 1: Install the drag-and-drop dependency**

Run: `npm install @hello-pangea/dnd --workspace=client`
Expected: adds `@hello-pangea/dnd` to `client/package.json`'s `dependencies` and updates the lockfile. No existing dependency of this name was present (confirmed before writing this plan).

- [ ] **Step 2: Add the new type and functions**

Current (`client/src/services/api.ts`, right after the existing Daily Task functions):
```ts
  // A7 — Daily Task (reads/writes the Lark Base table directly).
  getTodayTasks: () => request<{ tasks: DailyTask[] }>('/tasks/today'),
  getTaskOptions: () => request<TaskOptions>('/tasks/options'),
  createTask: (body: CreateTaskBody) => request<{ task: DailyTask }>('/tasks', { method: 'POST', body: JSON.stringify(body) }),
  updateTaskStatus: (recordId: string, status: string) =>
    request<{ ok: boolean }>(`/tasks/${encodeURIComponent(recordId)}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
```

Replace with:
```ts
  // A7 — Daily Task (reads/writes the Lark Base table directly).
  getTodayTasks: () => request<{ tasks: DailyTask[] }>('/tasks/today'),
  // specs/2026-08-21-daily-task-kanban-per-user-table-design.md — the
  // Kanban view's data source: ALL of the caller's own tasks, any due date.
  getAllTasks: () => request<{ tasks: DailyTask[] }>('/tasks/all'),
  getTaskOptions: () => request<TaskOptions>('/tasks/options'),
  createTask: (body: CreateTaskBody) => request<{ task: DailyTask }>('/tasks', { method: 'POST', body: JSON.stringify(body) }),
  updateTaskStatus: (recordId: string, status: string) =>
    request<{ ok: boolean }>(`/tasks/${encodeURIComponent(recordId)}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  // specs/2026-08-21-daily-task-kanban-per-user-table-design.md — a user's
  // own Lark Base table binding for Daily Task, separate from the org
  // default. Both appToken/tableId null means no personal binding is set.
  getMyTaskTable: () => request<MyTaskTableBinding>('/tasks/my-table'),
  saveMyTaskTable: (appToken: string, tableId: string) =>
    request<{ success: boolean }>('/tasks/my-table', { method: 'PUT', body: JSON.stringify({ appToken, tableId }) }),
  clearMyTaskTable: () => request<{ success: boolean }>('/tasks/my-table', { method: 'DELETE' }),
```

Current (`client/src/services/api.ts`, the `CreateTaskBody` interface):
```ts
export interface CreateTaskBody {
  task: string;
  workstream?: string;
  priority?: string;
  status?: string;
  notes?: string;
  dueDate?: number;
  projectRecordId?: string;
}
```

Replace with:
```ts
export interface CreateTaskBody {
  task: string;
  workstream?: string;
  priority?: string;
  status?: string;
  notes?: string;
  dueDate?: number;
  projectRecordId?: string;
}

// specs/2026-08-21-daily-task-kanban-per-user-table-design.md
export interface MyTaskTableBinding {
  appToken: string | null;
  tableId: string | null;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=client`
Expected: PASS. Slow on this machine — 3-5+ minutes.

- [ ] **Step 4: Commit**

```bash
git add client/package.json client/package-lock.json client/src/services/api.ts
git commit -m "feat: add client API for all-tasks fetch and my-table binding, install @hello-pangea/dnd"
```

(If this repo uses a root-level lockfile instead of a per-workspace one, `git add` the actual lockfile path `npm install` reports having modified — check `git status` before staging if the exact path differs from `client/package-lock.json`.)

---

### Task 5: Kanban board component

**Files:**
- Create: `client/src/components/ui/TaskKanbanBoard.tsx`

**Interfaces:**
- Consumes: `DailyTask`, `TaskOptions` (`client/src/services/api.ts`, unchanged shapes); `@hello-pangea/dnd` (Task 4).
- Produces: `TaskKanbanBoard({ tasks: DailyTask[]; options: TaskOptions; onStatusChange: (recordId: string, newStatus: string) => void })` — a presentational component with no data-fetching of its own; consumed by Task 6.

- [ ] **Step 1: Create the component**

Create `client/src/components/ui/TaskKanbanBoard.tsx`:
```tsx
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { DailyTask, TaskOptions } from '@/services/api';

// specs/2026-08-21-daily-task-kanban-per-user-table-design.md — columns
// mirror whichever Status options the ACTIVE table (org default, or the
// caller's own binding) actually defines — never hardcoded, so a
// different table's different Status values just work with no changes
// here. A task whose current Status isn't one of the table's own options
// (stale data, or a status renamed in Lark after the task was set) falls
// into this extra column instead of being silently dropped from the board.
const NO_STATUS_COLUMN = 'Tanpa Status';

export function TaskKanbanBoard({
  tasks,
  options,
  onStatusChange,
}: {
  tasks: DailyTask[];
  options: TaskOptions;
  onStatusChange: (recordId: string, newStatus: string) => void;
}) {
  const columns = [...options.status, NO_STATUS_COLUMN];

  const tasksByColumn = new Map<string, DailyTask[]>(columns.map((c) => [c, []]));
  for (const t of tasks) {
    const col = t.status && options.status.includes(t.status) ? t.status : NO_STATUS_COLUMN;
    tasksByColumn.get(col)!.push(t);
  }

  const handleDragEnd = (result: DropResult) => {
    const { destination, source, draggableId } = result;
    if (!destination) return; // dropped outside any column
    if (destination.droppableId === source.droppableId) return; // no actual move
    // specs/2026-08-21-daily-task-kanban-per-user-table-design.md — "Tanpa
    // Status" is a display-only bucket, not a real Status value the table
    // defines, so there's nothing to write back if a card is dropped here.
    if (destination.droppableId === NO_STATUS_COLUMN) return;
    onStatusChange(draggableId, destination.droppableId);
  };

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {columns.map((col) => (
          <Droppable droppableId={col} key={col}>
            {(provided) => (
              <div
                ref={provided.innerRef}
                {...provided.droppableProps}
                className="w-56 flex-shrink-0 rounded-xl bg-white/60 dark:bg-gray-800/60 border border-purple-100 dark:border-gray-700 p-2"
              >
                <h3 className="text-xs font-semibold text-gray-600 dark:text-gray-300 mb-2 px-1">
                  {col} <span className="text-gray-400">({tasksByColumn.get(col)!.length})</span>
                </h3>
                <div className="space-y-2 min-h-[40px]">
                  {tasksByColumn.get(col)!.map((t, i) => (
                    <Draggable draggableId={t.recordId} index={i} key={t.recordId}>
                      {(dragProvided) => (
                        <div
                          ref={dragProvided.innerRef}
                          {...dragProvided.draggableProps}
                          {...dragProvided.dragHandleProps}
                          className="rounded-lg bg-white dark:bg-gray-900 border border-purple-100 dark:border-gray-700 px-2.5 py-2 text-xs shadow-sm cursor-grab active:cursor-grabbing"
                        >
                          <p className="text-gray-800 dark:text-gray-100">{t.task}</p>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {t.priority && <span className="px-1 py-0.5 rounded bg-purple-50 dark:bg-gray-700 text-purple-700 dark:text-purple-200 text-[10px]">{t.priority}</span>}
                            {t.workstream && <span className="px-1 py-0.5 rounded bg-purple-50 dark:bg-gray-700 text-purple-700 dark:text-purple-200 text-[10px]">{t.workstream}</span>}
                            {t.project && <span className="px-1 py-0.5 rounded bg-purple-50 dark:bg-gray-700 text-purple-700 dark:text-purple-200 text-[10px]">{t.project.name}</span>}
                          </div>
                        </div>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </div>
              </div>
            )}
          </Droppable>
        ))}
      </div>
    </DragDropContext>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck --workspace=client`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/ui/TaskKanbanBoard.tsx
git commit -m "feat: add TaskKanbanBoard component"
```

---

### Task 6: Wire the view toggle, "Hubungkan tabel saya" form, and Kanban board into `DailyTaskPanel.tsx`

**Files:**
- Modify: `client/src/components/ui/DailyTaskPanel.tsx`

**Interfaces:**
- Consumes: `api.getAllTasks`, `api.getMyTaskTable`, `api.saveMyTaskTable`, `api.clearMyTaskTable` (Task 4); `TaskKanbanBoard` (Task 5).

- [ ] **Step 1: Replace the whole file**

Current (`client/src/components/ui/DailyTaskPanel.tsx`, full file — 271 lines, shown for reference; read the actual file before editing to confirm nothing has changed since this plan was written):

```tsx
import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { XLg, PlusLg, ArrowClockwise, BoxArrowUpRight } from 'react-bootstrap-icons';
import { api, ApiError, DailyTask, TaskOptions, CreateTaskBody } from '@/services/api';

// A7 — Daily Task widget. Reads/writes a Lark Base table directly (no local
// copy), so every open queries Lark and every change posts to Lark. The form
// mirrors the real table columns (confirmed via API): Task, Workstream,
// Priority, Due Date, Status, Notes, Related Project — Owner is auto (the
// logged-in user). Select/Project options are fetched LIVE from Lark, never
// hardcoded. Loading + error states are explicit because these are external
// API calls, not instant local reads.

function todayInputValue(): string {
  // Local YYYY-MM-DD for the date input's default.
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDue(ms: number | null): string {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
}

const DONE_STATUS = 'Done';
const UNDONE_STATUS = 'In Progress';

export function DailyTaskPanel({ onClose }: { onClose: () => void }) {
  const [tasks, setTasks] = useState<DailyTask[]>([]);
  const [options, setOptions] = useState<TaskOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [noLark, setNoLark] = useState(false);
  const [busyRecord, setBusyRecord] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setNoLark(false);
    try {
      // Options can fail independently of the list; the list is the critical one.
      const [tasksRes, optsRes] = await Promise.allSettled([api.getTodayTasks(), api.getTaskOptions()]);
      if (tasksRes.status === 'rejected') throw tasksRes.reason;
      setTasks(tasksRes.value.tasks);
      if (optsRes.status === 'fulfilled') setOptions(optsRes.value);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setNoLark(true);
      else setError(e instanceof Error && e.message !== 'lark' ? 'Gagal memuat task dari Lark. Coba lagi.' : 'Gagal terhubung ke Lark. Coba lagi sebentar.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleDone = async (t: DailyTask) => {
    setBusyRecord(t.recordId);
    const next = t.status === DONE_STATUS ? UNDONE_STATUS : DONE_STATUS;
    try {
      await api.updateTaskStatus(t.recordId, next);
      setTasks((prev) => prev.map((x) => (x.recordId === t.recordId ? { ...x, status: next } : x)));
    } catch {
      setError('Gagal mengubah status di Lark.');
    } finally {
      setBusyRecord(null);
    }
  };

  return (
    <div className="absolute inset-0 z-40 bg-purple-50/95 dark:bg-gray-900/95 backdrop-blur-md pl-14 pointer-events-auto overflow-y-auto">
      <div className="max-w-2xl mx-auto px-5 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-gray-900 dark:text-gray-100 text-lg font-bold">Daily Task</h2>
            <p className="text-gray-500 dark:text-gray-400 text-xs">Tugas kamu hari ini — tersambung langsung ke Lark Base.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void load()} title="Muat ulang" className="text-gray-500 hover:text-purple-600 dark:text-gray-400 dark:hover:text-purple-300 cursor-pointer p-1.5">
              <ArrowClockwise size={16} />
            </button>
            <button onClick={onClose} title="Tutup" className="text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100 cursor-pointer p-1.5">
              <XLg size={18} />
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm py-10 text-center">Memuat dari Lark…</p>
        ) : noLark ? (
          <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-800 dark:text-amber-200">
            Hubungkan akun Lark dulu (logout lalu <span className="font-medium">Login dengan Lark</span>) untuk memakai Daily Task — task disimpan atas nama akun Lark kamu.
          </div>
        ) : (
          <>
            {error && (
              <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs px-3 py-2 mb-3 flex items-center justify-between">
                <span>{error}</span>
                <button onClick={() => void load()} className="underline cursor-pointer">Coba lagi</button>
              </div>
            )}

            {!formOpen && (
              <button
                onClick={() => setFormOpen(true)}
                className="inline-flex items-center gap-1.5 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium px-3 py-2 rounded-lg cursor-pointer mb-4"
              >
                <PlusLg size={15} /> Tambah Task
              </button>
            )}

            {formOpen && options && (
              <TaskForm
                options={options}
                submitting={submitting}
                onCancel={() => setFormOpen(false)}
                onSubmit={async (body) => {
                  setSubmitting(true);
                  setError('');
                  try {
                    const { task } = await api.createTask(body);
                    // Only prepend if it belongs to today's owned view (it does:
                    // owner=me; due date may differ, so reload to stay truthful).
                    setTasks((prev) => [task, ...prev]);
                    setFormOpen(false);
                    void load();
                  } catch {
                    setError('Gagal menyimpan task ke Lark.');
                  } finally {
                    setSubmitting(false);
                  }
                }}
              />
            )}

            {tasks.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400 text-sm py-6 text-center">Belum ada task untuk hari ini.</p>
            ) : (
              <div className="space-y-2">
                {tasks.map((t) => {
                  const done = t.status === DONE_STATUS;
                  return (
                    <div key={t.recordId} className="flex items-start gap-3 rounded-lg bg-white dark:bg-gray-800 border border-purple-100 dark:border-gray-700 px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={done}
                        disabled={busyRecord === t.recordId}
                        onChange={() => void toggleDone(t)}
                        className="mt-1 h-4 w-4 accent-purple-600 cursor-pointer disabled:opacity-50"
                      />
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm ${done ? 'line-through text-gray-400 dark:text-gray-500' : 'text-gray-800 dark:text-gray-100'}`}>{t.task}</p>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[10px]">
                          {t.status && <Badge>{t.status}</Badge>}
                          {t.priority && <Badge>{t.priority}</Badge>}
                          {t.workstream && <Badge>{t.workstream}</Badge>}
                          {t.project && <Badge>{t.project.name}</Badge>}
                          {t.dueDate && <span className="text-gray-400 dark:text-gray-500">{fmtDue(t.dueDate)}</span>}
                        </div>
                        {t.notes && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t.notes}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <a
              href="https://osgfmmt9uzgh.sg.larksuite.com/base/UXozb1N5TapUC4s7fu2lpmDigwc?table=tbl4HKtwKhDS99pJ"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-purple-600 dark:text-purple-300 hover:underline mt-5"
            >
              <BoxArrowUpRight size={11} /> Buka di Lark Base
            </a>
          </>
        )}
      </div>
    </div>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return <span className="px-1.5 py-0.5 rounded bg-purple-50 dark:bg-gray-700 text-purple-700 dark:text-purple-200">{children}</span>;
}

function TaskForm({
  options,
  submitting,
  onSubmit,
  onCancel,
}: {
  options: TaskOptions;
  submitting: boolean;
  onSubmit: (body: CreateTaskBody) => void;
  onCancel: () => void;
}) {
  const [task, setTask] = useState('');
  const [workstream, setWorkstream] = useState('');
  const [priority, setPriority] = useState('');
  const [status, setStatus] = useState(options.status[0] ?? '');
  const [projectRecordId, setProjectRecordId] = useState('');
  const [due, setDue] = useState(todayInputValue());
  const [notes, setNotes] = useState('');

  const inputCls =
    'w-full bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm rounded px-2.5 py-1.5 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500';

  return (
    <div className="rounded-xl border border-purple-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 mb-4 space-y-2.5">
      <input autoFocus value={task} onChange={(e) => setTask(e.target.value)} placeholder="Judul tugas…" className={inputCls} />
      <div className="grid grid-cols-2 gap-2">
        <Select label="Workstream" value={workstream} onChange={setWorkstream} options={options.workstream} cls={inputCls} />
        <Select label="Priority" value={priority} onChange={setPriority} options={options.priority} cls={inputCls} />
        <Select label="Status" value={status} onChange={setStatus} options={options.status} cls={inputCls} />
        <label className="text-xs text-gray-500 dark:text-gray-400">
          Due Date
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={`${inputCls} mt-0.5`} />
        </label>
      </div>
      <label className="text-xs text-gray-500 dark:text-gray-400 block">
        Related Project
        <select value={projectRecordId} onChange={(e) => setProjectRecordId(e.target.value)} className={`${inputCls} mt-0.5 cursor-pointer`}>
          <option value="">— Tidak ada —</option>
          {options.projects.map((p) => (
            <option key={p.recordId} value={p.recordId}>{p.name}</option>
          ))}
        </select>
      </label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Catatan (opsional)…" rows={2} className={inputCls} />
      <div className="flex items-center gap-2 pt-1">
        <button
          disabled={submitting || !task.trim()}
          onClick={() =>
            onSubmit({
              task: task.trim(),
              workstream: workstream || undefined,
              priority: priority || undefined,
              status: status || undefined,
              notes: notes.trim() || undefined,
              dueDate: due ? new Date(`${due}T00:00:00`).getTime() : undefined,
              projectRecordId: projectRecordId || undefined,
            })
          }
          className="bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium px-3 py-1.5 rounded-lg cursor-pointer disabled:opacity-50"
        >
          {submitting ? 'Menyimpan…' : 'Simpan ke Lark'}
        </button>
        <button onClick={onCancel} disabled={submitting} className="text-gray-500 dark:text-gray-400 text-sm px-2 cursor-pointer">Batal</button>
      </div>
    </div>
  );
}

function Select({ label, value, onChange, options, cls }: { label: string; value: string; onChange: (v: string) => void; options: string[]; cls: string }) {
  return (
    <label className="text-xs text-gray-500 dark:text-gray-400">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${cls} mt-0.5 cursor-pointer`}>
        <option value="">— Pilih —</option>
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}
```

Replace with:
```tsx
import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { XLg, PlusLg, ArrowClockwise, BoxArrowUpRight, Link45deg } from 'react-bootstrap-icons';
import { api, ApiError, DailyTask, TaskOptions, CreateTaskBody } from '@/services/api';
import { TaskKanbanBoard } from './TaskKanbanBoard';

// A7 — Daily Task widget. Reads/writes a Lark Base table directly (no local
// copy), so every open queries Lark and every change posts to Lark. The form
// mirrors the real table columns (confirmed via API): Task, Workstream,
// Priority, Due Date, Status, Notes, Related Project — Owner is auto (the
// logged-in user). Select/Project options are fetched LIVE from Lark, never
// hardcoded. Loading + error states are explicit because these are external
// API calls, not instant local reads.
//
// specs/2026-08-21-daily-task-kanban-per-user-table-design.md — a second
// view (Kanban) and an optional per-user table binding, both added here.

function todayInputValue(): string {
  // Local YYYY-MM-DD for the date input's default.
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDue(ms: number | null): string {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
}

const DONE_STATUS = 'Done';
const UNDONE_STATUS = 'In Progress';

type ViewMode = 'list' | 'kanban';

export function DailyTaskPanel({ onClose }: { onClose: () => void }) {
  const [tasks, setTasks] = useState<DailyTask[]>([]);
  const [options, setOptions] = useState<TaskOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [noLark, setNoLark] = useState(false);
  const [busyRecord, setBusyRecord] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // specs/2026-08-21-daily-task-kanban-per-user-table-design.md — manual
  // toggle, deliberately NOT persisted anywhere: resets to 'list' every
  // time this panel mounts (the user explicitly did not ask for this to be
  // remembered, and it keeps the first version simpler).
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  const load = useCallback(async (mode: ViewMode) => {
    setLoading(true);
    setError('');
    setNoLark(false);
    try {
      // Options can fail independently of the list; the list is the critical one.
      const tasksCall = mode === 'kanban' ? api.getAllTasks() : api.getTodayTasks();
      const [tasksRes, optsRes] = await Promise.allSettled([tasksCall, api.getTaskOptions()]);
      if (tasksRes.status === 'rejected') throw tasksRes.reason;
      setTasks(tasksRes.value.tasks);
      if (optsRes.status === 'fulfilled') setOptions(optsRes.value);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setNoLark(true);
      else setError(e instanceof Error && e.message !== 'lark' ? 'Gagal memuat task dari Lark. Coba lagi.' : 'Gagal terhubung ke Lark. Coba lagi sebentar.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(viewMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  const toggleDone = async (t: DailyTask) => {
    setBusyRecord(t.recordId);
    const next = t.status === DONE_STATUS ? UNDONE_STATUS : DONE_STATUS;
    try {
      await api.updateTaskStatus(t.recordId, next);
      setTasks((prev) => prev.map((x) => (x.recordId === t.recordId ? { ...x, status: next } : x)));
    } catch {
      setError('Gagal mengubah status di Lark.');
    } finally {
      setBusyRecord(null);
    }
  };

  // specs/2026-08-21-daily-task-kanban-per-user-table-design.md — Kanban's
  // drag-to-change-status handler: optimistic update immediately (so the
  // card visibly lands in its new column without waiting on the network),
  // then reverts on failure — same "never show a state that wasn't
  // actually written to Lark" posture as toggleDone above.
  const handleKanbanStatusChange = async (recordId: string, newStatus: string) => {
    const prevTasks = tasks;
    setTasks((prev) => prev.map((x) => (x.recordId === recordId ? { ...x, status: newStatus } : x)));
    try {
      await api.updateTaskStatus(recordId, newStatus);
    } catch {
      setTasks(prevTasks);
      setError('Gagal mengubah status di Lark.');
    }
  };

  return (
    <div className="absolute inset-0 z-40 bg-purple-50/95 dark:bg-gray-900/95 backdrop-blur-md pl-14 pointer-events-auto overflow-y-auto">
      <div className={viewMode === 'kanban' ? 'max-w-4xl mx-auto px-5 py-6' : 'max-w-2xl mx-auto px-5 py-6'}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-gray-900 dark:text-gray-100 text-lg font-bold">Daily Task</h2>
            <p className="text-gray-500 dark:text-gray-400 text-xs">
              {viewMode === 'kanban' ? 'Semua tugas kamu — tersambung langsung ke Lark Base.' : 'Tugas kamu hari ini — tersambung langsung ke Lark Base.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-lg border border-purple-200 dark:border-gray-700 overflow-hidden text-xs">
              <button
                onClick={() => setViewMode('list')}
                className={`px-2.5 py-1.5 cursor-pointer ${viewMode === 'list' ? 'bg-purple-600 text-white' : 'text-gray-500 dark:text-gray-400 hover:bg-purple-50 dark:hover:bg-gray-800'}`}
              >
                List
              </button>
              <button
                onClick={() => setViewMode('kanban')}
                className={`px-2.5 py-1.5 cursor-pointer ${viewMode === 'kanban' ? 'bg-purple-600 text-white' : 'text-gray-500 dark:text-gray-400 hover:bg-purple-50 dark:hover:bg-gray-800'}`}
              >
                Kanban
              </button>
            </div>
            <button onClick={() => void load(viewMode)} title="Muat ulang" className="text-gray-500 hover:text-purple-600 dark:text-gray-400 dark:hover:text-purple-300 cursor-pointer p-1.5">
              <ArrowClockwise size={16} />
            </button>
            <button onClick={onClose} title="Tutup" className="text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100 cursor-pointer p-1.5">
              <XLg size={18} />
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm py-10 text-center">Memuat dari Lark…</p>
        ) : noLark ? (
          <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-800 dark:text-amber-200">
            Hubungkan akun Lark dulu (logout lalu <span className="font-medium">Login dengan Lark</span>) untuk memakai Daily Task — task disimpan atas nama akun Lark kamu.
          </div>
        ) : (
          <>
            {error && (
              <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs px-3 py-2 mb-3 flex items-center justify-between">
                <span>{error}</span>
                <button onClick={() => void load(viewMode)} className="underline cursor-pointer">Coba lagi</button>
              </div>
            )}

            {viewMode === 'list' && (
              <>
                {!formOpen && (
                  <button
                    onClick={() => setFormOpen(true)}
                    className="inline-flex items-center gap-1.5 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium px-3 py-2 rounded-lg cursor-pointer mb-4"
                  >
                    <PlusLg size={15} /> Tambah Task
                  </button>
                )}

                {formOpen && options && (
                  <TaskForm
                    options={options}
                    submitting={submitting}
                    onCancel={() => setFormOpen(false)}
                    onSubmit={async (body) => {
                      setSubmitting(true);
                      setError('');
                      try {
                        const { task } = await api.createTask(body);
                        setTasks((prev) => [task, ...prev]);
                        setFormOpen(false);
                        void load(viewMode);
                      } catch {
                        setError('Gagal menyimpan task ke Lark.');
                      } finally {
                        setSubmitting(false);
                      }
                    }}
                  />
                )}

                {tasks.length === 0 ? (
                  <p className="text-gray-500 dark:text-gray-400 text-sm py-6 text-center">Belum ada task untuk hari ini.</p>
                ) : (
                  <div className="space-y-2">
                    {tasks.map((t) => {
                      const done = t.status === DONE_STATUS;
                      return (
                        <div key={t.recordId} className="flex items-start gap-3 rounded-lg bg-white dark:bg-gray-800 border border-purple-100 dark:border-gray-700 px-3 py-2.5">
                          <input
                            type="checkbox"
                            checked={done}
                            disabled={busyRecord === t.recordId}
                            onChange={() => void toggleDone(t)}
                            className="mt-1 h-4 w-4 accent-purple-600 cursor-pointer disabled:opacity-50"
                          />
                          <div className="min-w-0 flex-1">
                            <p className={`text-sm ${done ? 'line-through text-gray-400 dark:text-gray-500' : 'text-gray-800 dark:text-gray-100'}`}>{t.task}</p>
                            <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[10px]">
                              {t.status && <Badge>{t.status}</Badge>}
                              {t.priority && <Badge>{t.priority}</Badge>}
                              {t.workstream && <Badge>{t.workstream}</Badge>}
                              {t.project && <Badge>{t.project.name}</Badge>}
                              {t.dueDate && <span className="text-gray-400 dark:text-gray-500">{fmtDue(t.dueDate)}</span>}
                            </div>
                            {t.notes && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t.notes}</p>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {viewMode === 'kanban' && options && (
              <>
                <button
                  onClick={() => setFormOpen(true)}
                  className="inline-flex items-center gap-1.5 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium px-3 py-2 rounded-lg cursor-pointer mb-4"
                >
                  <PlusLg size={15} /> Tambah Task
                </button>
                <TaskKanbanBoard tasks={tasks} options={options} onStatusChange={handleKanbanStatusChange} />
                {formOpen && (
                  <TaskFormModal
                    options={options}
                    submitting={submitting}
                    onCancel={() => setFormOpen(false)}
                    onSubmit={async (body) => {
                      setSubmitting(true);
                      setError('');
                      try {
                        const { task } = await api.createTask(body);
                        // Unlike List view's onSubmit below, no void load(viewMode)
                        // here — Kanban's scope is ALL of the caller's own tasks
                        // (no date restriction), so a just-created task always
                        // belongs in this view regardless of its due date; the
                        // local prepend is unconditionally truthful, unlike
                        // List's due-date-scoped view where it might not be.
                        setTasks((prev) => [task, ...prev]);
                        setFormOpen(false);
                      } catch {
                        setError('Gagal menyimpan task ke Lark.');
                      } finally {
                        setSubmitting(false);
                      }
                    }}
                  />
                )}
              </>
            )}

            <MyTaskTableSettings />

            <a
              href="https://osgfmmt9uzgh.sg.larksuite.com/base/UXozb1N5TapUC4s7fu2lpmDigwc?table=tbl4HKtwKhDS99pJ"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-purple-600 dark:text-purple-300 hover:underline mt-3"
            >
              <BoxArrowUpRight size={11} /> Buka di Lark Base
            </a>
          </>
        )}
      </div>
    </div>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return <span className="px-1.5 py-0.5 rounded bg-purple-50 dark:bg-gray-700 text-purple-700 dark:text-purple-200">{children}</span>;
}

// specs/2026-08-21-daily-task-kanban-per-user-table-design.md — same
// TaskForm as the List view's inline usage, wrapped in a modal shell so
// "+ Tambah Task" is reachable from the Kanban view too, per this
// feature's own requirement. List view's own inline placement is
// unchanged — only Kanban gets this modal treatment.
function TaskFormModal({
  options,
  submitting,
  onSubmit,
  onCancel,
}: {
  options: TaskOptions;
  submitting: boolean;
  onSubmit: (body: CreateTaskBody) => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onCancel}>
      <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <TaskForm options={options} submitting={submitting} onSubmit={onSubmit} onCancel={onCancel} />
      </div>
    </div>
  );
}

// specs/2026-08-21-daily-task-kanban-per-user-table-design.md — lets a
// user paste their OWN App Token + Table ID so Daily Task reads/writes a
// different Lark Base table than the org default. Validated server-side
// against Lark's live API before being persisted (see routes/tasks.ts's
// PUT /tasks/my-table) — this component just surfaces whatever error that
// returns. Collapsed by default; fetches the CURRENT binding (if any) the
// first time it's expanded, so re-opening the panel doesn't need a fresh
// network call every time for something most users will never touch.
function MyTaskTableSettings() {
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [appToken, setAppToken] = useState('');
  const [tableId, setTableId] = useState('');
  const [bound, setBound] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsMsg, setSettingsMsg] = useState('');

  const ensureLoaded = async () => {
    if (loaded) return;
    try {
      const binding = await api.getMyTaskTable();
      setAppToken(binding.appToken ?? '');
      setTableId(binding.tableId ?? '');
      setBound(!!(binding.appToken && binding.tableId));
    } catch {
      // A failed read here just leaves the form empty — the user can still
      // try pasting fresh values; this is a settings affordance, not the
      // main Daily Task data path, so it degrades quietly.
    } finally {
      setLoaded(true);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSettingsError('');
    setSettingsMsg('');
    try {
      await api.saveMyTaskTable(appToken.trim(), tableId.trim());
      setBound(true);
      setSettingsMsg('Tabel berhasil terhubung.');
    } catch (e) {
      // request()'s ApiError carries the response body's `error` CODE as
      // .message (see api.ts's request() — it never surfaces the body's
      // separate human-readable `message` field), same convention this
      // file's own existing load() already relies on (checking
      // e.message !== 'lark'). So this checks the CODE 'invalid-table'
      // from routes/tasks.ts's PUT /tasks/my-table, not any server text.
      setSettingsError(
        e instanceof ApiError && e.message === 'invalid-table'
          ? 'Tidak bisa mengakses tabel Lark Base tersebut — periksa kembali App Token dan Table ID-nya.'
          : 'Gagal menyimpan. Coba lagi.',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    setSettingsError('');
    setSettingsMsg('');
    try {
      await api.clearMyTaskTable();
      setAppToken('');
      setTableId('');
      setBound(false);
      setSettingsMsg('Kembali memakai tabel default organisasi.');
    } catch {
      setSettingsError('Gagal melepas tabel. Coba lagi.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-5 border-t border-purple-100 dark:border-gray-700 pt-3">
      <button
        onClick={() => {
          const next = !expanded;
          setExpanded(next);
          if (next) void ensureLoaded();
        }}
        className="inline-flex items-center gap-1.5 text-[11px] text-purple-600 dark:text-purple-300 hover:underline cursor-pointer"
      >
        <Link45deg size={13} /> Hubungkan tabel saya {bound && '(terhubung)'}
      </button>
      {expanded && (
        <div className="mt-2.5 rounded-xl border border-purple-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 space-y-2 max-w-sm">
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            Pakai tabel Lark Base kamu sendiri untuk Daily Task, bukan tabel default organisasi.
          </p>
          <input
            value={appToken}
            onChange={(e) => setAppToken(e.target.value)}
            placeholder="App Token"
            className="w-full bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 text-xs rounded px-2.5 py-1.5 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500"
          />
          <input
            value={tableId}
            onChange={(e) => setTableId(e.target.value)}
            placeholder="Table ID"
            className="w-full bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 text-xs rounded px-2.5 py-1.5 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500"
          />
          {settingsError && <p className="text-[11px] text-red-600 dark:text-red-400">{settingsError}</p>}
          {settingsMsg && <p className="text-[11px] text-green-600 dark:text-green-400">{settingsMsg}</p>}
          <div className="flex items-center gap-2 pt-1">
            <button
              disabled={saving || !appToken.trim() || !tableId.trim()}
              onClick={() => void handleSave()}
              className="bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium px-2.5 py-1.5 rounded-lg cursor-pointer disabled:opacity-50"
            >
              {saving ? 'Menyimpan…' : 'Simpan'}
            </button>
            {bound && (
              <button
                disabled={saving}
                onClick={() => void handleClear()}
                className="text-gray-500 dark:text-gray-400 text-xs px-2 cursor-pointer disabled:opacity-50"
              >
                Lepas
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TaskForm({
  options,
  submitting,
  onSubmit,
  onCancel,
}: {
  options: TaskOptions;
  submitting: boolean;
  onSubmit: (body: CreateTaskBody) => void;
  onCancel: () => void;
}) {
  const [task, setTask] = useState('');
  const [workstream, setWorkstream] = useState('');
  const [priority, setPriority] = useState('');
  const [status, setStatus] = useState(options.status[0] ?? '');
  const [projectRecordId, setProjectRecordId] = useState('');
  const [due, setDue] = useState(todayInputValue());
  const [notes, setNotes] = useState('');

  const inputCls =
    'w-full bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm rounded px-2.5 py-1.5 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500';

  return (
    <div className="rounded-xl border border-purple-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 mb-4 space-y-2.5">
      <input autoFocus value={task} onChange={(e) => setTask(e.target.value)} placeholder="Judul tugas…" className={inputCls} />
      <div className="grid grid-cols-2 gap-2">
        <Select label="Workstream" value={workstream} onChange={setWorkstream} options={options.workstream} cls={inputCls} />
        <Select label="Priority" value={priority} onChange={setPriority} options={options.priority} cls={inputCls} />
        <Select label="Status" value={status} onChange={setStatus} options={options.status} cls={inputCls} />
        <label className="text-xs text-gray-500 dark:text-gray-400">
          Due Date
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={`${inputCls} mt-0.5`} />
        </label>
      </div>
      <label className="text-xs text-gray-500 dark:text-gray-400 block">
        Related Project
        <select value={projectRecordId} onChange={(e) => setProjectRecordId(e.target.value)} className={`${inputCls} mt-0.5 cursor-pointer`}>
          <option value="">— Tidak ada —</option>
          {options.projects.map((p) => (
            <option key={p.recordId} value={p.recordId}>{p.name}</option>
          ))}
        </select>
      </label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Catatan (opsional)…" rows={2} className={inputCls} />
      <div className="flex items-center gap-2 pt-1">
        <button
          disabled={submitting || !task.trim()}
          onClick={() =>
            onSubmit({
              task: task.trim(),
              workstream: workstream || undefined,
              priority: priority || undefined,
              status: status || undefined,
              notes: notes.trim() || undefined,
              dueDate: due ? new Date(`${due}T00:00:00`).getTime() : undefined,
              projectRecordId: projectRecordId || undefined,
            })
          }
          className="bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium px-3 py-1.5 rounded-lg cursor-pointer disabled:opacity-50"
        >
          {submitting ? 'Menyimpan…' : 'Simpan ke Lark'}
        </button>
        <button onClick={onCancel} disabled={submitting} className="text-gray-500 dark:text-gray-400 text-sm px-2 cursor-pointer">Batal</button>
      </div>
    </div>
  );
}

function Select({ label, value, onChange, options, cls }: { label: string; value: string; onChange: (v: string) => void; options: string[]; cls: string }) {
  return (
    <label className="text-xs text-gray-500 dark:text-gray-400">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${cls} mt-0.5 cursor-pointer`}>
        <option value="">— Pilih —</option>
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}
```

Note: the "Buka di Lark Base" link (near the bottom) is left pointing at the org's default table URL, unchanged — a known, deliberately out-of-scope minor inconsistency for a user who has bound their own table (this plan's spec never asked for this link to become dynamic, and doing so would need the server to also expose the resolved URL, which is a separate, small addition if ever wanted later).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck --workspace=client`
Expected: PASS. Slow on this machine — 3-5+ minutes.

- [ ] **Step 3: Also run the server typecheck once more from a clean state**

Run: `npm run typecheck --workspace=server`
Expected: PASS (no server files touched by this task, but confirms every earlier task's combined state is still clean).

- [ ] **Step 4: Commit**

```bash
git add client/src/components/ui/DailyTaskPanel.tsx
git commit -m "feat: add Kanban view and per-user table binding settings to Daily Task"
```

---

## Final Verification

- [ ] `npm run typecheck --workspace=server` — PASS, zero errors.
- [ ] `npm run typecheck --workspace=client` — PASS, zero errors.
- [ ] `git log --oneline -6` — confirm the 6 commits above exist in order.

## Manual Testing After Deploy

1. Log in as a user with no personal table binding and open Daily Task. Confirm it opens on List view by default, showing today's tasks exactly as before this feature.
2. Toggle to Kanban view. Confirm it shows ALL of your own tasks (not just today's), grouped into columns that match the table's actual Status options (plus a "Tanpa Status" column for anything that doesn't match, if applicable).
3. Drag a card from one column to another. Confirm its Status updates — verify by switching back to List view (or checking Lark Base directly) that the change actually landed.
4. Click "+ Tambah Task" from the Kanban view. Confirm the same task form appears as a modal, and the created task lands in the column matching its chosen Status.
5. Expand "Hubungkan tabel saya", paste a VALID App Token + Table ID (one your Lark app actually has Bitable access to), and save. Confirm it succeeds, and that subsequent List/Kanban fetches now come from that table instead of the org default (e.g., a task that only exists in the personal table now shows up; one that only exists in the org table no longer does).
6. Paste an INVALID or inaccessible App Token/Table ID and try to save. Confirm it's rejected with a clear error and nothing gets persisted (reload the panel — the binding should be unchanged from before the failed attempt).
7. With a valid personal table set, click "Lepas" to clear it. Confirm Daily Task falls back to the org default table again.
8. Confirm the existing "today" List view's own scope (due date = today only) is completely unaffected for a user who never touches Kanban or the table-binding settings.
9. Log in as a user with no `larkOpenId` (a manual-login account never connected to Lark). Confirm the existing "connect Lark" prompt still appears before any of the new UI (view toggle, Kanban, table settings) is reachable.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-21-daily-task-kanban-per-user-table-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
