# Operator Organization List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the deployment operator (today, exactly one person) see a read-only list of every organization on this deployment — name, member count, admins, created date — from inside the app, without SSH.

**Architecture:** An `OPERATOR_EMAILS` env var gates a new `requireOperator` middleware (mirroring the existing `requireWorkspace`) on one new endpoint, `GET /api/operator/organizations`. The same email check is folded into the shared `publicUser()`/`publicUserWithAvatar()` helpers as an `isOperator` field, so every auth response (login, `/me`, register, create-organization, org-invite accept) carries it automatically. The client renders a new full-screen panel (`OperatorConsole`), toggled through the existing `activePanel` panel-store mechanism, gated on `currentUser.isOperator`.

**Tech Stack:** Express + Prisma (server), React + Zustand panel store (client). No new dependencies.

## Global Constraints

- Fail-closed default: unset or empty `OPERATOR_EMAILS` means nobody has operator access — never fail open.
- `requireOperator` returns `403` (not `500`) on BOTH an email mismatch AND a DB error while resolving the caller's email — a lookup failure means "cannot confirm operator status," not "assume operator."
- No schema migration — this feature reads existing `Organization`/`User` columns only.
- No pagination in v1 (YAGNI — one operator, a list that stays small for a long time).
- Explicit non-goals, do not implement in any task: cross-org audit log view, organization delete/suspend, per-org member drill-in. These are deferred to future specs.
- No permanent test files or test framework exists in this repo. Every verification step in this plan is a temporary Node/tsx script run against the real local dev server + real local Postgres (via Docker), deleted after use — matching this repo's established convention.
- Every response through `publicUser()`/`publicUserWithAvatar()` (`server/src/lib/publicUser.ts`) must keep the exact two existing shapes (short vs. `avatarConfig`-including) — `isOperator` is additive to both, never removes or renames an existing field.

---

### Task 1: Server — operator gating primitives

**Files:**
- Modify: `server/src/config/index.ts`
- Create: `server/src/lib/operator.ts`
- Modify: `server/src/lib/publicUser.ts`
- Modify: `server/.env.example`
- Modify: `.env.example` (repo root)

**Interfaces:**
- Produces: `isOperatorEmail(email: string | null | undefined): boolean` — exported from `server/src/lib/operator.ts`, pure function, checks a normalized (`.trim().toLowerCase()`) email against the parsed `OPERATOR_EMAILS` env var.
- Produces: `requireOperator(req: AuthRequest, res: Response, next: NextFunction): Promise<void>` — Express middleware exported from `server/src/lib/operator.ts`. Mount after `authenticateToken`. Returns `403 { error: 'Forbidden' }` on mismatch or DB error.
- Produces: `publicUser()` and `publicUserWithAvatar()` (both in `server/src/lib/publicUser.ts`) now include `isOperator: boolean` in their returned object. No other field changes.

- [ ] **Step 1: Add `OPERATOR_EMAILS` to the config schema**

Open `server/src/config/index.ts` and find the Google OAuth block (it ends with `GOOGLE_LOGIN_ENABLED: z.string().optional(),`). Add immediately after it, still inside the same `z.object({...})`:

```ts
    // Deployment operator — a read-only cross-org view (server/src/routes/
    // operator.ts), gated to exactly the emails listed here. Comma-
    // separated, e.g. "you@example.com,other@example.com". Unset or empty
    // means nobody has access — see lib/operator.ts's isOperatorEmail().
    OPERATOR_EMAILS: z.string().optional(),
```

- [ ] **Step 2: Write the failing verification script**

Create a temporary file `server/src/lib/__test_operator.ts`:

```ts
import { isOperatorEmail } from './operator';

process.env.OPERATOR_EMAILS = ' Ops@Example.com , other@example.com ';

function check(label: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) process.exitCode = 1;
}

check('exact match', isOperatorEmail('other@example.com'));
check('case-insensitive match', isOperatorEmail('OPS@EXAMPLE.COM'));
check('whitespace-tolerant match', isOperatorEmail('  ops@example.com  '));
check('non-match rejected', !isOperatorEmail('nobody@example.com'));
check('null rejected', !isOperatorEmail(null));
check('undefined rejected', !isOperatorEmail(undefined));
check('empty string rejected', !isOperatorEmail(''));

process.env.OPERATOR_EMAILS = '';
check('empty OPERATOR_EMAILS fails closed', !isOperatorEmail('ops@example.com'));

delete process.env.OPERATOR_EMAILS;
check('unset OPERATOR_EMAILS fails closed', !isOperatorEmail('ops@example.com'));
```

