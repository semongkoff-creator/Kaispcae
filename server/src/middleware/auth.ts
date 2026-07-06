import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getConfig } from '../config';

export interface AuthRequest extends Request {
  userId?: string;
}

export function authenticateToken(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const userId = verifyToken(token);
  if (!userId) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
  req.userId = userId;
  next();
}

// Non-throwing verify used for Socket.IO handshake auth, where a missing/
// invalid token means "treat as anonymous" rather than "reject the request".
export function verifyToken(token: string): string | null {
  try {
    const config = getConfig();
    const decoded = jwt.verify(token, config.JWT_SECRET) as { userId: string; email: string };
    return decoded.userId;
  } catch {
    return null;
  }
}
