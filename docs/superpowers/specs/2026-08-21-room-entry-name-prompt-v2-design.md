# Room-Entry Name Prompt v2 — Design

## Goal

Bring back the "enter your display name" popup shown on every room entry — removed earlier today as part of fixing the nametag/Display Name sync bug — but this time it edits the account's real `displayName` directly, so it can never desync again. The floating nametag, the Participant Panel, and this popup all end up reading the exact same value, always.

## Context

Earlier today, `docs/superpowers/specs/2026-08-21-nametag-displayname-sync-design.md` removed the original "Room-Entry Name Prompt" feature (`docs/superpowers/specs/2026-08-21-room-entry-name-prompt-design.md`) entirely, because it stored its value in a separate `User.roomDisplayName` field that permanently overrode `displayName` after being set once — the actual root cause of the reported "nametag ga sinkron" bug. That removal is correct and stays; this design reintroduces the *popup*, not the separate field.

Direct codebase checks (current state, re-read this session):
- `client/src/components/ui/NameModal.tsx` was deleted (commit `702dca4`) — its prior implementation (recovered from git history) is a simple, already-reviewed modal: text input pre-filled with an `initialName` prop, `maxLength=20`, Enter-to-submit, submit disabled while the trimmed value is empty, no random-name fallback. This design reuses that exact UI as-is — only what happens on submit changes.
- `server/src/routes/rooms.ts`'s `PUT /users/me/avatar` (unchanged all day) already does exactly what's needed: `prisma.user.update({ data: newName ? { avatarConfig: req.body, displayName: newName } : { avatarConfig: req.body } })` — sending a `name` field alongside a full avatar config writes both `avatarConfig` and `displayName` in one call. `client/src/services/api.ts`'s `saveAvatar(config)` already calls this route.
- **Critical detail confirmed by reading `avatarUpdateSchema`** (`server/src/middleware/validate.ts:43-64`): every field is `.optional()`, and the route stores `avatarConfig: req.body` verbatim — no server-side merge. A doc comment on that schema already warns about exactly this failure mode ("Bug 2's persist-on-rename fix... a pixel-avatar player's rename would save fine, but their body/eyes/outfit/hair sprite picks would vanish from the PERSISTED config"). This means the reintroduced popup MUST submit a full merged config (`{...loadAvatarConfig(), name: submitted}`), never a name-only payload, or it will silently wipe the user's avatar appearance.
- `AvatarSetup.tsx`'s own save handler (`handleSave`, line 155-159) confirms the established pattern: it always sends the full `config` object, never a partial one.
- `AvatarSetup` has two independent call sites with two independent `handleAvatarSave` functions in different component scopes: one inside `Game` (`App.tsx:1157-1180`, reached via the Sidebar's "Edit Avatar" button, mid-session) and one in the outer wrapper component (`App.tsx:3117-3122`, the first-time-onboarding path). They do not share state — a change to the onboarding one cannot affect the Sidebar-triggered one.
- The `showAvatarSetup` trigger (`if (!config.bodyShape) setShowAvatarSetup(true)`, inside the `playerName`-seeding effect) is unrelated to and unaffected by this design — it stays exactly as today's earlier fix left it.

## Scope (confirmed with user)

- The popup reappears with the same cadence as the original feature: once per new room entry (fresh from Lobby, or portal travel — both remount `<Game key={roomSlug}>`), never on a reconnect within the same room visit.
- It edits `User.displayName` directly via the existing `PUT /users/me/avatar` route — no new field, no new route.
- A brand-new user who has never configured an avatar skips this popup entirely and goes straight to the full Avatar Setup screen (which already has its own Display Name field) — the popup is only for users who already have an avatar configured.
- Confirmed: the Participant Panel already reads `User.displayName` directly (established in the original room-entry-name-prompt design's own explicit scope) — once the nametag and this popup both consistently read/write the same `displayName`, all three surfaces (nametag, popup, participant list) necessarily stay in sync with no further work needed there.

## Design

### Components

- **`NameModal.tsx`** — recreated with its exact prior UI (pre-filled input, `maxLength=20`, Enter-to-submit, disabled-while-empty submit button). Its `onSubmit` callback's caller-side behavior is what changes (see Data flow).
- **App.tsx (outer wrapper component)**:
  - `roomNameConfirmedFor` state is reintroduced (which `roomSlug` the current name has been confirmed for), reset alongside `playerName` on account switch (same guard as before).
  - Render order: `TutorialModal` gate → `showAvatarSetup` gate → **new** `roomSlug !== roomNameConfirmedFor` gate (only reached if `showAvatarSetup` is false) → loading/`StatusPickModal` → `<Game>`. Placing the name-prompt gate *after* the avatar-setup gate is what makes brand-new users skip it automatically — no separate "is this a new user" check needed.
  - The wrapper's own `handleAvatarSave` (the first-time-onboarding one, `App.tsx:3117-3122`) additionally calls `setRoomNameConfirmedFor(roomSlug)` when it runs, so a user who just went through Avatar Setup doesn't immediately see the name popup pop up right after for the same room entry.
  - A new `handleNameSubmit(name: string)` builds `const merged = { ...loadAvatarConfig(), name };`, calls `setPlayerName(name)` + `setLocalPlayer({ name, color: merged.color, avatarConfig: merged })` for the instant local/broadcast update (same as today's live-update path), marks `setRoomNameConfirmedFor(roomSlug)`, and fires `api.saveAvatar(merged).catch(() => {})` (fire-and-forget, matching `persistAvatar`'s existing posture — a save failure never blocks room entry).

### Data flow

1. `roomSlug` changes → `<Game key={roomSlug}>` remounts.
2. If `showAvatarSetup` is true (never-configured account), go straight there — the popup is skipped for this entry, and completing Avatar Setup marks this room as name-confirmed too.
3. Otherwise, if `roomSlug !== roomNameConfirmedFor`, show `NameModal`, pre-filled with `playerName || user.displayName`.
4. On submit: local nametag updates instantly (and broadcasts live, same as any avatar edit today); `roomNameConfirmedFor` is set so the popup doesn't reappear for this room; the FULL merged avatar config (existing appearance fields + the new name) is persisted via the existing `PUT /users/me/avatar` route, which writes both `avatarConfig` and `displayName`.
5. Room entry proceeds to `<Game>`.
6. Next room entry (new `roomSlug`, this session or a future login) repeats from step 1.

## Error handling

- Empty/whitespace-only input: submit stays disabled, same as before — no random-name fallback.
- Save failure (network blip): swallowed, never blocks room entry — the local nametag and `roomNameConfirmedFor` are already updated optimistically; a real disagreement with the server only matters on the next full login, at which point the seeding effect re-reads `user.displayName` from a fresh `/me` call.
- Length: capped client-side (`maxLength=20`, matching this popup) and already re-validated server-side (`avatarUpdateSchema`'s `name: z.string().max(20).optional()`).
- The full-config-merge requirement (never submit a name-only payload) is the one failure mode with real consequences (silently erasing appearance fields) — the design's `handleNameSubmit` always merges into `loadAvatarConfig()`'s current values before calling `saveAvatar`, exactly mirroring `AvatarSetup.tsx`'s own established pattern.

## Out of scope

- Any change to `PUT /users/me/avatar`, `avatarUpdateSchema`, or `api.saveAvatar` — all already correct and reused as-is.
- The Sidebar's mid-session "Edit Avatar" flow (`App.tsx:1157-1180`'s own `handleAvatarSave`) — separate component scope, untouched.
- Reintroducing `User.roomDisplayName` or any separate nickname field — explicitly not happening; this design's whole point is that there is only ever one name, `displayName`.
- Guests (`GuestEntry.tsx`) — unaffected, as before.
