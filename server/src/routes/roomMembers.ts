import { Router, Response } from 'express';
import { Server } from 'socket.io';
import { Prisma } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { hasFeatureAccess, SocketEvents, Zone, LayerData, layerDataToLegacy } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveRoomRole } from '../lib/roles';
import { resolveEntry } from '../lib/roomMembership';
import { resolveZoneEntry, refreshZoneRestrictionCache } from '../lib/zoneMembership';
import { groupConversationId } from '../lib/conversations';
import { requireWorkspace } from '../lib/workspace';
import { getConnectedAdminSocketIds, forceLeaveForQueue, forceZoneExitForQueue } from '../socket/roomHandler';
import { advanceQueue, QUEUE_MIN_MINUTES, QUEUE_MAX_MINUTES } from '../lib/roomQueue';

// Reads a room's current zone list regardless of which map format it's
// stored in — a ZEP-edited room's zones live in layerData (layerDataToLegacy
// derives them), an older room's live in the legacy `zones` column directly.
// Same fallback JOIN_ROOM already applies when populating the live cache.
function zonesOfRoom(room: { zones: unknown; layerData: unknown }): Zone[] {
  if (room.layerData) {
    try {
      return layerDataToLegacy(room.layerData as unknown as LayerData).zones;
    } catch {
      // Malformed layerData — fall through to whatever the legacy column has.
    }
  }
  return (room.zones as Zone[] | null) ?? [];
}

const roomMembers = Router();

let ioRef: Server | null = null;
export function setMembersIo(io: Server): void {
  ioRef = io;
}

// Room management is admin+ ('room:update' — see shared/permissions.ts).
// Deciding who gets into the room is the same class of action, so it reuses
// that gate rather than inventing a parallel one; an ordinary member can
// neither see the queue nor decide on it.
async function requireRoomAdmin(prisma: ReturnType<typeof getPrisma>, slug: string, userId: string) {
  const room = await prisma.room.findUnique({ where: { slug } });
  if (!room) return { error: 404 as const, room: null };
  const role = await resolveRoomRole(prisma, userId, room.id, room.ownerId);
  if (!hasFeatureAccess(role, 'room:update')) return { error: 403 as const, room };
  return { error: null, room };
}

// POST /api/rooms/:slug/join-request — what an invite link actually does now.
// Idempotent: re-posting while pending returns the same pending state instead
// of stacking duplicate requests.
roomMembers.post('/rooms/:slug/join-request', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await prisma.room.findUnique({ where: { slug: req.params.slug } });
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const entry = await resolveEntry(prisma, room, req.userId!);
    if (entry.allowed) {
      // Walking into an open room still records membership, for the same
      // reason the socket join does (see roomHandler.ts): otherwise switching
      // the room to approval-required later locks out everyone already using
      // it. 'privileged' is skipped — owners and global admins are allowed by
      // who they are, and don't need a row to prove it.
      if (entry.reason === 'open') {
        await prisma.roomMember.upsert({
          where: { userId_roomId: { userId: req.userId!, roomId: room.id } },
          create: { userId: req.userId!, roomId: room.id, status: 'active', role: 'member' },
          update: {},
        });
      }
      return res.json({ status: 'active', reason: entry.reason });
    }

    if (entry.reason === 'pending') return res.status(202).json({ status: 'pending' });
    // A rejected request is a decision, not a rate limit — re-requesting would
    // let someone re-queue indefinitely past an admin's "no". Lifting it is an
    // admin action (approve below), not something the rejected user can do.
    if (entry.reason === 'rejected') return res.status(403).json({ status: 'rejected', error: 'Permintaan bergabung ditolak admin.' });
    // QA (Akses ruang checklist item 1, "Ruang sensitif terkontrol") — a
    // restricted room has NO self-service request path, unlike an ordinary
    // approval-gated one below — falling through to that would wrongly
    // create a pending row and notify admins as if this were a normal
    // "please let me in" request. Access here can only be granted directly
    // by an admin (see the room-access endpoints), never requested.
    if (entry.reason === 'restricted') {
      return res.status(403).json({ status: 'restricted', error: 'Room ini dibatasi. Hubungi admin untuk diberi akses.' });
    }
    // Same "no auto-created pending row" reasoning as 'restricted' above —
    // a queue-gated room's only self-service path is POST .../queue/join,
    // never this ordinary join-request flow.
    if (entry.reason === 'queue') {
      return res.status(403).json({ status: 'queue', error: 'Room ini pakai sistem antrean. Daftar antrean untuk mendapat giliran.' });
    }

    await prisma.roomMember.upsert({
      where: { userId_roomId: { userId: req.userId!, roomId: room.id } },
      create: { userId: req.userId!, roomId: room.id, status: 'pending', role: 'member' },
      update: { status: 'pending', requestedAt: new Date(), decidedById: null, decidedAt: null },
    });

    // Item #5 — pop this up on every admin's screen right now, instead of
    // relying on the manual queue (or the 20s badge poll) to ever be opened.
    // Targeted at exactly the admin sockets currently connected to this room
    // (via getConnectedAdminSocketIds) rather than a room-wide broadcast: a
    // non-admin bystander must never receive this. An admin who isn't
    // connected right now just gets nothing here — their request is still
    // safe in the queue for whenever they do open it.
    if (ioRef) {
      const adminSocketIds = getConnectedAdminSocketIds(room.slug);
      if (adminSocketIds.length > 0) {
        const requester = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } });
        const payload = { userId: req.userId!, name: requester?.displayName || 'Seseorang', roomSlug: room.slug, roomName: room.name };
        for (const sid of adminSocketIds) ioRef.to(sid).emit(SocketEvents.JOIN_REQUESTED, payload);
      }
    }

    return res.status(202).json({ status: 'pending' });
  } catch (err) {
    console.error('[roomMembers] join-request error:', err);
    return res.status(500).json({ error: 'Gagal mengirim permintaan bergabung' });
  }
});

