/**
 * Fixture-environment guard: fixture rows exist only in `test` and `demo`, and every other
 * environment refuses to write them and cannot read them (AAP 0.5.2 "Fixture environments").
 *
 * The seed calls {@link assertFixturesAllowed} before it writes any fixture; a client built with
 * {@link fixturesGuardExtension} narrows every operation of the four fixture-bearing models —
 * `venue`, `lodging`, `place` and `price_record` — to `isFixture: false`, and filters every relation
 * read reaching those tables from any model. Raw SQL needs {@link fixturePredicate}.
 *
 * @see AAP 0.5.2 for the fixture policy, 0.5.1 for `assertFixturesAllowed()`, 0.8.1 for this file.
 */

import prismaPkg from '@prisma/client';

import type { AppEnv } from '@tablemate/shared';

// Named ESM imports from Prisma's CommonJS package are unreliable under plain Node 22, so the
// namespace is reached through the default import, which carries `sql`, `raw` and `defineExtension`.
import Prisma = prismaPkg.Prisma;

/** The environments that may hold fixture rows (AAP 0.5.2). */
export const FIXTURE_APP_ENVS = ['test', 'demo'] as const satisfies readonly AppEnv[];

/** An environment in which fixture rows are permitted. */
export type FixtureAppEnv = (typeof FIXTURE_APP_ENVS)[number];

/** True when `appEnv` may hold and read fixture rows: `test` and `demo` only (AAP 0.5.2). */
export function fixturesAllowed(appEnv: AppEnv): boolean {
  return FIXTURE_APP_ENVS.some((allowed) => allowed === appEnv);
}

/**
 * Raised when fixture data would be written in, or is asked for by, an environment that forbids it,
 * and when the seed is asked to load fixtures there (AAP 0.5.2).
 */
