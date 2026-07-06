import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getConfig } from '../config';

export interface AuthRequest extends Request {
  userId?: string;
  // Unix seconds the current token expires at (JWT `exp` claim) — used by
  // GET /auth/me to decide whether this session is close enough to expiry
  // to hand back a freshly-signed replacement token (see auth.ts).
  tokenExp?: number;
}

export function authenticateToken(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const decoded = verifyTokenClaims(token);
  if (!decoded) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
  req.userId = decoded.userId;
  req.tokenExp = decoded.exp;
  next();
}

// Non-throwing verify used for Socket.IO handshake auth, where a missing/
// invalid token means "treat as anonymous" rather than "reject the request".
export function verifyToken(token: string): string | null {
  return verifyTokenClaims(token)?.userId ?? null;
}

function verifyTokenClaims(token: string): { userId: string; exp: number } | null {
  try {
    const config = getConfig();
    const decoded = jwt.verify(token, config.JWT_SECRET) as { userId: string; email: string; exp: number };
    return { userId: decoded.userId, exp: decoded.exp };
  } catch {
    return null;
  }
}
