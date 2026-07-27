import { getPrisma } from './prisma';
import { getConfig } from '../config';

// A2 — auto check-in to Lark Attendance (the real HR feature, not Lark Base).
// MeetKai is ONLY a trigger; shifts/leave/reports all live in Lark. This module
// imports a punch "flow record" which Lark's attendance engine then evaluates
// against the user's work group + shift.

const LARK_BASE = 'https://open.larksuite.com/open-apis';

// Kaitech's business timezone — the "day" boundary for idempotency. Fixed to
// WIB deliberately (don't mix with per-user timezone) so "already checked in
// today" is unambiguous.
const ATTENDANCE_TZ = 'Asia/Jakarta';
function wibToday(): string {
  // 'en-CA' formats as YYYY-MM-DD.
  return new Date().toLocaleDateString('en-CA', { timeZone: ATTENDANCE_TZ });
}

// tenant_access_token: app-level token used for both contact lookups and the
// attendance write. Cached until shortly before expiry.
let tenantToken: { token: string; exp: number } | null = null;
async function getTenantAccessToken(appId: string, appSecret: string): Promise<string | null> {
  if (tenantToken && tenantToken.exp > Date.now() + 30_000) return tenantToken.token;
  try {
    const res = await fetch(`${LARK_BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const json: any = await res.json();
    if (!json?.tenant_access_token) {
      console.error('[attendance] tenant_access_token failed:', json?.code, json?.msg);
      return null;
    }
    tenantToken = { token: json.tenant_access_token, exp: Date.now() + (json.expire ?? 7200) * 1000 };
    return tenantToken.token;
  } catch (e) {
    console.error('[attendance] tenant_access_token error:', e);
    return null;
  }
}

// open_id -> user_id (employee_id) via the contact API. Needs scope
// contact:user.employee_id:readonly. Used only when we don't already have the
// user_id stored (login didn't return it).
async function resolveUserId(tenant: string, openId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${LARK_BASE}/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`,
      { headers: { Authorization: `Bearer ${tenant}` } },
    );
    const json: any = await res.json();
    const uid = json?.data?.user?.user_id;
    if (!uid) {
      console.error('[attendance] resolveUserId got no user_id:', json?.code, json?.msg);
      return null;
    }
    return uid as string;
  } catch (e) {
    console.error('[attendance] resolveUserId error:', e);
    return null;
  }
}

async function importPunch(tenant: string, employeeId: string, creatorId: string): Promise<{ ok: boolean; code?: number; msg?: string }> {
  const res = await fetch(`${LARK_BASE}/attendance/v1/user_flows/batch_create?employee_type=employee_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant}` },
    body: JSON.stringify({
      flow_records: [
        {
          user_id: employeeId,
          creator_id: creatorId,
          location_name: 'MeetKai',
          check_time: String(Math.floor(Date.now() / 1000)),
          comment: 'Auto check-in via MeetKai',
        },
      ],
    }),
  });
  const json: any = await res.json();
  return { ok: json?.code === 0, code: json?.code, msg: json?.msg };
}

// Record a check-in punch. Tries self-punch (creator_id = the user's own
// employee_id) first per the agreed plan; if Lark rejects that, retries with an
// admin creator id from env (LARK_ATTENDANCE_CREATOR_ID) when configured.
async function punchCheckIn(tenant: string, employeeId: string): Promise<boolean> {
  try {
    const first = await importPunch(tenant, employeeId, employeeId);
    if (first.ok) return true;
    console.error('[attendance] punch (self creator) rejected:', first.code, first.msg);

    const adminCreator = getConfig().LARK_ATTENDANCE_CREATOR_ID;
    if (adminCreator && adminCreator !== employeeId) {
      const second = await importPunch(tenant, employeeId, adminCreator);
      if (second.ok) return true;
      console.error('[attendance] punch (admin creator) rejected:', second.code, second.msg);
    }
    return false;
  } catch (e) {
    console.error('[attendance] punch error:', e);
    return false;
  }
}

// Concurrency guard: multiple tabs can hit /auth/me at once; without this they
// could all punch in the window before the date marker is written. Per-process
// only — the persisted date marker is the real idempotency guarantee.
const inFlight = new Set<string>();

// THE trigger. Called fire-and-forget from GET /auth/me (which every client
// hits on load, including 30-day auto-login — NOT just OAuth). Never throws,
// never blocks the caller, never marks success unless Lark actually accepted
// the punch (so a failure retries on the next request).
export async function ensureCheckedInToday(userId: string): Promise<void> {
  if (inFlight.has(userId)) return;
  inFlight.add(userId);
  try {
    const prisma = getPrisma();
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, larkOpenId: true, larkUserId: true, lastAttendanceCheckInDate: true },
    });
    if (!user?.larkOpenId) return; // manual-login users don't punch
    const today = wibToday();
    if (user.lastAttendanceCheckInDate === today) return; // already done today — idempotent

    const cfg = getConfig();
    if (!cfg.LARK_APP_ID || !cfg.LARK_APP_SECRET) {
      console.error('[attendance] Lark not configured — skipping check-in');
      return;
    }
    const tenant = await getTenantAccessToken(cfg.LARK_APP_ID, cfg.LARK_APP_SECRET);
    if (!tenant) return;

    // Need the employee_id; resolve + persist once if we don't have it yet.
    let employeeId = user.larkUserId;
    if (!employeeId) {
      employeeId = await resolveUserId(tenant, user.larkOpenId);
      if (employeeId) {
        await prisma.user.update({ where: { id: user.id }, data: { larkUserId: employeeId } }).catch(() => {});
      }
    }
    if (!employeeId) {
      console.error(`[attendance] no employee_id for user ${userId} — cannot check in`);
      return;
    }

    const ok = await punchCheckIn(tenant, employeeId);
    if (ok) {
      // Mark ONLY on real success, so a failed punch retries next request.
      await prisma.user.update({ where: { id: user.id }, data: { lastAttendanceCheckInDate: today } });
      console.log(`[attendance] check-in recorded for user ${userId} (${today} WIB)`);
    } else {
      console.error(`[attendance] check-in FAILED for user ${userId} — NOT marking, will retry`);
    }
  } catch (e) {
    console.error('[attendance] ensureCheckedInToday error:', e);
  } finally {
    inFlight.delete(userId);
  }
}
