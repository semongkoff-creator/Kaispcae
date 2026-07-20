import { Router, Response } from 'express';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { can } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveBaseRole } from '../lib/baseAccess';

const baseComments = Router();

let ioRef: Server | null = null;
export function setCommentsIo(io: Server): void { ioRef = io; }

// Resolve the base + caller's role from a record id (comments/history hang
// off records, but permission lives on the base).
async function recordBase(prisma: PrismaClient, recordId: string, userId: string) {
  const rec = await prisma.baseRecord.findUnique({ where: { id: recordId }, select: { table: { select: { baseId: true } } } });
  if (!rec) return null;
  const role = await resolveBaseRole(prisma, rec.table.baseId, userId);
  return role ? { baseId: rec.table.baseId, role } : null;
}

function commentDto(c: { id: string; authorId: string; author: { displayName: string }; body: string; mentions: unknown; parentId: string | null; resolved: boolean; createdAt: Date }) {
  return { id: c.id, authorId: c.authorId, authorName: c.author.displayName, body: c.body, mentions: (c.mentions as string[]) ?? [], parentId: c.parentId ?? undefined, resolved: c.resolved, createdAt: c.createdAt.getTime() };
}

// GET /api/records/:recordId/comments
baseComments.get('/records/:recordId/comments', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const ctx = await recordBase(prisma, req.params.recordId, req.userId!);
    if (!ctx) return res.status(403).json({ error: 'No access' });
    const comments = await prisma.recordComment.findMany({
      where: { recordId: req.params.recordId },
      orderBy: { createdAt: 'asc' },
      include: { author: { select: { displayName: true } } },
    });
    return res.json({ comments: comments.map(commentDto) });
  } catch (err) { console.error('[comments] list error:', err); return res.status(500).json({ error: 'Failed to list comments' }); }
});

// POST /api/records/:recordId/comments  { body, mentions: userId[], parentId? }
baseComments.post('/records/:recordId/comments', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const ctx = await recordBase(prisma, req.params.recordId, req.userId!);
    if (!ctx) return res.status(403).json({ error: 'No access' });
    if (!can('comment:create', { role: ctx.role })) return res.status(403).json({ error: 'Anda tidak boleh berkomentar' });
    const body = String(req.body?.body || '').slice(0, 4000).trim();
    if (!body) return res.status(400).json({ error: 'Komentar kosong' });
    const rawMentions: string[] = Array.isArray(req.body?.mentions) ? req.body.mentions : [];
    const parentId = typeof req.body?.parentId === 'string' ? req.body.parentId : null;

    // Only members of THIS base may be mentioned (and never yourself).
    const [owner, members] = await Promise.all([
      prisma.base.findUnique({ where: { id: ctx.baseId }, select: { ownerId: true, name: true } }),
      prisma.baseMember.findMany({ where: { baseId: ctx.baseId }, select: { userId: true } }),
    ]);
    const memberIds = new Set<string>([owner?.ownerId ?? '', ...members.map((m) => m.userId)]);
    const mentions = [...new Set(rawMentions)].filter((id) => memberIds.has(id) && id !== req.userId);

    const comment = await prisma.recordComment.create({
      data: { recordId: req.params.recordId, authorId: req.userId!, body, mentions, parentId },
      include: { author: { select: { displayName: true } } },
    });

    // A notification per MENTIONED user only — never a broadcast to everyone.
    if (mentions.length) {
      const author = comment.author.displayName;
      await prisma.notification.createMany({
        data: mentions.map((uid) => ({ baseId: ctx.baseId, recipientId: uid, kind: 'mention', body: `${author} menyebut Anda: "${body.slice(0, 80)}"`, recordId: req.params.recordId })),
      });
      // live bell bump for each mentioned user's sockets
      if (ioRef) for (const uid of mentions) ioRef.to(`user:${uid}`).emit('base:notif', { kind: 'mention' });
    }
    // refresh open comment threads / grid badges on this base
    if (ioRef) ioRef.to(`base:${ctx.baseId}`).emit('base:comment', { recordId: req.params.recordId });

    return res.status(201).json(commentDto(comment));
  } catch (err) { console.error('[comments] create error:', err); return res.status(500).json({ error: 'Failed to add comment' }); }
});

