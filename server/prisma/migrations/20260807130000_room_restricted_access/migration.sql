-- QA (Akses ruang checklist item 1) — stricter room-entry gate, separate
-- from requiresApproval. Both default to a no-op for existing rooms
-- (restrictedAccess false).
ALTER TABLE "Room" ADD COLUMN "restrictedAccess" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Room" ADD COLUMN "restrictedMinRole" TEXT NOT NULL DEFAULT 'staff';
