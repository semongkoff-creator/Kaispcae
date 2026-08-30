# Employment Type (Freelance/Fulltime) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workspace admin mark each Kaitech staff member as "Fulltime" or "Freelance" from the existing Admin Console → Members tab, as a pure visible label with no effect on any other feature.

**Architecture:** One additive `User.employmentType` column (plain string, same pattern as the existing `workspaceRole` column), a shared type + label map next to `WorkspaceRole`'s own, one new `select`/PATCH-validation branch on the existing Members admin route, and one new column in the existing Members table UI.

**Tech Stack:** Prisma/Postgres (server), Express (server), React/TypeScript (client) — no new dependencies.

## Global Constraints

- `employmentType` is a plain `String @default("fulltime")` column — no DB enum, validated at the application layer exactly like `workspaceRole` already is.
- The field is a PURE LABEL — no other feature (attendance, permissions, analytics, Sidebar, etc.) may read or branch on this value anywhere in this plan's tasks.
- Every existing account must read as `"fulltime"` immediately after migration, with zero other behavior change.
- No bulk-import/CSV path — one admin toggles it per person through the existing Members table UI, same as every other field there.
- The 3 not-yet-identified people (Amal, Reza, Septi) are explicitly out of scope for this plan.

---

### Task 1: Schema + shared type + server route

**Files:**
- Modify: `server/prisma/schema.prisma:138` (`User` model, right after `workspaceRole`)
- Create: `server/prisma/migrations/20260826000000_employment_type/migration.sql`
- Modify: `shared/workspacePermissions.ts` (append after line 111, the end of the file)
- Modify: `server/src/routes/admin.ts:36-57` (`GET /admin/members`), `server/src/routes/admin.ts:60-140` (`PATCH /admin/members/:userId`)

**Interfaces:**
- Produces: `EmploymentType` (`'fulltime' | 'freelance'`) and `EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string>`, both exported from `shared/workspacePermissions.ts` (re-exported via `@virtualmeet/shared`) — Task 2's client code imports both from there, exactly how `WorkspaceRole`/`WORKSPACE_ROLE_LABELS` are already imported today.
- Produces: `GET /admin/members`'s response now includes `employmentType: string` per member; `PATCH /admin/members/:userId` now accepts an optional `employmentType` field in its request body.

- [ ] **Step 1: Add the schema field**

`server/prisma/schema.prisma:138` currently reads:

```prisma
  workspaceRole           String                    @default("member")
```

Add a new field directly after it (before the `timezone` field on the current line 141), matching the existing column-alignment style:

```prisma
  workspaceRole           String                    @default("member")
  // Pure label ("who's freelance vs fulltime") — no other feature reads or
  // branches on this. Same plain-string, app-layer-validated pattern as
  // workspaceRole above, not a DB enum.
  employmentType          String                    @default("fulltime")
```

- [ ] **Step 2: Write the migration**

Create `server/prisma/migrations/20260826000000_employment_type/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "User" ADD COLUMN "employmentType" TEXT NOT NULL DEFAULT 'fulltime';
```

