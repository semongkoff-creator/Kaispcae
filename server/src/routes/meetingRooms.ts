import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { expandOccurrences, canWorkspace } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireWorkspace, resolveWorkspaceRole } from '../lib/workspace';
import { writeAudit, clientIp } from '../lib/audit';
import { rateLimit } from '../middleware/rateLimit';
import { findMeetingRoomInOrg } from '../lib/orgScope';

const meetingRooms = Router();
const mutationLimit = rateLimit(60 * 1000, 30);

// Anyone may LIST rooms — you can't book what you can't see. Creating and
// configuring them is admin-only (workspace layer), enforced below.
meetingRooms.get('/meeting-rooms', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    // Migration slice — used to have no org filter, listing every org's
    // meeting rooms (including location/equipment) to any authenticated
    // user of any org, and handing out ids that fed straight into the
    // busy/can-book/booking endpoints below.
    const rooms = await prisma.meetingRoom.findMany({
      where: { active: true, organizationId: req.organizationId },
      select: { id: true, name: true, capacity: true, location: true, equipment: true, bookableBy: true },
      orderBy: { name: 'asc' },
    });
    return res.json({ rooms });
  } catch (err) { console.error('[rooms] list error:', err); return res.status(500).json({ error: 'Gagal memuat ruang' }); }
});

meetingRooms.post('/admin/meeting-rooms', authenticateToken, requireWorkspace('calendar:manageRooms'), mutationLimit, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const name = String(req.body?.name ?? '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Nama ruang tidak boleh kosong' });
    const capacity = Number(req.body?.capacity);
    const room = await prisma.meetingRoom.create({
      data: {
        organizationId: req.organizationId,
        name,
        capacity: Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 4,
        location: req.body?.location ? String(req.body.location).slice(0, 120) : null,
        equipment: Array.isArray(req.body?.equipment) ? req.body.equipment.map(String).slice(0, 12) : [],
        bookableBy: req.body?.bookableBy === 'admin' ? 'admin' : 'member',
      },
    });
    await writeAudit(prisma, { actorId: req.userId!, action: 'calendar:manageRooms', targetType: 'room', targetId: room.id, meta: { created: name }, ip: clientIp(req) });
    return res.status(201).json({ room });
  } catch (err) { console.error('[rooms] create error:', err); return res.status(500).json({ error: 'Gagal membuat ruang' }); }
});

meetingRooms.patch('/admin/meeting-rooms/:roomId', authenticateToken, requireWorkspace('calendar:manageRooms'), mutationLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    // Migration slice — org-scoped lookup; without it any org's admin
    // could reconfigure (or, via `active`, silently disable) another
    // org's meeting room by id.
    const before = await findMeetingRoomInOrg(prisma, req.params.roomId, req.organizationId);
    if (!before) return res.status(404).json({ error: 'Ruang tidak ditemukan' });
    const data: Record<string, unknown> = {};
    if (req.body?.name !== undefined) data.name = String(req.body.name).trim().slice(0, 80);
    if (req.body?.capacity !== undefined) data.capacity = Math.max(1, Math.floor(Number(req.body.capacity) || 1));
    if (req.body?.location !== undefined) data.location = req.body.location ? String(req.body.location).slice(0, 120) : null;
    if (req.body?.bookableBy !== undefined) data.bookableBy = req.body.bookableBy === 'admin' ? 'admin' : 'member';
    if (req.body?.active !== undefined) data.active = Boolean(req.body.active);
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Tidak ada perubahan' });
    const room = await prisma.meetingRoom.update({ where: { id: before.id }, data });
    await writeAudit(prisma, {
      actorId: req.userId!, action: 'calendar:manageRooms', targetType: 'room', targetId: room.id,
      meta: { before: Object.fromEntries(Object.keys(data).map((k) => [k, (before as Record<string, unknown>)[k]])), after: data },
      ip: clientIp(req),
    });
    return res.json({ room });
  } catch (err) { console.error('[rooms] patch error:', err); return res.status(500).json({ error: 'Gagal menyimpan ruang' }); }
});

meetingRooms.delete('/admin/meeting-rooms/:roomId', authenticateToken, requireWorkspace('calendar:manageRooms'), async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    // Migration slice — org-scoped lookup; without it any org's admin
    // could delete another org's meeting room by id.
    const room = await findMeetingRoomInOrg(prisma, req.params.roomId, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Ruang tidak ditemukan' });
    await prisma.meetingRoom.delete({ where: { id: room.id } });
    await writeAudit(prisma, { actorId: req.userId!, action: 'calendar:manageRooms', targetType: 'room', targetId: room.id, meta: { deleted: room.name }, ip: clientIp(req) });
    return res.json({ success: true });
  } catch (err) { console.error('[rooms] delete error:', err); return res.status(500).json({ error: 'Gagal menghapus ruang' }); }
});

