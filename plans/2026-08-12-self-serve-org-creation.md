# Self-Serve Organization Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anyone create a brand-new, fully isolated `Organization` self-serve (org name + admin email/password/display name), without any operator involvement — closing the last manual step in this repo's multi-tenant onboarding.

**Architecture:** One new server endpoint (`POST /api/auth/create-organization`) that creates the `Organization` and its founding admin `User` atomically inside a Prisma transaction, generating a unique slug with a create-and-retry-on-collision loop (no separate check-then-create race window). Client-side, a third mode on the existing `LoginPage.tsx` form reuses its email/password/display-name inputs, adding one field, and wires through `useAuth`/`services/api.ts` exactly like the existing `register`/`acceptOrgInvite` functions.

**Tech Stack:** Express + Prisma (Postgres) on the server; React + a hand-rolled `useAuth` hook (no state library) on the client. No formal test runner exists in this repo — every prior slice in this migration was verified with a temporary Node script run against the real local dev server/DB, then deleted. This plan follows that same convention rather than introducing a new one.

## Global Constraints

- Spec: `specs/2026-08-12-self-serve-org-creation-design.md` — every requirement in this plan traces back to it.
- The existing "Sign Up here!" flow (`POST /auth/register`, `DEFAULT_ORG_ID`) must be completely unmodified and unaffected.
- Email + password only — no Google/Lark buttons on this new form (explicitly deferred).
- Fully open, no approval gate — protected only by the existing `authRateLimit` (10 attempts / 15 min / IP), reused as-is (not a new limiter instance).
- Org creation + founding-admin creation must be atomic (one Prisma `$transaction`) — never leave an orphaned org or a user with no org.
- Founding admin gets `accountRole: 'admin', workspaceRole: 'admin'` via the existing `accountFieldsForInviteRole('admin')` helper (`server/src/lib/orgInvite.ts`) — do not re-derive these values by hand.
- Follow this repo's `git add <specific files>` convention (never `-A`/`.`); `docs/` is excluded from every commit — this plan's own files live in `specs/`/`plans/` instead.
- No live-browser UI testing is available in this environment (confirmed absent in every prior slice of this engagement) — Task 4/5 rely on typecheck + production build + code review, not an actual click-through. State this limitation explicitly when reporting results; do not claim UI verification that didn't happen.

---

### Task 1: Org-name slug generator

**Files:**
- Create: `server/src/lib/orgSlug.ts`
- Test (temporary, deleted at the end of this task): `server/src/lib/__test_orgSlug.ts`

**Interfaces:**
- Produces: `slugifyOrgName(name: string): string` — pure function, no I/O. Lowercases, replaces runs of non-alphanumeric characters with a single hyphen, trims leading/trailing hyphens, caps at 60 characters, and falls back to the literal string `'org'` if the input slugifies to nothing (e.g. a name made entirely of punctuation/emoji).

- [ ] **Step 1: Write the failing test**

Create `server/src/lib/__test_orgSlug.ts`:

```ts
import { slugifyOrgName } from './orgSlug';

function assertEqual(actual: string, expected: string, label: string) {
  if (actual !== expected) {
    console.error(`FAIL: ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${label}`);
  }
}

assertEqual(slugifyOrgName('DCM'), 'dcm', 'simple uppercase name');
assertEqual(slugifyOrgName('DCM Industries'), 'dcm-industries', 'spaces become single hyphen');
assertEqual(slugifyOrgName('  Kaitech  '), 'kaitech', 'leading/trailing whitespace trimmed');
assertEqual(slugifyOrgName('Acme & Co., Inc.'), 'acme-co-inc', 'punctuation collapsed, no trailing hyphen');
assertEqual(slugifyOrgName('日本語'), 'org', 'non-latin-only name falls back to "org"');
assertEqual(slugifyOrgName('a'.repeat(100)), 'a'.repeat(60), 'capped at 60 characters');

if (process.exitCode === 1) {
  console.error('\nSome assertions FAILED');
} else {
  console.log('\nAll assertions PASSED');
}
```

- [ ] **Step 2: Run it to verify it fails**

