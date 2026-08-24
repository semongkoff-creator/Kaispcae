import { Router, Response } from 'express';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import {
  CalendarRole, canCalendar, canSeeEventDetails, canWorkspace,
  expandOccurrences, normaliseRule, truncateRuleBefore, EditScope,
} from '@kaispace/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveCalendarRole } from '../lib/calendarAccess';
import { resolveWorkspaceRole } from '../lib/workspace';
import { rateLimit } from '../middleware/rateLimit';

const calendar = Router();

let ioRef: Server | null = null;
export function setCalendarIo(io: Server): void { ioRef = io; }

const mutationLimit = rateLimit(60 * 1000, 60);
const MAX_WINDOW_DAYS = 400; // guard: never expand a series across all time

async function notify(prisma: PrismaClient, userId: string, body: string): Promise<void> {
  try {
    await prisma.notification.create({ data: { recipientId: userId, kind: 'workspace', body } });
    ioRef?.to(`user:${userId}`).emit('base:notif', {});
  } catch (err) { console.error('[calendar] notify error:', err); }
}

// ─── Calendars ──────────────────────────────────────────────────────

calendar.get('/calendars', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const uid = req.userId!;
    const [owned, member, teams] = await Promise.all([
      prisma.calendar.findMany({ where: { ownerId: uid }, select: { id: true, name: true, color: true, type: true } }),
      prisma.calendarMember.findMany({
        where: { userId: uid },
        select: { role: true, calendar: { select: { id: true, name: true, color: true, type: true } } },
      }),
      // Multi-tenant Fase 2 — used to list every team calendar workspace-
      // wide with no org filter at all.
      prisma.calendar.findMany({ where: { type: 'team', owner: { organizationId: req.organizationId } }, select: { id: true, name: true, color: true, type: true } }),
    ]);
    const map = new Map<string, { id: string; name: string; color: string; type: string; role: CalendarRole }>();
    for (const t of teams) map.set(t.id, { ...t, role: 'viewer' });
    for (const m of member) map.set(m.calendar.id, { ...m.calendar, role: m.role as CalendarRole });
    for (const o of owned) map.set(o.id, { ...o, role: 'owner' });
    return res.json({ calendars: [...map.values()] });
  } catch (err) { console.error('[calendar] list error:', err); return res.status(500).json({ error: 'Gagal memuat kalender' }); }
});

calendar.post('/calendars', authenticateToken, mutationLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const name = String(req.body?.name ?? '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Nama tidak boleh kosong' });
    const type = req.body?.type === 'team' ? 'team' : 'personal';
    // Creating a TEAM calendar is workspace configuration, not a personal act.
    if (type === 'team') {
      const wsRole = await resolveWorkspaceRole(prisma, req.userId!);
      if (!canWorkspace('calendar:manageTeamCalendars', { workspaceRole: wsRole ?? undefined })) {
        return res.status(403).json({ error: 'Hanya admin yang bisa membuat kalender tim' });
      }
    }
    const cal = await prisma.calendar.create({
      data: { name, type, ownerId: req.userId!, color: String(req.body?.color ?? '#a855f7').slice(0, 9) },
      select: { id: true, name: true, color: true, type: true },
    });
    return res.status(201).json({ ...cal, role: 'owner' });
  } catch (err) { console.error('[calendar] create error:', err); return res.status(500).json({ error: 'Gagal membuat kalender' }); }
});

calendar.delete('/calendars/:calendarId', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const cal = await prisma.calendar.findUnique({
      where: { id: req.params.calendarId },
      select: { type: true, owner: { select: { organizationId: true } } },
    });
    // Multi-tenant Fase 2 — checked directly here (not just via
    // resolveCalendarRole below) because the 'team' branch doesn't consult
    // `role` at all — it only checks the caller's WORKSPACE role, which
    // isn't org-scoped yet (Fase 3). Without this, any workspace admin could
    // delete another org's team calendar.
    if (!cal || cal.owner.organizationId !== req.organizationId) return res.status(404).json({ error: 'Kalender tidak ditemukan' });
    const role = await resolveCalendarRole(prisma, req.params.calendarId, req.userId!, req.organizationId);
    if (cal.type === 'team') {
      const wsRole = await resolveWorkspaceRole(prisma, req.userId!);
      if (!canWorkspace('calendar:manageTeamCalendars', { workspaceRole: wsRole ?? undefined })) {
        return res.status(403).json({ error: 'Hanya admin yang bisa menghapus kalender tim' });
      }
    } else if (!canCalendar('calendar:delete', { role: role ?? undefined })) {
      return res.status(403).json({ error: 'Hanya pemilik yang bisa menghapus' });
    }
    await prisma.calendar.delete({ where: { id: req.params.calendarId } });
    return res.json({ success: true });
  } catch (err) { console.error('[calendar] delete error:', err); return res.status(500).json({ error: 'Gagal menghapus' }); }
});

