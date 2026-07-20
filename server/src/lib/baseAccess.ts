import { PrismaClient } from '@prisma/client';
import { BaseRole } from '@virtualmeet/shared';

// Resolve a user's authoritative role in a base from the DB — NEVER trust a
// role sent by the client. Owner is derived from Base.ownerId; everyone else
// from their BaseMember row. Returns null if the user has no access at all.
export async function resolveBaseRole(prisma: PrismaClient, baseId: string, userId: string): Promise<BaseRole | null> {
  const base = await prisma.base.findUnique({ where: { id: baseId }, select: { ownerId: true } });
  if (!base) return null;
  if (base.ownerId === userId) return 'owner';
  const member = await prisma.baseMember.findUnique({
    where: { baseId_userId: { baseId, userId } },
    select: { role: true },
  });
  return (member?.role as BaseRole) ?? null;
}
