-- AlterTable
ALTER TABLE "CalendarEvent" ADD COLUMN "meetkaiZoneId" TEXT;
ALTER TABLE "CalendarEvent" ADD COLUMN "meetkaiPassword" TEXT;
ALTER TABLE "CalendarEvent" ADD COLUMN "lastAutoJoinFiredFor" TIMESTAMP(3);