Run from the repo root:
```bash
cd server && npx tsx src/lib/__test_orgSlug.ts
```
Expected: a TypeScript/module-resolution error, since `./orgSlug` doesn't exist yet (`Cannot find module './orgSlug'` or similar).

- [ ] **Step 3: Implement `orgSlug.ts`**

Create `server/src/lib/orgSlug.ts`:

```ts
// Self-serve org creation — turns a free-text organization name into a
// URL-safe slug CANDIDATE. This is deliberately just the pure
// name-to-string transform; collision handling (the -2, -3, ... suffix
// when a slug is already taken) happens at the call site via a
// create-and-retry-on-P2002 loop, not here — a separate "is this slug
// free" check followed by a create would leave a race window between
// the check and the actual insert under concurrent signups.
export function slugifyOrgName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'org';
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd server && npx tsx src/lib/__test_orgSlug.ts
```
Expected: `All assertions PASSED`, every line prefixed `PASS:`.

- [ ] **Step 5: Delete the temporary test file**

```bash
rm server/src/lib/__test_orgSlug.ts
```

- [ ] **Step 6: Typecheck**

```bash
cd server && npm run typecheck
```
Expected: clean (no output beyond the `tsc --noEmit` command echo).

- [ ] **Step 7: Commit**

```bash
git add server/src/lib/orgSlug.ts
git commit -m "Add slugifyOrgName helper for self-serve org creation"
```

---

### Task 2: `POST /api/auth/create-organization` endpoint

**Files:**
- Modify: `server/src/middleware/validate.ts` — add `createOrganizationSchema` right after the existing `registerSchema`
- Modify: `server/src/routes/auth.ts` — add imports and the new route, right after the existing `/register` route (after its closing `});`)

**Interfaces:**
- Consumes: `slugifyOrgName` (Task 1), `accountFieldsForInviteRole` from `server/src/lib/orgInvite.ts` (already exists — signature: `(role: string) => { accountRole: string; workspaceRole: string }`), `writeAudit`/`clientIp` from `server/src/lib/audit.ts` (already exist — `writeAudit(prisma, {actorId, action, targetType, targetId?, meta?, ip?}): Promise<void>`, `clientIp(req): string | null`), `signToken`/`startNewSession` (both already defined earlier in `auth.ts` itself, no import needed).
- Produces: `POST /api/auth/create-organization`, body `{ orgName, email, password, displayName }`, success response `201 { user: {...same shape as /auth/register...}, token: string }`.

- [ ] **Step 1: Add the Zod schema**

In `server/src/middleware/validate.ts`, find this existing block:

```ts
export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(100),
  displayName: z.string().min(1).max(30),
});
```

Add immediately after it:

```ts
export const createOrganizationSchema = z.object({
  orgName: z.string().min(1).max(80),
  email: z.string().email(),
  password: z.string().min(6).max(100),
  displayName: z.string().min(1).max(30),
});
```

- [ ] **Step 2: Add imports to `auth.ts`**

In `server/src/routes/auth.ts`, find:

```ts
import { validate, registerSchema, loginSchema } from '../middleware/validate';
```

Replace with:

```ts
import { validate, registerSchema, loginSchema, createOrganizationSchema } from '../middleware/validate';
```

Find:

```ts
import { DEFAULT_ORG_ID } from '../lib/defaultOrg';
import { googleConfig } from '../lib/googleConfig';
```

Replace with:

```ts
import { DEFAULT_ORG_ID } from '../lib/defaultOrg';
import { googleConfig } from '../lib/googleConfig';
import { Prisma, User } from '@prisma/client';
import { accountFieldsForInviteRole } from '../lib/orgInvite';
import { writeAudit, clientIp } from '../lib/audit';
import { slugifyOrgName } from '../lib/orgSlug';
```