export class FixturesNotAllowedError extends Error {
  /** The environment that refused the fixtures. */
  readonly appEnv: AppEnv;
  /** @param appEnv - The environment that refused the fixtures. */
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
 * Throws {@link FixturesNotAllowedError} unless fixtures are permitted in `appEnv` (AAP 0.5.2). The
 * seed calls it before writing any fixture row; the guard raises the same error on a fixture write.
 *
 * @param appEnv - The process's `APP_ENV`.
 * @throws FixturesNotAllowedError when `appEnv` is neither `test` nor `demo`.
 */
export function assertFixturesAllowed(appEnv: AppEnv): void {
  if (!fixturesAllowed(appEnv)) {
    throw new FixturesNotAllowedError(appEnv);
  }
}

/** The only identifier shape `Prisma.raw` may be given here, which keeps raw SQL un-injectable. */
export const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * The predicate a raw query needs because `$queryRaw` and `$executeRaw` bypass Prisma query
 * extensions: outside `test` and `demo` every raw query over `venue`, `lodging`, `place` or
 * `price_record` must `AND` in `fixturePredicate(appEnv, '<alias>')` for each such table it reads
 * (AAP 0.5.2).
 *
 * @param appEnv - The process's `APP_ENV`.
 * @param alias - The table alias, which must match {@link SQL_IDENTIFIER} because it is interpolated
 *   into the SQL text; the column name is fixed here.
 * @returns `TRUE` where fixtures are permitted, otherwise the `is_fixture = false` predicate.
 * @throws RangeError when `alias` is not a plain lower-case SQL identifier.
 */
export function fixturePredicate(appEnv: AppEnv, alias: string): Prisma.Sql {
  if (!SQL_IDENTIFIER.test(alias)) {
    throw new RangeError('SQL alias must match /^[a-z_][a-z0-9_]*$/');
  }
  return fixturesAllowed(appEnv) ? Prisma.sql`TRUE` : Prisma.raw(`"${alias}"."is_fixture" = false`);
}

/** The shape Prisma hands an `$allOperations` handler, narrowed to what the guard reads. */
type GuardOperationArgs = {
  model: string;
  operation: string;
  args: Record<string, unknown> | undefined;
  query: (args: unknown) => Promise<unknown>;
};

/** The operations whose `where` the guard narrows to `isFixture: false`; an operation outside this
 * list has no rows to filter. */
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

/** The two keys a relation selection lives under. */
const SELECTION_FIELDS = ['select', 'include'] as const;

/** The operations that store a row and hand it back, so a fixture relation their return value would
 * carry has to be judged on it: none of them has a `where` to exclude the row instead. */
const CREATE_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
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

/**
 * True when a write payload stores a fixture row: the literal `isFixture: true` and the operation
 * input `isFixture: { set: true }` that `update`, `updateMany`, `updateManyAndReturn` and `upsert`
 * take — a form the guard misses is a fixture row stored, so both are recognised.
 */
function marksFixture(data: unknown): boolean {
  if (!isRecord(data)) {
    return false;
  }
  const value = data['isFixture'];
  return value === true || (isRecord(value) && value['set'] === true);
}

/** One relation field of a model: where it points, whether it holds many rows, and whether it is
 * required — the last of which decides whether a fixture row reached through it is fatal. */
type Relation = {
  readonly targetModel: string;
  readonly isList: boolean;
  readonly isRequired: boolean;
};

/** One step of a relation path: the field to traverse, and whether it holds many rows. */
type RelationStep = { readonly field: string; readonly isList: boolean };

/**
 * One to-one relation read on the row an operation returns: `owner` is the record that holds the
 * relation, relative to the returned row, `field` the relation to judge there, and `required` says
 * whether a fixture row found there refuses the operation or is dropped. `added` is true when the
 * guard put `isFixture` into that field's `select`, so the key it added is removed again afterwards.
 */
type ReturnCheck = {
  readonly owner: readonly RelationStep[];
  readonly field: string;
  readonly required: boolean;
  readonly added: boolean;
};

/** The schema as the guard walks it: every model's relation fields, and the models with `isFixture`. */
type SchemaGraph = {
  readonly relations: ReadonlyMap<string, ReadonlyMap<string, Relation>>;
  readonly fixtureModels: ReadonlySet<string>;
};

/** Raised when the datamodel cannot be read, from which no relation graph can be built. */
const UNREADABLE_DATAMODEL =
  'fixtures-guard: Prisma.dmmf.datamodel.models could not be read, so the guard cannot tell which relations reach a fixture row';

/**
 * Builds {@link SchemaGraph} once per client from the client's own datamodel, which cannot drift from
 * `schema.prisma`; an unreadable or empty datamodel throws rather than let fixture rows through, since
 * a graph without models would leave every arm of the guard inert.
 */
function buildSchemaGraph(): SchemaGraph {
  const relations = new Map<string, ReadonlyMap<string, Relation>>();
  const fixtureModels = new Set<string>();
  const { models } = Prisma.dmmf.datamodel;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error(UNREADABLE_DATAMODEL);
  }
  for (const model of models as readonly Prisma.DMMF.Model[]) {
    const modelRelations = new Map<string, Relation>();
    for (const field of model.fields as readonly Prisma.DMMF.Field[]) {
      if (field.kind === 'object') {
        modelRelations.set(field.name, {
          targetModel: field.type,
          isList: field.isList,
          isRequired: field.isRequired,
        });
      }
      if (field.name === 'isFixture') {
        fixtureModels.add(model.name);
      }
    }
    relations.set(model.name, modelRelations);
  }
  return { relations, fixtureModels };
}

/** The exclusions collected for one set of `where`-carrying args, relative to its own row. */
type WhereHolder = { readonly exclusions: RelationStep[][] };

/** One position of the walk: what it reads, the args it rewrites, its enclosing holder, and the
 * return checks it collects — null where the position is not a pure to-one path from a returned row. */
type WalkPosition = {
  readonly modelName: string;
  readonly args: Record<string, unknown>;
  readonly path: readonly RelationStep[];
  readonly holder: WhereHolder | null;
  readonly returns: ReturnCheck[] | null;
};

/**
 * Rewrites the `select` and `include` of one read, and of every relation below it; nothing is written
 * to, and a read it changes nothing in is handed back as the caller's own object.
 */
function rewriteArgs(graph: SchemaGraph, position: WalkPosition): Record<string, unknown> {
  const { args } = position;
  let nextArgs = args;
  for (const key of SELECTION_FIELDS) {
    const selection = args[key];
    if (!isRecord(selection)) {
      continue;
    }
    // `_count` is Prisma's own key rather than a relation of the model, and Prisma takes it under
    // either selection key, so it is dispatched on the field name alone.
    let next: Record<string, unknown> = selection;
    for (const [field, value] of Object.entries(selection)) {
      const rewritten =
        field === '_count'
          ? rewriteCount(graph, position.modelName, value)
          : rewriteRelation(graph, position, field, value);
      if (rewritten === value) {
        continue;
      }
      next = next === selection ? { ...selection } : next;
      next[field] = rewritten;
    }
    if (next === selection) {
      continue;
    }
    nextArgs = nextArgs === args ? { ...args } : nextArgs;
    nextArgs[key] = next;
  }
  return nextArgs;
}

