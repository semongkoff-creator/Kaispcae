-- The first time a user ever actually joined a room (see
-- specs/2026-08-21-first-seen-offline-members-design.md) — separate from
-- User.createdAt (account creation), which can happen before someone ever
-- opens a room. Nullable: a user who's never joined a room stays NULL.

ALTER TABLE "User" ADD COLUMN "firstSeenAt" TIMESTAMP(3);

-- One-time backfill: without this, every EXISTING user (who may have used
-- KaiSpace for months) would only get firstSeenAt set the next time they
-- join a room after this deploy — incorrectly reporting "first seen:
-- today". This computes each user's actual earliest StatusInterval row
-- (already indexed on (userId, startedAt), see schema.prisma) and writes
-- it. A user with zero StatusInterval rows is untouched by this UPDATE and
-- correctly stays NULL — meaning "has never joined a room", not a bug.
UPDATE "User" u
SET "firstSeenAt" = earliest."minStartedAt"
FROM (
  SELECT "userId", MIN("startedAt") AS "minStartedAt"
  FROM "StatusInterval"
  GROUP BY "userId"
) earliest
WHERE u.id = earliest."userId";