(`User` is Prisma's generated model type — used below instead of hand-typing a partial shape, so there's no risk of guessing a field's type wrong and getting a spurious mismatch.)

- [ ] **Step 3: Add the route**

In `server/src/routes/auth.ts`, find the end of the existing `/register` route:

```ts
  } catch (err) {
    console.error('[auth] register error:', err);
    return res.status(500).json({ error: 'Registration failed' });
  }
});
```

Add immediately after that closing `});`:

```ts
// POST /auth/create-organization — self-serve: creates a brand-new
// Organization AND its founding admin User atomically. This is the only
// self-serve way to get a new org today; OrgInvite (lib/orgInvite.ts)
// only grows membership within an org that already exists. Deliberately
// reuses authRateLimit (not a separate limiter) — this mints a new
// tenant AND a new account in one request, at least as abuse-sensitive
// as plain registration.
auth.post('/create-organization', authRateLimit, validate(createOrganizationSchema), async (req, res: Response) => {
  try {
    const { orgName, email, password, displayName } = req.body;
    const prisma = getPrisma();

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const hashed = await bcrypt.hash(password, 12);
    const { accountRole, workspaceRole } = accountFieldsForInviteRole('admin');
    const baseSlug = slugifyOrgName(orgName);

    const MAX_SLUG_ATTEMPTS = 20;
    let created: User | null = null;
    let lastCollisionErr: unknown = null;

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      const candidateSlug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
      try {
        created = await prisma.$transaction(async (tx) => {
          const org = await tx.organization.create({ data: { name: orgName, slug: candidateSlug } });
          return tx.user.create({
            data: {
              email, password: hashed, displayName,
              accountRole, workspaceRole,
              organizationId: org.id,
            },
          });
        });
        lastCollisionErr = null;
        break;
      } catch (e) {
        // P2002 = unique constraint violation. Only retry on a slug
        // collision specifically — any other failure must surface
        // immediately, not get silently swallowed into more retries.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && (e.meta?.target as string[] | undefined)?.includes('slug')) {
          lastCollisionErr = e;
          continue;
        }
        throw e;
      }
    }

    if (!created) {
      console.error('[auth] create-organization: exhausted slug attempts for', orgName, lastCollisionErr);
      return res.status(500).json({ error: 'Gagal membuat organisasi, coba nama lain' });
    }

    const sessionId = await startNewSession(created.id);
    const token = signToken(created, sessionId);
    setUploadSessionCookie(req, res, token);

    void writeAudit(prisma, {
      actorId: created.id, action: 'org:create', targetType: 'organization', targetId: created.id,
      meta: { orgName, slug: baseSlug }, ip: clientIp(req),
    });

    return res.status(201).json({
      user: { id: created.id, email: created.email, displayName: created.displayName, accountRole: created.accountRole, workspaceRole: created.workspaceRole, timezone: created.timezone, tutorialCompletedAt: created.tutorialCompletedAt, preferences: created.preferences },
      token,
    });
  } catch (err) {
    console.error('[auth] create-organization error:', err);
    return res.status(500).json({ error: 'Gagal membuat organisasi' });
  }
});
```

- [ ] **Step 4: Typecheck**

```bash
cd server && npm run typecheck
```
Expected: clean.

- [ ] **Step 5: Restart the local dev server**

The dev server may still be running from earlier sessions with stale code. Check and restart if needed:

```bash
netstat -ano | grep ':3001' | grep LISTENING
```

If a PID is listed, stop it (`taskkill //PID <pid> //F` on Windows), then:

```bash
cd server && npm run dev > /tmp/dev-server-createorg.log 2>&1 &
sleep 4
curl -s http://localhost:3001/api/health
```
Expected: `"status":"ok"` in the response.

- [ ] **Step 6: Write the verification script**

Create `scratchpad/createorg_verify.mjs` (adjust the relative import path if run from a different cwd):

```js
import { PrismaClient } from '@prisma/client';

const BASE = 'http://localhost:3001/api';
const prisma = new PrismaClient();

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`PASS: ${name}`); pass++; }
  else { console.log(`FAIL: ${name}${extra ? ' -- ' + JSON.stringify(extra) : ''}`); fail++; }
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function main() {
  const stamp = Date.now();
  const orgName = `Test Org Alpha ${stamp}`;

  // ── Basic success path ──────────────────────────────────────────
  const emailA = `createorg-a-${stamp}@test.local`;
  const createA = await api('POST', '/auth/create-organization', { orgName, email: emailA, password: 'TestPass123!', displayName: 'Alpha Admin' });
  check('First org creation succeeds (201)', createA.status === 201, createA);
  check('Founding user is admin (accountRole)', createA.json?.user?.accountRole === 'admin', createA.json);
  check('Founding user is admin (workspaceRole)', createA.json?.user?.workspaceRole === 'admin', createA.json);
  check('Response includes a session token', !!createA.json?.token, createA.json);

  const userA = await prisma.user.findUnique({ where: { email: emailA } });
  const orgA = userA ? await prisma.organization.findUnique({ where: { id: userA.organizationId } }) : null;
  check('DB: org row has the exact submitted name', orgA?.name === orgName, orgA);
  check('DB: org slug is a clean slugification (no leading/trailing hyphen, lowercase)', !!orgA?.slug && orgA.slug === orgA.slug.toLowerCase() && !orgA.slug.startsWith('-') && !orgA.slug.endsWith('-'), orgA);

  // ── Same org NAME, different email -> different org, suffixed slug ──
  const emailB = `createorg-b-${stamp}@test.local`;
  const createB = await api('POST', '/auth/create-organization', { orgName, email: emailB, password: 'TestPass123!', displayName: 'Beta Admin' });
  check('Second org with SAME name succeeds (201)', createB.status === 201, createB);
  const userB = await prisma.user.findUnique({ where: { email: emailB } });
  const orgB = userB ? await prisma.organization.findUnique({ where: { id: userB.organizationId } }) : null;
  check('Second org has the SAME name as the first', orgB?.name === orgName, orgB);
  check('Second org got a DIFFERENT, suffixed slug (no collision)', !!orgB?.slug && orgB.slug !== orgA?.slug && orgB.slug.startsWith(orgA?.slug ?? ''), { orgA: orgA?.slug, orgB: orgB?.slug });
  check('Beta Admin landed in a DIFFERENT org than Alpha Admin', userB?.organizationId !== userA?.organizationId, { userA: userA?.organizationId, userB: userB?.organizationId });

  // ── Duplicate email rejected, no partial rows left behind ────────
  const orgCountBefore = await prisma.organization.count();
  const dup = await api('POST', '/auth/create-organization', { orgName: `Should Not Exist ${stamp}`, email: emailA, password: 'TestPass123!', displayName: 'Dup' });
  check('Duplicate email -> 409', dup.status === 409, dup);
  const orgCountAfter = await prisma.organization.count();
  check('No orphan org created on the rejected duplicate-email attempt', orgCountBefore === orgCountAfter, { before: orgCountBefore, after: orgCountAfter });

  // ── Validation ─────────────────────────────────────────────────
  const emptyName = await api('POST', '/auth/create-organization', { orgName: '', email: `createorg-c-${stamp}@test.local`, password: 'TestPass123!', displayName: 'C' });
  check('Empty orgName -> 400', emptyName.status === 400, emptyName);

  // ── Regression: existing manual register untouched ───────────────
  const regEmail = `createorg-reg-${stamp}@test.local`;
  const reg = await api('POST', '/auth/register', { email: regEmail, password: 'TestPass123!', displayName: 'Regular Signup' });
  check('Existing /auth/register still works (201)', reg.status === 201, reg);
  const regUser = await prisma.user.findUnique({ where: { email: regEmail } });
  check('Existing /auth/register STILL lands in the default org (unaffected)', regUser?.organizationId === 'org_kaitech_default', regUser);

  console.log(`\n${pass} passed, ${fail} failed`);

  // cleanup
  const cleanupEmails = [emailA, emailB, regEmail];
  const cleanupUsers = await prisma.user.findMany({ where: { email: { in: cleanupEmails } }, select: { id: true, organizationId: true } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUsers.map((u) => u.id) } } });
  const cleanupOrgIds = cleanupUsers.map((u) => u.organizationId).filter((id) => id !== 'org_kaitech_default');
  await prisma.organization.deleteMany({ where: { id: { in: cleanupOrgIds } } });

  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 7: Run it**

```bash
cd "<repo root>" && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/virtualmeet" node scratchpad/createorg_verify.mjs
```
Expected: `15 passed, 0 failed` (count the `check(...)` calls above to confirm — if the numbers don't match, something changed; re-derive rather than assume).

- [ ] **Step 8: Check the dev server log for unexpected errors**

```bash
tail -n 60 /tmp/dev-server-createorg.log | grep -iE 'error|warn|fatal|exception' | grep -v 'MaxListenersExceededWarning' | grep -v 'node --trace-warnings'
```
Expected: no output (both intentional-rejection paths in the test above return clean 4xx responses, not server-side errors/exceptions — anything printed here is a real problem to investigate).

- [ ] **Step 9: Delete the temporary verification script**

```bash
rm scratchpad/createorg_verify.mjs
```

- [ ] **Step 10: Commit**

```bash
git add server/src/middleware/validate.ts server/src/routes/auth.ts
git commit -m "Add POST /auth/create-organization: self-serve org + founding admin"
```

---

### Task 3: Client API + `useAuth` wiring

**Files:**
- Modify: `client/src/services/api.ts`
- Modify: `client/src/hooks/useAuth.ts`

**Interfaces:**
- Consumes: `POST /auth/create-organization` (Task 2).
- Produces: `api.createOrganization(orgName: string, email: string, password: string, displayName: string): Promise<{ user: UserProfile; token: string }>`; `useAuth().createOrganization(orgName: string, email: string, password: string, displayName: string): Promise<UserProfile>` (throws on failure, same contract as the existing `register`/`acceptOrgInvite`).

- [ ] **Step 1: Add the API call**

In `client/src/services/api.ts`, find:

```ts
  register: (email: string, password: string, displayName: string) =>
    request<{ user: UserProfile; token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    }),
