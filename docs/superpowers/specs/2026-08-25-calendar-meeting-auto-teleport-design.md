# Calendar Meeting Auto-Teleport + Optional Password — Design

## Goal

When a scheduled Calendar meeting's start time arrives, automatically pull invited attendees who are already online in the meeting's KaiSpace room straight into the "Meeting Area" (Zone) designated for that meeting — no manual click, no consent prompt. Meeting organizers can optionally set a password on the meeting; anyone who isn't an invited attendee must enter it before they can walk/teleport into that Zone while the meeting is in progress.

## Context

Investigation before this design found two systems that don't currently talk to each other:

- **`CalendarEvent`** already has `start`/`end`, `attendees` (`EventAttendee`, keyed by `userId`), recurrence (`rrule`), and a `meetkaiRoomSlug` field — but `meetkaiRoomSlug` is **never actually settable**: the event create/edit routes (`server/src/routes/calendar.ts`) only accept `roomId`, which points at `MeetingRoom` (a generic bookable resource — name/capacity/equipment, unrelated to a real KaiSpace room). `EventPanel.tsx`'s form has no KaiSpace-room picker at all today.
- **Zones** (`shared/types/index.ts`'s `Zone`, `type: 'meeting' | 'desk' | 'focus' | 'general'`) are the actual physical areas inside a KaiSpace `Room` — stored as JSON inside `Room.zones`/`layerData`, not their own DB table. There's no link from a `CalendarEvent` to a `Zone` today.

Also relevant precedent found and reused by this design:

- **`reminderSweep.ts`** — the existing 60s-tick sweep that fires notifications near a `CalendarEvent`'s scheduled time, using a shared `expandOccurrences` helper for recurrence and a `lastFiredFor`-style per-occurrence dedup column. This design's own sweep reuses `expandOccurrences` and mirrors the same dedup pattern, but is a **separate file** (a different trigger — the event's own `start`, not a configurable reminder offset — and a very different action: force-moving players, not sending a notification).
- **Summon / `FORCE_PULL`** (`roomHandler.ts`) — existing precedent for moving another player's avatar, broadcast as `PLAYER_TELEPORTED`. `FORCE_PULL` specifically is the no-consent variant this design's auto-join reuses the shape of.
- **`findZoneEntryTile`** (`shared/tileCollision.ts`) — already used by the "Team Locations" auto-provisioning feature to compute a walkable point inside a Zone. Reused here to land an auto-pulled attendee somewhere real, not just the Zone's raw corner.
- **Zone Lock** (`zoneLock.ts`, `ZONE_ENTER`/`ZONE_LOCKED_DENIED` in `zoneHandler.ts`) — an existing, different "keep people out of a zone" mechanism: a live keyholder manually locks a zone and approves knocks one at a time. Considered and **not reused** for the password gate — a scheduled, automated meeting has no live keyholder to approve knocks, which is exactly the gap a password (checked automatically, no human approval needed) fills instead. The two systems stay independent, same as Zone Lock already is from the room-wide lock.
- **Door password** (`doorPasswordEnabled`/`doorPassword` on `RoomTile`/`DoorAreaRect`, `server/src/socket/doorLock.ts`, `InteractiveObjectModal.tsx`) — precedent for a plaintext password stored alongside the thing it protects, an in-memory per-socket unlock set (cleared on disconnect), and the client-side password-prompt modal this design reuses.

## Scope (confirmed with user)

- The "Meeting Area" Zone is picked **from within the event's own selected KaiSpace room** — not a free-standing picker across every room in the org.
- Auto-teleport is **unconditional force-move**, no consent step, no exceptions for what the target is currently doing (mirrors `FORCE_PULL`).
- **Every** registered attendee counts, regardless of RSVP status (pending/declined attendees are still pulled if online in the right room — same as accepted ones). Simpler than filtering by RSVP, and matches "you were invited, the meeting is happening" over-strict-by-default posture.
- An attendee who is online but **not currently in the meeting's KaiSpace room** (different room, or still in the Lobby) is **not** force-moved across rooms — they get a notification instead (reusing the existing notify-a-user mechanism `reminderSweep.ts` already calls), and join manually. Same for anyone fully offline at the trigger moment.
- The KaiSpace-room picker in `EventPanel.tsx` is being **built from scratch** as part of this feature (confirmed explicitly — it doesn't exist yet, this isn't just "add a Zone dropdown on top of an existing room selection").
- Password gate applies **only to non-attendees**; invited attendees (including the auto-pulled ones) never see a password prompt for their own meeting.
- Password is active **only during the event's `[start, end]` window** for that occurrence; outside that window the Zone is unrestricted like any other.
- A correct password unlocks the Zone for that **session only** (same as door passwords) — a reconnect or leaving-and-rejoining the room re-prompts.

## Design

### 1. Data model

Additive changes to `CalendarEvent` (`server/prisma/schema.prisma`):

```prisma
model CalendarEvent {
  // ...existing fields...
  meetkaiZoneId          String?   // Zone.id within meetkaiRoomSlug's Room.zones — not a DB FK, Zones aren't their own table
  meetkaiPassword         String?   // plaintext, same posture as door passwords — optional, privacy not high-security
  lastAutoJoinFiredFor    String?   // ISO timestamp of the last occurrence's start this event's auto-join sweep already fired for
}
```

`meetkaiRoomSlug` already exists on the model — this feature is what finally gives it a real write path (Section 4).

No new table: attendee membership for the password-exemption check reads the existing `EventAttendee` rows directly (`where: { eventId, userId }`).

### 2. Auto-teleport sweep (server)

New file `server/src/socket/meetingAutoJoinSweep.ts`, structurally parallel to `reminderSweep.ts`:

- `startMeetingAutoJoinSweep(io: Server)`, `setInterval` every 60s (`TICK_MS`, matches `reminderSweep.ts`'s own cadence).
- Each tick: query `CalendarEvent` rows with `meetkaiRoomSlug` and `meetkaiZoneId` both set, `end >= now` (skip anything already fully over). For each, expand recurrence via the same `expandOccurrences` helper `reminderSweep.ts` already imports, and find any occurrence whose `start` has just crossed into the past (`start <= now`) and whose key doesn't match `lastAutoJoinFiredFor` yet.
- On a match: load `EventAttendee` rows for that event. For each attendee, look up their live socket via the room's connected-players registry (same lookup shape `findSocketByUserId` in `seatClaim.ts` already uses) scoped to `meetkaiRoomSlug` specifically:
  - **Online + in that room**: compute a landing tile via `findZoneEntryTile`, force-move via the same `PLAYER_TELEPORTED` broadcast `FORCE_PULL`/`SUMMON_RESPOND` already use, plus a targeted toast to just that socket ("Kamu ditarik ke meeting: {title}").
  - **Online elsewhere, or offline**: send the existing notify-a-user call (`notify(prisma, userId, ...)`, the same helper `calendar.ts`'s event-create handler already uses for invite notifications) with a "meeting dimulai" message. No retry/catch-up later — matches the confirmed "if you weren't there at the moment, you just get told, you don't get auto-pulled in late."
- Update `lastAutoJoinFiredFor` to this occurrence's key immediately after processing, so the next tick (60s later, meeting almost certainly still running) doesn't re-fire and yank anyone back who deliberately left.

### 3. Password gate (server)

Extends `zoneHandler.ts`'s existing `ZONE_ENTER` handler with one more check, after the existing lock/member-only/capacity checks:

- Look up whether `zoneId` is `meetkaiZoneId` for any `CalendarEvent` in this room with `meetkaiPassword` set and `now` inside `[start, end]` for the current occurrence (small indexed query — `ZONE_ENTER` isn't a hot per-frame path the way movement is, so no dedicated cache needed, matching this handler's existing per-call DB-free posture for its other checks... except this one query, which is acceptable at this call frequency).
- If such an event exists:
  - `EventAttendee` row exists for `(eventId, userId)` → allowed, no password needed.
  - Otherwise, check a new in-memory per-socket unlock set — `unlockedMeetingZones: Map<socketId, Set<zoneId>>` in a new small module (or added to `doorLock.ts` directly, mirroring its existing `unlockedDoors`/`unlockedDoorAreas` maps and their disconnect-clearing) — not yet unlocked → deny with a new `ZONE_PASSWORD_REQUIRED` event (`{ zoneId, eventTitle }`), same shape family as `ZONE_LOCKED_DENIED`.
- New `ZONE_PASSWORD_SUBMIT` handler: `{ zoneId, password }` → re-resolve the same active event + compare plaintext → on match, add to the unlock set and let the client's retried `ZONE_ENTER` through; on mismatch, re-emit `ZONE_PASSWORD_REQUIRED` with a wrong-password flag.

### 4. Client

**`EventPanel.tsx`** (event create/edit form) gains, after the existing fields:

- **"Room KaiSpace"** `<select>` — fetches from the existing `GET /rooms` (already used by `Lobby.tsx`, already open to any authenticated org member — no new endpoint needed here).
- **"Meeting Area"** `<select>` — enabled once a room is chosen, populated from a **new** endpoint `GET /rooms/:slug/zones` (returns only `type === 'meeting'` zones' `{id, name}`; deliberately NOT the existing admin-gated `/rooms/:slug/editor-data`, which requires `room:update` — this needs to be readable by any member filling out a meeting invite).
- **"Password (opsional)"** text input — shown once a Meeting Area is selected; saved/edited through the same event create/edit request as everything else in this form.

**New password-prompt component** for `ZONE_PASSWORD_REQUIRED` — reuses `InteractiveObjectModal.tsx` (the same component the door-password prompt already uses), wired in `App.tsx`/`GameCanvas.tsx` next to the existing `handleDoorPasswordTrigger`/`handleCheckDoorPassword` wiring, submitting via `ZONE_PASSWORD_SUBMIT`.

Auto-teleport itself needs no new client UI beyond what `PLAYER_TELEPORTED` and the existing toast system already render — the sweep's targeted toast (Section 2) reuses `showToast`.

## Error handling

- Sweep tick failures (a bad `rrule`, a DB hiccup) are caught and logged per-event inside the tick loop, same as `reminderSweep.ts` — one bad event never stops the rest of the tick from processing.
- A `meetkaiRoomSlug`/`meetkaiZoneId` pointing at a room or Zone that's since been deleted/renamed is treated as "nothing to do" (skip silently) rather than erroring the whole tick — matches this codebase's general posture of never letting stale references crash a sweep.
- Password mismatch is a normal, expected response (`ZONE_PASSWORD_REQUIRED` with a flag), never a 500/error path.

## Out of scope

- RSVP-based filtering of who gets pulled (every attendee counts, per the confirmed decision).
- Cross-room auto-move (notification only, per the confirmed decision).
- Any change to `MeetingRoom` (the generic bookable-resource concept) — entirely separate from this feature's "Room KaiSpace" + "Meeting Area" pickers.
- Reusing/extending Zone Lock for this — considered and rejected (no live keyholder for an automated trigger).
- Hashing the meeting password — kept plaintext, consistent with the existing door-password precedent's threat model (casual privacy, not access control against a determined attacker).
- Any catch-up/late-join auto-pull for attendees who come online after the sweep already fired for that occurrence.
