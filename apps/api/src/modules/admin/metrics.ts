/**
 * The operator dashboard's metrics and the language-model re-enable.
 *
 * Every meetup, funnel and count figure comes from one aggregate over `meetup` joined to `venue`, ranged on
 * `meetup.starts_at`, and no figure is counted twice. Completion reads `lockedAt` and `bothCheckedInAt` and never
 * `status`, so a later hold loss, `no_fault` resolution or late-cancel compensation cannot rewrite the rate.
 *
 * The dashboard is read-only, and time arrives as the `now` argument — the route passes `request.receivedAt` — never
 * from the process or SQL `now()`. Three measures are live rather than range-bound because their tables carry no
 * meetup timestamp, and the unlinked events the claim measures and signups read survive account erasure.
 *
 * Nothing here returns a user id, a handle, an email address, a coordinate or a row that was not named field by
 * field, and no log line carries a row, a reason or any other value.
 */

import { Prisma, SQL_IDENTIFIER, fixturePredicate, geoColumn, withinMeters } from '@tablemate/db';
import type { DbClient } from '@tablemate/db';
import { createRedisSuspensionStore } from '@tablemate/server-core';
import type { ApiEnv, Logger, SuspensionRedis, SuspensionStore } from '@tablemate/server-core';
import {
  CHECK_IN_CLOSES_AFTER_MINUTES,
  DAY_MS,
  FRESHNESS_ONLINE_DAYS,
  FRESHNESS_PHONE_OPERATOR_DAYS,
  MINUTE_MS,
  PlaceCategory,
  SUGGESTION_RADIUS_METERS,
} from '@tablemate/shared';
import type {
  AdminLlmSuspension,
  AnalyticsEventName,
  BlockedReason,
  CallAttemptOutcome,
  MetricsDto,
  MetricsQuery,
  OperatorClaimOutcome,
} from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';

/**
 * What {@link computeMetrics} needs from the API's composition root: a narrowed declaration rather than an import of
 * the app's services type, which lives in `app.ts` and satisfies this shape structurally.
 */
export interface AdminMetricsServices {
  /** The guarded Prisma client; only its raw, parameterized read surface is used. */
  readonly db: Pick<DbClient, '$queryRaw'>;
  /** The API's validated configuration (AAP 0.6.2): the environment, the caps and the thresholds. */
  readonly env: AdminMetricsEnv;
  /** The process logger: the warning a read that cannot reach the suspension flag raises, the warning and the one success line the operator's re-enable writes. */
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  /** The language-model suspension flag, when the composition root exposes it directly. Preferred over {@link AdminMetricsServices.redis}, because it is the store the relay writes. */
  readonly suspension?: SuspensionStore | undefined;
  /** The process's Redis connection, from which the suspension store is built when `suspension` is absent: the client itself, or the connection object the app holds under `client`. */
  readonly redis?: SuspensionRedis | { readonly client: SuspensionRedis } | null | undefined;
}

/**
 * The API configuration the dashboard reports: `APP_ENV` decides whether fixture rows are visible, the two caps are
 * drawn against, and the two thresholds are the pilot's reference lines.
 */
export type AdminMetricsEnv = Pick<
  ApiEnv,
  | 'APP_ENV'
  | 'CAP_CALLS_PER_CITY_DAY'
  | 'capLlmMicrosPerCityDay'
  | 'PILOT_LOCK_RATE_THRESHOLD'
  | 'PILOT_COMPLETION_THRESHOLD'
>;

/** The two counts the spend panel needs, or the fail-closed reading when the flag cannot be read. */
interface SuspensionReading {
  readonly suspended: boolean;
  readonly mismatches: number;
}

/** The suspension store behind `services`, or `null` when the composition root exposes neither the store nor a client to build one from. */
function suspensionStoreOf(services: AdminMetricsServices): SuspensionStore | null {
  if (services.suspension !== undefined && services.suspension !== null) {
    return services.suspension;
  }
  const redis = services.redis;
  if (redis === undefined || redis === null) {
    return null;
  }
  const client = 'client' in redis ? redis.client : redis;
  return client === undefined || client === null ? null : createRedisSuspensionStore(client);
}

/** An error's own short `code`, for a log line; anything else reads as `unknown` (AAP 0.11.1). */
function errorCodeOf(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code: unknown = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code)) {
      return code;
    }
  }
  return 'unknown';
}

/**
 * Whether language-model use is suspended, and how often it was suspended. An unreadable flag reads as suspended,
 * matching the spend meter's fail-closed rule, so a Redis outage is never shown as running on the dashboard; one
 * `metrics_suspension_unreadable` warning naming the failure's code is logged, and nothing but that code leaves the
 * process.
 */
async function readSuspension(services: AdminMetricsServices): Promise<SuspensionReading> {
  const store = suspensionStoreOf(services);
  if (store === null) {
    services.logger.warn({ event: 'metrics_suspension_unreadable', code: 'no_store' });
    return { suspended: true, mismatches: 0 };
  }
  try {
    const [suspended, mismatches] = await Promise.all([store.isSuspended(), store.mismatchCount()]);
    return { suspended, mismatches };
  } catch (error) {
    services.logger.warn({ event: 'metrics_suspension_unreadable', code: errorCodeOf(error) });
    return { suspended: true, mismatches: 0 };
  }
}

