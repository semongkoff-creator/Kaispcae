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

async function importPunch(tenant: string, employeeId: string, creatorId: string, comment: string): Promise<{ ok: boolean; code?: number; msg?: string }> {
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
          comment,
        },
      ],
    }),
  });
  const json: any = await res.json();
  return { ok: json?.code === 0, code: json?.code, msg: json?.msg };
}

// Import a punch (Lark's shift rules decide whether it lands as check-in or
// check-out — the same endpoint for both, see A12 audit). Tries self-punch
// (creator = the user themselves) first; if Lark rejects that, retries with an
// admin creator id from env (LARK_ATTENDANCE_CREATOR_ID) when configured.
async function punchWithFallback(tenant: string, employeeId: string, comment: string): Promise<boolean> {
  try {
    const first = await importPunch(tenant, employeeId, employeeId, comment);
    if (first.ok) return true;
    console.error('[attendance] punch (self creator) rejected:', first.code, first.msg);

    const adminCreator = getConfig().LARK_ATTENDANCE_CREATOR_ID;
    if (adminCreator && adminCreator !== employeeId) {
      const second = await importPunch(tenant, employeeId, adminCreator, comment);
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

    const ok = await punchWithFallback(tenant, employeeId, 'Auto check-in via MeetKai');
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

// ─── A12: checkout + bidirectional status ───────────────────────────────────

export interface AttendanceStatus {
  isLarkUser: boolean;
  checkedIn: boolean;
  checkInTime: number | null; // epoch seconds, from Lark
  checkedOut: boolean;
  checkOutTime: number | null;
  totalHours: number | null; // display-only (Lark computes the official value)
}

const EMPTY_STATUS: AttendanceStatus = {
  isLarkUser: false, checkedIn: false, checkInTime: null, checkedOut: false, checkOutTime: null, totalHours: null,
};

function wibDateCompact(): string {
  return wibToday().replace(/-/g, ''); // YYYYMMDD
}

function hoursBetween(inSec: number | null, outSec: number | null): number | null {
  if (inSec == null || outSec == null || outSec < inSec) return null;
  return Math.round(((outSec - inSec) / 3600) * 100) / 100;
}

async function ensureEmployeeId(
  tenant: string,
  u: { id: string; larkOpenId: string; larkUserId: string | null },
): Promise<string | null> {
  if (u.larkUserId) return u.larkUserId;
  const resolved = await resolveUserId(tenant, u.larkOpenId);
  if (resolved) {
    await getPrisma().user.update({ where: { id: u.id }, data: { larkUserId: resolved } }).catch(() => {});
  }
  return resolved;
}

// Read today's attendance from Lark — the source of truth for the UI. Reflects
// checkouts done in MeetKai AND directly in the Lark app. Needs scope
// attendance:task:readonly.
export async function getTodayAttendanceStatus(userId: string): Promise<AttendanceStatus> {
  try {
    const prisma = getPrisma();
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, larkOpenId: true, larkUserId: true },
    });
    if (!user?.larkOpenId) return EMPTY_STATUS;

    const cfg = getConfig();
    if (!cfg.LARK_APP_ID || !cfg.LARK_APP_SECRET) return { ...EMPTY_STATUS, isLarkUser: true };
    const tenant = await getTenantAccessToken(cfg.LARK_APP_ID, cfg.LARK_APP_SECRET);
    if (!tenant) return { ...EMPTY_STATUS, isLarkUser: true };

    const employeeId = await ensureEmployeeId(tenant, {
      id: user.id, larkOpenId: user.larkOpenId, larkUserId: user.larkUserId,
    });
    if (!employeeId) return { ...EMPTY_STATUS, isLarkUser: true };

    const day = Number(wibDateCompact());
    const res = await fetch(`${LARK_BASE}/attendance/v1/user_tasks/query?employee_type=employee_id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant}` },
      body: JSON.stringify({ user_ids: [employeeId], check_date_from: day, check_date_to: day }),
    });
    const json: any = await res.json();
    if (json?.code !== 0) {
      console.error('[attendance] user_tasks/query failed:', json?.code, json?.msg);
      return { ...EMPTY_STATUS, isLarkUser: true };
    }

    // Defensive parse: the day result carries check_in_record / check_out_record
    // (each with a `check_time` in seconds). Shapes vary slightly across Lark
    // versions, so dig for the records tolerantly.
    const result = json?.data?.user_task_results?.[0];
    const rec = Array.isArray(result?.records) ? result.records[0] : result?.records ?? result;
    const inTime = rec?.check_in_record?.check_time;
    const outTime = rec?.check_out_record?.check_time;
    // [attendance-diag] TEMPORARY — verify the real response shape against the
    // defensive parse above during the VPS test, then remove.
    console.log('[attendance-diag] user_tasks/query result:', JSON.stringify(result ?? json?.data ?? {}).slice(0, 800));
    const checkInTime = inTime ? Number(inTime) : null;
    const checkOutTime = outTime ? Number(outTime) : null;
    return {
      isLarkUser: true,
      checkedIn: checkInTime != null,
      checkInTime,
      checkedOut: checkOutTime != null,
      checkOutTime,
      totalHours: hoursBetween(checkInTime, checkOutTime),
    };
  } catch (e) {
    console.error('[attendance] getTodayAttendanceStatus error:', e);
    return { ...EMPTY_STATUS, isLarkUser: true };
  }
}

