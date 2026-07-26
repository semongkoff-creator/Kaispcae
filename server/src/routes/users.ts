import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const users = Router();

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

// GET /api/users/profile-photos?ids=a,b,c — batch lookup for chat. One call for
// all senders in view keeps this off the N+1 path, and this is the ONLY place
// the heavy profilePhoto column is selected (everywhere else omits it). Returns
// just the users that actually have a photo.
users.get('/users/profile-photos', authenticateToken, async (req: AuthRequest, res: Response) => {
  const raw = String(req.query.ids ?? '').trim();
  if (!raw) return res.json({ photos: [] });
  // Cap the batch so a crafted id list can't pull a pile of TEXT columns.
  const ids = Array.from(new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))).slice(0, 100);
  if (ids.length === 0) return res.json({ photos: [] });
  try {
    const rows = await getPrisma().user.findMany({
      where: { id: { in: ids }, profilePhoto: { not: null } },
      select: { id: true, profilePhoto: true },
    });
    return res.json({ photos: rows.map((r) => ({ id: r.id, photo: r.profilePhoto })) });
  } catch (e) {
    console.error('[users] batch profile photos failed:', e);
    return res.status(500).json({ error: 'Gagal memuat foto.' });
  }
});

export default users;
