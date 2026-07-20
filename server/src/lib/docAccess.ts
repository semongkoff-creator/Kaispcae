import { PrismaClient } from '@prisma/client';
import { DocRole } from '@virtualmeet/shared';

// Resolve a user's role on a doc FROM THE DATABASE. Called on every request
// and on every realtime edit — never cached in a token, never taken from the
// client.
//
// Note what is deliberately absent: there is no workspace-admin branch. An
// admin who is not the owner and holds no DocPermission gets null, exactly
// like any stranger. Admin power over docs is `docs:takeover` only, which is
// overt and audited (finish criterion #21's Docs equivalent).
export async function resolveDocRole(prisma: PrismaClient, docId: string, userId: string): Promise<DocRole | null> {
  const doc = await prisma.doc.findUnique({ where: { id: docId }, select: { ownerId: true } });
  if (!doc) return null;
  if (doc.ownerId === userId) return 'owner';
  const perm = await prisma.docPermission.findUnique({
    where: { docId_subjectType_subjectId: { docId, subjectType: 'user', subjectId: userId } },
    select: { role: true },
  });
  if (!perm) return null;
  const r = perm.role;
  return r === 'editor' || r === 'commenter' || r === 'viewer' ? r : null;
}