- [ ] **Step 3: Run it to confirm it fails (the module doesn't exist yet)**

Run: `cd server && npx tsx src/lib/__test_operator.ts`
Expected: FAIL with a module-not-found error for `./operator`.

- [ ] **Step 4: Create `server/src/lib/operator.ts`**

```ts
import { Response, NextFunction } from 'express';
import { getPrisma } from './prisma';
import { getConfig } from '../config';
import { AuthRequest } from '../middleware/auth';

// Parses OPERATOR_EMAILS on every call rather than caching — this env var
// changes rarely enough that re-parsing costs nothing, and caching would
// need its own invalidation story for zero real benefit. Comparison is
// trim+lowercase on both sides, matching this codebase's existing email-
// normalization convention (see routes/google.ts, routes/orgInvite.ts).
export function isOperatorEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = getConfig().OPERATOR_EMAILS;
  if (!raw) return false;
  const normalized = email.trim().toLowerCase();
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalized);
}

// Gate for GET /api/operator/*. Mirrors lib/workspace.ts's requireWorkspace:
// resolves the caller's CURRENT email from the database by req.userId,
// never from the JWT (an admin could change another user's email after
// their token was minted). Deliberately fails closed to 403 on a DB error
// too — unlike requireWorkspace's 500 on its own DB error, a lookup
// failure here means "cannot confirm operator status," which must never
// be treated as "assume operator." Always mount AFTER authenticateToken.
export async function requireOperator(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const user = await getPrisma().user.findUnique({ where: { id: req.userId! }, select: { email: true } });
    if (!user || !isOperatorEmail(user.email)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return next();
  } catch (err) {
    console.error('[operator] role check error:', err);
    return res.status(403).json({ error: 'Forbidden' });
  }
}
```

- [ ] **Step 5: Run the verification script to confirm it passes**

Run: `cd server && npx tsx src/lib/__test_operator.ts`
Expected: all 9 lines print `PASS`, exit code 0.

- [ ] **Step 6: Delete the temporary test script**

Run: `rm server/src/lib/__test_operator.ts`

- [ ] **Step 7: Add `isOperator` to the shared publicUser helpers**

Replace the full contents of `server/src/lib/publicUser.ts` with:

```ts
import { User } from '@prisma/client';
import { isOperatorEmail } from './operator';

// The client-safe projection of a User row — every auth response (register,
// login, /me, org-invite accept, self-serve org creation) building its own
// shape inline meant the shape had quietly drifted (login/`/me` included
// avatarConfig, the other three didn't) instead of being a single decision.

type PublicUserFields = Pick<
  User,
  'id' | 'email' | 'displayName' | 'accountRole' | 'workspaceRole' | 'timezone' | 'tutorialCompletedAt' | 'preferences'
>;

export function publicUser(user: PublicUserFields) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    accountRole: user.accountRole,
    workspaceRole: user.workspaceRole,
    timezone: user.timezone,
    tutorialCompletedAt: user.tutorialCompletedAt,
    preferences: user.preferences,
    // Every response shape that flows through this helper picks this up
    // automatically — see specs/2026-08-12-operator-org-list-design.md.
    isOperator: isOperatorEmail(user.email),
  };
}

export function publicUserWithAvatar(user: PublicUserFields & Pick<User, 'avatarConfig'>) {
  return { ...publicUser(user), avatarConfig: user.avatarConfig };
}
```

- [ ] **Step 8: Document the env var in both `.env.example` files**

In `server/.env.example`, add after the Google OAuth block (after the `GOOGLE_CLIENT_ID=` line and its siblings — find where that block ends):

```
# ── Operator (optional) ───────────────────────────────────────────────
# Comma-separated emails allowed to see the cross-org organization list
# (client/src/operator/OperatorConsole.tsx). Unset/empty = nobody has
# access. See server/src/lib/operator.ts.
OPERATOR_EMAILS=
```

Add the exact same block to `.env.example` at the repo root.

- [ ] **Step 9: Typecheck**

Run: `cd server && npm run typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add server/src/config/index.ts server/src/lib/operator.ts server/src/lib/publicUser.ts server/.env.example .env.example
git commit -m "feat: add operator gating primitives (OPERATOR_EMAILS, requireOperator, isOperator field)"
```

---

### Task 2: Server — GET /api/operator/organizations endpoint

**Files:**
- Create: `server/src/routes/operator.ts`
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `requireOperator` from `server/src/lib/operator.ts` (Task 1).
- Produces: `GET /api/operator/organizations` (auth required, operator-only) → `200 { organizations: { id: string, name: string, slug: string, createdAt: string, memberCount: number, admins: { displayName: string, email: string }[] }[] }`, newest org first. `401` with no/invalid token, `403` for a non-operator.

- [ ] **Step 1: Create `server/src/routes/operator.ts`**

```ts
import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireOperator } from '../lib/operator';

const operator = Router();

// Read-only, cross-org organization list for the deployment operator (see
// specs/2026-08-12-operator-org-list-design.md). Deliberately no
// pagination (YAGNI — v1 has exactly one operator checking a list that
// stays small for a long time) and no mutation endpoints (org delete/
// suspend is explicitly out of scope for this spec).
operator.get('/operator/organizations', authenticateToken, requireOperator, async (_req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const orgs = await prisma.organization.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        _count: { select: { users: true } },
        users: {
          where: { workspaceRole: 'admin' },
          select: { displayName: true, email: true },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      organizations: orgs.map((org) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        createdAt: org.createdAt,
        memberCount: org._count.users,
        admins: org.users,
      })),
    });
  } catch (err) {
    console.error('[operator] organizations list error:', err);
    return res.status(500).json({ error: 'Gagal memuat daftar organisasi' });
  }
});

export default operator;
```

- [ ] **Step 2: Mount the router**

In `server/src/index.ts`, find:

```ts
import larkRoutes from './routes/lark';
import googleRoutes from './routes/google';
```

Add immediately after:

```ts
import operatorRoutes from './routes/operator';
```

Then find:

```ts
app.use('/api', larkRoutes);
app.use('/api', googleRoutes);
```

Add immediately after:

```ts
app.use('/api', operatorRoutes);
```

- [ ] **Step 3: Typecheck**

Run: `cd server && npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Set up a local operator for testing**

Add a throwaway test email to local `server/.env` (do not commit this file — it's gitignored):

```
OPERATOR_EMAILS=operator-test@local.dev
```

Restart the local dev server so it picks up the new env var: find and kill whatever is listening on port 3001 (`netstat -ano | grep ':3001' | grep LISTENING`, then `taskkill //PID <pid> //F` on Windows, or `kill <pid>` elsewhere), then `cd server && npm run dev` in the background, then confirm with `curl -s http://localhost:3001/api/health` that it's actually back up before continuing (do not trust a background-task "started" notification alone).

- [ ] **Step 5: Write the verification script**

Create a temporary file `scratchpad/operator_endpoint_verify.mjs` (adjust the path to this session's scratchpad directory):

```js
const BASE = 'http://localhost:3001/api';
let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`PASS: ${label}`); }
  else { fail++; console.log(`FAIL: ${label}${detail ? ' -- ' + detail : ''}`); }
}

async function createOrg(orgName, email) {
  const res = await fetch(`${BASE}/auth/create-organization`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgName, email, password: 'testpass123', displayName: 'Admin ' + orgName }),
  });
  if (res.status !== 201) throw new Error(`create-organization failed for ${orgName}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const suffix = Math.random().toString(36).slice(2, 8);
  const opUser = await createOrg(`Operator Test Org ${suffix}`, 'operator-test@local.dev');
  const nonOpUser = await createOrg(`Non-Operator Test Org ${suffix}`, `non-op-${suffix}@test.local`);

  check('operator account has isOperator=true in create-organization response', opUser.user.isOperator === true);
  check('non-operator account has isOperator=false', nonOpUser.user.isOperator === false);

  const opRes = await fetch(`${BASE}/operator/organizations`, { headers: { Authorization: `Bearer ${opUser.token}` } });
  const opBody = await opRes.json();
  check('operator GET /operator/organizations returns 200', opRes.status === 200, `got ${opRes.status}`);
  check('response contains the operator test org', opBody.organizations.some((o) => o.name === `Operator Test Org ${suffix}`));
  check('response contains the non-operator test org too (list is cross-org)', opBody.organizations.some((o) => o.name === `Non-Operator Test Org ${suffix}`));
  const opOrgRow = opBody.organizations.find((o) => o.name === `Operator Test Org ${suffix}`);
  check('org row has memberCount 1', opOrgRow?.memberCount === 1, `got ${opOrgRow?.memberCount}`);
  check('org row lists its founding admin', opOrgRow?.admins?.[0]?.email === 'operator-test@local.dev');

  const nonOpRes = await fetch(`${BASE}/operator/organizations`, { headers: { Authorization: `Bearer ${nonOpUser.token}` } });
  check('non-operator GET /operator/organizations returns 403', nonOpRes.status === 403, `got ${nonOpRes.status}`);

  const noAuthRes = await fetch(`${BASE}/operator/organizations`);
  check('no-token GET /operator/organizations returns 401', noAuthRes.status === 401, `got ${noAuthRes.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: Run it**

Run: `node scratchpad/operator_endpoint_verify.mjs`
Expected: all checks print `PASS`, exit code 0.

- [ ] **Step 7: Clean up test data and script**

Delete the two test organizations and their users (and any `AuditLog` rows they produced) via a one-off Prisma script against the local dev DB, same pattern used earlier in this engagement — find orgs whose name starts with `Operator Test Org` or `Non-Operator Test Org`, delete their users then the org row. Delete `scratchpad/operator_endpoint_verify.mjs`. Remove `OPERATOR_EMAILS=operator-test@local.dev` from local `server/.env` (or leave it — it's gitignored and harmless locally, but removing keeps local state clean for the next task).

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/operator.ts server/src/index.ts
git commit -m "feat: add GET /api/operator/organizations endpoint"
```

---

### Task 3: Client — OperatorConsole panel component

**Files:**
- Modify: `client/src/services/api.ts`
- Modify: `client/src/hooks/useCurrentUser.ts`
- Create: `client/src/operator/api.ts`
- Create: `client/src/operator/OperatorConsole.tsx`

**Interfaces:**
- Consumes: the `{ organizations: [...] }` JSON shape produced by Task 2's endpoint.
- Produces: `OperatorConsole` component, default export style matching `AdminConsole` — `export function OperatorConsole({ currentUser, onClose }: { currentUser: CurrentUser; onClose: () => void })`.
- Produces: `operatorApi.getOrganizations(): Promise<{ organizations: OperatorOrganization[] }>` from `client/src/operator/api.ts`.
- Produces: `CurrentUser.isOperator: boolean` (from `client/src/hooks/useCurrentUser.ts`), populated by `toCurrentUser()`.

- [ ] **Step 1: Add `isOperator` to `UserProfile`**

In `client/src/services/api.ts`, find the `UserProfile` interface (starts `export interface UserProfile {`) and its `tutorialCompletedAt?: string | null;` field. Add immediately after it, still inside the interface:

```ts
  // Deployment operator (see specs/2026-08-12-operator-org-list-design.md)
  // — gates the "Semua Organisasi" panel entry point. Cosmetic on the
  // client; the server re-checks it on every /api/operator/* request.
  isOperator?: boolean;
```

- [ ] **Step 2: Add `isOperator` to `CurrentUser` and `toCurrentUser()`**

Replace the full contents of `client/src/hooks/useCurrentUser.ts` with:

```ts
import { UserProfile } from '@/services/api';
import { WorkspaceAction, WorkspaceRole, canWorkspace } from '@virtualmeet/shared';

// The shared identity shape the suite modules (Base / Calendar / Attendance /
// Docs) read. This app holds the session in App.tsx's useAuth() and passes it
// down by prop — there is no user Context in this repo — so this is a plain
// adapter over that profile rather than a second, competing source of truth.
export interface CurrentUser {
  id: string;
  name: string;
  avatarUrl?: string;
  workspaceRole: WorkspaceRole;
  timezone: string;
  isOperator: boolean;
}

export function toCurrentUser(user: UserProfile): CurrentUser {
  return {
    id: user.id,
    name: user.displayName,
    workspaceRole: user.workspaceRole ?? 'member',
    // Fall back to the browser's zone if the profile somehow lacks one, so
    // times are never silently rendered in the wrong zone.
    timezone: user.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta',
    isOperator: user.isOperator ?? false,
  };
}

// Cosmetic gate for workspace-level UI. The server re-checks every request
// from the DB — this only decides what to render.
export function useCan(user: CurrentUser | null) {
  return (action: WorkspaceAction): boolean => canWorkspace(action, { workspaceRole: user?.workspaceRole });
}
```

- [ ] **Step 3: Create `client/src/operator/api.ts`**

Mirrors `client/src/admin/api.ts`'s `req<T>` helper exactly (this module intentionally does not import from `admin/api.ts` — operator data is a distinct, non-org-scoped concern, matching the spec's decision to keep it a separate page rather than a tab inside Admin Console).

```ts
const API_BASE = '/api';

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('vm_token');
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...((options.headers as Record<string, string>) || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Gagal: ${res.status}`);
  }
  return res.json();
}

