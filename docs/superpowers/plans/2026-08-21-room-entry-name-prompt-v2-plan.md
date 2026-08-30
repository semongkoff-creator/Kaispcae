# Room-Entry Name Prompt v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring back the "enter your display name" popup on every room entry, removed earlier today alongside a bug fix — this time it edits `User.displayName` directly (via the already-existing `PUT /users/me/avatar` route) instead of a separate field, so it can never desync from the nametag again.

**Architecture:** Recreate `NameModal.tsx` with its exact prior UI (nothing about the component itself changes). In `App.tsx`, reintroduce `roomNameConfirmedFor` state and a render gate for it — placed AFTER the `showAvatarSetup` gate, so a never-configured account skips straight to Avatar Setup instead of seeing this popup. A new `handleNameSubmit` builds a full avatar config (current config + the new name) and saves it through the existing `api.saveAvatar`, which already writes both `avatarConfig` and `displayName` in one call. No server changes at all — this is a client-only feature.

**Tech Stack:** React/TypeScript. No new dependency.

## Global Constraints

- The popup must submit a FULL merged avatar config (`{...loadAvatarConfig(), name}`), never a name-only payload — `PUT /users/me/avatar` stores whatever it receives as the entire `avatarConfig`, with no server-side merge; a name-only submission would silently erase the user's body/eyes/outfit selections.
- No new server route, no new schema field — reuse `PUT /users/me/avatar` / `api.saveAvatar` exactly as they exist today.
- The popup shows once per new room entry (fresh from Lobby, or portal travel), never on a reconnect within the same room visit — same cadence as the original, pre-removal feature.
- A brand-new account (never configured an avatar) skips this popup entirely and goes straight to Avatar Setup — achieved by gate ordering, not a separate "is this a new user" check.
- Completing Avatar Setup for the first time also marks the current room as name-confirmed, so the popup doesn't immediately reappear right after.
- The Sidebar's separate mid-session "Edit Avatar" flow (`App.tsx`'s OTHER `handleAvatarSave`, inside the `Game` component, around line 1157) is a completely different function in a different component scope — do not touch it.
- Empty/whitespace-only input stays a hard block (disabled submit), no random-name fallback.
- Guests (`GuestEntry.tsx`) are unaffected — this plan touches no guest code.
- `docs/` folder and "SS AN.docx" are ALWAYS excluded from every commit.

---

### Task 1: Recreate `NameModal.tsx`

**Files:**
- Create: `client/src/components/ui/NameModal.tsx`

**Interfaces:**
- Produces: `NameModal({ initialName: string, onSubmit: (name: string) => void })` — a React component. Task 2 imports and renders it.

- [ ] **Step 1: Create the file with this exact content**

```tsx
import { useState } from 'react';

interface NameModalProps {
  // specs/2026-08-21-room-entry-name-prompt-v2-design.md — the caller
  // decides the pre-fill (App.tsx: playerName || user.displayName). This
  // component doesn't read localStorage or call the API itself — submit
  // just hands the trimmed name back to the caller.
  initialName: string;
  onSubmit: (name: string) => void;
}

export function NameModal({ initialName, onSubmit }: NameModalProps) {
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();

  // Empty/whitespace-only input is a hard block, not a random-name
  // fallback — the submit button stays disabled until there's a real
  // name, mirroring GuestEntry.tsx's existing
  // `disabled={loading || !name.trim() || !password}` pattern.
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

- [ ] **Step 2: Typecheck the client workspace**

Run: `npm run typecheck --workspace=client`

Expected: no errors. Slow on this machine (3-5+ minutes) — wait for it, don't cut it short. This step alone won't catch much (the component isn't imported anywhere yet), but confirms the new file itself is syntactically and structurally valid TypeScript/JSX before Task 2 wires it in.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/ui/NameModal.tsx
git commit -m "feat: recreate the room-entry name prompt component"
```

---

### Task 2: Wire the popup into `App.tsx`, submitting through `api.saveAvatar`

**Files:**
- Modify: `client/src/App.tsx`

**Interfaces:**
- Consumes: `NameModal` from Task 1 (`{ initialName: string, onSubmit: (name: string) => void }`).
- Consumes (unchanged, already exist): `loadAvatarConfig()`, `saveAvatarConfig()` (`client/src/hooks/useAvatarConfig.ts`), `api.saveAvatar(config: AvatarConfig)` (`client/src/services/api.ts`), `setLocalPlayer` (Zustand `useGameStore`).
- Produces: nothing new for later tasks — this is the final task in this plan.

- [ ] **Step 1: Import `NameModal`**

Open `client/src/App.tsx`. Find the other component imports near the top of the file (e.g. `import { AvatarSetup } from './components/avatar/AvatarSetup';`). Add, right after it:

