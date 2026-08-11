import { PrismaClient } from '@prisma/client';

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
