# Calendar Meeting Auto-Teleport + Optional Password Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a scheduled Calendar meeting's start time arrives, force-teleport invited attendees who are already online in the meeting's KaiSpace room into the designated Meeting Area (Zone); let organizers optionally set a password that gates non-attendees from walking into that Zone while the meeting is in progress.

**Architecture:** Additive Prisma columns on `CalendarEvent`; a new 60s-tick server sweep (`meetingAutoJoinSweep.ts`) mirroring the existing `reminderSweep.ts` pattern for recurrence-aware "did we just cross this occurrence's start" detection, reusing `PLAYER_TELEPORTED`/`FORCE_PULL`'s exact broadcast shape to move players; one new check inserted into the existing `ZONE_ENTER` handler for the password gate, reusing the existing per-socket in-memory unlock-Map pattern from `doorLock.ts` and the `InteractiveObjectModal` component (via the same synthetic-`Furniture`-adapter trick the door password feature already uses) for the client prompt; three new form fields in `EventPanel.tsx`, the last of which needs a new lightweight, non-admin-gated `GET /rooms/:slug/zones` endpoint.

**Tech Stack:** TypeScript, Express, Socket.IO, Prisma/Postgres, React, Zustand, Luxon (recurrence math via the existing `expandOccurrences` shared helper).

## Global Constraints

- Auto-teleport is unconditional force-move — no consent step, no exceptions for what the target is currently doing (mirrors `FORCE_PULL`).
- Every registered `EventAttendee` counts, regardless of `rsvp` status — no RSVP filtering.
- An attendee online but NOT in the meeting's own `meetkaiRoomSlug` room (different room, or the Lobby) is never force-moved across rooms — notified only. Same for anyone offline at the trigger moment. No later catch-up pull for stragglers who come online after the sweep already fired for that occurrence.
- The KaiSpace-room picker in `EventPanel.tsx` is being built from scratch — `meetkaiRoomSlug` has no write path anywhere today.
- The password gate applies ONLY to non-attendees. Invited attendees — including auto-pulled ones — never see a password prompt for their own meeting.
- Password is active only during the event occurrence's own `[start, end]` window; the Zone is unrestricted outside it.
- A correct password unlocks the Zone for that session only (same as door passwords — a reconnect re-prompts).
- The meeting password stays plaintext, consistent with the existing door-password precedent — not hashed.
- Do NOT reuse or extend the existing Zone Lock (`zoneLock.ts`) system for this — it needs a live keyholder to approve knocks, which an automated scheduled trigger doesn't have. Keep the two systems independent.
- Do NOT add RSVP-based filtering, and do NOT add any catch-up/late-join auto-pull.

---

### Task 1: Schema — `CalendarEvent` additive columns + migration

**Files:**
- Modify: `server/prisma/schema.prisma:745-789` (`CalendarEvent` model)
- Create: `server/prisma/migrations/<timestamp>_calendar_meeting_auto_join/migration.sql`

**Interfaces:**
- Produces: `CalendarEvent.meetkaiZoneId: string | null`, `CalendarEvent.meetkaiPassword: string | null`, `CalendarEvent.lastAutoJoinFiredFor: Date | null` — consumed by every later task.

- [ ] **Step 1: Add the three columns to the Prisma schema**

In `server/prisma/schema.prisma`, inside the `CalendarEvent` model, the current tail looks like this:

```prisma
  organizerId     String
  organizer       User    @relation("EventOrganizer", fields: [organizerId], references: [id], onDelete: Cascade)
  visibility      String  @default("default") // default | private
  // Link back to a MeetKai room session started from this event.
  meetkaiRoomSlug String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
```

Change it to:

```prisma
  organizerId     String
  organizer       User    @relation("EventOrganizer", fields: [organizerId], references: [id], onDelete: Cascade)
  visibility      String  @default("default") // default | private
  // Link back to a MeetKai room session started from this event.
  meetkaiRoomSlug String?
  // Zone.id (within meetkaiRoomSlug's Room.zones JSON — not a DB FK, Zones
  // aren't their own table) this event's participants get auto-pulled into
  // at start time. Null = no auto-join configured for this event.
  meetkaiZoneId   String?
  // Optional, plaintext (same posture as door passwords — casual privacy,
  // not access control against a determined attacker). Gates non-attendees
  // from walking into meetkaiZoneId while this occurrence is in progress;
  // invited attendees never see this prompt. Null = zone unrestricted.
  meetkaiPassword String?
  // Set once meetingAutoJoinSweep.ts has force-pulled attendees for a given
  // occurrence, to the occurrence's own start instant — same per-occurrence
  // dedup shape as EventReminder.lastFiredFor, needed because a recurring
  // event's occurrences each need their own independent "already fired".
  lastAutoJoinFiredFor DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
```

- [ ] **Step 2: Write the migration SQL by hand**

Local Docker access is unreliable on this machine — `npx prisma migrate dev` may not be runnable directly. Follow this session's established convention: hand-author the migration SQL, then verify it against the local dev Postgres container.

Find the most recent migration folder name to confirm the naming/timestamp convention:

```bash
ls server/prisma/migrations | tail -5
```

Create `server/prisma/migrations/<next-timestamp>_calendar_meeting_auto_join/migration.sql` (timestamp format `YYYYMMDDHHMMSS`, one later than the most recent existing migration) with:

```sql
-- AlterTable
ALTER TABLE "CalendarEvent" ADD COLUMN "meetkaiZoneId" TEXT;
ALTER TABLE "CalendarEvent" ADD COLUMN "meetkaiPassword" TEXT;
ALTER TABLE "CalendarEvent" ADD COLUMN "lastAutoJoinFiredFor" TIMESTAMP(3);
```

- [ ] **Step 3: Apply and verify against the local dev Postgres container**

```bash
docker exec -i <local-postgres-container> psql -U postgres -d virtualmeet -c '\d "CalendarEvent"'
```

Confirm the three new columns are NOT yet present, then apply:

```bash
cd server && npx prisma migrate deploy
```

(If local Docker/Prisma CLI access is genuinely unavailable, apply the SQL directly: `docker exec -i <local-postgres-container> psql -U postgres -d virtualmeet -f server/prisma/migrations/<new-folder>/migration.sql`.)