// ─── Events (expanded occurrences within a window) ───────────────────

interface EventRow {
  id: string; calendarId: string; title: string; description: string | null;
  start: Date; end: Date; allDay: boolean; timezone: string; location: string | null;
  roomId: string | null; rrule: string | null; masterId: string | null;
  recurrenceId: Date | null; exdates: Date[]; organizerId: string; visibility: string;
  meetkaiRoomSlug: string | null;
  meetkaiZoneId: string | null;
  meetkaiPassword: string | null;
  attendees: { userId: string; rsvp: string; optional: boolean; user: { displayName: string } }[];
  room: { id: string; name: string } | null;
}

// Shape one occurrence for the wire, stripping what this viewer may not see.
function serialise(row: EventRow, occStart: Date, occEnd: Date, recurrenceId: Date, viewerId: string, role: CalendarRole | undefined) {
  const attendeeIds = row.attendees.map((a) => a.userId);
  const detailed = canSeeEventDetails(
    { organizerId: row.organizerId, visibility: row.visibility as 'default' | 'private', attendeeIds },
    viewerId,
    role,
  );
  const base = {
    id: row.id,
    calendarId: row.calendarId,
    start: occStart.toISOString(),
    end: occEnd.toISOString(),
    recurrenceId: recurrenceId.toISOString(),
    allDay: row.allDay,
    timezone: row.timezone,
    isRecurring: !!row.rrule || !!row.masterId,
    rrule: row.rrule,
    organizerId: row.organizerId,
  };
  if (!detailed) {
    // Private/foreign event: the caller learns only that the slot is taken.
    // No title, no description, no location, no attendee list.
    return { ...base, title: 'Sibuk', busyOnly: true };
  }
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
    busyOnly: false,
  };
}

calendar.get('/calendars/events', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const uid = req.userId!;
    const from = new Date(String(req.query.from ?? ''));
    const to = new Date(String(req.query.to ?? ''));
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) return res.status(400).json({ error: 'Rentang tanggal tidak valid' });
    if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 86400000) return res.status(400).json({ error: 'Rentang terlalu panjang' });

    const ids = String(req.query.calendarIds ?? '').split(',').filter(Boolean);
    if (!ids.length) return res.json({ events: [] });

    // Re-check every calendar from the DB; ids come from the client.
    const roles = new Map<string, CalendarRole>();
    for (const id of ids) {
      const r = await resolveCalendarRole(prisma, id, uid, req.organizationId);
      if (r) roles.set(id, r);
    }
    if (!roles.size) return res.json({ events: [] });

    const rows = (await prisma.calendarEvent.findMany({
      where: {
        calendarId: { in: [...roles.keys()] },
        // Series masters must be fetched regardless of their own start, since
        // their occurrences can land inside the window; one-offs are filtered.
        OR: [{ rrule: { not: null } }, { start: { lt: to }, end: { gt: from } }, { masterId: { not: null } }],
      },
      include: {
        attendees: { include: { user: { select: { displayName: true } } } },
        room: { select: { id: true, name: true } },
      },
    })) as unknown as EventRow[];

    const overrides = rows.filter((r) => r.masterId);
    const out: unknown[] = [];

    for (const row of rows) {
      if (row.masterId) continue; // handled with its master below
      const role = roles.get(row.calendarId);
      const mine = overrides.filter((o) => o.masterId === row.id);
      // An overridden occurrence must not ALSO render from the rule.
      const suppressed = new Set(mine.map((o) => o.recurrenceId!.getTime()));

      for (const occ of expandOccurrences(
        { start: row.start, end: row.end, timezone: row.timezone, rrule: row.rrule, exdates: row.exdates },
        from, to,
      )) {
        if (suppressed.has(occ.recurrenceId.getTime())) continue;
        out.push(serialise(row, occ.start, occ.end, occ.recurrenceId, uid, role));
      }
      for (const o of mine) {
        if (o.end <= from || o.start >= to) continue;
        out.push(serialise(o, o.start, o.end, o.recurrenceId!, uid, roles.get(o.calendarId)));
      }
    }
    return res.json({ events: out });
  } catch (err) { console.error('[calendar] events error:', err); return res.status(500).json({ error: 'Gagal memuat acara' }); }
});

