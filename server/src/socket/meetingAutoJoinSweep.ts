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
