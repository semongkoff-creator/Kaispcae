-- Multi-tenant foundation (Fase 1 of the phased multi-tenant plan).
-- Adds Organization + OrgInvite, and a required organizationId FK on User
-- and Room. Existing data is backfilled to one default "Kaitech" org so
-- nothing breaks. NOT included in this migration: any query filtering,
-- permission scoping, or socket broadcast scoping by organizationId — those
-- are later, separate phases, done one file at a time with two-different-org
-- verification before each is deployed.

-- 1. Organization table
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- 2. Seed the single default org that all existing (Kaitech) data backfills into.
INSERT INTO "Organization" ("id", "name", "slug", "createdAt", "updatedAt")
VALUES ('org_kaitech_default', 'Kaitech', 'kaitech', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- 3. User.organizationId — add nullable, backfill, then tighten to NOT NULL.
--    Two-step so this works against a table that already has rows.
ALTER TABLE "User" ADD COLUMN "organizationId" TEXT;
UPDATE "User" SET "organizationId" = 'org_kaitech_default' WHERE "organizationId" IS NULL;
ALTER TABLE "User" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- 4. Room.organizationId — same two-step treatment.
ALTER TABLE "Room" ADD COLUMN "organizationId" TEXT;
UPDATE "Room" SET "organizationId" = 'org_kaitech_default' WHERE "organizationId" IS NULL;
ALTER TABLE "Room" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Room" ADD CONSTRAINT "Room_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Room_organizationId_idx" ON "Room"("organizationId");

-- 5. OrgInvite — foundation for the invite-based join flow. Not wired to any
--    route in this migration; the accept-invite/register endpoints are a
--    follow-up code change, not a further schema change.
CREATE TABLE "OrgInvite" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrgInvite_token_key" ON "OrgInvite"("token");
CREATE INDEX "OrgInvite_organizationId_idx" ON "OrgInvite"("organizationId");
CREATE INDEX "OrgInvite_email_idx" ON "OrgInvite"("email");

ALTER TABLE "OrgInvite" ADD CONSTRAINT "OrgInvite_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrgInvite" ADD CONSTRAINT "OrgInvite_invitedById_fkey"
    FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