/** The message an operator reads when the suspension flag cannot be reached at all. */
const SUSPENSION_CLEAR_FAILED_MESSAGE = 'The language-model suspension could not be cleared.';

/**
 * The one refusal {@link reEnableLanguageModel} raises: one narrowed line naming the failure's own short code, and
 * the shared `503` the operator answers for rather than an uncounted `500`. No message, no stack and no key value
 * reaches the line.
 */
function suspensionClearFailed(services: AdminMetricsServices, code: string): AppError {
  services.logger.warn({ event: 'llm_suspension_clear_failed', code });
  return new AppError('service_unavailable', SUSPENSION_CLEAR_FAILED_MESSAGE);
}

/**
 * Re-enable language-model use after a mismatch suspended it. `SuspensionStore.clear` deletes the `llm:suspended`
 * flag `api` and `workers` share, so menu ingestion and call dispatch resume in every city at once. The cumulative
 * `llm:count_mismatches` counter is deliberately left standing: it is the evidence the spend panel shows and the
 * operator establishes the cause from, and only the flag is the suspension.
 *
 * A store that is absent, a clear that fails and a read that fails are one `llm_suspension_clear_failed` warning
 * plus an `AppError('service_unavailable')` refusal, so a Redis outage reads as a refusal the operator can act on
 * rather than as an internal failure. The clear is idempotent: a flag that is already absent answers the same way.
 *
 * @throws AppError `service_unavailable` (503) when the flag's store is absent or cannot be used.
 */
export async function reEnableLanguageModel(
  services: AdminMetricsServices,
  operatorId: string,
): Promise<AdminLlmSuspension> {
  const store = suspensionStoreOf(services);
  if (store === null) {
    throw suspensionClearFailed(services, 'no_store');
  }
  try {
    await store.clear();
    const [suspended, mismatches] = await Promise.all([store.isSuspended(), store.mismatchCount()]);
    // One line, the event and the acting operator, and nothing else (AAP 0.11.1).
    services.logger.info({ event: 'llm_suspension_cleared', operatorId });
    return { suspended, mismatches };
  } catch (error) {
    throw suspensionClearFailed(services, errorCodeOf(error));
  }
}

/**
 * The half-open UTC instant range a dashboard query asks for: `from` at 00:00:00Z up to the midnight after `to`, so
 * the range covers `to` in full and every comparison reads `>= start AND < endExclusive`. Both endpoints are UTC,
 * because every meetup measure ranges on `Meetup.startsAt`, which is stored in UTC.
 *
 * @throws AppError `invalid_field` when either value is not a date, or when `from` is later than `to`: a reversed
 *   range has no reading, and a silently empty dashboard would look like a real zero.
 */
export function utcRange(from: string, to: string): { start: Date; endExclusive: Date } {
  const start = new Date(`${from}T00:00:00.000Z`);
  const lastDay = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(lastDay.getTime())) {
    throw new AppError('invalid_field', '`from` and `to` must be calendar dates.');
  }
  if (from > to) {
    throw new AppError('invalid_field', '`from` must not be later than `to`.');
  }
  return { start, endExclusive: new Date(lastDay.getTime() + DAY_MS) };
}

/**
 * The headline completion rate: meetups both attendees checked in for, over meetups that reached two locked holds.
 * `null` rather than 0 when nothing was locked, so an empty period reads as no data and not as a pilot that failed
 * its hypothesis.
 */
export function completionRate(locked: number, both: number): number | null {
  return locked === 0 ? null : both / locked;
}

/**
 * The median of a list of numbers: the middle value, or the mean of the two middle values, with the list left
 * untouched. The dashboard computes the same figure in PostgreSQL with `percentile_cont`, which keeps it from
 * transferring every value; this is that rule in one place, for tests and for callers that hold the values already.
 */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? 0) + upper) / 2;
}

/**
 * A count, a `bigint` or a PostgreSQL `numeric` as a finite JavaScript number, and 0 for anything else: `count`
 * arrives as `number`, a `bigint` column such as `llm_spend_micros` arrives as `bigint`, and a `percentile_cont`
 * result — the type of a median — arrives as `Prisma.Decimal`.
 */
function numberOf(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return Prisma.Decimal.isDecimal(value) ? value.toNumber() : 0;
}

/** The `AnalyticsEventName` members the unlinked measures read (AAP 0.5.2, 0.5.7). */
const ANALYTICS_NAMES = {
  signup: 'account_created',
  claimSubmitted: 'lodging_claim_submitted',
  claimResolved: 'lodging_claim_resolved',
  placeOpened: 'suggestion_place_opened',
} as const satisfies Record<string, AnalyticsEventName>;

/** Places with a fresh approved price a partner venue's 2 km neighbourhood needs before it counts as covered (at least 10 priced places). */
export const NEIGHBORHOOD_COVERAGE_PLACES = 10;