// Every booking of a room, for the admin's "view/cancel anyone's booking"
// power. Titles are included here BY DESIGN and gated on the admin action:
// unlike free/busy, this is the admin's room-management view.
meetingRooms.get('/admin/meeting-rooms/:roomId/bookings', authenticateToken, requireWorkspace('calendar:manageAnyBooking'), async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    // Migration slice — org-scoped lookup; without it any org's admin
    // could view another org's real booking titles and organizer identity
    // just by supplying that org's room id (requireWorkspace checks role
    // only, never which org the resource belongs to).
    if (!(await findMeetingRoomInOrg(prisma, req.params.roomId, req.organizationId))) {
      return res.status(404).json({ error: 'Ruang tidak ditemukan' });
    }
    const from = new Date(String(req.query.from ?? Date.now()));
    const to = new Date(String(req.query.to ?? Date.now() + 30 * 86400000));
    const rows = await prisma.calendarEvent.findMany({
      where: { roomId: req.params.roomId, start: { lt: to }, end: { gt: from } },
      select: { id: true, title: true, start: true, end: true, organizer: { select: { id: true, displayName: true } } },
      orderBy: { start: 'asc' },
    });
    await writeAudit(prisma, {
      actorId: req.userId!, action: 'calendar:manageAnyBooking', targetType: 'room', targetId: req.params.roomId,
      meta: { viewed: rows.length, from: from.toISOString(), to: to.toISOString() }, ip: clientIp(req),
    });
    return res.json({ bookings: rows.map((r) => ({ ...r, start: r.start.toISOString(), end: r.end.toISOString() })) });
  } catch (err) { console.error('[rooms] bookings error:', err); return res.status(500).json({ error: 'Gagal memuat booking' }); }
});

// Room availability — same privacy rule as free/busy: busy blocks only, never
// the meeting's title or who booked it.
meetingRooms.get('/meeting-rooms/:roomId/busy', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    // Migration slice — org-scoped lookup; the roomId here previously came
    // straight from the also-unscoped GET /meeting-rooms list, so this was
    // reachable for any org's room id.
    if (!(await findMeetingRoomInOrg(prisma, req.params.roomId, req.organizationId))) {
      return res.status(404).json({ error: 'Ruang tidak ditemukan' });
    }
    const from = new Date(String(req.query.from ?? ''));
    const to = new Date(String(req.query.to ?? ''));
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) return res.status(400).json({ error: 'Rentang tidak valid' });
    const rows = await prisma.calendarEvent.findMany({
      where: { roomId: req.params.roomId },
      select: { start: true, end: true, timezone: true, rrule: true, exdates: true },
    });
    const busy: { start: string; end: string }[] = [];
    for (const r of rows) {
      for (const occ of expandOccurrences(r, from, to)) busy.push({ start: occ.start.toISOString(), end: occ.end.toISOString() });
    }
    return res.json({ busy: busy.sort((a, b) => a.start.localeCompare(b.start)) });
  } catch (err) { console.error('[rooms] busy error:', err); return res.status(500).json({ error: 'Gagal memuat ketersediaan' }); }
});

// Cancel anyone's booking (frees the room, keeps the event).
meetingRooms.delete('/admin/bookings/:eventId', authenticateToken, requireWorkspace('calendar:manageAnyBooking'), async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const event = await prisma.calendarEvent.findUnique({ where: { id: req.params.eventId }, select: { id: true, title: true, roomId: true, organizerId: true } });
    if (!event?.roomId) return res.status(404).json({ error: 'Booking tidak ditemukan' });
    // Migration slice — org-scoped via the booked ROOM (this is the room
    // admin's "manage any booking" power, scoped to the rooms that
    // company actually owns) rather than trusting requireWorkspace's
    // role-only gate.
    if (!(await findMeetingRoomInOrg(prisma, event.roomId, req.organizationId))) {
      return res.status(404).json({ error: 'Booking tidak ditemukan' });
    }
    await prisma.calendarEvent.update({ where: { id: event.id }, data: { roomId: null } });
    await writeAudit(prisma, {
      actorId: req.userId!, action: 'calendar:manageAnyBooking', targetType: 'event', targetId: event.id,
      targetUserId: event.organizerId, reason: req.body?.reason ? String(req.body.reason) : null,
      meta: { cancelledRoom: event.roomId, title: event.title }, ip: clientIp(req),
    });
    await prisma.notification.create({
      data: { recipientId: event.organizerId, kind: 'workspace', body: `Booking ruang untuk "${event.title}" dibatalkan admin.` },
    });
    return res.json({ success: true });
  } catch (err) { console.error('[rooms] cancel booking error:', err); return res.status(500).json({ error: 'Gagal membatalkan booking' }); }
});

// Guard used by the calendar UI to decide whether to offer admin-only rooms.
meetingRooms.get('/meeting-rooms/can-book/:roomId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findMeetingRoomInOrg(prisma, req.params.roomId, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Ruang tidak ditemukan' });
    if (room.bookableBy !== 'admin') return res.json({ canBook: true });
    const wsRole = await resolveWorkspaceRole(prisma, req.userId!);
    return res.json({ canBook: canWorkspace('calendar:manageRooms', { workspaceRole: wsRole ?? undefined }) });
  } catch (err) { console.error('[rooms] can-book error:', err); return res.status(500).json({ error: 'Gagal' }); }
});

export default meetingRooms;
