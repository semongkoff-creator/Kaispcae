import { Router, Response } from 'express';
import { Server } from 'socket.io';
import { PrismaClient, Prisma } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { WORKSPACE_ACTIONS } from '@kaispace/shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireWorkspace } from '../lib/workspace';
import { writeAudit, clientIp } from '../lib/audit';
import { rateLimit } from '../middleware/rateLimit';
import { findUserInOrg, findDepartmentInOrg } from '../lib/orgScope';

const admin = Router();

let ioRef: Server | null = null;
export function setAdminIo(io: Server): void { ioRef = io; }

// Invites and role changes are abuse-sensitive; same shape as the auth limiter.
const adminMutationLimit = rateLimit(60 * 1000, 30);

// Notify a user in-app via the shared Notification table (a takeover notice
// must not need its own delivery channel). The Base module that once owned this
// table was removed (A7); the table and this path remain.
async function notify(prisma: PrismaClient, userId: string, body: string): Promise<void> {
  try {
    await prisma.notification.create({
      data: { recipientId: userId, kind: 'workspace', body },
    });
    ioRef?.to(`user:${userId}`).emit('base:notif', {});
  } catch (err) {
    console.error('[admin] notify error:', err);
  }
}

// ─── Members ────────────────────────────────────────────────────────