calendar.post('/calendars/:calendarId/events', authenticateToken, mutationLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const role = await resolveCalendarRole(prisma, req.params.calendarId, req.userId!, req.organizationId);
    if (!canCalendar('event:create', { role: role ?? undefined })) return res.status(403).json({ error: 'Tidak boleh membuat acara di kalender ini' });

    const title = String(req.body?.title ?? '').trim().slice(0, 200) || 'Tanpa judul';
    const start = new Date(String(req.body?.start));
    const end = new Date(String(req.body?.end));
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return res.status(400).json({ error: 'Waktu tidak valid' });

    let rule: string | null = null;
    if (req.body?.rrule) {
      rule = normaliseRule(String(req.body.rrule));
      if (!rule) return res.status(400).json({ error: 'Aturan perulangan tidak valid' });
    }
    const roomId = req.body?.roomId ? String(req.body.roomId) : null;
    if (roomId) {
      const why = await roomBookable(prisma, roomId, req.userId!, req.organizationId);
      if (why) return res.status(409).json({ error: why });
    }

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

    // Lock → check → insert inside ONE transaction. Doing the check in its own
    // transaction and inserting afterwards leaves the exact race this guards
    // against: both requests pass the SELECT, both INSERT (criterion #24).
    let event: { id: string; attendees: { userId: string }[] };
    try {
      event = await prisma.$transaction(async (tx) => {
        if (roomId) {
          await lockRoom(tx as unknown as PrismaClient, roomId);
          if (await roomClashes(tx as unknown as PrismaClient, roomId, start, end, null)) {
            throw new RoomBusyError();
          }
        }
        return tx.calendarEvent.create({ data: eventData, include: { attendees: true } });
      });
    } catch (e) {
      if (e instanceof RoomBusyError) return res.status(409).json({ error: 'Ruang sudah dibooking pada jam itu' });
      throw e;
    }

    const organiser = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } });
    for (const a of event.attendees) {
      await notify(prisma, a.userId, `${organiser?.displayName ?? 'Seseorang'} mengundang kamu ke "${title}".`);
    }
    return res.status(201).json({ id: event.id });
  } catch (err) { console.error('[calendar] create event error:', err); return res.status(500).json({ error: 'Gagal membuat acara' }); }
});

