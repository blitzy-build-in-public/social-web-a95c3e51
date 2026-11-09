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

/** Throws {@link FixturesNotAllowedError} unless fixtures are permitted in `appEnv` (AAP 0.5.2). */
export function assertFixturesAllowed(appEnv: AppEnv): void {
  if (!fixturesAllowed(appEnv)) {
    throw new FixturesNotAllowedError(appEnv);
  }
}

/** The only identifier shape `Prisma.raw` may be given here, which keeps raw SQL un-injectable. */
export const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * The predicate a raw read over `venue`, `lodging`, `place` or `price_record` needs, because
 * `$queryRaw` and `$queryRawUnsafe` are reads the guard leaves alone: outside `test` and `demo`
 * every fixture row must be filtered out (AAP 0.5.2).
 */
export function fixturePredicate(appEnv: AppEnv, alias: string): Prisma.Sql {
  if (!SQL_IDENTIFIER.test(alias)) {
    throw new RangeError('SQL alias must match /^[a-z_][a-z0-9_]*$/');
  }
  return fixturesAllowed(appEnv) ? Prisma.sql`TRUE` : Prisma.raw(`"${alias}"."is_fixture" = false`);
}

type GuardOperationArgs = {
  model: string;
  operation: string;
  args: Record<string, unknown> | undefined;
  query: (args: unknown) => Promise<unknown>;
};

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

const SELECTION_FIELDS = ['select', 'include'] as const;

const CREATE_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'upsert',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_WRITE_PAYLOAD_DEPTH = 8;

function writesFixture(operation: string, args: Record<string, unknown>): boolean {
  switch (operation) {
    case 'create':
    case 'createMany':
    case 'createManyAndReturn':
    case 'update':
    case 'updateMany':
    case 'updateManyAndReturn':
      // `createMany` and `createManyAndReturn` hand their rows over as an array, the rest as one
      // object; the walk reads either.
      return marksFixture(args['data']);
    case 'upsert':
      return marksFixture(args['create']) || marksFixture(args['update']);
    default:
      return false;
  }
}

function marksFixture(value: unknown, depth = 0): boolean {
  if (depth > MAX_WRITE_PAYLOAD_DEPTH) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => marksFixture(entry, depth + 1));
  }
  if (!isRecord(value)) {
    return false;
  }
  const flag = value['isFixture'];
  if (flag === true || (isRecord(flag) && flag['set'] === true)) {
    return true;
  }
  return Object.values(value).some((entry) => marksFixture(entry, depth + 1));
}

type Relation = {
  readonly targetModel: string;
  readonly isList: boolean;
  readonly isRequired: boolean;
};

type RelationStep = { readonly field: string; readonly isList: boolean };

type ReturnCheck = {
  readonly owner: readonly RelationStep[];
  readonly field: string;
  readonly required: boolean;
  readonly added: boolean;
};

type SchemaGraph = {
  readonly relations: ReadonlyMap<string, ReadonlyMap<string, Relation>>;
  readonly fixtureModels: ReadonlySet<string>;
};

const UNREADABLE_DATAMODEL =
  'fixtures-guard: Prisma.dmmf.datamodel.models could not be read, so the guard cannot tell which relations reach a fixture row';

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

type WhereHolder = { readonly exclusions: RelationStep[][] };

type WalkPosition = {
  readonly modelName: string;
  readonly args: Record<string, unknown>;
  readonly path: readonly RelationStep[];
  readonly holder: WhereHolder | null;
  readonly returns: ReturnCheck[] | null;
};

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

function exclusionClause(path: readonly RelationStep[]): Record<string, unknown> {
  return {
    NOT: path.reduceRight<Record<string, unknown>>(
      (inner, step) => ({ [step.field]: step.isList ? { some: inner } : { is: inner } }),
      { isFixture: true },
    ),
  };
}

function andWith(existing: unknown, clauses: readonly Record<string, unknown>[]): unknown[] {
  const caller: readonly unknown[] = Array.isArray(existing)
    ? existing
    : isRecord(existing)
      ? [existing]
      : [];
  return [...caller, ...clauses];
}

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

function countRelationArgs(entry: unknown): unknown {
  if (!isRecord(entry)) {
    return entry === true ? { where: { isFixture: false } } : entry;
  }
  const where = entry['where'];
  return { ...entry, where: { ...(isRecord(where) ? where : {}), isFixture: false } };
}

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

const FIXTURE_COLUMN = /is_fixture/i;

const FIXTURE_COLUMN_CONSTRAINED = /is_fixture"?\s*(?:=\s*false|is\s+false)/i;

const FIXTURE_COLUMN_SET = /is_fixture"?\s*(?:=\s*true|is\s+true|is\s+not\s+false)/i;

function rawWritesFixture(text: string): boolean {
  return (
    FIXTURE_COLUMN.test(text) &&
    (!FIXTURE_COLUMN_CONSTRAINED.test(text) || FIXTURE_COLUMN_SET.test(text))
  );
}

type RawStatementArgs = {
  readonly args: unknown;
  query: (args: unknown) => Promise<unknown>;
};

function rawStatementText(args: unknown): string | null {
  if (Array.isArray(args)) {
    return templateText(args[0]);
  }
  if (!isRecord(args)) {
    return templateText(args);
  }
  for (const key of ['sql', 'text', 'query'] as const) {
    const text = args[key];
    if (typeof text === 'string') {
      return text;
    }
  }
  return templateText(args['strings']);
}

function templateText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  return Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string')
    ? value.join('')
    : null;
}

function guardRawStatement(appEnv: AppEnv) {
  return async function guardRaw({ args, query }: RawStatementArgs): Promise<unknown> {
    // Where fixtures are permitted the handler is a pass-through: `test` and `demo` write fixture
    // rows freely (AAP 0.5.2).
    if (!fixturesAllowed(appEnv)) {
      const text = rawStatementText(args);
      if (text !== null && rawWritesFixture(text)) {
        throw new FixturesNotAllowedError(appEnv);
      }
    }
    return query(args);
  };
}

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
    // The write check stands alone and comes first: a write that stores a fixture row — its own row
    // or the row of a nested write inside its payload — is refused, never narrowed into a no-op
    // (AAP 0.5.2).
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

/** Builds the fixture guard to pass to `client.$extends(...)`. */
export function fixturesGuardExtension(appEnv: AppEnv) {
  const guard = guardOperation(appEnv);
  const guardRaw = guardRawStatement(appEnv);
  return Prisma.defineExtension({
    name: 'tablemate-fixtures-guard',
    query: {
      $allModels: { $allOperations: guard },
      // `$executeRaw` and `$executeRawUnsafe` are keys of their own, not model operations, so a raw
      // write reaches the guard only from here (AAP 0.5.2).
      $executeRaw: guardRaw,
      $executeRawUnsafe: guardRaw,
    },
  });
}
