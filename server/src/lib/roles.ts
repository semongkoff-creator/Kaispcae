import { PrismaClient } from '@prisma/client';
import { Role } from '@virtualmeet/shared';

// The one place a per-room Role gets resolved from DB data (owner match,
// RoomMember grant, or a global accountRole='admin' account — see
// shared/permissions.ts's AccountRole doc comment). Previously duplicated
// nearly verbatim across chat.ts, teleport.ts, rtcHandler.ts,
// recordingHandler.ts, and recordings.ts; consolidated here specifically
// because adding the accountRole check to all five separately would have
// made it easy to miss one. roomHandler.ts's own in-memory
// RoomAdminState-based getRole() is NOT replaced by this — it's a
// synchronous, per-socket-connection cache for the hot movement/action path
// and elevates global admins into that cache directly at JOIN_ROOM instead
// (see its own comment).
export async function resolveRoomRole(prisma: PrismaClient, userId: string, roomId: string, ownerId: string, roomOrganizationId: string | undefined): Promise<Role> {
  if (userId === ownerId) return 'owner';

  const [user, member] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { accountRole: true, memberVerifiedAt: true, workspaceRole: true, organizationId: true } }),
    prisma.roomMember.findUnique({ where: { userId_roomId: { userId, roomId } } }),
  ]);

  if (member?.role === 'admin') return 'admin';
  // Multi-tenant Fase 3 — accountRole is a single global flag with no org
  // dimension of its own; without this check a workspace admin from ANY
  // org would auto-elevate to room-admin in EVERY room, including another
  // company's, with zero RoomMember grant needed.
  if (user?.accountRole === 'admin' && user.organizationId === roomOrganizationId) return 'admin';
  if (member?.role === 'staff') return 'staff';
  // Self-registered account nobody has vouched for — POST /auth/register is
  // public, so a plain manual account is otherwise indistinguishable from a
  // stranger who found the URL. Every path where someone WITH authority
  // approved the account (org invite, invite-gated Google login, founding a
  // new org, the first-ever bootstrap account) stamps memberVerifiedAt, and
  // an admin can stamp it later via PATCH /admin/members/:userId. Same rule
  // roomHandler.ts's in-memory getRole() applies socket-side — kept in sync
  // so a REST route and a socket handler never disagree about the same
  // account's tier. Only the DEFAULT: an explicit room-level grant
  // (admin/staff, checked above) or workspace promotion always wins.
  if (!user?.memberVerifiedAt && user?.workspaceRole !== 'admin') return 'guest';
  return 'member';
}
