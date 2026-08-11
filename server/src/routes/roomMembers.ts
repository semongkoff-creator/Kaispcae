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
import { getConnectedAdminSocketIds, getConnectedCeoSocketIds, forceLeaveForQueue, forceZoneExitForQueue, broadcastZoneQueueSessionCleared, markSpawnNearUser, advanceZoneQuickQueue } from '../socket/roomHandler';
import { advanceQueue, QUEUE_MIN_MINUTES, QUEUE_MAX_MINUTES } from '../lib/roomQueue';
import { findRoomInOrg, findUserInOrg } from '../lib/orgScope';

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
// Multi-tenant Fase 2 — organizationId threaded through so a slug from a
// different org 404s here (same as "doesn't exist"), same helper as
// rooms.ts's own room lookups use. Every caller below passes req.organizationId.
async function requireRoomAdmin(prisma: ReturnType<typeof getPrisma>, slug: string, userId: string, organizationId: string | undefined) {
  const room = await findRoomInOrg(prisma, slug, organizationId);
  if (!room) return { error: 404 as const, room: null };
  const role = await resolveRoomRole(prisma, userId, room.id, room.ownerId);
  if (!hasFeatureAccess(role, 'room:update')) return { error: 403 as const, room };
  return { error: null, room };
}

// "Ngobrol dengan CEO" queue — same shape as requireRoomAdmin above, but
// also passes for whoever's been granted CEO access (RoomMember.isCeo),
// even though that grant deliberately carries no other room-admin
// privilege (see roomHandler.ts's RoomAdminState.ceoUserIds doc comment).
// It's their queue to approve/reject — an ordinary admin can still act on
// it too (moderation override), this only widens who ALSO can.
async function requireRoomAdminOrCeo(prisma: ReturnType<typeof getPrisma>, slug: string, userId: string, organizationId: string | undefined) {
  const room = await findRoomInOrg(prisma, slug, organizationId);
  if (!room) return { error: 404 as const, room: null };
  const role = await resolveRoomRole(prisma, userId, room.id, room.ownerId);
  if (hasFeatureAccess(role, 'room:update')) return { error: null, room };
  const member = await prisma.roomMember.findUnique({ where: { userId_roomId: { userId, roomId: room.id } }, select: { isCeo: true } });
  if (member?.isCeo) return { error: null, room };
  return { error: 403 as const, room };
}

