import { getConfig } from '../config';
import { getTenantToken, LARK_OPENAPI_BASE } from './larkToken';

// A9 — Lark Approval "Cuti" (leave). The approval uses Lark's native
// leaveGroupV2 widget; the exact create/read value shape was captured from a
// real instance (see the field spec below). Lark is the source of truth — we
// never store leave state locally. All functions null/[]-graceful.
//
// leaveGroupV2 value shape (verified against a live instance):
//   { name, start(ISO-UTC), end(ISO-UTC), unit(DAY|HALF_DAY|HOUR),
//     interval(string), reason, timezoneOffset(minutes) }

export interface LeaveInput {
  name: string;          // leave type, must match a configured option
  start: string;         // ISO UTC, e.g. 2026-03-25T17:00:00Z
  end: string;           // ISO UTC
  unit: string;          // DAY | HALF_DAY | HOUR
  interval: number;      // duration count in `unit`s
  reason: string;
  timezoneOffset: number; // minutes, e.g. WIB = -420
}

export interface LeaveRecord {
  instanceCode: string;
  status: string;        // PENDING | APPROVED | REJECTED | CANCELED | ...
  name: string | null;
  start: string | null;
  end: string | null;
  unit: string | null;
  reason: string | null;
  submittedAt: number | null;
}

export function leaveApprovalCode(): string {
  return getConfig().LARK_APPROVAL_CODE_CUTI ?? '';
}

export function approvalEnabled(): boolean {
  const c = getConfig();
  return !!(c.LARK_APPROVAL_CODE_CUTI && c.LARK_APP_ID && c.LARK_APP_SECRET);
}

async function token(): Promise<string | null> {
  return getTenantToken();
}

// Parse an instance's leaveGroupV2 form value out of the API's JSON-string form.
function parseLeaveForm(formStr: unknown): Partial<LeaveRecord> {
  try {
    const arr = typeof formStr === 'string' ? JSON.parse(formStr) : formStr;
    const w = Array.isArray(arr) ? arr.find((x: any) => x?.type === 'leaveGroupV2') : null;
    const v = w?.value ?? {};
    return { name: v.name ?? null, start: v.start ?? null, end: v.end ?? null, unit: v.unit ?? null, reason: v.reason ?? null };
  } catch {
    return {};
  }
}

// Fetch recent instance details for this approval, cached briefly so the
// history + leave-type dropdown don't hammer the API. Bounded page size.
let cache: { at: number; rows: (LeaveRecord & { openId: string | null })[] } | null = null;
const CACHE_TTL_MS = 20_000;

async function fetchRecent(): Promise<(LeaveRecord & { openId: string | null })[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  const t = await token();
  const code = leaveApprovalCode();
  if (!t || !code) return [];

  const end = Date.now();
  const start = end - 180 * 24 * 3600 * 1000;
  const u = new URL(`${LARK_OPENAPI_BASE}/approval/v4/instances`);
  u.searchParams.set('approval_code', code);
  u.searchParams.set('start_time', String(start));
  u.searchParams.set('end_time', String(end));
  u.searchParams.set('page_size', '50');
  const lr = await fetch(u, { headers: { Authorization: `Bearer ${t}` } });
  const lj: any = await lr.json();
  if (lj?.code !== 0) {
    console.error('[larkApproval] list failed:', lj?.code, lj?.msg);
    return [];
  }
  const codes: string[] = lj.data?.instance_code_list ?? [];

  const rows = await Promise.all(
    codes.slice(0, 50).map(async (ic) => {
      try {
        const dr = await fetch(`${LARK_OPENAPI_BASE}/approval/v4/instances/${encodeURIComponent(ic)}`, {
          headers: { Authorization: `Bearer ${t}` },
        });
        const dj: any = await dr.json();
        if (dj?.code !== 0) return null;
        const d = dj.data ?? {};
        const parsed = parseLeaveForm(d.form);
        return {
          instanceCode: ic,
          status: d.status ?? 'PENDING',
          openId: d.open_id ?? null,
          submittedAt: typeof d.start_time === 'string' ? Number(d.start_time) : (d.start_time ?? null),
          name: parsed.name ?? null,
          start: parsed.start ?? null,
          end: parsed.end ?? null,
          unit: parsed.unit ?? null,
          reason: parsed.reason ?? null,
        } as LeaveRecord & { openId: string | null };
      } catch {
        return null;
      }
    }),
  );
  const clean = rows.filter(Boolean) as (LeaveRecord & { openId: string | null })[];
  cache = { at: Date.now(), rows: clean };
  return clean;
}

// This user's leave requests (newest first), read live from Lark.
export async function listMyLeaves(openId: string): Promise<LeaveRecord[]> {
  const rows = await fetchRecent();
  return rows
    .filter((r) => r.openId === openId)
    .sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0))
    .map(({ openId: _o, ...r }) => r);
}

// Distinct leave-type names seen on this approval's instances — the dropdown
// options (Option A: derived live from Lark, not hardcoded). Falls back to a
// single sensible default if none exist yet.
export async function getLeaveTypes(): Promise<string[]> {
  const rows = await fetchRecent();
  const names = Array.from(new Set(rows.map((r) => r.name).filter((n): n is string => !!n)));
  return names.length ? names : ['Annual leave'];
}

// Create a leave request as the given user (open_id).
export async function createLeaveInstance(openId: string, input: LeaveInput): Promise<string | null> {
  const t = await token();
  const code = leaveApprovalCode();
  if (!t || !code) return null;
  const form = JSON.stringify([
    {
      id: 'widgetLeaveGroupV2',
      type: 'leaveGroupV2',
      ext: { widgetLeaveRuleType: 0 },
      value: {
        name: input.name,
        start: input.start,
        end: input.end,
        unit: input.unit,
        interval: String(input.interval),
        reason: input.reason,
        timezoneOffset: input.timezoneOffset,
      },
    },
  ]);
  const res = await fetch(`${LARK_OPENAPI_BASE}/approval/v4/instances`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ approval_code: code, open_id: openId, form }),
  });
  const j: any = await res.json();
  if (j?.code !== 0) {
    console.error('[larkApproval] create failed:', j?.code, j?.msg);
    return null;
  }
  cache = null; // new instance — invalidate so the history reflects it
  return j?.data?.instance_code ?? null;
}

// Subscribe the app to this approval's events (once at boot) so status-change
// events start flowing over the persistent connection. Best-effort/idempotent.
export async function subscribeLeaveApproval(): Promise<void> {
  const t = await token();
  const code = leaveApprovalCode();
  if (!t || !code) return;
  try {
    const res = await fetch(`${LARK_OPENAPI_BASE}/approval/v4/approvals/${encodeURIComponent(code)}/subscribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    });
    const j: any = await res.json();
    // code 0 = subscribed; a "already subscribed" code is fine too.
    if (j?.code !== 0) console.warn('[larkApproval] subscribe:', j?.code, j?.msg);
    else console.log('[larkApproval] subscribed to Cuti approval events');
  } catch (e) {
    console.error('[larkApproval] subscribe error:', e);
  }
}
