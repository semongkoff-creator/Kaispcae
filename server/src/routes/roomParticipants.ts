import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { findRoomInOrg } from '../lib/orgScope';
import { canAccessRoomChat } from '../lib/chatAccess';

const roomParticipants = Router();

// GET /api/rooms/:slug/participants — specs/2026-08-21-room-scoped-participants-design.md.
// Replaces the old org-wide GET /org/members: "participant of this room"
// means has EVER had a StatusInterval row for this room's slug (i.e. has
// actually been active here before), not "is in the organization" — someone
// active only in a DIFFERENT room of the same org no longer shows up here at
// all. Feeds ParticipantPanel.tsx's "Offline" section; "Online" is derived
// entirely client-side from live socket data and doesn't call this route.
//
// Deliberately NOT named/pathed `/rooms/:slug/members` — that path already
// belongs to routes/roomMembers.ts's group-chat "add members" picker (a
// different concept: currently-approved RoomMember rows, not activity
// history). Do not merge with or rename that route; it's a separate,
// unrelated, already-shipped feature.
roomParticipants.get('/rooms/:slug/participants', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await findRoomInOrg(prisma, req.params.slug, req.organizationId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!(await canAccessRoomChat(prisma, room, req.userId!, req.organizationId))) {
      return res.status(403).json({ error: 'Not a member of this room' });
    }

    const intervals = await prisma.statusInterval.findMany({
      where: { roomSlug: room.slug },
      select: { userId: true },
      distinct: ['userId'],
    });
    const userIds = intervals.map((i) => i.userId);
    if (userIds.length === 0) return res.json({ members: [] });

    const users = await prisma.user.findMany({
      where: { id: { in: userIds }, organizationId: req.organizationId, active: true },
      select: { id: true, displayName: true, workspaceRole: true, lastSeenAt: true },
      orderBy: { displayName: 'asc' },
    });
    // specs/2026-08-21-last-seen-offline-members-design.md — Prisma's Date is
    // converted to epoch milliseconds explicitly here (rather than relying on
    // JSON.stringify's default Date->ISO-string behavior), matching this
    // codebase's existing numeric-timestamp convention for client-facing
    // fields.
    const members = users.map((u) => ({ ...u, lastSeenAt: u.lastSeenAt ? u.lastSeenAt.getTime() : null }));
    return res.json({ members });
  } catch (err) {
    console.error('[roomParticipants] list error:', err);
    return res.status(500).json({ error: 'Gagal memuat anggota room' });
  }
});

export default roomParticipants;
