-- CreateTable
CREATE TABLE "Folder" (
    "id" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Doc" (
    "id" TEXT NOT NULL,
    "folderId" TEXT,
    "title" TEXT NOT NULL DEFAULT 'Dokumen Tanpa Judul',
    "icon" TEXT,
    "coverImage" TEXT,
    "content" BYTEA,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "Doc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocPermission" (
    "id" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL DEFAULT 'user',
    "subjectId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocShareLink" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "passwordHash" TEXT,
    "allowCopy" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "lastOpenedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocComment" (
    "id" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "parentId" TEXT,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "anchorFrom" INTEGER,
    "anchorTo" INTEGER,
    "quoted" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocVersion" (
    "id" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "name" TEXT,
    "preview" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Folder_ownerId_idx" ON "Folder"("ownerId");

-- CreateIndex
CREATE INDEX "Folder_parentId_idx" ON "Folder"("parentId");

-- CreateIndex
CREATE INDEX "Doc_ownerId_updatedAt_idx" ON "Doc"("ownerId", "updatedAt");

-- CreateIndex
CREATE INDEX "Doc_folderId_idx" ON "Doc"("folderId");

-- CreateIndex
CREATE INDEX "DocPermission_subjectId_idx" ON "DocPermission"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "DocPermission_docId_subjectType_subjectId_key" ON "DocPermission"("docId", "subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "DocShareLink_token_key" ON "DocShareLink"("token");

-- CreateIndex
CREATE INDEX "DocShareLink_docId_idx" ON "DocShareLink"("docId");

-- CreateIndex
CREATE INDEX "DocComment_docId_resolved_createdAt_idx" ON "DocComment"("docId", "resolved", "createdAt");

-- CreateIndex
CREATE INDEX "DocVersion_docId_createdAt_idx" ON "DocVersion"("docId", "createdAt");

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Folder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Doc" ADD CONSTRAINT "Doc_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Doc" ADD CONSTRAINT "Doc_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocPermission" ADD CONSTRAINT "DocPermission_docId_fkey" FOREIGN KEY ("docId") REFERENCES "Doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocShareLink" ADD CONSTRAINT "DocShareLink_docId_fkey" FOREIGN KEY ("docId") REFERENCES "Doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocComment" ADD CONSTRAINT "DocComment_docId_fkey" FOREIGN KEY ("docId") REFERENCES "Doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocComment" ADD CONSTRAINT "DocComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DocComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocComment" ADD CONSTRAINT "DocComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocVersion" ADD CONSTRAINT "DocVersion_docId_fkey" FOREIGN KEY ("docId") REFERENCES "Doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocVersion" ADD CONSTRAINT "DocVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
