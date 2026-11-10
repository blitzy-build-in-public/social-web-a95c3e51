import prismaPkg from '@prisma/client';

import type { AppEnv } from '@tablemate/shared';

import { fixturesGuardExtension } from './fixtures-guard.ts';
/** The Prisma namespace, re-exported so no other workspace has to import `@prisma/client` values. */
export import Prisma = prismaPkg.Prisma;
const PrismaClientCtor = prismaPkg.PrismaClient;
/** Options for {@link createPrismaClient}. */
export interface CreatePrismaClientOptions {
  /** The PostgreSQL connection string. It is read from `DATABASE_URL` by the host process and never logged. */
  databaseUrl: string;
  /** The process's `APP_ENV`, which decides how strictly the fixture guard filters (AAP 0.5.2). */
  appEnv: AppEnv;
  /** The Prisma log levels to emit, `['warn', 'error']` by default. `'query'` is deliberately absent from the union: query logs carry bound parameters, which can hold ciphertext, email addresses or coordinates. */
  log?: readonly ('error' | 'warn' | 'info')[];
}
/** Builds the process's Prisma client with the fixture guard applied. */
export function createPrismaClient(options: CreatePrismaClientOptions) {
  if (typeof options.databaseUrl !== 'string' || options.databaseUrl.length === 0) {
    throw new TypeError('createPrismaClient requires a non-empty databaseUrl');
  }
  return new PrismaClientCtor({
    datasourceUrl: options.databaseUrl,
    log: [...(options.log ?? ['warn', 'error'])],
  }).$extends(fixturesGuardExtension(options.appEnv));
}
/** The guarded client {@link createPrismaClient} returns, taken from the factory itself so the guard extension's type is never restated here. */
export type DbClient = ReturnType<typeof createPrismaClient>;
/** The interactive-transaction client: what `db.$transaction(async (tx) => ...)` hands its callback. */
export type DbTx = Parameters<Parameters<DbClient['$transaction']>[0]>[0];
/** The raw-SQL surface a helper needs, satisfied by both {@link DbClient} and {@link DbTx}. */
export type RawSqlClient = Pick<DbClient, '$queryRaw' | '$executeRaw'>;
const UNIQUE_VIOLATION_CODE = 'P2002';
const RAW_QUERY_FAILURE_CODE = 'P2010';
const POSTGRES_UNIQUE_VIOLATION = '23505';
interface KnownRequestErrorFields {
  code: string;
  meta: Record<string, unknown> | null;
}
const UNMODELLED_UNIQUE_INDEXES: Readonly<
  Record<string, { readonly modelName: string; readonly columns: readonly string[] }>
> = {
  meetup_open_pair_key: { modelName: 'Meetup', columns: ['initiator_id', 'recipient_id'] },
  check_in_pass_key: { modelName: 'CheckIn', columns: ['meetup_id', 'user_id'] },
  dispute_open_key: { modelName: 'Dispute', columns: ['meetup_id'] },
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function knownRequestError(error: unknown): KnownRequestErrorFields | null {
  // `instanceof` first, then a duck-typed check: a second generated client in the same process (a test harness beside the app) hands back errors from its own class copy.
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return { code: error.code, meta: isRecord(error.meta) ? error.meta : null };
  }
  if (!isRecord(error)) {
    return null;
  }
  const candidate = error as { name?: unknown; code?: unknown; meta?: unknown };
  return candidate.name === 'PrismaClientKnownRequestError' && typeof candidate.code === 'string'
    ? { code: candidate.code, meta: isRecord(candidate.meta) ? candidate.meta : null }
    : null;
}
function targetMatches(target: unknown, constraint: string): boolean {
  if (typeof target === 'string') {
    return target === constraint;
  }
  return Array.isArray(target) && target.some((entry) => entry === constraint);
}
function matchesUnmodelledIndex(meta: Record<string, unknown> | null, constraint: string): boolean {
  const index = UNMODELLED_UNIQUE_INDEXES[constraint];
  if (index === undefined || meta === null || meta['modelName'] !== index.modelName) {
    return false;
  }
  const target = meta['target'];
  return (
    Array.isArray(target) &&
    index.columns.every((column) =>
      target.some((entry) => typeof entry === 'string' && entry.includes(column)),
    )
  );
}
/** True when `error` is a unique-constraint violation, optionally of a named constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const known = knownRequestError(error);
  if (known === null) {
    return false;
  }
  if (known.code === UNIQUE_VIOLATION_CODE) {
    return (
      constraint === undefined ||
      targetMatches(known.meta?.['target'], constraint) ||
      matchesUnmodelledIndex(known.meta, constraint)
    );
  }
  if (known.code === RAW_QUERY_FAILURE_CODE) {
    const meta = known.meta;
    if (meta === null || meta['code'] !== POSTGRES_UNIQUE_VIOLATION) {
      return false;
    }
    if (constraint === undefined) {
      return true;
    }
    const message = meta['message'];
    return typeof message === 'string' && message.includes(constraint);
  }
  return false;
}
