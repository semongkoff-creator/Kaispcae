-- Chat profile photo: heavy TEXT column, kept out of hot queries via Prisma
-- omit/explicit-select (see routes/users.ts). Nullable + additive, so this is
-- safe to apply to a populated table with no backfill.
ALTER TABLE "User" ADD COLUMN "profilePhoto" TEXT;
