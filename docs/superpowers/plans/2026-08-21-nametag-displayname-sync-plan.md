# Nametag / Display Name Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The floating avatar nametag always matches the account's Display Name — removes the separate "room-entry nickname" concept (`User.roomDisplayName`) that was silently overriding it after the first login.

**Architecture:** This is a net REMOVAL. `User.roomDisplayName`, its two API routes (client + server), its `NameModal.tsx` prompt component, and the `App.tsx` state machine that gated room entry behind it are all deleted. What replaces it is simpler, not more code: the client's `playerName` session state seeds directly from `user.displayName`. One behavior from the removed flow must be preserved carefully: the old name-submit handler was ALSO the trigger for showing full Avatar Setup to an account that had never configured a body/appearance — that trigger moves into the same seeding effect, keyed on `avatarConfig.bodyShape` alone (the part of the old check that still means something once there's no separate name-collection step).

**Tech Stack:** Express, Prisma (Postgres), React/TypeScript. No new dependency.

## Global Constraints

- The nametag must always equal `User.displayName` — no separate nickname field, no fallback chain.
- `User.roomDisplayName` is DROPPED via a new migration (not left dormant) — confirmed with the user, it holds no data worth preserving.
- `NameModal.tsx` is deleted entirely — its only call site is removed by this plan, and no other caller exists.
- The "show Avatar Setup for an account that's never configured a body/appearance" behavior, currently triggered from inside the code being removed, MUST be preserved — check `avatarConfig.bodyShape` (not `.name`, which no longer means anything distinct once there's no separate name-collection step) as the trigger condition.
- Do not edit the OLD migration (`20260821170000_add_user_room_display_name`) — ship the removal as a NEW migration.
- Guests (`GuestEntry.tsx`), chat, participant lists, the furniture/desk nameplate — all already correct, all untouched by this plan.
- Avatar Editor's existing save path (`AvatarSetup.tsx` → `handleAvatarSave` → `api.saveAvatar` → `PUT /users/me/avatar` → writes `User.displayName`) is already correct and is NOT modified by this plan.

---

### Task 1: Server — remove `roomDisplayName` (field, route, migration)

**Files:**
- Modify: `server/prisma/schema.prisma` (`User` model — remove the `roomDisplayName` field)
- Create: `server/prisma/migrations/20260821220000_drop_user_room_display_name/migration.sql`
- Modify: `server/src/routes/rooms.ts` (remove the `PUT /users/me/room-display-name` route and its now-unused import)
- Modify: `server/src/middleware/validate.ts` (remove `roomDisplayNameSchema`)
- Modify: `server/src/lib/publicUser.ts` (`publicUserWithAvatar` — drop `roomDisplayName` from its type and return value)
- Modify: `server/src/routes/auth.ts` (remove `roomDisplayName: true,` from the `/me` endpoint's `select`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /auth/me`'s response (via `publicUserWithAvatar`) no longer includes a `roomDisplayName` field at all — Task 2's client code must stop expecting it.

- [ ] **Step 1: Remove `roomDisplayName` from the Prisma schema**

Open `server/prisma/schema.prisma`. Find the `User` model's `roomDisplayName` field (it was added by the `20260821170000_add_user_room_display_name` migration — search the file for `roomDisplayName` to find its exact current line and any doc comment above it). Delete that field declaration (and its doc comment) entirely. Do not touch any other field.

- [ ] **Step 2: Create the DROP COLUMN migration**

Create `server/prisma/migrations/20260821220000_drop_user_room_display_name/migration.sql` with exactly this content:

```sql
-- specs/2026-08-21-nametag-displayname-sync-design.md — removes the
-- separate room-entry nickname concept (specs/2026-08-21-room-entry-
-- name-prompt-design.md, added earlier the same day) entirely. The
-- floating avatar nametag now always follows User.displayName directly;
-- this column's sticky, per-account value was the thing silently
-- overriding displayName after a user's first login, which is exactly the
-- "nametag doesn't sync with Display Name" bug this removal fixes. No data
-- worth preserving — confirmed with the user — so this is a straight drop,
-- not a deprecation.

ALTER TABLE "User" DROP COLUMN "roomDisplayName";
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate --schema=server/prisma/schema.prisma`

Expected: `✔ Generated Prisma Client` with no errors. As with this session's other migrations, this does not apply the migration to any database (no live local Postgres in this environment) — the SQL above is hand-verified by reading it against the schema, and applies automatically on deploy via `deploy/deploy.sh`'s `prisma migrate deploy` step.

- [ ] **Step 4: Remove the `PUT /users/me/room-display-name` route from `rooms.ts`**

Open `server/src/routes/rooms.ts`. Find this import line (currently line 21):

```ts
import { validate, createRoomSchema, renameRoomSchema, avatarUpdateSchema, roomDisplayNameSchema } from '../middleware/validate';
```

Replace it with (removes `roomDisplayNameSchema` only — every other imported name is unchanged):

```ts
import { validate, createRoomSchema, renameRoomSchema, avatarUpdateSchema } from '../middleware/validate';
```

Find this whole route block (currently lines 886-906, right after the `PUT /users/me/avatar` route):

```ts
// PUT /api/users/me/room-display-name —
// specs/2026-08-21-room-entry-name-prompt-design.md. Deliberately its OWN
// route, not folded into PUT /users/me/avatar above: that route
// intentionally also writes displayName when its own `name` field is
// non-empty (see its comment) — reusing it here would silently rename the
// account's real display name (and desync it from Lark's own SSO sync)
// every time someone just changes their in-room nametag. This route
// writes roomDisplayName and NOTHING else.
rooms.put('/users/me/room-display-name', authenticateToken, validate(roomDisplayNameSchema), async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    await prisma.user.update({
      where: { id: req.userId },
      data: { roomDisplayName: req.body.name },
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[rooms] room display name save error:', err);
    return res.status(500).json({ error: 'Failed to save room display name' });
  }
});
```

Delete the entire block, comment included. The `PUT /users/me/avatar` route right above it (lines 864-884) is unchanged — leave it exactly as-is.

- [ ] **Step 5: Remove `roomDisplayNameSchema` from `validate.ts`**

Open `server/src/middleware/validate.ts`. Find `roomDisplayNameSchema` (search the file — it's defined with a doc comment right above it explaining the whitespace-trimming note). Delete the doc comment and the schema declaration entirely:

```ts
export const roomDisplayNameSchema = z.object({
  name: z.string().min(1).max(20),
});
```

- [ ] **Step 6: Remove `roomDisplayName` from `publicUser.ts`**

Open `server/src/lib/publicUser.ts`. Find this function (currently lines 26-28):

```ts
export function publicUserWithAvatar(user: PublicUserFields & Pick<User, 'avatarConfig' | 'roomDisplayName'>) {
  return { ...publicUser(user), avatarConfig: user.avatarConfig, roomDisplayName: user.roomDisplayName };
}
```

Replace it with:

```ts
export function publicUserWithAvatar(user: PublicUserFields & Pick<User, 'avatarConfig'>) {
  return { ...publicUser(user), avatarConfig: user.avatarConfig };
}
```

- [ ] **Step 7: Remove `roomDisplayName` from `auth.ts`'s `/me` select**

Open `server/src/routes/auth.ts`. Find the `select` block for the `/me` endpoint (search for `roomDisplayName: true,` — it's currently on its own line, right after `avatarConfig: true, preferences: true,`). Delete just that one line (`roomDisplayName: true,`) — every other field in that `select` block is unchanged.

- [ ] **Step 8: Typecheck the server workspace**

Run: `npm run typecheck --workspace=server`

Expected: no errors. Slow on this machine (3-5+ minutes) — wait for it, don't cut it short.

- [ ] **Step 9: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/20260821220000_drop_user_room_display_name server/src/routes/rooms.ts server/src/middleware/validate.ts server/src/lib/publicUser.ts server/src/routes/auth.ts
git commit -m "feat: remove the separate room-entry nickname field — nametag now always follows displayName"
```

---

### Task 2: Client — remove the name-prompt flow, seed the nametag from `displayName`

**Files:**
- Delete: `client/src/components/ui/NameModal.tsx`
- Modify: `client/src/services/api.ts` (remove `saveRoomDisplayName` and `roomDisplayName` from `UserProfile`)
- Modify: `client/src/App.tsx` (remove the `NameModal` import, the `roomNameConfirmedFor` state, the `NameModal` render gate, `handleNameSubmit`; rewrite the `playerName` seeding effect)

**Interfaces:**
- Consumes: Task 1's server changes (no more `roomDisplayName` field in `GET /auth/me`'s response, no more `PUT /users/me/room-display-name` route).
- Produces: nothing new for later tasks — this is the final task in this plan.

- [ ] **Step 1: Delete `NameModal.tsx`**

Delete the file `client/src/components/ui/NameModal.tsx` entirely. (Confirm before deleting that its only importer is `App.tsx` — grep the client tree for `NameModal` to double check nothing else references it.)

- [ ] **Step 2: Remove `saveRoomDisplayName` and `roomDisplayName` from `api.ts`**

Open `client/src/services/api.ts`. Find the `UserProfile` interface's `roomDisplayName` field (currently lines 252-255):

```ts
  // specs/2026-08-21-room-entry-name-prompt-design.md — the account's
  // last-used room-entry nametag. Separate from displayName; only ever
  // read as a pre-fill default, never shown anywhere by itself.
  roomDisplayName?: string | null;
```

Delete these 4 lines entirely (the comment and the field). Every other field in `UserProfile` is unchanged.

Find the `saveRoomDisplayName` function (currently lines 623-631):

```ts
  // specs/2026-08-21-room-entry-name-prompt-design.md — separate endpoint
  // from saveAvatar above on purpose: saveAvatar's route also renames the
  // account's real displayName when its own `name` field is non-empty,
  // which must never happen just from changing an in-room nametag.
  saveRoomDisplayName: (name: string) =>
    request<{ success: boolean }>('/users/me/room-display-name', {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),
```

Delete this entire block (comment and function). The `saveAvatar` function right above it is unchanged — leave it exactly as-is.

- [ ] **Step 3: Remove the `NameModal` import from `App.tsx`**

Open `client/src/App.tsx`. Find this import line:

```ts
import { NameModal } from './components/ui/NameModal';
```

Delete it entirely.

- [ ] **Step 4: Remove `roomNameConfirmedFor` state and simplify the account-switch reset effect**

Find this block (currently lines 3046-3078):

```ts
  const [playerName, setPlayerName] = useState<string | null>(null);
  // specs/2026-08-21-room-entry-name-prompt-design.md — which roomSlug the
  // CURRENT playerName was confirmed for. null until the modal is first
  // submitted. Compared against the live roomSlug below: `<Game
  // key={roomSlug}>` already remounts on every new room entry (lobby->room
  // AND portal travel), so re-showing the modal whenever roomSlug !==
  // roomNameConfirmedFor gives "every room entry" for free, with no new
  // wiring into useSocket.ts's reconnect path (reconnects don't change
  // roomSlug, so they never touch this).
  const [roomNameConfirmedFor, setRoomNameConfirmedFor] = useState<string | null>(null);
  const [showAvatarSetup, setShowAvatarSetup] = useState(false);
  const [isRoomReady, setIsRoomReady] = useState(false);
  const setRoomState = useGameStore((s) => s.setRoomState);
  const setLocalPlayer = useGameStore((s) => s.setLocalPlayer);

  // specs/2026-08-21-room-entry-name-prompt-design.md — final-review fix:
  // logout() (useAuth.ts) doesn't reload the page, so this component never
  // unmounts across a same-tab account switch — without this, a second
  // user logging in after a first would inherit the first user's
  // playerName/roomNameConfirmedFor untouched (the seeding effect below
  // only fires when playerName is still null, which it never is after the
  // first login), silently entering rooms under the PREVIOUS user's
  // chosen name with no prompt at all.
  const prevUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (user && user.id !== prevUserIdRef.current) {
      prevUserIdRef.current = user.id;
      setPlayerName(null);
      setRoomNameConfirmedFor(null);
    } else if (!user) {
      prevUserIdRef.current = null;
    }
  }, [user]);
```

Replace it with:

```ts
  const [playerName, setPlayerName] = useState<string | null>(null);
  const [showAvatarSetup, setShowAvatarSetup] = useState(false);
  const [isRoomReady, setIsRoomReady] = useState(false);
  const setRoomState = useGameStore((s) => s.setRoomState);
  const setLocalPlayer = useGameStore((s) => s.setLocalPlayer);

  // specs/2026-08-21-nametag-displayname-sync-design.md — logout()
  // (useAuth.ts) doesn't reload the page, so this component never unmounts
  // across a same-tab account switch — without this, a second user logging
  // in after a first would inherit the first user's playerName untouched
  // (the seeding effect below only fires when playerName is still null,
  // which it never is after the first login), silently entering rooms
  // under the PREVIOUS account's name.
  const prevUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (user && user.id !== prevUserIdRef.current) {
      prevUserIdRef.current = user.id;
      setPlayerName(null);
    } else if (!user) {
      prevUserIdRef.current = null;
    }
  }, [user]);
```

- [ ] **Step 5: Rewrite the `playerName` seeding effect**

Find this effect (currently lines 3084-3105):

```ts
  // If authenticated, use user's displayName and avatarConfig. New accounts
  // have no avatarConfig saved yet (null from the DB) — fall back to
  // loadAvatarConfig()'s defaults (sprite mode etc.) instead of leaving it
  // undefined, which would silently drop back to the legacy shape avatar.
  useEffect(() => {
    // specs/2026-08-21-room-entry-name-prompt-design.md — guarded on
    // playerName still being null so this only ever seeds ONCE per login,
    // not every time the `user` object gets a new reference (e.g.
    // markTutorialSeen/updatePreferences below both call setUser with a
    // fresh object for an unrelated field). Without the guard, any such
    // unrelated update mid-session would silently overwrite whatever name
    // the user had just confirmed for their CURRENT room with the
    // account's login-time default — a local-only visual glitch (this
    // effect only touches the Zustand store, not the server-authoritative
    // JOIN_ROOM name), but a confusing one.
    if (user && playerName === null) {
      const config = user.avatarConfig || loadAvatarConfig();
      const initialName = user.roomDisplayName || user.displayName;
      setPlayerName(initialName);
      setLocalPlayer({
        name: initialName,
        color: config.color,
        avatarConfig: config,
      });
    }
  }, [user, setLocalPlayer, playerName]);
```

Replace it with:

```ts
  // If authenticated, use user's displayName and avatarConfig. New accounts
  // have no avatarConfig saved yet (null from the DB) — fall back to
  // loadAvatarConfig()'s defaults (sprite mode etc.) instead of leaving it
  // undefined, which would silently drop back to the legacy shape avatar.
  useEffect(() => {
    // specs/2026-08-21-nametag-displayname-sync-design.md — guarded on
    // playerName still being null so this only ever seeds ONCE per login,
    // not every time the `user` object gets a new reference (e.g.
    // markTutorialSeen/updatePreferences below both call setUser with a
    // fresh object for an unrelated field). The nametag always follows
    // user.displayName directly now — no separate room-entry nickname to
    // fall back to (removed; see specs/2026-08-21-room-entry-name-prompt-
    // design.md, the feature that originally added it).
    if (user && playerName === null) {
      const config = user.avatarConfig || loadAvatarConfig();
      setPlayerName(user.displayName);
      setLocalPlayer({
        name: user.displayName,
        color: config.color,
        avatarConfig: config,
      });
      // specs/2026-08-21-room-entry-name-prompt-design.md originally
      // triggered Avatar Setup from inside the now-removed name-prompt's
      // submit handler, guarded on `savedConfig.bodyShape &&
      // savedConfig.name` (both being set meant "already fully onboarded").
      // The `name` half of that check no longer means anything distinct
      // now that there's no separate name-collection step — bodyShape
      // alone is the real signal of "has this account ever completed
      // avatar customization."
      if (!config.bodyShape) {
        setShowAvatarSetup(true);
      }
    }
  }, [user, setLocalPlayer, playerName]);
```

- [ ] **Step 6: Delete `handleNameSubmit`**

Find this callback (currently lines 3121-3139):

```ts
  const handleNameSubmit = useCallback((name: string) => {
    setPlayerName(name);
    // specs/2026-08-21-room-entry-name-prompt-design.md — marks THIS room
    // as confirmed so the gate below (Step 5) stops showing the modal for
    // it; persists the name server-side as the new default for whichever
    // room is entered next (fire-and-forget — a save failure must never
    // block entering the room, same posture as persistAvatar elsewhere in
    // this file).
    setRoomNameConfirmedFor(roomSlug);
    api.saveRoomDisplayName(name).catch(() => {});
    const savedConfig = loadAvatarConfig();
    if (savedConfig.bodyShape && savedConfig.name) {
      savedConfig.name = name;
      saveAvatarConfig(savedConfig);
      setLocalPlayer({ name, color: savedConfig.color, avatarConfig: savedConfig });
    } else {
      setShowAvatarSetup(true);
    }
  }, [setLocalPlayer, roomSlug]);
```

Delete it entirely. The `handleAvatarSave` callback right after it (currently lines 3141-3146) is unchanged — leave it exactly as-is:

```ts
  const handleAvatarSave = useCallback((config: AvatarConfig) => {
    saveAvatarConfig(config);
    setLocalPlayer({ name: config.name, color: config.color, avatarConfig: config });
    setShowAvatarSetup(false);
    persistAvatar(config);
  }, [setLocalPlayer, persistAvatar]);
```

- [ ] **Step 7: Remove the `NameModal` render gate and its `roomNameConfirmedFor` reference in `onLeave`**

Find this block (currently lines 3282-3288):

```ts
  // Room — specs/2026-08-21-room-entry-name-prompt-design.md: shows once
  // per NEW roomSlug (fresh entry from Lobby, or portal travel — both
  // already remount <Game key={roomSlug}> below), never on a reconnect
  // within the same room visit (reconnects don't change roomSlug).
  if (roomSlug !== roomNameConfirmedFor) {
    return <NameModal initialName={playerName || user.displayName} onSubmit={handleNameSubmit} />;
  }

  if (showAvatarSetup) {
```

Replace it with (deletes the whole `roomSlug !== roomNameConfirmedFor` gate and its comment; the `if (showAvatarSetup)` line and everything after it is unchanged):

```ts
  if (showAvatarSetup) {
```

Find the `<Game .../>` call site at the end of this same render function (it currently reads, all on one line):

```tsx
  return <Game key={roomSlug} roomSlug={roomSlug} onLeave={() => { setRoomSlug(null); setRoomNameConfirmedFor(null); }} onLogout={logout} onPortalTravel={setRoomSlug} authDisplayName={playerName || user.displayName} authUserId={user.id} currentUser={toCurrentUser(user)} theme={theme} onToggleTheme={toggleTheme} onUpdatePreferences={updatePreferences} />;
```

Replace only the `onLeave` prop's body — remove the now-nonexistent `setRoomNameConfirmedFor(null)` call, keep everything else on the line exactly as-is:

```tsx
  return <Game key={roomSlug} roomSlug={roomSlug} onLeave={() => { setRoomSlug(null); }} onLogout={logout} onPortalTravel={setRoomSlug} authDisplayName={playerName || user.displayName} authUserId={user.id} currentUser={toCurrentUser(user)} theme={theme} onToggleTheme={toggleTheme} onUpdatePreferences={updatePreferences} />;
```

- [ ] **Step 8: Typecheck the client workspace**

Run: `npm run typecheck --workspace=client`

Expected: no errors. Slow (3-5+ minutes) — wait for it. If TypeScript reports `roomDisplayName` or `NameModal` or `roomNameConfirmedFor` as unresolved/unused anywhere, you missed a reference — grep the whole `client/src` tree for those three names and resolve every remaining hit before proceeding.

- [ ] **Step 9: Typecheck the server workspace (confirms nothing else broke)**

Run: `npm run typecheck --workspace=server`

Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add client/src/services/api.ts client/src/App.tsx
git rm client/src/components/ui/NameModal.tsx
git commit -m "feat: remove the room-entry name prompt — nametag now seeds directly from displayName"
```

---

## Final Verification

- [ ] `npm run typecheck --workspace=server` passes.
- [ ] `npm run typecheck --workspace=client` passes.
- [ ] `git log --oneline -2` shows exactly the 2 commits from Tasks 1-2, in order.
- [ ] Grep the whole repo (`server/src`, `client/src`, `server/prisma/schema.prisma`) for `roomDisplayName` — the ONLY remaining matches should be inside the OLD migration file (`20260821170000_add_user_room_display_name/migration.sql`, which is never edited) and the NEW drop migration's own SQL/comment. Zero matches anywhere else.
- [ ] Grep for `NameModal` and `roomNameConfirmedFor` — zero matches anywhere in `client/src`.
- [ ] Confirm `client/src/components/ui/NameModal.tsx` no longer exists.

## Manual Testing After Deploy

1. **The actual bug, fixed:** edit Display Name via the Avatar Editor, save, log out, log back in — the floating nametag shows the NEW name (previously it would have reverted to whatever was in `roomDisplayName`).
2. **Live update still works:** edit Display Name via the Avatar Editor while already in a room — the nametag updates immediately (locally and for other connected clients), same as before.
3. **No more room-entry prompt:** enter a room (fresh from Lobby, or via portal travel) — no "Enter your display name" popup appears at all; the room loads straight through (past the tutorial/status-pick gates, which are unaffected).
4. **First-time Avatar Setup still triggers:** a brand-new account (or any account with no `bodyShape` ever configured) is taken to the Avatar Setup screen on their first room entry — confirm this still happens, since its old trigger path was removed and replaced.
5. **Returning users skip Avatar Setup:** an account that has already completed Avatar Setup once does NOT see it again on a later login/room entry.
6. **Guests unaffected:** `GuestEntry`'s flow is completely unchanged — a guest is never shown anything from this plan's changes.
7. **Chat/participant list unaffected:** both already showed `displayName` before this change and continue to.
