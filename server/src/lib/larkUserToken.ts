import { getPrisma } from './prisma';
import { getAppToken, LARK_OPENAPI_BASE } from './larkToken';
import { encryptToken, decryptToken, tokenCryptoEnabled } from './tokenCrypto';

// Bagian 4 upgrade — manage each user's stored Lark OAuth tokens so chat can be
// relayed AS the real user. Everything here is null-graceful: any failure means
// "no usable user token", and the caller falls back to the bot — a Lark hiccup
// must never break MeetKai chat.

// Default lifetimes from the Lark docs, used only if the response omits them:
// access ~2h, refresh ~30d.
const DEFAULT_ACCESS_TTL_S = 7140;
const DEFAULT_REFRESH_TTL_S = 2591940;
// Refresh this many ms BEFORE the access token actually expires, so a send
// never races the expiry boundary.
const EXPIRY_SKEW_MS = 120_000;

export interface StoredTokenFields {
  larkUserAccessToken?: string;
  larkRefreshToken?: string;
  larkTokenExpiresAt?: Date;
  larkRefreshExpiresAt?: Date;
}

// Encrypt a fresh (access, refresh) pair into the columns to persist. Returns
// {} — meaning "store nothing" — if encryption is disabled or either token is
// missing, so the caller simply doesn't write token fields (bot fallback).
// Used both at login (routes/lark.ts) and after a refresh below.
export function buildStoredTokenFields(
  accessToken?: string,
  refreshToken?: string,
  expiresIn?: number,
  refreshExpiresIn?: number,
): StoredTokenFields {
  if (!accessToken || !refreshToken || !tokenCryptoEnabled()) return {};
  const enc = encryptToken(accessToken);
  const encR = encryptToken(refreshToken);
  if (!enc || !encR) return {};
  const now = Date.now();
  return {
    larkUserAccessToken: enc,
    larkRefreshToken: encR,
    larkTokenExpiresAt: new Date(now + (expiresIn ?? DEFAULT_ACCESS_TTL_S) * 1000),
    larkRefreshExpiresAt: new Date(now + (refreshExpiresIn ?? DEFAULT_REFRESH_TTL_S) * 1000),
  };
}

// Return a usable user_access_token for this user, refreshing if needed, or
// null if none can be obtained (no tokens stored, refresh token dead, or Lark
// error). The columns are globally omitted (lib/prisma.ts) — the explicit
// `select` here is what opts back in to read them.
export async function getValidUserToken(userId: string): Promise<string | null> {
  if (!tokenCryptoEnabled()) return null;
  const prisma = getPrisma();
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      larkUserAccessToken: true,
      larkRefreshToken: true,
      larkTokenExpiresAt: true,
      larkRefreshExpiresAt: true,
    },
  });
  if (!u || !u.larkUserAccessToken) return null;

  const now = Date.now();
  // Still comfortably valid → use it as-is.
  if (u.larkTokenExpiresAt && u.larkTokenExpiresAt.getTime() > now + EXPIRY_SKEW_MS) {
    const tok = decryptToken(u.larkUserAccessToken);
    if (tok) return tok;
    // undecryptable (e.g. key rotated) → fall through to refresh
  }

  // Need a refresh. If the refresh token is itself dead, give up (→ bot).
  if (!u.larkRefreshToken) return null;
  if (u.larkRefreshExpiresAt && u.larkRefreshExpiresAt.getTime() <= now) return null;
  const refreshTok = decryptToken(u.larkRefreshToken);
  if (!refreshTok) return null;
  return refreshUserToken(userId, refreshTok);
}

// Exchange a refresh token for a new access token, persisting the ROTATED
// (access, refresh) pair Lark returns. On a hard failure (refresh token
// rejected) it clears the stored tokens so we stop retrying and fall back to
// the bot cleanly. Returns the new access token or null.
async function refreshUserToken(userId: string, refreshToken: string): Promise<string | null> {
  const appToken = await getAppToken();
  if (!appToken) return null;
  const prisma = getPrisma();
  try {
    const res = await fetch(`${LARK_OPENAPI_BASE}/authen/v1/refresh_access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${appToken}` },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    const j: any = await res.json();
    const d = j?.data ?? {};
    if (j?.code !== 0 || !d.access_token) {
      console.error('[larkUserToken] refresh failed:', j?.code, j?.msg);
      // Dead refresh token — clear so getValidUserToken stops trying.
      await prisma.user
        .update({
          where: { id: userId },
          data: {
            larkUserAccessToken: null,
            larkRefreshToken: null,
            larkTokenExpiresAt: null,
            larkRefreshExpiresAt: null,
          },
        })
        .catch(() => {});
      return null;
    }
    // Lark rotates the refresh token on every refresh — persist BOTH new values.
    const fields = buildStoredTokenFields(d.access_token, d.refresh_token, d.expires_in, d.refresh_expires_in);
    if (Object.keys(fields).length) {
      await prisma.user.update({ where: { id: userId }, data: fields }).catch(() => {});
    }
    return d.access_token;
  } catch (e) {
    console.error('[larkUserToken] refresh error:', e);
    return null;
  }
}
