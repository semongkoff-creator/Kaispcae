import { Request, Response, NextFunction } from 'express';

const requestCounts = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(windowMs: number, max: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = requestCounts.get(ip);

    if (!entry || now > entry.resetAt) {
      requestCounts.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= max) {
      return res.status(429).json({ error: 'Too many requests, try again later' });
    }

    entry.count++;
    next();
  };
}

export function socketRateLimit(maxPerSecond: number) {
  const socketCounts = new Map<string, number[]>();

  return (socketId: string): boolean => {
    const now = Date.now();
    const timestamps = socketCounts.get(socketId) || [];
    const recent = timestamps.filter((t) => now - t < 1000);

    if (recent.length >= maxPerSecond) {
      socketCounts.set(socketId, recent);
      return false;
    }

    recent.push(now);
    socketCounts.set(socketId, recent);
    return true;
  };
}
