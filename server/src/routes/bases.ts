import { Router, Response } from 'express';
import { Server } from 'socket.io';
import { Prisma } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { BaseOp, BaseRole, MutationRequest, can, canViewField, baseRoleAtLeast, FieldAccess } from '@virtualmeet/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveBaseRole } from '../lib/baseAccess';
import { applyOps } from '../lib/baseOps';
import { buildEmptyTables } from '../lib/baseSeed';

const bases = Router();

let ioRef: Server | null = null;
export function setBaseIo(io: Server): void { ioRef = io; }

interface StoredField { id: string; access?: FieldAccess }
interface StoredView { id: string; mode?: 'collaborative' | 'locked' | 'personal'; ownerId?: string }

// Fields this role may NOT see. Such fields are removed from the payload
// entirely (and their cells scrubbed from records) — never sent then hidden
// client-side (finish criterion #11).
function hiddenFieldIds(fields: StoredField[], role: BaseRole): Set<string> {
  return new Set(fields.filter((f) => !canViewField(f.access, role)).map((f) => f.id));
}

// GET /api/bases — bases the caller owns or is a member of.
bases.get('/bases', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const uid = req.userId!;
    const [owned, memberOf] = await Promise.all([
      prisma.base.findMany({ where: { ownerId: uid }, select: { id: true, name: true, updatedAt: true } }),
      prisma.baseMember.findMany({ where: { userId: uid }, select: { role: true, base: { select: { id: true, name: true, updatedAt: true } } } }),
    ]);
    const list = [
      ...owned.map((b) => ({ id: b.id, name: b.name, role: 'owner' as BaseRole, updatedAt: b.updatedAt })),
      ...memberOf.map((m) => ({ id: m.base.id, name: m.base.name, role: m.role as BaseRole, updatedAt: m.base.updatedAt })),
    ];
    return res.json({ bases: list });
  } catch (err) { console.error('[bases] list error:', err); return res.status(500).json({ error: 'Failed to list bases' }); }
});

// POST /api/bases — create a base (caller becomes owner), seeded.
bases.post('/bases', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const name = String(req.body?.name || 'Basis Data Baru').slice(0, 80);
    const base = await prisma.base.create({ data: { name, ownerId: req.userId! } });
    // A new base is ALWAYS empty — a blank starter table, no sample content.
    const seed = buildEmptyTables();
    for (const t of seed) {
      await prisma.baseTable.create({
        data: { id: t.id, baseId: base.id, name: t.name, icon: t.icon, orderIndex: seed.indexOf(t), fields: t.fields as object, views: t.views as object },
      });
      if (t.records.length) {
        await prisma.baseRecord.createMany({ data: t.records.map((r) => ({ id: r.id, tableId: t.id, cells: r.cells as object, orderIndex: r.orderIndex, createdById: req.userId!, updatedById: req.userId! })) });
      }
    }
    return res.status(201).json({ id: base.id, name: base.name });
  } catch (err) { console.error('[bases] create error:', err); return res.status(500).json({ error: 'Failed to create base' }); }
});

// PATCH /api/bases/:baseId/tables/:tableId/record-rule — owner-only (7d).
// Body: { personFieldId } to arm the rule, or { personFieldId: null } to clear.
bases.patch('/bases/:baseId/tables/:tableId/record-rule', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const role = await resolveBaseRole(prisma, req.params.baseId, req.userId!);
    // Deliberately owner-only: an editor who could set this rule could also
    // point it at themselves and lock every other editor out of the table.
    if (role !== 'owner') return res.status(403).json({ error: 'Hanya pemilik yang bisa mengatur aturan record' });
    const table = await prisma.baseTable.findFirst({
      where: { id: req.params.tableId, baseId: req.params.baseId },
      select: { id: true, fields: true },
    });
    if (!table) return res.status(404).json({ error: 'Tabel tidak ditemukan' });

    const raw = req.body?.personFieldId;
    if (raw === null || raw === undefined || raw === '') {
      await prisma.baseTable.update({ where: { id: table.id }, data: { recordRule: Prisma.JsonNull } });
      return res.json({ recordRule: null });
    }
    const personFieldId = String(raw);
    const field = ((table.fields as unknown as { id: string; type: string }[]) ?? []).find((f) => f.id === personFieldId);
    if (!field) return res.status(400).json({ error: 'Kolom tidak ditemukan' });
    if (field.type !== 'person') return res.status(400).json({ error: 'Aturan record hanya bisa memakai kolom bertipe Orang' });
    await prisma.baseTable.update({ where: { id: table.id }, data: { recordRule: { personFieldId } } });
    return res.json({ recordRule: { personFieldId } });
  } catch (err) { console.error('[bases] record-rule error:', err); return res.status(500).json({ error: 'Gagal menyimpan aturan' }); }
});

