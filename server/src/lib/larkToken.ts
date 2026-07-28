import { getConfig } from '../config';

// Shared cached tenant_access_token for app-level Lark API calls (VC, etc.).
// (larkAttendance/larkBase keep their own copies for now; new code uses this.)
export const LARK_OPENAPI_BASE = 'https://open.larksuite.com/open-apis';

let cached: { token: string; exp: number } | null = null;

export async function getTenantToken(): Promise<string | null> {
  const cfg = getConfig();
  if (!cfg.LARK_APP_ID || !cfg.LARK_APP_SECRET) return null;
  if (cached && cached.exp > Date.now() + 30_000) return cached.token;
  try {
    const res = await fetch(`${LARK_OPENAPI_BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: cfg.LARK_APP_ID, app_secret: cfg.LARK_APP_SECRET }),
    });
    const j: any = await res.json();
    if (!j?.tenant_access_token) { console.error('[lark] tenant token failed:', j?.code, j?.msg); return null; }
    cached = { token: j.tenant_access_token, exp: Date.now() + (j.expire ?? 7200) * 1000 };
    return cached.token;
  } catch (e) {
    console.error('[lark] tenant token error:', e);
    return null;
  }
}
