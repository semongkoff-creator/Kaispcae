-- DropForeignKey
ALTER TABLE "Base" DROP CONSTRAINT "Base_ownerId_fkey";

-- DropForeignKey
ALTER TABLE "BaseMember" DROP CONSTRAINT "BaseMember_baseId_fkey";

-- DropForeignKey
ALTER TABLE "BaseMember" DROP CONSTRAINT "BaseMember_userId_fkey";

-- DropForeignKey
ALTER TABLE "BaseRecord" DROP CONSTRAINT "BaseRecord_tableId_fkey";

-- DropForeignKey
ALTER TABLE "BaseTable" DROP CONSTRAINT "BaseTable_baseId_fkey";

-- DropForeignKey
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_baseId_fkey";

-- DropForeignKey
ALTER TABLE "RecordComment" DROP CONSTRAINT "RecordComment_authorId_fkey";

-- DropForeignKey
ALTER TABLE "RecordComment" DROP CONSTRAINT "RecordComment_recordId_fkey";

-- DropForeignKey
ALTER TABLE "RecordHistory" DROP CONSTRAINT "RecordHistory_actorId_fkey";

-- DropForeignKey
ALTER TABLE "RecordHistory" DROP CONSTRAINT "RecordHistory_recordId_fkey";

-- DropForeignKey
ALTER TABLE "ShareLink" DROP CONSTRAINT "ShareLink_baseId_fkey";

-- AlterTable
ALTER TABLE "Notification" DROP COLUMN "baseId";

-- DropTable
DROP TABLE "Base";

-- DropTable
DROP TABLE "BaseMember";

-- DropTable
DROP TABLE "BaseRecord";

-- DropTable
DROP TABLE "BaseTable";

-- DropTable
DROP TABLE "RecordComment";

-- DropTable
DROP TABLE "RecordHistory";

-- DropTable
DROP TABLE "ShareLink";

