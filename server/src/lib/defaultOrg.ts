import { PrismaClient } from '@prisma/client';

// The workspace a self-service signup lands in when nothing else resolves an
// organization for it. The invite flows (lib/orgInvite.ts) and self-serve org
// creation (POST /auth/create-organization) both name a real org explicitly;
// this is only the fallback for POST /auth/register, which has no other way to
// know where the account belongs.
//
// The id is a fixed literal, not a cuid, so every call site can reference the
// same row without a lookup. Deliberately product-neutral: this codebase ships
// to many different companies, so no customer's name belongs in an identifier
// that ends up in their database.
export const DEFAULT_ORG_ID = 'org_default';
const DEFAULT_ORG_NAME = 'Workspace';
const DEFAULT_ORG_SLUG = 'workspace';

// User.organizationId is a required FK, so creating an account against an
// organization row that doesn't exist fails with P2003 — and on a brand-new
// deployment that row has never existed, because nothing creates it. (In
// long-lived databases it happens to be present only because an early
// migration backfilled it there, which is why this never surfaced until the
// schema was applied to an empty database.) The practical effect was that a
// fresh install could not register its very first account at all — the app
// was unusable out of the box, with a foreign-key error as its only clue.
//
// Idempotent by construction: `create` on a conflicting id is skipped rather
// than treated as an error, so concurrent first-registrations race harmlessly
// and every later call is a no-op.
export async function ensureDefaultOrg(prisma: PrismaClient): Promise<void> {
  await prisma.organization.upsert({
    where: { id: DEFAULT_ORG_ID },
    update: {},
    create: { id: DEFAULT_ORG_ID, name: DEFAULT_ORG_NAME, slug: DEFAULT_ORG_SLUG },
  });
}
