import { Request, Response, NextFunction } from 'express';

export function rateLimit(windowMs: number, max: number) {
  // Own Map per rateLimit() instance — previously module-level and shared
  // by every instance, so the global app.use() limiter and each route's
  // stricter limiter (e.g. authRateLimit) were incrementing the exact same
  // counter per IP. In practice that meant any 10 total requests/minute
  // from one IP (to ANY route) tripped the 10-max auth limiter, since its
  // own check ran against a count already bumped by the global middleware.
  const requestCounts = new Map<string, { count: number; resetAt: number }>();

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