```ts
import { NameModal } from './components/ui/NameModal';
```

- [ ] **Step 2: Reintroduce `roomNameConfirmedFor` state**

Find this block (currently lines 3045-3049):

```ts
  const [playerName, setPlayerName] = useState<string | null>(null);
  const [showAvatarSetup, setShowAvatarSetup] = useState(false);
  const [isRoomReady, setIsRoomReady] = useState(false);
  const setRoomState = useGameStore((s) => s.setRoomState);
  const setLocalPlayer = useGameStore((s) => s.setLocalPlayer);
```

Replace it with:

```ts
  const [playerName, setPlayerName] = useState<string | null>(null);
  // specs/2026-08-21-room-entry-name-prompt-v2-design.md — which roomSlug
  // the CURRENT playerName was confirmed for. null until the modal is
  // first submitted for this room. Compared against the live roomSlug
  // below: `<Game key={roomSlug}>` already remounts on every new room
  // entry (lobby->room AND portal travel), so re-showing the modal
  // whenever roomSlug !== roomNameConfirmedFor gives "every room entry"
  // for free, with no new wiring into useSocket.ts's reconnect path
  // (reconnects don't change roomSlug, so they never touch this).
  const [roomNameConfirmedFor, setRoomNameConfirmedFor] = useState<string | null>(null);
  const [showAvatarSetup, setShowAvatarSetup] = useState(false);
  const [isRoomReady, setIsRoomReady] = useState(false);
  const setRoomState = useGameStore((s) => s.setRoomState);
  const setLocalPlayer = useGameStore((s) => s.setLocalPlayer);
```

- [ ] **Step 3: Reset `roomNameConfirmedFor` on account switch**

Find this block (currently lines 3051-3066):

```ts
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

Replace it with:

```ts
  // specs/2026-08-21-room-entry-name-prompt-v2-design.md — logout()
  // (useAuth.ts) doesn't reload the page, so this component never unmounts
  // across a same-tab account switch — without this, a second user logging
  // in after a first would inherit the first user's
  // playerName/roomNameConfirmedFor untouched (the seeding effect below
  // only fires when playerName is still null, which it never is after the
  // first login), silently entering rooms under the PREVIOUS account's
  // name with no prompt at all.
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

- [ ] **Step 4: Add `handleNameSubmit`, right after `handleAvatarSave`**

Find `handleAvatarSave` (currently lines 3117-3122):

```ts
  const handleAvatarSave = useCallback((config: AvatarConfig) => {
    saveAvatarConfig(config);
    setLocalPlayer({ name: config.name, color: config.color, avatarConfig: config });
    setShowAvatarSetup(false);
    persistAvatar(config);
  }, [setLocalPlayer, persistAvatar]);
```

Leave it completely unchanged, and add this new callback right after it:

```ts
  // specs/2026-08-21-room-entry-name-prompt-v2-design.md — unlike the
  // original (removed) version of this flow, there is no separate
  // roomDisplayName field to write: this merges the submitted name into
  // whatever avatar config already exists and saves it through the SAME
  // path AvatarSetup itself uses (api.saveAvatar), which already writes
  // both avatarConfig AND displayName in one call (see rooms.ts's PUT
  // /users/me/avatar). Sending the FULL merged config — not just {name} —
  // is required: that route stores whatever it receives as the entire
  // avatarConfig, with no server-side merge, so a name-only payload would
  // silently erase the user's body/eyes/outfit selections.
  const handleNameSubmit = useCallback((name: string) => {
    const merged = { ...loadAvatarConfig(), name };
    setRoomNameConfirmedFor(roomSlug);
    setPlayerName(name);
    saveAvatarConfig(merged);
    setLocalPlayer({ name, color: merged.color, avatarConfig: merged });
    api.saveAvatar(merged).catch(() => {});
  }, [setLocalPlayer, roomSlug]);
```

- [ ] **Step 5: Mark the room name-confirmed when first-time Avatar Setup completes**

Find `handleAvatarSave` again (same block as Step 4, still unchanged so far):

```ts
  const handleAvatarSave = useCallback((config: AvatarConfig) => {
    saveAvatarConfig(config);
    setLocalPlayer({ name: config.name, color: config.color, avatarConfig: config });
    setShowAvatarSetup(false);
    persistAvatar(config);
  }, [setLocalPlayer, persistAvatar]);
```

Replace it with (adds one line — `setRoomNameConfirmedFor(roomSlug)` — and `roomSlug` to the dependency array; every other line is unchanged):

