/**
 * The single Prisma client factory for Tablemate, with the fixture guard applied to every client.
 *
 * Every process builds its database access from {@link createPrismaClient}, so none of them holds
 * an unguarded client (AAP 0.5.1, 0.5.2).
 *
 * Prisma's CommonJS package cannot be pulled in by name reliably under plain Node 22 ESM, so the
 * whole module is reached through the default import below. `Prisma` is then re-exported from here,
 * carrying both the values (`sql`, `raw`, `join`, `Decimal`, `DbNull`, `JsonNull`,
 * `PrismaClientKnownRequestError`) and the namespace types (`Sql`, `VenueWhereInput`, ...), while
 * `PrismaClient` itself stays private. `@tablemate/db`'s barrel re-exports the client and model
 * types.
 *
 * @see AAP 0.5.1 for the database client shared by `api` and `workers`, 0.5.2 for the fixture
 *   guard, 0.5.3 for the transactions and row locks built on {@link DbTx}, 0.11.2 for the
 *   parameterized-SQL rule that {@link RawSqlClient} serves, and 0.8.1 for this file.
 */

import prismaPkg from '@prisma/client';

import type { AppEnv } from '@tablemate/shared';

import { fixturesGuardExtension } from './fixtures-guard.ts';

/**
 * The Prisma namespace, re-exported so no other workspace has to import `@prisma/client` values
 * (only this file and `fixtures-guard.ts` do). `export import` emits
 * `export var Prisma = prismaPkg.Prisma`, which keeps the value meaning and the type meaning in one
 * binding under both Node ESM and TypeScript.
 */
export import Prisma = prismaPkg.Prisma;

/**
 * The client constructor, deliberately not exported: a caller cannot build an unguarded client, so
 * every query in every process passes the fixture guard (AAP 0.5.2).
 */
const PrismaClientCtor = prismaPkg.PrismaClient;

/** Options for {@link createPrismaClient}. */
export interface CreatePrismaClientOptions {
  /** The PostgreSQL connection string. It is read from `DATABASE_URL` by the host process and never logged. */
  databaseUrl: string;
  /** The process's `APP_ENV`, which decides how strictly the fixture guard filters (AAP 0.5.2). */
  appEnv: AppEnv;
  /**
   * The Prisma log levels to emit; defaults to `['warn', 'error']`.
   *
   * `'query'` is deliberately absent from the union: query logs carry bound parameters, which can
   * hold ciphertext, email addresses or coordinates, so they are never on (AAP 0.11.1 redaction).
   */
  log?: readonly ('error' | 'warn' | 'info')[];
}

/**
 * Builds the process's Prisma client with the fixture guard applied.
 *
 * This is the only place a Prisma client is constructed: `apps/api/src/app.ts`,
 * `apps/workers/src/main.ts`, `packages/db/seed/seed.ts`, the `apps/api/test/support/*` helpers and
 * `tests/system/*` all call it and pass their own `DATABASE_URL`. The caller owns the client's
 * lifecycle and calls `$connect` and `$disconnect` itself.
 *
 * @param options - The connection string, the process's `APP_ENV` and the optional log levels.
 * @returns The guarded Prisma client, carrying every model delegate plus `$transaction`,
 *   `$queryRaw` and `$executeRaw`.
 * @throws TypeError when `databaseUrl` is not a non-empty string. The value itself is never part
 *   of the message, so a connection string cannot reach a log through this error.
 * @see AAP 0.5.1 and 0.5.2.
 */
export function createPrismaClient(options: CreatePrismaClientOptions) {
  if (typeof options.databaseUrl !== 'string' || options.databaseUrl.length === 0) {
    throw new TypeError('createPrismaClient requires a non-empty databaseUrl');
  }

  return new PrismaClientCtor({
    datasourceUrl: options.databaseUrl,
    log: [...(options.log ?? ['warn', 'error'])],
  }).$extends(fixturesGuardExtension(options.appEnv));
}

/**
 * The guarded client {@link createPrismaClient} returns, taken from the factory itself so the guard
 * extension's type is never restated here.
 */
export type DbClient = ReturnType<typeof createPrismaClient>;

/**
 * The interactive-transaction client: what `db.$transaction(async (tx) => ...)` hands its callback.
 *
 * Every domain transition runs inside that callback, and the row locks it takes
 * (`SELECT ... FOR UPDATE`) go through `tx.$queryRaw` tagged templates (AAP 0.3.2, 0.5.3, 0.11.2).
 * The last `$transaction` overload is the function one, which is the one this picks.
 */
