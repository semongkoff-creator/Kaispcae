import { Router, Response } from 'express';
import { Server } from 'socket.io';
import { getPrisma } from '../lib/prisma';
import { hasFeatureAccess, SocketEvents } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveRoomRole } from '../lib/roles';
import { resolveEntry } from '../lib/roomMembership';
import { groupConversationId } from '../lib/conversations';
import { requireWorkspace } from '../lib/workspace';
import { getConnectedAdminSocketIds } from '../socket/roomHandler';

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

    await prisma.roomMember.upsert({
      where: { userId_roomId: { userId: req.userId!, roomId: room.id } },
      create: { userId: req.userId!, roomId: room.id, status: 'pending', role: 'member' },
      update: { status: 'pending', requestedAt: new Date(), decidedById: null, decidedAt: null },
    });

    // Item #5 — pop this up on every admin's screen right now, instead of
    // relying on the manual queue (or the 20s badge poll) to ever be opened.
    // Targeted at exactly the admin sockets currently connected to this room
    // (same fan-out as ROOM_KNOCK_REQUEST) rather than a room-wide broadcast:
    // a non-admin bystander must never receive this. An admin who isn't
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
      select: { slug: true, name: true, requiresApproval: true, isPublic: true },
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

export default roomMembers;