// POST /api/rooms/:slug/join-request — what an invite link actually does now.
// Idempotent: re-posting while pending returns the same pending state instead
// of stacking duplicate requests.
roomMembers.post('/rooms/:slug/join-request', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
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
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!, req.organizationId);
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
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!, req.organizationId);
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

    // Spawn near the admin who approved — see roomHandler.ts's
    // markSpawnNearUser doc comment. Approve-only: a reject has no join to
    // place, and this is scoped to the explicit pending->decided transition
    // (not the "room is open, walk in freely" path, which has no specific
    // inviter to land beside).
    if (decision === 'approve') markSpawnNearUser(room!.slug, req.params.userId, req.userId!);

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
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
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
roomMembers.get('/admin/join-requests', authenticateToken, requireWorkspace('workspace:manageMembers'), async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    // Multi-tenant Fase 2 — used to have no org filter, so a workspace
    // admin saw pending join requests for every room in every org.
    const rows = await prisma.roomMember.findMany({
      where: { status: 'pending', room: { organizationId: req.organizationId } },
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
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
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
    // Multi-tenant Fase 2 — Channel has no organizationId of its own, but its
    // room relation does; a channel whose room belongs to another org reads
    // as "not found", same as every other cross-org lookup in this codebase.
    if (!channel || channel.room.organizationId !== req.organizationId) return res.status(404).json({ error: 'Channel not found' });

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
    if (!channel || channel.room.organizationId !== req.organizationId) return res.status(404).json({ error: 'Channel not found' });

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
roomMembers.get('/admin/rooms-approval', authenticateToken, requireWorkspace('workspace:manageMembers'), async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    // Multi-tenant Fase 2 — used to have no where at all, returning every
    // room in the deployment to any workspace admin.
    const rooms = await prisma.room.findMany({
      where: { organizationId: req.organizationId },
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
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!, req.organizationId);
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
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!, req.organizationId);
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
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const entry = await prisma.roomQueueEntry.findFirst({
      where: { roomId: room.id, zoneId, userId: req.userId!, status: { in: ['waiting', 'called', 'active'] } },
      orderBy: { requestedAt: 'desc' },
    });
    if (!entry) return res.json({ entry: null });

    // Position is a 'quick' FCFS-line concept only — a 'booking' entry's
    // place isn't determined by submit order, it's whenever the CEO
    // approves + whatever bookingStart was picked, so there's no meaningful
    // number to show while it's still 'waiting' on a decision.
    let position: number | null = null;
    if (entry.status === 'waiting' && entry.mode === 'quick') {
      position = 1 + (await prisma.roomQueueEntry.count({
        where: { roomId: room.id, zoneId, mode: 'quick', status: 'waiting', requestedAt: { lt: entry.requestedAt } },
      }));
    }
    return res.json({
      entry: {
        id: entry.id,
        status: entry.status,
        durationMin: entry.durationMin,
        mode: entry.mode,
        bookingStart: entry.bookingStart?.getTime() ?? null,
        bookingEnd: entry.bookingEnd?.getTime() ?? null,
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

// POST /api/rooms/:slug/queue/join — { topic?, durationMin, zoneId? } for the
// original 'quick' FCFS form, or { mode: 'booking', bookingStart, bookingEnd,
// topic?, zoneId } for a scheduled CEO booking (v2 — only valid for a
// bookingMode zone). Idempotent like join-request above: re-posting while
// already queued just returns the existing ticket instead of stacking
// duplicates.
roomMembers.post('/rooms/:slug/queue/join', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const mode = req.body?.mode === 'booking' ? 'booking' : 'quick';
    const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim().slice(0, 300) || null : null;
    const zoneId = normalizeZoneId(req.body?.zoneId);

    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    let zoneName: string | null = null;
    let zoneBookingMode = false;
    if (zoneId) {
      const restriction = await prisma.zoneRestriction.findUnique({ where: { roomId_zoneId: { roomId: room.id, zoneId } } });
      zoneBookingMode = !!restriction?.bookingMode;
      // bookingMode ignores minRole/queueEnabled entirely — the zone is
      // always freely walkable, so there's nothing to gate the FORM behind
      // either. A non-bookingMode zone keeps the original gated behavior.
      if (!zoneBookingMode && !restriction?.queueEnabled) {
        return res.status(400).json({ error: 'Zona ini tidak membuka antrean' });
      }
      const zone = zonesOfRoom(room).find((z) => z.id === zoneId);
      zoneName = zone?.name ?? zoneId;
      if (!zoneBookingMode) {
        const decision = await resolveZoneEntry(prisma, room, zoneId, req.userId!);
        if (decision.allowed) return res.status(400).json({ error: 'Kamu sudah punya akses ke zona ini' });
      }
    } else {
      if (mode === 'booking') return res.status(400).json({ error: 'Booking hanya berlaku untuk zona' });
      if (!room.restrictedAccess || !room.queueEnabled) {
        return res.status(400).json({ error: 'Room ini tidak membuka antrean' });
      }
      const entry = await resolveEntry(prisma, room, req.userId!);
      if (entry.allowed) return res.status(400).json({ error: 'Kamu sudah punya akses ke room ini' });
    }
    if (mode === 'booking' && !zoneBookingMode) {
      return res.status(400).json({ error: 'Zona ini tidak mendukung booking' });
    }

    let durationMin: number;
    let bookingStart: Date | null = null;
    let bookingEnd: Date | null = null;
    if (mode === 'booking') {
      const startMs = Number(req.body?.bookingStart);
      const endMs = Number(req.body?.bookingEnd);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        return res.status(400).json({ error: 'Jam mulai/selesai tidak valid' });
      }
      bookingStart = new Date(startMs);
      bookingEnd = new Date(endMs);
      if (bookingStart.getTime() <= Date.now()) {
        return res.status(400).json({ error: 'Jam mulai harus di masa depan' });
      }
      durationMin = Math.round((bookingEnd.getTime() - bookingStart.getTime()) / 60000);
      if (durationMin < QUEUE_MIN_MINUTES || durationMin > QUEUE_MAX_MINUTES) {
        return res.status(400).json({ error: `Durasi harus antara ${QUEUE_MIN_MINUTES}-${QUEUE_MAX_MINUTES} menit` });
      }
      // Best-effort — the authoritative check is the SERIALIZABLE transaction
      // inside the approve endpoint below; this just saves the requester a
      // trip when the clash is obvious up front.
      const clash = await prisma.roomQueueEntry.findFirst({
        where: {
          roomId: room.id, zoneId, mode: 'booking', status: { in: ['called', 'active'] },
          bookingStart: { lt: bookingEnd }, bookingEnd: { gt: bookingStart },
        },
      });
      if (clash) return res.status(409).json({ error: 'Jadwal ini bentrok dengan booking lain yang sudah disetujui' });
    } else {
      durationMin = Math.round(Number(req.body?.durationMin));
      if (!Number.isFinite(durationMin) || durationMin < QUEUE_MIN_MINUTES || durationMin > QUEUE_MAX_MINUTES) {
        return res.status(400).json({ error: `Durasi harus antara ${QUEUE_MIN_MINUTES}-${QUEUE_MAX_MINUTES} menit` });
      }
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
        mode,
        bookingStart,
        bookingEnd,
        status: 'waiting',
      },
    });

    // Opportunistic — if the room's (or zone-level 'quick') slot happens to
    // be free right now, this is what actually calls them rather than making
    // them wait for the next 20s sweep tick. A 'booking' entry is invisible
    // to this — it only ever moves waiting -> called via the explicit
    // approve endpoint below, never auto-promoted. Zone-level goes through
    // the teleport-aware wrapper (full-auto FCFS, v2); room-level is
    // untouched — it still waits for JOIN_ROOM's own admitCalledEntry.
    if (zoneId && ioRef) await advanceZoneQuickQueue(ioRef, room.id, room.slug, zoneId);
    else await advanceQueue(prisma, room.id, zoneId);

    // "Ngobrol dengan CEO" queue, zone-level, 'booking' only — a 'quick'
    // entry needs no decision (full-auto FCFS, see advanceQueue), so paging
    // the CEO for one would just be noise. Goes to whoever's actually been
    // granted CEO access for this room, NOT every room admin.
    if (zoneId && mode === 'booking' && ioRef) {
      const ceoSocketIds = getConnectedCeoSocketIds(room.slug);
      for (const sid of ceoSocketIds) {
        ioRef.to(sid).emit(SocketEvents.ZONE_QUEUE_REQUESTED, {
          entryId: created.id,
          userId: req.userId!,
          name: created.name,
          topic,
          durationMin,
          mode,
          bookingStart: bookingStart!.getTime(),
          bookingEnd: bookingEnd!.getTime(),
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
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const entry = await prisma.roomQueueEntry.findFirst({
      where: { roomId: room.id, zoneId, userId: req.userId!, status: { in: ['waiting', 'called'] } },
    });
    if (!entry) return res.status(404).json({ error: 'Tidak ada antrean aktif' });

    await prisma.roomQueueEntry.update({ where: { id: entry.id }, data: { status: 'cancelled' } });
    if (entry.status === 'called') {
      if (zoneId && ioRef) await advanceZoneQuickQueue(ioRef, room.id, room.slug, zoneId);
      else await advanceQueue(prisma, room.id, zoneId);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[roomMembers] queue/cancel error:', err);
    return res.status(500).json({ error: 'Gagal membatalkan antrean' });
  }
});

// GET /api/rooms/:slug/queue?zoneId=... — the admin/CEO's live view of the
// whole line (Admin Console's queue manager, and v2's in-game "Selesai
// meeting" widget). requireRoomAdminOrCeo, not requireRoomAdmin — a CEO
// grant is deliberately independent of room admin (see RoomAdminState's own
// doc comment), so a non-admin CEO must still be able to see their own
// zone's queue, same gate the approve/skip endpoints below already use.
roomMembers.get('/rooms/:slug/queue', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const zoneId = normalizeZoneId(req.query.zoneId);
    const prisma = getPrisma();
    const { error, room } = await requireRoomAdminOrCeo(prisma, req.params.slug, req.userId!, req.organizationId);
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
        mode: r.mode,
        bookingStart: r.bookingStart?.getTime() ?? null,
        bookingEnd: r.bookingEnd?.getTime() ?? null,
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
    const { error, room } = await requireRoomAdminOrCeo(prisma, req.params.slug, req.userId!, req.organizationId);
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
    // Same endpoint doubles as the CEO's "Selesai meeting" button (client
    // just relabels it when the target entry is 'active') — reuse rather
    // than a new one, per the v2 design doc.
    let zoneBookingMode = false;
    if (entry.zoneId) {
      const restriction = await prisma.zoneRestriction.findUnique({ where: { roomId_zoneId: { roomId: room!.id, zoneId: entry.zoneId } } });
      zoneBookingMode = !!restriction?.bookingMode;
    }
    if (wasActive && ioRef) {
      if (entry.zoneId) {
        // bookingMode: the zone stays freely walkable after the session ends
        // — only the queue bookkeeping/countdown stops, nobody gets nudged out.
        forceZoneExitForQueue(ioRef, entry.userId, room!.slug, entry.zoneId, entry.zoneName ?? entry.zoneId, !zoneBookingMode);
        broadcastZoneQueueSessionCleared(ioRef, room!.slug, entry.zoneId);
      } else {
        await forceLeaveForQueue(ioRef, entry.userId, room!.slug, room!.name);
      }
    }
    if (entry.zoneId && ioRef) await advanceZoneQuickQueue(ioRef, room!.id, room!.slug, entry.zoneId);
    else await advanceQueue(prisma, room!.id, entry.zoneId);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[roomMembers] queue skip error:', err);
    return res.status(500).json({ error: 'Gagal mengubah antrean' });
  }
});

// POST /api/rooms/:slug/queue/:entryId/approve — admin/CEO explicitly admits
// a 'waiting' entry. Under v2, 'quick' entries are full-auto FCFS
// (advanceZoneQuickQueue) and never sit in 'waiting' long enough for a human
// to reach this — this endpoint is now really the 'booking' decision point
// (see roomQueue.ts's advanceQueue doc comment), kept mode-aware below only
// as a defense-in-depth fallback. SERIALIZABLE transaction for the same
// reason advanceQueue itself uses one: two admins approving overlapping
// requests at the same instant must not both succeed.
roomMembers.post('/rooms/:slug/queue/:entryId/approve', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const { error, room } = await requireRoomAdminOrCeo(prisma, req.params.slug, req.userId!, req.organizationId);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Hanya admin room yang bisa menyetujui antrean' });

    const entry = await prisma.roomQueueEntry.findUnique({ where: { id: req.params.entryId } });
    if (!entry || entry.roomId !== room!.id || entry.status !== 'waiting') {
      return res.status(404).json({ error: 'Antrean ini sudah tidak berlaku' });
    }
    if (entry.mode === 'booking' && entry.bookingEnd && entry.bookingEnd.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'Waktu booking ini sudah lewat' });
    }

    const approver = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } });

    const approved = await prisma.$transaction(async (tx) => {
      if (entry.mode === 'booking') {
        // Reserves a future WINDOW, not the physical slot right now — so the
        // only thing that can block it is another approved booking whose
        // window overlaps, never a currently-active quick/booking session.
        const clash = await tx.roomQueueEntry.findFirst({
          where: {
            roomId: room!.id, zoneId: entry.zoneId, mode: 'booking', status: { in: ['called', 'active'] },
            id: { not: entry.id },
            bookingStart: { lt: entry.bookingEnd! }, bookingEnd: { gt: entry.bookingStart! },
          },
        });
        if (clash) return false;
      } else {
        const occupied = await tx.roomQueueEntry.findFirst({
          where: { roomId: room!.id, zoneId: entry.zoneId, status: { in: ['called', 'active'] } },
        });
        if (occupied) return false;
      }
      await tx.roomQueueEntry.update({
        where: { id: entry.id },
        data: { status: 'called', calledAt: new Date(), approvedAt: new Date(), approvedById: req.userId!, approvedByName: approver?.displayName ?? null },
      });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    if (!approved) {
      return res.status(409).json({ error: entry.mode === 'booking' ? 'Jadwal ini bentrok dengan booking lain yang sudah disetujui' : 'Slot sedang terisi orang lain' });
    }
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
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!, req.organizationId);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Hanya admin room yang bisa melihat ini' });

    const rows = await prisma.zoneRestriction.findMany({ where: { roomId: room!.id } });
    return res.json({
      zones: zonesOfRoom(room!).map((z) => ({ id: z.id, name: z.name })),
      restrictions: rows.map((r) => ({ zoneId: r.zoneId, minRole: r.minRole, queueEnabled: r.queueEnabled, bookingMode: r.bookingMode })),
    });
  } catch (err) {
    console.error('[roomMembers] zone-restrictions list error:', err);
    return res.status(500).json({ error: 'Gagal memuat daftar zona' });
  }
});

