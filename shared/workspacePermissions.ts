// Permission matrix for WORKSPACE-level (organisation-wide) configuration.
// Shared by the client (cosmetic gating — what to render) AND the server
// (authoritative re-check on every request). The server is the source of
// truth; the client copy only decides what to show or hide.
//
// This is the THIRD, independent permission layer in this repo. Do not
// conflate them:
//
//   permissions.ts        → Role       owner|admin|staff|member|guest  (per ROOM)
//   basePermissions.ts    → BaseRole   owner|editor|commenter|viewer   (per BASE)
//   workspacePermissions.ts → WorkspaceRole admin|member               (per WORKSPACE)
//
// The load-bearing rule, and the reason this file exists at all:
//
//   A workspace role grants the power to CONFIGURE and to TAKE OVER.
//   It NEVER grants the power to READ someone's private resource content.
//
// An `admin` cannot read a member's private doc or base just by being admin.
// If they need it, the only path is an overt takeover, which is written to
// the audit log AND notifies the previous owner. There is no silent access.
//
// The one deliberate exception is attendance data: an admin is *supposed* to
// see everyone's attendance — that is the product's purpose. It is still
// audit-logged: we record which admin looked at whose data.

export type WorkspaceRole = 'admin' | 'member';

export type WorkspaceAction =
  // ── org membership ──
  | 'workspace:manageMembers'      // invite, deactivate, set workspace role, set dept/manager
  | 'workspace:viewAuditLog'
  // ── attendance config ──
  | 'attendance:manageShifts'      // shifts, work hours, grace, overtime rules, geofence, IP
  | 'attendance:manageLeaveTypes'  // leave types, quotas, holidays
  | 'attendance:viewAll'           // read anyone's attendance (audit-logged; see note above)
  | 'attendance:editRecord'        // edit anyone's record — reason REQUIRED + audit-logged
  | 'attendance:approve'           // approve/reject leave + corrections
  | 'attendance:exportReports'
  // ── calendar config ──
  | 'calendar:manageTeamCalendars' // create/delete TEAM calendars (personal ones are free)
  | 'calendar:manageRooms'         // meeting rooms: add, capacity, who may book
  | 'calendar:managePolicy'        // max booking duration, how far ahead
  | 'calendar:manageAnyBooking'    // view/cancel anyone's room booking
  // ── docs config ──
  | 'docs:manageTemplates'
  | 'docs:managePolicy'            // public share links allowed? max expiry? password required?
  | 'docs:takeover'                // overt ownership takeover — audited + notifies old owner
  // ── base config (WorkspacePolicy share-link limits; Base module removed in
  //    A7 but the shared policy row + its Docs fields remain) ──
  | 'base:managePolicy';           // public share links allowed? export limits?

// Every action above is admin-only today. This is kept as an explicit map
// rather than a bare `role === 'admin'` so that (a) the full surface of
// admin power is greppable in ONE place, and (b) when a manager/approver
// tier lands (Attendance needs it for delegated approvals), only this map
// changes — no call sites do.
const ACTION_ROLE: Record<WorkspaceAction, WorkspaceRole> = {
  'workspace:manageMembers': 'admin',
  'workspace:viewAuditLog': 'admin',
  'attendance:manageShifts': 'admin',
  'attendance:manageLeaveTypes': 'admin',
  'attendance:viewAll': 'admin',
  'attendance:editRecord': 'admin',
  'attendance:approve': 'admin',
  'attendance:exportReports': 'admin',
  'calendar:manageTeamCalendars': 'admin',
  'calendar:manageRooms': 'admin',
  'calendar:managePolicy': 'admin',
  'calendar:manageAnyBooking': 'admin',
  'docs:manageTemplates': 'admin',
  'docs:managePolicy': 'admin',
  'docs:takeover': 'admin',
  'base:managePolicy': 'admin',
};

export interface WorkspaceCtx {
  workspaceRole: WorkspaceRole | undefined;
}

// The single gate for workspace-level actions. Every /admin affordance and
// every /api/admin/* route asks this — do not spread `workspaceRole === 'admin'`
// around the codebase.
export function canWorkspace(action: WorkspaceAction, ctx: WorkspaceCtx): boolean {
  return ctx.workspaceRole === ACTION_ROLE[action];
}

// Every action a workspace admin has. Used by the audit-log viewer's filter
// and by tests that must enumerate the admin surface.
export const WORKSPACE_ACTIONS = Object.keys(ACTION_ROLE) as WorkspaceAction[];

export const WORKSPACE_ROLE_LABELS: Record<WorkspaceRole, string> = {
  admin: 'Admin',
  member: 'Anggota',
};
