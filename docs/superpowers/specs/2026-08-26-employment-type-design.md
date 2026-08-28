# Employment Type (Freelance / Fulltime) — Design

## Goal

Let a workspace admin mark each Kaitech staff member as "Fulltime" or "Freelance" from the existing Admin Console → Members tab, purely as a visible label — no other feature's behavior changes based on this value.

## Context

Investigated before designing:

- No `employmentType`/freelance/fulltime concept exists anywhere in the codebase today (confirmed via a repo-wide search).
- The Admin Console already has a Members tab (`client/src/admin/MembersPanel.tsx`) with exactly this shape of per-user control: a `<select>` per row that calls `patch(m.id, { <field>: <value> })`, wired to `PATCH /api/admin/members/:userId` (`server/src/routes/admin.ts:60-140`), which builds a `Prisma.UserUpdateInput` field-by-field from whichever keys are present in the request body. `workspaceRole` is the closest existing analog: a plain `String @default("member")` column (`server/prisma/schema.prisma:138`, no DB-level enum), with its allowed values validated in the PATCH handler and a `WorkspaceRole` type + `WORKSPACE_ROLE_LABELS` display-label map living in `shared/workspacePermissions.ts`.
- `GET /admin/members` (`admin.ts:36-57`) is a `select`-based query already scoped to the caller's own org — a new field just needs adding to that `select`.
- Confirmed with the user: this is a pure label — no attendance, permission, or any other feature reads or branches on it.

## Design

### 1. Data model

Additive, nullable-free (like `workspaceRole`) field on `User` (`server/prisma/schema.prisma`), same style as its immediate neighbor:

```prisma
employmentType          String                    @default("fulltime")
```

Values: `"fulltime"` | `"freelance"`, validated at the application layer (server route), not a DB enum — matching `workspaceRole`'s own precedent exactly. Every existing account defaults to `"fulltime"` on migration, so nothing changes for anyone until an admin explicitly sets a account to `"freelance"`.

### 2. Shared type + label map

`shared/workspacePermissions.ts` (same file as `WorkspaceRole`/`WORKSPACE_ROLE_LABELS`, right below them):

```typescript
export type EmploymentType = 'fulltime' | 'freelance';

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  fulltime: 'Fulltime',
  freelance: 'Freelance',
};
```

### 3. Server

- `GET /admin/members`'s `select` gains `employmentType: true`.
- `PATCH /admin/members/:userId` gains a new `if (req.body?.employmentType !== undefined)` branch, immediately after the existing `workspaceRole` branch: validates the value is exactly `'fulltime'` or `'freelance'` (400 otherwise, same shape as the existing `workspaceRole` validation), records `before`/`after` for the audit log (same pattern every other field here already follows), and sets `data.employmentType`.
- No admin-lockout guard needed (unlike `workspaceRole`'s "can't demote the last admin" rule) — employment type carries no permission weight, so there's nothing to lock anyone out of.

### 4. Client

- `AdminMember` (`client/src/admin/api.ts`) gains `employmentType: EmploymentType`.
- `adminApi.updateMember`'s patch type gains `employmentType?: EmploymentType`.
- `MembersPanel.tsx` gains one new table column ("Status Kerja"), positioned right after the existing "Peran" (role) column, with a `<select>` identical in structure/styling to the existing `workspaceRole` select — same `patch(m.id, { employmentType: e.target.value as EmploymentType })` call, options driven by `EMPLOYMENT_TYPE_LABELS`.

## Error handling

- An invalid `employmentType` value in the PATCH body is rejected with the same 400-style response the existing `workspaceRole` validation already uses — no new error-handling pattern needed.
- Every existing account reads as `"fulltime"` after migration (the column default), so no account is silently left in an undefined state.

## Manual step after deploy

Mark the 3 already-identified people as Freelance through the new Admin Console UI once deployed: Andy (`alvertusandy@gmail.com`), Estiko (`estiko@kaitech.io`), Yugo (`yugo.kaitech@gmail.com`). The other 3 named people (Amal, Reza, Septi — Kaitech staff) are deferred until their accounts/emails are identified, per the user's own "skip for now" instruction.

## Out of scope

- No behavior in any other feature (attendance, permissions, analytics, etc.) reads this field — confirmed with the user this is label-only.
- No bulk-import or CSV-based way to set this for many people at once — one admin toggles it per person in the existing Members table, same as every other field there.
- The 3 not-yet-identified people (Amal, Reza, Septi) are not touched by this work at all.
