import { PrismaClient, Prisma } from '@prisma/client';

// Multi-tenant Fase 2 — every room lookup by slug across the codebase needs
// to verify the room actually belongs to the caller's org, not just that the
// slug resolves to something. Centralized (same reasoning as roles.ts's
// resolveRoomRole) so every call site gets the identical fail-closed
// behavior instead of ten hand-rolled copies that could each be subtly
// wrong: a missing organizationId on the request, or a real cross-org
// mismatch, both come back as "not found" — never a 403, which would
// confirm to the caller that the room exists in someone else's org.
export async function findRoomInOrg(prisma: PrismaClient, slug: string, organizationId: string | undefined) {
  if (!organizationId) return null;
  const room = await prisma.room.findUnique({ where: { slug } });
  if (!room || room.organizationId !== organizationId) return null;
  return room;
}

// Same shape as findRoomInOrg, for looking up a SPECIFIC user by id (e.g.
// the target of a report, an admin action) rather than the caller
// themselves (req.userId is always safe on its own — no org check needed
// for "look up my own row"). `select` is required and gets organizationId
// merged in automatically for the check, so callers can't forget it and
// can't accidentally select the un-omitted `password` column by leaving
// select out entirely (see lib/prisma.ts's comment on why password isn't
// globally omitted).
export async function findUserInOrg<T extends Prisma.UserSelect>(
  prisma: PrismaClient,
  id: string,
  organizationId: string | undefined,
  select: T,
): Promise<(Prisma.UserGetPayload<{ select: T }> & { organizationId: string }) | null> {
  if (!organizationId) return null;
  // Prisma's findUnique overloads don't infer cleanly through a spread of a
  // caller-supplied generic select — the query itself is still correct
  // (organizationId always merged in for the check below), just typed
  // loosely here and re-asserted to the precise caller-facing shape on
  // return.
  const selectWithOrg = { ...select, organizationId: true } as Prisma.UserSelect;
  const user = (await prisma.user.findUnique({ where: { id }, select: selectWithOrg })) as
    | (Prisma.UserGetPayload<{ select: T }> & { organizationId: string })
    | null;
  if (!user || user.organizationId !== organizationId) return null;
  return user;
}

// Migration slice (post-Fase 4) — same fail-closed shape as findRoomInOrg,
// for the 4 remaining models (of the 6 that gained organizationId) that
// have a lookup-by-id route: Department, Shift, LeaveType, MeetingRoom.
// Holiday has no by-id read route (only an org-scoped upsert-by-date) and
// WorkspacePolicy is looked up directly by organizationId (its new PK), so
// neither needs one of these.
export async function findDepartmentInOrg(prisma: PrismaClient, id: string, organizationId: string | undefined) {
  if (!organizationId) return null;
  const dept = await prisma.department.findUnique({ where: { id } });
  if (!dept || dept.organizationId !== organizationId) return null;
  return dept;
}

export async function findShiftInOrg(prisma: PrismaClient, id: string, organizationId: string | undefined) {
  if (!organizationId) return null;
  const shift = await prisma.shift.findUnique({ where: { id } });
  if (!shift || shift.organizationId !== organizationId) return null;
  return shift;
}

export async function findLeaveTypeInOrg(prisma: PrismaClient, id: string, organizationId: string | undefined) {
  if (!organizationId) return null;
  const type = await prisma.leaveType.findUnique({ where: { id } });
  if (!type || type.organizationId !== organizationId) return null;
  return type;
}

export async function findMeetingRoomInOrg(prisma: PrismaClient, id: string, organizationId: string | undefined) {
  if (!organizationId) return null;
  const room = await prisma.meetingRoom.findUnique({ where: { id } });
  if (!room || room.organizationId !== organizationId) return null;
  return room;
}
