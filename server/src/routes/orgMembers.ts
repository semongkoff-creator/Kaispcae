import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const orgMembers = Router();

// GET /api/org/members — the full org roster, open to any authenticated
// member (not admin-gated, unlike admin.ts's GET /admin/members, which
// includes email/department/manager and is workspace-admin only). This is
// just id/name/role, needed by ParticipantPanel.tsx to render the
// "Offline" section — everyone in the org NOT currently connected via
// socket right now.
orgMembers.get('/org/members', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const prisma = getPrisma();
    const users = await prisma.user.findMany({
      where: { organizationId: req.organizationId, active: true },
      select: { id: true, displayName: true, workspaceRole: true, firstSeenAt: true },
      orderBy: { displayName: 'asc' },
    });
    // specs/2026-08-21-first-seen-offline-members-design.md — Prisma's
    // Date is converted to epoch milliseconds explicitly here (rather than
    // relying on JSON.stringify's default Date->ISO-string behavior),
    // matching this codebase's existing numeric-timestamp convention for
    // client-facing fields (e.g. larkApproval.ts's submittedAt).
    const members = users.map((u) => ({ ...u, firstSeenAt: u.firstSeenAt ? u.firstSeenAt.getTime() : null }));
    return res.json({ members });
  } catch (err) {
    console.error('[orgMembers] list error:', err);
    return res.status(500).json({ error: 'Gagal memuat anggota organisasi' });
  }
});

export default orgMembers;
