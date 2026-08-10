-- "Ngobrol dengan CEO" v2 — booking-by-clock-time + free-entry zones.
-- bookingMode: opt-in per zone, defaults false so every existing restricted
-- zone (gated model) is completely unaffected.
ALTER TABLE "ZoneRestriction" ADD COLUMN "bookingMode" BOOLEAN NOT NULL DEFAULT false;

-- mode distinguishes the original FCFS line ('quick', the default — so
-- existing rows read as exactly what they always were) from a scheduled
-- ('booking') entry with a fixed bookingStart/bookingEnd window instead of a
-- relative durationMin.
ALTER TABLE "RoomQueueEntry" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'quick';
ALTER TABLE "RoomQueueEntry" ADD COLUMN "bookingStart" TIMESTAMP(3);
ALTER TABLE "RoomQueueEntry" ADD COLUMN "bookingEnd" TIMESTAMP(3);
ALTER TABLE "RoomQueueEntry" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "RoomQueueEntry" ADD COLUMN "approvedById" TEXT;
ALTER TABLE "RoomQueueEntry" ADD COLUMN "approvedByName" TEXT;

CREATE INDEX "RoomQueueEntry_zoneId_mode_status_bookingStart_idx" ON "RoomQueueEntry"("zoneId", "mode", "status", "bookingStart");
