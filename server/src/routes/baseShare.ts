import { Router, Response, Request } from 'express';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { getPrisma } from '../lib/prisma';
import { BaseRole, can } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveBaseRole } from '../lib/baseAccess';

const baseShare = Router();

const LINK_ROLES: BaseRole[] = ['viewer', 'commenter', 'editor'];

// POST /api/bases/:baseId/share-links — owner/editor creates a link to ONE view.
baseShare.post('/bases/:baseId/share-links', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const role = await resolveBaseRole(prisma, req.params.baseId, req.userId!);
    if (!can('share:create', { role: role ?? undefined })) return res.status(403).json({ error: 'Tidak boleh membuat link berbagi' });
    const { viewId, role: linkRole, expiresAt, password, allowCopy } = req.body ?? {};
    if (typeof viewId !== 'string' || !LINK_ROLES.includes(linkRole)) return res.status(400).json({ error: 'viewId/role tidak valid' });
    // viewId must belong to a table in this base
    const tables = await prisma.baseTable.findMany({ where: { baseId: req.params.baseId }, select: { views: true } });
    const viewExists = tables.some((t) => (t.views as { id: string }[]).some((v) => v.id === viewId));
    if (!viewExists) return res.status(404).json({ error: 'View tidak ditemukan' });

    // Workspace policy is enforced HERE, server-side — an admin turning public
    // links off must actually stop them, not just hide the button.
    const policy = await prisma.workspacePolicy.findUnique({ where: { id: 'singleton' } });
    if (policy && !policy.basePublicLinksAllowed) {
      return res.status(403).json({ error: 'Admin menonaktifkan link berbagi publik untuk workspace ini' });
    }
    let expiry = expiresAt ? new Date(expiresAt) : null;
    if (policy?.maxShareLinkDays != null) {
      const cap = new Date(Date.now() + policy.maxShareLinkDays * 86400000);
      // No expiry, or one beyond the cap, is clamped to the cap rather than
      // rejected — the link still works, just not longer than policy allows.
      if (!expiry || expiry.getTime() > cap.getTime()) expiry = cap;
    }
    // policy.docsLinkPasswordRequired intentionally does NOT apply here — it
    // gates the Docs module's links, not Base's.

    const token = randomBytes(24).toString('hex'); // 48 chars
    const passwordHash = password ? await bcrypt.hash(String(password), 10) : null;
    const link = await prisma.shareLink.create({
      data: { token, baseId: req.params.baseId, viewId, role: linkRole, passwordHash, allowCopy: allowCopy !== false, expiresAt: expiry, createdById: req.userId! },
    });
    return res.status(201).json({ token: link.token });
  } catch (err) { console.error('[share] create error:', err); return res.status(500).json({ error: 'Failed to create link' }); }
});

// GET /api/bases/:baseId/share-links — active links for the base.
baseShare.get('/bases/:baseId/share-links', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const role = await resolveBaseRole(prisma, req.params.baseId, req.userId!);
    if (!can('share:create', { role: role ?? undefined })) return res.status(403).json({ error: 'Forbidden' });
    const links = await prisma.shareLink.findMany({ where: { baseId: req.params.baseId }, orderBy: { createdAt: 'desc' } });
    return res.json({ links: links.map((l) => ({ token: l.token, viewId: l.viewId, role: l.role, hasPassword: !!l.passwordHash, allowCopy: l.allowCopy, expiresAt: l.expiresAt?.getTime() ?? null, lastOpenedAt: l.lastOpenedAt?.getTime() ?? null, createdAt: l.createdAt.getTime() })) });
  } catch (err) { console.error('[share] list error:', err); return res.status(500).json({ error: 'Failed to list links' }); }
});

// DELETE /api/share-links/:token — revoke.
baseShare.delete('/share-links/:token', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const link = await prisma.shareLink.findUnique({ where: { token: req.params.token }, select: { baseId: true } });
    if (!link) return res.status(404).json({ error: 'Not found' });
    const role = await resolveBaseRole(prisma, link.baseId, req.userId!);
    if (!can('share:create', { role: role ?? undefined })) return res.status(403).json({ error: 'Forbidden' });
    await prisma.shareLink.delete({ where: { token: req.params.token } });
    return res.json({ success: true });
  } catch (err) { console.error('[share] revoke error:', err); return res.status(500).json({ error: 'Failed to revoke link' }); }
});

