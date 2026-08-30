-- The start time of a user's MOST RECENT StatusInterval row (see
-- specs/2026-08-21-last-seen-offline-members-design.md) — replaces
-- firstSeenAt (added this morning, specs/2026-08-21-first-seen-offline-
-- members-design.md) as the timestamp shown in the Offline list; firstSeenAt
-- itself is left untouched, not dropped. Nullable: a user who's never
-- joined a room stays NULL.

ALTER TABLE "User" ADD COLUMN "lastSeenAt" TIMESTAMP(3);

-- One-time backfill: without this, every EXISTING user would only get
-- lastSeenAt set the next time they join a room or change work-mode after
-- this deploy — incorrectly showing "terakhir masuk: baru saja" for
-- someone who hasn't been active in weeks. This computes each user's
-- actual MOST RECENT StatusInterval row (already indexed on
-- (userId, startedAt), see schema.prisma) and writes its startedAt. A user
-- with zero StatusInterval rows is untouched by this UPDATE and correctly
-- stays NULL — meaning "has never joined a room", not a bug.
UPDATE "User" u
SET "lastSeenAt" = latest."maxStartedAt"
FROM (
  SELECT "userId", MAX("startedAt") AS "maxStartedAt"
  FROM "StatusInterval"
  GROUP BY "userId"
) latest
WHERE u.id = latest."userId";