Re-run `\d "CalendarEvent"` and confirm `meetkaiZoneId` (text), `meetkaiPassword` (text), `lastAutoJoinFiredFor` (timestamp) are now present, all nullable.

- [ ] **Step 4: Regenerate the Prisma client**

```bash
cd server && npx prisma generate
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck --workspace=server
```

Expected: PASS (no code references the new columns yet — this just confirms the generated client itself compiles).

- [ ] **Step 6: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations
git commit -m "feat: add CalendarEvent.meetkaiZoneId/meetkaiPassword/lastAutoJoinFiredFor"
```

---

### Task 2: Server — `calendar.ts` routes + new `GET /rooms/:slug/zones`

**Files:**
- Modify: `server/src/routes/calendar.ts:213-282` (`POST /calendars/:calendarId/events`), `server/src/routes/calendar.ts:288-380`-ish (`PATCH /calendars/events/:eventId` — read the current full handler before editing, its exact line range may have shifted)
- Modify: `server/src/routes/rooms.ts` (add new `GET /rooms/:slug/zones` route, modeled on the existing `GET /rooms/:slug` at `rooms.ts:115-146`)

**Interfaces:**
- Consumes: `CalendarEvent.meetkaiZoneId`/`meetkaiPassword` from Task 1.
- Produces: `POST`/`PATCH` event bodies now accept `meetkaiRoomSlug`, `meetkaiZoneId`, `meetkaiPassword`; the events-list/get responses include them; `GET /rooms/:slug/zones` returns `{ zones: { id: string; name: string }[] }` (only `type === 'meeting'` zones) — consumed by Task 5's client fetch.

- [ ] **Step 1: Add the new endpoint to `rooms.ts`**

Read `server/src/routes/rooms.ts:115-146` first to confirm the exact current shape of `GET /rooms/:slug` (it may have shifted slightly). Add a new route directly after it:

```typescript
// GET /api/rooms/:slug/zones — lightweight, read-only list of this room's
// 'meeting'-type Zones, for the Calendar event form's Meeting Area picker.
// Deliberately NOT admin-gated like /rooms/:slug/editor-data (room:update) —
// any org member scheduling a meeting needs to read this, not just admins.
rooms.get('/rooms/:slug/zones', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
    const prisma = getPrisma();
    const room = await prisma.room.findUnique({
      where: { slug: req.params.slug },
      select: { organizationId: true, zones: true },
    });
    if (!room || room.organizationId !== req.organizationId) {
      return res.status(404).json({ error: 'Room not found' });
    }
    const zones = (Array.isArray(room.zones) ? room.zones : []) as unknown as { id: string; name: string; type?: string }[];
    return res.json({
      zones: zones.filter((z) => z.type === 'meeting').map((z) => ({ id: z.id, name: z.name })),
    });
  } catch (err) {
    console.error('[rooms] zones error:', err);
    return res.status(500).json({ error: 'Failed to get zones' });
  }
});
```

- [ ] **Step 2: Update `POST /calendars/:calendarId/events` to accept the new fields**

In `server/src/routes/calendar.ts`, find the `eventData` object being built (currently around line 235-255). Its current shape:

```typescript
    const eventData = {
      calendarId: req.params.calendarId, title,
      description: req.body?.description ? String(req.body.description).slice(0, 4000) : null,
      start, end,
      allDay: !!req.body?.allDay,
      timezone: String(req.body?.timezone ?? 'Asia/Jakarta'),
      location: req.body?.location ? String(req.body.location).slice(0, 200) : null,
      roomId, rrule: rule,
      organizerId: req.userId!,
      visibility: req.body?.visibility === 'private' ? 'private' : 'default',
      attendees: {
        create: (Array.isArray(req.body?.attendeeIds) ? req.body.attendeeIds : [])
          .filter((id: unknown) => typeof id === 'string' && id !== req.userId)
          .map((userId: string) => ({ userId })),
      },
      reminders: {
        create: (Array.isArray(req.body?.reminders) ? req.body.reminders : [])
          .filter((m: unknown) => Number.isFinite(m))
          .map((minutesBefore: number) => ({ minutesBefore: Math.max(0, Math.floor(minutesBefore)) })),
      },
    };
```

Change to:

```typescript
    const meetkaiRoomSlug = req.body?.meetkaiRoomSlug ? String(req.body.meetkaiRoomSlug).slice(0, 200) : null;
    const meetkaiZoneId = meetkaiRoomSlug && req.body?.meetkaiZoneId ? String(req.body.meetkaiZoneId).slice(0, 200) : null;
    const meetkaiPassword = meetkaiZoneId && req.body?.meetkaiPassword ? String(req.body.meetkaiPassword).slice(0, 200) : null;

    const eventData = {
      calendarId: req.params.calendarId, title,
      description: req.body?.description ? String(req.body.description).slice(0, 4000) : null,
      start, end,
      allDay: !!req.body?.allDay,
      timezone: String(req.body?.timezone ?? 'Asia/Jakarta'),
      location: req.body?.location ? String(req.body.location).slice(0, 200) : null,
      roomId, rrule: rule,
      organizerId: req.userId!,
      visibility: req.body?.visibility === 'private' ? 'private' : 'default',
      meetkaiRoomSlug, meetkaiZoneId, meetkaiPassword,
      attendees: {
        create: (Array.isArray(req.body?.attendeeIds) ? req.body.attendeeIds : [])
          .filter((id: unknown) => typeof id === 'string' && id !== req.userId)
          .map((userId: string) => ({ userId })),
      },
      reminders: {
        create: (Array.isArray(req.body?.reminders) ? req.body.reminders : [])
          .filter((m: unknown) => Number.isFinite(m))
          .map((minutesBefore: number) => ({ minutesBefore: Math.max(0, Math.floor(minutesBefore)) })),
      },
    };
