/**
 * `@tablemate/db`: the database layer, and the only entry point to it (AAP 0.5.1) — the client
 * factory, the fixture guard and the PostGIS helpers, never `@prisma/client` itself.
 */
export * from './client.ts';
export * from './fixtures-guard.ts';
export * from './spatial.ts';
// Type-only: the generated model and `PrismaClient` types, with no `@prisma/client` runtime import.
export type * from '@prisma/client';
// Explicit, so it outranks the star exports: `Prisma` must stay usable as a value (`Prisma.sql`).
export { Prisma } from './client.ts';
