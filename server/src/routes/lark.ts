import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getPrisma } from '../lib/prisma';
import { getConfig } from '../config';
import { signToken } from './auth';
import { syntheticLarkEmail } from '../lib/larkEmail';
import { buildStoredTokenFields } from '../lib/larkUserToken';
import { disconnectUserSockets } from '../lib/sessionKick';
import { DEFAULT_ORG_ID } from '../lib/defaultOrg';
import { resolvePendingInvite, markInviteAccepted, accountFieldsForInviteRole } from '../lib/orgInvite';

const lark = Router();

// International Lark, not feishu.cn — confirmed with the user.
const LARK_BASE = 'https://open.larksuite.com/open-apis';

// Short-lived in-memory stores. This is a single-process server; if it ever
// runs multi-instance these move to Redis, but for one process a Map + TTL is
// enough and keeps A1 self-contained.
//   pendingStates: OAuth `state` values we issued, to reject forged callbacks.
//   oneTimeCodes:  single-use codes swapped for a JWT, so the raw token never
//                  travels in a URL (which proxies/servers log).
// Fase 5 — orgInviteToken rides alongside the expiry so a login started
// from an invite link (?orgInvite=<token> on /auth/lark/login) can resolve
// the right org in the callback below, instead of every Lark login
// hardcoding DEFAULT_ORG_ID.
const pendingStates = new Map<string, { exp: number; orgInviteToken?: string }>();
const oneTimeCodes = new Map<string, { token: string; exp: number }>();
const STATE_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;

function sweep<T>(m: Map<string, T>, expOf: (v: T) => number) {
  const now = Date.now();
  for (const [k, v] of m) if (expOf(v) < now) m.delete(k);
}

function larkConfig(): { appId: string; secret: string; redirect: string } | null {
  const c = getConfig();
  if (!c.LARK_APP_ID || !c.LARK_APP_SECRET || !c.LARK_REDIRECT_URI) return null;
  return { appId: c.LARK_APP_ID, secret: c.LARK_APP_SECRET, redirect: c.LARK_REDIRECT_URI };
}

// Kick off the OAuth dance: redirect the browser to Lark's consent screen.
lark.get('/auth/lark/login', (req: Request, res: Response) => {
  const cfg = larkConfig();
  if (!cfg) return res.status(503).send('Login Lark belum dikonfigurasi di server.');
  sweep(pendingStates, (v) => v.exp);
  const state = crypto.randomBytes(16).toString('hex');
  const orgInviteToken = typeof req.query.orgInvite === 'string' ? req.query.orgInvite : undefined;
  pendingStates.set(state, { exp: Date.now() + STATE_TTL_MS, orgInviteToken });
  const url =
    `${LARK_BASE}/authen/v1/authorize` +
    `?app_id=${encodeURIComponent(cfg.appId)}` +
    `&redirect_uri=${encodeURIComponent(cfg.redirect)}` +
    `&state=${state}`;
  res.redirect(url);
});

