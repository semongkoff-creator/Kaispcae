-- A12 checkout idempotency marker (nullable, additive).
ALTER TABLE "User" ADD COLUMN "lastAttendanceCheckOutDate" TEXT;