// PATCH with an edit scope — the part that is easy to get wrong.
//   this             → write an OVERRIDE row pinned to that occurrence
//   thisAndFollowing → cut the master short, start a NEW series from here
//   all              → edit the master in place
calendar.patch('/calendars/events/:eventId', authenticateToken, mutationLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const row = await prisma.calendarEvent.findUnique({
      where: { id: req.params.eventId },
      include: { attendees: true, reminders: true },
    });
    if (!row) return res.status(404).json({ error: 'Acara tidak ditemukan' });
    const role = await resolveCalendarRole(prisma, row.calendarId, req.userId!, req.organizationId);
    if (!canCalendar('event:update', { role: role ?? undefined })) return res.status(403).json({ error: 'Tidak boleh mengubah acara ini' });

    const scope = (String(req.body?.scope ?? 'all') as EditScope);
    const patch: Record<string, unknown> = {};
    if (req.body?.title !== undefined) patch.title = String(req.body.title).slice(0, 200);
    if (req.body?.description !== undefined) patch.description = req.body.description ? String(req.body.description).slice(0, 4000) : null;
    if (req.body?.location !== undefined) patch.location = req.body.location ? String(req.body.location).slice(0, 200) : null;
    if (req.body?.visibility !== undefined) patch.visibility = req.body.visibility === 'private' ? 'private' : 'default';
    if (req.body?.meetkaiRoomSlug !== undefined) patch.meetkaiRoomSlug = req.body.meetkaiRoomSlug ? String(req.body.meetkaiRoomSlug).slice(0, 200) : null;
    if (req.body?.meetkaiZoneId !== undefined) patch.meetkaiZoneId = req.body.meetkaiZoneId ? String(req.body.meetkaiZoneId).slice(0, 200) : null;
    if (req.body?.meetkaiPassword !== undefined) patch.meetkaiPassword = req.body.meetkaiPassword ? String(req.body.meetkaiPassword).slice(0, 200) : null;

    const newStart = req.body?.start ? new Date(String(req.body.start)) : null;
    const newEnd = req.body?.end ? new Date(String(req.body.end)) : null;
    if ((newStart && isNaN(newStart.getTime())) || (newEnd && isNaN(newEnd.getTime()))) return res.status(400).json({ error: 'Waktu tidak valid' });
    if (newStart && newEnd && newEnd <= newStart) return res.status(400).json({ error: 'Waktu selesai harus setelah mulai' });

    // Non-recurring event, or an explicit "all": plain update.
    if (!row.rrule || scope === 'all') {
      if (newStart) patch.start = newStart;
      if (newEnd) patch.end = newEnd;
      if (req.body?.rrule !== undefined) {
        const r = req.body.rrule ? normaliseRule(String(req.body.rrule)) : null;
        if (req.body.rrule && !r) return res.status(400).json({ error: 'Aturan perulangan tidak valid' });
        patch.rrule = r;
      }
      await prisma.calendarEvent.update({ where: { id: row.id }, data: patch });
      return res.json({ id: row.id, scope: 'all' });
    }

    const occurrence = req.body?.recurrenceId ? new Date(String(req.body.recurrenceId)) : null;
    if (!occurrence || isNaN(occurrence.getTime())) return res.status(400).json({ error: 'recurrenceId wajib untuk acara berulang' });

    if (scope === 'this') {
      // One occurrence detaches from the rule: exclude it, and store a
      // standalone override row carrying the edits.
      const dur = row.end.getTime() - row.start.getTime();
      const override = await prisma.calendarEvent.create({
        data: {
          calendarId: row.calendarId,
          title: (patch.title as string) ?? row.title,
          description: (patch.description as string | null) ?? row.description,
          start: newStart ?? occurrence,
          end: newEnd ?? new Date((newStart ?? occurrence).getTime() + dur),
          allDay: row.allDay, timezone: row.timezone,
          location: (patch.location as string | null) ?? row.location,
          roomId: row.roomId,
          meetkaiRoomSlug: 'meetkaiRoomSlug' in patch ? (patch.meetkaiRoomSlug as string | null) : row.meetkaiRoomSlug,
          meetkaiZoneId: 'meetkaiZoneId' in patch ? (patch.meetkaiZoneId as string | null) : row.meetkaiZoneId,
          meetkaiPassword: 'meetkaiPassword' in patch ? (patch.meetkaiPassword as string | null) : row.meetkaiPassword,
          masterId: row.id, recurrenceId: occurrence,
          organizerId: row.organizerId,
          visibility: (patch.visibility as string) ?? row.visibility,
          attendees: { create: row.attendees.map((a) => ({ userId: a.userId, rsvp: a.rsvp, optional: a.optional })) },
        },
      });
      return res.json({ id: override.id, scope: 'this' });
    }

    if (scope === 'thisAndFollowing') {
      // Split: the old master stops before this occurrence, a new master owns
      // it and everything after. Occurrences BEFORE the split must not move.
      const truncated = truncateRuleBefore(row.rrule, occurrence, row.timezone);
      const dur = row.end.getTime() - row.start.getTime();
      const [, created] = await prisma.$transaction([
        prisma.calendarEvent.update({ where: { id: row.id }, data: { rrule: truncated } }),
        prisma.calendarEvent.create({
          data: {
            calendarId: row.calendarId,
            title: (patch.title as string) ?? row.title,
            description: (patch.description as string | null) ?? row.description,
            start: newStart ?? occurrence,
            end: newEnd ?? new Date((newStart ?? occurrence).getTime() + dur),
            allDay: row.allDay, timezone: row.timezone,
            location: (patch.location as string | null) ?? row.location,
            roomId: row.roomId,
            meetkaiRoomSlug: 'meetkaiRoomSlug' in patch ? (patch.meetkaiRoomSlug as string | null) : row.meetkaiRoomSlug,
            meetkaiZoneId: 'meetkaiZoneId' in patch ? (patch.meetkaiZoneId as string | null) : row.meetkaiZoneId,
            meetkaiPassword: 'meetkaiPassword' in patch ? (patch.meetkaiPassword as string | null) : row.meetkaiPassword,
            rrule: req.body?.rrule !== undefined ? normaliseRule(String(req.body.rrule)) : row.rrule,
            organizerId: row.organizerId,
            visibility: (patch.visibility as string) ?? row.visibility,
            attendees: { create: row.attendees.map((a) => ({ userId: a.userId, rsvp: a.rsvp, optional: a.optional })) },
          },
        }),
      ]);
      return res.json({ id: created.id, scope: 'thisAndFollowing' });
    }
    return res.status(400).json({ error: 'scope tidak valid' });
  } catch (err) { console.error('[calendar] patch event error:', err); return res.status(500).json({ error: 'Gagal menyimpan acara' }); }
});

