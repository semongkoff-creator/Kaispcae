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

// Login/register are brute-force targets — much tighter than the global
// 100-req/min limiter applied to every other route.
const authRateLimit = rateLimit(15 * 60 * 1000, 10); // 10 attempts / 15 min / IP

// POST /auth/register
auth.post('/register', authRateLimit, validate(registerSchema), async (req, res: Response) => {
  try {
    const { email, password, displayName } = req.body;
    const prisma = getPrisma();
    const config = getConfig();

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const hashed = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, password: hashed, displayName },
    });

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRES_IN as any },
    );

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
    const config = getConfig();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRES_IN as any },
    );

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
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarConfig: user.avatarConfig,
      },
    });
  } catch (err) {
    console.error('[auth] me error:', err);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

export default auth;
