import { Server } from 'socket.io';
import { getPrisma } from '../lib/prisma';
import { SocketEvents, expandOccurrences, findZoneEntryTile, TILE_SIZE, type Occurrence } from '@virtualmeet/shared';
import { getPlayers, updatePlayerPosition, getCachedTiles, getCachedZones } from '../store/roomStore';
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
        where: {
          meetkaiRoomSlug: { not: null },
          meetkaiZoneId: { not: null },
          // A recurring event's own `start`/`end` are the FIXED first-occurrence
          // template (see RecurringMaster's doc comment in shared/recurrence.ts)
          // and are never advanced as the series progresses. Filtering on
          // `end >= now` alone would drop a recurring row out of this query
          // forever after its first occurrence ends, silently killing
          // auto-join for every later occurrence. So any row with a non-null
          // `rrule` is included regardless of its own end (same fix already
          // applied in calendar.ts's `GET /calendars/events` query); only
          // genuinely one-off events are still filtered by `end`.
          OR: [{ rrule: { not: null } }, { end: { gte: now } }],
        },
        select: {
          id: true, title: true, start: true, end: true, timezone: true, rrule: true, exdates: true,
          meetkaiRoomSlug: true, meetkaiZoneId: true, lastAutoJoinFiredFor: true,
          organizerId: true,
          attendees: { select: { userId: true } },
        },
      });
      if (!events.length) return;

      let fired = 0;
      for (const ev of events) {
        const room = ev.meetkaiRoomSlug!;
        const zoneId = ev.meetkaiZoneId!;

        // `due` is declared outside the try so the catch block below can still
        // reach it (it's only assigned once expandOccurrences/`.find` succeed).
        let due: Occurrence | undefined;
        try {
          const occurrences = expandOccurrences(
            { start: ev.start, end: ev.end, timezone: ev.timezone, rrule: ev.rrule, exdates: ev.exdates },
            new Date(now.getTime() - 60 * 60 * 1000), // small back-window, same as reminderSweep.ts, so a restart doesn't skip one
            horizon,
          );

          // The occurrence whose start JUST crossed into the past, that hasn't
          // been fired for yet. Unlike reminderSweep.ts (which fires ahead of
          // start, for a reminder), this only ever wants the occurrence that
          // has *just* started — not any future one still ahead.
          due = occurrences.find((occ) =>
            occ.start <= now &&
            (!ev.lastAutoJoinFiredFor || ev.lastAutoJoinFiredFor.getTime() !== occ.start.getTime()),
          );
          if (!due) continue;

          const players = await getPlayers(room);
          const tiles = getCachedTiles(room);
          // Zone geometry comes from the live in-memory cache, NOT a raw read
          // of Room.zones: that legacy column is frozen for any room saved
          // through the newer layered Room Editor (whose real zones live in
          // layerData and are refreshed into this cache via setCachedZones),
          // so reading it directly would land people on stale — or
          // non-existent — coordinates. Returns [] (→ no landing tile, the
          // player's own position is used instead) when the zone can no
          // longer be found at all.
          const zoneRect = getCachedZones(room).find((z) => z.id === zoneId) ?? null;
          const landing = tiles && tiles.length > 0 && zoneRect ? findZoneEntryTile(tiles, zoneRect) : null;

          // Everyone the meeting belongs to — the organizer PLUS the invited
          // attendees, deduped. EventAttendee deliberately excludes the
          // organizer (calendar.ts's create route filters `id !== req.userId`),
          // so iterating attendees alone would leave the person who called the
          // meeting behind. Same precedent reminderSweep.ts already sets for
          // its own recipient set.
          const participantIds = new Set<string>([ev.organizerId]);
          for (const a of ev.attendees) participantIds.add(a.userId);

          // Tracks participants ACTUALLY force-moved below (not just "found in
          // the room's player list") — a participant found in `players` but
          // skipped for a stale socket must still fall through to the
          // notification loop, or they'd get neither a pull nor a notice.
          const pulledUserIds = new Set<string>();
          for (const userId of participantIds) {
            const player = players.find((p) => p.userId === userId);
            if (!player) continue; // not online in this room right now — notified below instead
            const targetSocket = io.sockets.sockets.get(player.id);
            if (!targetSocket) continue; // stale Avatar record, socket already gone — notified below instead

            if (isZoneLocked(room, zoneId)) {
              admitUserToZone(room, zoneId, userId);
              // Tell the CLIENT it's been admitted too, or its own
              // ZoneWatcher.tsx would bounce the freshly force-moved avatar
              // straight back out (it mirrors the lock state locally and has
              // no idea an admission was just granted server-side). Same
              // pairing every other admitUserToZone caller uses — see
              // roomHandler.ts's FORCE_PULL/SUMMON_RESPOND.
              //
              // Known gap (deliberately not handled): the equivalent for a
              // restriction-bearing / CEO-queue zone, a much rarer
              // combination that would need a real queue ticket, not a
              // one-line notification.
              targetSocket.emit(SocketEvents.ZONE_KNOCK_DECIDED, { zoneId, admitted: true, byName: ev.title });
            }

            const landX = landing ? landing.x * TILE_SIZE + TILE_SIZE / 2 : player.x;
            const landY = landing ? landing.y * TILE_SIZE + TILE_SIZE / 2 : player.y;
            await updatePlayerPosition(room, targetSocket.id, landX, landY, 'down');
            io.to(room).emit(SocketEvents.PLAYER_TELEPORTED, { id: targetSocket.id, x: landX, y: landY, direction: 'down' });
            targetSocket.emit(SocketEvents.MEETING_AUTO_JOINED, { title: ev.title });
            pulledUserIds.add(userId);
          }

          // Participants who weren't actually force-moved above (offline,
          // online elsewhere, or a stale player record) get a plain in-app
          // notification instead — same inline pattern reminderSweep.ts
          // already uses, not calendar.ts's local (non-exported) notify()
          // helper.
          for (const userId of participantIds) {
            if (pulledUserIds.has(userId)) continue;
            await prisma.notification.create({
              data: { recipientId: userId, kind: 'workspace', body: `"${ev.title}" sudah dimulai.` },
            });
            io.to(`user:${userId}`).emit('base:notif', {});
          }

          await prisma.calendarEvent.update({ where: { id: ev.id }, data: { lastAutoJoinFiredFor: due.start } });
          fired++;
        } catch (e) {
          console.error(`[meetingAutoJoin] failed processing event ${ev.id}:`, e);
          // Still mark this occurrence as fired even though processing threw,
          // rather than leaving it to retry every tick forever — a
          // persistently-broken row (e.g. a malformed rrule) would otherwise
          // monopolise every tick indefinitely and starve every other event
          // in the sweep. This accepts that a genuinely failed occurrence
          // just doesn't get retried, consistent with this feature's
          // "one shot, no catch-up" design elsewhere (a missed window is
          // already a permanent, accepted miss). `due` is undefined when the
          // failure happened before an occurrence was even identified (e.g.
          // expandOccurrences itself threw on the malformed rrule) — nothing
          // meaningful to mark in that case.
          if (due) {
            try {
              await prisma.calendarEvent.update({ where: { id: ev.id }, data: { lastAutoJoinFiredFor: due.start } });
            } catch (e2) {
              console.error(`[meetingAutoJoin] failed to record fired-flag for event ${ev.id} after error:`, e2);
            }
          }
        }
      }
      if (fired) console.log(`[meetingAutoJoin] sweep fired ${fired} event(s)`);
    } catch (e) {
      console.error('[meetingAutoJoin] sweep error:', e);
    }
  }, intervalMs);
}
