/**
 * Fixture-environment guard: fixture rows exist only in `test` and `demo`, and every other
 * environment refuses to write them and cannot read them (AAP 0.5.2 "Fixture environments").
 *
 * `APP_ENV` is one of `test`, `demo`, `staging` or `production`. The seed calls
 * {@link assertFixturesAllowed} before it writes any fixture, and a Prisma client built with
 * {@link fixturesGuardExtension} adds `isFixture: false` to every top-level operation of the four
 * fixture-bearing models — `venue`, `lodging`, `place` and `price_record`.
 *
 * Raw SQL bypasses query extensions, so every `$queryRaw`/`$executeRaw` statement over those
 * tables has to carry {@link fixturePredicate}.
 *
 * @see AAP 0.5.2 for the fixture policy, 0.5.1 for `assertFixturesAllowed()`, 0.8.1 for this file.
 */

import prismaPkg from '@prisma/client';

import type { AppEnv } from '@tablemate/shared';

// Named ESM imports from Prisma's CommonJS package are unreliable under plain Node 22, so the
// namespace is reached through the default import. The alias carries both the values this file
// calls (`sql`, `raw`, `defineExtension`) and the namespace types (`Sql`).
import Prisma = prismaPkg.Prisma;

// ---------------------------------------------------------------------------------------------
// Environment policy (AAP 0.5.2)
// ---------------------------------------------------------------------------------------------

/** The environments that may hold fixture rows (AAP 0.5.2). */
export const FIXTURE_APP_ENVS = ['test', 'demo'] as const satisfies readonly AppEnv[];

/** An environment in which fixture rows are permitted. */
export type FixtureAppEnv = (typeof FIXTURE_APP_ENVS)[number];

/**
 * True when `appEnv` may hold and read fixture rows: `test` and `demo` only (AAP 0.5.2).
 *
 * @param appEnv - The process's `APP_ENV`.
 * @see AAP 0.5.2 for the fixture environments.
 */
export function fixturesAllowed(appEnv: AppEnv): boolean {
  return FIXTURE_APP_ENVS.some((allowed) => allowed === appEnv);
}

/**
 * Raised when fixture data would be written in, or is asked for by, an environment that forbids
 * it, and when the seed is asked to load fixtures there (AAP 0.5.2).
 */
export class FixturesNotAllowedError extends Error {
  /** The environment that refused the fixtures. */
  readonly appEnv: AppEnv;

  /**
   * @param appEnv - The environment that refused the fixtures.
   * @see AAP 0.5.2 for the environments fixtures are allowed in.
   */
  constructor(appEnv: AppEnv) {
    super(`Fixture data is not allowed when APP_ENV=${appEnv} (allowed: test, demo)`);
    this.name = 'FixturesNotAllowedError';
    this.appEnv = appEnv;
    // `super()` does not restore the prototype chain of a subclass of a built-in, so `instanceof`
    // still has to be repaired here.
    Object.setPrototypeOf(this, FixturesNotAllowedError.prototype);
  }
}

/**
 * Throws {@link FixturesNotAllowedError} unless fixtures are permitted in `appEnv`. The seed calls
 * it before writing any fixture row; the guard extension raises the same error on a fixture write
 * (AAP 0.5.2).
 *
 * @param appEnv - The process's `APP_ENV`.
 * @see AAP 0.5.2 for the environments fixtures are allowed in.
 */
export function assertFixturesAllowed(appEnv: AppEnv): void {
  if (!fixturesAllowed(appEnv)) {
    throw new FixturesNotAllowedError(appEnv);
  }
}

// ---------------------------------------------------------------------------------------------
// Raw-SQL predicate (AAP 0.5.2)
// ---------------------------------------------------------------------------------------------

/** The only identifier shape `Prisma.raw` may be given here, which keeps raw SQL un-injectable. */
export const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * The predicate a raw query needs because `$queryRaw` and `$executeRaw` bypass Prisma query
 * extensions: outside `test` and `demo` every raw query over `venue`, `lodging`, `place` or
 * `price_record` must `AND` in `fixturePredicate(appEnv, '<alias>')` for each such table it reads
 * (AAP 0.5.2).
 *
 * @param appEnv - The process's `APP_ENV`.
 * @param alias - The table alias the query uses. It must match {@link SQL_IDENTIFIER}, because it
 *   is interpolated into the SQL text; the column name is fixed here.
 * @returns `TRUE` where fixtures are permitted, otherwise the `is_fixture = false` predicate.
 * @throws RangeError when `alias` is not a plain lower-case SQL identifier.
 * @see AAP 0.5.2 for the fixture policy.
 */