admin.get('/admin/members', authenticateToken, requireWorkspace('workspace:manageMembers'), async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const users = await prisma.user.findMany({
      // Multi-tenant Fase 2 — used to have no where at all, returning every
      // account in the deployment to any workspace admin regardless of org.
      where: { organizationId: req.organizationId },
      select: {
        id: true, email: true, displayName: true, workspaceRole: true, timezone: true,
        active: true, createdAt: true, memberVerifiedAt: true,
        department: { select: { id: true, name: true } },
        manager: { select: { id: true, displayName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return res.json({ members: users });
  } catch (err) {
    console.error('[admin] members error:', err);
    return res.status(500).json({ error: 'Gagal memuat anggota' });
  }
});

// Change workspace role / department / manager / active.
admin.patch('/admin/members/:userId', authenticateToken, requireWorkspace('workspace:manageMembers'), adminMutationLimit, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    // Multi-tenant Fase 2 — this used to resolve ANY userId with no org
    // check, so a workspace admin of one org could promote/demote/deactivate
    // or reassign the manager of an account in a DIFFERENT org. findUserInOrg
    // returns null (→ 404) for a cross-org id, same as "doesn't exist".
    const target = await findUserInOrg(prisma, req.params.userId, req.organizationId, {
      id: true, workspaceRole: true, active: true, departmentId: true, managerId: true, displayName: true,
      memberVerifiedAt: true,
    });
    if (!target) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });

    const data: Prisma.UserUpdateInput = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (req.body?.workspaceRole !== undefined) {
      const role = String(req.body.workspaceRole);
      if (role !== 'admin' && role !== 'member') return res.status(400).json({ error: 'Peran tidak valid' });
      // Guard against locking the workspace out of itself: the last active
      // admin may not demote themselves (mirrors the Base module's
      // last-owner rule). Scoped to the TARGET's own org — an unscoped
      // count across every org would almost never trip once a second org
      // exists, silently defeating this guard for org A the moment org B
      // has its own admin.
      if (target.workspaceRole === 'admin' && role === 'member') {
        const admins = await prisma.user.count({ where: { workspaceRole: 'admin', active: true, organizationId: req.organizationId } });
        if (admins <= 1) return res.status(400).json({ error: 'Admin terakhir tidak bisa diturunkan' });
      }
      before.workspaceRole = target.workspaceRole; after.workspaceRole = role;
      data.workspaceRole = role;
    }
    if (req.body?.active !== undefined) {
      const active = Boolean(req.body.active);
      if (target.active && !active) {
        const admins = await prisma.user.count({ where: { workspaceRole: 'admin', active: true, organizationId: req.organizationId } });
        if (target.workspaceRole === 'admin' && admins <= 1) return res.status(400).json({ error: 'Admin terakhir tidak bisa dinonaktifkan' });
      }
      before.active = target.active; after.active = active;
      data.active = active;
    }
    // Approve (or withdraw approval for) a self-service registration. This is
    // the escape hatch for the only account-creation path that can't vouch
    // for itself — see User.memberVerifiedAt in schema.prisma. Stored as an
    // instant rather than a boolean so the audit trail below records WHEN,
    // and the client sends a plain boolean so it never has to invent a
    // timestamp the server would overwrite anyway.
    if (req.body?.memberVerified !== undefined) {
      const verified = Boolean(req.body.memberVerified);
      before.memberVerified = !!target.memberVerifiedAt; after.memberVerified = verified;
      data.memberVerifiedAt = verified ? new Date() : null;
    }
    if (req.body?.departmentId !== undefined) {
      const depId = req.body.departmentId ? String(req.body.departmentId) : null;
      // Migration slice — Department now carries organizationId; without
      // this check a workspace admin could attach an employee to another
      // org's department by id.
      if (depId) {
        const dep = await findDepartmentInOrg(prisma, depId, req.organizationId);
        if (!dep) return res.status(404).json({ error: 'Departemen tidak ditemukan' });
      }
      before.departmentId = target.departmentId; after.departmentId = depId;
      data.department = depId ? { connect: { id: depId } } : { disconnect: true };
    }
    if (req.body?.managerId !== undefined) {
      const mgrId = req.body.managerId ? String(req.body.managerId) : null;
      if (mgrId === target.id) return res.status(400).json({ error: 'Tidak bisa menjadi manajer diri sendiri' });
      // The new manager must be in the same org as the target — otherwise a
      // workspace admin could wire up a reporting line across companies.
      if (mgrId) {
        const mgr = await findUserInOrg(prisma, mgrId, req.organizationId, { id: true });
        if (!mgr) return res.status(404).json({ error: 'Manajer tidak ditemukan' });
      }
      before.managerId = target.managerId; after.managerId = mgrId;
      data.manager = mgrId ? { connect: { id: mgrId } } : { disconnect: true };
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Tidak ada perubahan' });

    await prisma.user.update({ where: { id: target.id }, data });
    await writeAudit(prisma, {
      actorId: req.userId!, action: 'workspace:manageMembers', targetType: 'user',
      targetId: target.id, targetUserId: target.id, meta: { before, after }, ip: clientIp(req),
    });
    if (after.workspaceRole) await notify(prisma, target.id, `Peran workspace kamu diubah menjadi ${after.workspaceRole === 'admin' ? 'Admin' : 'Anggota'}.`);
    if (after.active === false) await notify(prisma, target.id, 'Akun kamu dinonaktifkan oleh admin.');
    return res.json({ id: target.id, ...after });
  } catch (err) {
    console.error('[admin] update member error:', err);
    return res.status(500).json({ error: 'Gagal mengubah anggota' });
  }
});

// Directory for invite pickers (Calendar attendees, Docs sharing, ...).
// Deliberately NOT admin-gated and deliberately minimal: you cannot invite a
// colleague you can't name, but nobody needs their email, role, department or
// manager to do it — so those are not in the response.
admin.get('/workspace/people', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    // Multi-tenant Fase 2 — used to return every active account in the
    // deployment; a picker for inviting a colleague must not list people
    // from a different company.
    const people = await prisma.user.findMany({
      where: { active: true, organizationId: req.organizationId },
      select: { id: true, displayName: true },
      orderBy: { displayName: 'asc' },
      take: 500,
    });
    return res.json({ people });
  } catch (err) {
    console.error('[admin] people error:', err);
    return res.status(500).json({ error: 'Gagal memuat daftar orang' });
  }
});

// ─── Departments ────────────────────────────────────────────────────

admin.get('/admin/departments', authenticateToken, requireWorkspace('workspace:manageMembers'), async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    // Migration slice — used to return every org's departments (requireWorkspace
    // checks role only, not org membership of the resource).
    const departments = await prisma.department.findMany({
      where: { organizationId: req.organizationId },
      select: { id: true, name: true, _count: { select: { members: true } } },
      orderBy: { name: 'asc' },
    });
    return res.json({ departments: departments.map((d) => ({ id: d.id, name: d.name, memberCount: d._count.members })) });
  } catch (err) {
    console.error('[admin] departments error:', err);
    return res.status(500).json({ error: 'Gagal memuat departemen' });
  }
});

