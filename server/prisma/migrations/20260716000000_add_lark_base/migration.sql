-- CreateTable
CREATE TABLE "Base" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Base_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BaseMember" (
    "id" TEXT NOT NULL,
    "baseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BaseMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BaseTable" (
    "id" TEXT NOT NULL,
    "baseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "fields" JSONB NOT NULL,
    "views" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BaseTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BaseRecord" (
    "id" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "cells" JSONB NOT NULL,
    "orderIndex" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BaseRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareLink" (
    "token" TEXT NOT NULL,
    "baseId" TEXT NOT NULL,
    "viewId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "passwordHash" TEXT,
    "expiresAt" TIMESTAMP(3),
    "allowCopy" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastOpenedAt" TIMESTAMP(3),

    CONSTRAINT "ShareLink_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "RecordComment" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "mentions" JSONB,
    "parentId" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecordComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordHistory" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecordHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "baseId" TEXT,
    "recipientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "recordId" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BaseMember_userId_idx" ON "BaseMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BaseMember_baseId_userId_key" ON "BaseMember"("baseId", "userId");

-- CreateIndex
CREATE INDEX "BaseTable_baseId_idx" ON "BaseTable"("baseId");

-- CreateIndex
CREATE INDEX "BaseRecord_tableId_orderIndex_idx" ON "BaseRecord"("tableId", "orderIndex");

-- CreateIndex
CREATE INDEX "ShareLink_baseId_idx" ON "ShareLink"("baseId");

-- CreateIndex
CREATE INDEX "RecordComment_recordId_createdAt_idx" ON "RecordComment"("recordId", "createdAt");

-- CreateIndex
CREATE INDEX "RecordHistory_recordId_createdAt_idx" ON "RecordHistory"("recordId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_recipientId_read_createdAt_idx" ON "Notification"("recipientId", "read", "createdAt");

-- AddForeignKey
ALTER TABLE "Base" ADD CONSTRAINT "Base_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BaseMember" ADD CONSTRAINT "BaseMember_baseId_fkey" FOREIGN KEY ("baseId") REFERENCES "Base"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BaseMember" ADD CONSTRAINT "BaseMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BaseTable" ADD CONSTRAINT "BaseTable_baseId_fkey" FOREIGN KEY ("baseId") REFERENCES "Base"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BaseRecord" ADD CONSTRAINT "BaseRecord_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "BaseTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_baseId_fkey" FOREIGN KEY ("baseId") REFERENCES "Base"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordComment" ADD CONSTRAINT "RecordComment_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "BaseRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordComment" ADD CONSTRAINT "RecordComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordHistory" ADD CONSTRAINT "RecordHistory_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "BaseRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordHistory" ADD CONSTRAINT "RecordHistory_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_baseId_fkey" FOREIGN KEY ("baseId") REFERENCES "Base"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
