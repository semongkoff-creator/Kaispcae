import { Router, Response } from 'express';
import { Server } from 'socket.io';
import { Prisma } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';

const users = Router();

let ioRef: Server | null = null;
export function setUsersIo(io: Server): void { ioRef = io; }

// The profile photo is a data-URL string the client has already cropped,
// resized (<=256px) and compressed (WebP ~q0.8) — a real one is ~10-40KB. This
// ceiling is a server-side backstop for when that client processing is skipped
// or fails: refuse anything big enough to bloat the row rather than silently
// storing it. base64 inflates bytes ~33%, so 150KB of text ≈ ~110KB image.
const MAX_PHOTO_CHARS = 150 * 1024;
const DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/;

// PUT /api/users/me/profile-photo — set or replace the caller's own photo.
users.put('/users/me/profile-photo', authenticateToken, async (req: AuthRequest, res: Response) => {
  const photo: unknown = req.body?.photo;
  if (typeof photo !== 'string' || !DATA_URL_RE.test(photo)) {
    return res.status(400).json({ error: 'Foto tidak valid — harus data URL gambar (png/jpeg/webp).' });
  }
  if (photo.length > MAX_PHOTO_CHARS) {
    return res.status(413).json({ error: 'Foto terlalu besar setelah diproses — coba foto lain.' });
  }
  try {
    await getPrisma().user.update({ where: { id: req.userId }, data: { profilePhoto: photo } });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[users] set profile photo failed:', e);
    return res.status(500).json({ error: 'Gagal menyimpan foto.' });
  }
});

// DELETE /api/users/me/profile-photo — clear it, falling back to initials.
users.delete('/users/me/profile-photo', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    await getPrisma().user.update({ where: { id: req.userId }, data: { profilePhoto: null } });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[users] delete profile photo failed:', e);
    return res.status(500).json({ error: 'Gagal menghapus foto.' });
  }
});

// POST /api/users/me/tutorial-completed — QA #1/#6: marks the first-run
// tutorial (App.tsx's gate before Game mounts) as done for this account, so
// it never shows again on future logins. Idempotent — fine to call more
// than once (e.g. the reopen-from-Sidebar "Panduan" replay also calls this).
users.post('/users/me/tutorial-completed', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    await getPrisma().user.update({ where: { id: req.userId }, data: { tutorialCompletedAt: new Date() } });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[users] mark tutorial completed failed:', e);
    return res.status(500).json({ error: 'Gagal menyimpan status tutorial.' });
  }
});

// PATCH /api/users/me/preferences — partial update (shallow-merge) of the
// lightweight, cross-device UI preferences added for the Settings feature.
// Merges into the existing JSON rather than replacing it, so e.g. toggling
// tooltips in one request doesn't clobber notifKinds set in another. Keys
// are whitelisted to keep this a small, predictable blob, not a general
// JSON dumping ground.
const ALLOWED_PREF_KEYS = new Set(['tooltipsEnabled', 'notifKinds']);
const ALLOWED_NOTIF_KINDS = new Set(['chat', 'mention', 'nudge', 'slap', 'handRaise']);

users.patch('/users/me/preferences', authenticateToken, async (req: AuthRequest, res: Response) => {
  const patch: unknown = req.body;
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return res.status(400).json({ error: 'Body harus berupa objek preferensi.' });
  }
  const body = patch as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!ALLOWED_PREF_KEYS.has(key)) {
      return res.status(400).json({ error: `Preferensi tidak dikenal: ${key}` });
    }
  }
  if (body.tooltipsEnabled !== undefined && typeof body.tooltipsEnabled !== 'boolean') {
    return res.status(400).json({ error: 'tooltipsEnabled harus boolean.' });
  }
  if (body.notifKinds !== undefined) {
    if (typeof body.notifKinds !== 'object' || body.notifKinds === null || Array.isArray(body.notifKinds)) {
      return res.status(400).json({ error: 'notifKinds harus berupa objek.' });
    }
    for (const [k, v] of Object.entries(body.notifKinds as Record<string, unknown>)) {
      if (!ALLOWED_NOTIF_KINDS.has(k) || typeof v !== 'boolean') {
        return res.status(400).json({ error: `notifKinds.${k} tidak valid.` });
      }
    }
  }
  try {
    const prisma = getPrisma();
    const existing = await prisma.user.findUnique({ where: { id: req.userId }, select: { preferences: true } });
    const current = (existing?.preferences as Record<string, unknown> | null) ?? {};
    const merged: Record<string, unknown> = { ...current, ...body };
    if (body.notifKinds) {
      merged.notifKinds = { ...((current.notifKinds as Record<string, unknown> | undefined) ?? {}), ...(body.notifKinds as Record<string, unknown>) };
    }
    await prisma.user.update({ where: { id: req.userId }, data: { preferences: merged as Prisma.InputJsonValue } });
    return res.json({ ok: true, preferences: merged });
  } catch (e) {
    console.error('[users] update preferences failed:', e);
    return res.status(500).json({ error: 'Gagal menyimpan preferensi.' });
  }
});