// PATCH /api/comments/:id  { body?, resolved? } — author-only for body; any
// member+ may toggle resolved.
baseComments.patch('/comments/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const c = await prisma.recordComment.findUnique({ where: { id: req.params.id }, select: { authorId: true, recordId: true } });
    if (!c) return res.status(404).json({ error: 'Not found' });
    const ctx = await recordBase(prisma, c.recordId, req.userId!);
    if (!ctx) return res.status(403).json({ error: 'No access' });
    const data: { body?: string; resolved?: boolean } = {};
    if (typeof req.body?.body === 'string') {
      if (c.authorId !== req.userId) return res.status(403).json({ error: 'Hanya penulis yang bisa mengedit' });
      data.body = req.body.body.slice(0, 4000);
    }
    if (typeof req.body?.resolved === 'boolean') data.resolved = req.body.resolved;
    await prisma.recordComment.update({ where: { id: req.params.id }, data });
    if (ioRef) ioRef.to(`base:${ctx.baseId}`).emit('base:comment', { recordId: c.recordId });
    return res.json({ success: true });
  } catch (err) { console.error('[comments] patch error:', err); return res.status(500).json({ error: 'Failed to update comment' }); }
});

// DELETE /api/comments/:id — author-only.
baseComments.delete('/comments/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const c = await prisma.recordComment.findUnique({ where: { id: req.params.id }, select: { authorId: true, recordId: true } });
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (c.authorId !== req.userId) return res.status(403).json({ error: 'Hanya penulis yang bisa menghapus' });
    const ctx = await recordBase(prisma, c.recordId, req.userId!);
    await prisma.recordComment.delete({ where: { id: req.params.id } });
    if (ioRef && ctx) ioRef.to(`base:${ctx.baseId}`).emit('base:comment', { recordId: c.recordId });
    return res.json({ success: true });
  } catch (err) { console.error('[comments] delete error:', err); return res.status(500).json({ error: 'Failed to delete comment' }); }
});

// GET /api/records/:recordId/history — who changed which field, old→new.
baseComments.get('/records/:recordId/history', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const ctx = await recordBase(prisma, req.params.recordId, req.userId!);
    if (!ctx) return res.status(403).json({ error: 'No access' });
    const hist = await prisma.recordHistory.findMany({
      where: { recordId: req.params.recordId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { actor: { select: { displayName: true } } },
    });
    return res.json({ history: hist.map((h) => ({ id: h.id, fieldId: h.fieldId, oldValue: h.oldValue, newValue: h.newValue, actorId: h.actorId, actorName: h.actor.displayName, createdAt: h.createdAt.getTime() })) });
  } catch (err) { console.error('[history] error:', err); return res.status(500).json({ error: 'Failed to load history' }); }
});

// GET /api/notifications — mine, newest first.
baseComments.get('/notifications', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const notifs = await prisma.notification.findMany({ where: { recipientId: req.userId! }, orderBy: { createdAt: 'desc' }, take: 100 });
    return res.json({ notifications: notifs.map((n) => ({ id: n.id, kind: n.kind, body: n.body, recordId: n.recordId ?? undefined, baseId: n.baseId ?? undefined, read: n.read, createdAt: n.createdAt.getTime() })) });
  } catch (err) { console.error('[notif] list error:', err); return res.status(500).json({ error: 'Failed to list notifications' }); }
});

// POST /api/notifications/read  { id? }  — mark one, or all if no id.
baseComments.post('/notifications/read', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const id = req.body?.id as string | undefined;
    await prisma.notification.updateMany({ where: id ? { id, recipientId: req.userId! } : { recipientId: req.userId! }, data: { read: true } });
    return res.json({ success: true });
  } catch (err) { console.error('[notif] read error:', err); return res.status(500).json({ error: 'Failed to mark read' }); }
});

export default baseComments;
