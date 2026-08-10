-- Guest Link password (bcrypt hash). Nullable so pre-existing invite rows
-- don't break the migration; POST /guest/join treats a null hash as
-- "predates password support" and rejects the join.
ALTER TABLE "RoomInvite" ADD COLUMN "passwordHash" TEXT;
