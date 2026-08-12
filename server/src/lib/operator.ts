import { Response, NextFunction } from 'express';
import { getPrisma } from './prisma';
import { getConfig } from '../config';
import { AuthRequest } from '../middleware/auth';

// Parses OPERATOR_EMAILS on every call rather than caching — this env var
// changes rarely enough that re-parsing costs nothing, and caching would
// need its own invalidation story for zero real benefit. Comparison is
// trim+lowercase on both sides, matching this codebase's existing email-
// normalization convention (see routes/google.ts, routes/orgInvite.ts).
export function isOperatorEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = process.env.OPERATOR_EMAILS;
  if (!raw) return false;
  const normalized = email.trim().toLowerCase();
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalized);
}

// Gate for GET /api/operator/*. Mirrors lib/workspace.ts's requireWorkspace:
// resolves the caller's CURRENT email from the database by req.userId,
// never from the JWT (an admin could change another user's email after
// their token was minted). Deliberately fails closed to 403 on a DB error
// too — unlike requireWorkspace's 500 on its own DB error, a lookup
// failure here means "cannot confirm operator status," which must never
// be treated as "assume operator." Always mount AFTER authenticateToken.
export async function requireOperator(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const user = await getPrisma().user.findUnique({ where: { id: req.userId! }, select: { email: true } });
    if (!user || !isOperatorEmail(user.email)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return next();
  } catch (err) {
    console.error('[operator] role check error:', err);
    return res.status(403).json({ error: 'Forbidden' });
  }
}
