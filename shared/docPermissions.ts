// Permission matrix for the Docs module. Shared by the client (cosmetic
// gating) AND the server (authoritative re-check on every request and on
// every realtime edit). The server is the source of truth.
//
// Same four-role ladder as Base (owner → editor → commenter → viewer) but a
// SEPARATE action vocabulary: a doc's verbs are not a base's verbs, and
// collapsing them would make one module's changes silently redefine the
// other's permissions.
//
// The rule that outranks everything here: a workspace admin does NOT get to
// read a private doc. Admin power over docs is limited to `docs:takeover`
// (shared/workspacePermissions.ts), which is overt — audited and it notifies
// the previous owner. Nothing in this file grants an admin a read path.

export type DocRole = 'owner' | 'editor' | 'commenter' | 'viewer';

const ROLE_ORDER: DocRole[] = ['viewer', 'commenter', 'editor', 'owner'];

export function docRoleAtLeast(role: DocRole | undefined, min: DocRole): boolean {
  if (!role) return false;
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);
}

export type DocAction =
  | 'doc:read'
  | 'doc:edit'          // apply Yjs updates to the content
  | 'doc:rename'
  | 'doc:comment'
  | 'doc:resolveComment'
  | 'doc:createVersion'
  | 'doc:restoreVersion'
  | 'doc:share'         // create/revoke share links, invite people
  | 'doc:export'        // PDF / Markdown / copy — see allowCopy note below
  | 'doc:manageAccess'  // change someone's role
  | 'doc:transfer'
  | 'doc:delete';

const OWNER_ONLY: DocAction[] = ['doc:manageAccess', 'doc:transfer', 'doc:delete'];

const ACTION_MIN_ROLE: Record<Exclude<DocAction, 'doc:manageAccess' | 'doc:transfer' | 'doc:delete'>, DocRole> = {
  'doc:read': 'viewer',
  'doc:edit': 'editor',
  'doc:rename': 'editor',
  'doc:comment': 'commenter',
  'doc:resolveComment': 'commenter',
  'doc:createVersion': 'editor',
  'doc:restoreVersion': 'editor',
  'doc:share': 'editor',
  'doc:export': 'viewer',
};

export interface DocCtx {
  role: DocRole | undefined;
  // Set for link-based access with "allow copy" turned off. This is an
  // affordance switch, NOT a security control — see canDoc() below.
  allowCopy?: boolean;
}

export function canDoc(action: DocAction, ctx: DocCtx): boolean {
  // allowCopy=false hides export/copy buttons. Be honest about what this is:
  // anyone who can READ the text can still select it, screenshot it, or read
  // it straight out of the API response. It deters casual copying; it does
  // not protect the content. Never describe it as security.
  if (action === 'doc:export' && ctx.allowCopy === false) return false;
  if (OWNER_ONLY.includes(action)) return ctx.role === 'owner';
  return docRoleAtLeast(ctx.role, ACTION_MIN_ROLE[action as keyof typeof ACTION_MIN_ROLE]);
}

export const DOC_ROLE_LABELS: Record<DocRole, string> = {
  owner: 'Pemilik',
  editor: 'Editor',
  commenter: 'Komentator',
  viewer: 'Pengamat',
};