/** Most venues one dashboard names, ordered by meetup count (AAP 0.5.4). */
const MEETUPS_BY_VENUE_LIMIT = 50;

/**
 * The most recent attempt's outcome for a task: `no_answer` is not a task status, it is a task still `queued` whose
 * latest attempt went unanswered. Ties on `started_at` break by id, so the read is deterministic.
 */
const LATEST_ATTEMPT_OUTCOME = Prisma.sql`(
    SELECT "a"."outcome"::text
      FROM "call_attempt" AS "a"
     WHERE "a"."call_task_id" = "t"."id"
     ORDER BY "a"."started_at" DESC, "a"."id" DESC
     LIMIT 1
  )`;
/**
 * The calls-by-outcome table, keyed by `CallAttemptOutcome` so a status the shared enum gains cannot be left out of
 * the panel. Every filter tests a distinct status, so a task is counted once; `no_answer` is the one entry that
 * reads the task's latest attempt instead.
 */
const CALL_OUTCOME_MEASURES = {
  completed: Prisma.sql`"t"."status"::text = 'completed'`,
  refused: Prisma.sql`"t"."status"::text = 'refused'`,
  do_not_call: Prisma.sql`"t"."status"::text = 'do_not_call'`,
  unreachable: Prisma.sql`"t"."status"::text = 'unreachable'`,
  needs_review: Prisma.sql`"t"."status"::text = 'needs_review'`,
  no_answer: Prisma.sql`"t"."status"::text = 'queued' AND ${LATEST_ATTEMPT_OUTCOME} = 'no_answer'`,
} satisfies Record<CallAttemptOutcome, Prisma.Sql>;

const CALL_OUTCOME_SELECT = Prisma.join(
  Object.entries(CALL_OUTCOME_MEASURES).map(
    ([outcome, condition]) =>
      // The outcome is a literal of the shared enum, never caller input.
      Prisma.sql`count(*) FILTER (WHERE ${condition})::int AS ${Prisma.raw(`"${outcome}"`)}`,
  ),
  ', ',
);

/**
 * The resolution outcomes of `lodging_claim_resolved`, keyed by `OperatorClaimOutcome`. The panel reads the event's
 * own `outcome` property rather than the claim rows, which are erased with the account.
 */
const CLAIM_OUTCOME_MEASURES = {
  verified: Prisma.sql`"e"."props"->>'outcome' = 'verified'`,
  rejected: Prisma.sql`"e"."props"->>'outcome' = 'rejected'`,
  unreachable: Prisma.sql`"e"."props"->>'outcome' = 'unreachable'`,
} satisfies Record<OperatorClaimOutcome, Prisma.Sql>;

const CLAIM_OUTCOME_SELECT = Prisma.join(
  Object.entries(CLAIM_OUTCOME_MEASURES).map(
    ([outcome, condition]) =>
      Prisma.sql`count(*) FILTER (WHERE "e"."name" = ${ANALYTICS_NAMES.claimResolved} AND ${condition})::int AS ${Prisma.raw(`"${outcome}"`)}`,
  ),
  ', ',
);

/** The place categories suggestions may draw from, from the shared enum (AAP 0.5.2). */
const PLACE_CATEGORY_LIST = Prisma.join(
  PlaceCategory.options.map((category) => Prisma.sql`${category}`),
);

type MeetupMeasureRow = {
  readonly locked_meetups: number;
  readonly both_checked_in: number;
  readonly open_window_meetups: number;
  readonly proposals_sent: number;
  readonly proposals_viewed: number;
  readonly proposals_accepted: number;
  readonly no_shows: number;
  readonly cancelled_early: number;
  readonly cancelled_late: number;
  readonly lock_lost: number;
  readonly suggestions_viewed: number;
};

type CountRow = { readonly count: number };

type CityCountRow = { readonly city_id: string; readonly count: number };

type VenueCountRow = {
  readonly venue_id: string;
  readonly venue_name: string;
  readonly count: number;
};

type CoverageRow = { readonly venues: number; readonly covered: number };

type CallOutcomeRow = Record<CallAttemptOutcome, number>;

type CallLifecycleRow = {
  readonly queued_without_outcome: number;
  readonly in_progress: number;
  readonly cancelled: number;
};

type BlockedReasonRow = { readonly reason: BlockedReason; readonly count: number };

type BudgetDayRow = {
  readonly city_id: string;
  readonly local_date: Date;
  readonly calls: number;
  readonly llm_spend_micros: bigint;
};

/** The lodging-claim measures, with the median left as PostgreSQL returned it. */
type LodgingClaimRow = {
  readonly submitted: number;
  readonly verified: number;
  readonly rejected: number;
  readonly unreachable: number;
  readonly median: unknown;
};

type EventCountsRow = {
  readonly signups: number;
  readonly opened: number;
};

/**
 * A qualified, double-quoted column identifier built from two code constants. Both parts are checked against
 * `SQL_IDENTIFIER` before they reach the statement, so a name that did not come from this file cannot reach the SQL
 * text.
 *
 * @throws RangeError when either part is not a plain lower-case SQL identifier.
 */
