import { PrismaClient } from '@prisma/client';

// ONE PrismaClient for the whole process.
//
// Every route and socket handler used to declare its own
// `function getPrisma() { return new PrismaClient(); }` and call it per
// request. Each PrismaClient opens its OWN connection pool and none of them
// were ever $disconnect()ed, so a burst of traffic (opening a room fires
// several API calls at once) piled up pools until Postgres refused new
// connections — surfacing as "Can't reach database server at localhost:5432"
// on random, unrelated queries. That is a client-side connection leak, not a
// database outage.
//
// A PrismaClient is designed to be long-lived and shared; its pool does the
// per-query multiplexing. Import this instead of constructing your own.
//
// Global `omit` (Bagian 4 upgrade): the two Lark token columns are
// impersonation credentials, so they're excluded from EVERY query by default —
// a query has to opt back in with an explicit `select`/`omit:false` to see
// them (only lib/larkUserToken does). This is the backstop the audit found
// missing: without it, protection relied on every author remembering a
// whitelist `select`, and one `res.json({ user })` would leak the tokens.
// Password is deliberately NOT omitted here — manual login reads it for
// bcrypt.compare — but no endpoint serializes it (verified).
// The cast keeps the shared type as the plain `PrismaClient` every
// `(prisma: PrismaClient)` signature in the codebase expects — the `omit`
// generic would otherwise make this a structurally different type and ripple
// type errors everywhere. The omit is a RUNTIME config (fields are stripped
// from every result object regardless of the compile-time type), so casting the
// type away does NOT weaken the backstop: a stray `res.json(user)` still ships
// no tokens. The one place that needs them (lib/larkUserToken) re-selects them
// explicitly, which overrides the omit at runtime too.
export const prisma = new PrismaClient({
  omit: {
    user: {
      larkUserAccessToken: true,
      larkRefreshToken: true,
    },
  },
}) as unknown as PrismaClient;

// Kept so the many existing `const prisma = getPrisma();` call sites read the
// same as before — they now just receive the shared instance.
export function getPrisma(): PrismaClient {
  return prisma;
}
