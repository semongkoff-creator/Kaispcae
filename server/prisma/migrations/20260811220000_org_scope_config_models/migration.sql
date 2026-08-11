-- Migration slice (post-Fase 4) — the last 6 models with no organizationId
-- at all, explicitly deferred by Fase 1: Department, WorkspacePolicy,
-- Shift, LeaveType, Holiday, MeetingRoom. All backfill to the one existing
-- default org (same two-step nullable-then-NOT-NULL pattern as Fase 1's
-- User/Room). Global unique constraints (Department.name, LeaveType.name,
-- Holiday.date) become per-org composite uniques. WorkspacePolicy is the
-- special case: it was a single literal row (id='singleton') shared and
-- mutated by every org on the deployment — organizationId becomes its
-- primary key outright (one policy row per org) rather than adding a
-- filter column alongside the old id.

-- 1. Department
ALTER TABLE "Department" ADD COLUMN "organizationId" TEXT;
UPDATE "Department" SET "organizationId" = 'org_kaitech_default' WHERE "organizationId" IS NULL;
ALTER TABLE "Department" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Department" ADD CONSTRAINT "Department_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
DROP INDEX "Department_name_key";
CREATE UNIQUE INDEX "Department_organizationId_name_key" ON "Department"("organizationId", "name");
CREATE INDEX "Department_organizationId_idx" ON "Department"("organizationId");

-- 2. Shift
ALTER TABLE "Shift" ADD COLUMN "organizationId" TEXT;
UPDATE "Shift" SET "organizationId" = 'org_kaitech_default' WHERE "organizationId" IS NULL;
ALTER TABLE "Shift" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Shift_organizationId_idx" ON "Shift"("organizationId");

-- 3. LeaveType
ALTER TABLE "LeaveType" ADD COLUMN "organizationId" TEXT;
UPDATE "LeaveType" SET "organizationId" = 'org_kaitech_default' WHERE "organizationId" IS NULL;
ALTER TABLE "LeaveType" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "LeaveType" ADD CONSTRAINT "LeaveType_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
DROP INDEX "LeaveType_name_key";
CREATE UNIQUE INDEX "LeaveType_organizationId_name_key" ON "LeaveType"("organizationId", "name");
CREATE INDEX "LeaveType_organizationId_idx" ON "LeaveType"("organizationId");

-- 4. Holiday
ALTER TABLE "Holiday" ADD COLUMN "organizationId" TEXT;
UPDATE "Holiday" SET "organizationId" = 'org_kaitech_default' WHERE "organizationId" IS NULL;
ALTER TABLE "Holiday" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Holiday" ADD CONSTRAINT "Holiday_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
DROP INDEX "Holiday_date_key";
CREATE UNIQUE INDEX "Holiday_organizationId_date_key" ON "Holiday"("organizationId", "date");
CREATE INDEX "Holiday_organizationId_idx" ON "Holiday"("organizationId");

-- 5. MeetingRoom
ALTER TABLE "MeetingRoom" ADD COLUMN "organizationId" TEXT;
UPDATE "MeetingRoom" SET "organizationId" = 'org_kaitech_default' WHERE "organizationId" IS NULL;
ALTER TABLE "MeetingRoom" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "MeetingRoom" ADD CONSTRAINT "MeetingRoom_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "MeetingRoom_organizationId_idx" ON "MeetingRoom"("organizationId");

-- 6. WorkspacePolicy — PK swap from id='singleton' to organizationId.
--    At most one row exists today (created lazily by the first PATCH
--    /admin/policy upsert); if it exists it backfills to the default org,
--    same as every other table above.
ALTER TABLE "WorkspacePolicy" ADD COLUMN "organizationId" TEXT;
UPDATE "WorkspacePolicy" SET "organizationId" = 'org_kaitech_default' WHERE "organizationId" IS NULL;
ALTER TABLE "WorkspacePolicy" DROP CONSTRAINT "WorkspacePolicy_pkey";
ALTER TABLE "WorkspacePolicy" DROP COLUMN "id";
ALTER TABLE "WorkspacePolicy" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "WorkspacePolicy" ADD CONSTRAINT "WorkspacePolicy_pkey" PRIMARY KEY ("organizationId");
ALTER TABLE "WorkspacePolicy" ADD CONSTRAINT "WorkspacePolicy_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
