-- QA #1/#6 — first-run tutorial gate. Null = never completed.
ALTER TABLE "User" ADD COLUMN "tutorialCompletedAt" TIMESTAMP(3);