admin.post('/admin/departments', authenticateToken, requireWorkspace('workspace:manageMembers'), adminMutationLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Nama departemen tidak boleh kosong' });
    // Migration slice — uniqueness is now per-org (@@unique([organizationId,
    // name])); this pre-check is scoped the same way so a name already used
    // by a DIFFERENT org no longer blocks this one from using it.
    const existing = await prisma.department.findUnique({ where: { organizationId_name: { organizationId: req.organizationId!, name } } });
    if (existing) return res.status(409).json({ error: 'Departemen dengan nama itu sudah ada' });
    const dep = await prisma.department.create({ data: { name, organizationId: req.organizationId! } });
    await writeAudit(prisma, { actorId: req.userId!, action: 'workspace:manageMembers', targetType: 'department', targetId: dep.id, meta: { created: name }, ip: clientIp(req) });
    return res.status(201).json({ id: dep.id, name: dep.name, memberCount: 0 });
  } catch (err) {
    console.error('[admin] create department error:', err);
    return res.status(500).json({ error: 'Gagal membuat departemen' });
  }
});

admin.delete('/admin/departments/:id', authenticateToken, requireWorkspace('workspace:manageMembers'), async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    // Migration slice — org-scoped lookup; without it an admin could delete
    // another org's department by id (members' departmentId → null via
    // Prisma's SetNull, which would have applied cross-org too).
    const dep = await findDepartmentInOrg(prisma, req.params.id, req.organizationId);
    if (!dep) return res.status(404).json({ error: 'Departemen tidak ditemukan' });
    await prisma.department.delete({ where: { id: dep.id } }); // members' departmentId → null (SetNull)
    await writeAudit(prisma, { actorId: req.userId!, action: 'workspace:manageMembers', targetType: 'department', targetId: dep.id, meta: { deleted: dep.name }, ip: clientIp(req) });
    return res.json({ success: true });
  } catch (err) {
    console.error('[admin] delete department error:', err);
    return res.status(500).json({ error: 'Gagal menghapus departemen' });
  }
});

// ─── Policy ─────────────────────────────────────────────────────────

const POLICY_DEFAULTS = {
  basePublicLinksAllowed: true,
  baseExportAllowed: true,
  docsPublicLinksAllowed: true,
  docsLinkPasswordRequired: false,
  maxShareLinkDays: null as number | null,
};

// Read-your-own-policy is intentionally NOT admin-gated: every client needs
// to know whether share links are allowed in order to hide the affordance.
// It exposes no one's data — only the workspace's own rules. Migration
// slice — this used to read the one literal id='singleton' row, meaning
// EVERY org read (and, via the PATCH below, silently overwrote) the exact
// same policy in real time. organizationId is now WorkspacePolicy's own
// primary key, one row per org.
admin.get('/workspace/policy', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const policy = await prisma.workspacePolicy.findUnique({ where: { organizationId: req.organizationId } });
    return res.json({ policy: policy ?? POLICY_DEFAULTS });
  } catch (err) {
    console.error('[admin] get policy error:', err);
    return res.status(500).json({ error: 'Gagal memuat kebijakan' });
  }
});