// GET /api/bases/:baseId — base + tables (fields/views) + members + my role.
bases.get('/bases/:baseId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const role = await resolveBaseRole(prisma, req.params.baseId, req.userId!);
    if (!role) return res.status(403).json({ error: 'No access to this base' });
    const base = await prisma.base.findUnique({
      where: { id: req.params.baseId },
      include: {
        owner: { select: { id: true, displayName: true } },
        tables: { orderBy: { orderIndex: 'asc' }, select: { id: true, name: true, icon: true, fields: true, views: true, recordRule: true } },
        members: { include: { user: { select: { id: true, displayName: true, email: true } } } },
      },
    });
    if (!base) return res.status(404).json({ error: 'Base not found' });
    const members = [
      { userId: base.owner.id, name: base.owner.displayName, email: undefined as string | undefined, role: 'owner' as BaseRole },
      ...base.members.map((m) => ({ userId: m.user.id, name: m.user.displayName, email: m.user.email, role: m.role as BaseRole })),
    ];
    // Strip fields this role isn't allowed to see (#11), and personal views
    // belonging to someone else (#12) — they never leave the server.
    const tables = base.tables.map((t) => {
      const fields = (t.fields as unknown as StoredField[]) ?? [];
      const hidden = hiddenFieldIds(fields, role);
      const views = ((t.views as unknown as StoredView[]) ?? []).filter((v) => v.mode !== 'personal' || v.ownerId === req.userId);
      return { ...t, fields: fields.filter((f) => !hidden.has(f.id)), views };
    });
    return res.json({ id: base.id, name: base.name, ownerId: base.ownerId, myRole: role, tables, members });
  } catch (err) { console.error('[bases] get error:', err); return res.status(500).json({ error: 'Failed to get base' }); }
});

// PATCH /api/bases/:baseId — rename the base (editor+).
bases.patch('/bases/:baseId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const role = await resolveBaseRole(prisma, req.params.baseId, req.userId!);
    if (!baseRoleAtLeast(role ?? undefined, 'editor')) return res.status(403).json({ error: 'Tidak boleh mengubah nama base' });
    const name = String(req.body?.name ?? '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Nama tidak boleh kosong' });
    await prisma.base.update({ where: { id: req.params.baseId }, data: { name } });
    // everyone on this base sees the new name without a reload
    if (ioRef) ioRef.to(`base:${req.params.baseId}`).emit('base:renamed', { name });
    return res.json({ id: req.params.baseId, name });
  } catch (err) { console.error('[bases] rename error:', err); return res.status(500).json({ error: 'Failed to rename base' }); }
});

