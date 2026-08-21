-- specs/2026-08-21-room-scoped-participants-design.md — GET /rooms/:slug/participants
-- (replacing GET /org/members) needs "every distinct userId that has ever had
-- a StatusInterval row for this roomSlug." StatusInterval's two existing
-- indexes are both keyed on userId first, so neither serves a WHERE roomSlug
-- lookup — this index makes that query efficient, and also covers the
-- DISTINCT userId projection directly (no need to touch the base table rows).

CREATE INDEX "StatusInterval_roomSlug_userId_idx" ON "StatusInterval"("roomSlug", "userId");