// GET /api/rooms/:slug/join-requests — the admin's pending queue.
roomMembers.get('/rooms/:slug/join-requests', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Hanya admin room yang bisa melihat antrean' });

    const rows = await prisma.roomMember.findMany({
      where: { roomId: room!.id, status: 'pending' },
      orderBy: { requestedAt: 'asc' },
      include: { user: { select: { id: true, displayName: true, email: true } } },
    });
    return res.json({
      requests: rows.map((r) => ({
        userId: r.userId,
        displayName: r.user.displayName,
        email: r.user.email,
        requestedAt: r.requestedAt.getTime(),
      })),
    });
  } catch (err) {
    console.error('[roomMembers] list join-requests error:', err);
    return res.status(500).json({ error: 'Gagal memuat antrean' });
  }
});

// POST /api/rooms/:slug/join-requests/:userId — { decision: 'approve' | 'reject' }
roomMembers.post('/rooms/:slug/join-requests/:userId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      return res.status(400).json({ error: "decision harus 'approve' atau 'reject'" });
    }
    const prisma = getPrisma();
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Hanya admin room yang bisa memutuskan' });

    const target = await prisma.roomMember.findUnique({
      where: { userId_roomId: { userId: req.params.userId, roomId: room!.id } },
    });
    if (!target || target.status !== 'pending') {
      return res.status(404).json({ error: 'Tidak ada permintaan yang menunggu untuk user ini' });
    }

    // Approving only ever sets status. The role stays whatever it was
    // ('member' for a fresh request) — approving someone into the room must
    // never be a way to hand out admin by accident.
    const updated = await prisma.roomMember.update({
      where: { userId_roomId: { userId: req.params.userId, roomId: room!.id } },
      data: {
        status: decision === 'approve' ? 'active' : 'rejected',
        decidedById: req.userId,
        decidedAt: new Date(),
      },
    });

    if (ioRef) {
      // Targeted at the requester's own sockets: a decision about one person
      // is nobody else's business, and the client uses it to move off the
      // waiting screen without polling.
      for (const s of ioRef.sockets.sockets.values()) {
        if (s.data.userId === req.params.userId) {
          s.emit(SocketEvents.JOIN_DECISION, { roomSlug: room!.slug, status: updated.status });
        }
      }
      // userId included so a still-open popup for this exact request (see
      // Item #5) can remove just that one card — a decision on one request
      // must not dismiss other, unrelated pending requests for the same room.
      ioRef.to(room!.slug).emit(SocketEvents.JOIN_QUEUE_CHANGED, { roomId: room!.id, userId: req.params.userId, roomSlug: room!.slug });
    }

    return res.json({ status: updated.status });
  } catch (err) {
    console.error('[roomMembers] decide join-request error:', err);
    return res.status(500).json({ error: 'Gagal memproses keputusan' });
  }
});

// GET /api/rooms/:slug/membership — what the client checks before entering.
roomMembers.get('/rooms/:slug/membership', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await prisma.room.findUnique({ where: { slug: req.params.slug } });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const entry = await resolveEntry(prisma, room, req.userId!);
    return res.json({ allowed: entry.allowed, reason: entry.reason, requiresApproval: room.requiresApproval });
  } catch (err) {
    console.error('[roomMembers] membership error:', err);
    return res.status(500).json({ error: 'Gagal memeriksa keanggotaan' });
  }
});

