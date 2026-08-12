-- AlterTable
-- AuditLog is append-only by design (see model comment in schema.prisma) —
-- deleting the actor's User row must never cascade-delete the audit
-- evidence of what they did. actorId becomes nullable so the row survives
-- with actorId = NULL, matching the existing targetUserId/SetNull pattern
-- already used in this same table.
ALTER TABLE "AuditLog" ALTER COLUMN "actorId" DROP NOT NULL;

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_actorId_fkey";

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
