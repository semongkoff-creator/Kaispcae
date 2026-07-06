import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { getConfig } from '../config';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { validate, registerSchema, loginSchema } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimit';

const auth = Router();

function getPrisma(): PrismaClient {
  return new PrismaClient();
}

function signToken(user: { id: string; email: string }): string {
  const config = getConfig();
  return jwt.sign(
    { userId: user.id, email: user.email },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRES_IN as any },
  );
}

// How close to expiry (in seconds) a token has to be before GET /auth/me
// hands back a freshly-signed replacement — see the route below. Keeps an
// actively-returning user logged in indefinitely without ever needing a
// dedicated refresh-token flow: every time they open the app with a token
// inside this window, they silently get a new full-length one.
const REFRESH_THRESHOLD_SECONDS = 3 * 24 * 60 * 60; // 3 days

// Login/register are brute-force targets — much tighter than the global
// 100-req/min limiter applied to every other route.
const authRateLimit = rateLimit(15 * 60 * 1000, 10); // 10 attempts / 15 min / IP

// POST /auth/register
auth.post('/register', authRateLimit, validate(registerSchema), async (req, res: Response) => {
  try {
    const { email, password, displayName } = req.body;
    const prisma = getPrisma();

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const hashed = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, password: hashed, displayName },
    });

    const token = signToken(user);

    return res.status(201).json({
      user: { id: user.id, email: user.email, displayName: user.displayName },
      token,
    });
  } catch (err) {
    console.error('[auth] register error:', err);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /auth/login
auth.post('/login', authRateLimit, validate(loginSchema), async (req, res: Response) => {
  try {
    const { email, password } = req.body;
    const prisma = getPrisma();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken(user);

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarConfig: user.avatarConfig,
      },
      token,
    });
  } catch (err) {
    console.error('[auth] login error:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// GET /auth/me
auth.get('/me', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const prisma = getPrisma();
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) {
      // A JWT can verify fine (correct signature, not expired) and still
      // point at a user id that no longer exists in the database — this is
      // what a database reset looks like from the client's side (valid
      // token, "auto-login" silently fails). Loud and specific on purpose:
      // this exact combination is easy to mis-diagnose as a token/JWT bug.
      console.warn(
        `[auth] /me: token valid but userId ${req.userId} not found in DB — ` +
        'likely a database reset (e.g. in-memory/dev DB recreated) invalidating otherwise-valid sessions.',
      );
      return res.status(404).json({ error: 'User not found' });
    }

    // Sliding-expiry refresh: an actively-returning user with a token still
    // valid but within REFRESH_THRESHOLD_SECONDS of expiring gets a new
    // full-length one here, so someone who opens the app regularly is never
    // logged out — only a user who stays away longer than the full
    // JWT_EXPIRES_IN window ever hits a real expiry.
    let refreshedToken: string | undefined;
    if (typeof req.tokenExp === 'number') {
      const secondsRemaining = req.tokenExp - Math.floor(Date.now() / 1000);
      if (secondsRemaining < REFRESH_THRESHOLD_SECONDS) {
        refreshedToken = signToken(user);
      }
    }

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarConfig: user.avatarConfig,
      },
      ...(refreshedToken ? { token: refreshedToken } : {}),
    });
  } catch (err) {
    console.error('[auth] me error:', err);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

export default auth;