function columnOf(alias: string, column: string): Prisma.Sql {
  if (!SQL_IDENTIFIER.test(alias) || !SQL_IDENTIFIER.test(column)) {
    throw new RangeError(`Unsafe SQL identifier: ${alias}.${column}`);
  }
  return Prisma.raw(`"${alias}"."${column}"`);
}

/**
 * The `AND …` fragment for an optional city filter over `alias`.`city_id`, or nothing at all when no city was asked
 * for. Every table this module filters by city carries that column name; a query over `meetup` filters through its
 * venue instead.
 */
function cityEquals(alias: string, cityId: string | undefined): Prisma.Sql {
  return cityId === undefined
    ? Prisma.empty
    : Prisma.sql`AND ${columnOf(alias, 'city_id')} = ${cityId}`;
}

/**
 * The fresh, approved price-record predicate: an online-menu price captured within {@link FRESHNESS_ONLINE_DAYS}
 * days of `now`, or a phone-quoted or operator-entered one within {@link FRESHNESS_PHONE_OPERATOR_DAYS} days. Both
 * cutoffs are computed from the injected clock, so a test can age a price out of the panel by moving the clock.
 */
function freshPriceCondition(
  env: AdminMetricsEnv,
  priceAlias: string,
  placeAlias: string,
  now: Date,
): Prisma.Sql {
  const onlineCutoff = new Date(now.getTime() - FRESHNESS_ONLINE_DAYS * DAY_MS);
  const otherCutoff = new Date(now.getTime() - FRESHNESS_PHONE_OPERATOR_DAYS * DAY_MS);
  return Prisma.sql`
    ${columnOf(priceAlias, 'review_status')} = 'approved'
    AND ((${columnOf(priceAlias, 'source')}::text = 'online_menu' AND ${columnOf(priceAlias, 'captured_at')} >= ${onlineCutoff})
         OR (${columnOf(priceAlias, 'source')}::text <> 'online_menu' AND ${columnOf(priceAlias, 'captured_at')} >= ${otherCutoff}))
    AND ${fixturePredicate(env.APP_ENV, priceAlias)}
    AND ${fixturePredicate(env.APP_ENV, placeAlias)}
  `;
}

/**
 * The predicate every meetup measure shares: the requested range on `meetup.starts_at`, the optional city and
 * variant filters, and the fixture guard for the venue row. The variant filter compares the meetup's own
 * `variant_pairing` as text, never either participant's assignment, so a meetup counts once under a variant filter.
 */
function meetupWhere(
  env: AdminMetricsEnv,
  query: MetricsQuery,
  start: Date,
  endExclusive: Date,
): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`"m"."starts_at" >= ${start}`,
    Prisma.sql`"m"."starts_at" < ${endExclusive}`,
  ];
  if (query.cityId !== undefined) {
    parts.push(Prisma.sql`"v"."city_id" = ${query.cityId}`);
  }
  if (query.variant !== undefined) {
    parts.push(Prisma.sql`"m"."variant_pairing"::text = ${query.variant}`);
  }
  parts.push(fixturePredicate(env.APP_ENV, 'v'));
  return Prisma.join(parts, ' AND ');
}

/**
 * The joins a call-task statement needs: the task's city is the city of its place or of its lodging. The fixture
 * guard sits in each join's own `ON` condition rather than in the `WHERE`: written the other way round, a
 * filtered-out target would turn into a `NULL` comparison and drop the task row instead of leaving it cityless.
 */
function callTaskJoins(env: AdminMetricsEnv): Prisma.Sql {
  const place = fixturePredicate(env.APP_ENV, 'pl');
  const lodging = fixturePredicate(env.APP_ENV, 'lo');
  return Prisma.sql`
    LEFT JOIN "place" AS "pl"
           ON "pl"."id" = "t"."place_id" AND ${place}
    LEFT JOIN "lodging" AS "lo"
           ON "lo"."id" = "t"."lodging_id" AND ${lodging}
  `;
}

function callTaskCity(cityId: string | undefined): Prisma.Sql {
  return cityId === undefined
    ? Prisma.empty
    : Prisma.sql`AND COALESCE("pl"."city_id", "lo"."city_id") = ${cityId}`;
}

/** One count off an aggregate row, as a JavaScript number: the row key is checked against the row's own shape, and an absent row — one no aggregate statement returned — reads as 0. */
function countOf<T extends object, K extends keyof T>(row: T | undefined, key: K): number {
  return row === undefined ? 0 : numberOf(row[key]);
}

/** A `date` column as the `YYYY-MM-DD` the contract carries; Prisma reads it at UTC midnight. */
function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * The meetup aggregate: the completion, funnel and lifecycle measures in one indexed pass over `meetup` joined to
 * `venue`.
 *
 * `openWindowMeetups` counts locked meetups whose window has not closed yet, which is what keeps a meetup that may
 * still be completed inside the denominator while the dashboard shows how many are outstanding. The window end is
 * `starts_at + 45 min`, so the predicate is written against `starts_at >= now - 45 min` with `windowEnd` computed by
 * the caller from the injected clock.
 */