```

Add immediately after it:

```ts

  // Self-serve org creation (Fase 5 follow-up) — same response shape as
  // register above, but creates a brand-new Organization too; the
  // founding user lands as that org's admin.
  createOrganization: (orgName: string, email: string, password: string, displayName: string) =>
    request<{ user: UserProfile; token: string }>('/auth/create-organization', {
      method: 'POST',
      body: JSON.stringify({ orgName, email, password, displayName }),
    }),
```

- [ ] **Step 2: Add the `useAuth` wrapper**

In `client/src/hooks/useAuth.ts`, find the existing `register` function:

```ts
  const register = useCallback(async (email: string, password: string, displayName: string) => {
    setError(null);
    setSessionExpiredMessage(null);
    try {
      const res = await api.register(email, password, displayName);
      localStorage.setItem('vm_token', res.token);
      setUser(res.user);
      return res.user;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
      throw err;
    }
  }, []);
```

Add immediately after it:

```ts

  // Self-serve org creation — same shape as register above, landing the
  // new account as the founding admin of a brand-new org instead of the
  // single default org register() always uses.
  const createOrganization = useCallback(async (orgName: string, email: string, password: string, displayName: string) => {
    setError(null);
    setSessionExpiredMessage(null);
    try {
      const res = await api.createOrganization(orgName, email, password, displayName);
      localStorage.setItem('vm_token', res.token);
      setUser(res.user);
      return res.user;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membuat organisasi');
      throw err;
    }
  }, []);