// GET /api/rooms/:slug/booking-zones — any authenticated member (not
// admin-gated, unlike zone-restrictions above) — just the id+name of every
// zone flagged bookingMode, so the client's G-key booking form knows which
// zone to target without needing admin-only data.
roomMembers.get('/rooms/:slug/booking-zones', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const rows = await prisma.zoneRestriction.findMany({ where: { roomId: room.id, bookingMode: true } });
    const zoneNames = new Map(zonesOfRoom(room).map((z) => [z.id, z.name]));
    return res.json({
      zones: rows.map((r) => ({ zoneId: r.zoneId, name: zoneNames.get(r.zoneId) ?? r.zoneId })),
    });
  } catch (err) {
    console.error('[roomMembers] booking-zones list error:', err);
    return res.status(500).json({ error: 'Gagal memuat zona booking' });
  }
});

// PATCH /api/rooms/:slug/zones/:zoneId/restriction — { enabled, minRole?,
// queueEnabled?, bookingMode? }. enabled:false deletes the row outright (an
// absent row IS "not restricted" — there is no separate off-switch to flip
// back on accidentally). Refreshes the in-memory cache ZONE_ENTER reads AND
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
    // "Ngobrol dengan CEO" v2 — see ZoneRestriction.bookingMode's own doc
    // comment. Only one zone is expected to ever use this (the Q&A this
    // session settled on "assume 1 CEO zone per room" for the G-key form),
    // but nothing here enforces that singleton — an admin could flip it on
    // for more than one zone, the client just won't have a picker for it yet.
    const bookingMode = req.body?.bookingMode;
    if (bookingMode !== undefined && typeof bookingMode !== 'boolean') {
      return res.status(400).json({ error: 'bookingMode harus boolean' });
    }

    const prisma = getPrisma();
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!, req.organizationId);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Hanya admin room yang bisa mengubah setelan ini' });

    const zoneId = req.params.zoneId;
    if (enabled) {
      await prisma.zoneRestriction.upsert({
        where: { roomId_zoneId: { roomId: room!.id, zoneId } },
        create: { roomId: room!.id, zoneId, minRole: minRole ?? 'staff', queueEnabled: queueEnabled ?? true, bookingMode: bookingMode ?? false },
        update: { ...(minRole ? { minRole } : {}), ...(queueEnabled !== undefined ? { queueEnabled } : {}), ...(bookingMode !== undefined ? { bookingMode } : {}) },
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
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!, req.organizationId);
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
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!, req.organizationId);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Hanya admin room yang bisa memberi akses' });

    // Multi-tenant Fase 2 — the user being granted room access must be in
    // the same org as the room itself; otherwise a room admin could hand a
    // stranger-org account a staff/admin role in their room.
    const target = await findUserInOrg(prisma, targetUserId, req.organizationId, { id: true, displayName: true });
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
    const { error, room } = await requireRoomAdmin(prisma, req.params.slug, req.userId!, req.organizationId);
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
