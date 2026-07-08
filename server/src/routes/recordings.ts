import { Router, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { Role, hasFeatureAccess } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const recordings = Router();

function getPrisma(): PrismaClient {
  return new PrismaClient();
}

async function resolveRole(prisma: PrismaClient, userId: string, roomId: string, ownerId: string): Promise<Role> {
  if (userId === ownerId) return 'owner';
  const member = await prisma.roomMember.findUnique({ where: { userId_roomId: { userId, roomId } } });
  if (member?.role === 'admin') return 'admin';
  if (member?.role === 'staff') return 'staff';
  return 'member';
}

// §7 — visible to admin+ (manage all of this room's recordings) or the
// person who was recorded (wants their own copy) — same "creator or admin"
// shape as Add Media's delete rule, just read-only here.
recordings.get('/rooms/:slug/recordings', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const room = await prisma.room.findUnique({ where: { slug: req.params.slug } });
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const role = await resolveRole(prisma, req.userId!, room.id, room.ownerId);
    const rows = await prisma.recording.findMany({ where: { roomId: room.id }, orderBy: { startedAt: 'desc' } });
    const visible = hasFeatureAccess(role, 'recording:start')
      ? rows
      : rows.filter((r) => r.targetUserId === req.userId);

    return res.json({ recordings: visible });
  } catch (err) {
    console.error('[recordings] list error:', err);
    return res.status(500).json({ error: 'Failed to list recordings' });
  }
});

// §7 — every download checks count/expiry BEFORE serving and increments
// atomically, exactly matching the spec's own explicit rule ("setiap
// request download harus increment counter & cek sebelum serve file").
recordings.get('/recordings/:id/download', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const row = await prisma.recording.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'Recording not found' });

    const room = await prisma.room.findUnique({ where: { id: row.roomId } });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const role = await resolveRole(prisma, req.userId!, room.id, room.ownerId);
    if (row.targetUserId !== req.userId && !hasFeatureAccess(role, 'recording:start')) {
      return res.status(403).json({ error: 'Not authorized to download this recording' });
    }

    if (row.status !== 'done' || !row.fileUrl) {
      return res.status(400).json({ error: 'Recording is not ready for download' });
    }
    if (row.downloadExpiresAt && new Date() > row.downloadExpiresAt) {
      return res.status(410).json({ error: 'Download link has expired' });
    }
    if (row.downloadCount >= row.maxDownloads) {
      return res.status(410).json({ error: 'Maximum download count reached' });
    }

    await prisma.recording.update({ where: { id: row.id }, data: { downloadCount: { increment: 1 } } });

    const filename = path.basename(row.fileUrl);
    const filePath = path.join(process.cwd(), 'uploads', filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Recording file not found' });
    return res.download(filePath, `${row.title || 'recording'}.webm`);
  } catch (err) {
    console.error('[recordings] download error:', err);
    return res.status(500).json({ error: 'Failed to download recording' });
  }
});

export default recordings;
