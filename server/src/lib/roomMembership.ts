import { PrismaClient } from '@prisma/client';

// Room entry — a separate question from room ROLE.
//
// resolveRoomRole (lib/roles.ts) answers "what may this person DO here" and
// returns 'member' for anyone authenticated, member row or not. That is fine
// for action gating but it is not an entry check: it never says no. Approval
// needs a gate that can, so it lives here rather than being bolted onto the
// role resolver, where a default-allow would be easy to reintroduce.

export type MembershipStatus = 'active' | 'pending' | 'rejected';

export interface EntryDecision {
  allowed: boolean;
  // 'pending'  — waiting on an admin
  // 'rejected' — an admin said no; re-requesting is blocked
  // 'open'     — the room takes walk-ins
  // 'member'   — has an approved membership row
  // 'privileged' — owner or a global admin account
  reason: 'open' | 'member' | 'privileged' | 'pending' | 'rejected' | 'needs-request';
}

// Owner and global admins always get in: the owner cannot be locked out of
// their own room, and a global admin is already elevated everywhere (see
// shared/permissions.ts's AccountRole).
export async function resolveEntry(
  prisma: PrismaClient,
  room: { id: string; ownerId: string; requiresApproval: boolean },
  userId: string,
): Promise<EntryDecision> {
  if (userId === room.ownerId) return { allowed: true, reason: 'privileged' };

  const [user, member] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { accountRole: true } }),
    prisma.roomMember.findUnique({ where: { userId_roomId: { userId, roomId: room.id } } }),
  ]);
  if (user?.accountRole === 'admin') return { allowed: true, reason: 'privileged' };

  // An approved membership row wins regardless of the room's current setting —
  // flipping approval on must not evict people who are already in.
  if (member?.status === 'active') return { allowed: true, reason: 'member' };
  if (member?.status === 'pending') return { allowed: false, reason: 'pending' };
  if (member?.status === 'rejected') return { allowed: false, reason: 'rejected' };

  if (!room.requiresApproval) return { allowed: true, reason: 'open' };
  return { allowed: false, reason: 'needs-request' };
}

export async function canEnterRoom(
  prisma: PrismaClient,
  room: { id: string; ownerId: string; requiresApproval: boolean },
  userId: string,
): Promise<boolean> {
  return (await resolveEntry(prisma, room, userId)).allowed;
}
