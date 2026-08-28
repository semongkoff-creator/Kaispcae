# Last-Seen Timestamp for Offline Members — Design

## Goal

Replace the just-shipped "Pertama masuk" (first-ever-join) timestamp in the Participant Panel's Offline list with "Terakhir masuk" (last-seen) — so a viewer can tell apart a member who was online earlier and has since gone offline from one who has never come online at all, and roughly when the former was last active.

## Context

This session shipped a "First-Seen Timestamp for Offline Members" feature earlier today (commits `e4bd199`/`b75cf73`/`a2dfc5d`, deployed): `User.firstSeenAt` — the EARLIEST `StatusInterval.startedAt` per user, set exactly once via an atomic "set if null" write in `openStatusInterval`, backfilled via `MIN(startedAt)` for existing users — rendered as "Pertama masuk {relative} ({exact date/time})" in `OfflineMemberRow` (`client/src/components/ui/ParticipantPanel.tsx`).

After seeing it live, the user clarified the actual need was different: they want to know **when each offline member was last active** (so they can tell "this person was online earlier today, now they're off" apart from "this person hasn't come online at all"), not when they first ever joined KaiSpace. "Pertama masuk" only answers "have they ever used this," not "were they around recently."

Direct codebase checks (current state, re-read this session):
- `server/src/lib/statusIntervals.ts`'s `openStatusInterval` is called on every room join AND every work-mode change while already in a room (`closeOpenStatusInterval` then `statusInterval.create`), so a new `StatusInterval` row's `startedAt` is written far more often than just "genuine room entries" — this is fine for a last-seen signal (see Design below).
- `server/prisma/schema.prisma:88` has `firstSeenAt DateTime?` on `User`, from this morning's feature.
- `server/src/routes/orgMembers.ts`'s `GET /org/members` currently selects and exposes `firstSeenAt` (converted to epoch ms via `.getTime()`).
- `client/src/utils/relativeTime.ts` has `formatRelativeTimeId` (Indonesian relative phrasing) and `formatExactDateTimeId` (exact date+time, added earlier today per separate user feedback) — both are generic timestamp formatters, not tied to any specific field name, and are reused as-is here.

## Scope (confirmed with user)

- "Terakhir masuk" replaces "Pertama masuk" entirely in the UI — this is not an additive second field shown alongside the first.
- New column `User.lastSeenAt`, NOT a repurposing of `User.firstSeenAt`. The existing `firstSeenAt` column and its already-backfilled data stay in the database untouched — just no longer selected/exposed via the API or rendered anywhere, since nothing will consume it once this ships.
- "Terakhir masuk" = the start time of the member's most recent `StatusInterval` row (i.e., updates on every `openStatusInterval` call, join or work-mode change alike) — not the moment they most recently went offline. For this feature's actual purpose (distinguish "was around recently" from "never around"), the difference between session-start and session-end isn't material, and using session-start keeps the write a single additive line in the already-shared `openStatusInterval` helper rather than adding a second write inside `closeOpenStatusInterval`.
- A user with zero `StatusInterval` rows ever stays `lastSeenAt: NULL` forever — same "never guessed" rule as before, rendered as "Belum pernah masuk" (unchanged copy).
- The Offline list's existing org-wide scope (every active `User` minus currently-connected, not room-scoped) is unchanged — this only swaps which timestamp field is shown.

## Design

### Data model

One new nullable column, additive (schema.prisma):

```prisma
model User {
  // ...
  firstSeenAt DateTime? // kept as-is; no longer selected/exposed via the API — see specs/2026-08-21-last-seen-offline-members-design.md
  lastSeenAt  DateTime?
  // ...
}
```

### Backfill (one-time, shipped alongside this feature)

A hand-authored migration computes, for every user with at least one `StatusInterval` row, the MAXIMUM `startedAt` across all their intervals, and writes it to `lastSeenAt`. A user with no `StatusInterval` rows at all is left `NULL`.

### Going forward

`openStatusInterval` (`server/src/lib/statusIntervals.ts`) gains one additional unconditional write, right where its existing `firstSeenAt` "set if null" write already sits: `lastSeenAt` is overwritten with the interval's own `startedAt` on every call, no null-check needed (last write always wins — simpler than `firstSeenAt`'s atomic guard, since there's no "only once" constraint here). The existing `firstSeenAt` write is deleted, not left in place — it has no consumer left once this ships, and leaving dead writes around invites exactly the kind of drift this session's own established convention warns against.

### Server

`GET /org/members` (`server/src/routes/orgMembers.ts`) swaps its `select`/response field from `firstSeenAt` to `lastSeenAt` (same `.getTime()` epoch-ms conversion pattern). `firstSeenAt` is dropped from both the select clause and the response shape — it has no remaining reader.

### Client

`client/src/services/api.ts`'s `OrgMember` interface swaps `firstSeenAt: number | null` for `lastSeenAt: number | null`. `ParticipantPanel.tsx`'s `OfflineMemberRow` renders `` `Terakhir masuk ${formatRelativeTimeId(lastSeenAt)} (${formatExactDateTimeId(lastSeenAt)})` `` when non-null, `'Belum pernah masuk'` when `null` — reusing both existing formatters from `client/src/utils/relativeTime.ts` unchanged (both are generic over any epoch-ms timestamp, added/extended earlier today for this same row).

## Error handling

- Backfill: a single user's computation failing doesn't halt the migration — that user is skipped/logged, everyone else still gets backfilled correctly.
- Going forward: `openStatusInterval` is already fire-and-forget from every call site (analytics bookkeeping must never block or fail the feature it's hooked into) — if the `lastSeenAt` write fails transiently, the very next join or work-mode change naturally retries it, and nothing else in the room-join flow depends on it succeeding.
- No behavior change to `StatusInterval`'s own read/write logic, room-join flow, or anything else in `openStatusInterval` beyond swapping the `firstSeenAt` write for this new unconditional `lastSeenAt` write.

## Out of scope

- Showing this timestamp for ONLINE members — unchanged from the original feature's own out-of-scope call.
- Changing the Offline list's existing org-wide (not room-scoped) membership logic.
- Distinguishing "started a session" from "went offline" as two different displayed values — this design deliberately picks one (session-start) rather than building both.
- Dropping the `firstSeenAt` column itself — it stays in the schema with its already-backfilled data, just unused; an actual column drop is a separate, easily-reversible-later decision not needed to ship this.
