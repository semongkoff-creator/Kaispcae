import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { getPrisma } from '../lib/prisma';
import { getConfig } from '../config';
import { authenticateToken, setUploadSessionCookie, clearUploadSessionCookie, verifyTokenClaims, AuthRequest } from '../middleware/auth';
import { validate, registerSchema, loginSchema } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimit';
import { ensureCheckedInToday } from '../lib/larkAttendance';
import { disconnectUserSockets, disconnectUserSocketsSilently } from '../lib/sessionKick';
import { DEFAULT_ORG_ID } from '../lib/defaultOrg';
import { googleConfig } from '../lib/googleConfig';

const auth = Router();

// Fase 5 — lets the client know whether to even offer "Login with Google"
// before anyone is authenticated (LoginPage/JoinOrgInvite both fetch this
// on mount), without exposing the credentials themselves. Reuses
// googleConfig() (not a separately-hand-rolled check) so this can never
// drift out of sync with what routes/google.ts itself actually accepts —
// the button and the route it points at always agree.
auth.get('/config', (_req, res) => {
  const c = getConfig();
  res.json({
    larkEnabled: !!(c.LARK_APP_ID && c.LARK_APP_SECRET),
    googleEnabled: !!googleConfig(),
  });
});


// Exported so the Lark OAuth route (routes/lark.ts) issues the EXACT same
// token shape as manual login — same claims, same secret, same expiry — so the
// socket handshake middleware treats a Lark session identically. There must be
// only one way to mint a MeetKai JWT. Bug 1: the sessionId claim is what auth
// (REST + socket) checks against User.currentSessionId for single-session.
export function signToken(user: { id: string; email: string }, sessionId: string): string {
  const config = getConfig();
  return jwt.sign(
    { userId: user.id, email: user.email, sessionId },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRES_IN as any },
  );
}

// Bug 1 — establish a brand-new active session for this user (on a successful
// manual/Lark login): mint a fresh id, persist it as THE session, kick any
// other live sockets, and return the id to embed in the JWT.
async function startNewSession(userId: string): Promise<string> {
  const sessionId = randomUUID();
  await getPrisma().user.update({ where: { id: userId }, data: { currentSessionId: sessionId } });
  disconnectUserSockets(userId); // supersede every previously-connected device
  return sessionId;
}

