# Full Name Field — Design

## Goal

Add a "Nama Lengkap" (Full Name) field, separate from the existing "Display Name" — purely additional data captured/editable via the Avatar Editor, auto-populated from Lark's real profile name for Lark-authenticated accounts.

## Context

This session earlier fought a "second name field causes desync" bug class at length (the `roomDisplayName` removal, then the "Room-Entry Name Prompt v2" feature's 5-round review cycle) — the user's request here is a deliberate, legitimate reversal of that consolidation (adding a genuinely NEW, additive field), not a repeat of the same mistake, confirmed explicitly during this brainstorming session:

- The existing `User.displayName` field — and everything wired to it today (the Avatar Editor's "Display Name" input, the room-entry name popup, the avatar nametag, the desk-seat nameplate, chat, Participant Panel, admin console, attendance/HR surfaces) — is **completely untouched** by this feature. Confirmed with the user: keep `displayName` exactly as-is, add a brand-new field alongside it.
- The new "Nama Lengkap" field is **purely additional data** — confirmed with the user that no existing UI surface (chat, Participant Panel, admin console, attendance approvals, audit logs, analytics leaderboard) switches to showing it. It only appears in the Avatar Editor, where it's entered/edited.
- **Lark's own Contact/login API already models this exact distinction upstream and this codebase currently discards half of it.** Lark's `authen/v1/user_info` (used at login, `server/src/routes/lark.ts`) and the fuller `contact/v3/users/:open_id` (used elsewhere, e.g. `server/src/lib/larkAttendance.ts`, `server/src/lib/larkIm.ts`) both return a `name` field (the person's real/legal name) — this is exactly what `User.fullName` should be seeded from for Lark-authenticated accounts. (Lark's `contact/v3` response also has a separate `nickname` field, which this design does NOT use — `fullName` is seeded from `name`, not `nickname`.)
- **A separate, pre-existing, unrelated bug was found during this feature's own investigation:** the desk-seat nameplate (`Furniture.assignedToName`, `shared/types/index.ts`) is a client-supplied snapshot taken once at seat-assignment time (`server/src/socket/furnitureHandler.ts`'s `FURNITURE_ASSIGN` handler) and never re-resolved — if someone renames after claiming a seat, their desk pill keeps showing the old name. This is out of scope for this feature (confirmed: `displayName`, which the desk nameplate is ultimately sourced from at assignment time, isn't changing) — flagged here only as a known, separate issue for a possible future fix.
- Precedent for "a small, dedicated route for a field that must NOT get bundled into a bigger write": `PUT /users/me/avatar` (`server/src/routes/rooms.ts`) writes `avatarConfig: req.body` — the ENTIRE request body — verbatim as the stored `avatarConfig` JSON blob. Adding `fullName` to that same request would incorrectly nest it inside `avatarConfig` instead of writing the real `User.fullName` column. This exact problem was already solved once before in this codebase for the (now-removed) `roomDisplayName` field, via its own small dedicated route — this design reuses that same shape.
- Precedent for "populate a field exactly once, race-safely, never overwrite an already-set value": `User.firstSeenAt` (from earlier today), set via an atomic `updateMany({ where: { id, firstSeenAt: null }, data: { firstSeenAt: at } })` rather than a read-then-write. This design reuses that exact pattern for `fullName`.

## Scope (confirmed with user)

- `User.displayName` and everything currently wired to it are completely unchanged.
- New field `User.fullName` (nullable) — purely additive, shown/editable only in the Avatar Editor.
- No other UI surface changes to show `fullName` instead of `displayName`.
- Lark-authenticated accounts: `fullName` auto-populates from Lark's real profile `name` — but ONLY while the field is still null. Once a user has set/edited it (via Lark auto-fill or manual entry), it's never silently overwritten again — not even by a later Lark login.
- Non-Lark (manually registered) accounts: `fullName` starts null, filled in only by the user themselves via the Avatar Editor. No other source to auto-populate from.

## Design

### Data model

New nullable column, additive:

```prisma
model User {
  // ...
  fullName String?
  // ...
}
```

### Populating it (Lark logins)

Wherever Lark login already resolves the user's Lark `name` for `displayName` (`server/src/routes/lark.ts`), add one additional atomic write: `prisma.user.updateMany({ where: { id: user.id, fullName: null }, data: { fullName: larkName } })` — same "set exactly once, race-safe" shape as `firstSeenAt`. Runs on every Lark login (cheap — the Lark profile fetch already happens for `displayName`), but only actually writes while `fullName` is still null, so a manually-edited value is never clobbered.

### Server

New, small, dedicated route — mirroring the shape of the (now-removed) `room-display-name` route: `PUT /users/me/full-name`, validated (non-empty after trim if provided, capped length — same defense-in-depth posture as every other user-supplied string field this session), writes `User.fullName` and NOTHING else. Deliberately not folded into `PUT /users/me/avatar`, since that route stores the entire request body as `avatarConfig` verbatim.

`GET /auth/me`'s existing user-profile response gains `fullName` in its select, so the Avatar Editor can read the current value to pre-fill the new input.

### Client

`AvatarSetup.tsx` gains a new "Nama Lengkap" text input, positioned near/above the existing "Display Name" input — same general input styling/validation posture (non-empty-after-trim on save, reasonable length cap). Saved via a new `api.saveFullName(name)` call to the new route, independent of the existing avatar-config save. `UserProfile`'s client-side type gains `fullName?: string | null`.

## Error handling

- Save failure (network blip): fire-and-forget, matches every other profile-edit save in this codebase (`persistAvatar`, `updatePreferences`, etc.) — never blocks the Avatar Editor form.
- Lark auto-populate failure or absence (e.g. Lark's profile fetch has no `name` for some reason): `fullName` simply stays null — no guessed/fallback value, same "never guess" posture as `firstSeenAt`.
- Non-Lark accounts: no error, no attempted auto-fill — `fullName` stays null until the user fills it in.

## Out of scope

- Any change to `User.displayName` or anything currently reading it.
- Showing `fullName` anywhere in the UI besides the Avatar Editor's own input.
- Fixing the pre-existing `Furniture.assignedToName` staleness bug (flagged above, tracked separately, not touched here).
- Re-syncing `fullName` from Lark on every login the way `displayName` does — it's set once (if still null) and then left alone.
