-- Zone-level restriction ("CEO Office" is a zone, not a separate Room):
-- queue entries can now be scoped to one zone within a room, and a room can
-- declare which zones require staff+ or a queue ticket to enter.

-- DropIndex
DROP INDEX "RoomQueueEntry_roomId_status_requestedAt_idx";

-- AlterTable
ALTER TABLE "RoomQueueEntry" ADD COLUMN "zoneId" TEXT;
ALTER TABLE "RoomQueueEntry" ADD COLUMN "zoneName" TEXT;

-- CreateIndex
CREATE INDEX "RoomQueueEntry_roomId_zoneId_status_requestedAt_idx" ON "RoomQueueEntry"("roomId", "zoneId", "status", "requestedAt");

-- CreateTable
CREATE TABLE "ZoneRestriction" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "minRole" TEXT NOT NULL DEFAULT 'staff',
    "queueEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoneRestriction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ZoneRestriction_roomId_zoneId_key" ON "ZoneRestriction"("roomId", "zoneId");

-- AddForeignKey
ALTER TABLE "ZoneRestriction" ADD CONSTRAINT "ZoneRestriction_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