```

(A password with no zone selected, or a zone with no room selected, is silently dropped rather than rejected — matches this route's existing "clamp/ignore malformed optional input" posture elsewhere in the same handler, e.g. `roomId`/`rrule`.)

- [ ] **Step 3: Update `PATCH /calendars/events/:eventId` the same way**

The handler (`server/src/routes/calendar.ts:288-378`) has THREE places that write event fields: the `patch` object used directly for scope `'all'`/non-recurring, and two separate `data` objects built explicitly field-by-field for scope `'this'` (an override row) and `'thisAndFollowing'` (a new split-off master) — `roomId` in those last two is currently just copied unchanged from `row.roomId` (not actually patchable in those scopes today; don't copy that gap for the new fields — a user editing a single occurrence's Room/Zone/Password from `EventPanel.tsx` needs it to actually apply).

In the `patch` object (currently ends after the `visibility` line, `calendar.ts:301-304`):

```typescript
    if (req.body?.title !== undefined) patch.title = String(req.body.title).slice(0, 200);
    if (req.body?.description !== undefined) patch.description = req.body.description ? String(req.body.description).slice(0, 4000) : null;
    if (req.body?.location !== undefined) patch.location = req.body.location ? String(req.body.location).slice(0, 200) : null;
    if (req.body?.visibility !== undefined) patch.visibility = req.body.visibility === 'private' ? 'private' : 'default';
    if (req.body?.meetkaiRoomSlug !== undefined) patch.meetkaiRoomSlug = req.body.meetkaiRoomSlug ? String(req.body.meetkaiRoomSlug).slice(0, 200) : null;
    if (req.body?.meetkaiZoneId !== undefined) patch.meetkaiZoneId = req.body.meetkaiZoneId ? String(req.body.meetkaiZoneId).slice(0, 200) : null;
    if (req.body?.meetkaiPassword !== undefined) patch.meetkaiPassword = req.body.meetkaiPassword ? String(req.body.meetkaiPassword).slice(0, 200) : null;
```

(This alone covers scope `'all'`/non-recurring — that branch does `prisma.calendarEvent.update({ where: { id: row.id }, data: patch })` with `patch` used as-is.)

In the scope `'this'` override-row `data` object (`calendar.ts:331-346`), add three lines right after `roomId: row.roomId,`:

```typescript
          roomId: row.roomId,
          meetkaiRoomSlug: 'meetkaiRoomSlug' in patch ? (patch.meetkaiRoomSlug as string | null) : row.meetkaiRoomSlug,
          meetkaiZoneId: 'meetkaiZoneId' in patch ? (patch.meetkaiZoneId as string | null) : row.meetkaiZoneId,
          meetkaiPassword: 'meetkaiPassword' in patch ? (patch.meetkaiPassword as string | null) : row.meetkaiPassword,
