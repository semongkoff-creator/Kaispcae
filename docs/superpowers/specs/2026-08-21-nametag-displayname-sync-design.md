# Nametag / Display Name Sync — Design

## Goal

The floating nametag above a user's avatar should always match their account's Display Name — editing it in the Avatar Editor should stick permanently, not silently revert on the next login.

## Context

Direct codebase checks (not assumptions) found the root cause:

- There are two separate name fields on `User`: `displayName` (the account's real name, editable via the Avatar Editor's "Save & Apply") and `roomDisplayName` (a separate, sticky-per-account field added earlier the same day by the "Room-Entry Name Prompt" feature — `docs/superpowers/specs/2026-08-21-room-entry-name-prompt-design.md`).
- The floating nametag is client-side session state (`playerName` in `App.tsx`), seeded ONCE per login via `user.roomDisplayName || user.displayName` (`App.tsx:3097`) — `roomDisplayName` permanently wins whenever it's non-null, for every future session, once a user has ever gone through the room-entry name prompt (`NameModal.tsx`, shown once per new `roomSlug`).
- Editing Display Name via the Avatar Editor DOES immediately update the current session's nametag (locally and broadcast to others), but never touches `roomDisplayName` — so the next login/session reverts to the stale sticky value. This is the actual "ga sinkron" bug: it only reproduces across a session boundary (logout/login, fresh page load), not within one continuous session, which is why it read as intermittent.
- `roomDisplayName` was deliberately built as a SEPARATE field from `displayName` specifically because `displayName` gets re-synced from Lark on every login (`server/src/routes/lark.ts:214`) — writing a custom nickname into `displayName` would have been silently clobbered on next SSO. That constraint was about not using `displayName` as *storage* for something else; it doesn't block *reading* `displayName` directly for the nametag, which is what this design does. One known, pre-existing, out-of-scope side effect: a Lark-authenticated user's `displayName` (and therefore, after this change, their nametag) can still be reset to their Lark profile name on a future Lark login — this is existing `displayName` behavior, unrelated to this fix, and not being changed here.
- `NameModal.tsx` has exactly one call site (`App.tsx:3287`, gated by `roomSlug !== roomNameConfirmedFor`) and is not used by guests (`GuestEntry.tsx` has its own separate, untouched flow) — safe to remove entirely once that call site is removed.
- A grep of `roomDisplayName` across the repo found 12 files; two (`docs/superpowers/specs/2026-08-21-daily-task-kanban-per-user-table-design.md` and its plan) only mention it incidentally as a style precedent ("additive, same shape/spirit as avatarConfig/roomDisplayName") — not a real dependency, unaffected by this change.

## Scope (confirmed with user)

- The nametag always follows `User.displayName` — the separate room-entry nickname concept is removed entirely, not patched.
- The `roomDisplayName` column is DROPPED via a new migration (not left dormant) — it holds no data worth preserving.
- Guests, chat, participant lists — all already use `displayName` (or their own separate flow) and are unaffected.

## Design

### Removed entirely

- `NameModal.tsx` (component file) — its only call site is removed, and it serves no other caller.
- `App.tsx`'s room-entry gate: the `roomNameConfirmedFor` state, the `if (roomSlug !== roomNameConfirmedFor) return <NameModal ... />` block (`App.tsx:3286-3287`), and `handleNameSubmit`.
- `client/src/services/api.ts`'s `saveRoomDisplayName`.
- Server: `PUT /users/me/room-display-name` (`server/src/routes/rooms.ts:894-906`) and its validation entry in `server/src/middleware/validate.ts`.
- `User.roomDisplayName` from `server/prisma/schema.prisma`, and from any select/type surfaced in `server/src/routes/auth.ts` / `server/src/lib/publicUser.ts`.

### Changed

- `App.tsx`'s `playerName` seeding (`App.tsx:3095-3105`, the effect that currently does `user.roomDisplayName || user.displayName`) becomes a direct seed from `user.displayName` alone — no fallback chain, no modal, no gate blocking room entry. Room entry (the socket connection / `<Game>` mount) proceeds immediately once `user` is loaded, the same way it already does once the old modal is out of the way.
- New migration: `ALTER TABLE "User" DROP COLUMN "roomDisplayName";` — the original add-column migration (`20260821170000_add_user_room_display_name`) is left untouched (never edit a past migration); this ships as a new one.

### Unchanged

- Avatar Editor's "Save & Apply" flow (`AvatarSetup.tsx` → `App.tsx`'s `handleAvatarSave` → `api.saveAvatar` → `PUT /users/me/avatar` → writes `User.displayName`) — already correct, already the only write path needed. Its existing live local update (`setLocalPlayer`) and broadcast (`emitAvatarUpdate` → `AVATAR_UPDATED`) are untouched.
- Chat, participant lists, and every other surface already reading `User.displayName` directly.
- Guests (`GuestEntry.tsx`) — untouched, separate flow.
- The furniture/desk "🪑 {name}" assignment label — separate, pre-existing, untouched.

## Error handling

- No new error paths introduced — this is a net removal of code (a modal, a gate, an API route, a DB column) rather than an addition. Existing error handling for `PUT /users/me/avatar` (Avatar Editor save) is untouched.
- The migration is a single `DROP COLUMN`, applied once at deploy — no data to migrate/preserve, no backfill.

## Out of scope

- Any change to how/when `User.displayName` itself is set or re-synced from Lark (`server/src/routes/lark.ts:214`) — a Lark-authenticated user's `displayName` (and therefore nametag) can still reset to their Lark profile name on a future Lark login; this is pre-existing behavior, not touched here.
- Guests, chat, participant lists, the furniture/desk nameplate — all already correct, all unaffected.
