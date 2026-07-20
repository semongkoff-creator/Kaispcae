import { Router, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { getPrisma } from '../lib/prisma';
import { hasFeatureAccess } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveRoomRole as resolveRole } from '../lib/roles';

const recordings = Router();


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

    // fileUrl is withheld on purpose. It points at /api/uploads/<uuid>.webm —
    // the raw file, which the download route below deliberately gates behind
    // a role check, an expiry, and an atomically-incremented maxDownloads
    // counter. Handing the direct path to the client made every one of those
    // checks optional: burn the three downloads, then fetch the uuid forever.
    // No client reads this field (it's only ever sent UP, at
    // RECORDING_FINALIZE), so nothing needs it on the way down. Download
    // strictly via GET /recordings/:id/download.
    return res.json({ recordings: visible.map(({ fileUrl: _fileUrl, ...r }) => r) });
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

    // Check-then-increment as two separate statements would let two
    // concurrent requests both read downloadCount < maxDownloads before
    // either's increment lands, letting more than maxDownloads through.
    // A single conditional UPDATE re-checks count/expiry against the row's
    // CURRENT state at the moment Postgres applies it — only one of two
    // racing requests can match a row still under the limit, so `count`
    // below is 0 for every request after the last one that legitimately won.
    const result = await prisma.recording.updateMany({
      where: { id: row.id, downloadCount: { lt: row.maxDownloads }, downloadExpiresAt: { gt: new Date() } },
      data: { downloadCount: { increment: 1 } },
    });
    if (result.count === 0) {
      return res.status(410).json({ error: 'Download link has expired or reached its maximum download count' });
    }

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