```

(Uses `'x' in patch` rather than `(patch.x as ...) ?? row.x` deliberately — the latter, which the surrounding `description`/`location` lines already use, silently falls back to the OLD value when the new value is an explicit `null` — e.g. clearing the password — since `null ?? row.x` evaluates to `row.x`. That's a pre-existing quirk in this handler's other fields; don't copy it into these three brand-new ones.)

Same three lines, same position (right after `roomId: row.roomId,`), in the scope `'thisAndFollowing'` new-master `data` object (`calendar.ts:357-372`).

- [ ] **Step 4: Expose the new fields on read**

`GET /calendars/events`' `EventRow` interface (`calendar.ts:105-113`) currently ends:

```typescript
  recurrenceId: Date | null; exdates: Date[]; organizerId: string; visibility: string;
  meetkaiRoomSlug: string | null;
  attendees: { userId: string; rsvp: string; optional: boolean; user: { displayName: string } }[];
  room: { id: string; name: string } | null;
}
```

Change to:

```typescript
  recurrenceId: Date | null; exdates: Date[]; organizerId: string; visibility: string;
  meetkaiRoomSlug: string | null;
  meetkaiZoneId: string | null;
  meetkaiPassword: string | null;
  attendees: { userId: string; rsvp: string; optional: boolean; user: { displayName: string } }[];
  room: { id: string; name: string } | null;
}
```

(No `select`/`include` change needed for the query itself — it already fetches every scalar column, so the two new columns arrive automatically once Task 1's migration exists; this interface is only a TypeScript view over what's already there.)

In `serialise()`'s `detailed` return block (`calendar.ts:140-149`), currently:

```typescript
  return {
    ...base,
    title: row.title,
    description: row.description,
    location: row.location,
    roomId: row.roomId,
    roomName: row.room?.name ?? null,
    visibility: row.visibility,
    meetkaiRoomSlug: row.meetkaiRoomSlug,
    attendees: row.attendees.map((a) => ({ userId: a.userId, name: a.user.displayName, rsvp: a.rsvp, optional: a.optional })),
```

Change to:

```typescript
  return {
    ...base,
    title: row.title,
    description: row.description,
    location: row.location,
    roomId: row.roomId,
    roomName: row.room?.name ?? null,
    visibility: row.visibility,
    meetkaiRoomSlug: row.meetkaiRoomSlug,
    meetkaiZoneId: row.meetkaiZoneId,
    meetkaiPassword: row.meetkaiPassword,
    attendees: row.attendees.map((a) => ({ userId: a.userId, name: a.user.displayName, rsvp: a.rsvp, optional: a.optional })),
```

(Only reached when `detailed` is true — the earlier `!detailed` branch already returns a stripped `{ ...base, title: 'Sibuk', busyOnly: true }` with none of this, so a viewer who can't see this event's details never sees its password either. `detailed` requires being the organizer, an attendee, or a calendar role with visibility into it — the same people `EventPanel.tsx`'s `canEdit` gate already requires to edit the event in the first place, so this matches the door-password precedent's spirit without needing a SEPARATE redaction pass the way `doorPassword` gets — a door is walked into by people with no relationship to whoever set it; a calendar event's password is only ever serialised to people who already have standing to see the rest of the event.)

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck --workspace=server
```

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/calendar.ts server/src/routes/rooms.ts
git commit -m "feat: accept/expose meetkaiRoomSlug/meetkaiZoneId/meetkaiPassword on calendar events, add GET /rooms/:slug/zones"
```

---

### Task 3: Server — `meetingAutoJoinSweep.ts` (new file)

**Files:**
- Create: `server/src/socket/meetingAutoJoinSweep.ts`
- Modify: wherever `startReminderSweep(io)` is currently called from server startup (search `startReminderSweep(` to find the exact call site — likely `server/src/index.ts`) to add the new sweep's own start call alongside it.

**Interfaces:**
- Consumes: `CalendarEvent.meetkaiRoomSlug`/`meetkaiZoneId`/`lastAutoJoinFiredFor` (Task 1), `expandOccurrences` (`@virtualmeet/shared`), `findZoneEntryTile` (`@virtualmeet/shared`), `getPlayers`/`updatePlayerPosition` (`../store/roomStore`), `getCachedTiles` (`../store/roomStore`), `isZoneLocked`/`admitUserToZone` (`./zoneLock`).
- Produces: `startMeetingAutoJoinSweep(io: Server, intervalMs?: number): void`, and a new `SocketEvents.MEETING_AUTO_JOINED = 'meeting:auto_joined'` (client-facing, `{ title: string }`) — consumed by Task 6.

- [ ] **Step 1: Add the new SocketEvents entry**

In `shared/types/index.ts`, near the other single-purpose notice-style events (e.g. next to `FORCE_PULLED`), add:

```typescript
  // A CalendarEvent's meetingAutoJoinSweep.ts fired for its own target —
  // told directly to this one socket, distinct from the room-wide
  // PLAYER_TELEPORTED broadcast everyone else's client also receives.
  MEETING_AUTO_JOINED = 'meeting:auto_joined',
```

- [ ] **Step 2: Write `meetingAutoJoinSweep.ts`**

```typescript
import { Server } from 'socket.io';
import { getPrisma } from '../lib/prisma';
import { SocketEvents, expandOccurrences, findZoneEntryTile, TILE_SIZE } from '@virtualmeet/shared';
import { getPlayers, updatePlayerPosition, getCachedTiles } from '../store/roomStore';
import { isZoneLocked, admitUserToZone } from './zoneLock';

// Calendar meeting auto-join. Structurally parallel to reminderSweep.ts (same
// tick/expand/dedup shape) but a different trigger — an occurrence's own
// `start` crossing into the past, not a configurable reminder offset — and a
// very different action: force-moving players, not sending a notification.
// Kept in its own file rather than folded into reminderSweep.ts so the two
// concerns (notify vs. force-move) stay independently reviewable.

const TICK_MS = 60 * 1000;
const LOOKAHEAD_DAYS = 8; // same rationale as reminderSweep.ts's own constant

export function startMeetingAutoJoinSweep(io: Server, intervalMs = TICK_MS): void {
  setInterval(async () => {
    try {
      const prisma = getPrisma();
      const now = new Date();
      const horizon = new Date(now.getTime() + LOOKAHEAD_DAYS * 86400000);

      const events = await prisma.calendarEvent.findMany({
        where: { meetkaiRoomSlug: { not: null }, meetkaiZoneId: { not: null }, end: { gte: now } },
        select: {
          id: true, title: true, start: true, end: true, timezone: true, rrule: true, exdates: true,
          meetkaiRoomSlug: true, meetkaiZoneId: true, lastAutoJoinFiredFor: true,
          attendees: { select: { userId: true } },
        },
      });
      if (!events.length) return;

      let fired = 0;
      for (const ev of events) {
        const room = ev.meetkaiRoomSlug!;
        const zoneId = ev.meetkaiZoneId!;

        const occurrences = expandOccurrences(
          { start: ev.start, end: ev.end, timezone: ev.timezone, rrule: ev.rrule, exdates: ev.exdates },
          new Date(now.getTime() - 60 * 60 * 1000), // small back-window, same as reminderSweep.ts, so a restart doesn't skip one
          horizon,
        );

        // The occurrence whose start JUST crossed into the past, that hasn't
        // been fired for yet. Unlike reminderSweep.ts (which fires ahead of
        // start, for a reminder), this only ever wants the occurrence that
        // has *just* started — not any future one still ahead.
        const due = occurrences.find((occ) =>
          occ.start <= now &&
          (!ev.lastAutoJoinFiredFor || ev.lastAutoJoinFiredFor.getTime() !== occ.start.getTime()),
        );
        if (!due) continue;

        try {
          const players = await getPlayers(room);
          const tiles = getCachedTiles(room);
          const landing = tiles && tiles.length > 0 ? await findZoneEntryTileForRoom(tiles, room, zoneId) : null;

          for (const attendee of ev.attendees) {
            const player = players.find((p) => p.userId === attendee.userId);
            if (!player) continue; // not online in this room right now — notified below instead
            const targetSocket = io.sockets.sockets.get(player.id);
            if (!targetSocket) continue; // stale Avatar record, socket already gone

            if (isZoneLocked(room, zoneId)) admitUserToZone(room, zoneId, attendee.userId);

            const landX = landing ? landing.x * TILE_SIZE + TILE_SIZE / 2 : player.x;
            const landY = landing ? landing.y * TILE_SIZE + TILE_SIZE / 2 : player.y;
            await updatePlayerPosition(room, targetSocket.id, landX, landY, 'down');
            io.to(room).emit(SocketEvents.PLAYER_TELEPORTED, { id: targetSocket.id, x: landX, y: landY, direction: 'down' });
            targetSocket.emit(SocketEvents.MEETING_AUTO_JOINED, { title: ev.title });
          }

          // Attendees who weren't found above (offline, or online elsewhere)
          // get a plain in-app notification instead — same inline pattern
          // reminderSweep.ts already uses, not calendar.ts's local (non-exported)
          // notify() helper.
          const pulledUserIds = new Set(ev.attendees.filter((a) => players.some((p) => p.userId === a.userId)).map((a) => a.userId));
          for (const attendee of ev.attendees) {
            if (pulledUserIds.has(attendee.userId)) continue;
            await prisma.notification.create({
              data: { recipientId: attendee.userId, kind: 'workspace', body: `"${ev.title}" sudah dimulai.` },
            });
            io.to(`user:${attendee.userId}`).emit('base:notif', {});
          }
        } catch (e) {
          console.error(`[meetingAutoJoin] failed processing event ${ev.id}:`, e);
        }

        await prisma.calendarEvent.update({ where: { id: ev.id }, data: { lastAutoJoinFiredFor: due.start } });
        fired++;
      }
      if (fired) console.log(`[meetingAutoJoin] sweep fired ${fired} event(s)`);
    } catch (e) {
      console.error('[meetingAutoJoin] sweep error:', e);
    }
  }, intervalMs);
}

// findZoneEntryTile needs the Zone's own x/y/width/height (from Room.zones),
// not just its id — a small DB read, acceptable at this call frequency (once
// per due occurrence, not per tick). Returns null if the zone can no longer
// be found (deleted/renamed since the event was created) — the sweep still
// fires (using the player's own current position as a no-op landing spot)
// rather than skipping the attendee entirely.
async function findZoneEntryTileForRoom(
  tiles: import('@virtualmeet/shared').RoomTile[][],
  room: string,
  zoneId: string,
): Promise<{ x: number; y: number } | null> {
  const prisma = getPrisma();
  const dbRoom = await prisma.room.findUnique({ where: { slug: room }, select: { zones: true } });
  const zones = (Array.isArray(dbRoom?.zones) ? dbRoom!.zones : []) as unknown as { id: string; x: number; y: number; width: number; height: number }[];
  const zone = zones.find((z) => z.id === zoneId);
  if (!zone) return null;
  return findZoneEntryTile(tiles, zone);
}
```

- [ ] **Step 3: Wire the sweep into server startup**

Find the existing `startReminderSweep(io)` call site:

```bash
grep -rn "startReminderSweep(" server/src/
```

Read that file around the call site and add, immediately after it:

```typescript
import { startMeetingAutoJoinSweep } from './socket/meetingAutoJoinSweep'; // adjust the relative path to match this file's own existing reminderSweep import
// ...
startMeetingAutoJoinSweep(io);
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck --workspace=server
```

- [ ] **Step 5: Commit**

```bash
git add server/src/socket/meetingAutoJoinSweep.ts shared/types/index.ts <the file with the new startMeetingAutoJoinSweep call>
git commit -m "feat: auto-pull online attendees into a meeting's Zone when it starts"
```

---

### Task 4: Server — Zone password gate

**Files:**
- Modify: `server/src/socket/zoneHandler.ts` (the `ZONE_ENTER` handler)
- Modify: `server/src/socket/doorLock.ts` (add the zone-password unlock functions)

**Interfaces:**
- Consumes: `CalendarEvent.meetkaiZoneId`/`meetkaiPassword` (Task 1).
- Produces: `SocketEvents.ZONE_PASSWORD_REQUIRED` (`{ zoneId: string; eventTitle: string }`), `SocketEvents.ZONE_PASSWORD_SUBMIT` (client→server, `{ zoneId: string; password: string }`), `SocketEvents.ZONE_PASSWORD_RESULT` (server→client, `{ zoneId: string; correct: boolean }`) — all consumed by Task 6.

- [ ] **Step 1: Add the two new SocketEvents entries**

In `shared/types/index.ts`, next to `ZONE_LOCKED_DENIED` (around line 558):

```typescript
  // A CalendarEvent's optional meetkaiPassword gate — a DIFFERENT mechanism
  // from ZONE_LOCK_SET above (no live keyholder; checked automatically
  // against the event's own stored password during its [start, end] window).
  // Never fires for an invited attendee of that same event — see
  // zoneHandler.ts's ZONE_ENTER.
  ZONE_PASSWORD_REQUIRED = 'zone:password_required',
  ZONE_PASSWORD_SUBMIT = 'zone:password_submit',
  ZONE_PASSWORD_RESULT = 'zone:password_result',
```

- [ ] **Step 2: Add zone-password unlock functions to `doorLock.ts`**

In `server/src/socket/doorLock.ts`, after the existing "Door Area" section (after `unlockDoorArea`, at the end of the file), add:

```typescript
// Meeting Zone password (CalendarEvent.meetkaiPassword) — same per-socket,
// per-session unlock tracking, reusing the SAME underlying map as the door
// functions above (key `${room}:zonepw:${zoneId}`, distinguishable from a
// tile key's `${room}:${x}:${y}` and an area key's `${room}:area:${id}` by
// the literal "zonepw" segment). clearUnlockedDoors/clearUnlockedDoorsForRoom
// above already clear this with no changes needed — both still start with
// the same `${room}:` prefix.
function zonePasswordKey(room: string, zoneId: string): string {
  return `${room}:zonepw:${zoneId}`;
}

export function isZonePasswordUnlocked(socketId: string, room: string, zoneId: string): boolean {
  return unlockedDoors.get(socketId)?.has(zonePasswordKey(room, zoneId)) ?? false;
}

export function unlockZonePassword(socketId: string, room: string, zoneId: string): void {
  let set = unlockedDoors.get(socketId);
  if (!set) { set = new Set(); unlockedDoors.set(socketId, set); }
  set.add(zonePasswordKey(room, zoneId));
}
```

- [ ] **Step 3: Insert the password check into `ZONE_ENTER`**

Read `server/src/socket/zoneHandler.ts`'s current `ZONE_ENTER` handler in full first — confirm the exact current line numbers (they may have shifted from this plan's citations) and the exact point right before `socketZone.set(socket.id, { room, zoneId });` (currently the first line after the restriction/CEO-queue `if` block closes). Insert this new block immediately before that line:

```typescript
    // Meeting Zone password (CalendarEvent.meetkaiPassword) — a DIFFERENT
    // gate from the lock/member-only/capacity checks above: automated
    // (no live keyholder), scoped to a specific event's own [start, end]
    // window, and never applied to that event's own invited attendees.
    const activeMeeting = await getPrisma().calendarEvent.findFirst({
      where: {
        meetkaiRoomSlug: room, meetkaiZoneId: zoneId,
        meetkaiPassword: { not: null },
        start: { lte: new Date() }, end: { gte: new Date() },
      },
      select: { id: true, title: true, meetkaiPassword: true, attendees: { select: { userId: true } } },
    });
    if (activeMeeting) {
      const isAttendee = !!uid && activeMeeting.attendees.some((a) => a.userId === uid);
      if (!isAttendee && !isZonePasswordUnlocked(socket.id, room, zoneId)) {
        socket.emit(SocketEvents.ZONE_PASSWORD_REQUIRED, { zoneId, eventTitle: activeMeeting.title });
        return;
      }
    }

```

Add the two new imports this needs at the top of `zoneHandler.ts`:

```typescript
import { getPrisma } from '../lib/prisma';
import { isZonePasswordUnlocked, unlockZonePassword } from './doorLock';
```

(Check whether `getPrisma` is already imported in this file before adding a duplicate import — it's used elsewhere in `zoneHandler.ts` already per the CEO-queue restriction check, so this import likely already exists; only add `isZonePasswordUnlocked`/`unlockZonePassword`.)

- [ ] **Step 4: Add the `ZONE_PASSWORD_SUBMIT` handler**

In `server/src/socket/zoneHandler.ts`, inside `registerZoneHandlers`, add a new handler after the `ZONE_ENTER` handler closes (before `ZONE_EXIT`):

```typescript
  socket.on(SocketEvents.ZONE_PASSWORD_SUBMIT, async (data: { zoneId: string; password: string }) => {
    if (!currentRoom || typeof data?.zoneId !== 'string' || typeof data?.password !== 'string') return;
    const room = currentRoom;
    const now = new Date();
    const activeMeeting = await getPrisma().calendarEvent.findFirst({
      where: {
        meetkaiRoomSlug: room, meetkaiZoneId: data.zoneId,
        meetkaiPassword: { not: null },
        start: { lte: now }, end: { gte: now },
      },
      select: { meetkaiPassword: true },
    });
    if (!activeMeeting) return; // nothing active to unlock — a stale prompt from before the meeting ended
    const correct = activeMeeting.meetkaiPassword === data.password;
    if (correct) unlockZonePassword(socket.id, room, data.zoneId);
    socket.emit(SocketEvents.ZONE_PASSWORD_RESULT, { zoneId: data.zoneId, correct });
  });
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck --workspace=server
```

- [ ] **Step 6: Commit**

```bash
git add shared/types/index.ts server/src/socket/zoneHandler.ts server/src/socket/doorLock.ts
git commit -m "feat: gate a meeting Zone behind its optional password for non-attendees"
```

---

### Task 5: Client — `EventPanel.tsx` fields + `api.ts`

**Files:**
- Modify: `client/src/components/Calendar/api.ts` (`EventInput`, `CalendarEventDto`, new zones fetcher)
- Modify: `client/src/components/Calendar/EventPanel.tsx` (3 new fields)

**Interfaces:**
- Consumes: `GET /rooms/:slug/zones` (Task 2), the updated `POST`/`PATCH` event bodies (Task 2), `api.getRooms()` (`client/src/services/api.ts`, already exists — returns `{ rooms: RoomInfo[] }`, `RoomInfo { id, name, slug, ... }`).
- Produces: nothing new consumed by later tasks — this is the leaf UI for Tasks 1-4's server work.

- [ ] **Step 1: Add the new fields to `api.ts`'s types**

In `client/src/components/Calendar/api.ts`, update `CalendarEventDto`:

```typescript
export interface CalendarEventDto {
  id: string;
  calendarId: string;
  start: string;
  end: string;
  recurrenceId: string;
  allDay: boolean;
  timezone: string;
  isRecurring: boolean;
  rrule: string | null;
  organizerId: string;
  title: string;
  busyOnly: boolean;
  description?: string | null;
  location?: string | null;
  roomId?: string | null;
  roomName?: string | null;
  visibility?: 'default' | 'private';
  meetkaiRoomSlug?: string | null;
  meetkaiZoneId?: string | null;
  meetkaiPassword?: string | null;
  attendees?: EventAttendeeDto[];
}
```

And `EventInput`:

```typescript
export interface EventInput {
  title: string;
  description?: string | null;
  start: string;
  end: string;
  allDay?: boolean;
  timezone?: string;
  location?: string | null;
  roomId?: string | null;
  rrule?: string | null;
  visibility?: 'default' | 'private';
  attendeeIds?: string[];
  reminders?: number[];
  meetkaiRoomSlug?: string | null;
  meetkaiZoneId?: string | null;
  meetkaiPassword?: string | null;
}
```

And add a new fetcher next to `listRooms`/`roomBusy`:

```typescript
export interface MeetingZoneDto { id: string; name: string }

export const calendarApi = {
  // ...existing entries unchanged...
  listMeetingZones: (roomSlug: string) => req<{ zones: MeetingZoneDto[] }>(`/rooms/${roomSlug}/zones`),
};
```

- [ ] **Step 2: Add the three new fields to `EventPanel.tsx`'s state**

In `client/src/components/Calendar/EventPanel.tsx`, add the new import (alongside the existing `calendarApi` import) and new state, next to the existing `roomId`/`rooms` state (around line 68-69):

```typescript
import { calendarApi, CalendarEventDto, CalendarSummary, MeetingRoomDto, MeetingZoneDto, EventInput, BusyBlock } from './api';
import { api as kaispaceApi, RoomInfo } from '@/services/api';
```

```typescript
  const [roomId, setRoomId] = useState(event?.roomId ?? '');
  const [rooms, setRooms] = useState<MeetingRoomDto[]>([]);
  const [meetkaiRoomSlug, setMeetkaiRoomSlug] = useState(event?.meetkaiRoomSlug ?? '');
  const [kaispaceRooms, setKaispaceRooms] = useState<RoomInfo[]>([]);
  const [meetkaiZoneId, setMeetkaiZoneId] = useState(event?.meetkaiZoneId ?? '');
  const [meetingZones, setMeetingZones] = useState<MeetingZoneDto[]>([]);
  const [meetkaiPassword, setMeetkaiPassword] = useState(event?.meetkaiPassword ?? '');
```

(Confirm the actual client-side alias/import path for the main service — check `client/src/pages/Lobby.tsx`'s own `import { api, RoomInfo } from '@/services/api';` for the exact existing convention and match it; `kaispaceApi` above is only to avoid a name clash with this file's own local `calendarApi` — use whatever alias reads cleanest once both imports are in front of you.)

- [ ] **Step 3: Fetch the KaiSpace room list once, and this event's zones whenever the room changes**

Next to the existing `useEffect(() => { calendarApi.listRooms()... }, [])` (around line 84), add:

```typescript
  useEffect(() => { kaispaceApi.getRooms().then((r) => setKaispaceRooms(r.rooms)).catch(() => { /* optional */ }); }, []);

  // Refetches this room's Meeting Areas whenever the Room selection changes,
  // and drops a stale Zone selection left over from a previously-picked room.
  useEffect(() => {
    if (!meetkaiRoomSlug) { setMeetingZones([]); setMeetkaiZoneId(''); return; }
    calendarApi.listMeetingZones(meetkaiRoomSlug)
      .then((r) => {
        setMeetingZones(r.zones);
        setMeetkaiZoneId((prev) => (r.zones.some((z) => z.id === prev) ? prev : ''));
      })
      .catch(() => setMeetingZones([]));
  }, [meetkaiRoomSlug]);
```

- [ ] **Step 4: Include the new fields in the save payload**

In the `save` function (around line 120-133), the current `input` object:

```typescript
    const input: EventInput = {
      title: title.trim() || 'Tanpa judul',
      description: description || null,
      location: location || null,
      start: startDt.toUTC().toISO()!,
      end: endDt.toUTC().toISO()!,
      timezone: zone,
      roomId: roomId || null,
      rrule,
      visibility,
      attendeeIds,
      reminders,
    };
```

Add the three new fields:

```typescript
    const input: EventInput = {
      title: title.trim() || 'Tanpa judul',
      description: description || null,
      location: location || null,
      start: startDt.toUTC().toISO()!,
      end: endDt.toUTC().toISO()!,
      timezone: zone,
      roomId: roomId || null,
      rrule,
      visibility,
      attendeeIds,
      reminders,
      meetkaiRoomSlug: meetkaiRoomSlug || null,
      meetkaiZoneId: meetkaiRoomSlug && meetkaiZoneId ? meetkaiZoneId : null,
      meetkaiPassword: meetkaiRoomSlug && meetkaiZoneId && meetkaiPassword ? meetkaiPassword : null,
    };
```

- [ ] **Step 5: Add the three new form fields to the JSX**

In `EventPanel.tsx`, the current "Ruang meeting" (MeetingRoom) block:

```typescript
        <div>
          <label className={label} htmlFor="ev-room">Ruang meeting</label>
          <select id="ev-room" value={roomId} onChange={(e) => setRoomId(e.target.value)} disabled={!canEdit} className={field}>
            <option value="">Tidak pakai ruang</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.capacity} orang{r.bookableBy === 'admin' ? ' (admin)' : ''}</option>)}
          </select>
          <p className="text-[10px] text-gray-400 mt-0.5">Bentrok ruang ditolak server, bukan cuma disembunyikan di sini.</p>
        </div>
