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
// A global `omit` used to sit here, stripping two stored third-party OAuth
// tokens from every query result as a backstop against a stray
// `res.json({ user })` leaking them. Those columns are gone, so the omit went
// with them — but the reasoning is worth keeping: if a credential-shaped
// column is ever added to User, exclude it here rather than relying on every
// author remembering a whitelist `select`. Password is deliberately NOT
// omitted — manual login reads it for bcrypt.compare — but no endpoint
// serializes it (verified).
export const prisma = new PrismaClient();

// Kept so the many existing `const prisma = getPrisma();` call sites read the
// same as before — they now just receive the shared instance.
export function getPrisma(): PrismaClient {
  return prisma;
}
