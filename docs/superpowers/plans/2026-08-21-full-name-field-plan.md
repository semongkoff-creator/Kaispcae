# Full Name Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Nama Lengkap" (Full Name) field, separate from and additive to the existing "Display Name" — editable in the Avatar Editor, auto-populated once (never overwritten again) from Lark's real profile name for Lark-authenticated accounts.

**Architecture:** New nullable `User.fullName` column. Lark login gains one additional atomic "set if null" write (same race-safe pattern as this session's earlier `firstSeenAt`), so it seeds from Lark's real `name` exactly once and is never silently clobbered afterward. A new, small, dedicated server route (`PUT /users/me/full-name`) writes it — deliberately NOT folded into the existing `PUT /users/me/avatar`, which stores its entire request body as `avatarConfig` JSON verbatim. The Avatar Editor gains a new "Nama Lengkap" input alongside the existing "Display Name" one, saved through the new route on the same "Save & Apply" click. `User.displayName` and everything currently wired to it are completely untouched.

**Tech Stack:** Express, Prisma (Postgres), React/TypeScript, Zod (validation). No new dependency.

## Global Constraints

- `User.displayName` and every surface currently reading it (avatar nametag, room-entry popup, desk-seat nameplate, chat, Participant Panel, admin console, attendance/HR) are completely unchanged — this plan touches none of that code.
- `fullName` is shown/editable ONLY in the Avatar Editor — no other UI surface displays it.
- Lark-authenticated accounts: `fullName` auto-populates from Lark's real profile `name` field, but ONLY while `fullName` is still null (atomic "set if null" — same pattern as `firstSeenAt`). Once set (by auto-fill or manual edit), never silently overwritten again, including by a later Lark login.
- Non-Lark (manually registered) accounts: `fullName` starts null, filled in only by the user via the Avatar Editor.
- The new `PUT /users/me/full-name` route writes `fullName` and NOTHING else — mirrors the (now-removed) `room-display-name` route's own reasoning: never fold a single-field write into `PUT /users/me/avatar`, which stores its whole body as `avatarConfig`.
- A save with an empty/whitespace-only value clears `fullName` back to `null` (the field is optional and must stay explicitly clearable) — not rejected as invalid.
- No change to `StatusInterval`, `firstSeenAt`/`lastSeenAt`, or any other feature shipped earlier this session.
- `docs/` folder and "SS AN.docx" are ALWAYS excluded from every commit.

---

### Task 1: Schema, migration, and the read path (`publicUser.ts`, `/me`)

**Files:**
- Modify: `server/prisma/schema.prisma` (`User` model — add `fullName`)
- Create: `server/prisma/migrations/20260824000000_add_user_full_name/migration.sql`
- Modify: `server/src/lib/publicUser.ts` (`PublicUserFields` + `publicUser()` — add `fullName`)
- Modify: `server/src/routes/auth.ts` (`/me`'s explicit `select` — add `fullName: true`)

**Interfaces:**
- Produces: `User.fullName` (`DateTime?` — no, `String?`, nullable). `publicUser()`'s return object (and therefore `publicUserWithAvatar()`, which spreads it) gains `fullName: string | null`. Task 2 writes to this column; Task 3 reads/renders it client-side.

- [ ] **Step 1: Add `fullName` to the Prisma schema**

Open `server/prisma/schema.prisma`. Find the `User` model's `displayName` field (near the top of the model, currently `displayName String` around line 28). Add a new field right after it:

```prisma
  displayName String
  // specs/2026-08-21-full-name-field-design.md — a separate, purely
  // additive field from displayName above: the account's real/legal name,
  // shown/editable only in the Avatar Editor, never used for the nametag,
  // chat, Participant Panel, or any other surface that already reads
  // displayName. Auto-populated once from Lark's real profile name for
  // Lark-authenticated accounts (see lib/statusIntervals.ts's firstSeenAt
  // for the same "set exactly once, race-safe" pattern this reuses) — set
  // via an atomic updateMany({where: {id, fullName: null}, ...}) on Lark
  // login, so a manually-edited value is never silently overwritten. Null
  // for a manually-registered account until the user fills it in
  // themselves; never guessed.
  fullName String?
```

(Confirm the exact current line/formatting around `displayName` before inserting — this must land as a real diff against the live file, not a guess.)

- [ ] **Step 2: Create the migration**

Create `server/prisma/migrations/20260824000000_add_user_full_name/migration.sql` with exactly this content:

```sql
-- specs/2026-08-21-full-name-field-design.md — a new, purely additive
-- column, separate from User.displayName (untouched by this migration).
-- Nullable: stays NULL for every existing user until either a Lark login
-- auto-populates it (once, never overwritten again — see the schema
-- comment) or the user fills it in themselves via the Avatar Editor.

ALTER TABLE "User" ADD COLUMN "fullName" TEXT;
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate --schema=server/prisma/schema.prisma`

Expected: `✔ Generated Prisma Client` with no errors. This does not apply the migration to any database (no live local Postgres in this environment, per this session's established convention) — the SQL above is hand-verified by reading it against the schema, and applies automatically on deploy via `deploy/deploy.sh`'s `prisma migrate deploy` step.

- [ ] **Step 4: Add `fullName` to `publicUser()`'s type and return object**

Open `server/src/lib/publicUser.ts`. Read its current full content (it's short). Find `PublicUserFields`'s `Pick<User, ...>` type and add `'fullName'` to that list. Find `publicUser()`'s return object (currently returns `id`, `email`, `displayName`, `accountRole`, `workspaceRole`, `timezone`, `tutorialCompletedAt`, `preferences`) and add `fullName: user.fullName,` to it, near `displayName`. Do not otherwise change `publicUserWithAvatar()` — it already spreads `publicUser(user)`, so it automatically gains `fullName` too.

- [ ] **Step 5: Add `fullName: true` to `/me`'s explicit select**

Open `server/src/routes/auth.ts`. Find the `/me` route's `select` block (search for `select: { id: true, email: true, displayName: true, avatarConfig: true, preferences: true,`). Add `fullName: true,` to that line, right after `displayName: true,`:

```ts
        id: true, email: true, displayName: true, fullName: true, avatarConfig: true, preferences: true,
```

Every other line in that select block is unchanged. This is the only explicit-select call site producing a `user` object that flows into `publicUser`/`publicUserWithAvatar` that needs a manual field addition — every OTHER caller across the codebase that constructs a `user` via a bare `prisma.user.create(...)` or `prisma.user.update(...)` with no `select` clause (e.g. `server/src/routes/lark.ts`'s login handler, Task 2's concern) already returns every scalar column, including the new `fullName`, automatically — no code change needed there for the TYPE to be satisfied, only for the VALUE to actually be non-null (which is Task 2's job).

**Before finishing this task, grep the whole `server/src` tree for `publicUser(` and `publicUserWithAvatar(` calls** and confirm each one's `user` argument comes from either (a) a bare `create`/`update`/`findUnique` with no `select` (fine, needs no change), or (b) an explicit `select` block (needs `fullName: true` added, same as Step 5 above) — if you find any OTHER explicit-select call site besides `/me`'s that isn't already covered, add `fullName: true` there too and note it in your report.

- [ ] **Step 6: Typecheck the server workspace**

Run: `npm run typecheck --workspace=server`

Expected: no errors. Slow on this machine (3-5+ minutes) — wait for it, don't cut it short.

- [ ] **Step 7: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/20260824000000_add_user_full_name server/src/lib/publicUser.ts server/src/routes/auth.ts
git commit -m "feat: add User.fullName, exposed via /me alongside the existing displayName"
```

---

### Task 2: Server write paths — the new save route and the Lark auto-populate

**Files:**
- Modify: `server/src/middleware/validate.ts` (new `fullNameSchema`)
- Modify: `server/src/routes/rooms.ts` (new `PUT /users/me/full-name` route)
- Modify: `server/src/routes/lark.ts` (the login handler — one additional atomic write)

**Interfaces:**
- Consumes: `User.fullName` from Task 1.
- Produces: `PUT /api/users/me/full-name` → `{ success: true }`. Task 3's client code calls this.

- [ ] **Step 1: Add `fullNameSchema` to `validate.ts`**

Open `server/src/middleware/validate.ts`. Find `avatarUpdateSchema` (or any other nearby schema) as a placement reference, and add a new export near the other small profile-field schemas:

```ts
// specs/2026-08-21-full-name-field-design.md — no `.min(1)`: an empty
// string is a valid submission and means "clear the field back to null"
// (see the route below), not an invalid one. 100 chars is generous
// compared to displayName's 20-char nametag cap — a real full name is
// often longer than a casual nickname.
export const fullNameSchema = z.object({
  name: z.string().max(100),
});
```

- [ ] **Step 2: Add the `PUT /users/me/full-name` route to `rooms.ts`**

Open `server/src/routes/rooms.ts`. Find the import line that currently reads `import { validate, createRoomSchema, renameRoomSchema, avatarUpdateSchema } from '../middleware/validate';` and add `fullNameSchema` to it:

```ts
import { validate, createRoomSchema, renameRoomSchema, avatarUpdateSchema, fullNameSchema } from '../middleware/validate';
```

Find the end of the existing `PUT /users/me/avatar` route (search for `// PUT /api/users/me/avatar` and its handler, ending in `export default rooms;` shortly after — confirm nothing else currently sits between them). Add this new route right after `PUT /users/me/avatar`'s closing `});`, before `export default rooms;`:

```ts
// PUT /api/users/me/full-name — specs/2026-08-21-full-name-field-design.md.
// Deliberately its OWN route, not folded into PUT /users/me/avatar above:
// that route stores its ENTIRE request body as avatarConfig verbatim —
// reusing it here would nest fullName inside that JSON blob instead of
// writing the real User.fullName column. This route writes fullName and
// NOTHING else. An empty string clears it back to null (fullName is an
// optional, explicitly-clearable field, not a required one).
rooms.put('/users/me/full-name', authenticateToken, validate(fullNameSchema), async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const trimmed = req.body.name.trim();
    await prisma.user.update({
      where: { id: req.userId },
      data: { fullName: trimmed || null },
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[rooms] full name save error:', err);
    return res.status(500).json({ error: 'Failed to save full name' });
  }
});
```

- [ ] **Step 3: Add the atomic Lark auto-populate write to `lark.ts`**

Open `server/src/routes/lark.ts`. Find the Lark login handler's user-resolution block — it ends with `user` guaranteed to be a real, non-null `User` row (after the create-or-link, brand-new-create, and existing-account-resync branches all complete), right before the comment `// 4) OUR token, minted the one and only way (identical to manual login).`. The `name` variable (Lark's resolved profile name, possibly `undefined` if Lark didn't return one) is still in scope at this point.

Insert this new block right after the user-resolution `if`/`else if`/`else` chain finishes, and before the `// 4) OUR token...` comment:

```ts
    // specs/2026-08-21-full-name-field-design.md — seeds fullName from
    // Lark's real profile name EXACTLY ONCE, race-safe (same
    // "set-if-null" pattern as firstSeenAt from earlier this session):
    // updateMany's own where clause re-checks fullName is still null AT
    // WRITE TIME, so this can never silently overwrite a value the user
    // already set (via this same auto-fill, on an earlier login, or by
    // editing it manually in the Avatar Editor). Runs on every Lark
    // login — cheap, since `name` was already fetched above for
    // displayName — but only actually writes while fullName is null.
    if (name) {
      await prisma.user.updateMany({ where: { id: user.id, fullName: null }, data: { fullName: name } });
    }

```

Do not change anything else in this handler — the existing `displayName`/`avatar`/token-related logic above and below this insertion is untouched.

- [ ] **Step 4: Typecheck the server workspace**

Run: `npm run typecheck --workspace=server`

Expected: no errors. Slow (3-5+ minutes) — wait for it.

- [ ] **Step 5: Commit**

```bash
git add server/src/middleware/validate.ts server/src/routes/rooms.ts server/src/routes/lark.ts
git commit -m "feat: add PUT /users/me/full-name, auto-populate fullName once from Lark on login"
```

---

### Task 3: Client — Avatar Editor field, save wiring, both call sites

**Files:**
- Modify: `client/src/services/api.ts` (`UserProfile` + new `saveFullName`)
- Modify: `client/src/hooks/useCurrentUser.ts` (`CurrentUser` + `toCurrentUser` — thread `fullName` through for the Sidebar-triggered call site)
- Modify: `client/src/components/avatar/AvatarSetup.tsx` (new prop, new state, new input, extended save)
- Modify: `client/src/App.tsx` (both `<AvatarSetup .../>` call sites)

**Interfaces:**
- Consumes: `GET /auth/me`'s response (Task 1) now includes `fullName: string | null`. `PUT /users/me/full-name` (Task 2) is the write target.
- Produces: nothing new for later tasks — this is the final task in this plan.

- [ ] **Step 1: Add `fullName` to `UserProfile` and a new `saveFullName` function**

Open `client/src/services/api.ts`. Find the `UserProfile` interface (currently starting `export interface UserProfile { id: string; email: string; displayName: string; ...`, around line 247). Add a new field right after `displayName: string;`:

```ts
  displayName: string;
  // specs/2026-08-21-full-name-field-design.md — separate from
  // displayName; null means the account has never had it set (a
  // manually-registered account that hasn't filled it in yet, or a Lark
  // account whose profile fetch never returned a name). Shown/editable
  // only in the Avatar Editor.
  fullName?: string | null;
```

Find the `saveAvatar` function (currently `saveAvatar: (config: any) => request<{ success: boolean }>('/users/me/avatar', { method: 'PUT', body: JSON.stringify(config) }),`, around line 613). Add a new function right after it:

```ts
  // specs/2026-08-21-full-name-field-design.md — separate endpoint from
  // saveAvatar above on purpose: that route stores its whole body as
  // avatarConfig verbatim, so reusing it here would nest fullName inside
  // that JSON blob instead of writing the real column.
  saveFullName: (name: string) =>
    request<{ success: boolean }>('/users/me/full-name', {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),
```

- [ ] **Step 2: Thread `fullName` through `CurrentUser`**

Open `client/src/hooks/useCurrentUser.ts`. Find the `CurrentUser` interface and add a new field:

```ts
export interface CurrentUser {
  id: string;
  name: string;
  // specs/2026-08-21-full-name-field-design.md — threaded through so the
  // Sidebar-triggered Avatar Editor (which only receives `currentUser`,
  // not the raw `user` object) can pre-fill the Nama Lengkap field.
  fullName?: string | null;
  avatarUrl?: string;
  workspaceRole: WorkspaceRole;
  timezone: string;
  isDefaultOrg: boolean;
}
```

Find `toCurrentUser` and add the field to its return object:

```ts
export function toCurrentUser(user: UserProfile): CurrentUser {
  return {
    id: user.id,
    name: user.displayName,
    fullName: user.fullName,
    workspaceRole: user.workspaceRole ?? 'member',
    timezone: user.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta',
    isDefaultOrg: user.isDefaultOrg ?? true,
  };
}
```

- [ ] **Step 3: Add the "Nama Lengkap" field to `AvatarSetup.tsx`**

Open `client/src/components/avatar/AvatarSetup.tsx`. Find `AvatarSetupProps` (currently `{ initialConfig?: AvatarConfig; onSave: (config: AvatarConfig) => void; onClose?: () => void; localUserId?: string; }`) and add a new optional prop:

```ts
interface AvatarSetupProps {
  initialConfig?: AvatarConfig;
  onSave: (config: AvatarConfig) => void;
  onClose?: () => void;
  localUserId?: string;
  // specs/2026-08-21-full-name-field-design.md — pre-fills the new "Nama
  // Lengkap" field. Separate from initialConfig/AvatarConfig entirely —
  // fullName is not part of the pixel-avatar config, it's saved through
  // its own dedicated endpoint (api.saveFullName), not api.saveAvatar.
  initialFullName?: string | null;
}
```

Find the function signature (`export function AvatarSetup({ initialConfig, onSave, onClose, localUserId }: AvatarSetupProps) {`) and add `initialFullName` to the destructuring:

```ts
export function AvatarSetup({ initialConfig, onSave, onClose, localUserId, initialFullName }: AvatarSetupProps) {
```

Right after the component's existing `photo`/`photoBusy`/`photoError` state declarations (search for `const [photoError, setPhotoError] = useState('');`), add:

```ts
  // specs/2026-08-21-full-name-field-design.md — independent of `config`
  // (the AvatarConfig) entirely, same reasoning as the photo state right
  // above: saved through its own dedicated call (api.saveFullName), not
  // bundled into onSave/api.saveAvatar.
  const [fullName, setFullName] = useState(initialFullName ?? '');
```

Find the existing "Display Name" `<Section>` (currently lines ~287-298, starting `{/* Display Name */}`). Add a new "Nama Lengkap" `<Section>` right before it (so it appears above Display Name in the form, matching the design's placement):

```tsx
        {/* Nama Lengkap — specs/2026-08-21-full-name-field-design.md.
            Separate from Display Name below: this is the account's real
            name, saved through its own endpoint, never shown on the
            nametag/desk pill/chat/anywhere else. */}
        <Section label="Nama Lengkap">
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value.slice(0, 100))}
            maxLength={100}
            className="w-full bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg px-3 py-2 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500 transition-colors text-sm"
            placeholder="Nama lengkap kamu"
          />
        </Section>

        {/* Display Name */}
```

Find `handleSave` (currently `const handleSave = () => { const trimmed = { ...config, name: config.name.trim() || 'You', statusTag: config.statusTag.trim().slice(0, 10) }; setConfig(trimmed); onSave(trimmed); };`). Extend it to also save `fullName`:

```ts
  const handleSave = () => {
    const trimmed = { ...config, name: config.name.trim() || 'You', statusTag: config.statusTag.trim().slice(0, 10) };
    setConfig(trimmed);
    onSave(trimmed);
    // specs/2026-08-21-full-name-field-design.md — fire-and-forget, same
    // posture as every other profile-field save in this codebase; a
    // failure here must never block the avatar-config save above or the
    // panel closing. Empty string is a valid submission (clears fullName
    // back to null server-side) — see the route's own comment.
    api.saveFullName(fullName.trim()).catch(() => {});
  };
```

- [ ] **Step 4: Pass `initialFullName` from both `<AvatarSetup .../>` call sites in `App.tsx`**

Open `client/src/App.tsx`. Find the first call site (currently lines 2379-2386, inside the `Game`-scoped Sidebar-triggered block: `{avatarSetupActive && (<AvatarSetup initialConfig={savedConfig} onSave={handleAvatarSave} onClose={closePanel} localUserId={localUserId} />)}`). Add `initialFullName={currentUser.fullName}` to it:

```tsx
      {avatarSetupActive && (
        <AvatarSetup
          initialConfig={savedConfig}
          onSave={handleAvatarSave}
          onClose={closePanel}
          localUserId={localUserId}
          initialFullName={currentUser.fullName}
        />
      )}
```

(Confirm `currentUser` is genuinely a `CurrentUser`-typed prop already in scope at this exact point in the `Game` component — it's the same `currentUser` object this component already receives and uses elsewhere, e.g. for chat sender identity.)

Find the second call site (currently lines 3321-3328, the first-time-onboarding one: `if (showAvatarSetup) { return (<AvatarSetup initialConfig={{ ...loadAvatarConfig(), name: playerName || user.displayName }} onSave={handleAvatarSave} />); }`). Add `initialFullName={user.fullName}` to it:

```tsx
  if (showAvatarSetup) {
    return (
      <AvatarSetup
        initialConfig={{ ...loadAvatarConfig(), name: playerName || user.displayName }}
        onSave={handleAvatarSave}
        initialFullName={user.fullName}
      />
    );
  }
```

(This second call site is in the outer wrapper component, which already has direct access to the raw `user` object from `useAuth()` — no `currentUser` adapter needed here.)

- [ ] **Step 5: Typecheck the client workspace**

Run: `npm run typecheck --workspace=client`

Expected: no errors. Slow (3-5+ minutes) — wait for it.

- [ ] **Step 6: Typecheck the server workspace (confirms nothing else broke)**

Run: `npm run typecheck --workspace=server`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/services/api.ts client/src/hooks/useCurrentUser.ts client/src/components/avatar/AvatarSetup.tsx client/src/App.tsx
git commit -m "feat: add Nama Lengkap field to the Avatar Editor"
```

---

## Final Verification

- [ ] `npm run typecheck --workspace=server` passes.
- [ ] `npm run typecheck --workspace=client` passes.
- [ ] `git log --oneline -3` shows exactly the 3 commits from Tasks 1-3, in order.
- [ ] Grep the whole repo for `fullName` — confirm it appears ONLY in the places this plan added it (schema, migration, `publicUser.ts`, `auth.ts`, `validate.ts`, `rooms.ts`, `lark.ts`, `api.ts`, `useCurrentUser.ts`, `AvatarSetup.tsx`, `App.tsx`) — nothing in `ParticipantPanel.tsx`, `ChatPanel.tsx`, `MessengerApp.tsx`, `GameCanvas.tsx`/`AvatarSprite.ts` (the nametag), or any other surface this plan deliberately left untouched.
- [ ] Grep for `displayName` across the diff of all 3 commits combined — confirm zero lines touch its existing read/write behavior anywhere (only new, additive `fullName` code should appear).

## Manual Testing After Deploy

1. **Field appears and saves:** open the Avatar Editor (via Sidebar "Edit Avatar", or first-time onboarding for a brand-new account) — a new "Nama Lengkap" field appears above "Display Name". Type a value, click Save & Apply — reopen the editor (or reload) and confirm the value persisted.
2. **Clearing works:** clear the field back to empty and save — reopen and confirm it's now empty (not stuck at the old value, not throwing an error).
3. **Lark auto-populate, first time:** a Lark-authenticated account that has never had `fullName` set — after logging in via Lark, open the Avatar Editor and confirm "Nama Lengkap" is pre-filled with their real Lark profile name.
4. **Lark auto-populate never overwrites a manual edit:** for that same account, manually change "Nama Lengkap" to something else and save. Log out and log back in via Lark — open the Avatar Editor again and confirm the MANUALLY-SET value is still there, NOT reverted to the Lark name.
5. **Non-Lark account:** a manually-registered account's "Nama Lengkap" starts empty and stays empty until filled in — no auto-population attempt, no error.
6. **No other surface shows it:** confirm the nametag, chat, Participant Panel, desk-seat nameplate, and admin console all look completely unchanged — "Nama Lengkap" appears nowhere except the Avatar Editor form itself.
7. **Both entry points work:** confirm the field pre-fills and saves correctly BOTH from the Sidebar's "Edit Avatar" (mid-session) AND from first-time onboarding's Avatar Setup screen (a brand-new account).
