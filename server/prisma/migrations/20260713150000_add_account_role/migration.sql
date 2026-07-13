-- AlterTable
ALTER TABLE "User" ADD COLUMN     "accountRole" TEXT NOT NULL DEFAULT 'user';

-- Backfill: anyone who already created at least one room demonstrated
-- room-creation intent before this gate existed — grandfather them in as
-- admin rather than suddenly locking them out of a capability they were
-- already using.
UPDATE "User" SET "accountRole" = 'admin'
WHERE "id" IN (SELECT DISTINCT "ownerId" FROM "Room");
