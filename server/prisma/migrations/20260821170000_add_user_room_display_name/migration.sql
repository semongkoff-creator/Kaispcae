-- The account's last-used room-entry nametag (see
-- specs/2026-08-21-room-entry-name-prompt-design.md) — separate from
-- displayName, which Lark SSO overwrites on every login, and from
-- avatarConfig.name. Nullable, no backfill: every existing account gets
-- NULL, and the client falls back to displayName until this is set once.

ALTER TABLE "User" ADD COLUMN "roomDisplayName" TEXT;