export type DbTx = Parameters<Parameters<DbClient['$transaction']>[0]>[0];

/**
 * The raw-SQL surface a helper needs, satisfied by both {@link DbClient} and {@link DbTx}.
 *
 * The spatial helpers in `./spatial.ts` and the language-model spend reservation in
 * `packages/server-core/src/llm/spend.ts` take this instead of the whole client, so they work
 * inside and outside a transaction. Statements are always tagged templates, never concatenated
 * strings (AAP 0.11.2).
 */
export type RawSqlClient = Pick<DbClient, '$queryRaw' | '$executeRaw'>;

// ---------------------------------------------------------------------------------------------
// Unique-violation detection
// ---------------------------------------------------------------------------------------------

/** Prisma's code for a unique-constraint violation it mapped itself. */
const UNIQUE_VIOLATION_CODE = 'P2002';

/** Prisma's code for a failure it could not map — the shape a raw SQL error arrives in. */
const RAW_QUERY_FAILURE_CODE = 'P2010';

/** PostgreSQL's SQLSTATE for a unique violation, carried in a `P2010`'s `meta.code`. */
const POSTGRES_UNIQUE_VIOLATION = '23505';

/** The `code` and `meta` a known request error carries, however the error was constructed. */
interface KnownRequestErrorFields {
  code: string;
  meta: Record<string, unknown> | null;
}

/**
 * The hand-added indexes of the init migration, which Prisma cannot report by name.
 *
 * A `P2002` names the columns a unique index covers, never the index: a modelled `@@unique` comes
 * through as its field list, and these partial and expression indexes come through as the columns
 * they span — the pair index as the fragments `LEAST(initiator_id`, `recipient_id)`, … So a route
 * asking `isUniqueViolation(err, 'meetup_open_pair_key')` would never match without this mapping,
 * and could not tell `409 meetup_exists` from any other collision on the table (AAP 0.5.4).
 */
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

/** Reads a known request error's code and metadata, whatever produced the error object. */
function knownRequestError(error: unknown): KnownRequestErrorFields | null {
  // `instanceof` first, then a duck-typed check: a second generated client in the same process (a
  // test harness beside the app) hands back errors from its own class copy.
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

/** True when `meta.target` names `constraint`: the constraint itself, or one of the reported fields. */
function targetMatches(target: unknown, constraint: string): boolean {
  if (typeof target === 'string') {
    return target === constraint;
  }
  return Array.isArray(target) && target.some((entry) => entry === constraint);
}

/**
 * True when a `P2002` reports every column of the named index of {@link UNMODELLED_UNIQUE_INDEXES}
 * for that index's own model. `includes` rather than equality, because the expression index reports
 * its columns inside fragments (`LEAST(initiator_id`, `recipient_id)`).
 */
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

/**
 * True when `error` is a unique-constraint violation, optionally of a named constraint.
 *
 * The routes turn each of these into its own `409`:
 *
 * - `nullifier_used` — the `SpentNullifier` primary key.
 * - `meetup_exists` — the pair's open-meetup index, `meetup_open_pair_key`.
 * - `already_checked_in` — an attendee's second passing check-in, `check_in_pass_key`.
 * - `dispute_open` — a second open dispute on a meetup, `dispute_open_key`.
 * - `StripeEvent` and `VoiceCallbackEvent` dedupe, where the insert collides with the row that
 *   already recorded the same event.
 *
 * Two shapes are recognised. `P2002` is what the client raises for a constraint it mapped, with
 * `meta.target` holding either the constraint name or the field list. `P2010` is the unmapped
 * failure a raw query raises, carrying PostgreSQL's SQLSTATE `23505` in `meta.code` and the failed
 * key in `meta.message`. Because a `P2002` never names the hand-added partial and expression
 * indexes, `constraint` also matches those by their reported columns (see
 * {@link UNMODELLED_UNIQUE_INDEXES}).
 *
 * @param error - The unknown a `catch` block holds.
 * @param constraint - Optional index, constraint or field name the violation must name.
 * @returns True for a matching unique violation, false for anything else. Never throws.
 * @see AAP 0.3.2 for webhook and callback dedupe, 0.5.3 for the conflict rules.
 */
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