```

- [ ] **Step 3: Export it from the hook**

In `client/src/hooks/useAuth.ts`, find:

```ts
  return { user, loading, error, sessionExpiredMessage, login, register, acceptOrgInvite, logout, setError, markTutorialSeen, updatePreferences };
```

Replace with:

```ts
  return { user, loading, error, sessionExpiredMessage, login, register, acceptOrgInvite, createOrganization, logout, setError, markTutorialSeen, updatePreferences };
```

- [ ] **Step 4: Typecheck**

```bash
cd client && npm run typecheck
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add client/src/services/api.ts client/src/hooks/useAuth.ts
git commit -m "Wire createOrganization through useAuth and the API client"
```

---

### Task 4: `LoginPage.tsx` third mode + `App.tsx` wiring

**Files:**
- Modify: `client/src/pages/LoginPage.tsx`
- Modify: `client/src/App.tsx`

**Interfaces:**
- Consumes: `createOrganization` from `useAuth` (Task 3).
- Produces: a new `onCreateOrganization: (orgName: string, email: string, password: string, displayName: string) => Promise<void>` prop on `LoginPage`.

- [ ] **Step 1: Add the prop and mode**

In `client/src/pages/LoginPage.tsx`, find:

```ts
interface LoginPageProps {
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (email: string, password: string, displayName: string) => Promise<void>;
  error: string | null;
  // Set instead of `error` when auto-login on mount found a token the
  // server actively rejected (expired/invalid/deleted user) — distinct
  // styling on purpose, since this isn't something the user did wrong.
  sessionExpiredMessage?: string | null;
  theme: Theme;
  onToggleTheme: () => void;
}

