import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest, setUploadSessionCookie } from '../middleware/auth';
import { requireWorkspace } from '../lib/workspace';
import { writeAudit, clientIp } from '../lib/audit';
import { rateLimit } from '../middleware/rateLimit';
import { resolvePendingInvite, markInviteAccepted, accountFieldsForInviteRole, ORG_INVITE_TTL_MS } from '../lib/orgInvite';
import { signToken } from './auth';
import { publicUser } from '../lib/publicUser';

const orgInvite = Router();
const mutationLimit = rateLimit(60 * 1000, 30);
// Public, account-creation-adjacent — same tightness as auth.ts's own
// authRateLimit for register/login (10 attempts/15min/IP).
const acceptLimit = rateLimit(15 * 60 * 1000, 10);

// ─── Admin: create/list/revoke ───────────────────────────────────────

orgInvite.post('/admin/org-invites', authenticateToken, requireWorkspace('workspace:manageMembers'), mutationLimit, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email tidak valid' });
    const role = req.body?.role === 'admin' ? 'admin' : 'member';

    // An account (any org) already owns this email — fail fast with a
    // clear message rather than letting it surface as a cryptic error
    // when the invite is eventually accepted.
    const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existingUser) return res.status(409).json({ error: 'Email ini sudah punya akun' });

    // Same "one pending invite per email at a time" guard as Department's
    // duplicate-name pre-check — not a security boundary, just avoids
    // piling up dead rows and confusing "which link is the real one".
    const existingInvite = await prisma.orgInvite.findFirst({
      where: { organizationId: req.organizationId, email, status: 'pending', expiresAt: { gt: new Date() } },
    });
    if (existingInvite) return res.status(409).json({ error: 'Sudah ada undangan aktif untuk email ini' });

    const invite = await prisma.orgInvite.create({
      data: {
        organizationId: req.organizationId,
        email, role,
        // 24 random bytes, base64url — same convention as guest-invite
        // and guest-join tokens (guestInvite.ts) and every other
        // capability token in this codebase.
        token: crypto.randomBytes(24).toString('base64url'),
        invitedById: req.userId!,
        expiresAt: new Date(Date.now() + ORG_INVITE_TTL_MS),
      },
    });
    await writeAudit(prisma, {
      actorId: req.userId!, action: 'workspace:manageMembers', targetType: 'orgInvite', targetId: invite.id,
      meta: { invited: email, role }, ip: clientIp(req),
    });
    // Bare token, same as guest-invite's response — the client builds the
    // shareable link itself from window.location.origin (this codebase has
    // no email-sending infrastructure at all; delivery is copy-the-link).
    return res.status(201).json({ id: invite.id, token: invite.token, email: invite.email, role: invite.role, expiresAt: invite.expiresAt });
  } catch (err) {
    console.error('[orgInvite] create error:', err);
    return res.status(500).json({ error: 'Gagal membuat undangan' });
  }
});

orgInvite.get('/admin/org-invites', authenticateToken, requireWorkspace('workspace:manageMembers'), async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const invites = await prisma.orgInvite.findMany({
      where: { organizationId: req.organizationId },
      select: { id: true, email: true, role: true, status: true, expiresAt: true, acceptedAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return res.json({ invites });
  } catch (err) {
    console.error('[orgInvite] list error:', err);
    return res.status(500).json({ error: 'Gagal memuat undangan' });
  }
});

orgInvite.delete('/admin/org-invites/:id', authenticateToken, requireWorkspace('workspace:manageMembers'), async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    // Scoped to organizationId in the WHERE clause itself, not a separate
    // lookup-then-check — an admin of org A can never revoke org B's
    // invite just by guessing its id (updateMany's count tells us whether
    // anything actually matched).
    const { count } = await prisma.orgInvite.updateMany({
      where: { id: req.params.id, organizationId: req.organizationId, status: 'pending' },
      data: { status: 'revoked' },
    });
    if (!count) return res.status(404).json({ error: 'Undangan tidak ditemukan' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[orgInvite] revoke error:', err);
    return res.status(500).json({ error: 'Gagal mencabut undangan' });
  }
});

// ─── Public: preview + accept ──────────────────────────────────────
// Both PUBLIC, no auth — this IS the front door for someone who isn't a
// member of anything yet, same posture as guestInvite.ts's POST /guest/join.

orgInvite.get('/org-invites/:token', async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma();
    const invite = await resolvePendingInvite(prisma, req.params.token);
    if (!invite) return res.status(404).json({ error: 'Undangan tidak valid atau sudah kedaluwarsa' });
    return res.json({ organizationName: invite.organization.name, email: invite.email, role: invite.role });
  } catch (err) {
    console.error('[orgInvite] preview error:', err);
    return res.status(500).json({ error: 'Gagal memuat undangan' });
  }
});

orgInvite.post('/org-invites/:token/accept', acceptLimit, async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma();
    const invite = await resolvePendingInvite(prisma, req.params.token);
    if (!invite) return res.status(404).json({ error: 'Undangan tidak valid atau sudah kedaluwarsa' });

    const displayName = String(req.body?.displayName ?? '').trim().slice(0, 30);
    const password = String(req.body?.password ?? '');
    if (!displayName) return res.status(400).json({ error: 'Nama wajib diisi' });
    if (password.length < 6 || password.length > 100) return res.status(400).json({ error: 'Password minimal 6 karakter' });

    // Email is the invite's own (never client-supplied) — otherwise
    // accepting a valid token for someone@else.com would let the caller
    // register under any address they type in.
    const existing = await prisma.user.findUnique({ where: { email: invite.email }, select: { id: true } });
    if (existing) return res.status(409).json({ error: 'Email ini sudah punya akun' });

    const hashed = await bcrypt.hash(password, 12);
    const { accountRole, workspaceRole } = accountFieldsForInviteRole(invite.role);
    const user = await prisma.user.create({
      data: {
        email: invite.email, password: hashed, displayName,
        organizationId: invite.organizationId,
        accountRole, workspaceRole,
      },
    });
    await markInviteAccepted(prisma, invite.id);

    const sessionId = crypto.randomUUID();
    await prisma.user.update({ where: { id: user.id }, data: { currentSessionId: sessionId } });
    const token = signToken(user, sessionId);
    setUploadSessionCookie(req, res, token);

    return res.status(201).json({
      user: publicUser(user),
      token,
    });
  } catch (err) {
    console.error('[orgInvite] accept error:', err);
    return res.status(500).json({ error: 'Gagal bergabung' });
  }
});

export default orgInvite;
