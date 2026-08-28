# Room-Entry Name Prompt — Design

## Goal

Like ZEP: every time a logged-in user enters a room, prompt them for a display name to use in that room's avatar nametag — pre-filled with whatever name they last used (anywhere), editable, and required (no empty submissions). This is independent of the account's real name (`User.displayName`, kept in sync from Lark) — it only affects the floating nametag shown above the user's own avatar in the game canvas.

## Context

Direct codebase checks (not assumptions) found:

- **Today, the avatar nametag is NOT user-controlled for logged-in accounts.** `App.tsx:3046-3056`'s `useEffect` auto-sets `playerName` from `user.displayName` the instant `user` loads, firing before the `if (!playerName) return <NameModal onSubmit={handleNameSubmit} />` check at `App.tsx:3214-3216`. So `NameModal.tsx` — which already has exactly the UX this feature wants (pre-filled input, editable, `Enter`-to-submit) — is effectively unreachable for real accounts today. It only fires for the (rare) case of `playerName` staying null.
- **"Kursi" = the avatar's own floating nametag**, not the separate `Furniture.assignedToUserId`/`assignedToName` desk-assignment system (`shared/types/index.ts:1515-1521`, rendered as a "🪑 {name}" pill in `GameCanvas.tsx:2470-2488`). Confirmed with the user — that desk-assignment feature is untouched by this design.
- **`User.displayName` is not safe to repurpose.** `server/src/routes/lark.ts:214` re-syncs `displayName` from Lark on every login (deliberately, not just account creation). Writing a per-room name into `displayName` would be silently clobbered on the next SSO. This needs a new, separate field.
- **The nametag is already decoupled from live DB reads.** The server caches `playerName` once per socket in an in-memory `playerNames` Map (`roomHandler.ts:174, 849-856`), populated once at `JOIN_ROOM` and read via `getPlayerName(socketId)` for every broadcast — never re-queried from `User.displayName` per frame. `AvatarSprite.ts`'s `drawAvatar` renders whatever name the client received in that broadcast. This confirms the nametag is a legitimate, self-contained thing to override per session without touching anything else.
- **`useSocket.ts`'s `CONNECT` handler re-emits `JOIN_ROOM` on every reconnect**, not just the first connection (`useSocket.ts:136-150`) — using whatever `authUserName`/`playerName` is already in state. This is the critical constraint: the name prompt must NOT be wired to the socket's connect lifecycle, or it would re-appear on every transient network drop/reconnect during a room visit, which would be a disruptive regression, not a feature.
- **`<Game key={roomSlug} ...>` (`App.tsx:3262`) fully remounts on every `roomSlug` change** — both a fresh lobby→room entry and portal travel (`onPortalTravel={setRoomSlug}`, `App.tsx:1149-1155,3262`) go through this same remount. This is the correct, already-existing granularity for "the user is entering a room" — using it means portal travel is naturally covered as "entering a room" with no special-case code, and reconnects inside one room visit are naturally excluded.
- **Guests have no account to persist a "last name" against.** `RoomInvite`'s schema comment (`schema.prisma:1084-1112`) confirms guest identity lives entirely in a short-lived JWT (`guestId`), never a `User` row. `GuestEntry.tsx` already asks for a name once, before the guest's one and only room (an invite link pins them to exactly one room — there's no "entering a different room" case for a guest to begin with). Confirmed with the user: guests are out of scope for this feature: their existing one-time prompt already satisfies the need.
- **Precedent for "remembered default, server-persisted, editable each time it's used"**: `useAvatarConfig.ts` + `User.avatarConfig` (Json column) + `api.saveAvatar()` fire-and-forget save (`App.tsx:3065-3070`, `persistAvatar`). This design reuses that exact pattern for the new field.
- **Precedent for "required, non-empty, submit disabled until filled"**: `GuestEntry.tsx`'s submit button (`disabled={loading || !name.trim() || !password}`).

## Scope (confirmed with user)

- Applies to **logged-in users only**. Guests keep their existing `GuestEntry` flow, untouched.
- Affects **only the avatar's floating nametag** in the game canvas. Chat messages, the participant list, and every other place a user's real name appears keep showing `User.displayName` — untouched.
- The remembered "last name" is **one global value per account**, not per-room — it pre-fills regardless of which room is being entered next.
- The furniture/desk "🪑 {name}" assignment label is a **separate, pre-existing feature** and is not touched by this design.

## Design

### Data model

New nullable column, additive, same shape/spirit as `avatarConfig`:

```prisma
model User {
  // ...
  roomDisplayName String?
  // ...
}
```

No backfill — existing users simply have `NULL`, which the client treats as "fall back to `user.displayName`" (see Data flow below). Migration is a plain `ALTER TABLE "User" ADD COLUMN "roomDisplayName" TEXT;`, hand-authored in the same style as this session's other migrations (no live local Postgres to run `prisma migrate dev` against).

### Components

- **`NameModal.tsx`** (existing, currently dead code for logged-in users): generalized to also serve logged-in accounts, not just the "playerName somehow still null" fallback case it serves today. Keeps its existing UX (pre-filled input from a passed-in default, `maxLength=20`, `Enter`-to-submit) but changes:
  - The submit button becomes `disabled` when the trimmed input is empty (mirroring `GuestEntry.tsx`'s pattern) — **no more random `Player-xxxx` fallback**, per the user's explicit correction during design review.
  - Its default/pre-fill value becomes a prop (`initialName`) instead of reading its own `localStorage` key directly, so the caller can pass `user.roomDisplayName ?? user.displayName`.
- **`App.tsx`**: the flow that currently unconditionally auto-sets `playerName` from `user.displayName` (`App.tsx:3046-3056`) changes to only supply the *pre-fill*, not the final value — the modal now gates entry into `<Game>` for logged-in users the same way it already conceptually does for the "no name yet" case, keyed to the same `roomSlug` transition that already remounts `<Game key={roomSlug}>`. Because that remount already fires on both fresh room entry and portal travel, and reconnects happen *inside* one `Game` mount (not across a remount), this one gating point naturally satisfies "every room entry, not every reconnect" with no new lifecycle wiring.
- **`services/api.ts`**: new `api.saveRoomDisplayName(name: string)` — fire-and-forget from the caller's side (`.catch(() => {})`), same pattern as `persistAvatar`'s existing `api.saveAvatar(config).catch(() => {})`.
- **Server**: new small route (or an additive field on the existing profile-update route, whichever the current `saveAvatar` route's shape makes more natural) that validates `name` (non-empty after trim, capped length server-side too — defense in depth, same posture as every other user-supplied-string field this session) and writes `User.roomDisplayName`.

### Data flow

1. `roomSlug` changes (lobby → room, or portal travel) → `<Game key={roomSlug}>` remounts.
2. Instead of immediately setting `playerName = user.displayName`, the app shows the (generalized) `NameModal`, pre-filled with `user.roomDisplayName ?? user.displayName`. Room entry (the socket connection) is blocked until submit, mirroring the existing "Ask before entering" gate's blocking pattern (`App.tsx:3091-3106`).
3. User edits or keeps the pre-filled value, submits (button disabled until non-empty).
4. `playerName` is set to the submitted value — feeds `useSocket`'s `authUserName` → `JOIN_ROOM` → server's `playerNames` Map → broadcast → `AvatarSprite.drawAvatar`, exactly the same rendering path as today, just a different source value.
5. In parallel, `api.saveRoomDisplayName(name)` fires (fire-and-forget) to persist it as the account's new default for next time.
6. Any socket reconnect during this room visit (network blip, etc.) reuses the already-confirmed `playerName` — the modal does not reappear; `useSocket.ts`'s existing reconnect-reemits-`JOIN_ROOM` behavior is untouched.
7. The next room entry (this session or a future login) repeats from step 1, pre-filling with whatever was saved in step 5.

### Error handling

- **Empty input**: submit button stays disabled until the trimmed value is non-empty — no fallback random name (revised from the initial draft per explicit user correction: this must be a hard requirement, not a soft default).
- **Save-to-server failure** (network blip, server hiccup): fire-and-forget, swallowed — never blocks room entry. Worst case, the next room visit's pre-fill falls back one step further, to `user.displayName`.
- **Length**: capped at 20 characters client-side (matches the existing input's `maxLength`) and re-validated server-side.

## Out of scope

- Guests (`GuestEntry` flow) — unchanged.
- Chat messages, participant lists, or any other surface showing a user's real name — unchanged, all keep reading `User.displayName`.
- The furniture/desk assignment nameplate (`Furniture.assignedToName`) — a separate, pre-existing feature, untouched.
- Per-room-specific remembered names — this ships as one global "last used name" per account, not one per room.
- Any change to how `User.displayName` itself is set or synced from Lark.