// GET /api/admin/join-requests — every pending request across the whole
// workspace, for the admin console. The per-room queue in the room sidebar
// only helps someone already standing in that room; an admin managing the
// office needs one place that shows all of them.
//
// Gated by the WORKSPACE role, not per-room admin: this deliberately spans
// rooms, so a per-room check has nothing to check against.
roomMembers.get('/admin/join-requests', authenticateToken, requireWorkspace('workspace:manageMembers'), async (_req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const rows = await prisma.roomMember.findMany({
      where: { status: 'pending' },
      orderBy: { requestedAt: 'asc' },
      include: {
        user: { select: { id: true, displayName: true, email: true } },
        room: { select: { slug: true, name: true } },
      },
    });
    return res.json({
      requests: rows.map((r) => ({
        userId: r.userId,
        displayName: r.user.displayName,
        email: r.user.email,
        roomSlug: r.room.slug,
        roomName: r.room.name,
        requestedAt: r.requestedAt.getTime(),
      })),
    });
  } catch (err) {
    console.error('[roomMembers] admin join-requests error:', err);
    return res.status(500).json({ error: 'Gagal memuat antrean' });
  }
});

// GET /api/rooms/:slug/members — the room's approved people. This is the
// picker an admin adds group members FROM: only 'active' rows, so someone
// still waiting on approval can't be dropped into a group before they're even
// in the room.
roomMembers.get('/rooms/:slug/members', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await prisma.room.findUnique({ where: { slug: req.params.slug } });
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const entry = await resolveEntry(prisma, room, req.userId!);
    if (!entry.allowed) return res.status(403).json({ error: 'Bukan anggota room ini' });

    const rows = await prisma.roomMember.findMany({
      where: { roomId: room.id, status: 'active' },
      include: { user: { select: { id: true, displayName: true, email: true } } },
    });
    // The owner has a member row already in the normal case, but a room whose
    // owner never got one would otherwise be missing its own admin here.
    const owner = await prisma.user.findUnique({
      where: { id: room.ownerId },
      select: { id: true, displayName: true, email: true },
    });
    const byId = new Map(rows.map((r) => [r.userId, { id: r.user.id, displayName: r.user.displayName, email: r.user.email, role: r.role }]));
    if (owner && !byId.has(owner.id)) byId.set(owner.id, { ...owner, role: 'owner' });

    return res.json({ members: [...byId.values()] });
  } catch (err) {
    console.error('[roomMembers] list members error:', err);
    return res.status(500).json({ error: 'Gagal memuat anggota' });
  }
});

// GET/POST /api/channels/:channelId/participants — who is in a group.
//
// Adding is admin-only: it is room structure, the same class of action as
// creating the channel ('channel:create'), so it reuses the same tier rather
// than inventing a softer one.
roomMembers.get('/channels/:channelId/participants', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const channel = await prisma.channel.findUnique({ where: { id: req.params.channelId }, include: { room: true } });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const entry = await resolveEntry(prisma, channel.room, req.userId!);
    if (!entry.allowed) return res.status(403).json({ error: 'Bukan anggota room ini' });

    const rows = await prisma.conversationParticipant.findMany({
      where: { conversationId: groupConversationId(channel.id) },
      include: { user: { select: { id: true, displayName: true, email: true } } },
    });
    return res.json({ participants: rows.map((r) => ({ id: r.user.id, displayName: r.user.displayName, email: r.user.email })) });
  } catch (err) {
    console.error('[roomMembers] list participants error:', err);
    return res.status(500).json({ error: 'Gagal memuat peserta' });
  }
});

