# Kaitech Lobby Limit + DCM Presence Wording — Design

## Goal

Two small follow-ups to the "DCM Restricted Accounts" feature:

1. Temporarily limit the Lobby's room list to just `kaitech` and `dcm` for everyone in the Kaitech organization (not just DCM-restricted accounts) — decluttering the Lobby during this rollout, without touching room access itself.
2. Make the existing company-wide Member panel show restricted/online presence as "Online · [room name]" for every room, so a DCM account showing online there reads unambiguously as "Online · DCM" instead of a bare room name.

## Context

Investigation before this design found:

- No "active rooms" concept exists anywhere today. `Room` has no `isActive`/similar visibility field. `GET /rooms` (`server/src/routes/rooms.ts:72-123`) returns every `Room` with `isPublic: true` in the caller's org — no curated subset. Production currently has roughly 190 live rooms.
- The app is multi-tenant (see the earlier "self-serve org creation" feature) — other organizations besides Kaitech exist and must not be affected by this change.
- A company-wide Member panel already exists (`client/src/components/ui/MemberListPanel.tsx`, opened from Sidebar's "Member" row) that shows every org member's online/offline status plus, for online members, their current room name (`roomName`) and zone (`zoneName`) — sourced from `server/src/socket/roomHandler.ts`'s `userRoomMap`, broadcast via `ROSTER_SNAPSHOT`/`ROSTER_UPDATED`. Since the DCM room is named `"DCM"`, a DCM account already renders as `"DCM"` in this panel today — just without an explicit "Online" qualifier, same as every other room.

Confirmed with the user:
- The 188 other rooms are hidden from the Lobby LIST only — not blocked from entry. Anyone with a direct link/slug, or anyone already inside one of those rooms when this ships, is unaffected.
- Implemented as a hardcoded 2-slug allowlist, not a new database field — this is explicitly temporary ("sementara"), and a hardcoded array is a one-line revert versus a schema migration.
- Scoped to the Kaitech/default organization only — every other organization's Lobby is completely unaffected.
- The Member panel's presence wording changes to `"Online · {roomName}"` uniformly for every room (not a DCM-specific special case), for consistency.

## Design

### 1. Lobby limited to `kaitech` + `dcm` (Kaitech org only)

In `GET /rooms` (`server/src/routes/rooms.ts`), the existing unrestricted-account query branch:

```ts
where: req.restrictedToRoomId
  ? { id: req.restrictedToRoomId, organizationId: req.organizationId }
  : { isPublic: true, organizationId: req.organizationId },
```

gains a Kaitech-only slug filter:

```ts
// Temporary Lobby declutter during the DCM rollout — remove this
// ACTIVE_KAITECH_ROOM_SLUGS branch (fall back to the plain isPublic
// query) to restore the full room list once no longer needed.
const ACTIVE_KAITECH_ROOM_SLUGS = ['kaitech', 'dcm'];

where: req.restrictedToRoomId
  ? { id: req.restrictedToRoomId, organizationId: req.organizationId }
  : req.organizationId === DEFAULT_ORG_ID
    ? { isPublic: true, organizationId: req.organizationId, slug: { in: ACTIVE_KAITECH_ROOM_SLUGS } }
    : { isPublic: true, organizationId: req.organizationId },
```

`DEFAULT_ORG_ID` comes from `server/src/lib/defaultOrg.ts` — already used elsewhere in this codebase (e.g. `seedDcmAccounts.ts`, `auth.ts`) and the same constant the DCM feature itself scopes accounts to, but not yet imported in `rooms.ts` — the implementation adds that import.

No other boundary changes: `GET /rooms/:slug` and socket `JOIN_ROOM` are untouched, so a hidden room remains fully enterable by direct slug/link, and anyone already connected to one of the 188 rooms when this deploys keeps working normally — this only narrows what `GET /rooms` returns for the Lobby list.

### 2. Member panel presence wording

In `client/src/components/ui/MemberListPanel.tsx`, the online-row subtext (currently lines 97-101):

```tsx
{online
  ? `${r.presence!.roomName}${r.presence!.zoneName ? ` · ${r.presence!.zoneName}` : ''}`
  : 'Offline'}
```

becomes:

```tsx
{online
  ? `Online · ${r.presence!.roomName}${r.presence!.zoneName ? ` · ${r.presence!.zoneName}` : ''}`
  : 'Offline'}
```

Applies uniformly to every room's presence row, not a DCM-specific branch — a DCM account shows `"Online · DCM"`, a Kaitech-room account shows `"Online · Kaitech"`, etc. The separate "Kamu di room: …" header line (line 62) is unchanged — it already states "you're in room X" explicitly, so prefixing it with "Online" would be redundant there.

No server-side change for this part — `roomName`/`zoneName` are already present in the roster payload; this is purely a client-side text-formatting change.

## Error handling

- If `ACTIVE_KAITECH_ROOM_SLUGS` ever named a slug that no longer exists (e.g. `dcm` deleted), the `slug: { in: [...] }` filter simply returns fewer rows — no error, same as any other empty-result Prisma query.
- No change to what happens when a restricted account's `restrictedToRoomId` is `undefined` (the existing fail-closed `{rooms: []}` branch runs first and is untouched).

## Out of scope

- No changes to `GET /rooms/:slug` or `JOIN_ROOM` — entry to any of the 188 other rooms remains exactly as it is today.
- No new `Room.isActive` field or admin UI to toggle it — explicitly deferred per the user's "temporary" framing; the hardcoded array is the entire mechanism.
- No change to any other organization's Lobby behavior.
- No change to the Member panel's data source, sorting, or any row other than the online-presence subtext string.