function meetupsStatement(where: Prisma.Sql, windowEnd: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT
      count(*) FILTER (WHERE "m"."locked_at" IS NOT NULL)::int AS "locked_meetups",
      count(*) FILTER (WHERE "m"."locked_at" IS NOT NULL AND "m"."both_checked_in_at" IS NOT NULL)::int AS "both_checked_in",
      count(*) FILTER (WHERE "m"."locked_at" IS NOT NULL AND "m"."both_checked_in_at" IS NULL AND "m"."starts_at" >= ${windowEnd})::int AS "open_window_meetups",
      count(*) FILTER (WHERE "m"."proposal_visible_at" IS NOT NULL)::int AS "proposals_sent",
      count(*) FILTER (WHERE "m"."recipient_viewed_at" IS NOT NULL)::int AS "proposals_viewed",
      count(*) FILTER (WHERE "m"."recipient_accepted_at" IS NOT NULL)::int AS "proposals_accepted",
      count(*) FILTER (WHERE "m"."status"::text = 'forfeited')::int AS "no_shows",
      count(*) FILTER (WHERE "m"."status"::text = 'cancelled')::int AS "cancelled_early",
      count(*) FILTER (WHERE "m"."status"::text = 'forfeited' AND "m"."forfeit_reason"::text = 'late_cancel')::int AS "cancelled_late",
      count(*) FILTER (WHERE "m"."status"::text = 'lock_lost')::int AS "lock_lost",
      count(*) FILTER (WHERE "m"."suggestions_first_viewed_at" IS NOT NULL)::int AS "suggestions_viewed"
      FROM "meetup" AS "m"
      JOIN "venue" AS "v" ON "v"."id" = "m"."venue_id"
     WHERE ${where}
  `;
}

/** Disputes opened on meetups that pass the filter, counted once per dispute (AAP 0.5.7). */
function disputesStatement(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS "count"
      FROM "dispute" AS "d"
      JOIN "meetup" AS "m" ON "m"."id" = "d"."meetup_id"
      JOIN "venue" AS "v" ON "v"."id" = "m"."venue_id"
     WHERE ${where}
  `;
}

/**
 * Meetups per partner venue over the range, named so the operator need not look an id up. A meetup counts here once
 * it is committed to — `lockedAt` is set — which is what meetups per partner venue measures; a proposal that never
 * locked is not yet a meeting. The limit keeps one dashboard bounded, and the venue name is the tie-break so the
 * order is deterministic.
 */
function venuesStatement(where: Prisma.Sql): Prisma.Sql {
  // A code constant, not caller input: `LIMIT` refuses a bound parameter of unknown type.
  const limit = Prisma.raw(String(MEETUPS_BY_VENUE_LIMIT));
  return Prisma.sql`
    SELECT "v"."id"::text AS "venue_id", "v"."name" AS "venue_name", count(*)::int AS "count"
      FROM "meetup" AS "m"
      JOIN "venue" AS "v" ON "v"."id" = "m"."venue_id"
     WHERE ${where} AND "m"."locked_at" IS NOT NULL
     GROUP BY "v"."id", "v"."name"
     ORDER BY count(*) DESC, "v"."name" ASC
     LIMIT ${limit}
  `;
}

/** The live active-proof figure per city: the users holding a proof valid at `now`, excluding a deleted or deletion-requested account, so the figure follows the live roster. */
function activeProofsStatement(now: Date, cityId: string | undefined): Prisma.Sql {
  return Prisma.sql`
    SELECT "p"."city_id" AS "city_id", count(DISTINCT "p"."user_id")::int AS "count"
      FROM "itinerary_proof" AS "p"
      JOIN "user" AS "u" ON "u"."id" = "p"."user_id"
     WHERE "p"."valid_from" <= ${now}
       AND "p"."valid_to" >= ${now}
       AND "u"."deleted_at" IS NULL
       AND "u"."deletion_requested_at" IS NULL
       ${cityEquals('p', cityId)}
     GROUP BY "p"."city_id"
     ORDER BY "p"."city_id"
  `;
}

/** Places with at least one fresh, approved price, per city (AAP 0.5.7). */
function freshPricesStatement(
  env: AdminMetricsEnv,
  now: Date,
  cityId: string | undefined,
): Prisma.Sql {
  return Prisma.sql`
    SELECT "pl"."city_id" AS "city_id", count(DISTINCT "pl"."id")::int AS "count"
      FROM "place" AS "pl"
      JOIN "price_record" AS "pr" ON "pr"."place_id" = "pl"."id"
     WHERE ${columnOf('pl', 'category')}::text IN (${PLACE_CATEGORY_LIST})
       AND ${freshPriceCondition(env, 'pr', 'pl', now)}
       ${cityEquals('pl', cityId)}
     GROUP BY "pl"."city_id"
     ORDER BY "pl"."city_id"
  `;
}