// GET /api/bases/:baseId/records?tableId=
bases.get('/bases/:baseId/records', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const role = await resolveBaseRole(prisma, req.params.baseId, req.userId!);
    if (!role) return res.status(403).json({ error: 'No access' });
    const tableId = String(req.query.tableId || '');
    const table = tableId ? await prisma.baseTable.findFirst({ where: { id: tableId, baseId: req.params.baseId }, select: { id: true } }) : null;
    if (tableId && !table) return res.status(404).json({ error: 'Table not in base' });
    const records = await prisma.baseRecord.findMany({
      where: tableId ? { tableId } : { table: { baseId: req.params.baseId } },
      orderBy: { orderIndex: 'asc' },
      take: 5000,
      select: { id: true, tableId: true, cells: true, createdById: true, updatedById: true, createdAt: true, updatedAt: true, _count: { select: { comments: true } } },
    });

    // Scrub cells of fields this role can't see — the values never leave the
    // server, they aren't merely hidden client-side (#11).
    const tablesMeta = await prisma.baseTable.findMany({ where: { baseId: req.params.baseId }, select: { id: true, fields: true } });
    const hiddenByTable = new Map<string, Set<string>>();
    for (const t of tablesMeta) hiddenByTable.set(t.id, hiddenFieldIds((t.fields as unknown as StoredField[]) ?? [], role));

    return res.json({
      records: records.map((r) => {
        const hidden = hiddenByTable.get(r.tableId);
        let cells = r.cells as Record<string, unknown>;
        if (hidden && hidden.size) { cells = { ...cells }; for (const fid of hidden) delete cells[fid]; }
        return { ...r, cells, commentCount: r._count.comments, _count: undefined };
      }),
    });
  } catch (err) { console.error('[bases] records error:', err); return res.status(500).json({ error: 'Failed to get records' }); }
});

// POST /api/bases/:baseId/mutations — batch ops, permission-enforced.
bases.post('/bases/:baseId/mutations', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const role = await resolveBaseRole(prisma, req.params.baseId, req.userId!);
    if (!role) return res.status(403).json({ error: 'No access to this base' });
    const body = req.body as MutationRequest;
    const ops: BaseOp[] = Array.isArray(body?.ops) ? body.ops : [];
    if (ops.length === 0) return res.json({ applied: [], rejected: [] });

    const { applied, rejected } = await applyOps(prisma, req.params.baseId, req.userId!, role, ops);

    // Nothing applied AND everything was a permission failure → 403 (finish #10).
    if (applied.length === 0 && rejected.length > 0 && rejected.every((r) => r.reason === 'forbidden')) {
      return res.status(403).json({ error: 'Forbidden', rejected });
    }

    // Broadcast exactly the applied ops to everyone else on this base's WS room.
    if (ioRef && applied.length) {
      ioRef.to(`base:${req.params.baseId}`).except(`user:${req.userId}`).emit('base:ops', { type: 'ops', ops: applied, byUserId: req.userId });
    }
    await prisma.base.update({ where: { id: req.params.baseId }, data: { updatedAt: new Date() } }).catch(() => {});
    return res.json({ applied, rejected });
  } catch (err) { console.error('[bases] mutations error:', err); return res.status(500).json({ error: 'Failed to apply mutations' }); }
});

// ── Members ──
bases.get('/bases/:baseId/members', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const role = await resolveBaseRole(prisma, req.params.baseId, req.userId!);
    if (!role) return res.status(403).json({ error: 'No access' });
    const base = await prisma.base.findUnique({ where: { id: req.params.baseId }, include: { owner: { select: { id: true, displayName: true, email: true } }, members: { include: { user: { select: { id: true, displayName: true, email: true } } } } } });
    if (!base) return res.status(404).json({ error: 'Base not found' });
    return res.json({
      members: [
        { userId: base.owner.id, name: base.owner.displayName, email: base.owner.email, role: 'owner' },
        ...base.members.map((m) => ({ userId: m.user.id, name: m.user.displayName, email: m.user.email, role: m.role })),
      ],
    });
  } catch (err) { console.error('[bases] members error:', err); return res.status(500).json({ error: 'Failed to list members' }); }
});

const ASSIGNABLE: BaseRole[] = ['editor', 'commenter', 'viewer'];