// Logout's server-side half: rotate to a fresh (unguessable, never handed
// out) sessionId so the token just presented — and any other still-valid
// token for this account — immediately fails isSessionSuperseded, then
// silently drop any live sockets still using it. Same rotation mechanic as
// startNewSession above, but the kick must stay silent (see
// disconnectUserSocketsSilently's doc comment) — this isn't a new device
// taking over, it's the user themselves leaving on purpose.
async function invalidateSession(userId: string): Promise<void> {
  await getPrisma().user.update({ where: { id: userId }, data: { currentSessionId: randomUUID() } });
  disconnectUserSocketsSilently(userId);
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
    // The very first account ever created has no one else to grant it
    // admin — without this, a fresh deployment would have zero accounts
    // able to create a room at all (see shared/permissions.ts's AccountRole
    // and routes/rooms.ts's POST /rooms gate). A tiny race (two people
    // registering in the same instant on a brand-new deployment) could in
    // theory both read count===0, but that's an acceptably rare edge case
    // for a one-time bootstrap, not worth a transaction/lock for.
    const isFirstEverUser = (await prisma.user.count()) === 0;
    const user = await prisma.user.create({
      // The first-ever account also bootstraps the workspace admin. Without
      // this nobody would ever hold 'admin', so /admin and every
      // /api/admin/* route would be permanently unreachable.
      data: {
        email, password: hashed, displayName,
        accountRole: isFirstEverUser ? 'admin' : 'user',
        workspaceRole: isFirstEverUser ? 'admin' : 'member',
        // Fase 1 — no invite/org-selection flow exists yet (that's a later
        // phase), so every registration still lands in the one default org,
        // same behavior as today having a single implicit workspace.
        organizationId: DEFAULT_ORG_ID,
      },
    });

    const sessionId = await startNewSession(user.id);
    const token = signToken(user, sessionId);
    setUploadSessionCookie(req, res, token);

    return res.status(201).json({
      user: { id: user.id, email: user.email, displayName: user.displayName, accountRole: user.accountRole, workspaceRole: user.workspaceRole, timezone: user.timezone, tutorialCompletedAt: user.tutorialCompletedAt, preferences: user.preferences },
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
    // A deactivated account keeps its row (audit history must survive) but
    // must not be able to get back in.
    if (!user.active) {
      return res.status(403).json({ error: 'Akun ini dinonaktifkan. Hubungi admin.' });
    }

    const sessionId = await startNewSession(user.id);
    const token = signToken(user, sessionId);
    setUploadSessionCookie(req, res, token);

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarConfig: user.avatarConfig,
        accountRole: user.accountRole,
        workspaceRole: user.workspaceRole,
        timezone: user.timezone,
        tutorialCompletedAt: user.tutorialCompletedAt,
        preferences: user.preferences,
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
    // Explicit select (not the whole row): this endpoint runs on every mount +
    // sliding refresh, and the heavy profilePhoto TEXT column has no business
    // riding along. Only the fields actually used below are fetched; the client
    // gets photos (its own included) from the batched /users/profile-photos
    // route. Keep this list in sync with the response object + active/signToken
    // usage further down.
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true, email: true, displayName: true, avatarConfig: true, preferences: true,
        accountRole: true, workspaceRole: true, timezone: true, active: true,
        // larkOpenId (a short field, unlike profilePhoto) so we can trigger the
        // Lark attendance check-in below for Lark accounts only.
        larkOpenId: true,
        // Bug 1 — needed to preserve / adopt the single-session id below.
        currentSessionId: true,
        // QA #1/#6 — gates the first-run tutorial (App.tsx); null means this
        // account has never finished it.
        tutorialCompletedAt: true,
      },
    });
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
    // Deactivation must take effect on an ALREADY-ISSUED token, not only at
    // the next login — otherwise a deactivated account keeps working until
    // its JWT happens to expire. /me is the chokepoint every client hits on
    // load, so a 403 here ends the session.
    if (!user.active) {
      return res.status(403).json({ error: 'Akun ini dinonaktifkan. Hubungi admin.' });
    }

    // Bug 1 — single-session handling. authenticateToken already rejected a
    // token whose sessionId is superseded, so reaching here means either (a)
    // this token IS the active session, or (b) legacy: the user has no
    // currentSessionId yet (grace-accepted). For (b), ADOPT this device as the
    // active session now (migrate) so single-session takes effect without ever
    // logging existing 30-day auto-logins out. Either way we keep the SAME
    // sessionId across the sliding refresh below, so the same device stays one
    // continuous session.
    let sessionId = req.sessionId;
    if (!user.currentSessionId) {
      sessionId = sessionId ?? randomUUID();
      await prisma.user.update({ where: { id: user.id }, data: { currentSessionId: sessionId } });
    }

    // Sliding-expiry refresh: an actively-returning user with a token still
    // valid but within REFRESH_THRESHOLD_SECONDS of expiring gets a new
    // full-length one here, so someone who opens the app regularly is never
    // logged out — only a user who stays away longer than the full
    // JWT_EXPIRES_IN window ever hits a real expiry. Bug 1: a legacy token just
    // adopted above is re-minted unconditionally so it starts carrying the
    // sessionId claim.
    let refreshedToken: string | undefined;
    const adopted = !req.sessionId && !!sessionId; // legacy token migrated this hit
    if (sessionId && (adopted || typeof req.tokenExp === 'number')) {
      const secondsRemaining = typeof req.tokenExp === 'number' ? req.tokenExp - Math.floor(Date.now() / 1000) : 0;
      if (adopted || secondsRemaining < REFRESH_THRESHOLD_SECONDS) {
        refreshedToken = signToken(user, sessionId);
      }
    }

    // Unconditionally re-mint the upload cookie here, not just when the token
    // was refreshed above. /me is the one route every client hits on load, so
    // this is what gives a session that predates the cookie (token already in
    // localStorage, no cookie ever set) a working one — without it, existing
    // logins would silently lose every image and attachment until they logged
    // out and back in. Also re-arms the cookie's maxAge on each visit.
    const currentToken = refreshedToken
      ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
    if (currentToken) setUploadSessionCookie(req, res, currentToken);

    // A2 — trigger Lark Attendance check-in here, NOT at the OAuth callback:
    // /me is hit on every app load including 30-day auto-login, so this fires
    // once per work day even when the user never re-does OAuth. Fire-and-forget
    // + idempotent per WIB day; a failure must never block loading the app.
    // Lark accounts only (manual users have no larkOpenId).
    if (user.larkOpenId) void ensureCheckedInToday(user.id);

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarConfig: user.avatarConfig,
        accountRole: user.accountRole,
        workspaceRole: user.workspaceRole,
        timezone: user.timezone,
        tutorialCompletedAt: user.tutorialCompletedAt,
        preferences: user.preferences,
      },
      ...(refreshedToken ? { token: refreshedToken } : {}),
    });
  } catch (err) {
    console.error('[auth] me error:', err);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// POST /auth/logout — the upload cookie is HttpOnly, so the client dropping
// its localStorage token can't clear it; without this the cookie would
// outlive the visible session and keep serving uploads to a "logged out"
// browser. Deliberately not REQUIRING authentication: clearing a cookie is
// safe to do for anyone, and requiring a valid token would leave the cookie
// stranded in exactly the case that matters most (an already-expired
// session) — a missing/expired/invalid token still 204s, it just has
// nothing left to invalidate server-side.
//
// A still-valid token, if presented (see client/src/services/api.ts's
// logout — it's read before localStorage is cleared), also gets its
// session invalidated server-side via invalidateSession() above: without
// this, logout was purely cosmetic client-side — the JWT itself stayed
// valid until its natural expiry (up to REFRESH_THRESHOLD_SECONDS' worth of
// sliding refresh), so a token copied out of localStorage/history/an XSS
// before logout would keep working long after the user believed they'd
// logged out.
auth.post('/logout', async (req, res: Response) => {
  clearUploadSessionCookie(req, res);

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const decoded = token ? verifyTokenClaims(token) : null;
  if (decoded) {
    try {
      await invalidateSession(decoded.userId);
    } catch (e) {
      // The cookie is already cleared and the user is leaving regardless —
      // a DB hiccup here must not turn a logout into a stuck/error screen.
      console.error('[auth] logout session invalidation failed:', e);
    }
  }

  return res.status(204).end();
});

export default auth;
