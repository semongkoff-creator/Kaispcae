import { getConfig } from '../config';

// A3 — activity logging to a Lark Base (Bitable) table. Setting up the
// `activity_log` table is a MANUAL step in the Lark UI, the app doesn't have
// the bitable scope yet, and there's no app_token/table_id configured. So this
// is a GUARDED no-op: it warns once and returns until
// LARK_BITABLE_APP_TOKEN + LARK_BITABLE_ACTIVITY_TABLE_ID are set. The core
// Focus/Public feature must never fail because logging isn't ready — every
// path here is wrapped and non-throwing.

const LARK_BASE = 'https://open.larksuite.com/open-apis';
let warnedUnconfigured = false;

export interface ActivityLog {
  eventType: string; // 'focus_start' | 'focus_end' | ...
  userId: string;
  room: string;
  detail?: Record<string, unknown>;
}

export async function logActivity(entry: ActivityLog): Promise<void> {
  try {
    const cfg = getConfig();
    if (!cfg.LARK_BITABLE_APP_TOKEN || !cfg.LARK_BITABLE_ACTIVITY_TABLE_ID || !cfg.LARK_APP_ID || !cfg.LARK_APP_SECRET) {
      if (!warnedUnconfigured) {
        console.warn('[larkBase] activity_log belum siap (LARK_BITABLE_APP_TOKEN / table id belum diset) — pencatatan dilewati; fitur inti tetap jalan.');
        warnedUnconfigured = true;
      }
      return;
    }

    // Real path, active only once the table + scope + config exist.
    const tokRes = await fetch(`${LARK_BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: cfg.LARK_APP_ID, app_secret: cfg.LARK_APP_SECRET }),
    });
    const tj: any = await tokRes.json();
    const tenant = tj?.tenant_access_token;
    if (!tenant) { console.warn('[larkBase] no tenant token — skip'); return; }

    const res = await fetch(
      `${LARK_BASE}/bitable/v1/apps/${cfg.LARK_BITABLE_APP_TOKEN}/tables/${cfg.LARK_BITABLE_ACTIVITY_TABLE_ID}/records`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant}` },
        body: JSON.stringify({
          fields: {
            event_type: entry.eventType,
            user: entry.userId,
            room: entry.room,
            timestamp: Date.now(),
            detail: JSON.stringify(entry.detail ?? {}),
          },
        }),
      },
    );
    const rj: any = await res.json();
    if (rj?.code !== 0) console.warn('[larkBase] record create failed:', rj?.code, rj?.msg);
  } catch (e) {
    console.warn('[larkBase] logActivity error (non-fatal):', e);
  }
}
