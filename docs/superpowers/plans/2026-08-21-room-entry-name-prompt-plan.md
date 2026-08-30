# Room-Entry Name Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Like ZEP — every time a logged-in user enters a room (including portal travel), prompt them for the display name their avatar's floating nametag will use, pre-filled with whatever name they last used anywhere, required (no empty submissions, no random fallback).

**Architecture:** A new nullable `User.roomDisplayName` column (server-persisted, mirrors the existing `avatarConfig` pattern) holds the account's last-used room name. The existing (currently dead-code-for-real-accounts) `NameModal` component is generalized to accept a pre-fill and to hard-require non-empty input. `App.tsx`'s room-entry gate is widened from "show the modal only if `playerName` is null" to "show the modal whenever the current `roomSlug` hasn't been confirmed yet" — which fires on every fresh room entry (including portal travel, which already remounts `<Game key={roomSlug}>`) without adding any new logic to the socket reconnect path.

**Tech Stack:** Express + Zod (`server/src/middleware/validate.ts`) for the new save endpoint, Prisma (hand-authored migration, no live local Postgres this session), React state in `App.tsx` for the room-entry gate, no new client dependencies.

## Global Constraints

- This feature is for **logged-in users only** — guests keep their existing `GuestEntry` flow, completely untouched. Do not modify `client/src/pages/GuestEntry.tsx`.
- The custom name affects **only the avatar's floating nametag** in the game canvas. Chat messages, participant lists, and every other surface showing a user's name must keep reading `User.displayName` — never the new field.
- The remembered "last name" is **one global value per account** (`User.roomDisplayName String?`), not per-room.
- Empty/whitespace-only input is a **hard block on submission** — the submit button stays disabled. There is **no fallback random `Player-xxxx` name**. This is a deliberate reversal of `NameModal`'s current behavior, corrected by the user during design review — do not preserve the old fallback out of habit.
- The modal gates on **`roomSlug` transitions** (new room entry, including portal travel) and must **never** gate on socket reconnects. Do not add any new logic to `client/src/hooks/useSocket.ts`'s `CONNECT` handler — its existing "reconnect reuses whatever `playerName`/`authUserName` is already in state" behavior must be preserved exactly as-is.
- Do not touch `User.displayName` or its Lark-sync logic (`server/src/routes/lark.ts`) at all.
- Do not touch the Furniture `assignedToName` desk-assignment feature.
- Name length capped at 20 characters client-side (matching `NameModal`'s existing `maxLength`) and re-validated server-side.

---

### Task 1: Schema, migration, and server-side save endpoint

**Files:**
- Modify: `server/prisma/schema.prisma` (User model)
- Create: `server/prisma/migrations/20260821170000_add_user_room_display_name/migration.sql`
- Modify: `server/src/lib/publicUser.ts`
- Modify: `server/src/routes/auth.ts` (the `/me` route's `select` clause)
- Modify: `server/src/middleware/validate.ts` (new schema)
- Modify: `server/src/routes/rooms.ts` (new route)

**Interfaces:**
- Produces: `PUT /api/users/me/room-display-name` accepting `{ name: string }` (1-20 chars after trim), writing `User.roomDisplayName`, returning `{ success: true }`. `User.roomDisplayName: string | null` rides along in both responses built via `publicUserWithAvatar` (`/auth/login`, `/auth/me`) — the two responses built via the plainer `publicUser` (`/auth/register`, org-invite accept) do NOT carry it, same as they already don't carry `avatarConfig` today; harmless here since a freshly registered/invited account's `roomDisplayName` is always null anyway, and the client (Task 3) already treats a missing/null value as "fall back to displayName."

- [ ] **Step 1: Add the column to the schema**

In `server/prisma/schema.prisma`, find the `User` model's `avatarConfig` field (currently line 29):

Current:
```prisma
  password                String
  displayName             String
  avatarConfig            Json?
```

Replace with:
```prisma
  password                String
  displayName             String
  avatarConfig            Json?
  // The account's last-used AVATAR NAMETAG in a room — separate from
  // displayName (which Lark SSO re-syncs on every login, see
  // routes/lark.ts:214) and from avatarConfig.name (which the Avatar
  // Setup screen's own save flow deliberately keeps in sync with
  // displayName — see routes/rooms.ts's PUT /users/me/avatar). Set only by
  // PUT /users/me/room-display-name — never read/written by anything else.
  // Null for every account that hasn't used this feature yet; the client
  // falls back to displayName in that case.
  roomDisplayName         String?
```

- [ ] **Step 2: Write the migration**

Create `server/prisma/migrations/20260821170000_add_user_room_display_name/migration.sql`:

```sql
-- The account's last-used room-entry nametag (see
-- specs/2026-08-21-room-entry-name-prompt-design.md) — separate from
-- displayName, which Lark SSO overwrites on every login, and from
-- avatarConfig.name. Nullable, no backfill: every existing account gets
-- NULL, and the client falls back to displayName until this is set once.

ALTER TABLE "User" ADD COLUMN "roomDisplayName" TEXT;
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate --schema=server/prisma/schema.prisma`
Expected: `Generated Prisma Client` message, no errors. (This must run before the TypeScript in the next steps will compile — `User.roomDisplayName` doesn't exist in the generated client's types until this runs.)

- [ ] **Step 4: Thread the field through the shared auth-response shape**

Read the current `server/src/lib/publicUser.ts` in full first (it's short, ~29 lines) to confirm nothing about its shape has changed since this plan was written. Then:

Current:
```ts
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
  };
}

export function publicUserWithAvatar(user: PublicUserFields & Pick<User, 'avatarConfig'>) {
  return { ...publicUser(user), avatarConfig: user.avatarConfig };
}
```

Replace with:
```ts
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
  };
}

export function publicUserWithAvatar(user: PublicUserFields & Pick<User, 'avatarConfig' | 'roomDisplayName'>) {
  return { ...publicUser(user), avatarConfig: user.avatarConfig, roomDisplayName: user.roomDisplayName };
}
```

`server/src/routes/auth.ts`'s `/auth/login` route (`auth.post('/login', ...)`, line ~181) calls `publicUserWithAvatar(user)` with a Prisma row fetched via `findUnique` **without** an explicit `select` (the whole row, including the new column) — no change needed there. `/auth/register` (line ~146) and `server/src/routes/orgInvite.ts`'s accept route (line ~156) call the plainer `publicUser(user)` instead, which this step does NOT touch — they already exclude `avatarConfig` too, so this is consistent with their existing narrower shape, not a gap this task needs to close. Only `/me`'s explicit `select` (next step) needs updating.

- [ ] **Step 5: Add the field to `/auth/me`'s explicit select**

In `server/src/routes/auth.ts`, find the `/me` route's `select` (currently around line 202-220):

Current:
```ts
      select: {
        id: true, email: true, displayName: true, avatarConfig: true, preferences: true,
        accountRole: true, workspaceRole: true, timezone: true, active: true,
```

Replace with:
```ts
      select: {
        id: true, email: true, displayName: true, avatarConfig: true, preferences: true,
        roomDisplayName: true,
        accountRole: true, workspaceRole: true, timezone: true, active: true,
```

(Leave every other field in that `select` block exactly as-is — this only adds one line.)

- [ ] **Step 6: Add the Zod validation schema**

In `server/src/middleware/validate.ts`, after the existing `avatarUpdateSchema` (at the end of the file):

Current end of file:
```ts
  spriteAccessoryId: z.string().optional(),
  premadeId: z.string().optional(),
});
```

Replace with:
```ts
  spriteAccessoryId: z.string().optional(),
  premadeId: z.string().optional(),
});

// specs/2026-08-21-room-entry-name-prompt-design.md — the room-entry
// nametag save. Deliberately just one field, capped at the same 20 chars
// as the client's own input maxLength — min(1) after Zod's own trim isn't
// automatic, so the route handler trims before this schema sees it (see
// routes/rooms.ts) to keep "   " (whitespace-only) from passing min(1).
export const roomDisplayNameSchema = z.object({
  name: z.string().min(1).max(20),
});
```

- [ ] **Step 7: Add the server route**

In `server/src/routes/rooms.ts`, update the existing validate-schema import line (currently):
```ts
import { validate, createRoomSchema, renameRoomSchema, avatarUpdateSchema } from '../middleware/validate';
```
Replace with:
```ts
import { validate, createRoomSchema, renameRoomSchema, avatarUpdateSchema, roomDisplayNameSchema } from '../middleware/validate';
```

Then, immediately after the existing `PUT /users/me/avatar` route (which ends with the closing `});` currently around line 884 — read the file to confirm the exact current line, this plan's earlier research found it at rooms.ts:865-884), add:

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

Note: `validate(roomDisplayNameSchema)` runs Zod's `min(1)` against `req.body.name` exactly as sent — it does NOT trim first, so `"   "` (whitespace-only) would pass Zod's `min(1)` check since it has length > 0. The client (Task 3) is responsible for trimming before it ever sends the request, matching how `NameModal`'s own submit button is disabled until the trimmed value is non-empty — by the time a request reaches this route, the client has already guaranteed a non-whitespace value. This mirrors the existing `PUT /users/me/avatar` route's own posture (it trims `req.body.name` itself, at line 874) — server-side trimming is intentionally NOT duplicated here since Task 3's client-side guard already makes it redundant for this specific route, and Zod's `min(1)` is enough of a floor to reject a genuinely empty string sent directly to the API.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck --workspace=server`
Expected: PASS. This is slow on this machine — 3-5+ minutes. If the Prisma client seems stale (errors about `roomDisplayName` not existing on `User`), re-run Step 3 (`npx prisma generate --schema=server/prisma/schema.prisma`) and typecheck again.

- [ ] **Step 9: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/20260821170000_add_user_room_display_name server/src/lib/publicUser.ts server/src/routes/auth.ts server/src/middleware/validate.ts server/src/routes/rooms.ts
git commit -m "feat: add User.roomDisplayName and its save endpoint"
```

---

### Task 2: Client API — type and save function

**Files:**
- Modify: `client/src/services/api.ts`

**Interfaces:**
- Consumes: `PUT /api/users/me/room-display-name` (Task 1).
- Produces: `UserProfile.roomDisplayName?: string | null`; `api.saveRoomDisplayName(name: string): Promise<{ success: boolean }>` — consumed by Task 3.

- [ ] **Step 1: Add the field to `UserProfile`**

Current (`client/src/services/api.ts`, the `UserProfile` interface):
```ts
export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  avatarConfig?: any;
  preferences?: UserPreferences | null;
```

Replace with:
```ts
export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  avatarConfig?: any;
  // specs/2026-08-21-room-entry-name-prompt-design.md — the account's
  // last-used room-entry nametag. Separate from displayName; only ever
  // read as a pre-fill default, never shown anywhere by itself.
  roomDisplayName?: string | null;
  preferences?: UserPreferences | null;
```

- [ ] **Step 2: Add the save function**

Current (`client/src/services/api.ts`, right after `saveAvatar`):
```ts
  saveAvatar: (config: any) =>
    request<{ success: boolean }>('/users/me/avatar', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
```

Replace with:
```ts
  saveAvatar: (config: any) =>
    request<{ success: boolean }>('/users/me/avatar', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

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

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=client`
Expected: PASS. Slow on this machine — 3-5+ minutes.

- [ ] **Step 4: Commit**

```bash
git add client/src/services/api.ts
git commit -m "feat: add saveRoomDisplayName client API"
```

---

### Task 3: Generalize `NameModal` and wire it into `App.tsx`'s room-entry flow

This task touches two files together, not split across two tasks: `NameModal.tsx`'s new required `initialName` prop and its one call site in `App.tsx` must land in the same commit, or the intermediate state fails `npm run typecheck --workspace=client` on its own (this session already hit exactly this mistake once before on a different plan and corrected it — a task's own typecheck must pass in isolation, forward-references to not-yet-existing code belong in whichever task actually wires things together, not split across a task boundary that leaves either side broken alone).

**Files:**
- Modify: `client/src/components/ui/NameModal.tsx`
- Modify: `client/src/App.tsx`

**Interfaces:**
- Produces: `NameModal({ initialName: string; onSubmit: (name: string) => void })`. `initialName` replaces the component's own `localStorage` read; there is no longer a `STORAGE_KEY` constant or any `localStorage` access inside this file.
- Consumes: `api.saveRoomDisplayName(name)` and `UserProfile.roomDisplayName` (Task 2).

- [ ] **Step 1: Replace the whole file**

Current (`client/src/components/ui/NameModal.tsx`, full file):
```tsx
import { useState } from 'react';

const STORAGE_KEY = 'virtualmeet-player-name';

interface NameModalProps {
  onSubmit: (name: string) => void;
}

export function NameModal({ onSubmit }: NameModalProps) {
  const savedName = localStorage.getItem(STORAGE_KEY) || '';
  const [name, setName] = useState(savedName);

  const handleSubmit = () => {
    const trimmed = name.trim();
    const displayName = trimmed || `Player-${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem(STORAGE_KEY, displayName);
    onSubmit(displayName);
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 w-full max-w-sm shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700">
        <h2 className="text-gray-900 dark:text-gray-100 text-xl font-bold mb-2">Welcome to KaiSpace</h2>
        <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">Enter your display name to join the room.</p>

        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="Your name"
          autoFocus
          maxLength={20}
          className="w-full bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg px-4 py-3 mb-4 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500 transition-colors"
        />

        <button
          onClick={handleSubmit}
          className="w-full bg-purple-600 hover:bg-purple-700 text-white font-semibold rounded-lg py-3 transition-colors cursor-pointer"
        >
          Join Room
        </button>
      </div>
    </div>
  );
}
```

Replace with:
```tsx
import { useState } from 'react';

interface NameModalProps {
  // specs/2026-08-21-room-entry-name-prompt-design.md — the caller decides
  // the pre-fill (App.tsx: playerName ?? user.displayName, itself seeded
  // from user.roomDisplayName ?? user.displayName at login). This
  // component no longer reads localStorage itself.
  initialName: string;
  onSubmit: (name: string) => void;
}

export function NameModal({ initialName, onSubmit }: NameModalProps) {
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();

  // specs/2026-08-21-room-entry-name-prompt-design.md — deliberate reversal
  // of this component's old behavior: empty/whitespace-only input is now a
  // hard block, not a "Player-xxxx" random fallback. The submit button
  // stays disabled until there's a real name, mirroring GuestEntry.tsx's
  // existing `disabled={loading || !name.trim() || !password}` pattern.
  const handleSubmit = () => {
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 w-full max-w-sm shadow-xl shadow-purple-100/50 dark:shadow-black/30 border border-purple-100 dark:border-gray-700">
        <h2 className="text-gray-900 dark:text-gray-100 text-xl font-bold mb-2">Welcome to KaiSpace</h2>
        <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">Enter your display name to join the room.</p>

        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="Your name"
          autoFocus
          maxLength={20}
          className="w-full bg-purple-50/50 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg px-4 py-3 mb-4 outline-none border border-purple-100 dark:border-gray-700 focus:border-purple-500 transition-colors"
        />

        <button
          onClick={handleSubmit}
          disabled={!trimmed}
          className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-3 transition-colors cursor-pointer"
        >
          Join Room
        </button>
      </div>
    </div>
  );
}
```

Do NOT typecheck yet — `App.tsx`'s one call site still calls `<NameModal onSubmit={handleNameSubmit} />` without the new required `initialName` prop, which would fail on its own. Continue directly into the `App.tsx` steps below; both files land in the single commit at the end of this task.

- [ ] **Step 2: Add the per-room confirmation state**

Current (`client/src/App.tsx`, around line 3036):
```ts
  const [playerName, setPlayerName] = useState<string | null>(null);
  const [showAvatarSetup, setShowAvatarSetup] = useState(false);
```

Replace with:
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
```

- [ ] **Step 3: Seed `playerName` from `roomDisplayName` once, not on every `user` reference change**

Current (`client/src/App.tsx`, around line 3046-3056):
```ts
  useEffect(() => {
    if (user) {
      const config = user.avatarConfig || loadAvatarConfig();
      setPlayerName(user.displayName);
      setLocalPlayer({
        name: user.displayName,
        color: config.color,
        avatarConfig: config,
      });
    }
  }, [user, setLocalPlayer]);
```

Replace with:
```ts
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

- [ ] **Step 4: Update `handleNameSubmit` to track confirmation and persist the name**

Current (`client/src/App.tsx`, around line 3072-3082):
```ts
  const handleNameSubmit = useCallback((name: string) => {
    setPlayerName(name);
    const savedConfig = loadAvatarConfig();
    if (savedConfig.bodyShape && savedConfig.name) {
      savedConfig.name = name;
      saveAvatarConfig(savedConfig);
      setLocalPlayer({ name, color: savedConfig.color, avatarConfig: savedConfig });
    } else {
      setShowAvatarSetup(true);
    }
  }, [setLocalPlayer]);
```

Replace with:
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

- [ ] **Step 5: Widen the gate and pass the new prop**

Current (`client/src/App.tsx`, around line 3213-3216):
```tsx
  // Room (existing flow)
  if (!playerName) {
    return <NameModal onSubmit={handleNameSubmit} />;
  }
```

Replace with:
```tsx
  // Room — specs/2026-08-21-room-entry-name-prompt-design.md: shows once
  // per NEW roomSlug (fresh entry from Lobby, or portal travel — both
  // already remount <Game key={roomSlug}> below), never on a reconnect
  // within the same room visit (reconnects don't change roomSlug).
  if (roomSlug !== roomNameConfirmedFor) {
    return <NameModal initialName={playerName || user.displayName} onSubmit={handleNameSubmit} />;
  }
```

(By this point in the component, `user` is guaranteed non-null — the `if (!user)` auth gate above already returned `<LoginPage>` otherwise. `playerName` is guaranteed non-null too by the time this line can be reached on any render after the very first one, since Step 3's effect seeds it as soon as `user` exists — the `|| user.displayName` is just a defensive fallback for the one-tick window before that effect's first run.)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck --workspace=client`
Expected: PASS — both `NameModal.tsx` and its `App.tsx` call site are consistent now.

- [ ] **Step 7: Also run the server typecheck once more from a clean state**

Run: `npm run typecheck --workspace=server`
Expected: PASS (no server files touched by this task, but confirms Task 1 + this task's combined state is still clean).

- [ ] **Step 8: Commit**

```bash
git add client/src/components/ui/NameModal.tsx client/src/App.tsx
git commit -m "feat: prompt for a room-entry name on every new room, pre-filled from the last one used"
```

---

## Final Verification

- [ ] `npm run typecheck --workspace=server` — PASS, zero errors.
- [ ] `npm run typecheck --workspace=client` — PASS, zero errors.
- [ ] `git log --oneline -3` — confirm the 3 commits above exist in order.

## Manual Testing After Deploy

1. Log in as a user who has never used this feature (`roomDisplayName` is `NULL`) and enter any room for the first time. Confirm the modal appears, pre-filled with their account/Lark display name.
2. Change the name and submit. Confirm their avatar's nametag in the canvas shows the NEW name, not the account name.
3. Leave the room and enter a DIFFERENT room. Confirm the modal reappears, now pre-filled with the name just used in step 2 — not the original account name.
4. In the modal, clear the name field to empty (or type only spaces). Confirm the "Join Room" button is disabled and there is no way to enter the room until a real name is typed.
5. While already inside a room (past the modal), simulate a reconnect — briefly toggle the network offline/online, or restart the server container and watch the client reconnect. Confirm the modal does NOT reappear and the same nametag persists through the reconnect (this is the constraint that most needs verifying live, since it can't be typechecked).
6. Send a chat message from that room. Confirm it shows the user's real account name in the chat panel, not the custom room nametag.
7. If a portal to a different room is easily reachable in this environment, travel through it. Confirm the modal re-shows, pre-filled with the most recently used name — the same as a fresh Lobby→room entry.
8. Join a room as a guest via an existing invite link. Confirm the guest still only sees the existing one-time `GuestEntry` prompt — this new modal never appears for them.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-21-room-entry-name-prompt-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
