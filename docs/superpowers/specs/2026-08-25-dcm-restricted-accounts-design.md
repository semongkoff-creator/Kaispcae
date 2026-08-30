# DCM Restricted Accounts — Design

## Goal

Create ~26 real login accounts (from `DCM_Password_List.xlsx`, an external client's email list sharing one plaintext password) that can only ever see and enter one specific room ("DCM") in the existing Kaitech organization, and cannot see any Lark-integration feature — "bener kayak guest" (genuinely guest-like), enforced server-side, not just hidden in the UI.

## Context

Investigation before this design found the user's literal request ("real accounts with the `guest` role") doesn't map onto the existing system: `Role: 'guest'` (`shared/permissions.ts`) is exclusively a link-based, ephemeral mechanism — `RoomInvite`'s own schema comment states "Never grants a real account — the guest identity lives entirely in the JWT (`guestId`), not a `User` row." There is no path to assign a real, registered `User` the `'guest'` role; `RoomMember.role` for a real account only ever holds `owner|admin|staff|member`.

Confirmed with the user: these accounts stay in the existing Kaitech/default organization (not a new, separate one) — so the isolation this design builds is a genuinely new mechanism, not a reuse of the existing Organization-boundary multi-tenancy.

Also confirmed via investigation: no per-user "which rooms can I see" mechanism exists today. `GET /rooms` filters only by `organizationId` + `isPublic` — every member of an org sees every public room in it. `Room.restrictedAccess` blocks *entry* to a room but not its *visibility* in the Lobby list (a restricted room still shows, just locked). This design adds the missing per-user mechanism.

Lark-feature gating today (`client/src/components/ui/Sidebar.tsx`) is inconsistent: Chat/Messenger and Absensi (Attendance) are shown to any real account unconditionally; Daily Task and Cuti/Izin already hide for non-default-org accounts via an `isDefaultOrg` check — but since these 26 accounts stay in the *default* org, that existing check would NOT hide anything for them. All four need a new, uniform gate.

`DCM_Password_List.xlsx` (repo root) is untracked in git but not yet gitignored — flagged to the user; this design's script reads it directly at run time rather than copying its contents into source, and the user should add it to `.gitignore` to prevent an accidental future commit.

## Scope (confirmed with user)

- Accounts stay in the existing Kaitech (default) organization — not a new, separate Organization.
- Restriction is to exactly **one** room per account (no multi-room allowlist needed).
- Enforcement is real, server-side rejection at every relevant boundary — not merely hidden from the Lobby list. A restricted account must be unable to see OR enter any room but the one it's scoped to, by any path (Lobby list, direct slug/URL, the room-join socket flow itself).
- ALL Lark-linked Sidebar menu items are hidden for a restricted account: Chat/Messenger, Absensi (Attendance), Daily Task, Cuti/Izin — a single uniform rule, not a partial list.
- Account creation is a one-off script (mirroring this session's `server/scripts/seedKaitechRoom.ts` precedent), not a new reusable bulk-import admin feature — this is a one-time 26-account setup for one external client engagement, not an ongoing need.
- The script reads credentials directly from `DCM_Password_List.xlsx` at run time (via `exceljs`, already a dependency) rather than embedding them in committed source.

## Design

### 1. Data model

Additive nullable field on `User` (`server/prisma/schema.prisma`):

```prisma
model User {
  // ...existing fields...
  restrictedToRoomId String?
  restrictedToRoom   Room?   @relation(fields: [restrictedToRoomId], references: [id], onDelete: SetNull)
}
```

`null` (every existing account today) = completely unrestricted, zero behavior change. Set = this account may only see/enter that one room and never sees a Lark-linked Sidebar item. `onDelete: SetNull` — if the DCM room is ever deleted, these accounts fall back to unrestricted rather than being left pointing at a dangling id (matches this codebase's general "never leave an orphaned reference silently broken" posture); their continued restriction in that edge case is a follow-up admin decision, not something the schema needs to force.

### 2. Server enforcement (three boundaries)

- **`GET /rooms`** (Lobby list, `server/src/routes/rooms.ts`): when `req.user.restrictedToRoomId` is set, replace the normal `isPublic + organizationId` query with a single-room lookup scoped to that id — the response shape is unchanged, just a list of exactly one room (or zero, if it's since been deleted).
- **`GET /rooms/:slug`**: when restricted and `slug` doesn't resolve to the allowed room's id, respond 404 — indistinguishable from that room simply not existing, same as this route's existing not-found path.
- **`JOIN_ROOM`** (socket, `server/src/socket/roomHandler.ts`): the actual gate for participating in a room's live state. When restricted and the room being joined isn't the allowed one, reject the join the same way an existing cross-org join is already rejected in this handler — this is the authoritative boundary; even if a gap existed in the two REST checks above, this one alone still prevents genuinely joining/participating in any other room.

All three read the same `User.restrictedToRoomId` — no new caching layer, since this is checked at request/join time, not on a hot per-frame path.

### 3. Client — hide Lark-linked Sidebar items

`GET /auth/me`'s user payload gains `restrictedToRoomId`. In `client/src/components/ui/Sidebar.tsx`, the four Lark-linked items' existing visibility conditions each gain `&& !user.restrictedToRoomId`:
- Chat/Messenger (currently gated by `!isGuest` only)
- Absensi/Attendance (currently gated by `!isGuest` only)
- Daily Task (currently gated by `!isGuest && isDefaultOrg`)
- Cuti/Izin (currently gated by `!isGuest && isDefaultOrg`)

A restricted account sees none of the four, uniformly, regardless of org.

### 4. Account creation — one-off script

New `server/scripts/seedDcmAccounts.ts`, structurally parallel to `seedKaitechRoom.ts`:

- Idempotent by room slug `'dcm'` (create-or-reuse, same pattern as `seedKaitechRoom.ts`'s fixed-slug idempotency) — a default-template room, in `DEFAULT_ORG_ID`'s organization (`server/src/lib/defaultOrg.ts`, the same constant `auth.ts`'s own registration route resolves the Kaitech org from).
- Reads `DCM_Password_List.xlsx` from the repo root at run time via `exceljs` (already a dependency — used server-side for other exports), row by row: email + shared plaintext password.
- Per row: `bcrypt`-hashes the password (same work factor `auth.ts`'s own registration route uses), upserts a `User` (create if the email doesn't exist yet; if it already exists, this run is a no-op for that row rather than overwriting an already-active account's password) with `organizationId` = `DEFAULT_ORG_ID`, `restrictedToRoomId` = the DCM room's id, and a `RoomMember` row for that room with `role: 'member'`.
- Run once, directly in the production server container (matching how this session's Prisma migrations are applied) — not wired into any startup path or exposed as an HTTP route.
- Never logs the plaintext password; only a per-row created/skipped summary.

## Error handling

- A row with a malformed/empty email is skipped with a logged warning, not a script abort — one bad row in the spreadsheet must not block the other 25.
- Re-running the script after a partial failure is safe (idempotent upsert-by-email + create-or-reuse-by-slug).
- The `JOIN_ROOM` rejection for a restricted account attempting a different room fails the same way an already-rejected join fails today (silent no-op from the client's perspective, matching existing cross-org rejection) — no special new error UI needed.

## Out of scope

- Any new Admin Console UI for bulk account import (one-off script only, per confirmed scope).
- Multi-room restriction (one room per account is sufficient here; the schema could grow a join table later if a genuinely different need arises, but nothing here should anticipate it).
- Changing `DCM_Password_List.xlsx`'s handling beyond flagging it for `.gitignore` — the file itself isn't moved, renamed, or deleted by this work.
- Any change to the existing link-based Guest Link/`Role: 'guest'` mechanism — this is a wholly separate, new concept for real accounts, not a modification of it.
