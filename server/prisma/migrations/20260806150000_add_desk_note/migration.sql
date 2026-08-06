-- CreateTable
CREATE TABLE "DeskNote" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "furnitureId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeskNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeskNote_roomId_furnitureId_key" ON "DeskNote"("roomId", "furnitureId");

-- AddForeignKey
ALTER TABLE "DeskNote" ADD CONSTRAINT "DeskNote_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