```

Add immediately after it (still before the "Lokasi" block):

```typescript
        <div>
          <label className={label} htmlFor="ev-kaispace-room">Room KaiSpace</label>
          <select
            id="ev-kaispace-room" value={meetkaiRoomSlug}
            onChange={(e) => setMeetkaiRoomSlug(e.target.value)}
            disabled={!canEdit} className={field}
          >
            <option value="">Tidak pakai auto-join</option>
            {kaispaceRooms.map((r) => <option key={r.slug} value={r.slug}>{r.name}</option>)}
          </select>
        </div>

        {meetkaiRoomSlug && (
          <div>
            <label className={label} htmlFor="ev-meeting-area">Meeting Area</label>
            <select
              id="ev-meeting-area" value={meetkaiZoneId}
              onChange={(e) => setMeetkaiZoneId(e.target.value)}
              disabled={!canEdit} className={field}
            >
              <option value="">Pilih Meeting Area…</option>
              {meetingZones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
            <p className="text-[10px] text-gray-400 mt-0.5">Peserta yang online di room ini otomatis ditarik ke sini saat meeting mulai.</p>
          </div>
        )}

        {meetkaiRoomSlug && meetkaiZoneId && (
          <div>
            <label className={label} htmlFor="ev-meeting-password">Password (opsional)</label>
            <input
              id="ev-meeting-password" type="text" value={meetkaiPassword}
              onChange={(e) => setMeetkaiPassword(e.target.value)}
              readOnly={!canEdit} className={field}
              placeholder="Kosongkan jika tidak private"
            />
            <p className="text-[10px] text-gray-400 mt-0.5">Peserta terundang selalu bisa masuk tanpa password.</p>
          </div>
        )}
```

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck --workspace=client
```

- [ ] **Step 7: Commit**

```bash
git add client/src/components/Calendar/api.ts client/src/components/Calendar/EventPanel.tsx
git commit -m "feat: add Room KaiSpace/Meeting Area/Password fields to the event form"
```

---

### Task 6: Client — Zone password prompt + auto-join notice

**Files:**
- Modify: `client/src/stores/gameStore.ts` (new state for the password prompt result)
- Modify: `client/src/hooks/useSocket.ts` (new event listeners + emit functions)
- Modify: `client/src/App.tsx` (new `InteractiveObjectModal` instance, wired the same way the door-password one is)

**Interfaces:**
- Consumes: `SocketEvents.ZONE_PASSWORD_REQUIRED`/`ZONE_PASSWORD_RESULT`/`MEETING_AUTO_JOINED` (Tasks 3 & 4), `InteractiveObjectModal` (`client/src/components/ui/InteractiveObjectModal.tsx`, unchanged).

- [ ] **Step 1: Add gameStore state for the zone-password prompt**

In `client/src/stores/gameStore.ts`, near `spotlightNotice` (added earlier this session — a good, recent example of this exact "single most-recent X" shape), add:

```typescript
  // Meeting Zone password prompt (ZONE_PASSWORD_REQUIRED) — which zone is
  // currently asking, if any. Cleared once the modal closes (correct
  // password, or the user dismisses it) or a fresh ZONE_PASSWORD_REQUIRED
  // for a DIFFERENT zone replaces it.
  zonePasswordPrompt: { zoneId: string; eventTitle: string } | null;
  setZonePasswordPrompt: (prompt: { zoneId: string; eventTitle: string } | null) => void;
  zonePasswordResult: { zoneId: string; correct: boolean } | null;
  setZonePasswordResult: (result: { zoneId: string; correct: boolean } | null) => void;
```

And in the store implementation, next to `spotlightNotice`'s own implementation:

```typescript
  zonePasswordPrompt: null,
  setZonePasswordPrompt: (prompt) => set({ zonePasswordPrompt: prompt }),
  zonePasswordResult: null,
  setZonePasswordResult: (result) => set({ zonePasswordResult: result }),
```

- [ ] **Step 2: Add socket listeners and emit functions in `useSocket.ts`**

Next to the existing `SPOTLIGHT_CHANGED`/`BROADCAST_RECEIVED` listeners, add:

```typescript
    socket.on(SocketEvents.ZONE_PASSWORD_REQUIRED, (data: { zoneId: string; eventTitle: string }) => {
      useGameStore.getState().setZonePasswordPrompt({ zoneId: data.zoneId, eventTitle: data.eventTitle });
      useGameStore.getState().setZonePasswordResult(null);
    });

    socket.on(SocketEvents.ZONE_PASSWORD_RESULT, (data: { zoneId: string; correct: boolean }) => {
      useGameStore.getState().setZonePasswordResult(data);
      if (data.correct) useGameStore.getState().setZonePasswordPrompt(null);
    });

    // Meeting auto-join — same lightweight activity-feed notice FORCE_PULLED
    // already uses, not a toast (see FORCE_PULLED's own comment for why).
    socket.on(SocketEvents.MEETING_AUTO_JOINED, (data: { title: string }) => {
      useGameStore.getState().addActivity(`📅 Kamu ditarik ke meeting: "${data.title}"`);
    });
```

Next to `emitTeleportTo`/`emitSpotlight`, add the new emit function:

```typescript
  const emitZonePasswordSubmit = useCallback((zoneId: string, password: string) => {
    socketRef.current?.emit(SocketEvents.ZONE_PASSWORD_SUBMIT, { zoneId, password });
  }, []);
```

Add `emitZonePasswordSubmit` to this hook's returned object (find the existing `return { ... emitTeleportTo, emitSpotlight, ... }` at the bottom of the hook and add it there, matching the existing alphabetical-ish grouping if there is one).

- [ ] **Step 3: Wire the modal in `App.tsx`**

Find the door-password wiring (`doorPasswordFurniture`/`doorPasswordResultAdapted`, around line 1334-1368) and the three existing `<InteractiveObjectModal>` render sites (around lines 2340-2370). Read that full render block first to confirm its exact current JSX structure, then add a fourth, following the identical adapter pattern:

```typescript
  const zonePasswordPrompt = useGameStore((s) => s.zonePasswordPrompt);
  const zonePasswordResult = useGameStore((s) => s.zonePasswordResult);

  // Meeting Zone password — same InteractiveObjectModal-reuse trick as the
  // door password adapters above, adapting the prompt into the same
  // synthetic Furniture shape.
  const zonePasswordFurniture = zonePasswordPrompt
    ? {
        id: `zonepw:${zonePasswordPrompt.zoneId}`,
        x: 0, y: 0, paletteId: '', tilesW: 1, tilesH: 1,
        name: zonePasswordPrompt.eventTitle,
        interactiveType: 'password' as const,
        interactiveConfig: {
          passwordDescription: `"${zonePasswordPrompt.eventTitle}" sedang berlangsung — masukkan password untuk masuk.`,
          correctText: 'Password benar — silakan masuk.',
          failureMessage: 'Password salah.',
        },
      }
    : null;
  const zonePasswordResultAdapted = (zonePasswordPrompt && zonePasswordResult && zonePasswordResult.zoneId === zonePasswordPrompt.zoneId)
    ? {
        furnitureId: `zonepw:${zonePasswordPrompt.zoneId}`,
        correct: zonePasswordResult.correct,
        correctText: zonePasswordFurniture?.interactiveConfig.correctText,
        failureMessage: zonePasswordFurniture?.interactiveConfig.failureMessage,
      }
    : null;

  const handleCheckZonePassword = useCallback((_furnitureId: string, attempt: string) => {
    if (!zonePasswordPrompt) return;
    useGameStore.getState().setZonePasswordResult(null);
    emitZonePasswordSubmit(zonePasswordPrompt.zoneId, attempt);
  }, [zonePasswordPrompt, emitZonePasswordSubmit]);
```

And in the JSX, next to the existing door-password `<InteractiveObjectModal>` instance:

```tsx
        {zonePasswordFurniture && (
          <InteractiveObjectModal
            furniture={zonePasswordFurniture}
            onClose={() => useGameStore.getState().setZonePasswordPrompt(null)}
            onCheckPassword={handleCheckZonePassword}
            passwordResult={zonePasswordResultAdapted}
            onCheckChoice={() => {}}
            choiceResult={null}
          />
        )}
```

(Match the exact `onCheckChoice`/`choiceResult` no-op values the existing door-password instance already passes — read its actual current JSX first rather than guessing; if it passes something other than `() => {}`/`null` for those two unused-for-password props, mirror that instead.)

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck --workspace=client
```

- [ ] **Step 5: Commit**

```bash
git add client/src/stores/gameStore.ts client/src/hooks/useSocket.ts client/src/App.tsx
git commit -m "feat: prompt for a meeting Zone's password, show an auto-join notice"
```

---

## Manual Testing After Deploy

1. Create a meeting with a Room KaiSpace + Meeting Area, no password, one attendee. Have that attendee already standing in the chosen room when the start time hits (wait for the minute to turn over, or backdate the event's `start` a minute into the future when creating it). Confirm: their avatar snaps into the Zone, and their own client shows the "📅 Kamu ditarik ke meeting" activity-feed line.
2. Same setup, but the attendee is in a DIFFERENT room (or the Lobby) at start time. Confirm: they are NOT moved, and instead get an in-app notification ("... sudah dimulai").
3. Wait a further 60+ seconds after Test 1 (a second sweep tick) with the attendee having walked back OUT of the Zone. Confirm they are NOT re-pulled — `lastAutoJoinFiredFor` dedup is holding.
4. Create a meeting WITH a password, one attendee. During the meeting window, have that attendee walk/teleport into the Zone themselves (not via auto-join). Confirm: no password prompt at all.
5. During the same meeting's window, have a DIFFERENT user (not an attendee) try to walk into that Zone. Confirm: the password prompt appears. Submit a wrong password — confirm a "Password salah" failure message and the prompt stays open. Submit the correct password — confirm it lets them in.
6. Still connected as that same non-attendee from Test 5, walk out of the Zone and back in. Confirm: NO re-prompt (session-unlocked).
7. Have that same non-attendee refresh the page (or reconnect) and walk into the Zone again. Confirm: the prompt appears again (session unlock cleared on disconnect).
8. Before the meeting's `start` and after its `end`, confirm the Zone is completely unrestricted for everyone — no password prompt at all, regardless of attendee status.
9. Confirm the pre-existing Zone Lock feature (manually locking a zone via its own UI, someone else knocking) still works completely unaffected by any of the above.
10. Confirm the pre-existing door-password feature (a password-protected door tile/area) still prompts and unlocks correctly, unaffected.
