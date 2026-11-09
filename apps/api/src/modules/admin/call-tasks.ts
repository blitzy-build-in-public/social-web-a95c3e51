/**
 * The automated-call queue and one operator's resolution of a task in it.
 *
 * {@link listCallTasks} reads one page of what an operator still has to act on — the `needs_review` and
 * `unreachable` tasks no operator has resolved yet — and {@link resolveCallTask} records one outcome on a
 * `menu_prices` task: `completed` stores the prices the operator was told on the phone or approves the `phone_quote`
 * records a call left for review, `refused` closes the task, `do_not_call` flags the place and stops every other task
 * of it, and `unreachable` records that the operator could not obtain prices either.
 *
 * Whichever outcome a resolution records, the task leaves the dialing path with no `blockedReason`, and the tasks a
 * `do_not_call` stops are cleared with it. The checks run in the order the contract lists them: a task that is not
 * `needs_review` or `unreachable`, or that an operator already resolved, is `422`, because terminal tasks stay
 * terminal, and a task whose one target the guarded client can no longer read is `422` rather than a `500`. A
 * resolution runs in one transaction behind the operator's own write fence and takes `SELECT … FOR UPDATE` on the
 * task row first, so two operators resolving one task serialize and the second cannot store a second outcome.
 *
 * Time arrives as the `now` argument, never from a clock of this file's own, and no log line carries a phone number,
 * a price or a summary.
 */

import { randomUUID } from 'node:crypto';

import { Prisma } from '@tablemate/db';
import type { CallTask, DbClient, DbTx, Place } from '@tablemate/db';
import type { Logger } from '@tablemate/server-core';
import {
  CURSOR_INSTANT_FORMAT,
  decodeNullableKeysetCursor,
  encodeNullableKeysetCursor,
  OperatorCallTaskOutcome,
} from '@tablemate/shared';
import type {
  AdminCallTaskDto,
  AdminCallTasksQuery,
  AdminCallTasksResponse,
  CallAttemptState,
  CallTaskStatus,
  ExtractedFields,
  NullableKeysetCursorPosition,
  PriceItemInput,
  ResolveCallTask,
} from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { transact } from '../outbox/write.ts';
import type { TransactServices } from '../outbox/write.ts';

/** What {@link resolveCallTask} needs: the transaction's own services type, because the state change runs through `transact` with the operator's write fence. */
export type CallTaskServices = TransactServices;

/**
 * What {@link listCallTasks} needs: the guarded client, narrowed to what one page of the queue is read with, and the
 * process logger the one warning a row the contract cannot carry is reported through.
 */
export interface CallTaskQueueReader {
  /** The guarded Prisma client: the `callTask` delegate for the page and its count, and the raw reader for the exact `outcome_at` of the row a page ended on ({@link exactOutcomeAt}). */
  readonly db: Pick<DbClient, 'callTask' | '$queryRaw'>;
  readonly logger: Pick<Logger, 'warn'>;
}

/** The page one read of the queue returns when the query names no `limit`, the quantity the contract's first answer already carried. */
export const ADMIN_CALL_TASKS_LIMIT = 200;

/** The two task statuses an operator still has to resolve (AAP 0.5.3). */
const OPERATOR_QUEUE_STATUSES: CallTaskStatus[] = ['needs_review', 'unreachable'];

/** The statuses a `do_not_call` cancels on the place's other tasks (AAP 0.5.3). */
const CANCELLABLE_STATUSES: CallTaskStatus[] = [
  'queued',
  'in_progress',
  'needs_review',
  'unreachable',
];

/** The attempt states whose live call a `do_not_call` ends, so the relay closes it (AAP 0.5.3). */
const LIVE_ATTEMPT_STATES: CallAttemptState[] = [
  'dispatching',
  'dispatch_unknown',
  'dialing',
  'in_progress',
];

const CALL_TASK_RESOLVED = 'call_task_resolved';

// A queue row the contract cannot carry, because neither its place nor its lodging is readable,
// logged under its own event so the defect is visible rather than silent.
const CALL_TASK_TARGET_UNRESOLVED = 'call_task_target_unresolved';

/** The scalar fields one extracted menu item contributes to the flat record, in listed order. */
const EXTRACTED_ITEM_FIELDS = [
  'dish',
  'priceText',
  'amountMinor',
  'currency',
  'confirmed',
] as const;

