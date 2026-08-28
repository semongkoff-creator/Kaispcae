# First-Seen Timestamp for Offline Members — Design

## Goal

In the Participant Panel's "Offline" list, show when each member first ever actually joined a room in KaiSpace — so a viewer can tell apart an account that has genuinely used KaiSpace before (and is just currently offline) from one that has never joined a room at all.

## Context

Direct codebase checks (not assumptions) found:

- **The Offline list is org-wide, not room-scoped.** `GET /org/members` (`server/src/routes/orgMembers.ts`) returns every active `User` row in the organization; the client (`ParticipantPanel.tsx`) computes `offlineMembers` as every org member minus whoever's currently connected via socket. This design keeps that scope unchanged — it only adds a field to the same existing list.
- **`User.createdAt` is NOT a faithful "first used KaiSpace" signal.** It marks when the account row was created (registration/OAuth callback succeeding) — which can happen before someone ever actually opens the game canvas and joins a room. Confirmed with the user this is the wrong signal: they want "actually came to KaiSpace," not "has a login."
- **`StatusInterval` (`schema.prisma`) is the right signal.** A row is opened via `openStatusInterval` (`server/src/lib/statusIntervals.ts`) specifically when a (non-guest) user joins a room — this only ever happens as a result of genuinely entering a room, unlike account creation. The earliest such row's `startedAt`, per user, is their true first-use moment.
- **No existing dedicated "first seen" field exists anywhere** — this is new. The closest existing precedent for caching a derived timestamp directly on `User` (rather than computing an aggregate live on every read) is the existing `lastAttendanceCheckInDate`/`lastAttendanceCheckOutDate` idempotency-marker fields, which this design's `User.firstSeenAt` mirrors in spirit.
- **No relative-time formatter in Bahasa Indonesia exists in the client today.** `ActivityFeed.tsx`'s local `formatRelativeTime` only covers seconds/minutes/hours, in English, and isn't shared/exported. A first-seen timestamp can realistically be months old, so this needs a broader (days/weeks/months/years) Indonesian-language formatter. Native `Intl.RelativeTimeFormat('id', ...)` covers this with no new dependency.
- **Guests never appear in this list** — `GET /org/members` queries the `User` table directly, and guests have no `User` row (confirmed earlier this session — guest identity lives entirely in a short-lived JWT). Nothing to special-case here.

## Scope (confirmed with user)

- "First seen" means **the first time a user actually joined a room** (their earliest `StatusInterval` row), not account creation.
- **Existing users need a one-time backfill.** Without it, a veteran user's `firstSeenAt` would only get set the NEXT time `openStatusInterval` runs after this ships — incorrectly reporting "first seen: today" for someone who's used KaiSpace for months. The backfill computes each user's actual earliest `StatusInterval.startedAt` from existing history; a user with genuinely zero prior intervals is correctly left with `firstSeenAt: null`.
- The Offline list's own existing scope (org-wide, minus currently-connected) is unchanged — this only adds a field to what's already shown.

## Design

### Data model

One new nullable column, additive:

```prisma
model User {
  // ...
  firstSeenAt DateTime?
  // ...
}
```

### Backfill (one-time, shipped alongside this feature)

A hand-authored migration step (or a one-off script run once at deploy time, matching this session's established "no live local Postgres, hand-author + verify" convention) computes, for every user with at least one `StatusInterval` row, the minimum `startedAt` across all their intervals, and writes it to `firstSeenAt`. A user with no `StatusInterval` rows at all is left `NULL` — correctly meaning "never joined a room."

### Going forward

`openStatusInterval` (`server/src/lib/statusIntervals.ts`) — called every time a non-guest user joins a room — additionally checks whether that user's `firstSeenAt` is currently `NULL`; if so, sets it to the interval's own start time. Once set, it's never touched again (a genuinely new user's true first join is captured exactly once, at the moment it happens; an existing user's backfilled value is never overwritten since it's already non-null).

### Server

`GET /org/members` (`server/src/routes/orgMembers.ts`) adds `firstSeenAt` to its existing `select` — no new query, no new endpoint.

### Client

`ParticipantPanel.tsx`'s `OfflineMemberRow` renders, below/beside the existing name: "Pertama masuk {relative time}" when `firstSeenAt` is set, or "Belum pernah masuk" when it's `null`. A new small shared helper formats the relative time in Bahasa Indonesia via `Intl.RelativeTimeFormat('id', { numeric: 'auto' })`, covering the full range from minutes up through years (unlike `ActivityFeed.tsx`'s existing hours-only helper, which stays as-is and unshared — this is a new, separate helper suited to a much wider possible time range).

## Error handling

- Backfill: a single user's computation failing (corrupt/unexpected data) doesn't halt the migration — that one user is skipped/logged, everyone else still gets backfilled correctly.
- Going forward: if the `firstSeenAt` write inside `openStatusInterval` fails for any reason (transient DB error, race condition), nothing breaks — since the field is still `NULL`, the very next room join naturally retries the same "set if null" logic.
- No behavior change to `StatusInterval`'s own existing read/write logic, room-join flow, or anything else in `openStatusInterval` beyond this one additive check.

## Out of scope

- Showing this timestamp for ONLINE members — the whole point is distinguishing two kinds of *offline* accounts; an online member has trivially "been to KaiSpace" already.
- Changing the Offline list's existing org-wide (not room-scoped) membership logic.
- A tooltip or exact-date display on hover — a plain relative-time string is enough for this feature; can be revisited later if wanted.
- Backfilling or tracking anything for guests — they have no `User` row and never appear in this list.
