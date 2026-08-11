import { PrismaClient } from '@prisma/client';

// The single answer to "may this user read this chat?".
//
// This logic previously lived in two hand-kept copies (routes/chat.ts and
// socket/channelChatHandler.ts), each with a comment calling the duplication
// deliberate — decoupling was worth a little repetition. That reasoning holds
// for state maps; it does not hold for an authorization predicate. Copies of
// an access rule drift, and a rule that drifts fails OPEN in whichever copy
// someone forgot. A third caller (routes/uploads.ts, which must now decide
// whether you may read a DM's attachment) is what forced the issue.

// Public rooms are open to any authenticated user — the same rule as joining
// one anywhere else in this app (Socket.IO's JOIN_ROOM has no isPublic check
// either). Private rooms are unlisted-by-slug everywhere too, but these are
// silent REST reads that leave no trace an occupant could notice — no avatar
// appears, no "X joined" fires — so they take one extra bar: the owner, an
// explicit RoomMember row of any role, or a global admin account (see
// shared/permissions.ts's AccountRole). Without it, anyone who guessed a
// private room's slug could read and post into its chat while never "being"
// in the room in any way anyone else could see.
export async function canAccessRoomChat(
  prisma: PrismaClient,
  room: { id: string; ownerId: string; isPublic: boolean; organizationId: string },
  userId: string,
  organizationId: string | undefined,
): Promise<boolean> {
  // Multi-tenant Fase 3 — checked FIRST, before isPublic: a public room is
  // "open to any authenticated user" WITHIN its own company, never across
  // one. Without this, isPublic's fast path returned true unconditionally
  // for any authenticated caller regardless of org — the widest bypass
  // found in this audit, since (per this file's own comment) 190 of 191
  // rooms are public.
  if (!organizationId || room.organizationId !== organizationId) return false;
  if (room.isPublic) return true;
  if (userId === room.ownerId) return true;
  const [user, member] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { accountRole: true } }),
    prisma.roomMember.findUnique({ where: { userId_roomId: { userId, roomId: room.id } } }),
  ]);
  if (user?.accountRole === 'admin') return true;
  return !!member;
}

// The same question against a Conversation (see the Conversation model).
//
// The two kinds answer differently on purpose. A DM is gated by its
// participant list — that list IS the conversation, and no room has any say.
// A group still defers to its originating room, because 190 of 191 rooms are
// public and their chat is open to authenticated users holding no RoomMember
// row at all; gating groups on the participant list would silently lock every
// one of them out.
export async function canAccessConversation(
  prisma: PrismaClient,
  conversationId: string,
  userId: string,
  organizationId: string | undefined,
): Promise<boolean> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { room: true },
  });
  if (!conversation) return false;

  if (conversation.kind === 'dm') {
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    return !!participant;
  }

  // A group whose room is gone (Conversation.roomId is SetNull) has nothing
  // left to derive access from, so nobody reads it. Deliberately closed
  // rather than open: this is the branch that would otherwise quietly expose
  // an ex-room's history to everyone.
  if (!conversation.room) return false;
  return canAccessRoomChat(prisma, conversation.room, userId, organizationId);
}