calendar.delete('/calendars/events/:eventId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const row = await prisma.calendarEvent.findUnique({ where: { id: req.params.eventId } });
    if (!row) return res.status(404).json({ error: 'Acara tidak ditemukan' });
    const role = await resolveCalendarRole(prisma, row.calendarId, req.userId!, req.organizationId);
    if (!canCalendar('event:delete', { role: role ?? undefined })) return res.status(403).json({ error: 'Tidak boleh menghapus acara ini' });

    const scope = String(req.query.scope ?? 'all') as EditScope;
    if (!row.rrule || scope === 'all') {
      await prisma.calendarEvent.delete({ where: { id: row.id } });
      return res.json({ success: true, scope: 'all' });
    }
    const occurrence = req.query.recurrenceId ? new Date(String(req.query.recurrenceId)) : null;
    if (!occurrence || isNaN(occurrence.getTime())) return res.status(400).json({ error: 'recurrenceId wajib' });

    if (scope === 'this') {
      await prisma.calendarEvent.update({ where: { id: row.id }, data: { exdates: { push: occurrence } } });
      await prisma.calendarEvent.deleteMany({ where: { masterId: row.id, recurrenceId: occurrence } });
      return res.json({ success: true, scope: 'this' });
    }
    if (scope === 'thisAndFollowing') {
      await prisma.calendarEvent.update({
        where: { id: row.id },
        data: { rrule: truncateRuleBefore(row.rrule, occurrence, row.timezone) },
      });
      await prisma.calendarEvent.deleteMany({ where: { masterId: row.id, recurrenceId: { gte: occurrence } } });
      return res.json({ success: true, scope: 'thisAndFollowing' });
    }
    return res.status(400).json({ error: 'scope tidak valid' });
  } catch (err) { console.error('[calendar] delete event error:', err); return res.status(500).json({ error: 'Gagal menghapus acara' }); }
});

// ─── RSVP ───────────────────────────────────────────────────────────

calendar.post('/calendars/events/:eventId/rsvp', authenticateToken, mutationLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const rsvp = String(req.body?.rsvp ?? '');
    if (!['accepted', 'declined', 'tentative', 'needsAction'].includes(rsvp)) return res.status(400).json({ error: 'RSVP tidak valid' });
    // Only an actual invitee may answer — you can't RSVP to a meeting you
    // weren't invited to, and you can't answer on someone else's behalf.
    const att = await prisma.eventAttendee.findUnique({
      where: { eventId_userId: { eventId: req.params.eventId, userId: req.userId! } },
    });
    if (!att) return res.status(403).json({ error: 'Kamu tidak diundang ke acara ini' });
    await prisma.eventAttendee.update({ where: { id: att.id }, data: { rsvp } });

    const event = await prisma.calendarEvent.findUnique({ where: { id: req.params.eventId }, select: { title: true, organizerId: true } });
    const me = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } });
    const label = rsvp === 'accepted' ? 'hadir' : rsvp === 'declined' ? 'tidak hadir' : 'mungkin hadir';
    if (event && event.organizerId !== req.userId) {
      await notify(prisma, event.organizerId, `${me?.displayName ?? 'Seseorang'} ${label} di "${event.title}".`);
    }
    return res.json({ rsvp });
  } catch (err) { console.error('[calendar] rsvp error:', err); return res.status(500).json({ error: 'Gagal menyimpan RSVP' }); }
});