export function LoginPage({ onLogin, onRegister, error, sessionExpiredMessage, theme, onToggleTheme }: LoginPageProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
```

Replace with:

```ts
interface LoginPageProps {
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (email: string, password: string, displayName: string) => Promise<void>;
  // Self-serve org creation — a third entry point alongside login/register,
  // NOT a replacement for onRegister: the existing "Sign Up here!" flow
  // still joins the single default org, unchanged. This one creates a
  // brand-new org and lands the caller as its founding admin.
  onCreateOrganization: (orgName: string, email: string, password: string, displayName: string) => Promise<void>;
  error: string | null;
  // Set instead of `error` when auto-login on mount found a token the
  // server actively rejected (expired/invalid/deleted user) — distinct
  // styling on purpose, since this isn't something the user did wrong.
  sessionExpiredMessage?: string | null;
  theme: Theme;
  onToggleTheme: () => void;
}

export function LoginPage({ onLogin, onRegister, onCreateOrganization, error, sessionExpiredMessage, theme, onToggleTheme }: LoginPageProps) {
  const [mode, setMode] = useState<'login' | 'register' | 'createOrg'>('login');
  const [orgName, setOrgName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
```

- [ ] **Step 2: Update the submit handler**

Find:

```ts
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === 'login') {
        await onLogin(email, password);
      } else {
        await onRegister(email, password, displayName);
      }
    } finally {
      setLoading(false);
    }
  };
```

Replace with:

```ts
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === 'login') {
        await onLogin(email, password);
      } else if (mode === 'createOrg') {
        await onCreateOrganization(orgName, email, password, displayName);
      } else {
        await onRegister(email, password, displayName);
      }
    } finally {
      setLoading(false);
    }
  };
```

- [ ] **Step 3: Update the heading**

Find:

```tsx
        <h1 className="text-[28px] leading-tight font-bold text-gray-900 dark:text-white mb-6">
          {mode === 'login' ? 'Welcome to KaiSpace' : 'Create your KaiSpace account'}
        </h1>
```

Replace with:

```tsx
        <h1 className="text-[28px] leading-tight font-bold text-gray-900 dark:text-white mb-6">
          {mode === 'login' ? 'Welcome to KaiSpace' : mode === 'createOrg' ? 'Buat organisasi baru' : 'Create your KaiSpace account'}
        </h1>
```

- [ ] **Step 4: Add the organization-name field**

Find the start of the form (the Email label is the first field):

```tsx
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Email</span>
```

Replace with:

```tsx
        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'createOrg' && (
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Nama organisasi</span>
              <input
                type="text" value={orgName} onChange={(e) => setOrgName(e.target.value)}
                placeholder="mis. DCM"
                maxLength={80} required autoFocus
                className="w-full bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg px-3 py-2.5 outline-none border border-purple-100 dark:border-gray-600 focus:border-purple-500 transition-colors text-sm"
              />
            </label>
          )}
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Email</span>
```

- [ ] **Step 5: Show the Display Name field in `createOrg` mode too**

The Display Name field is currently gated to `register` mode only, but `createOrg` mode reuses the same email/password/display-name inputs (per the design spec). Find:

```tsx
          {mode === 'register' && (
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Display name</span>
              <input
                type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Nama tampilanmu" required maxLength={30}
                className="w-full bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg px-3 py-2.5 outline-none border border-purple-100 dark:border-gray-600 focus:border-purple-500 transition-colors text-sm"
              />
            </label>
          )}
