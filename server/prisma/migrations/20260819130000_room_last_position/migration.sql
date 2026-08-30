-- A player's last-known position (server/src/store/roomStore.ts) used to live only in an
-- in-memory Map, so it correctly survived a reconnect/refresh mid-session but every deploy
-- (server restart) silently reset everyone back to the room's spawn tile. Persisted here so
-- it survives a restart too.

-- CreateTable
CREATE TABLE "RoomLastPosition" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "direction" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomLastPosition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RoomLastPosition_roomId_userId_key" ON "RoomLastPosition"("roomId", "userId");

-- AddForeignKey
ALTER TABLE "RoomLastPosition" ADD CONSTRAINT "RoomLastPosition_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