/**
 * The currencies whose ICU currency digits are not their ISO 4217 minor-unit exponent: in Node 22.23.4
 * `maximumFractionDigits` resolves to 0 for both, while ISO 4217 — and so the price pipeline — gives each an
 * exponent of 2.
 */
const ISO_MINOR_UNIT_OVERRIDES: Readonly<Record<string, number>> = { COP: 2, IDR: 2 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The flat, scalar view of one menu call's extracted fields, or `null` when the payload is not a menu result or holds
 * no usable value. The relay records a menu call's extraction as `{ kind: 'menu_prices', items: [...] }` — a list
 * rather than a map — and the operator's form reads one flat record, so each item becomes `<slot>.<field>` entries
 * (`coffee.amountMinor`). An item without a usable slot is skipped and a field whose value is not a scalar is left
 * out, so a half-written payload still shows what it does hold.
 */
export function flattenExtractedFields(value: unknown): ExtractedFields | null {
  if (!isRecord(value)) {
    return null;
  }
  const items: unknown = value['items'];
  if (value['kind'] !== 'menu_prices' || !Array.isArray(items)) {
    return null;
  }
  const fields: Record<string, string | number | boolean | null> = {};
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const slot: unknown = item['slot'];
    if (typeof slot !== 'string' || slot === '') {
      continue;
    }
    for (const field of EXTRACTED_ITEM_FIELDS) {
      const held: unknown = item[field];
      if (
        typeof held === 'string' ||
        typeof held === 'number' ||
        typeof held === 'boolean' ||
        held === null
      ) {
        fields[`${slot}.${field}`] = held;
      }
    }
  }
  return Object.keys(fields).length === 0 ? null : fields;
}

/**
 * An item name in the form the suggestion estimate groups by: NFKC-normalized, lower-cased, inner whitespace
 * collapsed and the ends trimmed. `packages/db/seed/seed.ts` applies the same rule to a seeded record and
 * `apps/workers/src/menus/extract-items.ts` must apply it to an extracted one, because the estimate keeps one record
 * per `(itemCategory, normalizedName)` and a different spelling would show one dish as two.
 */