```

Replace with:

```tsx
          {(mode === 'register' || mode === 'createOrg') && (
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Display name</span>
              <input
                type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Nama tampilanmu" required maxLength={30}
                className="w-full bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg px-3 py-2.5 outline-none border border-purple-100 dark:border-gray-600 focus:border-purple-500 transition-colors text-sm"
              />
            </label>
          )}
```

- [ ] **Step 6: Add the new entry point below the existing login/register toggle**

Find this existing block (the login↔register toggle — note its ternary already degrades correctly for `'createOrg'` mode too, since `mode === 'login'` is simply false there, falling through to the "already have an account / Sign in" branch — so this block itself needs NO changes):

```tsx
        <p className="text-gray-500 dark:text-gray-400 text-xs text-center mt-5">
          {mode === 'login' ? "Don't have account?" : 'Already have an account?'}{' '}
          <button
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
            style={{ color: FIGMA_PURPLE }}
            className="font-semibold hover:brightness-110 cursor-pointer"
          >
            {mode === 'login' ? 'Sign Up here!' : 'Sign in'}
          </button>
        </p>
```

Add a new, second paragraph immediately after its closing `</p>`:

```tsx
        <p className="text-gray-500 dark:text-gray-400 text-xs text-center mt-2">
          {mode === 'createOrg' ? (
            <>
              Sudah punya akun?{' '}
              <button
                type="button"
                onClick={() => setMode('login')}
                style={{ color: FIGMA_PURPLE }}
                className="font-semibold hover:brightness-110 cursor-pointer"
              >
                Login di sini
              </button>
            </>
          ) : (
            <>
              Mau bikin organisasi sendiri?{' '}
              <button
                type="button"
                onClick={() => setMode('createOrg')}
                style={{ color: FIGMA_PURPLE }}
                className="font-semibold hover:brightness-110 cursor-pointer"
              >
                Buat di sini
              </button>
            </>
          )}
        </p>
```

- [ ] **Step 7: Wire the prop through in `App.tsx`**

In `client/src/App.tsx`, find:

```ts
  const { user, loading, error, sessionExpiredMessage, login, register, acceptOrgInvite, logout, markTutorialSeen, updatePreferences } = useAuth();
```

Replace with:

```ts
  const { user, loading, error, sessionExpiredMessage, login, register, acceptOrgInvite, createOrganization, logout, markTutorialSeen, updatePreferences } = useAuth();
```

Find:

```tsx
    return <LoginPage onLogin={async (e, p) => { await login(e, p); }} onRegister={async (e, p, n) => { await register(e, p, n); }} error={error} sessionExpiredMessage={sessionExpiredMessage} theme={theme} onToggleTheme={toggleTheme} />;
