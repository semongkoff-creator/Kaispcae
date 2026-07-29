-- Bug 1 — single active session per account.
ALTER TABLE "User" ADD COLUMN "currentSessionId" TEXT;
