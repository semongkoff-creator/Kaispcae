-- Messenger migration, step 2: workspace-level conversations.
--
-- ADDITIVE ONLY. Channel, DirectConversation, ChatMessage.channelId and
-- ChatMessage.conversationId are all left untouched and stay authoritative:
-- nothing reads the new columns yet. Rolling this back is "stop reading
-- conversationId2", not a data restore.
--
-- Conversation.roomId is SET NULL, not CASCADE — the entire point. Today a
-- room's deletion cascades away the DMs of everyone who happened to talk
-- while in it.

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "conversationId2" TEXT;

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "roomId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationParticipant" (
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("conversationId","userId")
);

-- CreateIndex
CREATE INDEX "Conversation_roomId_idx" ON "Conversation"("roomId");

-- CreateIndex
CREATE INDEX "Conversation_kind_idx" ON "Conversation"("kind");

-- CreateIndex
CREATE INDEX "ConversationParticipant_userId_idx" ON "ConversationParticipant"("userId");

-- CreateIndex
CREATE INDEX "ChatMessage_conversationId2_createdAt_idx" ON "ChatMessage"("conversationId2", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_conversationId2_clientId_key" ON "ChatMessage"("conversationId2", "clientId");

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId2_fkey" FOREIGN KEY ("conversationId2") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────
-- Backfill. Every statement below is idempotent (deterministic ids +
-- ON CONFLICT DO NOTHING), so re-running this migration against a
-- partially-migrated database converges instead of duplicating.
-- ─────────────────────────────────────────────────────────────────────

-- Each Channel becomes a group conversation, keeping its room as provenance.
INSERT INTO "Conversation" ("id", "kind", "title", "roomId", "createdAt")
SELECT 'grp:' || c."id", 'group', c."name", c."roomId", c."createdAt"
FROM "Channel" c
ON CONFLICT ("id") DO NOTHING;

-- Each DM pair becomes ONE conversation, no longer one per (pair, room).
-- LEAST/GREATEST rather than trusting the userAId < userBId invariant the
-- application maintains: this must produce the same id for a pair even if a
-- row ever got written the other way round.
--
-- DISTINCT ON collapses a pair that holds DMs in several rooms down to a
-- single conversation, keeping the earliest as provenance. No such pair
-- exists in this database today (verified: 6 DMs, 6 distinct pairs, 1 room
-- each), so this merges nothing here — it is here so the statement is
-- correct on any other deployment, not decoration.
INSERT INTO "Conversation" ("id", "kind", "title", "roomId", "createdAt")
SELECT DISTINCT ON (LEAST(d."userAId", d."userBId"), GREATEST(d."userAId", d."userBId"))
       'dm:' || LEAST(d."userAId", d."userBId") || ':' || GREATEST(d."userAId", d."userBId"),
       'dm', NULL, d."roomId", d."createdAt"
FROM "DirectConversation" d
ORDER BY LEAST(d."userAId", d."userBId"), GREATEST(d."userAId", d."userBId"), d."createdAt" ASC
ON CONFLICT ("id") DO NOTHING;

-- DM participants: authoritative — this is exactly the pair check
-- routes/chat.ts already enforces, just stored instead of derived.
INSERT INTO "ConversationParticipant" ("conversationId", "userId", "joinedAt")
SELECT 'dm:' || LEAST(d."userAId", d."userBId") || ':' || GREATEST(d."userAId", d."userBId"), u."userId", MIN(d."createdAt")
FROM "DirectConversation" d
CROSS JOIN LATERAL (VALUES (d."userAId"), (d."userBId")) AS u("userId")
GROUP BY 1, 2
ON CONFLICT ("conversationId", "userId") DO NOTHING;

-- Group participants: INFORMATIONAL ONLY. Access for groups still resolves
-- through the room (see routes/chat.ts's canAccessRoomChat), because 190 of
-- 191 rooms are public and open to any authenticated user who has no
-- RoomMember row at all — gating on this list would silently lock them out.
-- Seeded from RoomMember plus the owner (who needs no RoomMember row).
INSERT INTO "ConversationParticipant" ("conversationId", "userId", "joinedAt")
SELECT 'grp:' || c."id", rm."userId", GREATEST(c."createdAt", rm."joinedAt")
FROM "Channel" c
JOIN "RoomMember" rm ON rm."roomId" = c."roomId"
ON CONFLICT ("conversationId", "userId") DO NOTHING;

INSERT INTO "ConversationParticipant" ("conversationId", "userId", "joinedAt")
SELECT 'grp:' || c."id", r."ownerId", c."createdAt"
FROM "Channel" c
JOIN "Room" r ON r."id" = c."roomId"
ON CONFLICT ("conversationId", "userId") DO NOTHING;

-- Point every existing message at its new conversation. channelId and
-- conversationId are deliberately NOT cleared — they remain the source of
-- truth until step 3 verifies every message is readable through the new
-- column.
UPDATE "ChatMessage" m
SET "conversationId2" = 'grp:' || m."channelId"
WHERE m."channelId" IS NOT NULL AND m."conversationId2" IS NULL;

UPDATE "ChatMessage" m
SET "conversationId2" = 'dm:' || LEAST(d."userAId", d."userBId") || ':' || GREATEST(d."userAId", d."userBId")
FROM "DirectConversation" d
WHERE m."conversationId" = d."id" AND m."conversationId2" IS NULL;