```

Replace with:

```tsx
    return (
      <LoginPage
        onLogin={async (e, p) => { await login(e, p); }}
        onRegister={async (e, p, n) => { await register(e, p, n); }}
        onCreateOrganization={async (o, e, p, n) => { await createOrganization(o, e, p, n); }}
        error={error}
        sessionExpiredMessage={sessionExpiredMessage}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
```

- [ ] **Step 8: Typecheck**

```bash
cd client && npm run typecheck
```
Expected: clean.

- [ ] **Step 9: Production build**

```bash
cd client && npm run build
```
Expected: succeeds (`✓ built in ...`), same pre-existing chunk-size warning as always is fine, no new errors.

- [ ] **Step 10: Commit**

```bash
git add client/src/pages/LoginPage.tsx client/src/App.tsx
git commit -m "Add self-serve org creation entry point to LoginPage"
```

---

### Task 5: Final end-to-end pass + rate-limit check

**Files:** none (verification only).

- [ ] **Step 1: Restart the local dev server fresh**

```bash
netstat -ano | grep ':3001' | grep LISTENING
```
Stop whatever PID is listed, then:
```bash
cd server && npm run dev > /tmp/dev-server-final.log 2>&1 &
sleep 4
curl -s http://localhost:3001/api/health
```
Expected: `"status":"ok"`.

- [ ] **Step 2: Re-run the Task 2 verification script one more time against the fresh server**

Recreate `scratchpad/createorg_verify.mjs` with the exact contents from Task 2 Step 6, run it, confirm the same pass count, then delete it again:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/virtualmeet" node scratchpad/createorg_verify.mjs
rm scratchpad/createorg_verify.mjs
```
Expected: `15 passed, 0 failed`.

- [ ] **Step 3: Dedicated rate-limit check (run LAST — this deliberately exhausts the shared authRateLimit bucket)**

`authRateLimit` is a single shared middleware instance reused across `/register`, `/login`, AND `/create-organization` — hits against any of them count toward the same 10-per-15-min-per-IP bucket. Verify the limit actually engages:

Create `scratchpad/createorg_ratelimit_verify.mjs`:

```js
const BASE = 'http://localhost:3001/api';

async function main() {
  const results = [];
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${BASE}/auth/create-organization`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgName: `Ratelimit Test ${Date.now()}-${i}`, email: `ratelimit-${Date.now()}-${i}@test.local`, password: 'TestPass123!', displayName: 'RL Test' }),
    });
    results.push(res.status);
  }
  console.log('Statuses:', results.join(', '));
  const has429 = results.includes(429);
  console.log(has429 ? 'PASS: rate limit engaged within 12 attempts' : 'FAIL: no 429 seen in 12 rapid attempts');
  process.exit(has429 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Run it:
```bash
node scratchpad/createorg_ratelimit_verify.mjs
```
Expected: `PASS: rate limit engaged within 12 attempts`, with a `429` appearing partway through the status list (the exact position depends on how much of the bucket Step 2's run already consumed — that's fine, any 429 appearing proves the limiter is live).

Clean up any orgs/users this created, then delete the script:
```bash
cd "<repo root>" && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/virtualmeet" node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const users = await prisma.user.findMany({ where: { email: { contains: '@test.local' }, email: { startsWith: 'ratelimit-' } }, select: { id: true, organizationId: true } });
  await prisma.user.deleteMany({ where: { id: { in: users.map(u => u.id) } } });
  await prisma.organization.deleteMany({ where: { id: { in: users.map(u => u.organizationId) } } });
  console.log('cleaned', users.length);
  await prisma.\$disconnect();
})();
"
rm scratchpad/createorg_ratelimit_verify.mjs
```

- [ ] **Step 4: Restart the dev server once more to reset the in-memory rate limiter**

(So the environment is left clean, not mid-lockout, for whoever tests next.)

```bash
netstat -ano | grep ':3001' | grep LISTENING
```
Stop the listed PID, then:
```bash
cd server && npm run dev > /tmp/dev-server-clean.log 2>&1 &
sleep 4
curl -s http://localhost:3001/api/health
```
Expected: `"status":"ok"`.

- [ ] **Step 5: Check dev server log one last time**

```bash
tail -n 80 /tmp/dev-server-final.log | grep -iE 'error|fatal|exception' | grep -v 'MaxListenersExceededWarning' | grep -v 'node --trace-warnings'
```
Expected: no output.

- [ ] **Step 6: Report to the user**

Summarize: all checks passed/failed with exact counts, explicitly note that live-browser UI testing was NOT performed (typecheck + build only), and that this is code-complete on the local branch — **do not deploy** (push/VPS steps) without an explicit go-ahead, per this repo's standing deploy convention used throughout every prior slice in this engagement.

---

## Self-Review Notes

- **Spec coverage:** new entry point (Task 4) ✓, four fields incl. auto slug (Task 1+2) ✓, no approval gate / rate-limit only (Task 2 route + Task 5 Step 3) ✓, email+password only / no OAuth buttons (Task 4 has none) ✓, atomic transaction (Task 2) ✓, audit logging (Task 2) ✓, regression check for existing Sign Up (Task 2 Step 6 script) ✓.
- **Type consistency:** `createOrganization(orgName, email, password, displayName)` — same parameter order and names used identically in `api.ts` (Task 3 Step 1), `useAuth.ts` (Task 3 Step 2), `LoginPage.tsx`'s prop type (Task 4 Step 1), and `App.tsx`'s wiring (Task 4 Step 7). Response shape `{ user, token }` matches `register`'s existing shape exactly, reusing `UserProfile` — no new client-side type needed.
- **No placeholders:** every step has complete, concrete code; no "add validation"/"TBD" left anywhere.