/**
 * Rewrites one selected relation of a model and everything below it; a scalar and a shape Prisma
 * rejects stay untouched. A to-many relation's args take a `where`, so a read into a fixture table is
 * filtered there and those args become the holder every relation below them excludes from. A to-one
 * relation's args take no `where`, so the row that owns it is excluded from its holder instead, which
 * makes a to-one read into a fixture table leave the owning row out — and on a create-family row,
 * which nothing can leave out afterwards, the relation is recorded for judging on the returned row.
 */
function rewriteRelation(
  graph: SchemaGraph,
  position: WalkPosition,
  field: string,
  value: unknown,
): unknown {
  const relation = graph.relations.get(position.modelName)?.get(field);
  const args = value === true ? {} : isRecord(value) ? value : undefined;
  if (relation === undefined || args === undefined) {
    return value;
  }
  const step: RelationStep = { field, isList: relation.isList };
  const fixtureTarget = graph.fixtureModels.has(relation.targetModel);
  const child = { ...position, modelName: relation.targetModel, args };
  if (relation.isList) {
    const holder: WhereHolder = { exclusions: [] };
    // A to-many step leaves the returned row, so nothing below it is a pure to-one path from it.
    const rewritten = rewriteArgs(graph, { ...child, path: [], holder, returns: null });
    return narrowArgs(rewritten, fixtureTarget, holder.exclusions);
  }
  const path = [...position.path, step];
  if (fixtureTarget) {
    position.holder?.exclusions.push(path);
  }
  const returned = fixtureTarget ? position.returns : null;
  if (returned === null) {
    const rewritten = rewriteArgs(graph, { ...child, path });
    return rewritten === args ? value : rewritten;
  }
  const fetched = fetchFixtureKey(args);
  returned.push({
    owner: position.path,
    field,
    required: relation.isRequired,
    added: fetched.added,
  });
  const rewritten = rewriteArgs(graph, { ...child, args: fetched.args, path });
  return rewritten === args ? value : rewritten;
}

/**
 * Narrows args that carry a `where`: `isFixture: false` where their rows are fixture rows, and an
 * `AND`ed exclusion for every relation path that would reach a fixture row.
 */
function narrowArgs(
  args: Record<string, unknown>,
  filterFixtures: boolean,
  exclusions: readonly RelationStep[][],
): Record<string, unknown> {
  if (!filterFixtures && exclusions.length === 0) {
    return args;
  }
  const where = args['where'];
  const nextWhere: Record<string, unknown> = { ...(isRecord(where) ? where : {}) };
  if (filterFixtures) {
    // Spreading keeps a unique `where` valid and overwrites a caller-supplied `isFixture: true`
    // filter, so a fixture row can neither be found nor mutated (AAP 0.5.2).
    nextWhere['isFixture'] = false;
  }
  if (exclusions.length > 0) {
    nextWhere['AND'] = andWith(nextWhere['AND'], exclusions.map(exclusionClause));
  }
  return { ...args, where: nextWhere };
}

/**
 * The `NOT` clause that leaves out every row leading to a fixture row along `path`: a step through a
 * to-one relation is `{ is: ... }`, through a to-many one `{ some: ... }`, and the last step is the
 * fixture relation itself.
 */
function exclusionClause(path: readonly RelationStep[]): Record<string, unknown> {
  return {
    NOT: path.reduceRight<Record<string, unknown>>(
      (inner, step) => ({ [step.field]: step.isList ? { some: inner } : { is: inner } }),
      { isFixture: true },
    ),
  };
}

/** Appends `clauses` to a caller's `AND`, which Prisma takes as one filter or as a list of them. */
function andWith(existing: unknown, clauses: readonly Record<string, unknown>[]): unknown[] {
  const caller: readonly unknown[] = Array.isArray(existing)
    ? existing
    : isRecord(existing)
      ? [existing]
      : [];
  return [...caller, ...clauses];
}

/**
 * Rewrites a `_count` selection so its figures leave out fixture children, under either selection
 * key: a relation reading a fixture table carries the predicate in its `where`, and `_count: true` is
 * spelled out because Prisma expands it to every to-many relation of the model.
 */
