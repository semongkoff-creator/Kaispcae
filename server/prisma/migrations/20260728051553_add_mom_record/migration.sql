-- A5 — recorded official meetings (Lark VC).
CREATE TABLE "MomRecord" (
  "id" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "zoneId" TEXT NOT NULL,
  "startedBy" TEXT NOT NULL,
  "startTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endTime" TIMESTAMP(3),
  "larkReserveId" TEXT,
  "larkMeetingNo" TEXT,
  "larkMeetingId" TEXT,
  "recordingStatus" TEXT NOT NULL DEFAULT 'live',
  "recordingUrl" TEXT,
  "summary" TEXT,
  "actionItems" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MomRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MomRecord_roomId_idx" ON "MomRecord"("roomId");