No foreign key, no index — nothing else references this column (matches the plan's "pure label" constraint).

Verify against your local dev Postgres container the same way this session's prior migrations were verified: apply it and confirm `\d "User"` in `psql` shows the new column with the right type/default, then confirm `npx prisma migrate diff` (or an equivalent no-op check) reports no drift between the migration and `schema.prisma`, following whatever exact verification steps this session has used for its prior hand-authored migrations.

- [ ] **Step 3: Add the shared type + label map**

`shared/workspacePermissions.ts` currently ends at line 111 with:

```typescript
export const WORKSPACE_ROLE_LABELS: Record<WorkspaceRole, string> = {
  admin: 'Admin',
  member: 'Anggota',
};
```

Append directly after it (new lines 113 onward):

```typescript

export type EmploymentType = 'fulltime' | 'freelance';

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  fulltime: 'Fulltime',
  freelance: 'Freelance',
};
```

- [ ] **Step 4: Expose the field in `GET /admin/members`**

`server/src/routes/admin.ts:36-57` currently reads:

```typescript
admin.get('/admin/members', authenticateToken, requireWorkspace('workspace:manageMembers'), async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const users = await prisma.user.findMany({
      // Multi-tenant Fase 2 — used to have no where at all, returning every
      // account in the deployment to any workspace admin regardless of org.
      where: { organizationId: req.organizationId },
      select: {
        id: true, email: true, displayName: true, workspaceRole: true, timezone: true,
        active: true, createdAt: true,
        department: { select: { id: true, name: true } },
        manager: { select: { id: true, displayName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return res.json({ members: users });
  } catch (err) {
    console.error('[admin] members error:', err);
    return res.status(500).json({ error: 'Gagal memuat anggota' });
  }
});
```

Change only the `select` line to add `employmentType: true`:

```typescript
      select: {
        id: true, email: true, displayName: true, workspaceRole: true, employmentType: true, timezone: true,
        active: true, createdAt: true,
        department: { select: { id: true, name: true } },
        manager: { select: { id: true, displayName: true } },
      },
```

- [ ] **Step 5: Add the validated PATCH branch**

`server/src/routes/admin.ts:77-92` currently reads:

```typescript
    if (req.body?.workspaceRole !== undefined) {
      const role = String(req.body.workspaceRole);
      if (role !== 'admin' && role !== 'member') return res.status(400).json({ error: 'Peran tidak valid' });
      // Guard against locking the workspace out of itself: the last active
      // admin may not demote themselves (mirrors the Base module's
      // last-owner rule). Scoped to the TARGET's own org — an unscoped
      // count across every org would almost never trip once a second org
      // exists, silently defeating this guard for org A the moment org B
      // has its own admin.
      if (target.workspaceRole === 'admin' && role === 'member') {
        const admins = await prisma.user.count({ where: { workspaceRole: 'admin', active: true, organizationId: req.organizationId } });
        if (admins <= 1) return res.status(400).json({ error: 'Admin terakhir tidak bisa diturunkan' });
      }
      before.workspaceRole = target.workspaceRole; after.workspaceRole = role;
      data.workspaceRole = role;
    }
```

Add a new, simpler branch immediately after this one closes (before the existing `if (req.body?.active !== undefined) {` block):

```typescript
    if (req.body?.employmentType !== undefined) {
      const employmentType = String(req.body.employmentType);
      if (employmentType !== 'fulltime' && employmentType !== 'freelance') {
        return res.status(400).json({ error: 'Status kerja tidak valid' });
      }
      // Pure label — no admin-lockout guard needed (unlike workspaceRole
      // above), since this carries no permission weight to lock anyone out of.
      before.employmentType = target.employmentType; after.employmentType = employmentType;
      data.employmentType = employmentType;
    }
```

`target` (the result of `findUserInOrg`, `server/src/routes/admin.ts:68-70`) is currently selected as `{ id: true, workspaceRole: true, active: true, departmentId: true, managerId: true, displayName: true }` — add `employmentType: true` to that select too, so `target.employmentType` (used in the `before.employmentType = target.employmentType` line above) is actually populated rather than `undefined`:

```typescript
    const target = await findUserInOrg(prisma, req.params.userId, req.organizationId, {
      id: true, workspaceRole: true, active: true, departmentId: true, managerId: true, displayName: true, employmentType: true,
    });
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck --workspace=server`

This is slow on this machine (3-5+ minutes) — let it run to completion. This also re-checks `shared/` (the server workspace imports directly from `@virtualmeet/shared`, so a type error introduced there surfaces here too). Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/20260826000000_employment_type/migration.sql shared/workspacePermissions.ts server/src/routes/admin.ts
git commit -m "feat: add User.employmentType (fulltime/freelance label) + admin API support"
```

---

### Task 2: Client — Members tab "Status Kerja" column

**Files:**
- Modify: `client/src/admin/api.ts:22-32` (`AdminMember` interface), `client/src/admin/api.ts:179` (`updateMember`'s patch type)
- Modify: `client/src/admin/MembersPanel.tsx` (new table column)

**Interfaces:**
- Consumes: `EmploymentType`, `EMPLOYMENT_TYPE_LABELS` from `@virtualmeet/shared` (Task 1).
- Produces: nothing consumed elsewhere in this plan — this is the final task.

- [ ] **Step 1: Add `employmentType` to `AdminMember` and `updateMember`'s patch type**

`client/src/admin/api.ts:22-32` currently reads:

```typescript
export interface AdminMember {
  id: string;
  email: string;
  displayName: string;
  workspaceRole: WorkspaceRole;
  timezone: string;
  active: boolean;
  createdAt: string;
  department: { id: string; name: string } | null;
  manager: { id: string; displayName: string } | null;
}
```

Add `employmentType` right after `workspaceRole`:

```typescript
export interface AdminMember {
  id: string;
  email: string;
  displayName: string;
  workspaceRole: WorkspaceRole;
  employmentType: EmploymentType;
  timezone: string;
  active: boolean;
  createdAt: string;
  department: { id: string; name: string } | null;
  manager: { id: string; displayName: string } | null;
}
```

`client/src/admin/api.ts:1` currently reads `import { WorkspaceRole } from '@virtualmeet/shared';` — change it to also import `EmploymentType`:

```typescript
import { WorkspaceRole, EmploymentType } from '@virtualmeet/shared';
```

`client/src/admin/api.ts:179` currently reads:

```typescript
  updateMember: (userId: string, patch: Partial<{ workspaceRole: WorkspaceRole; active: boolean; departmentId: string | null; managerId: string | null }>) =>
    req<Record<string, unknown>>(`/admin/members/${userId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
```

Add `employmentType` to the `Partial<{...}>` type (the function body itself needs no change — it already forwards whatever's in `patch`):

```typescript
  updateMember: (userId: string, patch: Partial<{ workspaceRole: WorkspaceRole; employmentType: EmploymentType; active: boolean; departmentId: string | null; managerId: string | null }>) =>
    req<Record<string, unknown>>(`/admin/members/${userId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
```

- [ ] **Step 2: Add the "Status Kerja" column to `MembersPanel.tsx`**

`client/src/admin/MembersPanel.tsx:3` currently reads:

```typescript
import { WORKSPACE_ROLE_LABELS, WorkspaceRole } from '@virtualmeet/shared';
```

Change to also import the new type/label map:

```typescript
import { WORKSPACE_ROLE_LABELS, WorkspaceRole, EMPLOYMENT_TYPE_LABELS, EmploymentType } from '@virtualmeet/shared';
```

`client/src/admin/MembersPanel.tsx:69-77` (the `<thead>`) currently reads:

```tsx
            <tr className="text-left text-gray-400 border-b border-gray-100 dark:border-gray-700">
              <th className="py-2 pr-3 font-medium">Nama</th>
              <th className="py-2 pr-3 font-medium">Peran</th>
              <th className="py-2 pr-3 font-medium">Departemen</th>
              <th className="py-2 pr-3 font-medium">Manajer</th>
              <th className="py-2 pr-3 font-medium">Bergabung</th>
              <th className="py-2 font-medium">Status</th>
            </tr>
```

Add a new header cell right after "Peran", before "Departemen":

```tsx
            <tr className="text-left text-gray-400 border-b border-gray-100 dark:border-gray-700">
              <th className="py-2 pr-3 font-medium">Nama</th>
              <th className="py-2 pr-3 font-medium">Peran</th>
              <th className="py-2 pr-3 font-medium">Status Kerja</th>
              <th className="py-2 pr-3 font-medium">Departemen</th>
              <th className="py-2 pr-3 font-medium">Manajer</th>
              <th className="py-2 pr-3 font-medium">Bergabung</th>
              <th className="py-2 font-medium">Status</th>
            </tr>
```

`client/src/admin/MembersPanel.tsx:97-110` (the "Peran" `<td>`, immediately followed by the "Departemen" `<td>`) currently reads:

```tsx
                  <td className="py-2 pr-3">
                    <select
                      value={m.workspaceRole}
                      disabled={busyId === m.id}
                      onChange={(e) => patch(m.id, { workspaceRole: e.target.value as WorkspaceRole })}
                      aria-label={`Peran ${m.displayName}`}
                      className="bg-gray-50 dark:bg-gray-700 rounded px-1.5 py-1 outline-none cursor-pointer text-gray-800 dark:text-gray-100"
                    >
                      {(['admin', 'member'] as WorkspaceRole[]).map((r) => (
                        <option key={r} value={r}>{WORKSPACE_ROLE_LABELS[r]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      value={m.department?.id ?? ''}
```

Insert a new `<td>` between them, mirroring the `workspaceRole` select exactly:

```tsx
                  <td className="py-2 pr-3">
                    <select
                      value={m.workspaceRole}
                      disabled={busyId === m.id}
                      onChange={(e) => patch(m.id, { workspaceRole: e.target.value as WorkspaceRole })}
                      aria-label={`Peran ${m.displayName}`}
                      className="bg-gray-50 dark:bg-gray-700 rounded px-1.5 py-1 outline-none cursor-pointer text-gray-800 dark:text-gray-100"
                    >
                      {(['admin', 'member'] as WorkspaceRole[]).map((r) => (
                        <option key={r} value={r}>{WORKSPACE_ROLE_LABELS[r]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      value={m.employmentType}
                      disabled={busyId === m.id}
                      onChange={(e) => patch(m.id, { employmentType: e.target.value as EmploymentType })}
                      aria-label={`Status kerja ${m.displayName}`}
                      className="bg-gray-50 dark:bg-gray-700 rounded px-1.5 py-1 outline-none cursor-pointer text-gray-800 dark:text-gray-100"
                    >
                      {(['fulltime', 'freelance'] as EmploymentType[]).map((t) => (
                        <option key={t} value={t}>{EMPLOYMENT_TYPE_LABELS[t]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      value={m.department?.id ?? ''}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=client`

This is slow on this machine (3-5+ minutes) — let it run to completion. Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/admin/api.ts client/src/admin/MembersPanel.tsx
git commit -m "feat: show and edit employment type (Fulltime/Freelance) in Admin Console Members tab"
```

---

## Manual Testing After Deploy

1. Open Admin Console → Members tab, confirm a new "Status Kerja" column appears for every row, defaulting to "Fulltime" for all existing accounts.
2. Change one test account's status to "Freelance" via the dropdown, confirm it persists after a page reload (re-fetch from `GET /admin/members`).
3. Confirm no other feature's behavior changed for that account (Sidebar, attendance, permissions all unaffected) — this is the core "label only" guarantee from the spec.
4. Set Andy (`alvertusandy@gmail.com`), Estiko (`estiko@kaitech.io`), and Yugo (`yugo.kaitech@gmail.com`) to Freelance via this same UI — the actual real-world task this feature was built for.
