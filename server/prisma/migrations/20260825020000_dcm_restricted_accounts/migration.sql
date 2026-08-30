-- AlterTable
ALTER TABLE "User" ADD COLUMN "restrictedToRoomId" TEXT;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_restrictedToRoomId_fkey" FOREIGN KEY ("restrictedToRoomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;
