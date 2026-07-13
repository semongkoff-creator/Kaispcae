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
export async function resolveRoomRole(prisma: PrismaClient, userId: string, roomId: string, ownerId: string): Promise<Role> {
  if (userId === ownerId) return 'owner';

  const [user, member] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { accountRole: true } }),
    prisma.roomMember.findUnique({ where: { userId_roomId: { userId, roomId } } }),
  ]);

  if (member?.role === 'admin') return 'admin';
  if (user?.accountRole === 'admin') return 'admin';
  if (member?.role === 'staff') return 'staff';
  return 'member';
}
