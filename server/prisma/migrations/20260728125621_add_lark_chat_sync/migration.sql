-- CreateTable
CREATE TABLE "RoomChatMap" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "chatName" TEXT,
    "roomName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomChatMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LarkSentMessage" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LarkSentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RoomChatMap_roomId_key" ON "RoomChatMap"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomChatMap_chatId_key" ON "RoomChatMap"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "LarkSentMessage_messageId_key" ON "LarkSentMessage"("messageId");

-- CreateIndex
CREATE INDEX "LarkSentMessage_createdAt_idx" ON "LarkSentMessage"("createdAt");

-- AddForeignKey
ALTER TABLE "RoomChatMap" ADD CONSTRAINT "RoomChatMap_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

