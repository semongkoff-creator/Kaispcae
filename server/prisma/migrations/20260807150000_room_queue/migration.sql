-- "Ngobrol dengan CEO" queue: per-room toggle + FIFO timed-ticket table.
ALTER TABLE "Room" ADD COLUMN "queueEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "RoomQueueEntry" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "topic" TEXT,
    "durationMin" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RoomQueueEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RoomQueueEntry_roomId_status_requestedAt_idx" ON "RoomQueueEntry"("roomId", "status", "requestedAt");

CREATE INDEX "RoomQueueEntry_userId_status_idx" ON "RoomQueueEntry"("userId", "status");

ALTER TABLE "RoomQueueEntry" ADD CONSTRAINT "RoomQueueEntry_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RoomQueueEntry" ADD CONSTRAINT "RoomQueueEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