export type CheckoutOutcome =
  | { ok: true; status: AttendanceStatus }
  | { ok: false; reason: 'not_lark' | 'not_checked_in' | 'already_checked_out' | 'lark_error'; status: AttendanceStatus };

// Record a check-out punch from MeetKai. Idempotent: refuses if not checked in,
// or if already checked out (per Lark's live status OR the local same-day
// marker). Never double-punches.
export async function checkOut(userId: string): Promise<CheckoutOutcome> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, larkOpenId: true, larkUserId: true, lastAttendanceCheckOutDate: true },
  });
  if (!user?.larkOpenId) return { ok: false, reason: 'not_lark', status: EMPTY_STATUS };

  const today = wibToday();
  const status = await getTodayAttendanceStatus(userId);
  if (!status.checkedIn) return { ok: false, reason: 'not_checked_in', status };
  if (status.checkedOut || user.lastAttendanceCheckOutDate === today) {
    return { ok: false, reason: 'already_checked_out', status };
  }

  const cfg = getConfig();
  const tenant = cfg.LARK_APP_ID && cfg.LARK_APP_SECRET
    ? await getTenantAccessToken(cfg.LARK_APP_ID, cfg.LARK_APP_SECRET)
    : null;
  const employeeId = tenant
    ? await ensureEmployeeId(tenant, { id: user.id, larkOpenId: user.larkOpenId, larkUserId: user.larkUserId })
    : null;
  if (!tenant || !employeeId) return { ok: false, reason: 'lark_error', status };

  const ok = await punchWithFallback(tenant, employeeId, 'Checkout via MeetKai');
  if (!ok) return { ok: false, reason: 'lark_error', status };

  await prisma.user.update({ where: { id: user.id }, data: { lastAttendanceCheckOutDate: today } }).catch(() => {});
  console.log(`[attendance] checkout recorded for user ${userId} (${today} WIB)`);

  // Re-read so the response shows the new checkout. Lark may lag turning the
  // punch into a result, so fall back to "now" if it's not visible yet.
  const after = await getTodayAttendanceStatus(userId);
  if (after.checkedOut) return { ok: true, status: after };
  const now = Math.floor(Date.now() / 1000);
  return {
    ok: true,
    status: { ...after, checkedOut: true, checkOutTime: now, totalHours: hoursBetween(after.checkInTime, now) },
  };
}