function rewriteCount(graph: SchemaGraph, modelName: string, value: unknown): unknown {
  if (value === true) {
    return countEveryRelation(graph, modelName);
  }
  const counted: Record<string, unknown> = isRecord(value) ? value : {};
  const selection = isRecord(counted['select']) ? counted['select'] : undefined;
  if (selection === undefined) {
    return value;
  }
  let next = selection;
  for (const [field, entry] of Object.entries(selection)) {
    const relation = graph.relations.get(modelName)?.get(field);
    if (relation === undefined || !graph.fixtureModels.has(relation.targetModel)) {
      continue;
    }
    const rewritten = countRelationArgs(entry);
    if (rewritten === entry) {
      continue;
    }
    next = next === selection ? { ...selection } : next;
    next[field] = rewritten;
  }
  return next === selection ? value : { ...counted, select: next };
}

/**
 * Spells `_count: true` out as the to-many relations Prisma counts for it, so the fixture ones can
 * be given a `where`; only a relation into a fixture table is filterable.
 */
function countEveryRelation(graph: SchemaGraph, modelName: string): unknown {
  const relations = graph.relations.get(modelName);
  if (relations === undefined) {
    return true;
  }
  const select: Record<string, unknown> = {};
  for (const [field, relation] of relations) {
    if (relation.isList) {
      select[field] = graph.fixtureModels.has(relation.targetModel)
        ? { where: { isFixture: false } }
        : true;
    }
  }
  const filtered = Object.values(select).some((entry) => entry !== true);
  return filtered ? { select } : true;
}

/** Narrows one `_count` entry to the non-fixture children, keeping any `where` the caller wrote. */
function countRelationArgs(entry: unknown): unknown {
  if (!isRecord(entry)) {
    return entry === true ? { where: { isFixture: false } } : entry;
  }
  const where = entry['where'];
  return { ...entry, where: { ...(isRecord(where) ? where : {}), isFixture: false } };
}

/**
 * The args a return check reads `isFixture` through: a `select` that leaves the field out gets it
 * added to a copy of the args — the caller's own args are never touched — while `true`, an `include`
 * and a `select` that names the field all fetch it already.
 */
function fetchFixtureKey(args: Record<string, unknown>): {
  readonly args: Record<string, unknown>;
  readonly added: boolean;
} {
  const select = args['select'];
  if (!isRecord(select) || 'isFixture' in select) {
    return { args, added: false };
  }
  return { args: { ...args, select: { ...select, isFixture: true } }, added: true };
}

/** The record a path of to-one steps reaches from `row`, or undefined where a step is missing. */
function recordAt(
  row: unknown,
  path: readonly RelationStep[],
): Record<string, unknown> | undefined {
  let current: unknown = row;
  for (const step of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[step.field];
  }
  return isRecord(current) ? current : undefined;
}

/**
 * Judges the to-one fixture relations of the row or rows an operation returned, in walk order, and
 * hands the row back (AAP 0.5.2): a fixture row there is dropped where the relation is optional, and
 * refuses the operation with {@link FixturesNotAllowedError} where it is required — after the row is
 * stored, because a create-family operation has no `where` to exclude a row with and Prisma filters
 * no to-one relation read. A key the guard added to judge with is removed again, so a caller sees the
 * selection it asked for.
 *
 * @param appEnv - The process's `APP_ENV`, which the refusal reports.
 * @param result - What the operation resolved to, a row or `createManyAndReturn`'s rows.
 * @param checks - The return checks the walk recorded for this operation.
 * @returns The same result, with every optional fixture relation dropped from it.
 * @throws FixturesNotAllowedError when a required relation holds a fixture row.
 */
function judgeFixtureReturns(
  appEnv: AppEnv,
  result: unknown,
  checks: readonly ReturnCheck[],
): unknown {
  for (const row of Array.isArray(result) ? result : [result]) {
    for (const check of checks) {
      const owner = recordAt(row, check.owner);
      const related = owner === undefined ? undefined : owner[check.field];
      if (owner === undefined || !isRecord(related)) {
        continue;
      }
      if (related['isFixture'] === true) {
        if (check.required) {
          throw new FixturesNotAllowedError(appEnv);
        }
        owner[check.field] = null;
      } else if (check.added) {
        delete related['isFixture'];
      }
    }
  }
  return result;
}

/**
 * The `$allOperations` handler every model shares. Outside `test` and `demo` it refuses a write that
 * would store a fixture row, narrows every read, update and delete of a fixture table to non-fixture
 * rows, filters fixture rows out of every relation read that reaches those tables, and judges the
 * to-one fixture relations the row a create-family operation hands back carries (AAP 0.5.2).
 *
 * @param appEnv - The process's `APP_ENV`.
 * @returns The handler Prisma calls for every model operation.
 * @throws FixturesNotAllowedError when a write stores a fixture row, or when a created or upserted
 *   row carries a required relation into a fixture table.
 * @throws Error when `appEnv` forbids fixtures and Prisma's datamodel cannot be read.
 */