```ts
  const handleAvatarSave = useCallback((config: AvatarConfig) => {
    saveAvatarConfig(config);
    setLocalPlayer({ name: config.name, color: config.color, avatarConfig: config });
    setShowAvatarSetup(false);
    // specs/2026-08-21-room-entry-name-prompt-v2-design.md — a user who
    // just went through first-time Avatar Setup (which has its own Display
    // Name field, see AvatarSetup.tsx) has already given their name for
    // THIS room entry. Without this, the name-prompt gate below would
    // immediately fire again right after, asking for a name they just gave
    // a moment ago.
    setRoomNameConfirmedFor(roomSlug);
    persistAvatar(config);
  }, [setLocalPlayer, persistAvatar, roomSlug]);
```

- [ ] **Step 6: Add the render gate, after `showAvatarSetup`'s**

Find this block (currently lines 3257-3264):

```ts
  if (showAvatarSetup) {
    return (
      <AvatarSetup
        initialConfig={{ ...loadAvatarConfig(), name: playerName || user.displayName }}
        onSave={handleAvatarSave}
      />
    );
  }

  if (!isRoomReady) {
```

Replace it with (inserts the new gate between the two existing ones; both existing blocks are otherwise unchanged):

```ts
  if (showAvatarSetup) {
    return (
      <AvatarSetup
        initialConfig={{ ...loadAvatarConfig(), name: playerName || user.displayName }}
        onSave={handleAvatarSave}
      />
    );
  }

  // specs/2026-08-21-room-entry-name-prompt-v2-design.md — shows once per
  // NEW roomSlug (fresh entry from Lobby, or portal travel — both already
  // remount <Game key={roomSlug}> below), never on a reconnect within the
  // same room visit (reconnects don't change roomSlug). Placed AFTER the
  // showAvatarSetup check above: a never-configured account goes straight
  // to Avatar Setup (which has its own Display Name field) instead of
  // being asked for a name twice.
  if (roomSlug !== roomNameConfirmedFor) {
    return <NameModal initialName={playerName || user.displayName} onSubmit={handleNameSubmit} />;
  }

  if (!isRoomReady) {
```

- [ ] **Step 7: Typecheck the client workspace**

Run: `npm run typecheck --workspace=client`

Expected: no errors. Slow (3-5+ minutes) — wait for it. If TypeScript complains about `roomSlug` not being in scope inside `handleNameSubmit`'s dependency array or similar, double check you placed these edits inside the same component function that already defines `roomSlug`, `user`, `loadAvatarConfig`, etc. (the same one containing `handleAvatarSave`, `playerName`, and the render `if` chain).

- [ ] **Step 8: Typecheck the server workspace (confirms nothing else broke — this task touches no server files, but this repo's convention runs both)**

Run: `npm run typecheck --workspace=server`

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add client/src/App.tsx
git commit -m "feat: wire the room-entry name prompt to save through the existing avatar endpoint"
```

---

## Final Verification

- [ ] `npm run typecheck --workspace=client` passes.
- [ ] `npm run typecheck --workspace=server` passes.
- [ ] `git log --oneline -2` shows exactly the 2 commits from Tasks 1-2, in order.
- [ ] Grep `client/src` for `roomDisplayName` or `saveRoomDisplayName` — zero matches (this plan must not reintroduce either; it reuses `api.saveAvatar` exclusively).
- [ ] Confirm `client/src/components/ui/NameModal.tsx` exists again.

## Manual Testing After Deploy

1. **Popup reappears:** enter a room (fresh from Lobby) as an account that already has an avatar configured — the "Enter your display name to join the room" popup shows, pre-filled with the current Display Name.
2. **Submit persists correctly, everywhere:** change the name and submit — the nametag on the map, the Participant Panel, and (after a fresh login) the popup's own next pre-fill all show the new name. Confirm appearance (body/eyes/outfit) is UNCHANGED after this submit — this is the specific regression this plan is designed to avoid (a name-only payload silently wiping appearance).
3. **Per-room-entry cadence:** submit the popup for Room A, then travel (portal or Lobby) to Room B — the popup shows again for Room B. Return to Room A in the same session (without a fresh login) — confirm current behavior (the popup reappears again, since `roomNameConfirmedFor` only remembers the MOST RECENT room, matching the original feature's own behavior).
4. **Reconnect doesn't re-trigger:** a brief network drop/reconnect while inside a room does NOT show the popup again (same room, `roomSlug` unchanged).
5. **Brand-new account skips the popup:** an account with no avatar configured yet goes straight to the Avatar Setup screen on room entry — the name popup does NOT show first. After completing Avatar Setup, confirm the popup does NOT immediately show again for that same room entry.
6. **Sidebar's mid-session Avatar Editor unaffected:** editing your avatar via the Sidebar (not at room entry) still works exactly as before — this plan didn't touch that code path.
7. **Empty input blocked:** the submit button stays disabled while the input is empty/whitespace-only; no random fallback name is ever used.
8. **Guests unaffected:** `GuestEntry`'s flow is completely unchanged.
