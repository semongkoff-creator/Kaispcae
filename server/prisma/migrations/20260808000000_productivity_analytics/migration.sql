-- AlterTable
ALTER TABLE "WorkspacePolicy"
  ADD COLUMN "analyticsVibeNormalizationFactor" DOUBLE PRECISION NOT NULL DEFAULT 10,
  ADD COLUMN "analyticsOvertimeGraceMinMinutes" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "analyticsPlatformMonthlyCostIdr" INTEGER,
  ADD COLUMN "analyticsAvgHourlyRateIdr" INTEGER,
  ADD COLUMN "analyticsSchedulingSavedMinutesPerMeeting" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "analyticsHallOfFameLarkChatId" TEXT,
  ADD COLUMN "analyticsTaskDoneStatusValues" TEXT[] NOT NULL DEFAULT ARRAY['Done', 'Selesai', 'Completed']::TEXT[];

-- CreateTable
CREATE TABLE "StatusInterval" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roomSlug" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "StatusInterval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StatusInterval_userId_startedAt_idx" ON "StatusInterval"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "StatusInterval_userId_endedAt_idx" ON "StatusInterval"("userId", "endedAt");

-- AddForeignKey
ALTER TABLE "StatusInterval" ADD CONSTRAINT "StatusInterval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ConnectionEvent" (
    "id" TEXT NOT NULL,
    "roomSlug" TEXT NOT NULL,
    "userAId" TEXT NOT NULL,
    "userBId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConnectionEvent_userAId_occurredAt_idx" ON "ConnectionEvent"("userAId", "occurredAt");

-- CreateIndex
CREATE INDEX "ConnectionEvent_userBId_occurredAt_idx" ON "ConnectionEvent"("userBId", "occurredAt");

-- AddForeignKey
ALTER TABLE "ConnectionEvent" ADD CONSTRAINT "ConnectionEvent_userAId_fkey" FOREIGN KEY ("userAId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionEvent" ADD CONSTRAINT "ConnectionEvent_userBId_fkey" FOREIGN KEY ("userBId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "DailyVibeCounter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "emoteCount" INTEGER NOT NULL DEFAULT 0,
    "waveCount" INTEGER NOT NULL DEFAULT 0,
    "chatCount" INTEGER NOT NULL DEFAULT 0,
    "furnitureCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyVibeCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyVibeCounter_userId_date_key" ON "DailyVibeCounter"("userId", "date");

-- AddForeignKey
ALTER TABLE "DailyVibeCounter" ADD CONSTRAINT "DailyVibeCounter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "TaskCompletionSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "dueCount" INTEGER NOT NULL DEFAULT 0,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "onTimeCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskCompletionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskCompletionSnapshot_userId_date_key" ON "TaskCompletionSnapshot"("userId", "date");

-- AddForeignKey
ALTER TABLE "TaskCompletionSnapshot" ADD CONSTRAINT "TaskCompletionSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