admin.patch('/admin/policy', authenticateToken, requireWorkspace('base:managePolicy'), adminMutationLimit, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const before = (await prisma.workspacePolicy.findUnique({ where: { organizationId: req.organizationId! } })) ?? POLICY_DEFAULTS;

    const patch: Record<string, unknown> = {};
    for (const key of ['basePublicLinksAllowed', 'baseExportAllowed', 'docsPublicLinksAllowed', 'docsLinkPasswordRequired'] as const) {
      if (req.body?.[key] !== undefined) patch[key] = Boolean(req.body[key]);
    }
    if (req.body?.maxShareLinkDays !== undefined) {
      const v = req.body.maxShareLinkDays;
      if (v === null || v === '') patch.maxShareLinkDays = null;
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 1 || n > 3650) return res.status(400).json({ error: 'Batas hari tidak valid' });
        patch.maxShareLinkDays = Math.floor(n);
      }
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Tidak ada perubahan' });

    const policy = await prisma.workspacePolicy.upsert({
      where: { organizationId: req.organizationId! },
      update: { ...patch, updatedById: req.userId! },
      create: { ...POLICY_DEFAULTS, ...patch, organizationId: req.organizationId!, updatedById: req.userId! },
    });
    // Log ONLY the keys this request actually changed. Recording the whole
    // `before` row against a partial `after` renders untouched fields as
    // "true → —" in the viewer, which reads as "an admin cleared this" — the
    // log would be actively misleading, which is worse than no log.
    const beforeChanged: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) beforeChanged[k] = (before as Record<string, unknown>)[k];
    await writeAudit(prisma, {
      actorId: req.userId!, action: 'base:managePolicy', targetType: 'policy', targetId: req.organizationId!,
      meta: { before: beforeChanged, after: patch }, ip: clientIp(req),
    });
    return res.json({ policy });
  } catch (err) {
    console.error('[admin] patch policy error:', err);
    return res.status(500).json({ error: 'Gagal menyimpan kebijakan' });
  }
});

// ─── Takeover ───────────────────────────────────────────────────────
// The ONLY sanctioned path for an admin to reach someone's private resource.
// It is loud by construction: audit row + notification to the previous owner.
// There is no read-without-takeover endpoint, and there must never be one.

// Doc takeover — the ONLY way an admin ever reaches a private document's
// contents (D6).
admin.post('/admin/docs/:docId/takeover', authenticateToken, requireWorkspace('docs:takeover'), adminMutationLimit, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    // Multi-tenant Fase 2 — Doc has no organizationId column of its own, but
    // ownerId is a real relation to User (which does), so the org check
    // rides on the owner join rather than needing a new column. Wrong-org
    // (or missing) both read as the same 404 — a workspace admin must never
    // learn that a document exists in someone else's company.
    const doc = await prisma.doc.findUnique({
      where: { id: req.params.docId },
      select: { id: true, title: true, ownerId: true, owner: { select: { organizationId: true } } },
    });
    if (!doc || doc.owner.organizationId !== req.organizationId) return res.status(404).json({ error: 'Dokumen tidak ditemukan' });
    if (doc.ownerId === req.userId) return res.status(400).json({ error: 'Kamu sudah pemilik dokumen ini' });
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'Alasan wajib diisi untuk pengambilalihan' });

    const prevOwnerId = doc.ownerId;
    await prisma.$transaction([
      // Previous owner keeps editor access — a takeover must not also erase
      // someone's access to their own work.
      prisma.docPermission.upsert({
        where: { docId_subjectType_subjectId: { docId: doc.id, subjectType: 'user', subjectId: prevOwnerId } },
        update: { role: 'editor' },
        create: { docId: doc.id, subjectType: 'user', subjectId: prevOwnerId, role: 'editor' },
      }),
      prisma.docPermission.deleteMany({ where: { docId: doc.id, subjectId: req.userId! } }),
      prisma.doc.update({ where: { id: doc.id }, data: { ownerId: req.userId! } }),
    ]);

    await writeAudit(prisma, {
      actorId: req.userId!, action: 'docs:takeover', targetType: 'doc', targetId: doc.id,
      targetUserId: prevOwnerId, reason,
      meta: { title: doc.title, before: { ownerId: prevOwnerId }, after: { ownerId: req.userId } },
      ip: clientIp(req),
    });
    const actor = await prisma.user.findUnique({ where: { id: req.userId! }, select: { displayName: true } });
    await notify(prisma, prevOwnerId, `Admin ${actor?.displayName ?? ''} mengambil alih kepemilikan dokumen "${doc.title}". Alasan: ${reason}`);
    return res.json({ success: true, docId: doc.id, newOwnerId: req.userId });
  } catch (err) {
    console.error('[admin] doc takeover error:', err);
    return res.status(500).json({ error: 'Gagal mengambil alih dokumen' });
  }
});

