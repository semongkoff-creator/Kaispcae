// Permission matrix for the Lark Base collaborative module. Shared by the
// client (cosmetic `can()` gating) AND the server (authoritative re-check on
// every request). The server is the source of truth — the client copy only
// decides what to show/hide.

export type BaseRole = 'owner' | 'editor' | 'commenter' | 'viewer';

const ROLE_ORDER: BaseRole[] = ['viewer', 'commenter', 'editor', 'owner'];

export function baseRoleAtLeast(role: BaseRole | undefined, min: BaseRole): boolean {
  if (!role) return false;
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);
}

export type BaseAction =
  | 'base:read'
  | 'record:create'
  | 'record:update'
  | 'record:delete'
  | 'field:create'
  | 'field:update'
  | 'field:delete'
  | 'view:create'        // collaborative view
  | 'view:editConfig'    // change a collaborative/locked view's filters/sort/group
  | 'view:lock'          // lock/unlock a view
  | 'view:createPersonal'
  | 'comment:create'
  | 'share:create'
  | 'export'
  | 'base:manageMembers'
  | 'base:transfer'
  | 'base:delete';

// Minimum role for the "graded" actions. The three base-admin actions below
// are owner-ONLY (not just "owner is high enough") and handled specially.
const ACTION_MIN_ROLE: Record<Exclude<BaseAction, 'base:manageMembers' | 'base:transfer' | 'base:delete'>, BaseRole> = {
  'base:read': 'viewer',
  'record:create': 'editor',
  'record:update': 'editor',
  'record:delete': 'editor',
  'field:create': 'editor',
  'field:update': 'editor',
  'field:delete': 'editor',
  'view:create': 'editor',
  'view:editConfig': 'editor',
  'view:lock': 'editor',
  'view:createPersonal': 'viewer', // anyone who can see the base can keep a private view
  'comment:create': 'commenter',
  'share:create': 'editor',
  'export': 'viewer',
};

const OWNER_ONLY: BaseAction[] = ['base:manageMembers', 'base:transfer', 'base:delete'];

export interface PermissionCtx {
  role: BaseRole | undefined;
}

// The single gate. Every UI affordance and every server mutation asks this.
export function can(action: BaseAction, ctx: PermissionCtx): boolean {
  if (OWNER_ONLY.includes(action)) return ctx.role === 'owner';
  return baseRoleAtLeast(ctx.role, ACTION_MIN_ROLE[action as keyof typeof ACTION_MIN_ROLE]);
}

// ─── Field-level access ─────────────────────────────────────────────
// A field may be restricted so roles below a threshold can't SEE it (server
// strips it from responses) or can't EDIT it (read-only). These live on the
// Field definition (optional).

export interface FieldAccess {
  hiddenBelowRole?: BaseRole; // e.g. 'owner' → only owner sees this field at all
  readOnlyBelowRole?: BaseRole; // e.g. 'editor' → commenter/viewer can't write it
}

export function canViewField(access: FieldAccess | undefined, role: BaseRole | undefined): boolean {
  if (!access?.hiddenBelowRole) return true;
  return baseRoleAtLeast(role, access.hiddenBelowRole);
}

export function canEditField(access: FieldAccess | undefined, role: BaseRole | undefined): boolean {
  if (!baseRoleAtLeast(role, 'editor')) return false; // must be editor+ to write anything
  if (!access?.readOnlyBelowRole) return true;
  return baseRoleAtLeast(role, access.readOnlyBelowRole);
}

// ─── Record-level access ────────────────────────────────────────────
// One simple rule: editors may only modify records whose `person` field
// equals themselves. Owner bypasses. `rule` is stored per-table.

export interface RecordEditRule {
  personFieldId: string; // the person field a record's "owner" is read from
}

export function canEditRecord(
  rule: RecordEditRule | undefined,
  role: BaseRole | undefined,
  userId: string,
  recordCells: Record<string, unknown>,
): boolean {
  if (role === 'owner') return true;
  if (!baseRoleAtLeast(role, 'editor')) return false;
  if (!rule) return true;
  return recordCells[rule.personFieldId] === userId;
}

export const BASE_ROLE_LABELS: Record<BaseRole, string> = {
  owner: 'Pemilik',
  editor: 'Editor',
  commenter: 'Komentator',
  viewer: 'Pengamat',
};
