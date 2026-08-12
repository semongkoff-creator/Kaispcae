# Operator Organization List — Design

**Status:** Approved by user, 2026-08-12
**Location note:** Saved to top-level `specs/` (not `docs/superpowers/specs/`) — `docs/` is unconditionally excluded from every commit in this repo, a standing rule re-confirmed earlier in this engagement (see `specs/2026-08-12-self-serve-org-creation-design.md`).

## Context

The final whole-branch review of the self-serve org-creation feature (`plans/2026-08-12-self-serve-org-creation.md`) flagged that once organizations can be created by anyone with an email address (fully open, no approval gate, rate-limit-only), there is no product-level way to see how many organizations exist, when they were created, or who administers them. The only path today is direct SSH + `psql` access to the shared VPS.

There is no "platform operator" or "superadmin" role concept anywhere in this codebase. `accountRole` is `'admin' | 'user'`; `workspaceRole` is `'admin' | 'member'`, both scoped to the caller's own organization. The person who operates this deployment has no in-app identity distinct from being an org's own admin.

## Goals

- Let the deployment operator see a list of all organizations — name, member count, admin(s), created date — from inside the app, without SSH.
- Gate this strictly: only the operator (today, one person) can ever see it.

## Explicit non-goals (deferred, not part of this spec)

- Cross-org audit log view (the other gap the final review flagged) — deferred; may be a future spec.
- Deleting, suspending, or otherwise mutating an organization from this UI — deferred. Cleanup of abusive/abandoned orgs still goes through direct DB access for now.
- Drilling into a specific org's member list/detail from this view — deferred. The list itself (with member count + admin names) is enough to spot problems; deeper inspection can stay a DB query until it's actually needed.
- A general-purpose "operator" role with configurable permissions — this spec grants exactly one capability (view the org list) to exactly the people named in one env var. Not a role system.

## Architecture

**Granting access — `OPERATOR_EMAILS` env var.** A comma-separated list of emails in `.env`, read via the existing Zod `envSchema` pattern in `server/src/config/index.ts` (same shape as `LARK_APP_ID`/`GOOGLE_CLIENT_ID`). No schema migration, no admin UI for granting access — adding a second operator later is a one-line env change on the VPS, exactly like every other credential/flag in this deployment. If unset or empty, nobody has access (fail closed).

**Server gate — `requireOperator` middleware**, in `server/src/lib/operator.ts`, mirroring `requireWorkspace`'s existing pattern in `server/src/lib/workspace.ts` exactly: resolves the caller's *current* email from the database by `req.userId` (never trusts a claim baked into the JWT — same principle `resolveWorkspaceRole` already applies to `workspaceRole`, since an admin could change another user's email after the token was minted), checks it against the parsed `OPERATOR_EMAILS` set, and returns `403` on mismatch (matching `requireWorkspace`'s own `403` convention) or on a DB error (fail closed, not fail open).

**New field — `isOperator`** added to the shared response shape in `server/src/lib/publicUser.ts` (`publicUser()` / `publicUserWithAvatar()`), computed the same way `requireOperator` checks it (email membership in `OPERATOR_EMAILS`), so the login/`/me`/register/create-organization responses all carry it consistently with zero duplicated logic. The client uses this only to decide whether to render the entry point — it is never trusted as the real gate; the real gate is the server 403.

**New endpoint — `GET /api/operator/organizations`**, in a new `server/src/routes/operator.ts`, mounted at `/api`, gated by `authenticateToken` then `requireOperator`. One query:

```ts
const orgs = await prisma.organization.findMany({
  select: {
    id: true, name: true, slug: true, createdAt: true,
    _count: { select: { users: true } },
    users: { where: { workspaceRole: 'admin' }, select: { displayName: true, email: true }, orderBy: { createdAt: 'asc' } },
  },
  orderBy: { createdAt: 'desc' },
});
```

Returns `{ organizations: [{ id, name, slug, createdAt, memberCount, admins: [{ displayName, email }] }] }`, newest org first (most relevant for spotting a suspicious org right after it's created).

**New UI — `client/src/operator/OperatorConsole.tsx`**, lazy-loaded and toggled through the existing `activePanel` state in `App.tsx` (`activePanel === 'operatorConsole'`) — the same panel-toggle mechanism `AdminConsole` already uses; this app has no router, so "a separate page" means a distinct panel, not a URL. A new toggle button, rendered only when `currentUser.isOperator === true` (parallel to the existing `isWorkspaceAdmin` gate on the Admin Console toggle), placed next to that existing toggle. The panel itself: a plain table (org name, member count, admin names joined by comma, created date, relative + absolute), no pagination for v1 (the operator is one person checking a list that will be small for a long time; add pagination later if it ever actually gets long — YAGNI).

## Data flow

1. Operator logs in normally (Lark/Google/password — unchanged). Their `/me`/login response now includes `isOperator: true`.
2. Client renders the operator-console toggle button because of that flag.
3. Operator clicks it → `OperatorConsole` mounts → calls `GET /api/operator/organizations`.
4. Server re-resolves the caller's email from the DB, checks `OPERATOR_EMAILS`, returns the org list or `403`.

## Error handling

- Non-operator hits the endpoint directly (bypassing the hidden button): `403 { error: 'Forbidden' }`. No leaked detail about what `OPERATOR_EMAILS` contains.
- `OPERATOR_EMAILS` unset/empty: `requireOperator` always rejects — safe default, matches this deployment's current single-operator reality without needing the var set at all until it's actually used.
- DB error while resolving the caller's email: fail closed (`403`), logged server-side, same posture as `requireWorkspace`'s own error path returning `500` for its own DB errors — here a lookup failure is treated as "cannot confirm operator status" rather than "assume operator", so it maps to `403` not `500`.
- Client: if `OperatorConsole` is somehow reached without `isOperator` (e.g. a stale cached flag), the `403` from the API call renders as a plain "Forbidden" state in the panel — no separate client-side re-gate needed beyond that, since the panel has no destructive actions and the only data it fetches is exactly what the server call itself protects.

## Testing plan

Same convention as the rest of this engagement — no permanent test file. A temporary local verification script: set `OPERATOR_EMAILS` in local `server/.env` to a throwaway test email, create a couple of test organizations via the existing `/auth/create-organization` endpoint (one whose admin email is the operator email, one whose isn't), then confirm:
- The operator-email user's request to `/api/operator/organizations` returns `200` with both test orgs present, correct member counts and admin names.
- The non-operator user's request to the same endpoint returns `403`.
- `isOperator` is `true` in the operator's own login/`/me` response and `false`/absent for the non-operator.

Clean up test orgs/users afterward, same as every other verification script in this engagement.