function guardOperation(appEnv: AppEnv) {
  // The graph is read once per client; where fixtures are allowed it is not needed, and the handler
  // is a pass-through: `test` and `demo` read and write fixture rows freely (AAP 0.5.2).
  const graph = fixturesAllowed(appEnv) ? null : buildSchemaGraph();
  return async function guard({
    model,
    operation,
    args,
    query,
  }: GuardOperationArgs): Promise<unknown> {
    if (graph === null) {
      return query(args);
    }
    // `findMany()` and `count()` are called with no arguments at all.
    const operationArgs = args ?? {};
    const fixtureModel = graph.fixtureModels.has(model);
    // The write check stands alone and comes first: a write that stores a fixture row is refused,
    // never narrowed into a no-op (AAP 0.5.2).
    if (fixtureModel && writesFixture(operation, operationArgs)) {
      throw new FixturesNotAllowedError(appEnv);
    }
    const holder: WhereHolder = { exclusions: [] };
    // A create-family operation has no `where` to exclude a fixture relation's row with, so the
    // selection its return value reads is walked for those relations and the row is judged once it
    // arrives (AAP 0.5.2).
    const returns: ReturnCheck[] | null = CREATE_OPERATIONS.has(operation) ? [] : null;
    const position = { modelName: model, args: operationArgs, path: [], holder, returns };
    const rewritten = rewriteArgs(graph, position);
    const result = FILTERED_OPERATIONS.has(operation)
      ? await query(narrowArgs(rewritten, fixtureModel, holder.exclusions))
      : await query(rewritten);
    return returns === null ? result : judgeFixtureReturns(appEnv, result, returns);
  };
}

/**
 * Builds the fixture guard to pass to `client.$extends(...)`.
 *
 * Registered for every model, it acts on an operation in one of four ways (AAP 0.5.2):
 *
 * - **A write that stores a fixture row is refused**, as {@link FixturesNotAllowedError}: `create`,
 *   `createMany`, `createManyAndReturn`, `update`, `updateMany`, `updateManyAndReturn` and `upsert`,
 *   in either input form Prisma takes for the field.
 * - **An operation over a fixture table is narrowed to non-fixture rows**: `findUnique`,
 *   `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `findMany`, `count`, `aggregate`,
 *   `groupBy`, `update`, `updateMany`, `updateManyAndReturn`, `delete`, `deleteMany` and `upsert`
 *   carry `isFixture: false` in their `where`, whatever the caller wrote there.
 * - **Every relation read that reaches a fixture table is filtered**, wherever it sits in a `select`
 *   or `include` and whichever model it starts from: a to-many read returns only non-fixture children,
 *   and a `_count` of such a relation — written `_count: true` or `_count: { select: { ... } }`, under
 *   either selection key — counts only those; a to-one read cannot carry a predicate (Prisma rejects a
 *   `where` on a to-one relation read), so the row that owns the relation is left out instead.
 * - **A created or upserted row hands no fixture relation back**: on `create`, `createMany`,
 *   `createManyAndReturn` and `upsert` a to-one relation read into a fixture table is judged on the
 *   row the operation returns — it is `null` where the schema makes the relation optional, and where
 *   it is required the operation is refused with {@link FixturesNotAllowedError} after the row is
 *   stored, because none of those four has a `where` to exclude the owning row with and Prisma
 *   filters no to-one relation read. The key the guard adds to a `select` to judge with is removed
 *   from the returned row again, and the caller's own args are never mutated.
 *
 * What stays outside the guard's reach: raw SQL bypasses query extensions and needs
 * {@link fixturePredicate}; and nested writes (`data: { venue: { create: ... } }`) are not inspected.
 *
 * @param appEnv - The process's `APP_ENV`.
 * @returns The Prisma extension to apply to the client.
 * @throws FixturesNotAllowedError when a write stores a fixture row, or when a created or upserted
 *   row carries a required relation into a fixture table.
 * @throws Error when `appEnv` forbids fixtures and Prisma's datamodel cannot be read.
 */
export function fixturesGuardExtension(appEnv: AppEnv) {
  const guard = guardOperation(appEnv);

  return Prisma.defineExtension({
    name: 'tablemate-fixtures-guard',
    query: {
      $allModels: { $allOperations: guard },
    },
  });
}