// GET /api/users/profile-photos?ids=a,b,c — batch identity lookup for chat.
// Returns the CURRENT displayName + photo for each requested sender, so chat
// always renders live identity (Bug 8: old messages must show the sender's
// latest name/photo, not a snapshot from send time). One call for all senders
// in view keeps this off the N+1 path, and this is the ONLY place the heavy
// profilePhoto column is selected (everywhere else omits it). `photo` is null
// for users who haven't set one (chat falls back to initials); a row is still
// returned for them so the name resolves.
users.get('/users/profile-photos', authenticateToken, async (req: AuthRequest, res: Response) => {
  const raw = String(req.query.ids ?? '').trim();
  if (!raw) return res.json({ profiles: [] });
  // Cap the batch so a crafted id list can't pull a pile of TEXT columns.
  const ids = Array.from(new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))).slice(0, 100);
  if (ids.length === 0) return res.json({ profiles: [] });
  try {
    const rows = await getPrisma().user.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true, profilePhoto: true },
    });
    return res.json({ profiles: rows.map((r) => ({ id: r.id, name: r.displayName, photo: r.profilePhoto })) });
  } catch (e) {
    console.error('[users] batch profiles failed:', e);
    return res.status(500).json({ error: 'Gagal memuat profil.' });
  }
});

// Item 13, "Panic/report user" — abuse-sensitive (could be used to spam
// notifications at every admin), so it gets its own tight limiter rather
// than reusing the global 100-req/min one.
const reportRateLimit = rateLimit(60 * 1000, 5);
const MAX_REPORT_REASON_CHARS = 1000;

// POST /api/users/:userId/report — { reason, roomSlug? }. Open to every
// authenticated real member (not admin-gated) — the person experiencing bad
// behavior is rarely the one holding a Kick button, and this is the way
// they reach one. Persists a UserReport row and pushes a Notification to
// EVERY workspace admin — there's no dedicated review queue yet (per
// product decision), an admin acts on it manually via tools that already
// exist (DM, Kick, Force Mute).
users.post('/users/:userId/report', authenticateToken, reportRateLimit, async (req: AuthRequest, res: Response) => {
  try {
    const reportedId = req.params.userId;
    if (reportedId === req.userId) return res.status(400).json({ error: 'Tidak bisa melaporkan diri sendiri' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) return res.status(400).json({ error: 'Alasan laporan wajib diisi' });
    if (reason.length > MAX_REPORT_REASON_CHARS) {
      return res.status(400).json({ error: `Alasan maksimal ${MAX_REPORT_REASON_CHARS} karakter` });
    }
    const roomSlug = typeof req.body?.roomSlug === 'string' ? req.body.roomSlug : null;

    const prisma = getPrisma();
    const [reporter, reported] = await Promise.all([
      prisma.user.findUnique({ where: { id: req.userId }, select: { displayName: true } }),
      prisma.user.findUnique({ where: { id: reportedId }, select: { id: true, displayName: true } }),
    ]);
    if (!reported) return res.status(404).json({ error: 'User tidak ditemukan' });

    await prisma.userReport.create({
      data: { reporterId: req.userId!, reportedId, roomSlug, reason },
    });

    // Fan out to every workspace admin — same Notification + socket-push
    // shape as admin.ts's own notify() (a takeover notice), duplicated
    // rather than shared since that helper is a single-recipient send and
    // this one is deliberately a broadcast to a role, not one user.
    const admins = await prisma.user.findMany({ where: { workspaceRole: 'admin' }, select: { id: true } });
    const body = `${reporter?.displayName ?? 'Seseorang'} melaporkan ${reported.displayName}${roomSlug ? ` (di room ${roomSlug})` : ''}: ${reason}`;
    await prisma.notification.createMany({
      data: admins.map((a) => ({ recipientId: a.id, kind: 'report', body })),
    });
    for (const a of admins) ioRef?.to(`user:${a.id}`).emit('base:notif', {});

    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error('[users] report failed:', e);
    return res.status(500).json({ error: 'Gagal mengirim laporan.' });
  }
});

export default users;