// Lark redirects back here with ?code&state. Exchange the code, resolve the
// user, mint OUR JWT (same helper as manual login), then bounce to the SPA
// with a one-time code — never the JWT itself — in the URL.
lark.get('/auth/lark/callback', async (req: Request, res: Response) => {
  const cfg = larkConfig();
  if (!cfg) return res.status(503).send('Login Lark belum dikonfigurasi di server.');

  const { code, state } = req.query;
  // Relative redirects: the browser arrived on the same origin the SPA is
  // served from (nginx routes both), so "/" is the frontend without depending
  // on a CLIENT_URL that may point at a stale tunnel.
  const fail = (reason: string) => res.redirect(`/?larkError=${reason}`);

  const pending = typeof state === 'string' ? pendingStates.get(state) : undefined;
  if (!pending || pending.exp < Date.now()) return fail('state');
  pendingStates.delete(state as string);
  if (typeof code !== 'string' || !code) return fail('nocode');

  try {
    // 1) App access token (identifies our app to Lark).
    const appTokenRes = await fetch(`${LARK_BASE}/auth/v3/app_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.secret }),
    });
    const appTokenJson: any = await appTokenRes.json();
    const appAccessToken = appTokenJson?.app_access_token;
    if (!appAccessToken) throw new Error(`no app_access_token (code=${appTokenJson?.code} msg=${appTokenJson?.msg})`);

    // 2) Swap the login code for a user access token.
    const tokRes = await fetch(`${LARK_BASE}/authen/v1/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${appAccessToken}` },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    const tokJson: any = await tokRes.json();
    const tokData = tokJson?.data ?? {};
    const userAccessToken: string | undefined = tokData.access_token;
    // Bagian 4 upgrade — capture the refresh token + lifetimes (previously
    // discarded) so chat can be relayed as this user later. Encrypted before
    // storage; buildStoredTokenFields returns {} if encryption is off.
    const larkTokenFields = buildStoredTokenFields(
      tokData.access_token,
      tokData.refresh_token,
      tokData.expires_in,
      tokData.refresh_expires_in,
    );

    // The access_token response already carries the profile; user_info is the
    // task's named source, so prefer it and fall back to the token payload.
    let openId: string | undefined = tokData.open_id;
    let name: string | undefined = tokData.name;
    let avatar: string | undefined = tokData.avatar_url;
    let email: string | undefined = tokData.email;
    // A2 — capture the Lark user_id (employee_id) if the login returns it (the
    // contact:user.employee_id:readonly scope may surface it here). The
    // attendance API needs this, not open_id. If absent, larkAttendance
    // resolves it later from open_id — so a null here is fine.
    let larkUserId: string | undefined = tokData.user_id;

    if (userAccessToken) {
      const infoRes = await fetch(`${LARK_BASE}/authen/v1/user_info`, {
        headers: { Authorization: `Bearer ${userAccessToken}` },
      });
      const infoJson: any = await infoRes.json();
      const info = infoJson?.data ?? {};
      openId = info.open_id ?? openId;
      name = info.name ?? name;
      avatar = info.avatar_url ?? avatar;
      email = info.email ?? email;
      larkUserId = info.user_id ?? larkUserId;
    }

    if (!openId) throw new Error(`no open_id (token code=${tokJson?.code} msg=${tokJson?.msg})`);

    // 3) Find-or-create the local account, keyed on the Lark identity.
    const prisma = getPrisma();
    let user = await prisma.user.findUnique({ where: { larkOpenId: openId } });
    if (!user) {
      // Fase 5 — a login started from an invite link (?orgInvite=<token>)
      // resolves the invited org/role instead of the DEFAULT_ORG_ID
      // placeholder every account used to land in regardless of which
      // company actually invited them. Falls back to the old placeholder
      // when there's no invite (still true for a bare Lark login button
      // with no invite context) or the invite turned out to be invalid/
      // expired/already used by the time the OAuth round-trip finished.
      const invite = pending.orgInviteToken ? await resolvePendingInvite(prisma, pending.orgInviteToken) : null;
      const orgFields = invite
        ? { organizationId: invite.organizationId, ...accountFieldsForInviteRole(invite.role) }
        : { organizationId: DEFAULT_ORG_ID };
      user = await prisma.user.create({
        data: {
          larkOpenId: openId,
          larkUserId: larkUserId || null,
          // Real Lark email if the scope ever returns one; otherwise a
          // deterministic placeholder (email is required + unique).
          email: email || syntheticLarkEmail(openId),
          displayName: name || 'Lark User',
          // A random, non-bcrypt value: manual login's bcrypt.compare can never
          // match it, so this account is Lark-only until/unless it sets a real
          // password (out of scope for A1).
          password: `lark-oauth:${crypto.randomBytes(24).toString('hex')}`,
          // Lark's avatar is an external URL (not a base64 data-URL like the
          // upload feature stores). ChatAvatar renders any <img src>, so it
          // still shows — just note it's not the base64-in-DB path.
          profilePhoto: avatar || null,
          ...orgFields,
          ...larkTokenFields,
        },
      });
      if (invite) await markInviteAccepted(prisma, invite.id);
    } else {
      // Existing account — always refresh the stored tokens on each Lark login
      // (they rotate), backfill user_id for accounts created before A2, and
      // re-sync name/avatar from Lark on EVERY login (previously this only
      // ever happened once, at account creation — a name/photo change in
      // Lark afterward never reached KaiSpace). Lark wins whenever it
      // actually returns a value; a transient empty response from user_info
      // must never blank out what's already stored.
      const updateData: Record<string, unknown> = { ...larkTokenFields };
      if (larkUserId && !user.larkUserId) updateData.larkUserId = larkUserId;
      if (name) updateData.displayName = name;
      if (avatar) updateData.profilePhoto = avatar;
      if (Object.keys(updateData).length > 0) {
        user = await prisma.user.update({ where: { id: user.id }, data: updateData });
      }
    }

    // 4) OUR token, minted the one and only way (identical to manual login).
    // Bug 1 — start a fresh single-session (persist id + kick other devices),
    // same as manual login, so the "one active device" rule applies to Lark too.
    const sessionId = crypto.randomUUID();
    await prisma.user.update({ where: { id: user.id }, data: { currentSessionId: sessionId } });
    disconnectUserSockets(user.id);
    const token = signToken(user, sessionId);

    // 5) Hand it back via a single-use code, not the raw JWT in the URL.
    sweep(oneTimeCodes, (v) => v.exp);
    const otc = crypto.randomBytes(24).toString('hex');
    oneTimeCodes.set(otc, { token, exp: Date.now() + CODE_TTL_MS });
    return res.redirect(`/?larkCode=${otc}`);
  } catch (e) {
    console.error('[lark] callback failed:', e);
    return fail('exchange');
  }
});

// The SPA posts the one-time code back here to receive the JWT, then stores it
// exactly like a manual login (see useAuth). Single-use + short TTL.
lark.post('/auth/lark/exchange', (req: Request, res: Response) => {
  const code = req.body?.code;
  const entry = typeof code === 'string' ? oneTimeCodes.get(code) : undefined;
  if (!entry || entry.exp < Date.now()) {
    if (typeof code === 'string') oneTimeCodes.delete(code);
    return res.status(400).json({ error: 'Kode login kadaluarsa atau tidak valid.' });
  }
  oneTimeCodes.delete(code); // single use
  return res.json({ token: entry.token });
});

export default lark;
