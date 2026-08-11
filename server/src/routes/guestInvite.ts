import { Router, Request, Response } from 'express';
import { Server } from 'socket.io';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getPrisma } from '../lib/prisma';
import { hasFeatureAccess } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest, signGuestToken } from '../middleware/auth';
import { resolveRoomRole } from '../lib/roles';
import { kickRevokedGuestSocket } from '../socket/roomHandler';

const guestInvite = Router();

// QA (Akses tamu checklist item 7, "Revoke") — same "HTTP route needs the
// live socket server" pattern as rooms.ts's own setIo (see index.ts's
// `import { setIo as setChatIo }` for the established alias convention this
// file's caller uses too).
let ioRef: Server | null = null;
export function setIo(io: Server): void {
  ioRef = io;
}

// Human-typeable random password when the admin doesn't set their own —
// excludes visually-ambiguous characters (0/O, 1/I/l) since this gets read
// off a screen and typed by hand on the guest's side, unlike the link token
// itself (which is only ever copy-pasted, so base64url is fine there).
const PASSWORD_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function generatePassword(length = 8): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += PASSWORD_CHARS[bytes[i] % PASSWORD_CHARS.length];
  return out;
}

// Guest Link & Ruang Tunggu — creating/revoking a link is admin+
// ('guest:manage', shared/permissions.ts), same "resolve the caller's real
// room role from the DB, never trust the client" pattern as roomMembers.ts's
// requireRoomAdmin.
async function requireGuestManage(prisma: ReturnType<typeof getPrisma>, slug: string, userId: string) {
  const room = await prisma.room.findUnique({ where: { slug } });
  if (!room) return { error: 404 as const, room: null };
  const role = await resolveRoomRole(prisma, userId, room.id, room.ownerId);
  if (!hasFeatureAccess(role, 'guest:manage')) return { error: 403 as const, room };
  return { error: null, room };
}

// POST /api/rooms/:slug/guest-invites — admin generates an invite link.
// expiresInHours/maxUses are both optional — omitted means "no expiry" /
// "unlimited uses" respectively, matching the audit's #6 requirement that
// this be admin-configurable rather than a single hardcoded policy.
guestInvite.post('/rooms/:slug/guest-invites', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const { error, room } = await requireGuestManage(prisma, req.params.slug, req.userId!);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Admin role required' });

    const body = (req.body ?? {}) as { expiresInHours?: unknown; maxUses?: unknown; password?: unknown };
    const expiresInHours = Number(body.expiresInHours);
    const maxUses = Number(body.maxUses);

    // Every link gets a password — admin-supplied (must be non-empty after
    // trim) or auto-generated. Never optional/blank: an empty string is
    // treated the same as "not provided", not as "no password".
    const customPassword = typeof body.password === 'string' ? body.password.trim() : '';
    const plainPassword = customPassword || generatePassword();
    const passwordHash = await bcrypt.hash(plainPassword, 12);

    const actor = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } });
    const invite = await prisma.roomInvite.create({
      data: {
        roomId: room!.id,
        // 24 random bytes, base64url — short enough to fit comfortably in a
        // URL query param, long enough that guessing one is infeasible.
        token: crypto.randomBytes(24).toString('base64url'),
        createdById: req.userId!,
        createdByName: actor?.displayName ?? 'Admin',
        expiresAt: Number.isFinite(expiresInHours) && expiresInHours > 0 ? new Date(Date.now() + expiresInHours * 3600_000) : null,
        maxUses: Number.isInteger(maxUses) && maxUses > 0 ? maxUses : null,
        passwordHash,
      },
    });
    // plainPassword is returned ONCE here, never stored — this is the only
    // moment it exists outside the admin's own clipboard/notes. `id` (not
    // just `token`) is included so the caller can revoke this exact link
    // later without a separate lookup — DELETE .../guest-invites/:id below
    // needs the DB id, not the invite token.
    res.json({ id: invite.id, token: invite.token, expiresAt: invite.expiresAt, maxUses: invite.maxUses, password: plainPassword });
  } catch (e) {
    console.error('[guestInvite] create error:', e);
    res.status(500).json({ error: 'Gagal membuat guest link' });
  }
});

