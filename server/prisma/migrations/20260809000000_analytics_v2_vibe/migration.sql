-- AlterTable
ALTER TABLE "StatusInterval" ADD COLUMN "zoneId" TEXT;

-- AlterTable
ALTER TABLE "WorkspacePolicy"
  ADD COLUMN "analyticsVibeWeightEmote" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
  ADD COLUMN "analyticsVibeWeightPoke" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
  ADD COLUMN "analyticsVibeWeightVoluntaryCall" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
  ADD COLUMN "analyticsVibeWeightOvertimeInverted" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
  ADD COLUMN "analyticsPokeResponseCeilingSeconds" INTEGER NOT NULL DEFAULT 120;

-- CreateTable
CREATE TABLE "PokeResponseSample" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PokeResponseSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PokeResponseSample_userId_occurredAt_idx" ON "PokeResponseSample"("userId", "occurredAt");

-- AddForeignKey
ALTER TABLE "PokeResponseSample" ADD CONSTRAINT "PokeResponseSample_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
