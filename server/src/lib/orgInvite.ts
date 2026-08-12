import { PrismaClient } from '@prisma/client';

// Fase 5 (org-resolution foundation) — the OrgInvite table has existed
// since Fase 1's org_foundation migration but was never wired to any
// route: every signup hardcoded
// DEFAULT_ORG_ID because nothing else could resolve which org a new
// account belonged to. This is the shared lookup both routes/orgInvite.ts
// (manual accept) and routes/google.ts (Google login) use to answer that.

export const ORG_INVITE_TTL_MS = 7 * 24 * 3600_000; // 7 days

// Same fail-closed shape as orgScope.ts's findRoomInOrg/findUserInOrg —
// "expired", "already accepted", and "never existed" are indistinguishable
// to the caller, all just null. There's no cross-tenant confirmation risk
// here the way there is for a room/user id (a token IS the secret, not a
// guessable id), but treating every non-usable state uniformly keeps the
// call sites simple and avoids a second bug class (e.g. someone building a
// UI branch on "expired" vs "not found" and getting it wrong).
export async function resolvePendingInvite(prisma: PrismaClient, token: string) {
  const invite = await prisma.orgInvite.findUnique({
    where: { token },
    include: { organization: { select: { name: true } } },
  });
  if (!invite || invite.status !== 'pending' || invite.expiresAt < new Date()) return null;
  return invite;
}

export async function markInviteAccepted(prisma: PrismaClient, inviteId: string): Promise<void> {
  await prisma.orgInvite.update({ where: { id: inviteId }, data: { status: 'accepted', acceptedAt: new Date() } });
}

// OrgInvite.role is deliberately its own small vocabulary (see its schema
// doc comment) rather than reusing accountRole/workspaceRole's strings
// directly — this is the one place that translates it, mirroring exactly
// how routes/auth.ts's register route bootstraps the very first-ever
// account: 'admin' gets both the workspace-admin AND the account-wide
// room-creation role, everyone else gets the ordinary member defaults.
export function accountFieldsForInviteRole(role: string): { accountRole: string; workspaceRole: string } {
  return role === 'admin' ? { accountRole: 'admin', workspaceRole: 'admin' } : { accountRole: 'user', workspaceRole: 'member' };
}
