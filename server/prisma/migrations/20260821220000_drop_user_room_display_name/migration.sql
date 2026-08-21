-- specs/2026-08-21-nametag-displayname-sync-design.md — removes the
-- separate room-entry nickname concept (specs/2026-08-21-room-entry-
-- name-prompt-design.md, added earlier the same day) entirely. The
-- floating avatar nametag now always follows User.displayName directly;
-- this column's sticky, per-account value was the thing silently
-- overriding displayName after a user's first login, which is exactly the
-- "nametag doesn't sync with Display Name" bug this removal fixes. No data
-- worth preserving — confirmed with the user — so this is a straight drop,
-- not a deprecation.

ALTER TABLE "User" DROP COLUMN "roomDisplayName";
