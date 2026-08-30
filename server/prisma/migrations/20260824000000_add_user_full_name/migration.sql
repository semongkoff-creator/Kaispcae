-- specs/2026-08-21-full-name-field-design.md — a new, purely additive
-- column, separate from User.displayName (untouched by this migration).
-- Nullable: stays NULL for every existing user until either a Lark login
-- auto-populates it (once, never overwritten again — see the schema
-- comment) or the user fills it in themselves via the Avatar Editor.

ALTER TABLE "User" ADD COLUMN "fullName" TEXT;