export interface OperatorOrgAdmin {
  displayName: string;
  email: string;
}

export interface OperatorOrganization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  memberCount: number;
  admins: OperatorOrgAdmin[];
}

export const operatorApi = {
  getOrganizations: () => req<{ organizations: OperatorOrganization[] }>('/operator/organizations'),
};
```

- [ ] **Step 4: Create `client/src/operator/OperatorConsole.tsx`**

```tsx
import { useEffect, useState, useCallback } from 'react';
import { XLg, ShieldLock, Buildings } from 'react-bootstrap-icons';
import { CurrentUser } from '@/hooks/useCurrentUser';
import { operatorApi, OperatorOrganization } from './api';

const dateFmt = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });

// Gated here AND on the one request this panel makes (requireOperator,
// server/src/lib/operator.ts) — a non-operator who forces their way here
// still gets 403, same posture as AdminConsole's own gate comment.
export function OperatorConsole({ currentUser, onClose }: { currentUser: CurrentUser; onClose: () => void }) {
  const [orgs, setOrgs] = useState<OperatorOrganization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { organizations } = await operatorApi.getOrganizations();
      setOrgs(organizations);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentUser.isOperator) void load();
    else setLoading(false);
  }, [currentUser.isOperator, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!currentUser.isOperator) {
    return (
      <div className="absolute inset-0 z-40 flex items-center justify-center bg-white dark:bg-gray-900 pl-14">
        <div className="text-center max-w-sm px-6">
          <ShieldLock size={32} className="mx-auto text-gray-300 dark:text-gray-600 mb-3" />
          <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">Halaman ini khusus operator deployment</p>
          <button onClick={onClose} className="mt-4 px-3 py-1.5 rounded-lg bg-purple-600 text-white text-xs font-medium cursor-pointer hover:bg-purple-700">
            Kembali
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-white dark:bg-gray-900 overflow-hidden pl-14">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800 shrink-0">
        <div className="flex items-center gap-2">
          <Buildings size={16} className="text-purple-600" />
          <h1 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Semua organisasi</h1>
          {!loading && !error && <span className="text-xs text-gray-400">{orgs.length} org</span>}
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer">
          <XLg size={16} className="text-gray-500" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <p className="text-xs text-gray-400">Memuat organisasi…</p>
        ) : error ? (
          <p className="text-xs text-red-500">{error}</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-400 border-b border-gray-100 dark:border-gray-800">
                <th className="py-2 pr-3 font-medium">Nama</th>
                <th className="py-2 pr-3 font-medium">Anggota</th>
                <th className="py-2 pr-3 font-medium">Admin</th>
                <th className="py-2 pr-3 font-medium">Dibuat</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((org) => (
                <tr key={org.id} className="border-b border-gray-50 dark:border-gray-800/50">
                  <td className="py-2 pr-3 text-gray-800 dark:text-gray-100">{org.name}</td>
                  <td className="py-2 pr-3 text-gray-500">{org.memberCount}</td>
                  <td className="py-2 pr-3 text-gray-500">{org.admins.map((a) => a.displayName).join(', ') || '—'}</td>
                  <td className="py-2 pr-3 text-gray-500">{dateFmt.format(new Date(org.createdAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck / build**

Run: `cd client && npm run build`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/services/api.ts client/src/hooks/useCurrentUser.ts client/src/operator/api.ts client/src/operator/OperatorConsole.tsx
git commit -m "feat: add OperatorConsole panel component"
```

---

### Task 4: Client — wire OperatorConsole into navigation

**Files:**
- Modify: `client/src/stores/gameStore.ts`
- Modify: `client/src/components/ui/Sidebar.tsx`
- Modify: `client/src/App.tsx`

**Interfaces:**
- Consumes: `OperatorConsole` component and `CurrentUser.isOperator` from Task 3.
- Produces: a `'operatorConsole'` value on the shared `PanelId` type; a visible "Semua Organisasi" row in the Sidebar menu, shown only when `currentUser.isOperator` is true.

- [ ] **Step 1: Add `'operatorConsole'` to `PanelId`**

In `client/src/stores/gameStore.ts`, find the `PanelId` type (ends with `| 'myAnalytics';`). Change that final line so the type ends with two entries instead of one:

```ts
  | 'myAnalytics'
  // Operator-only, cross-org organization list (see
  // specs/2026-08-12-operator-org-list-design.md) — gated on
  // currentUser.isOperator, not workspaceRole, unlike adminConsole above.
  | 'operatorConsole';
```

- [ ] **Step 2: Add props to `Sidebar`'s interface**

In `client/src/components/ui/Sidebar.tsx`, find:

```ts
  isWorkspaceAdmin: boolean;
  adminViewActive: boolean;
  onToggleAdminView: () => void;
```

Add immediately after:

```ts

  // Deployment operator's cross-org organization list — a DIFFERENT gate
  // from isWorkspaceAdmin above (org-scoped workspace admin vs. the one
  // person operating this whole deployment). See
  // specs/2026-08-12-operator-org-list-design.md.
  isOperator: boolean;
  operatorConsoleActive: boolean;
  onToggleOperatorConsole: () => void;
```

- [ ] **Step 3: Add the icon import**

In `client/src/components/ui/Sidebar.tsx`, find the `react-bootstrap-icons` import line (starts `import { List, XLg, ...`). Add `Buildings` to the imported names list (anywhere in the list, e.g. right after `ShieldLock,`).

- [ ] **Step 4: Destructure the new props**

In `client/src/components/ui/Sidebar.tsx`, find the destructured props (where `isWorkspaceAdmin,`, `adminViewActive,`, `onToggleAdminView,` appear as function-parameter destructuring, not the interface). Add immediately after those three lines:

```ts
  isOperator,
  operatorConsoleActive,
  onToggleOperatorConsole,
```

- [ ] **Step 5: Render the menu row**

In `client/src/components/ui/Sidebar.tsx`, find:

```tsx
            {isWorkspaceAdmin && (
              <MenuRow icon={<ShieldLock size={15} />} label={adminViewActive ? 'Tutup Konsol Admin' : 'Konsol Admin'} active={adminViewActive} onClick={closeAnd(onToggleAdminView)} />
            )}
```

Add immediately after:

```tsx
            {isOperator && (
              <MenuRow icon={<Buildings size={15} />} label={operatorConsoleActive ? 'Tutup Semua Organisasi' : 'Semua Organisasi'} active={operatorConsoleActive} onClick={closeAnd(onToggleOperatorConsole)} />
            )}
```

- [ ] **Step 6: Lazy-load `OperatorConsole` in `App.tsx`**

In `client/src/App.tsx`, find:

```ts
const AdminConsole = lazy(() => import('./admin/AdminConsole').then((m) => ({ default: m.AdminConsole })));
```

Add immediately after:

```ts
// Operator-only, same "don't pay for code you never load" reasoning as
// AdminConsole above — an even smaller audience (one person today).
const OperatorConsole = lazy(() => import('./operator/OperatorConsole').then((m) => ({ default: m.OperatorConsole })));
```

- [ ] **Step 7: Add the derived active-panel variable**

In `client/src/App.tsx`, find:

```ts
  const adminViewActive = activePanel === 'adminConsole';
```

Add immediately after:

```ts
  const operatorConsoleActive = activePanel === 'operatorConsole';
```

- [ ] **Step 8: Thread the props into the Sidebar element**

In `client/src/App.tsx`, find:

```tsx
        isWorkspaceAdmin={currentUser.workspaceRole === 'admin'}
        adminViewActive={adminViewActive}
        onToggleAdminView={() => openPanel('adminConsole')}
```

Add immediately after:

```tsx
        isOperator={currentUser.isOperator}
        operatorConsoleActive={operatorConsoleActive}
        onToggleOperatorConsole={() => openPanel('operatorConsole')}
```

- [ ] **Step 9: Render the panel**

In `client/src/App.tsx`, find:

```tsx
      {adminViewActive && (
        <Suspense fallback={null}>
          <AdminConsole currentUser={currentUser} onClose={closePanel} />
        </Suspense>
      )}
```

Add immediately after:

```tsx
      {operatorConsoleActive && (
        <Suspense fallback={null}>
          <OperatorConsole currentUser={currentUser} onClose={closePanel} />
        </Suspense>
      )}
```

- [ ] **Step 10: Typecheck / build**

Run: `cd client && npm run build`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 11: Commit**

```bash
git add client/src/stores/gameStore.ts client/src/components/ui/Sidebar.tsx client/src/App.tsx
git commit -m "feat: wire OperatorConsole into app navigation"
```

---

### Task 5: End-to-end verification

**Files:** none (verification only, no commits — matches this repo's Task 5 precedent from `plans/2026-08-12-self-serve-org-creation.md`).

- [ ] **Step 1: Confirm both dev servers are running with the latest code**

Server: kill whatever is listening on port 3001 (see Task 2 Step 4), start fresh with `cd server && npm run dev` in the background, confirm with `curl -s http://localhost:3001/api/health` before continuing.
Client: confirm the Vite dev server (`cd client && npm run dev`) is running and reachable at `http://localhost:5173`; if not, start it in the background and confirm with a `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173` returning `200` before continuing.

- [ ] **Step 2: Set a real local operator email**

Add `OPERATOR_EMAILS=<a throwaway test email you can log into>` to local `server/.env`, restart the server dev process the same way as Task 2 Step 4.

- [ ] **Step 3: Re-run the server-side regression**

Repeat Task 2's Steps 5–7 (recreate the verification script, run it, expect 100% pass, clean up test orgs/users/script). This is a full regression, not a skip — it re-confirms Tasks 1–2's behavior still holds after Tasks 3–4's client changes (which shouldn't affect the server at all, but re-running costs one script and catches any accidental drift).

- [ ] **Step 4: Manual visual check (client)**

This repo has no browser automation available in this environment — this step is a manual/visual check, not an automated one, same standing limitation already noted for the self-serve org-creation feature's LoginPage changes.

1. Register or log into an account whose email matches `OPERATOR_EMAILS` (self-serve org creation via the signup flow works for this).
2. Open the room, open the sidebar menu, confirm a "Semua Organisasi" row is visible.
3. Click it, confirm the panel opens and shows a table with at least the org you just created (name, member count `1`, your own display name as admin, today's date).
4. Close it (`Escape` key and the X button both), confirm it closes.
5. Log into or register a second account whose email is NOT in `OPERATOR_EMAILS`, confirm the "Semua Organisasi" row is absent from the sidebar menu entirely.

Report the actual observed result of each of these 5 checks — do not report this step as passed without having actually performed it.

- [ ] **Step 5: Clean up**

Remove `OPERATOR_EMAILS=...` from local `server/.env` (or leave the line present but empty — it's gitignored either way). Delete any leftover test organizations/users created during the manual check, the same way prior cleanup steps in this plan did.

- [ ] **Step 6: Report**

Summarize: server regression pass/fail count, and the actual outcome of each of the 5 manual checks in Step 4.
