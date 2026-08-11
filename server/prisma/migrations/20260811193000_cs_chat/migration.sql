-- CreateTable
CREATE TABLE "CsSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'bot',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CsSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CsMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CsMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CsSession_userId_updatedAt_idx" ON "CsSession"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "CsMessage_sessionId_createdAt_idx" ON "CsMessage"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "CsSession" ADD CONSTRAINT "CsSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CsMessage" ADD CONSTRAINT "CsMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CsSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
