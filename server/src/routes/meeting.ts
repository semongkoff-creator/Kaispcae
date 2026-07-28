import { Router, Response } from 'express';
import { Server } from 'socket.io';
import { SocketEvents } from '@virtualmeet/shared';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { reserveMeeting, getActiveMeetingId, getRecordingUrl } from '../lib/larkVc';
import { logActivity } from '../lib/larkBase';

// A5 — official (recorded) meetings started from a meeting-type zone, via Lark
// VC. Separate from proximity WebRTC. Recording arrives asynchronously (Lark
// processes it after the meeting ends) — see the poller below.
let io: Server | null = null;
export function setMeetingIo(server: Server) { io = server; }

const meeting = Router();

// Start: reserve a Lark VC meeting (auto-record), record it, broadcast the join
// link to everyone in the room. Any Lark-account user in the zone may start one.
meeting.post('/meeting/start', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { roomId, zoneId } = req.body ?? {};
  if (!roomId || !zoneId) return res.status(400).json({ error: 'roomId & zoneId wajib.' });
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { larkOpenId: true } });
  if (!user?.larkOpenId) return res.status(400).json({ error: 'Hanya akun yang login lewat Lark yang bisa memulai meeting Lark VC.' });

  const topic = `MeetKai — ${roomId}`;
  const reserved = await reserveMeeting(user.larkOpenId, topic);
  if (!reserved) {
    return res.status(502).json({ error: 'Gagal membuat meeting Lark VC. Pastikan scope vc:reserve aktif & paket Lark mendukung VC.' });
  }

  const rec = await prisma.momRecord.create({
    data: {
      roomId, zoneId, startedBy: req.userId!,
      larkReserveId: reserved.reserveId, larkMeetingNo: reserved.meetingNo,
      recordingStatus: 'live',
    },
  });

  io?.to(roomId).emit(SocketEvents.MEETING_STARTED, {
    momRecordId: rec.id, zoneId, url: reserved.url, startedBy: req.userId, topic,
  });
  // Fire-and-forget activity log (guarded stub until Lark Base is configured).
  void logActivity({ eventType: 'meeting_start', userId: req.userId!, room: roomId, detail: { zoneId, momRecordId: rec.id } });

  return res.json({ momRecordId: rec.id, url: reserved.url, meetingNo: reserved.meetingNo });
});

// End: mark ended; capture meeting_id (needed for recording) if the meeting is
// still resolvable; flag recording as pending for the poller. Starter or admin.
meeting.post('/meeting/end', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { momRecordId } = req.body ?? {};
  const prisma = getPrisma();
  const rec = await prisma.momRecord.findUnique({ where: { id: momRecordId } });
  if (!rec) return res.status(404).json({ error: 'Meeting tidak ditemukan.' });
  if (rec.endTime) return res.json({ ok: true, alreadyEnded: true });

  if (rec.startedBy !== req.userId) {
    const u = await prisma.user.findUnique({ where: { id: req.userId }, select: { accountRole: true } });
    if (u?.accountRole !== 'admin') return res.status(403).json({ error: 'Hanya pemulai atau admin yang bisa mengakhiri meeting.' });
  }

  let meetingId = rec.larkMeetingId;
  if (!meetingId && rec.larkReserveId) meetingId = await getActiveMeetingId(rec.larkReserveId);

  const updated = await prisma.momRecord.update({
    where: { id: rec.id },
    data: { endTime: new Date(), larkMeetingId: meetingId ?? undefined, recordingStatus: 'recording_pending' },
  });
  io?.to(rec.roomId).emit(SocketEvents.MEETING_ENDED, { momRecordId: rec.id, zoneId: rec.zoneId });
  void logActivity({ eventType: 'meeting_end', userId: req.userId!, room: rec.roomId, detail: { zoneId: rec.zoneId, momRecordId: rec.id } });

  return res.json({ ok: true, recordingStatus: updated.recordingStatus });
});

// History for a room (foundation for A6 AI summary).
meeting.get('/meeting/history', authenticateToken, async (req: AuthRequest, res: Response) => {
  const roomId = String(req.query.roomId ?? '');
  if (!roomId) return res.json({ meetings: [] });
  const prisma = getPrisma();
  const meetings = await prisma.momRecord.findMany({
    where: { roomId }, orderBy: { startTime: 'desc' }, take: 50,
  });
  return res.json({ meetings });
});

// Best-effort async recording retrieval: every few minutes, for each pending
// record, resolve the meeting_id (if not yet) and try to fetch the recording
// URL. Gives up (→ 'unavailable') after a while so a plan without VC recording
// doesn't poll forever.
export function startRecordingPoller(): void {
  const GIVE_UP_MS = 3 * 60 * 60 * 1000; // 3h
  setInterval(async () => {
    try {
      const prisma = getPrisma();
      const pending = await prisma.momRecord.findMany({ where: { recordingStatus: 'recording_pending' }, take: 10 });
      for (const rec of pending) {
        let meetingId = rec.larkMeetingId;
        if (!meetingId && rec.larkReserveId) {
          meetingId = await getActiveMeetingId(rec.larkReserveId);
          if (meetingId) await prisma.momRecord.update({ where: { id: rec.id }, data: { larkMeetingId: meetingId } });
        }
        if (meetingId) {
          const url = await getRecordingUrl(meetingId);
          if (url) {
            await prisma.momRecord.update({ where: { id: rec.id }, data: { recordingUrl: url, recordingStatus: 'recorded' } });
            continue;
          }
        }
        const endedAt = rec.endTime ? rec.endTime.getTime() : rec.startTime.getTime();
        if (Date.now() - endedAt > GIVE_UP_MS) {
          await prisma.momRecord.update({ where: { id: rec.id }, data: { recordingStatus: 'unavailable' } });
        }
      }
    } catch (e) {
      console.warn('[meeting] recording poller error:', e);
    }
  }, 3 * 60 * 1000); // every 3 min
}

export default meeting;