roomMembers.post('/channels/:channelId/participants', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userIds: unknown = req.body?.userIds;
    if (!Array.isArray(userIds) || userIds.some((u) => typeof u !== 'string')) {
      return res.status(400).json({ error: 'userIds harus array of string' });
    }
    const prisma = getPrisma();
    const channel = await prisma.channel.findUnique({ where: { id: req.params.channelId }, include: { room: true } });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const role = await resolveRoomRole(prisma, req.userId!, channel.roomId, channel.room.ownerId);
    if (!hasFeatureAccess(role, 'channel:create')) {
      return res.status(403).json({ error: 'Hanya admin yang bisa menambah peserta grup' });
    }

    // Only people already approved into the room. Without this an admin could
    // add a stranger — or someone still pending — into a group, which is a
    // back door around the approval gate.
    const allowed = await prisma.roomMember.findMany({
      where: { roomId: channel.roomId, status: 'active', userId: { in: userIds as string[] } },
      select: { userId: true },
    });
    const allowedIds = new Set(allowed.map((a) => a.userId));
    if (channel.room.ownerId && (userIds as string[]).includes(channel.room.ownerId)) allowedIds.add(channel.room.ownerId);

    const rejected = (userIds as string[]).filter((u) => !allowedIds.has(u));
    if (allowedIds.size === 0) {
      return res.status(400).json({ error: 'Tidak ada user yang valid untuk ditambahkan', rejected });
    }

    const conversationId = groupConversationId(channel.id);
    await prisma.conversationParticipant.createMany({
      data: [...allowedIds].map((userId) => ({ conversationId, userId })),
      skipDuplicates: true,
    });

    // Reported back rather than swallowed: "added 2 of 3" is information the
    // admin needs, and a silent partial success looks like a bug.
    return res.json({ added: [...allowedIds], rejected });
  } catch (err) {
    console.error('[roomMembers] add participants error:', err);
    return res.status(500).json({ error: 'Gagal menambah peserta' });
  }
});

// GET /api/admin/rooms-approval — every room plus whether it is gated, for
// the admin console's toggle list. Workspace-scoped like the queue above.
roomMembers.get('/admin/rooms-approval', authenticateToken, requireWorkspace('workspace:manageMembers'), async (_req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const rooms = await prisma.room.findMany({
      orderBy: { createdAt: 'desc' },
      select: { slug: true, name: true, requiresApproval: true, isPublic: true, restrictedAccess: true, restrictedMinRole: true, queueEnabled: true },
    });
    return res.json({ rooms });
  } catch (err) {
    console.error('[roomMembers] rooms-approval error:', err);
    return res.status(500).json({ error: 'Gagal memuat daftar room' });
  }
});

// PATCH /api/rooms/:slug/approval — turn the gate on or off for one room.
//
// Gated at room admin ('room:update') rather than workspace admin: this is
// room configuration, and the room's own admin is exactly who should decide
// whether their room takes walk-ins.
//
// Turning it ON never evicts anyone: resolveEntry lets an existing 'active'
// member straight through regardless of the current setting, so the gate only
// applies to people who aren't in yet.
roomMembers.patch('/rooms/:slug/approval', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const requiresApproval = req.body?.requiresApproval;
    if (typeof requiresApproval !== 'boolean') {
      return res.status(400).json({ error: 'requiresApproval harus boolean' });
    }
    const prisma = getPrisma();
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Hanya admin room yang bisa mengubah setelan ini' });

    const updated = await prisma.room.update({
      where: { id: room!.id },
      data: { requiresApproval },
      select: { slug: true, requiresApproval: true },
    });
    return res.json(updated);
  } catch (err) {
    console.error('[roomMembers] set approval error:', err);
    return res.status(500).json({ error: 'Gagal menyimpan setelan' });
  }
});

// QA (Akses ruang checklist item 1, "Ruang sensitif terkontrol") — turn the
// stricter gate on/off for one room, same shape as PATCH /approval above
// (same room-admin gate, same "existing active+sufficient-role members
// aren't evicted" posture — see resolveEntry's own comment).
roomMembers.patch('/rooms/:slug/restricted', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const restrictedAccess = req.body?.restrictedAccess;
    if (typeof restrictedAccess !== 'boolean') {
      return res.status(400).json({ error: 'restrictedAccess harus boolean' });
    }
    const restrictedMinRole = req.body?.restrictedMinRole;
    if (restrictedMinRole !== undefined && !['staff', 'admin', 'owner'].includes(restrictedMinRole)) {
      return res.status(400).json({ error: 'restrictedMinRole tidak valid' });
    }
    // "Ngobrol dengan CEO" queue toggle — bundled into this same endpoint
    // (rather than a separate route) because it's configured from the exact
    // same Admin Console section as restrictedAccess itself, and only ever
    // makes sense alongside it.
    const queueEnabled = req.body?.queueEnabled;
    if (queueEnabled !== undefined && typeof queueEnabled !== 'boolean') {
      return res.status(400).json({ error: 'queueEnabled harus boolean' });
    }
    const prisma = getPrisma();
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Hanya admin room yang bisa mengubah setelan ini' });

    const updated = await prisma.room.update({
      where: { id: room!.id },
      data: {
        restrictedAccess,
        ...(restrictedMinRole ? { restrictedMinRole } : {}),
        ...(queueEnabled !== undefined ? { queueEnabled } : {}),
      },
      select: { slug: true, restrictedAccess: true, restrictedMinRole: true, queueEnabled: true },
    });
    return res.json(updated);
  } catch (err) {
    console.error('[roomMembers] set restricted error:', err);
    return res.status(500).json({ error: 'Gagal menyimpan setelan' });
  }
});

