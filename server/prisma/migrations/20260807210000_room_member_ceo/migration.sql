-- "Ngobrol dengan CEO" restricted-area bypass — a separate, stackable flag
-- (not another `role` value, see RoomMember.isCeo's own doc comment in
-- schema.prisma), so granting/revoking it never disturbs an existing
-- admin/staff grant.
ALTER TABLE "RoomMember" ADD COLUMN "isCeo" BOOLEAN NOT NULL DEFAULT false;