// GET /api/share/:token?password= — PUBLIC (no auth). Honours expiry +
// password server-side; returns ONLY the linked view's data. Revoked/missing
// → 404, expired → 410, wrong/missing password → 401.
baseShare.get('/share/:token', async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma();
    const link = await prisma.shareLink.findUnique({ where: { token: req.params.token } });
    if (!link) return res.status(404).json({ error: 'Link tidak ditemukan atau sudah dicabut' });
    if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return res.status(410).json({ error: 'Link sudah kedaluwarsa' });
    if (link.passwordHash) {
      const supplied = String(req.query.password ?? '');
      if (!supplied) return res.status(401).json({ error: 'password_required' });
      const ok = await bcrypt.compare(supplied, link.passwordHash);
      if (!ok) return res.status(401).json({ error: 'password_wrong' });
    }
    const base = await prisma.base.findUnique({ where: { id: link.baseId }, select: { name: true, tables: { select: { id: true, name: true, icon: true, fields: true, views: true } } } });
    if (!base) return res.status(404).json({ error: 'Base tidak ditemukan' });
    const table = base.tables.find((t) => (t.views as { id: string }[]).some((v) => v.id === link.viewId));
    const view = table ? (table.views as { id: string }[]).find((v) => v.id === link.viewId) : null;
    if (!table || !view) return res.status(404).json({ error: 'View tidak ditemukan' });
    const records = await prisma.baseRecord.findMany({ where: { tableId: table.id }, orderBy: { orderIndex: 'asc' }, take: 5000, select: { id: true, cells: true } });
    await prisma.shareLink.update({ where: { token: link.token }, data: { lastOpenedAt: new Date() } }).catch(() => {});
    return res.json({ baseName: base.name, role: link.role, allowCopy: link.allowCopy, table: { id: table.id, name: table.name, icon: table.icon, fields: table.fields, views: [view] }, records });
  } catch (err) { console.error('[share] public get error:', err); return res.status(500).json({ error: 'Failed to open link' }); }
});

// POST /api/share/:token/submit — PUBLIC form submission. Only valid when the
// link points at a FORM view; each submit appends one record. Honours expiry +
// password exactly like the read route, and only accepts cells for fields the
// form actually asks for (so a crafted payload can't write hidden columns).
baseShare.post('/share/:token/submit', async (req: Request, res: Response) => {
  try {
    const prisma = getPrisma();
    const link = await prisma.shareLink.findUnique({ where: { token: req.params.token } });
    if (!link) return res.status(404).json({ error: 'Link tidak ditemukan atau sudah dicabut' });
    if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return res.status(410).json({ error: 'Link sudah kedaluwarsa' });
    if (link.passwordHash) {
      const supplied = String(req.body?.password ?? '');
      if (!supplied || !(await bcrypt.compare(supplied, link.passwordHash))) return res.status(401).json({ error: 'password_required' });
    }
    const tables = await prisma.baseTable.findMany({ where: { baseId: link.baseId }, select: { id: true, fields: true, views: true } });
    const table = tables.find((t) => (t.views as { id: string }[]).some((v) => v.id === link.viewId));
    const view = table ? (table.views as { id: string; type?: string; hidden?: string[] }[]).find((v) => v.id === link.viewId) : null;
    if (!table || !view) return res.status(404).json({ error: 'View tidak ditemukan' });
    if (view.type !== 'form') return res.status(400).json({ error: 'Link ini bukan formulir' });

    // Whitelist: only non-hidden, writable (non-formula) fields of this form.
    const hidden = new Set(view.hidden ?? []);
    const allowed = new Set(
      (table.fields as { id: string; type: string }[])
        .filter((f) => !hidden.has(f.id) && f.type !== 'formula')
        .map((f) => f.id),
    );
    const incoming = (req.body?.cells ?? {}) as Record<string, unknown>;
    const cells: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming)) if (allowed.has(k)) cells[k] = v;

    const count = await prisma.baseRecord.count({ where: { tableId: table.id } });
    await prisma.baseRecord.create({ data: { tableId: table.id, cells: cells as object, orderIndex: count } });
    await prisma.shareLink.update({ where: { token: link.token }, data: { lastOpenedAt: new Date() } }).catch(() => {});
    return res.status(201).json({ success: true });
  } catch (err) { console.error('[share] submit error:', err); return res.status(500).json({ error: 'Gagal mengirim formulir' }); }
});

export default baseShare;