// ── "Ngobrol dengan CEO" queue ──────────────────────────────────────────
// Self-service (join/mine/cancel) needs only authentication — that's the
// whole point, a restricted room with queueing on has NO admin-mediated
// self-service path otherwise. Management (list/skip) reuses requireRoomAdmin,
// same gate as the access-grant/revoke endpoints above.

// `zoneId` throughout this block: absent/undefined means the ROOM-level
// queue (Room.restrictedAccess); present means a queue scoped to one ZONE
// within the room (ZoneRestriction) — "ruang CEO" turned out to be a zone,
// not a separate Room, so these two levels share one REST surface rather
// than duplicating it. Always normalized to `string | null` before touching
// Prisma, never left as `undefined` (a Prisma `where` filter treats a
// missing key as "don't filter", which would silently match BOTH kinds).
function normalizeZoneId(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

// GET /api/rooms/:slug/queue/mine?zoneId=... — the requester's own ticket,
// if any, plus their live position (only meaningful while 'waiting' — once
// 'called' or 'active' there's nothing left to wait behind). Polled by the
// client every few seconds while waiting, same convention as JoinGate's
// existing 'pending' poll for ordinary approval-gated rooms.
roomMembers.get('/rooms/:slug/queue/mine', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const zoneId = normalizeZoneId(req.query.zoneId);
    const prisma = getPrisma();
    const room = await prisma.room.findUnique({ where: { slug: req.params.slug } });
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const entry = await prisma.roomQueueEntry.findFirst({
      where: { roomId: room.id, zoneId, userId: req.userId!, status: { in: ['waiting', 'called', 'active'] } },
      orderBy: { requestedAt: 'desc' },
    });
    if (!entry) return res.json({ entry: null });

    let position: number | null = null;
    if (entry.status === 'waiting') {
      position = 1 + (await prisma.roomQueueEntry.count({
        where: { roomId: room.id, zoneId, status: 'waiting', requestedAt: { lt: entry.requestedAt } },
      }));
    }
    return res.json({
      entry: {
        id: entry.id,
        status: entry.status,
        durationMin: entry.durationMin,
        position,
        calledAt: entry.calledAt?.getTime() ?? null,
        endsAt: entry.endsAt?.getTime() ?? null,
      },
    });
  } catch (err) {
    console.error('[roomMembers] queue/mine error:', err);
    return res.status(500).json({ error: 'Gagal memuat status antrean' });
  }
});

