import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getConfig } from '../config';
import { getPrisma } from '../lib/prisma';

// Bug 1 — single active session. The exact error code + message the client
// keys off to show "logged in elsewhere" and redirect to login.
export const SESSION_SUPERSEDED = 'SESSION_SUPERSEDED';
export const SESSION_SUPERSEDED_MESSAGE = 'Akun ini baru saja login di perangkat lain. Sesi ini telah berakhir.';

// A browser loading <img src="/api/uploads/<uuid>.png"> cannot attach an
// Authorization header, and passing the token as a query param would leak it
// into server logs and browser history — the exact tradeoff routes/uploads.ts
// used to justify serving uploads to anyone at all. The session therefore
// ALSO rides as an HttpOnly cookie, minted alongside every token we hand out.
//
// Path used to be narrowed to /api/uploads — fine until routes/uploads.ts (A8)
// added a SECOND read route, GET /api/files/:token, for Lark-Drive-backed
// attachments. A cookie's path match is a plain prefix test with no OR, so
// /api/uploads never matched /api/files: the browser silently dropped the
// cookie on every Drive-backed request, authenticateUploadRead saw no
// credential at all, and every such attachment 401'd — invisibly, since nginx
// logs a 401 same as any other response, and the failure reads identically to
// "the upload itself failed" from the chat bubble. Renaming either route
// isn't an option (every attachmentUrl already stored in the DB points at the
// old path), so the cookie's path widens to their common ancestor instead.
// /api is still far narrower than "every route": authenticateUploadRead is
// the ONLY place that ever reads this cookie's value, so it riding along on
// other /api/* requests doesn't hand any OTHER endpoint a credential to act
// on — there is nothing there to widen a CSRF/XSS surface INTO.
export const UPLOAD_COOKIE_NAME = 'mk_upload_sess';
const UPLOAD_COOKIE_PATH = '/api';

// Secure is keyed off the request's ACTUAL protocol, not NODE_ENV. Tying it
// to NODE_ENV would be a trap: nginx/nginx.conf currently terminates on plain
// `listen 80` with no TLS, so a production deploy would set Secure on a
// cookie the browser then refuses to send back over http — every image and
// attachment 401s, in production only, with dev and typecheck both clean.
// Reading the real scheme means this flips itself on the day TLS lands and
// needs no follow-up. Spoofing X-Forwarded-Proto only sets Secure on your own
// cookie over http, i.e. breaks your own session — not a way in.
function uploadCookieOptions(req: Request) {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim() || req.protocol;
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: proto === 'https',
    path: UPLOAD_COOKIE_PATH,
  };
}

// Mirrors the token's own `exp` rather than a fixed duration, so the cookie
// and the Bearer token can never outlive each other.
export function setUploadSessionCookie(req: Request, res: Response, token: string) {
  const claims = verifyTokenClaims(token);
  if (!claims) return;
  const maxAge = Math.max(0, claims.exp * 1000 - Date.now());
  res.cookie(UPLOAD_COOKIE_NAME, token, { ...uploadCookieOptions(req), maxAge });
}

