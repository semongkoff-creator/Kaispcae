-- Claimable-seat ownership used to live only in an in-memory Map (server/src/socket/seatClaim.ts),
-- so it survived disconnects/reconnects but not an actual server restart -- every deploy silently
-- wiped every claimed desk. Persisted here so a claim survives everything except an explicit release.

-- CreateTable
CREATE TABLE "RoomSeatClaim" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomSeatClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RoomSeatClaim_roomId_seatId_key" ON "RoomSeatClaim"("roomId", "seatId");

-- AddForeignKey
ALTER TABLE "RoomSeatClaim" ADD CONSTRAINT "RoomSeatClaim_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
