import { PrismaClient } from '@prisma/client';
import { getPrisma } from './prisma';
import { Response, NextFunction } from 'express';
import { WorkspaceAction, WorkspaceRole, canWorkspace } from '@virtualmeet/shared';
import { AuthRequest } from '../middleware/auth';

// Local client, matching the per-file convention used by every route in this
// repo (see routes/bases.ts, routes/auth.ts, ...).

// Resolve the caller's workspace role FROM THE DATABASE on every call. Never
// from the JWT and never from the request body — a token minted before a
// demotion must not keep admin powers, and a client-sent role is just a claim.
export async function resolveWorkspaceRole(prisma: PrismaClient, userId: string): Promise<WorkspaceRole | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { workspaceRole: true, active: true },
  });
  if (!user) return null;
  // A deactivated account keeps its row (audit history must survive) but
  // holds no powers at all.
  if (!user.active) return null;
  return user.workspaceRole === 'admin' ? 'admin' : 'member';
}

// Gate for every /api/admin/* route. Use as:
//   admin.post('/admin/shifts', authenticateToken, requireWorkspace('attendance:manageShifts'), handler)
// Always mount AFTER authenticateToken.
export function requireWorkspace(action: WorkspaceAction) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const role = await resolveWorkspaceRole(getPrisma(), req.userId!);
      if (!canWorkspace(action, { workspaceRole: role ?? undefined })) {
        return res.status(403).json({ error: 'Butuh peran admin workspace' });
      }
      req.workspaceRole = role ?? undefined;
      return next();
    } catch (err) {
      console.error('[workspace] role check error:', err);
      return res.status(500).json({ error: 'Gagal memeriksa izin' });
    }
  };
}