// HttpOnly means client-side logout can't clear this itself — POST
// /auth/logout exists purely so the cookie dies with the localStorage token.
export function clearUploadSessionCookie(req: Request, res: Response) {
  res.clearCookie(UPLOAD_COOKIE_NAME, uploadCookieOptions(req));
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// Read-side auth for uploaded files. Accepts the cookie (browser tag loads)
// or a Bearer token (programmatic fetches), so both callers work without
// either mechanism being special-cased at the call site.
//
// This authenticates only — it does not authorize per-conversation. Any
// logged-in user can still read any upload they know the URL of, which is
// what map media already assumes (a media object's url is broadcast to
// everyone in the room). Narrowing DM attachments to their participants needs
// the Conversation/Participant model that doesn't exist yet.
export function authenticateUploadRead(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = bearer ?? readCookie(req, UPLOAD_COOKIE_NAME);

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const decoded = verifyTokenClaims(token);
  if (!decoded) {
    return res.status(403).json({ error: 'Invalid or expired session' });
  }
  req.userId = decoded.userId;
  next();
}

export interface AuthRequest extends Request {
  userId?: string;
  // Set by requireWorkspace() (server/src/lib/workspace.ts) after it resolves
  // the role FROM THE DB. Never populated from the token or the body.
  workspaceRole?: 'admin' | 'member';
  // Unix seconds the current token expires at (JWT `exp` claim) — used by
  // GET /auth/me to decide whether this session is close enough to expiry
  // to hand back a freshly-signed replacement token (see auth.ts).
  tokenExp?: number;
  // Bug 1 — the token's sessionId claim; /auth/me preserves it on refresh so
  // the same device keeps one session across sliding-refresh.
  sessionId?: string;
}

// Bug 1 — a token is superseded when the user has an active session id and this
// token doesn't carry it. `currentSessionId === null` (legacy / no login since
// launch) is grace-accepted so a deploy never logs everyone out.
export async function isSessionSuperseded(userId: string, sessionId?: string): Promise<boolean> {
  try {
    const user = await getPrisma().user.findUnique({ where: { id: userId }, select: { currentSessionId: true } });
    return !!user?.currentSessionId && sessionId !== user.currentSessionId;
  } catch (e) {
    // Fail OPEN on a transient DB error: a DB blip must not log everyone out,
    // and the socket handshake + /auth/me enforce the same rule anyway.
    console.error('[auth] session check error:', e);
    return false;
  }
}

export async function authenticateToken(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const decoded = verifyTokenClaims(token);
  if (!decoded) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
  if (await isSessionSuperseded(decoded.userId, decoded.sessionId)) {
    return res.status(401).json({ error: SESSION_SUPERSEDED, message: SESSION_SUPERSEDED_MESSAGE });
  }
  req.userId = decoded.userId;
  req.tokenExp = decoded.exp;
  req.sessionId = decoded.sessionId;
  next();
}

// Non-throwing verify used for Socket.IO handshake auth, where a missing/
// invalid token means "treat as anonymous" rather than "reject the request".
export function verifyToken(token: string): string | null {
  return verifyTokenClaims(token)?.userId ?? null;
}

// Full claims — used by the socket handshake (needs sessionId, not just userId).
export function verifyTokenClaims(token: string): { userId: string; exp: number; sessionId?: string } | null {
  try {
    const config = getConfig();
    const decoded = jwt.verify(token, config.JWT_SECRET) as { userId: string; email: string; exp: number; sessionId?: string };
    return { userId: decoded.userId, exp: decoded.exp, sessionId: decoded.sessionId };
  } catch {
    return null;
  }
}

// Guest Link & Ruang Tunggu — a deliberately DIFFERENT claims shape from the
// real-account token above: `guestId` (a synthetic id, never a User.id) and
// `roomSlug` (the ONE room this token may ever join — see roomHandler.ts's
// JOIN_ROOM guest branch, which rejects any other slug outright), no
// `userId`/`sessionId` at all. Same JWT_SECRET (no separate secret needed —
// the claims shape itself is what makes this structurally impossible to
// route through authenticateToken/verifyTokenClaims: `decoded.userId` would
// just be undefined, and every consumer of req.userId does a real DB
// lookup/FK-write keyed on it). Short-lived on purpose (12h, vs accounts'
// 30d) — a guest session isn't meant to outlive the visit it was minted for.
export function signGuestToken(payload: { guestId: string; name: string; roomSlug: string }): string {
  const config = getConfig();
  return jwt.sign(
    { guestId: payload.guestId, name: payload.name, roomSlug: payload.roomSlug },
    config.JWT_SECRET,
    { expiresIn: '12h' },
  );
}

export interface GuestTokenClaims {
  guestId: string;
  name: string;
  roomSlug: string;
  exp: number;
}

export function verifyGuestTokenClaims(token: string): GuestTokenClaims | null {
  try {
    const config = getConfig();
    const decoded = jwt.verify(token, config.JWT_SECRET) as { guestId?: string; name?: string; roomSlug?: string; exp: number };
    if (!decoded.guestId || !decoded.roomSlug) return null;
    return { guestId: decoded.guestId, name: decoded.name || 'Guest', roomSlug: decoded.roomSlug, exp: decoded.exp };
  } catch {
    return null;
  }
}
