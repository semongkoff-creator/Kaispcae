-- Lark attendance trigger support: user_id (employee_id) + per-day idempotency
-- marker. Both nullable + additive, safe on populated table.
ALTER TABLE "User" ADD COLUMN "larkUserId" TEXT;
ALTER TABLE "User" ADD COLUMN "lastAttendanceCheckInDate" TEXT;