/**
 * The share of the city's active partner venues whose 2 km neighbourhood holds at least
 * {@link NEIGHBORHOOD_COVERAGE_PLACES} freshly priced places.
 *
 * One set-based statement rather than a subquery per venue: the places in the radius join the venue, each place is
 * counted once however many price records it has, and both totals aggregate in SQL. The radius is
 * {@link SUGGESTION_RADIUS_METERS}, the same 2 km the suggestion filter uses, with the indexed place column first so
 * the GiST index is used.
 */
function neighborhoodsStatement(
  env: AdminMetricsEnv,
  now: Date,
  cityId: string | undefined,
): Prisma.Sql {
  const target = Prisma.raw(String(NEIGHBORHOOD_COVERAGE_PLACES));
  const radius = withinMeters(
    geoColumn('p', 'place'),
    geoColumn('v', 'venue'),
    SUGGESTION_RADIUS_METERS,
  );
  return Prisma.sql`
    SELECT count(*)::int AS "venues",
           count(*) FILTER (WHERE "nearby" >= ${target})::int AS "covered"
      FROM (
        SELECT "v"."id" AS "venue_id",
               count(DISTINCT CASE WHEN "pr"."id" IS NOT NULL THEN "p"."id" END)::int AS "nearby"
          FROM "venue" AS "v"
          LEFT JOIN "place" AS "p"
                 ON ${radius}
                AND ${columnOf('p', 'category')}::text IN (${PLACE_CATEGORY_LIST})
                AND ${fixturePredicate(env.APP_ENV, 'p')}
          LEFT JOIN "price_record" AS "pr"
                 ON "pr"."place_id" = "p"."id"
                AND ${freshPriceCondition(env, 'pr', 'p', now)}
         WHERE "v"."is_active_partner"
           AND ${fixturePredicate(env.APP_ENV, 'v')}
           ${cityEquals('v', cityId)}
         GROUP BY "v"."id"
      ) AS "neighborhoods"
  `;
}

/** Calls by outcome, each task counted once and dated by its `outcome_at` (AAP 0.5.7). */
function callOutcomesStatement(
  env: AdminMetricsEnv,
  start: Date,
  endExclusive: Date,
  cityId: string | undefined,
): Prisma.Sql {
  return Prisma.sql`
    SELECT ${CALL_OUTCOME_SELECT}
      FROM "call_task" AS "t"
      ${callTaskJoins(env)}
     WHERE "t"."outcome_at" >= ${start}
       AND "t"."outcome_at" < ${endExclusive}
       ${callTaskCity(cityId)}
  `;
}

/** The current call-task snapshot: what is waiting, what is live and what was set aside. Not range-bound, because a queue is a present-tense thing: a task queued today with no outcome would vanish from a yesterday-to-today window the moment it was dialed. */
function callLifecycleStatement(env: AdminMetricsEnv, cityId: string | undefined): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*) FILTER (WHERE "t"."status"::text = 'queued' AND "t"."outcome_at" IS NULL)::int AS "queued_without_outcome",
           count(*) FILTER (WHERE "t"."status"::text = 'in_progress')::int AS "in_progress",
           count(*) FILTER (WHERE "t"."status"::text = 'cancelled')::int AS "cancelled"
      FROM "call_task" AS "t"
      ${callTaskJoins(env)}
     WHERE TRUE
       ${callTaskCity(cityId)}
  `;
}

/**
 * The operator queue's blocked tasks by reason, over the statuses a block can hold a task in: waiting, held for
 * review, or unreachable.
 *
 * The three labels are `CallTaskStatus` members written into the statement as literals, never bound as parameters: a
 * bound JavaScript string arrives as `text`, and PostgreSQL has no `enum = text` operator, so the comparison is
 * written enum-typed and `call_task_status_next_attempt_at_idx` can serve it rather than the table being scanned.
 * The city fragment is optional and `AND`-prefixed on purpose, so the filter needs no second copy of the joins.
 */
function blockedReasonsStatement(env: AdminMetricsEnv, cityId: string | undefined): Prisma.Sql {
  return Prisma.sql`
    SELECT "t"."blocked_reason"::text AS "reason", count(*)::int AS "count"
      FROM "call_task" AS "t"
      ${callTaskJoins(env)}
     WHERE "t"."blocked_reason" IS NOT NULL
       AND "t"."status" IN ('queued', 'needs_review', 'unreachable')
       ${callTaskCity(cityId)}
     GROUP BY "t"."blocked_reason"
  `;
}

/**
 * The per-city, per-local-day calls and language-model spend the caps are drawn against. `local_date` is the city's
 * own day, so the panel lines up with `CAP_CALLS_PER_CITY_DAY` and `CAP_LLM_USD_PER_CITY_DAY`, which are counted per
 * city per local day as well.
 */
function budgetDaysStatement(from: string, to: string, cityId: string | undefined): Prisma.Sql {
  return Prisma.sql`
    SELECT "b"."city_id" AS "city_id",
           "b"."local_date" AS "local_date",
           "b"."calls"::int AS "calls",
           "b"."llm_spend_micros" AS "llm_spend_micros"
      FROM "call_budget_day" AS "b"
     WHERE "b"."local_date" >= CAST(${from} AS date)
       AND "b"."local_date" <= CAST(${to} AS date)
       ${cityEquals('b', cityId)}
     ORDER BY "b"."city_id" ASC, "b"."local_date" ASC
  `;
}

/**
 * The lodging-claim measures, from the unlinked events that survive erasure.
 *
 * The city filter reads `AnalyticsEvent.cityId`, so it counts a claim only when its emitter set that field. The
 * median is `percentile_cont(0.5)` over the `resolveSeconds` the emitters recorded, rounded to a whole second; the
 * cast is guarded by a digit pattern so one malformed property cannot fail the whole dashboard, and a range with no
 * resolved claim answers `null` rather than 0.
 */
function lodgingClaimsStatement(
  start: Date,
  endExclusive: Date,
  cityId: string | undefined,
): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*) FILTER (WHERE "e"."name" = ${ANALYTICS_NAMES.claimSubmitted})::int AS "submitted",
           ${CLAIM_OUTCOME_SELECT},
           ROUND(percentile_cont(0.5) WITHIN GROUP (
             ORDER BY CASE WHEN "e"."props"->>'resolveSeconds' ~ '^[0-9]+(\.[0-9]+)?$'
                           THEN ("e"."props"->>'resolveSeconds')::numeric END
           ) FILTER (WHERE "e"."name" = ${ANALYTICS_NAMES.claimResolved})) AS "median"
      FROM "analytics_event" AS "e"
     WHERE "e"."occurred_at" >= ${start}
       AND "e"."occurred_at" < ${endExclusive}
       ${cityEquals('e', cityId)}
  `;
}