function normalizeItemName(itemName: string): string {
  return itemName.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * How many minor units one major unit of `currency` holds: the ISO 4217 exponent the workers' `price-parse.ts` parses
 * a menu price with and the relay's `menu-prices.ts` reads from the same rule, so all three agree on every price this
 * route can store. Derived from ICU, which resolves 2 for USD, EUR, MXN and THB, and corrected for the two launch
 * currencies whose ICU currency digits are not their ISO 4217 exponent.
 */
function currencyMinorDigits(currency: string): number {
  const override = ISO_MINOR_UNIT_OVERRIDES[currency];
  if (override !== undefined) {
    return override;
  }
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits;
  // ICU resolves a digit count for every currency, so the ISO 4217 default is unreachable here.
  return digits ?? 2;
}

/**
 * `localAmountMinor` in whole USD cents, rounded half up. The computation stays in `Prisma.Decimal`: a float loses
 * cents at the scale of an IDR amount, and stored money is always integer USD cents.
 */
function toUsdCents(
  localAmountMinor: number,
  currency: string,
  usdPerUnit: Prisma.Decimal,
): number {
  return new Prisma.Decimal(localAmountMinor)
    .div(new Prisma.Decimal(10).pow(currencyMinorDigits(currency)))
    .mul(usdPerUnit)
    .mul(100)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber();
}

/** The UTC day `now` falls in, as an `@db.Date` column stores it: its own UTC midnight. */
function utcDay(now: Date): Date {
  return new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

/**
 * What one queue row reads: the task's own columns, its one business target and its latest attempt. The attempt is
 * taken by `startedAt` descending with `id` breaking a same-instant tie; a stripped lodging attempt carries a null
 * summary and null extracted fields, which is what `data-expiry` leaves behind.
 */
const CALL_TASK_SELECT = {
  id: true,
  kind: true,
  status: true,
  attempts: true,
  nextAttemptAt: true,
  blockedReason: true,
  place: { select: { name: true, cityId: true } },
  lodging: { select: { name: true, cityId: true } },
  callAttempts: {
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: { outcome: true, summary: true, extractedFields: true },
  },
} satisfies Prisma.CallTaskSelect;

export type CallTaskQueueRow = Prisma.CallTaskGetPayload<{ select: typeof CALL_TASK_SELECT }>;

/**
 * One queue row as the operator contract carries it, field by field and never spread, so a column added to
 * `CallTask`, `Place`, `Lodging` or `CallAttempt` cannot reach an operator without a change here.
 * `extractedFields` is flattened for a menu task only, because a lodging verification's content does not outlive its
 * claim.
 *
 * `null` when neither `row.place` nor `row.lodging` resolves, and never a value invented for one: `cityId` is a
 * `CitySlug`, whose pattern the empty string fails, so a fallback would answer a body the response schema cannot
 * carry — and the route would raise `500 internal_error` in place of a DTO — while `targetName` would name no
 * business at all. `call_task_one_target_chk` keeps both relations from being absent at once, but a row this mapper
 * cannot answer for is still reachable: outside `test` and `demo` the guarded client keeps a fixture business out of
 * what a caller sees, so a production database still holding a seeded business can leave its task unrepresentable.
 * The callers leave such a row out and report it, rather than inventing the name and city it does not have.
 */
export function toAdminCallTaskDto(row: CallTaskQueueRow): AdminCallTaskDto | null {
  const target = row.place ?? row.lodging;
  if (target === null) {
    return null;
  }
  const latest = row.callAttempts[0];
  return {
    id: row.id,
    kind: row.kind,
    targetName: target.name,
    cityId: target.cityId,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    blockedReason: row.blockedReason,
    lastOutcome: latest?.outcome ?? null,
    lastSummary: latest?.summary ?? null,
    extractedFields:
      row.kind === 'menu_prices' ? flattenExtractedFields(latest?.extractedFields ?? null) : null,
  };
}

/**
 * Decodes a queue cursor this file issued. A cursor is a value the client sends back, so the shared codec parses it
 * strictly: canonical base64url of a `{t,i}` payload that `NullableKeysetCursor` accepts — an instant in exactly the
 * form {@link CURSOR_INSTANT_FORMAT} writes, or `null` for the tasks that have no outcome, and a UUID — and nothing
 * else.
 *
 * @throws {AppError} `invalid_field` (400) for anything else, which is the contract's answer for a bad query value.
 */
function decodeQueueCursor(value: string): NullableKeysetCursorPosition {
  const position = decodeNullableKeysetCursor(value);
  if (position === null) {
    throw new AppError('invalid_field', 'The cursor is malformed.');
  }
  return position;
}

/**
 * The keyset half of the read: every row ordered after `position` by `(outcomeAt asc, id asc)` with a task that has
 * no outcome last. A missing instant sorts last, so a cursor taken from a row with none continues inside the block of
 * those rows by id alone, while a cursor with an instant continues with the tasks that reached an outcome later, the
 * tasks that reached it at the same instant under a larger id, and then that whole block of tasks without an outcome.
 */
function afterCursor(position: NullableKeysetCursorPosition): Prisma.CallTaskWhereInput {
  if (position.instant === null) {
    return { outcomeAt: null, id: { gt: position.id } };
  }
  return {
    OR: [
      { outcomeAt: { gt: position.instant } },
      { outcomeAt: position.instant, id: { gt: position.id } },
      { outcomeAt: null },
    ],
  };
}

/**
 * The exact stored `outcome_at` of one task, as {@link CURSOR_INSTANT_FORMAT} renders it, or `null` when that task
 * has no outcome.
 *
 * A string and not the row's own `Date`: Prisma answers a `timestamptz(6)` column as a `Date`, which holds
 * milliseconds, while a row whose `outcome_at` the database's own `now()` wrote keeps microseconds. A cursor built
 * from a truncated value would leave the equality branch of {@link afterCursor} unable to match the boundary row at
 * all, and every row sharing its millisecond would be skipped from the middle of the list. PostgreSQL therefore
 * formats the value here, as `meetups/queries.ts` reads the `created_at` its own cursor continues from.
 *
 * @throws Error when the row is gone, which no request in the pilot can cause and which leaves no cursor to continue
 *   from.
 */
async function exactOutcomeAt(db: Pick<DbClient, '$queryRaw'>, id: string): Promise<string | null> {
  const rows = await db.$queryRaw<{ exact: string | null }[]>`
    SELECT to_char("outcome_at" AT TIME ZONE 'UTC', ${CURSOR_INSTANT_FORMAT}) AS "exact"
      FROM "call_task"
     WHERE "id" = ${id}::uuid
  `;
  const exact = rows[0]?.exact;
  if (exact === undefined) {
    throw new Error('The call task a page ended on is no longer there.');
  }
  return exact;
}

/** The exact instant is read only when another page follows, so the last page costs nothing extra. */
async function nextQueueCursor(
  db: Pick<DbClient, '$queryRaw'>,
  boundary: CallTaskQueueRow | undefined,
): Promise<string | null> {
  if (boundary === undefined) {
    return null;
  }
  return encodeNullableKeysetCursor({
    instant: await exactOutcomeAt(db, boundary.id),
    id: boundary.id,
  });
}

/**
 * One page of the operator's call queue, oldest outcome first, narrowed by the request's filters.
 *
 * Both kinds are listed, so an operator sees a lodging verification's state too; only a `menu_prices` task is
 * resolvable from here, because a claim is resolved through its own route. The order is the one the read states:
 * `outcomeAt` ascending, the task id breaking a same-instant tie, and a task with no outcome yet last. This queue
 * holds the tasks no dial is coming for, so the call-and-menu priority rule, the distance bands and the near locked
 * meetup `calls/priority.ts` applies to `menu-ingest` and `call-dispatch` order that path and not this read.
 *
 * The filter is one `AND` list so each piece stands on its own and the fixtures guard's own `AND` composes with it
 * rather than replacing it, which is what keeps a business the guard hides out of both the page and the count.
 * `limit + 1` rows are read, so the presence of a next page is known without a second query: the extra row proves
 * another page exists and is not returned, and the cursor is encoded from the page's last row read whether or not its
 * DTO could be built, so paging can never stand still on a row it cannot carry.
 *
 * `total` counts the tasks the filters match with the cursor ignored. A row whose target {@link toAdminCallTaskDto}
 * cannot carry is left out of the answer and reported under {@link CALL_TASK_TARGET_UNRESOLVED} with its own id, so
 * the reply is always a body the response schema accepts while the defect stays visible — and such a row makes
 * `items` one element shorter than `total`.
 *
 * @throws {AppError} `invalid_field` (400) for a malformed cursor.
 */
export async function listCallTasks(
  services: CallTaskQueueReader,
  query: AdminCallTasksQuery,
): Promise<AdminCallTasksResponse> {
  const cursor = query.cursor === undefined ? null : decodeQueueCursor(query.cursor);
  const limit = query.limit ?? ADMIN_CALL_TASKS_LIMIT;
  const search = query.q;
  const filters: Prisma.CallTaskWhereInput[] = [
    // The two statuses an operator still has to resolve, or the one the request narrowed to
    // (AAP 0.5.3).
    { status: query.status === undefined ? { in: OPERATOR_QUEUE_STATUSES } : query.status },
    // Null before any result exists and `agent` once the pipeline recorded one; only an operator's
    // own resolution takes a task out of the queue (AAP 0.5.3).
    { OR: [{ resolvedBy: null }, { resolvedBy: { not: 'operator' } }] },
  ];
  if (query.kind !== undefined) {
    filters.push({ kind: query.kind });
  }
  if (search !== undefined) {
    // The target's own name, matched case-insensitively: a menu task names a place and a
    // verification task a lodging, and no task carries both.
    filters.push({
      OR: [
        { place: { is: { name: { contains: search, mode: 'insensitive' } } } },
        { lodging: { is: { name: { contains: search, mode: 'insensitive' } } } },
      ],
    });
  }
  // Taken before the keyset half joins the list, and as a copy of it: `total` is how many tasks the
  // request's filters match, never how many of them follow the cursor.
  const matching: Prisma.CallTaskWhereInput = { AND: [...filters] };
  if (cursor !== null) {
    filters.push(afterCursor(cursor));
  }
  const [rows, total] = await Promise.all([
    services.db.callTask.findMany({
      where: { AND: filters },
      select: CALL_TASK_SELECT,
      orderBy: [{ outcomeAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      take: limit + 1,
    }),
    services.db.callTask.count({ where: matching }),
  ]);
  const page = rows.slice(0, limit);
  const boundary = rows.length > limit ? page[page.length - 1] : undefined;
  const items: AdminCallTaskDto[] = [];
  for (const row of page) {
    const dto = toAdminCallTaskDto(row);
    if (dto === null) {
      // No DTO, because the contract has no field to carry a task whose business is unreadable: the
      // row is reported and left out rather than answered with a name and a city it does not have.
      services.logger.warn({ event: CALL_TASK_TARGET_UNRESOLVED, taskId: row.id });
      continue;
    }
    items.push(dto);
  }
  return { items, total, nextCursor: await nextQueueCursor(services.db, boundary) };
}

type LockedCallTask = Pick<
  CallTask,
  'id' | 'kind' | 'status' | 'resolvedBy' | 'placeId' | 'lodgingId'
>;

/**
 * Locks one task row for the rest of the transaction and returns the columns the resolution decides on, or `null`
 * when no such task exists. Raw SQL, because Prisma has no equivalent of `FOR UPDATE`; the id binds as a parameter
 * cast to `uuid`.
 */
async function lockCallTask(tx: DbTx, taskId: string): Promise<LockedCallTask | null> {
  const rows = await tx.$queryRaw<LockedCallTask[]>(Prisma.sql`
    SELECT "id", "kind", "status", "resolved_by" AS "resolvedBy", "place_id" AS "placeId",
           "lodging_id" AS "lodgingId"
      FROM "call_task"
     WHERE "id" = ${taskId}::uuid
       FOR UPDATE
  `);
  return rows[0] ?? null;
}

/**
 * Refuses a resolution whose target the guarded client can no longer read.
 *
 * The task's one business target is read back through the same guarded client the rest of the transaction uses,
 * because a to-one relation read is not a value this file holds: outside `test` and `demo` the guarded client
 * narrows `place` and `lodging` to `is_fixture = false`, so a task on a seeded business has no name, no city and no
 * source a price could be attributed to. Refusing every outcome on such a task answers the contract's `422` rather
 * than half-applying one, and the update below — whose `where` the guard narrows the same way — would otherwise
 * match no row and surface as a `500`.
 *
 * @throws {AppError} `invalid_outcome` (422) when neither id names a readable row, which covers both a task with no
 *   target at all and a target the guard hides.
 */
async function assertTargetReadable(tx: DbTx, task: LockedCallTask): Promise<void> {
  const { placeId, lodgingId } = task;
  const target =
    placeId !== null
      ? await tx.place.findUnique({ where: { id: placeId }, select: { id: true } })
      : lodgingId !== null
        ? await tx.lodging.findUnique({ where: { id: lodgingId }, select: { id: true } })
        : null;
  if (target === null) {
    throw new AppError('invalid_outcome', "The call task's target is no longer readable.");
  }
}

/**
 * The URL a stored price is attributed to, from the first source the place has: the number the operator called, its
 * menu link, its website, or its OpenStreetMap object. A place with none of the four refuses the resolution rather
 * than store a price with no provenance, which a suggestion may not show.
 */
function sourceUrlForPlace(
  place: Pick<Place, 'phone' | 'website' | 'menuUrl' | 'osmType' | 'osmId'>,
): string {
  if (place.phone !== null) {
    return `tel:${place.phone}`;
  }
  const link = place.menuUrl ?? place.website;
  if (link !== null) {
    return link;
  }
  if (place.osmType !== null && place.osmId !== null) {
    return `https://www.openstreetmap.org/${place.osmType}/${place.osmId.toString()}`;
  }
  throw new AppError('invalid_outcome', 'The place has no source a price could be attributed to.');
}

/**
 * The rate to convert a price in `currency` on `day`: the latest `FxRate` at or before that day, or the unit rate for
 * USD, which the table need not carry. A currency with no rate at all refuses the resolution, so nothing is stored
 * and no price is guessed.
 *
 * @throws {AppError} `fx_rate_unavailable` (503) when no row exists at or before `day`: only the `fx-refresh` job
 *   writes that table and it runs daily at 00:30 UTC, so a stack younger than its first run holds no row for a
 *   non-USD currency, and the contract's `422 invalid_outcome` describes a refused outcome rather than a dependency
 *   still to arrive. The throw stays inside the caller's transaction, so the resolution stores nothing.
 */
async function usdRateFor(tx: DbTx, currency: string, day: Date) {
  if (currency === 'USD') {
    return { date: day, usdPerUnit: new Prisma.Decimal(1) };
  }
  const row = await tx.fxRate.findFirst({
    where: { currency, date: { lte: day } },
    orderBy: { date: 'desc' },
    select: { date: true, usdPerUnit: true },
  });
  if (row === null) {
    throw new AppError(
      'fx_rate_unavailable',
      `No FX rate for ${currency} at or before the capture day. Enter the price in USD, or retry once the daily FX refresh has stored a rate.`,
    );
  }
  return row;
}

/**
 * Stores the prices an operator was told on the phone as one capture batch of `operator_entry` records: one call is
 * one batch, and each record is approved as it is stored, because the operator is the review. No row is stored
 * without a `sourceUrl` and a `priceUsdCents`.
 */
async function storeOperatorPrices(
  tx: DbTx,
  placeId: string,
  prices: readonly PriceItemInput[],
  now: Date,
): Promise<void> {
  const place = await tx.place.findFirst({
    where: { id: placeId },
    select: { phone: true, website: true, menuUrl: true, osmType: true, osmId: true },
  });
  if (place === null) {
    throw new AppError('invalid_outcome', 'The place is no longer readable.');
  }
  const sourceUrl = sourceUrlForPlace(place);
  const captureBatchId = randomUUID();
  const day = utcDay(now);
  const rows: Prisma.PriceRecordCreateManyInput[] = [];
  for (const item of prices) {
    const rate = await usdRateFor(tx, item.currency, day);
    rows.push({
      placeId,
      captureBatchId,
      itemName: item.name,
      normalizedName: normalizeItemName(item.name),
      itemCategory: item.category,
      alcoholic: item.alcoholic,
      perPerson: item.perPerson,
      ticketType: item.ticketType,
      priceText: item.priceText,
      localAmountMinor: item.localAmountMinor,
      currency: item.currency,
      priceUsdCents: toUsdCents(item.localAmountMinor, item.currency, rate.usdPerUnit),
      source: 'operator_entry',
      sourceUrl,
      capturedAt: now,
      fxDate: rate.date,
      confidence: null,
      reviewStatus: 'approved',
      isFixture: false,
    });
  }
  await tx.priceRecord.createMany({ data: rows });
}

/**
 * The `completed` outcome: store the prices the operator was told, or, when none were supplied, approve the
 * `phone_quote` records the call left for review — a call's prices are stored but held out of suggestions until an
 * operator approves them.
 *
 * An empty `prices` array is read as no prices at all, and a `completed` with nothing to store is refused rather
 * than closing the task with the place still unpriced.
 */
async function completeTask(
  tx: DbTx,
  task: Pick<CallTask, 'placeId'>,
  prices: readonly PriceItemInput[] | undefined,
  now: Date,
): Promise<void> {
  if (task.placeId === null) {
    throw new AppError('invalid_outcome', 'A menu task without a place has no prices to complete.');
  }
  if (prices !== undefined && prices.length > 0) {
    await storeOperatorPrices(tx, task.placeId, prices, now);
    return;
  }
  const approved = await tx.priceRecord.updateMany({
    where: { placeId: task.placeId, source: 'phone_quote', reviewStatus: 'needs_review' },
    data: { reviewStatus: 'approved' },
  });
  if (approved.count === 0) {
    throw new AppError(
      'invalid_outcome',
      'No prices to complete with: none were supplied and no phone quote awaits review.',
    );
  }
}

/**
 * The `do_not_call` side effects: flag the place and stop every other task of it, marking a live call's attempt
 * superseded so the relay speaks its closing line and ends the call.
 *
 * The cancelled tasks are neither `resolved_by` anyone nor given an `outcome_at`: nobody resolved them, and the
 * metrics count them in the cancelled lifecycle panel. Their `blocked_reason` is cleared with the status: a task the
 * place asked to stop calling is cancelled rather than blocked, and a reason written while a dial was still possible
 * would describe a call that is never coming.
 */
async function stopCallingPlace(tx: DbTx, task: Pick<CallTask, 'id' | 'placeId'>): Promise<void> {
  if (task.placeId === null) {
    throw new AppError(
      'invalid_outcome',
      'A menu task without a place has no number to stop calling.',
    );
  }
  const placeId = task.placeId;
  await tx.place.update({ where: { id: placeId }, data: { doNotCall: true } });
  const others = await tx.callTask.findMany({
    where: { placeId, id: { not: task.id }, status: { in: CANCELLABLE_STATUSES } },
    select: { id: true },
  });
  if (others.length === 0) {
    return;
  }
  const taskIds = others.map((other) => other.id);
  await tx.callAttempt.updateMany({
    where: { callTaskId: { in: taskIds }, state: { in: LIVE_ATTEMPT_STATES } },
    data: { superseded: true },
  });
  await tx.callTask.updateMany({
    where: { id: { in: taskIds } },
    data: { status: 'cancelled', blockedReason: null },
  });
}

/**
 * Records one operator outcome on a `menu_prices` call task. Every outcome clears the task's `blockedReason`, because
 * a task an operator resolved has left the dialing path whatever status it now stands in, and the answer reports it
 * that way. Nothing else about a resolution moves: the checks above and their order, the errors, the `do_not_call`
 * side effects and the DTO are unaffected.
 *
 * @throws {AppError} `invalid_outcome` (422) for an outcome outside the operator's four, for a lodging task, for a
 *   task that is not in the queue, for a `completed` with no prices to store, and for a task whose target is no
 *   longer readable — checked before the outcome is applied — which rolls the resolution back rather than storing an
 *   outcome the reply could not carry; `fx_rate_unavailable` (503) for a `completed` whose prices name a currency
 *   with no `FxRate` row at or before the capture day, which likewise stores nothing and leaves the task in the
 *   queue; `not_found` (404) for an unknown task id.
 */
export async function resolveCallTask(
  services: CallTaskServices,
  operatorId: string,
  taskId: string,
  body: ResolveCallTask,
  now: Date,
): Promise<AdminCallTaskDto> {
  const parsed = OperatorCallTaskOutcome.safeParse(body.outcome);
  if (!parsed.success) {
    throw new AppError('invalid_outcome');
  }
  const outcome = parsed.data;
  const resolved = await transact(
    services,
    async (tx) => {
      const task = await lockCallTask(tx, taskId);
      if (task === null) {
        throw new AppError('not_found');
      }
      // A claim owns its verification call's result: only `POST /admin/lodging-claims/:id/resolve`
      // may set it, so every outcome on a lodging task is refused here (AAP 0.5.3).
      if (task.kind !== 'menu_prices') {
        throw new AppError('invalid_outcome');
      }
      // Only the two statuses an operator still has to act on, and only while no operator has:
      // `completed`, `refused`, `do_not_call` and `cancelled` are terminal (AAP 0.5.3).
      if (!OPERATOR_QUEUE_STATUSES.includes(task.status) || task.resolvedBy === 'operator') {
        throw new AppError('invalid_outcome');
      }
      // Every outcome needs a target the client can still read, so the check runs before the switch
      // rather than inside an arm (AAP 0.5.2): a target the guarded client hides refuses the
      // resolution with the contract's `422`, where the update below would match no row and answer
      // `500`, and no arm applies its side effects first.
      await assertTargetReadable(tx, task);
      switch (outcome) {
        case 'completed':
          await completeTask(tx, task, body.prices, now);
          break;
        case 'do_not_call':
          await stopCallingPlace(tx, task);
          break;
        case 'refused':
        case 'unreachable':
          // The status alone carries these two; `unreachable` records that the operator could not
          // obtain prices either.
          break;
      }
      // The update answers with the refreshed row, so the reply is the task as it now stands (AAP
      // 0.5.4) and no second read is needed. `blockedReason` is cleared for every outcome, including
      // the three whose effect is the status alone: the task has left the dialing path, and the
      // status the operator applied is what the row now means, so a reason written while its dial was
      // still out of reach would contradict the state the operator sees (AAP 0.5.3, 0.5.7).
      const row = await tx.callTask.update({
        where: { id: taskId },
        data: { status: outcome, resolvedBy: 'operator', blockedReason: null, outcomeAt: now },
        select: CALL_TASK_SELECT,
      });
      const dto = toAdminCallTaskDto(row);
      if (dto === null) {
        // The net the mapper's own contract requires, not an arm this path takes: the target above
        // was just proven readable, so a row the contract still cannot carry is a defect, and
        // failing closed keeps an outcome the reply could not carry out of the database (AAP 0.5.3,
        // 0.5.4).
        throw new AppError('invalid_outcome', "The call task's target is no longer readable.");
      }
      return dto;
    },
    { fenceUserId: operatorId },
  );
  services.logger.info({ event: CALL_TASK_RESOLVED, taskId, outcome });
  return resolved;
}