// POST /api/rooms/:slug/queue/join — { topic?, durationMin, zoneId? } — the
// form submit. Idempotent like join-request above: re-posting while already
// queued just returns the existing ticket instead of stacking duplicates.
roomMembers.post('/rooms/:slug/queue/join', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const durationMin = Math.round(Number(req.body?.durationMin));
    if (!Number.isFinite(durationMin) || durationMin < QUEUE_MIN_MINUTES || durationMin > QUEUE_MAX_MINUTES) {
      return res.status(400).json({ error: `Durasi harus antara ${QUEUE_MIN_MINUTES}-${QUEUE_MAX_MINUTES} menit` });
    }
    const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim().slice(0, 300) || null : null;
    const zoneId = normalizeZoneId(req.body?.zoneId);

    const prisma = getPrisma();
    const room = await prisma.room.findUnique({ where: { slug: req.params.slug } });
    if (!room) return res.status(404).json({ error: 'Room not found' });

    let zoneName: string | null = null;
    if (zoneId) {
      const restriction = await prisma.zoneRestriction.findUnique({ where: { roomId_zoneId: { roomId: room.id, zoneId } } });
      if (!restriction?.queueEnabled) return res.status(400).json({ error: 'Zona ini tidak membuka antrean' });
      const zone = zonesOfRoom(room).find((z) => z.id === zoneId);
      zoneName = zone?.name ?? zoneId;
      const decision = await resolveZoneEntry(prisma, room, zoneId, req.userId!);
      if (decision.allowed) return res.status(400).json({ error: 'Kamu sudah punya akses ke zona ini' });
    } else {
      if (!room.restrictedAccess || !room.queueEnabled) {
        return res.status(400).json({ error: 'Room ini tidak membuka antrean' });
      }
      const entry = await resolveEntry(prisma, room, req.userId!);
      if (entry.allowed) return res.status(400).json({ error: 'Kamu sudah punya akses ke room ini' });
    }

    const existing = await prisma.roomQueueEntry.findFirst({
      where: { roomId: room.id, zoneId, userId: req.userId!, status: { in: ['waiting', 'called', 'active'] } },
    });
    if (existing) return res.status(200).json({ status: existing.status, id: existing.id });

    const requester = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } });
    const created = await prisma.roomQueueEntry.create({
      data: {
        roomId: room.id,
        zoneId,
        zoneName,
        userId: req.userId!,
        name: requester?.displayName || 'Seseorang',
        topic,
        durationMin,
        status: 'waiting',
      },
    });

    // Opportunistic — if the room/zone's slot happens to be free right now
    // (e.g. this is the only person waiting), this is what actually calls
    // them rather than making them wait for the next 20s sweep tick. A no-op
    // for zone-level entries now (see advanceQueue's own doc comment) —
    // those wait on the ZONE_QUEUE_REQUESTED push just below instead.
    await advanceQueue(prisma, room.id, zoneId);

    // "Ngobrol dengan CEO" queue, zone-level — approval-gated (see
    // advanceQueue above), so this is the ONLY signal an admin gets that
    // someone's waiting; fanned out to every admin socket currently
    // connected to the room, same posture as JOIN_REQUESTED.
    if (zoneId && ioRef) {
      const adminSocketIds = getConnectedAdminSocketIds(room.slug);
      for (const sid of adminSocketIds) {
        ioRef.to(sid).emit(SocketEvents.ZONE_QUEUE_REQUESTED, {
          entryId: created.id,
          userId: req.userId!,
          name: created.name,
          topic,
          durationMin,
          roomSlug: room.slug,
          roomName: room.name,
          zoneId,
          zoneName: zoneName ?? zoneId,
        });
      }
    }

    return res.status(201).json({ status: 'waiting', id: created.id });
  } catch (err) {
    console.error('[roomMembers] queue/join error:', err);
    return res.status(500).json({ error: 'Gagal mendaftar antrean' });
  }
});

// POST /api/rooms/:slug/queue/cancel — { zoneId? } — the requester changing
// their mind while still 'waiting' or 'called'. Deliberately does NOT
// accept 'active' (leaving mid-session goes through the ordinary in-room/
// in-zone leave flow, which already completes the ticket immediately — see
// roomHandler.ts's handleLeave and zoneHandler.ts's ZONE_EXIT).
roomMembers.post('/rooms/:slug/queue/cancel', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const zoneId = normalizeZoneId(req.body?.zoneId);
    const prisma = getPrisma();
    const room = await prisma.room.findUnique({ where: { slug: req.params.slug } });
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const entry = await prisma.roomQueueEntry.findFirst({
      where: { roomId: room.id, zoneId, userId: req.userId!, status: { in: ['waiting', 'called'] } },
    });
    if (!entry) return res.status(404).json({ error: 'Tidak ada antrean aktif' });

    await prisma.roomQueueEntry.update({ where: { id: entry.id }, data: { status: 'cancelled' } });
    if (entry.status === 'called') await advanceQueue(prisma, room.id, zoneId);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[roomMembers] queue/cancel error:', err);
    return res.status(500).json({ error: 'Gagal membatalkan antrean' });
  }
});

// GET /api/rooms/:slug/queue?zoneId=... — the admin's live view of the
// whole line, for the Admin Console's queue manager.
roomMembers.get('/rooms/:slug/queue', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const zoneId = normalizeZoneId(req.query.zoneId);
    const prisma = getPrisma();
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Hanya admin room yang bisa melihat antrean' });

    const rows = await prisma.roomQueueEntry.findMany({
      where: { roomId: room!.id, zoneId, status: { in: ['waiting', 'called', 'active'] } },
      orderBy: { requestedAt: 'asc' },
    });
    return res.json({
      queueEnabled: room!.queueEnabled,
      entries: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        name: r.name,
        topic: r.topic,
        durationMin: r.durationMin,
        status: r.status,
        requestedAt: r.requestedAt.getTime(),
        calledAt: r.calledAt?.getTime() ?? null,
        endsAt: r.endsAt?.getTime() ?? null,
      })),
    });
  } catch (err) {
    console.error('[roomMembers] queue list error:', err);
    return res.status(500).json({ error: 'Gagal memuat antrean' });
  }
});