// ─── Audit log ──────────────────────────────────────────────────────

admin.get('/admin/audit', authenticateToken, requireWorkspace('workspace:viewAuditLog'), async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    // Multi-tenant Fase 2 — AuditLog has no organizationId column, but
    // actorId is a required relation to User (which does), so the filter
    // rides on that join. Optional actorId/targetUserId query filters below
    // still apply ON TOP of this — a cross-org id just yields zero rows,
    // never a peek into another company's log.
    const where: Prisma.AuditLogWhereInput = { actor: { organizationId: req.organizationId } };
    if (req.query.actorId) where.actorId = String(req.query.actorId);
    if (req.query.targetUserId) where.targetUserId = String(req.query.targetUserId);
    if (req.query.action) where.action = String(req.query.action);
    if (req.query.from || req.query.to) {
      where.createdAt = {};
      if (req.query.from) (where.createdAt as Prisma.DateTimeFilter).gte = new Date(String(req.query.from));
      if (req.query.to) (where.createdAt as Prisma.DateTimeFilter).lte = new Date(String(req.query.to));
    }
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const entries = await prisma.auditLog.findMany({
      where, take: limit, orderBy: { createdAt: 'desc' },
      select: {
        id: true, action: true, targetType: true, targetId: true, meta: true,
        reason: true, ip: true, createdAt: true,
        actor: { select: { id: true, displayName: true } },
        targetUser: { select: { id: true, displayName: true } },
      },
    });
    return res.json({ entries, actions: WORKSPACE_ACTIONS });
  } catch (err) {
    console.error('[admin] audit error:', err);
    return res.status(500).json({ error: 'Gagal memuat audit log' });
  }
});

// ─── Backup & recovery ─────────────────────────────────────────────
//
// Item 12, "Tak Terpikir" checklist — manual export, not a scheduled job:
// admin clicks a button in the Admin Console whenever they want a snapshot,
// downloaded straight to their machine rather than stored on the server
// (nothing new to secure/rotate/prune server-side). Covers everything that
// is actually PERSISTED: room notes (DeskNote) and attendance.
// "Pengumuman" (room notices) is deliberately
// NOT included — see roomHandler.ts's roomNoticeMap doc comment: a pinned
// notice is in-memory only by design (a live banner, not a historical
// record), so there is nothing durable to back up there.
admin.get('/admin/backup/export', authenticateToken, requireWorkspace('workspace:exportBackup'), async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    // Multi-tenant Fase 2 — both of these used to have no where at all,
    // dumping every room's notes and every user's attendance company-wide
    // into one export.
    const [notes, attendance] = await Promise.all([
      prisma.deskNote.findMany({ where: { room: { organizationId: req.organizationId } }, orderBy: { createdAt: 'asc' } }),
      // Deliberately excludes clockIn/clockOut lat/lng/accuracy — location is
      // the most sensitive column here, and a manual export would create an
      // unmanaged copy of it sitting outside the app entirely.
      prisma.attendanceRecord.findMany({
        where: { user: { organizationId: req.organizationId } },
        orderBy: { date: 'asc' },
        select: {
          id: true, userId: true, date: true, clockIn: true, clockOut: true, shiftId: true,
          status: true, workMinutes: true, overtimeMinutes: true, clockInMethod: true, note: true, createdAt: true,
        },
      }),
    ]);

    await writeAudit(getPrisma(), {
      actorId: req.userId!, action: 'backup:export', targetType: 'workspace',
      meta: { noteCount: notes.length, attendanceCount: attendance.length },
      ip: clientIp(req),
    });

    const backup = { exportedAt: new Date().toISOString(), exportedBy: req.userId, notes, attendance };
    const filename = `kaispace-backup-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(JSON.stringify(backup, null, 2));
  } catch (err) {
    console.error('[admin] backup export error:', err);
    return res.status(500).json({ error: 'Gagal membuat backup' });
  }
});

export default admin;
