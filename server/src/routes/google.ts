import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getPrisma } from '../lib/prisma';
import { signToken } from './auth';
import { disconnectUserSockets } from '../lib/sessionKick';
import { googleConfig } from '../lib/googleConfig';
import { resolvePendingInvite, markInviteAccepted, accountFieldsForInviteRole } from '../lib/orgInvite';

const google = Router();

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

// Same in-memory Map + TTL shape as lark.ts's own pendingStates/
// oneTimeCodes (see that file's comment on why this is enough for a
// single-process server) — kept as its own separate pair of Maps rather
// than sharing Lark's, same "small deliberate duplication for decoupling"
// precedent used elsewhere in this codebase (mediaHandler.ts/
// followHandler.ts).
const pendingStates = new Map<string, { exp: number; orgInviteToken?: string }>();
const oneTimeCodes = new Map<string, { token: string; exp: number }>();
const STATE_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;

function sweep<T>(m: Map<string, T>, expOf: (v: T) => number) {
  const now = Date.now();
  for (const [k, v] of m) if (expOf(v) < now) m.delete(k);
}

// Kick off the OAuth dance: redirect the browser to Google's consent
// screen. ?orgInvite=<token> (present when this login started from an
// org-invite link, see JoinOrgInvite.tsx) rides along in `state` exactly
// like Lark's own login route does.
google.get('/auth/google/login', (req: Request, res: Response) => {
  const cfg = googleConfig();
  if (!cfg) return res.status(503).send('Login Google belum dikonfigurasi di server.');
  sweep(pendingStates, (v) => v.exp);
  const state = crypto.randomBytes(16).toString('hex');
  const orgInviteToken = typeof req.query.orgInvite === 'string' ? req.query.orgInvite : undefined;
  pendingStates.set(state, { exp: Date.now() + STATE_TTL_MS, orgInviteToken });
  const url =
    `${GOOGLE_AUTH_URL}` +
    `?client_id=${encodeURIComponent(cfg.clientId)}` +
    `&redirect_uri=${encodeURIComponent(cfg.redirect)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent('openid email profile')}` +
    `&state=${state}`;
  res.redirect(url);
});

// Google redirects back here with ?code&state. Exchange the code, resolve
// the user, mint OUR JWT (same helper as manual login and Lark), then
// bounce to the SPA with a one-time code — never the JWT itself — in the
// URL, same posture as Lark's callback.
google.get('/auth/google/callback', async (req: Request, res: Response) => {
  const cfg = googleConfig();
  if (!cfg) return res.status(503).send('Login Google belum dikonfigurasi di server.');

  const { code, state } = req.query;
  const fail = (reason: string) => res.redirect(`/?googleError=${reason}`);

  const pending = typeof state === 'string' ? pendingStates.get(state) : undefined;
  if (!pending || pending.exp < Date.now()) return fail('state');
  pendingStates.delete(state as string);
  if (typeof code !== 'string' || !code) return fail('nocode');

  try {
    // 1) Exchange the authorization code for tokens.
    const tokRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: cfg.clientId,
        client_secret: cfg.secret,
        redirect_uri: cfg.redirect,
        grant_type: 'authorization_code',
      }),
    });
    const tokJson: any = await tokRes.json();
    const accessToken: string | undefined = tokJson?.access_token;
    if (!accessToken) throw new Error(`no access_token (error=${tokJson?.error} desc=${tokJson?.error_description})`);

    // 2) Fetch the verified profile.
    const infoRes = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    const info: any = await infoRes.json();
    const email: string | undefined = info?.email;
    const emailVerified = info?.email_verified === true || info?.email_verified === 'true';
    const name: string | undefined = info?.name;
    const picture: string | undefined = info?.picture;

    // Google's email_verified is what makes matching-by-email safe at all
    // (see below) — an unverified email is just a claim, not an identity.
    if (!email || !emailVerified) return fail('unverified');

    // 3) Resolve the local account. Unlike Lark (keyed on a provider id,
    // larkOpenId — Lark doesn't always return a real email, hence
    // syntheticLarkEmail), Google always returns a verified email, so this
    // "Basic" scope keys on that email directly rather than adding a new
    // googleId column — see the plan doc for this trade-off.
    const prisma = getPrisma();
    const normalizedEmail = email.trim().toLowerCase();
    let user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (!user) {
      // Brand-new identity — ONLY created behind a still-valid org invite.
      // Multi-tenant is live: unlike Lark's new-user branch (which still
      // falls back to DEFAULT_ORG_ID when there's no invite — a known,
      // not-yet-closed gap), Google refuses outright rather than silently
      // landing a stranger in the wrong org.
      const invite = pending.orgInviteToken ? await resolvePendingInvite(prisma, pending.orgInviteToken) : null;
      if (!invite) return fail('no-invite');

      user = await prisma.user.create({
        data: {
          email: normalizedEmail,
          displayName: name || normalizedEmail,
          // Same trick as Lark's `lark-oauth:...` placeholder — a random,
          // non-bcrypt value so manual login's bcrypt.compare can never
          // match it; this account is Google-only until it sets a real
          // password (out of scope for this Basic pass).
          password: `google-oauth:${crypto.randomBytes(24).toString('hex')}`,
          profilePhoto: picture || null,
          organizationId: invite.organizationId,
          ...accountFieldsForInviteRole(invite.role),
          // This branch is only reachable behind a still-valid org invite
          // (the guard above returns 'no-invite' otherwise), so the account
          // is vouched for on arrival. See User.memberVerifiedAt.
          memberVerifiedAt: new Date(),
        },
      });
      await markInviteAccepted(prisma, invite.id);
    }
    // Existing user (found by email): org is whatever's already stored on
    // that row — never touched here. Any invite token present is ignored,
    // same posture as Lark's existing-account branch.

    // 4) OUR token, minted the one and only way (identical to manual login
    // and Lark). Bug 1 — single active session, same as both.
    const sessionId = crypto.randomUUID();
    await prisma.user.update({ where: { id: user.id }, data: { currentSessionId: sessionId } });
    disconnectUserSockets(user.id);
    const token = signToken(user, sessionId);

    // 5) Hand it back via a single-use code, not the raw JWT in the URL.
    sweep(oneTimeCodes, (v) => v.exp);
    const otc = crypto.randomBytes(24).toString('hex');
    oneTimeCodes.set(otc, { token, exp: Date.now() + CODE_TTL_MS });
    return res.redirect(`/?googleCode=${otc}`);
  } catch (e) {
    console.error('[google] callback failed:', e);
    return fail('exchange');
  }
});

// The SPA posts the one-time code back here to receive the JWT, then
// stores it exactly like a manual login. Single-use + short TTL, same as
// Lark's own exchange route.
google.post('/auth/google/exchange', (req: Request, res: Response) => {
  const code = req.body?.code;
  const entry = typeof code === 'string' ? oneTimeCodes.get(code) : undefined;
  if (!entry || entry.exp < Date.now()) {
    if (typeof code === 'string') oneTimeCodes.delete(code);
    return res.status(400).json({ error: 'Kode login kadaluarsa atau tidak valid.' });
  }
  oneTimeCodes.delete(code); // single use
  return res.json({ token: entry.token });
});

export default google;