// POST /api/rooms/:slug/queue/:entryId/skip — admin force-removes any entry
// (waiting, called, or the one currently active), same as PLAYER_KICK is to
// an ordinary member — for a no-show that's about to expire on its own
// anyway, or someone who needs to be bumped from the line right now. Works
// for both room- and zone-level tickets — entry.zoneId (not a request
// param) decides which kind of removal to perform.
roomMembers.post('/rooms/:slug/queue/:entryId/skip', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Hanya admin room yang bisa mengubah antrean' });

    const entry = await prisma.roomQueueEntry.findUnique({ where: { id: req.params.entryId } });
    if (!entry || entry.roomId !== room!.id || !['waiting', 'called', 'active'].includes(entry.status)) {
      return res.status(404).json({ error: 'Entri antrean tidak ditemukan' });
    }

    const wasActive = entry.status === 'active';
    await prisma.roomQueueEntry.update({
      where: { id: entry.id },
      data: wasActive ? { status: 'done', completedAt: new Date() } : { status: 'skipped' },
    });
    if (wasActive && ioRef) {
      if (entry.zoneId) {
        forceZoneExitForQueue(ioRef, entry.userId, room!.slug, entry.zoneId, entry.zoneName ?? entry.zoneId);
      } else {
        await forceLeaveForQueue(ioRef, entry.userId, room!.slug, room!.name);
      }
    }
    await advanceQueue(prisma, room!.id, entry.zoneId);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[roomMembers] queue skip error:', err);
    return res.status(500).json({ error: 'Gagal mengubah antrean' });
  }
});

// POST /api/rooms/:slug/queue/:entryId/approve — admin explicitly admits a
// 'waiting' zone-level entry (see roomQueue.ts's advanceQueue — zone-level
// no longer auto-advances, this is the replacement). SERIALIZABLE
// transaction for the same reason advanceQueue itself uses one: two admins
// approving different people at the same instant must not both succeed
// against a single-occupant slot.
roomMembers.post('/rooms/:slug/queue/:entryId/approve', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Hanya admin room yang bisa menyetujui antrean' });

    const entry = await prisma.roomQueueEntry.findUnique({ where: { id: req.params.entryId } });
    if (!entry || entry.roomId !== room!.id || entry.status !== 'waiting') {
      return res.status(404).json({ error: 'Antrean ini sudah tidak berlaku' });
    }

    const approved = await prisma.$transaction(async (tx) => {
      const occupied = await tx.roomQueueEntry.findFirst({
        where: { roomId: room!.id, zoneId: entry.zoneId, status: { in: ['called', 'active'] } },
      });
      if (occupied) return false;
      await tx.roomQueueEntry.update({ where: { id: entry.id }, data: { status: 'called', calledAt: new Date() } });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    if (!approved) return res.status(409).json({ error: 'Slot sedang terisi orang lain' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[roomMembers] queue approve error:', err);
    return res.status(500).json({ error: 'Gagal menyetujui antrean' });
  }
});

// GET /api/rooms/:slug/zone-restrictions — every zone in the room that
// currently requires staff+ or a queue ticket, for the Admin Console.
roomMembers.get('/rooms/:slug/zone-restrictions', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Hanya admin room yang bisa melihat ini' });

    const rows = await prisma.zoneRestriction.findMany({ where: { roomId: room!.id } });
    return res.json({
      zones: zonesOfRoom(room!).map((z) => ({ id: z.id, name: z.name })),
      restrictions: rows.map((r) => ({ zoneId: r.zoneId, minRole: r.minRole, queueEnabled: r.queueEnabled })),
    });
  } catch (err) {
    console.error('[roomMembers] zone-restrictions list error:', err);
    return res.status(500).json({ error: 'Gagal memuat daftar zona' });
  }
});

// PATCH /api/rooms/:slug/zones/:zoneId/restriction — { enabled, minRole?,
// queueEnabled? }. enabled:false deletes the row outright (an absent row
// IS "not restricted" — there is no separate off-switch to flip back on
// accidentally). Refreshes the in-memory cache ZONE_ENTER reads AND
// broadcasts to the room so anyone already standing there updates without
// needing to rejoin.
roomMembers.patch('/rooms/:slug/zones/:zoneId/restriction', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled harus boolean' });
    const minRole = req.body?.minRole;
    if (minRole !== undefined && !['staff', 'admin', 'owner'].includes(minRole)) {
      return res.status(400).json({ error: 'minRole tidak valid' });
    }
    const queueEnabled = req.body?.queueEnabled;
    if (queueEnabled !== undefined && typeof queueEnabled !== 'boolean') {
      return res.status(400).json({ error: 'queueEnabled harus boolean' });
    }

    const prisma = getPrisma();
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Hanya admin room yang bisa mengubah setelan ini' });

    const zoneId = req.params.zoneId;
    if (enabled) {
      await prisma.zoneRestriction.upsert({
        where: { roomId_zoneId: { roomId: room!.id, zoneId } },
        create: { roomId: room!.id, zoneId, minRole: minRole ?? 'staff', queueEnabled: queueEnabled ?? true },
        update: { ...(minRole ? { minRole } : {}), ...(queueEnabled !== undefined ? { queueEnabled } : {}) },
      });
    } else {
      await prisma.zoneRestriction.deleteMany({ where: { roomId: room!.id, zoneId } });
    }

    const restrictions = await refreshZoneRestrictionCache(prisma, room!.slug, room!.id);
    if (ioRef) ioRef.to(room!.slug).emit(SocketEvents.ZONE_RESTRICTIONS, { zones: restrictions });

    return res.json({ ok: true, restrictions });
  } catch (err) {
    console.error('[roomMembers] zone restriction update error:', err);
    return res.status(500).json({ error: 'Gagal menyimpan setelan' });
  }
});