export function fixturePredicate(appEnv: AppEnv, alias: string): Prisma.Sql {
  if (!SQL_IDENTIFIER.test(alias)) {
    throw new RangeError('SQL alias must match /^[a-z_][a-z0-9_]*$/');
  }
  return fixturesAllowed(appEnv) ? Prisma.sql`TRUE` : Prisma.raw(`"${alias}"."is_fixture" = false`);
}

// ---------------------------------------------------------------------------------------------
// Prisma query extension (AAP 0.5.2)
// ---------------------------------------------------------------------------------------------

/** The shape Prisma hands an `$allOperations` handler, narrowed to what the guard reads. */
type GuardOperationArgs = {
  operation: string;
  args: Record<string, unknown> | undefined;
  query: (args: unknown) => Promise<unknown>;
};

/**
 * The operations whose `where` the guard narrows to `isFixture: false`. A write that stores no
 * fixture row is left untouched, and an operation outside this list has no rows to filter.
 */
const FILTERED_OPERATIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when this write's payload sets `isFixture: true` on the row or on any row of a batch. */
function writesFixture(operation: string, args: Record<string, unknown>): boolean {
  switch (operation) {
    case 'create':
    case 'update':
    case 'updateMany':
    case 'updateManyAndReturn':
      return marksFixture(args['data']);
    case 'createMany':
    case 'createManyAndReturn': {
      const data = args['data'];
      return Array.isArray(data) ? data.some(marksFixture) : marksFixture(data);
    }
    case 'upsert':
      return marksFixture(args['create']) || marksFixture(args['update']);
    default:
      return false;
  }
}

function marksFixture(data: unknown): boolean {
  return isRecord(data) && data['isFixture'] === true;
}

/**
 * The `$allOperations` handler the four fixture-bearing models share. Outside `test` and `demo` it
 * refuses a write that would store a fixture row and narrows every read, update and delete to
 * non-fixture rows (AAP 0.5.2).
 */
function guardOperation(appEnv: AppEnv) {
  return async function guard({ operation, args, query }: GuardOperationArgs): Promise<unknown> {
    if (fixturesAllowed(appEnv)) {
      return query(args);
    }

    // `findMany()` and `count()` are called with no arguments at all.
    const operationArgs = args ?? {};

    if (writesFixture(operation, operationArgs)) {
      throw new FixturesNotAllowedError(appEnv);
    }

    if (!FILTERED_OPERATIONS.has(operation)) {
      return query(args);
    }

    // Spreading keeps a unique `where` valid — Prisma accepts extra non-unique filters in a
    // `WhereUniqueInput` — and a caller-supplied `isFixture: true` filter is overwritten, so a
    // fixture row can neither be found nor mutated (AAP 0.5.2).
    const where = operationArgs['where'];
    return query({
      ...operationArgs,
      where: { ...(isRecord(where) ? where : {}), isFixture: false },
    });
  };
}

/**
 * Builds the fixture guard to pass to `client.$extends(...)`.
 *
 * The guard covers top-level operations only, for the four fixture-bearing models: `create`,
 * `createMany`, `createManyAndReturn`, `findUnique`, `findUniqueOrThrow`, `findFirst`,
 * `findFirstOrThrow`, `findMany`, `count`, `aggregate`, `groupBy`, `update`, `updateMany`,
 * `updateManyAndReturn`, `delete`, `deleteMany` and `upsert`. Query extensions do not act on
 * nested `include`/`select` relation reads (a `meetup.findMany({ include: { venue: true } })` reads
 * venues unguarded), on nested writes, or on raw SQL. That is defence in depth, not the only
 * defence: outside `test` and `demo` the seed never loads a fixture row, and raw SQL carries
 * {@link fixturePredicate} (AAP 0.5.2).
 *
 * @param appEnv - The process's `APP_ENV`.
 * @returns The Prisma extension to apply to the client.
 * @see AAP 0.5.2 for the fixture policy.
 */
export function fixturesGuardExtension(appEnv: AppEnv) {
  const guard = guardOperation(appEnv);

  return Prisma.defineExtension({
    name: 'tablemate-fixtures-guard',
    query: {
      venue: { $allOperations: guard },
      lodging: { $allOperations: guard },
      place: { $allOperations: guard },
      priceRecord: { $allOperations: guard },
    },
  });
}
