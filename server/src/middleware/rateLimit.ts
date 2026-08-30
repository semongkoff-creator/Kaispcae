import { Request, Response, NextFunction } from 'express';

export interface RateLimitOptions {
  /**
   * Give the budget back when the request succeeds (status < 400).
   *
   * For a login endpoint the thing worth limiting is WRONG guesses, not
   * arrivals. Counting both means one office behind one NAT IP shares a single
   * budget for correct passwords: the Nth coworker to sign in is refused
   * despite typing the right thing, and a shift change or a "everyone please
   * reload" is enough to exhaust it for everybody.
   *
   * Refunding successes keeps the brute-force ceiling exactly where it was —
   * an attacker produces failures by definition, and failures still count in
   * full — while making the limit invisible to people who know their password.
   */
  refundOnSuccess?: boolean;
}

export function rateLimit(windowMs: number, max: number, options: RateLimitOptions = {}) {
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

    if (options.refundOnSuccess) {
      // On 'finish', so the handler's own outcome decides. Re-read the map
      // rather than closing over `entry`: the window may have rolled over
      // while the request was in flight, and decrementing the NEW window's
      // counter for an old request would let the budget drift upward.
      res.on('finish', () => {
        if (res.statusCode >= 400) return;
        const current = requestCounts.get(ip);
        if (current === entry) entry.count = Math.max(0, entry.count - 1);
      });
    }

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
