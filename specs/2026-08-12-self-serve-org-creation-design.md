# Self-serve organization creation — design spec

**Date:** 2026-08-12
**Status:** Approved, ready for implementation plan
**Scope:** Sub-project 1 of 4 identified during brainstorming for "sign up with organization + provider choice" — see Deferred section below for the other three.

## Context

MeetKai/KaiSpace's multi-tenant migration (Fase 1–5) is production-ready: every model, broadcast, and signup path is org-aware. But creating a brand-new `Organization` row has, until now, only ever been a manual operator action (a direct Prisma script run by whoever operates the deployment) — there is no self-serve way for a new company (e.g. DCM) to get their own isolated workspace. The existing `OrgInvite` flow (built in the prior slice) only handles *growing membership within an org that already exists*; it doesn't create orgs.

This spec covers building that missing piece: a public, self-serve "create your own organization" flow.

## Non-goals (deferred to separate specs)

The originating request bundled four independent pieces of work. Only #1 is in scope here:

1. **Self-serve org creation** (this spec).
2. Per-org Lark integration ("Lark" as a collaboration provider at org-creation time) — requires refactoring every `lib/lark*.ts` file from a single global token cache to a per-org-keyed one, plus a credential-setup wizard. Comparable in size to the entire multi-tenant migration already done.
3. Google Workspace integration as a collaboration provider — scope itself needs clarifying (domain restriction only, vs. Directory/Calendar/Drive integration).
4. "KaiSpace murni" (no external provider) — effectively free once #1 exists; no separate work.

## Decisions made during brainstorming

- **New, separate entry point.** The existing "Sign Up here!" link/form is untouched — it still registers a new member into the single default org (Kaitech's own growth path). A new, distinct link ("Buat organisasi baru") is added alongside it. Changing the existing form's behavior would have broken Kaitech's own onboarding.
- **Fields:** organization name, admin email, admin password, admin display name. No manual slug/URL entry — the slug is generated automatically from the org name, with an automatic numeric suffix on collision (`dcm` → `dcm-2` if taken). Org names are NOT required to be globally unique (two orgs can share a display name; only the generated slug must be unique, matching the existing `Organization.slug @unique` constraint).
- **Fully open, self-serve, no approval gate.** Same posture as the existing manual registration: anyone who submits the form gets an org immediately, protected only by rate limiting (not a moderation queue). Revisit later if abuse becomes a real problem.
- **Email + password only for v1.** No Google/Lark buttons on this specific form. Google and Lark remain fully available for *logging into* an org that already exists (unchanged) — this decision only scopes down the org-*creation* form itself, to keep this slice small. OAuth-based org creation can be a fast-follow if actually needed.

## Design

### API

New route, alongside the existing `POST /auth/register` in `server/src/routes/auth.ts` (or a small new file if that grows unwieldy — implementation plan decides):

`POST /api/auth/create-organization`
- Public (no `authenticateToken`), rate-limited identically to the existing `authRateLimit` (10 attempts / 15 min / IP) — this mints new accounts *and* new tenants, at least as abuse-sensitive as plain registration.
- Body: `{ orgName: string, email: string, password: string, displayName: string }`, validated via a new Zod schema mirroring `registerSchema`'s email/password/displayName rules, with `orgName` added (non-empty, max 80 chars — matching `Shift.name`'s existing `.slice(0, 80)` precedent elsewhere in this codebase; `Department.name` uses 60, but an org's own name is closer in kind to other free-text entity names capped at 80).
- Rejects with 409 if `email` already has an account anywhere (same check/message as register and org-invite accept).
- **Slug generation:** slugify `orgName` (lowercase, spaces/punctuation → hyphens, matching the shape of the existing seeded `kaitech` slug). If taken, append `-2`, `-3`, ... until free. This needs a small loop of `findUnique` checks (or a single query for `slug: { startsWith }` plus in-memory suffix pick) — implementation plan decides the exact technique.
- **Atomicity:** the `Organization` create and the founding `User` create happen inside one `prisma.$transaction([...])` — a failure partway through must never leave an orphan org with no admin, or vice versa.
- Founding user gets `accountRole: 'admin', workspaceRole: 'admin'` — the same mapping `accountFieldsForInviteRole('admin')` already produces for an admin-role org invite (reuse that helper rather than re-deriving the values).
- On success: mint a session exactly like `/auth/register` (`currentSessionId` + `signToken`), set the upload-session cookie, return `{ user, token }` in the identical shape `/auth/register` already returns.
- Audit: `writeAudit` with a new action (e.g. `'org:create'`), `targetType: 'organization'`, actor = the new user's own id, `meta: { orgName, slug }` — every other significant mutation in this codebase is already audited; org creation is at least as significant.

### Client

- `LoginPage.tsx` gains a third mode alongside the existing `'login' | 'register'`: `'createOrg'`. A link near the existing "Don't have account? Sign Up here!" line: *"Mau bikin organisasi sendiri? Buat di sini"*, switching the mode.
- In `createOrg` mode, the existing form gains one extra field above email ("Nama organisasi"); the email/password/display-name inputs are reused as-is. Submit calls a new `onCreateOrganization` prop instead of `onRegister`.
- `useAuth.ts` gains `createOrganization(orgName, email, password, displayName)`, mirroring `register`/`acceptOrgInvite` exactly (call the API, store the token, `setUser`, propagate errors the same way).
- `services/api.ts` gains `createOrganization(...)`, mirroring `register`'s shape (`POST /auth/create-organization`, returns `{ user, token }`).
- `App.tsx`'s `MainApp` passes the new handler into `LoginPage` alongside the existing `onLogin`/`onRegister` props — no new query-param/routing wiring needed (unlike the guest/org-invite links, there's no secret token in the URL to thread through; this is an ordinary form reachable by anyone).

### Error handling

- Empty/oversized `orgName` → 400, clear message.
- Email already registered → 409, same message register/org-invite-accept already use.
- Password/display-name validation failures → 400, same shape as register's existing Zod validation errors.
- Slug collisions are invisible to the user — always resolved automatically, never surfaced as an error.
- Rate-limit exceeded → same 429 shape the existing `rateLimit` middleware already produces everywhere else.

### Testing plan

Same 2-org-style verification standard used throughout this migration, adapted for "N orgs created via this new flow":
1. Create org A via the new endpoint — confirm the response shape matches register's, confirm the DB row has the right `accountRole`/`workspaceRole` (admin/admin), confirm the org's slug is a clean slugification of the name.
2. Create a second org B with the **same** `orgName` as org A — confirm it succeeds with a distinct, suffixed slug (no collision), confirm org B's admin lands in org B, not org A.
3. Attempt to create an org with an email that already has an account (e.g. org A's own admin email again) — confirm 409, confirm no partial org/user rows were left behind (transaction rollback verified directly against the DB).
4. Confirm rate limiting actually engages after repeated attempts from the same IP (reusing the same verification technique already used for `authRateLimit` elsewhere in this session).
5. Regression: confirm the existing "Sign Up here!" flow (join Kaitech's default org) is completely unaffected — same behavior as before this change.
6. Client: typecheck + production build clean (no live browser automation available in this environment, same caveat as the Google OAuth slice — flagged explicitly, not silently skipped).