bases.post('/bases/:baseId/members', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const role = await resolveBaseRole(prisma, req.params.baseId, req.userId!);
    if (!can('base:manageMembers', { role: role ?? undefined })) return res.status(403).json({ error: 'Only the owner can manage members' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const newRole = req.body?.role as BaseRole;
    if (!email || !ASSIGNABLE.includes(newRole)) return res.status(400).json({ error: 'Invalid email or role' });
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) return res.status(404).json({ error: 'Pengguna dengan email itu tidak ditemukan' });
    const base = await prisma.base.findUnique({ where: { id: req.params.baseId }, select: { ownerId: true } });
    if (base?.ownerId === user.id) return res.status(400).json({ error: 'Pengguna itu sudah menjadi pemilik' });
    const member = await prisma.baseMember.upsert({
      where: { baseId_userId: { baseId: req.params.baseId, userId: user.id } },
      update: { role: newRole },
      create: { baseId: req.params.baseId, userId: user.id, role: newRole },
    });
    return res.status(201).json({ userId: member.userId, role: member.role });
  } catch (err) { console.error('[bases] add member error:', err); return res.status(500).json({ error: 'Failed to add member' }); }
});

bases.patch('/bases/:baseId/members/:userId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const role = await resolveBaseRole(prisma, req.params.baseId, req.userId!);
    if (!can('base:manageMembers', { role: role ?? undefined })) return res.status(403).json({ error: 'Only the owner can manage members' });
    const newRole = req.body?.role as BaseRole;
    if (!ASSIGNABLE.includes(newRole)) return res.status(400).json({ error: 'Invalid role' });
    await prisma.baseMember.update({ where: { baseId_userId: { baseId: req.params.baseId, userId: req.params.userId } }, data: { role: newRole } });
    return res.json({ userId: req.params.userId, role: newRole });
  } catch (err) { console.error('[bases] patch member error:', err); return res.status(500).json({ error: 'Failed to update member' }); }
});

bases.delete('/bases/:baseId/members/:userId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const role = await resolveBaseRole(prisma, req.params.baseId, req.userId!);
    // A member may remove THEMSELVES (leave); otherwise owner-only.
    const isSelf = req.params.userId === req.userId;
    if (!isSelf && !can('base:manageMembers', { role: role ?? undefined })) return res.status(403).json({ error: 'Forbidden' });
    const base = await prisma.base.findUnique({ where: { id: req.params.baseId }, select: { ownerId: true } });
    if (base?.ownerId === req.params.userId) return res.status(400).json({ error: 'Pemilik tidak bisa dikeluarkan — transfer kepemilikan dulu' });
    await prisma.baseMember.deleteMany({ where: { baseId: req.params.baseId, userId: req.params.userId } });
    return res.json({ success: true });
  } catch (err) { console.error('[bases] delete member error:', err); return res.status(500).json({ error: 'Failed to remove member' }); }
});

// POST /api/bases/:baseId/transfer — owner-only; new owner becomes owner, old
// owner is demoted to editor member. This is the ONLY way ownership changes,
// so the last owner can never demote themselves (finish #18).
bases.post('/bases/:baseId/transfer', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const role = await resolveBaseRole(prisma, req.params.baseId, req.userId!);
    if (!can('base:transfer', { role: role ?? undefined })) return res.status(403).json({ error: 'Only the owner can transfer ownership' });
    const toUserId = String(req.body?.toUserId || '');
    const target = await prisma.user.findUnique({ where: { id: toUserId }, select: { id: true } });
    if (!target) return res.status(404).json({ error: 'Target user not found' });
    await prisma.$transaction([
      prisma.base.update({ where: { id: req.params.baseId }, data: { ownerId: toUserId } }),
      // new owner shouldn't linger as a member row; old owner becomes editor.
      prisma.baseMember.deleteMany({ where: { baseId: req.params.baseId, userId: toUserId } }),
      prisma.baseMember.upsert({ where: { baseId_userId: { baseId: req.params.baseId, userId: req.userId! } }, update: { role: 'editor' }, create: { baseId: req.params.baseId, userId: req.userId!, role: 'editor' } }),
    ]);
    return res.json({ success: true, ownerId: toUserId });
  } catch (err) { console.error('[bases] transfer error:', err); return res.status(500).json({ error: 'Failed to transfer ownership' }); }
});

export default bases;
