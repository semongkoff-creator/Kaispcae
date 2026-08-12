import { PrismaClient } from '@prisma/client';
import { Role, roleAtLeast } from '@kaispace/shared';

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
  // 'restricted' — QA (Akses ruang checklist item 1) — room.restrictedAccess
  //   is on and this user doesn't hold a RoomMember row with role >=
  //   restrictedMinRole. Deliberately NOT the same as 'needs-request' —
  //   there is no self-service path out of this one; an admin has to grant
  //   the role directly (see routes/rooms.ts's room-access endpoints).
  // 'queue' — same as 'restricted', except room.queueEnabled is also on, so
  //   the client should show the "join the queue" form instead of a dead
  //   end (see lib/roomQueue.ts).
  // 'queue-active' — this user currently holds a 'called' or unexpired
  //   'active' RoomQueueEntry for this room: a session-scoped admission,
  //   separate from a real RoomMember role grant (see RoomQueueEntry's own
  //   doc comment for why it's not just a temporary role).
  reason: 'open' | 'member' | 'privileged' | 'pending' | 'rejected' | 'needs-request' | 'restricted' | 'queue' | 'queue-active';
}

// Owner and global admins always get in: the owner cannot be locked out of
// their own room, and a global admin is already elevated everywhere (see
// shared/permissions.ts's AccountRole).
export async function resolveEntry(
  prisma: PrismaClient,
  room: { id: string; ownerId: string; requiresApproval: boolean; restrictedAccess?: boolean; restrictedMinRole?: string; queueEnabled?: boolean },
  userId: string,
): Promise<EntryDecision> {
  if (userId === room.ownerId) return { allowed: true, reason: 'privileged' };

  const [user, member] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { accountRole: true } }),
    prisma.roomMember.findUnique({ where: { userId_roomId: { userId, roomId: room.id } } }),
  ]);
  if (user?.accountRole === 'admin') return { allowed: true, reason: 'privileged' };

  // QA (Akses ruang checklist item 1, "Ruang sensitif terkontrol") — checked
  // BEFORE the ordinary approval flow below: a restricted room has no
  // "needs-request" escape hatch at all, self-service or otherwise. Only an
  // ACTIVE membership with sufficient role clears it — 'pending'/'rejected'
  // members are still denied, same as they would be anywhere else.
  if (room.restrictedAccess) {
    const role = (member?.role as Role | undefined) ?? 'member';
    const minRole = (room.restrictedMinRole as Role | undefined) ?? 'staff';
    if (member?.status === 'active' && roleAtLeast(role, minRole)) {
      return { allowed: true, reason: 'member' };
    }

    // "Ngobrol dengan CEO" queue — a 'called' ticket (their turn) or an
    // 'active' one that hasn't expired yet (a mid-session reconnect) both
    // admit, without ever touching the persistent RoomMember role above.
    if (room.queueEnabled) {
      const ticket = await prisma.roomQueueEntry.findFirst({
        where: { roomId: room.id, zoneId: null, userId, status: { in: ['called', 'active'] } },
      });
      if (ticket?.status === 'called') return { allowed: true, reason: 'queue-active' };
      if (ticket?.status === 'active' && ticket.endsAt && ticket.endsAt > new Date()) {
        return { allowed: true, reason: 'queue-active' };
      }
      return { allowed: false, reason: 'queue' };
    }
    return { allowed: false, reason: 'restricted' };
  }

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
  room: { id: string; ownerId: string; requiresApproval: boolean; restrictedAccess?: boolean; restrictedMinRole?: string },
  userId: string,
): Promise<boolean> {
  return (await resolveEntry(prisma, room, userId)).allowed;
}