// GET /api/rooms/:slug/access-list — everyone currently holding a
// RoomMember row with role staff/admin (owner is implicit — the room's
// own ownerId, not a RoomMember row) — i.e. exactly who a restricted room
// currently admits, for the Admin Console's room-access manager to display.
roomMembers.get('/rooms/:slug/access-list', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Hanya admin room yang bisa melihat ini' });

    const members = await prisma.roomMember.findMany({
      where: { roomId: room!.id, role: { in: ['staff', 'admin'] } },
      include: { user: { select: { id: true, displayName: true, email: true } } },
      orderBy: { joinedAt: 'asc' },
    });
    return res.json({
      members: members.map((m) => ({ userId: m.userId, displayName: m.user.displayName, email: m.user.email, role: m.role, status: m.status })),
    });
  } catch (err) {
    console.error('[roomMembers] access-list error:', err);
    return res.status(500).json({ error: 'Gagal memuat daftar akses' });
  }
});

// POST /api/rooms/:slug/access-grant — grant a user staff/admin role in
// THIS room directly, without requiring them to be online/present — the
// socket-based ADMIN_GRANT/STAFF_GRANT (roomHandler.ts) only works against
// someone currently standing in front of you, which is circular for a
// restricted room nobody unauthorized can even enter to be granted access
// from inside. Deliberately does NOT require an existing 'active'
// membership row first — granting IS how someone gets one, same as
// approving a join-request does.
roomMembers.post('/rooms/:slug/access-grant', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const targetUserId = req.body?.userId;
    const role = req.body?.role;
    if (typeof targetUserId !== 'string' || !targetUserId) return res.status(400).json({ error: 'userId wajib diisi' });
    if (role !== 'staff' && role !== 'admin') return res.status(400).json({ error: 'role harus staff atau admin' });

    const prisma = getPrisma();
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Hanya admin room yang bisa memberi akses' });

    const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, displayName: true } });
    if (!target) return res.status(404).json({ error: 'User tidak ditemukan' });

    await prisma.roomMember.upsert({
      where: { userId_roomId: { userId: targetUserId, roomId: room!.id } },
      create: { userId: targetUserId, roomId: room!.id, role, status: 'active' },
      // status:'active' unconditionally — a grant is an explicit admit
      // decision, same as approving a pending join-request; a previously
      // 'rejected' or 'pending' row must not stay stuck once an admin has
      // directly handed this person a role.
      update: { role, status: 'active' },
    });
    return res.json({ ok: true, userId: targetUserId, displayName: target.displayName, role });
  } catch (err) {
    console.error('[roomMembers] access-grant error:', err);
    return res.status(500).json({ error: 'Gagal memberi akses' });
  }
});

// POST /api/rooms/:slug/access-revoke — the inverse: drop back to plain
// 'member' (not deleted outright — they may still have ordinary walk-in
// membership in a non-restricted room; only the ELEVATED role that
// satisfied restrictedMinRole is what's being taken away).
roomMembers.post('/rooms/:slug/access-revoke', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const targetUserId = req.body?.userId;
    if (typeof targetUserId !== 'string' || !targetUserId) return res.status(400).json({ error: 'userId wajib diisi' });

    const prisma = getPrisma();
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Hanya admin room yang bisa mencabut akses' });
    if (targetUserId === room!.ownerId) return res.status(400).json({ error: 'Tidak bisa mencabut akses pemilik room' });

    await prisma.roomMember.updateMany({
      where: { userId: targetUserId, roomId: room!.id },
      data: { role: 'member' },
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[roomMembers] access-revoke error:', err);
    return res.status(500).json({ error: 'Gagal mencabut akses' });
  }
});

export default roomMembers;