// ─── Free/busy (finish criterion #25) ───────────────────────────────
// Returns ONLY busy intervals. No titles, no locations, no event ids — there
// is deliberately nothing here to leak, regardless of who asks.

calendar.get('/calendars/freebusy', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const from = new Date(String(req.query.from ?? ''));
    const to = new Date(String(req.query.to ?? ''));
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) return res.status(400).json({ error: 'Rentang tidak valid' });
    if (to.getTime() - from.getTime() > 31 * 86400000) return res.status(400).json({ error: 'Rentang terlalu panjang' });
    const requestedIds = String(req.query.userIds ?? '').split(',').filter(Boolean).slice(0, 50);
    if (!requestedIds.length) return res.json({ freebusy: {} });

    // Multi-tenant Fase 2 — userIds are fully client-supplied; a cross-org id
    // used to still return that stranger's busy/free times. Silently drop
    // anything outside the caller's org, same as a batch-lookup omission
    // elsewhere (not an error — the caller just gets no data for that id).
    const inOrg = await prisma.user.findMany({ where: { id: { in: requestedIds }, organizationId: req.organizationId }, select: { id: true } });
    const userIds = inOrg.map((u) => u.id);

    const out: Record<string, { start: string; end: string }[]> = {};
    for (const userId of userIds) {
      const rows = await prisma.calendarEvent.findMany({
        where: {
          OR: [
            { organizerId: userId },
            { attendees: { some: { userId, rsvp: { not: 'declined' } } } },
          ],
        },
        select: { start: true, end: true, timezone: true, rrule: true, exdates: true },
      });
      const busy: { start: string; end: string }[] = [];
      for (const r of rows) {
        for (const occ of expandOccurrences(r, from, to)) {
          busy.push({ start: occ.start.toISOString(), end: occ.end.toISOString() });
        }
      }
      busy.sort((a, b) => a.start.localeCompare(b.start));
      out[userId] = busy;
    }
    return res.json({ freebusy: out });
  } catch (err) { console.error('[calendar] freebusy error:', err); return res.status(500).json({ error: 'Gagal memuat ketersediaan' }); }
});

// ─── Room booking ───────────────────────────────────────────────────
// Booking is only correct if the overlap check and the insert happen under the
// SAME lock. These three pieces are meant to be composed inside one
// transaction — see the create route above (finish criterion #24: two parallel
// requests for the same slot, exactly one wins).

export class RoomBusyError extends Error {}

// Policy/existence check. Safe to run before the transaction: it doesn't
// depend on the slot. Migration slice — this used to check ONLY active +
// bookableBy, with zero org awareness: the CALENDAR a booking lands on was
// verified org-safe (resolveCalendarRole above), but the ROOM being booked
// never was, so a member of one org could book (and really clash-block)
// another org's meeting room on their own org's calendar.
export async function roomBookable(prisma: PrismaClient, roomId: string, userId: string, organizationId: string | undefined): Promise<string | null> {
  if (!organizationId) return 'Ruang tidak tersedia';
  const room = await prisma.meetingRoom.findUnique({ where: { id: roomId }, select: { active: true, bookableBy: true, name: true, organizationId: true } });
  if (!room || !room.active || room.organizationId !== organizationId) return 'Ruang tidak tersedia';
  if (room.bookableBy === 'admin') {
    const wsRole = await resolveWorkspaceRole(prisma, userId);
    if (wsRole !== 'admin') return `Ruang "${room.name}" hanya bisa dibooking admin`;
  }
  return null;
}

// Serialise every booking attempt for this room. hashtext() maps the room id
// onto the advisory lock's bigint keyspace; the lock releases when the
// surrounding transaction ends, so the caller MUST hold a transaction.
export async function lockRoom(tx: PrismaClient, roomId: string): Promise<void> {
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', roomId);
}

export async function roomClashes(tx: PrismaClient, roomId: string, start: Date, end: Date, ignoreEventId: string | null): Promise<boolean> {
  const clash = await tx.calendarEvent.findFirst({
    where: {
      roomId,
      id: ignoreEventId ? { not: ignoreEventId } : undefined,
      start: { lt: end },
      end: { gt: start },
    },
    select: { id: true },
  });
  return !!clash;
}

export default calendar;
