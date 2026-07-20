import { PrismaClient } from '@prisma/client';

// Messenger migration — the ONE place conversation ids are derived.
//
// These forms are duplicated in SQL by the backfill
// (prisma/migrations/20260717040000_add_conversation_participant). That
// duplication is unavoidable — the migration can't import TypeScript — which
// is exactly why the shapes are dead simple: a sorted pair and a prefix, no
// hashing, nothing that could drift between the two implementations without
// being obvious on sight.
//
// Deterministic rather than cuid so that every writer converges on the same
// row: a backfill re-run, two racing sends, and a lazily-created channel all
// name the same conversation the same way, and the primary key does the
// deduplicating instead of a lookup-then-insert that can race.

// The pair is sorted so that the same two people always produce one id,
// whichever of them started the conversation. This — not the room — is what
// identifies a DM, which is the whole point of the migration: a conversation
// belongs to its people, not to where they happened to be standing.
export function dmConversationId(userIdA: string, userIdB: string): string {
  const [a, b] = [userIdA, userIdB].sort();
  return `dm:${a}:${b}`;
}

export function groupConversationId(channelId: string): string {
  return `grp:${channelId}`;
}

// Every Channel needs its mirror Conversation to exist before any message can
// point at it (ChatMessage.conversationId2 is a real foreign key). Called at
// each of the three places a Channel comes into being — POST /rooms, POST
// /rooms/:slug/channels, and the lazy backfill in GET /rooms/:slug/channels.
//
// upsert, not create: the id is derived from the channel's own id, so a
// second call is a no-op rather than a duplicate or a crash. That makes this
// safe to call unconditionally, including on rows the migration already
// backfilled.
export async function ensureGroupConversation(
  prisma: PrismaClient,
  channel: { id: string; name: string; roomId: string; createdAt?: Date },
): Promise<string> {
  const id = groupConversationId(channel.id);
  await prisma.conversation.upsert({
    where: { id },
    create: {
      id,
      kind: 'group',
      title: channel.name,
      roomId: channel.roomId,
      ...(channel.createdAt ? { createdAt: channel.createdAt } : {}),
    },
    update: {},
  });
  return id;
}

// The DM equivalent. Participants are written here too — for a DM the
// participant list IS the access rule (it's the same pair check
// routes/chat.ts already performs), so a DM conversation without its two
// participants would be a conversation nobody can reach.
export async function ensureDmConversation(
  prisma: PrismaClient,
  dm: { userAId: string; userBId: string; roomId?: string | null; createdAt?: Date },
): Promise<string> {
  const id = dmConversationId(dm.userAId, dm.userBId);
  await prisma.conversation.upsert({
    where: { id },
    create: {
      id,
      kind: 'dm',
      // roomId is provenance only and never re-pointed on a later upsert: it
      // records where the pair first spoke, and must not follow them around.
      roomId: dm.roomId ?? null,
      ...(dm.createdAt ? { createdAt: dm.createdAt } : {}),
    },
    update: {},
  });
  await prisma.conversationParticipant.createMany({
    data: [
      { conversationId: id, userId: dm.userAId },
      { conversationId: id, userId: dm.userBId },
    ],
    skipDuplicates: true,
  });
  return id;
}