/** The two unlinked event measures over one range: signups, from `account_created`, and how often a suggested place was opened, from `suggestion_place_opened`. */
function signupsAndPlacesOpenedStatement(
  start: Date,
  endExclusive: Date,
  cityId: string | undefined,
): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*) FILTER (WHERE "e"."name" = ${ANALYTICS_NAMES.signup})::int AS "signups",
           count(*) FILTER (WHERE "e"."name" = ${ANALYTICS_NAMES.placeOpened} ${cityEquals('e', cityId)})::int AS "opened"
      FROM "analytics_event" AS "e"
     WHERE "e"."occurred_at" >= ${start}
       AND "e"."occurred_at" < ${endExclusive}
  `;
}

function cityCounts(rows: readonly CityCountRow[]): MetricsDto['activeProofsByCity'] {
  return rows.map((row) => ({ cityId: row.city_id, count: numberOf(row.count) }));
}

/**
 * The operator dashboard for one range, city and variant pairing.
 *
 * The statements are independent and run together, so the answer costs one round of queries rather than twelve.
 * Nothing here writes, so there is no transaction and no row lock; the only non-SQL read is the language-model
 * suspension flag, which fails closed to suspended when it cannot be read.
 *
 * @throws AppError `invalid_field` when the range is reversed or not a pair of dates.
 */
export async function computeMetrics(
  services: AdminMetricsServices,
  query: MetricsQuery,
  now: Date,
): Promise<MetricsDto> {
  const { start, endExclusive } = utcRange(query.from, query.to);
  const windowEnd = new Date(now.getTime() - CHECK_IN_CLOSES_AFTER_MINUTES * MINUTE_MS);
  const where = meetupWhere(services.env, query, start, endExclusive);
  const cityId = query.cityId;
  const [
    meetups,
    disputes,
    venues,
    proofs,
    prices,
    coverage,
    outcomes,
    lifecycle,
    blocked,
    budgets,
    claims,
    eventCounts,
    suspension,
  ] = await Promise.all([
    services.db.$queryRaw<MeetupMeasureRow[]>(meetupsStatement(where, windowEnd)),
    services.db.$queryRaw<CountRow[]>(disputesStatement(where)),
    services.db.$queryRaw<VenueCountRow[]>(venuesStatement(where)),
    services.db.$queryRaw<CityCountRow[]>(activeProofsStatement(now, cityId)),
    services.db.$queryRaw<CityCountRow[]>(freshPricesStatement(services.env, now, cityId)),
    services.db.$queryRaw<CoverageRow[]>(neighborhoodsStatement(services.env, now, cityId)),
    services.db.$queryRaw<CallOutcomeRow[]>(
      callOutcomesStatement(services.env, start, endExclusive, cityId),
    ),
    services.db.$queryRaw<CallLifecycleRow[]>(callLifecycleStatement(services.env, cityId)),
    services.db.$queryRaw<BlockedReasonRow[]>(blockedReasonsStatement(services.env, cityId)),
    services.db.$queryRaw<BudgetDayRow[]>(budgetDaysStatement(query.from, query.to, cityId)),
    services.db.$queryRaw<LodgingClaimRow[]>(lodgingClaimsStatement(start, endExclusive, cityId)),
    services.db.$queryRaw<EventCountsRow[]>(
      signupsAndPlacesOpenedStatement(start, endExclusive, cityId),
    ),
    readSuspension(services),
  ]);
  const meetupRow = meetups[0];
  const lifecycleRow = lifecycle[0];
  const outcomeRow = outcomes[0];
  const claimsRow = claims[0];
  const lockedMeetups = countOf(meetupRow, 'locked_meetups');
  const bothCheckedIn = countOf(meetupRow, 'both_checked_in');
  const partnerVenues = countOf(coverage[0], 'venues');
  const coveredVenues = countOf(coverage[0], 'covered');
  const blockedCounts = new Map(blocked.map((row) => [row.reason, numberOf(row.count)]));
  const medianSeconds =
    claimsRow === undefined || claimsRow.median === null
      ? null
      : Math.round(numberOf(claimsRow.median));
  const perDay: MetricsDto['calls']['perDay'] = budgets.map((row) => ({
    cityId: row.city_id,
    localDate: dateOnly(row.local_date),
    calls: numberOf(row.calls),
    cap: services.env.CAP_CALLS_PER_CITY_DAY,
  }));
  const spend: MetricsDto['calls']['spend'] = budgets.map((row) => ({
    cityId: row.city_id,
    localDate: dateOnly(row.local_date),
    spendMicros: numberOf(row.llm_spend_micros),
    capMicros: services.env.capLlmMicrosPerCityDay,
  }));
  return {
    completion: {
      lockedMeetups,
      bothCheckedIn,
      rate: completionRate(lockedMeetups, bothCheckedIn),
      openWindowMeetups: countOf(meetupRow, 'open_window_meetups'),
    },
    thresholds: {
      lockRate: services.env.PILOT_LOCK_RATE_THRESHOLD,
      completion: services.env.PILOT_COMPLETION_THRESHOLD,
    },
    // The funnel's last two stages are the completion rate's two terms: a meetup cannot record
    // `bothCheckedInAt` without `lockedAt`, so the funnel closes on the same numbers it is judged
    // by rather than on a second reading of them (AAP 0.5.7).
    funnel: {
      proposalsSent: countOf(meetupRow, 'proposals_sent'),
      proposalsViewed: countOf(meetupRow, 'proposals_viewed'),
      proposalsAccepted: countOf(meetupRow, 'proposals_accepted'),
      bothLocked: lockedMeetups,
      bothCheckedIn,
    },
    counts: {
      noShows: countOf(meetupRow, 'no_shows'),
      cancelledEarly: countOf(meetupRow, 'cancelled_early'),
      cancelledLate: countOf(meetupRow, 'cancelled_late'),
      lockLost: countOf(meetupRow, 'lock_lost'),
      disputesOpened: countOf(disputes[0], 'count'),
    },
    activeProofsByCity: cityCounts(proofs),
    meetupsByVenue: venues.map((row) => ({
      venueId: row.venue_id,
      venueName: row.venue_name,
      count: numberOf(row.count),
    })),
    prices: {
      placesWithFreshPriceByCity: cityCounts(prices),
      neighborhoodsCoveredShare: partnerVenues === 0 ? null : coveredVenues / partnerVenues,
      meetupsWithSuggestionsViewed: countOf(meetupRow, 'suggestions_viewed'),
      placesOpened: countOf(eventCounts[0], 'opened'),
    },
    calls: {
      byOutcome: {
        completed: countOf(outcomeRow, 'completed'),
        refused: countOf(outcomeRow, 'refused'),
        do_not_call: countOf(outcomeRow, 'do_not_call'),
        unreachable: countOf(outcomeRow, 'unreachable'),
        needs_review: countOf(outcomeRow, 'needs_review'),
        no_answer: countOf(outcomeRow, 'no_answer'),
      },
      lifecycle: {
        queuedWithoutOutcome: countOf(lifecycleRow, 'queued_without_outcome'),
        inProgress: countOf(lifecycleRow, 'in_progress'),
        cancelled: countOf(lifecycleRow, 'cancelled'),
        // Every blocked reason is reported, at zero when the queue holds none of it, so a panel
        // keyed by reason never changes shape between two ranges.
        blockedByReason: {
          not_allowlisted: blockedCounts.get('not_allowlisted') ?? 0,
          no_phone: blockedCounts.get('no_phone') ?? 0,
          do_not_call: blockedCounts.get('do_not_call') ?? 0,
          invalid_number: blockedCounts.get('invalid_number') ?? 0,
          vendor_unavailable: blockedCounts.get('vendor_unavailable') ?? 0,
          dispatch_unknown: blockedCounts.get('dispatch_unknown') ?? 0,
          no_final_status: blockedCounts.get('no_final_status') ?? 0,
        },
      },
      perDay,
      spend,
      llmSuspended: suspension.suspended,
      llmCountMismatches: suspension.mismatches,
    },
    lodgingClaims: {
      submitted: countOf(claimsRow, 'submitted'),
      verified: countOf(claimsRow, 'verified'),
      rejected: countOf(claimsRow, 'rejected'),
      unreachable: countOf(claimsRow, 'unreachable'),
      medianResolveSeconds: medianSeconds,
    },
    signups: countOf(eventCounts[0], 'signups'),
  };
}
