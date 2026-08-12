import { Router, Response } from 'express';
import { getPrisma } from '../lib/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireOperator } from '../lib/operator';

const operator = Router();

// Read-only, cross-org organization list for the deployment operator (see
// specs/2026-08-12-operator-org-list-design.md). Deliberately no
// pagination (YAGNI — v1 has exactly one operator checking a list that
// stays small for a long time) and no mutation endpoints (org delete/
// suspend is explicitly out of scope for this spec).
operator.get('/operator/organizations', authenticateToken, requireOperator, async (_req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const orgs = await prisma.organization.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        _count: { select: { users: true } },
        users: {
          where: { workspaceRole: 'admin' },
          select: { displayName: true, email: true },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      organizations: orgs.map((org) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        createdAt: org.createdAt,
        memberCount: org._count.users,
        admins: org.users,
      })),
    });
  } catch (err) {
    console.error('[operator] organizations list error:', err);
    return res.status(500).json({ error: 'Gagal memuat daftar organisasi' });
  }
});

export default operator;
