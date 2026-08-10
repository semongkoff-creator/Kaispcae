-- Lobby room-card cover image — a URL under /api/uploads/ or /api/files/,
-- same upload pipeline the Room Editor reference-image feature already
-- uses. Null (every existing room) falls back to the Lobby's placeholder.
ALTER TABLE "Room" ADD COLUMN "coverImage" TEXT;
