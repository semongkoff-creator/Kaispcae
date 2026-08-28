# Room-Scoped Participant List — Design

## Goal

Scope the Participant Panel's "Offline" list to the current room, matching how "Online" already works — so the panel shows who's tied to *this room* (currently in it, or has been before and isn't right now), not every member of the whole organization.

## Context

The user's original ask (across two garbled messages) turned out to be two separate questions, resolved as follows:

- **Messenger/#general chat is already fully per-room** — confirmed via direct code investigation, not assumption. `Channel` (`schema.prisma`) has a required `roomId`, `@@unique([roomId, name])`, and every room gets its own distinct "general" channel (`server/src/routes/rooms.ts:725-726` on creation, `server/src/routes/chat.ts:144-148` as a lazy backfill for older rooms). `ChatMessage.channelId` → `Channel.roomId` means message history can never cross rooms. The user confirmed after seeing this explanation that nothing needs to change here — no bug, no build needed.
- **The Participant Panel's "Offline" list is genuinely org-wide today, and this is the real gap.** "Online" is already room-scoped (`ParticipantPanel.tsx`'s `onlineUserIds` comes entirely from `playerRecords`/`remotePlayers` — only players connected to *this room's* live socket session). "Offline" comes from `GET /org/members` (`server/src/routes/orgMembers.ts`), which queries every active `User` in the organization with zero room filter, then the client subtracts whoever's online in this room. Someone active in a *different* room of the same org today shows up as "Offline" here.

**Historical note:** this org-wide Offline scope was an explicit, deliberate design decision, confirmed twice earlier today in the two "first seen"/"last seen" features just shipped ("The Offline list's existing org-wide scope must not change"). The user is now deliberately reversing that decision — confirmed directly, not assumed — in favor of a genuinely room-scoped panel.

## Scope (confirmed with user)

- Chat/Messenger: no change, confirmed already correct.
- "Offline" list: replaced entirely with a room-scoped version — not kept alongside an org-wide view, no toggle/tab for "see everyone in the org."
- "Room membership" (since this system has no persistent concept of who belongs to a room — anyone with access can join any room) is defined as: **has this user ever had a `StatusInterval` row for this specific `roomSlug`** (i.e., has actually been active in this room before, at least once). A brand-new room with zero history correctly shows an empty Offline list — not a bug.

## Design

### Architecture

- `GET /org/members` (`server/src/routes/orgMembers.ts`) is replaced by `GET /rooms/:slug/participants` — **not** `/rooms/:slug/members`, because that path is already taken: `server/src/routes/roomMembers.ts` (1061 lines, unrelated — room join/queue/zone routes) already defines `GET /rooms/:slug/members` for a completely different, already-shipped feature (the group-chat "add members" picker, backed by approved `RoomMember` rows, response shape `{id, displayName, email, role}`), and `client/src/services/api.ts` already exports `getRoomMembers(slug)` for it. This collision was caught mid-implementation (a Task 1 implementer discovered it, reverted cleanly, and escalated rather than guessing) — this spec was corrected afterward to use non-colliding names throughout, without touching the existing group-picker feature at all.
- New route lives in `server/src/routes/roomParticipants.ts` (the old `orgMembers.ts`, renamed) — still following the same room-nested convention and reusing the same `findRoomInOrg(prisma, slug, organizationId)` helper and room-access check pattern as `GET /rooms/:slug/channels`, just at a path that doesn't collide with the pre-existing `roomMembers.ts`.
- Query: `StatusInterval.findMany({ where: { roomSlug }, select: { userId: true }, distinct: ['userId'] })` to get every user who has ever been active in this room, then `User.findMany({ where: { id: { in: userIds }, organizationId, active: true }, select: { id, displayName, workspaceRole, lastSeenAt } })` — same selected fields as today, just filtered to this room's user set first.
- Client: `ParticipantPanel.tsx` calls the new `api.getRoomParticipants(roomSlug)` (not `getRoomMembers` — that name is taken by the group-picker) instead of the old no-argument `getOrgMembers()` call. Everything downstream — the `onlineUserIds` derivation from live socket data, the `offlineMembers = orgMembers.filter(m => !onlineUserIds.has(m.id))` merge, and `OfflineMemberRow`'s "Terakhir masuk"/"Belum pernah masuk" rendering — is unchanged; only the source list is now room-filtered instead of org-wide.

### Data flow

1. Panel opens (or refreshes) → client calls `GET /rooms/:slug/members` for the current room.
2. Server resolves the room via `findRoomInOrg`; if not found, `404 Room not found` (matching `/rooms/:slug/channels`'s existing behavior). If the room exists but the user lacks room access, apply the same access check already used by the sibling chat route.
3. Server queries distinct `userId`s from `StatusInterval` for this `roomSlug`, then fetches the matching `User` rows (active, same org).
4. Response shape is unchanged: `{ members: [...] }`, same fields as today.
5. Client merges as before; a room with no historical activity simply returns `members: []`, rendering an empty Offline section — a real, correct state, not an error.

## Error handling

- Room not found for the given slug → `404`, same as the existing sibling route.
- User lacks access to the room → same access-denied handling as `/rooms/:slug/channels`.
- Zero historical `StatusInterval` rows for a room → empty `members` array, not an error; the Offline list is simply empty.
- No change to `StatusInterval`'s own read/write semantics, or to how "Online" is derived.

## Out of scope

- Any org-wide "see everyone in the company" view — explicitly not being kept alongside this change.
- Changing what counts as "Online" (already room-scoped, untouched).
- A persistent "room membership" concept (invite lists, assigned members) — this design deliberately reuses existing `StatusInterval` history instead of introducing new data modeling.
- Any change to Messenger/#general chat — confirmed already correct, nothing to build.