// DELETE /api/rooms/:slug/guest-invites/:id — admin revokes a link early
// (e.g. it leaked somewhere it shouldn't have). scoped to `roomId` in the
// WHERE clause, not just the invite's own id, so an admin of room A can
// never revoke an invite that belongs to room B just by guessing its id.
guestInvite.delete('/rooms/:slug/guest-invites/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const { error, room } = await requireGuestManage(prisma, req.params.slug, req.userId!);
    if (error === 404) return res.status(404).json({ error: 'Room not found' });
    if (error === 403) return res.status(403).json({ error: 'Admin role required' });
    const { count } = await prisma.roomInvite.updateMany({ where: { id: req.params.id, roomId: room!.id }, data: { revoked: true } });

    // QA (Akses tamu checklist item 7, "Revoke") — a revoke that only
    // blocks FUTURE joins would leave anyone already in via this link
    // connected indefinitely. Walk the room's currently-connected sockets
    // (not a DB query — there's no table of "who's connected", the socket
    // server IS that state) and kick any whose guestInviteId matches.
    // Was previously a raw `s.disconnect(true)` here — that routed through
    // the ordinary DISCONNECT handler's 4s reconnect-grace timer (meant for
    // real network blips, not an explicit removal) instead of leaving the
    // room immediately, AND never told the guest's client anything, so
    // their tab just sat frozen with no notice. kickRevokedGuestSocket
    // fixes both: same "notice event, then handleLeave immediately" shape
    // PLAYER_KICK already uses for admin-kicked real users.
    // fetchSockets() returns RemoteSocket, not this file's Socket type —
    // pass ids through and let kickRevokedGuestSocket re-resolve real
    // Socket instances via io.sockets.sockets.get, same as roomHandler.ts's
    // other force-removal helpers do.
    if (count > 0 && ioRef) {
      const sockets = await ioRef.in(req.params.slug).fetchSockets();
      const matchedSocketIds = sockets
        .filter((s) => (s.data as { guestInviteId?: string }).guestInviteId === req.params.id)
        .map((s) => s.id);
      for (const socketId of matchedSocketIds) {
        await kickRevokedGuestSocket(ioRef, socketId, req.params.slug);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[guestInvite] revoke error:', e);
    res.status(500).json({ error: 'Gagal mencabut guest link' });
  }
});

// POST /api/guest/join — PUBLIC, no auth (this IS the front door for an
// unauthenticated visitor). Exchanges a valid invite token + a display name
// for a short-lived guest session token — the ONLY way a guest identity is
// ever minted anywhere in this app. See signGuestToken's doc comment for why
// the resulting token structurally cannot be routed through authenticateToken
// or any endpoint that assumes req.userId is a real User row.
guestInvite.post('/guest/join', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { token?: unknown; name?: unknown; password?: unknown };
    if (typeof body.token !== 'string' || typeof body.name !== 'string' || typeof body.password !== 'string') {
      return res.status(400).json({ error: 'Data tidak valid' });
    }
    const trimmedName = body.name.trim().slice(0, 40);
    if (!trimmedName) return res.status(400).json({ error: 'Nama wajib diisi' });

    const prisma = getPrisma();
    const invite = await prisma.roomInvite.findUnique({
      where: { token: body.token },
      include: { room: { select: { slug: true, name: true } } },
    });
    if (!invite || invite.revoked) return res.status(404).json({ error: 'Link undangan tidak valid' });
    if (invite.expiresAt && invite.expiresAt < new Date()) {
      return res.status(410).json({ error: 'Link undangan ini sudah kedaluwarsa' });
    }
    if (invite.maxUses != null && invite.useCount >= invite.maxUses) {
      return res.status(410).json({ error: 'Link undangan ini sudah tidak berlaku' });
    }
    // Links created before password support existed have no hash — reject
    // rather than silently letting them through unguarded (see schema.prisma's
    // doc comment on passwordHash).
    if (!invite.passwordHash) {
      return res.status(410).json({ error: 'Link undangan ini sudah tidak berlaku — minta admin membuat link baru' });
    }
    // Checked BEFORE the useCount bump below — a wrong password must not
    // burn a one-time link's only use.
    const passwordOk = await bcrypt.compare(body.password, invite.passwordHash);
    if (!passwordOk) return res.status(401).json({ error: 'Password salah' });

    // Fire-and-forget count bump — a lost increment under a race just means
    // a one-time link could be used one extra time in the worst case, not a
    // security hole (the guest still lands in the waiting room either way).
    await prisma.roomInvite.update({ where: { id: invite.id }, data: { useCount: { increment: 1 } } });

    const guestId = crypto.randomUUID();
    const token = signGuestToken({ guestId, name: trimmedName, roomSlug: invite.room.slug, inviteId: invite.id });
    res.json({ token, roomSlug: invite.room.slug, roomName: invite.room.name, name: trimmedName });
  } catch (e) {
    console.error('[guestInvite] guest join error:', e);
    res.status(500).json({ error: 'Gagal bergabung sebagai tamu' });
  }
});

export default guestInvite;
