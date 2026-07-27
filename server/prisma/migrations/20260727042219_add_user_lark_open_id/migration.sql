-- Lark OAuth identity: nullable + unique. Additive, safe on a populated
-- table (all existing rows get NULL, which the unique index permits many of).
ALTER TABLE "User" ADD COLUMN "larkOpenId" TEXT;
CREATE UNIQUE INDEX "User_larkOpenId_key" ON "User"("larkOpenId");
