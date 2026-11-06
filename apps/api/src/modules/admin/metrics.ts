/**
 * The operator dashboard's metrics (AAP 0.5.1 `admin/metrics.ts`, 0.5.4 `GET /admin/metrics`,
 * 0.5.7 "Metric definitions").
 *
 * One call of {@link computeMetrics} answers the whole dashboard — the headline completion rate the
 * pilot is judged by, the pilot's two reference lines, the deposit funnel, the lifecycle counts, the
 * live per-city figures, the prices and suggestions panel, the calls and spend panel and the
 * lodging-claim measures — assembled field by field into {@link MetricsDto}. `signups` is last on
 * purpose: the hypothesis is tested on completion, and a signup count is never a headline (0.1.1).
 *
 * Every meetup, funnel and count figure comes from one aggregate over `meetup` joined to `venue`,
 * ranged on `meetup.starts_at` (AAP 0.5.7). No figure is counted twice: the variant filter reads
 * `meetup.variant_pairing` alone, which fixes one pairing per meetup. Completion reads `lockedAt`
 * and `bothCheckedInAt` and never `status`, so a later hold loss, `no_fault` resolution or
 * late-cancel compensation cannot rewrite the rate.
 *
 * Read-only: no transaction, no row lock, and not one of the state-writing reads, so the
 * account-deletion write fence does not apply (AAP 0.5.3). Time arrives as the `now` argument — the
 * route passes `request.receivedAt` — never from the process or SQL `now()`, so a test can cross the
 * 45-minute settlement window. The check-in window end is therefore computed in JavaScript as
 * `now - 45 min`, and no interval arithmetic binds a parameter.
 *
 * Three measures are live rather than range-bound, because their tables carry no meetup timestamp:
 * `activeProofsByCity` counts the proofs valid at `now`, and both calls panels are current
 * snapshots. The lodging-claim measures and signups come from the unlinked `account_created`,
 * `lodging_claim_submitted` and `lodging_claim_resolved` events, which survive account erasure
 * (AAP 0.5.2), so neither figure moves when a user is deleted.
 *
 * Decisions taken where the AAP leaves a choice, each restated at its code: the composition root's
 * services are declared here as {@link AdminMetricsServices} rather than imported from `app.ts`,
 * which is outside this file's dependency list and which the narrowed shape satisfies structurally;
 * `meetupsByVenue` counts committed (locked) meetups; `neighborhoodsCoveredShare` is null when the
 * city has no active partner venue and is otherwise the share whose 2 km neighbourhood holds
 * {@link NEIGHBORHOOD_COVERAGE_PLACES} freshly priced places; `placesOpened` ignores the variant
 * filter, because a client-reported event carries no pairing; and `medianResolveSeconds` is
 * PostgreSQL's `percentile_cont` (AAP 0.5.7), with {@link medianOf} stating the same rule in one
 * place for tests.
 *
 * Nothing here returns a user id, a handle, an email address, a coordinate or a row that was not
 * named field by field, and no log line carries a row, a reason or any other value (AAP 0.11.1).
 *
 * @see AAP 0.5.2 for the `AnalyticsEvent` fields and the caps, 0.5.3 for the statuses and forfeit
 *   reasons, 0.5.6 for the calls and spend panel and the suspension flag, 0.8.1 for this file.
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
  AnalyticsEventName,
  BlockedReason,
  CallAttemptOutcome,
  MetricsDto,
  MetricsQuery,
  OperatorClaimOutcome,
} from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';

// ---------------------------------------------------------------------------------------------
// Services (AAP 0.5.1)
// ---------------------------------------------------------------------------------------------

/**
 * What {@link computeMetrics} needs from the API's composition root: a narrowed declaration rather
 * than an import of the app's services type, which lives in `app.ts` outside this file's dependency
 * list and satisfies this shape structurally. A test can stand an executor, an environment and a
 * logger in for the app.
 */
export interface AdminMetricsServices {
  /** The guarded Prisma client; only its raw, parameterized read surface is used. */
  readonly db: Pick<DbClient, '$queryRaw'>;
  /** The API's validated configuration (AAP 0.6.2): the environment, the caps and the thresholds. */
  readonly env: AdminMetricsEnv;
  /** The process logger, read for the one warning an unreadable suspension flag raises. */
  readonly logger: Pick<Logger, 'warn'>;
  /**
   * The language-model suspension flag, when the composition root exposes it directly (AAP 0.5.6).
   * Preferred over {@link AdminMetricsServices.redis}, because it is the store the relay writes.
   */
  readonly suspension?: SuspensionStore | undefined;
  /**
   * The process's Redis connection, from which the suspension store is built when `suspension` is
   * absent: the client itself, or the connection object the app holds under `client`.
   */
  readonly redis?: SuspensionRedis | { readonly client: SuspensionRedis } | null | undefined;
}

/**
 * The API configuration the dashboard reports (AAP 0.6.2): `APP_ENV` decides whether fixture rows
 * are visible, the two caps are drawn against, and the two thresholds are the pilot's reference
 * lines.
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
  /** Whether language-model use is suspended in every city. */
  readonly suspended: boolean;
  /** How many count mismatches have been recorded since the counter was last cleared. */
  readonly mismatches: number;
}

/**
 * The suspension store behind `services`, or `null` when the composition root exposes neither the
 * store nor a client to build one from.
 */
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
 * Whether language-model use is suspended, and how often it was suspended (AAP 0.5.6).
 *
 * An unreadable flag reads as suspended, matching the spend meter's fail-closed rule, so a Redis
 * outage is never shown as "running" on the dashboard; one `metrics_suspension_unreadable` warning
 * naming the failure's code is logged, and nothing but that code leaves the process.
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

// ---------------------------------------------------------------------------------------------
// Pure helpers (AAP 0.5.4, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * The half-open UTC instant range a dashboard query asks for (AAP 0.5.4): `from` at 00:00:00Z up to
 * the midnight after `to`, so the range covers `to` in full and every comparison reads
 * `>= start AND < endExclusive`. Both endpoints are UTC, because the AAP ranges on
 * `Meetup.startsAt`, which is stored in UTC (AAP 0.11.1).
 *
 * @param from - The first day of the range, `YYYY-MM-DD`.
 * @param to - The last day of the range, inclusive.
 * @returns The two instants to bind.
 * @throws AppError `invalid_field` when either value is not a date, or when `from` is later than
 *   `to`: a reversed range has no reading, and a silently empty dashboard would look like a real
 *   zero. `MetricsQuery` refuses it first; this is the same rule for direct callers.
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
 * The headline completion rate: meetups both attendees checked in for, over meetups that reached two
 * locked holds (AAP 0.5.7). `null` rather than 0 when nothing was locked, so an empty period reads
 * as "no data" and not as a pilot that failed its hypothesis.
 *
 * @param locked - Meetups whose `lockedAt` is set.
 * @param both - Meetups with a pass check-in from both attendees.
 * @returns The rate in 0..1, or `null` when `locked` is 0.
 */
export function completionRate(locked: number, both: number): number | null {
  return locked === 0 ? null : both / locked;
}

/**
 * The median of a list of numbers (AAP 0.5.7 "median time to resolve"): the middle value, or the
 * mean of the two middle values, with the list left untouched. The dashboard computes the same
 * figure in PostgreSQL with `percentile_cont`, which keeps it from transferring every value; this is
 * that rule in one place, for tests and for callers that hold the values already.
 *
 * @param values - The values to take the median of; an empty list has none.
 * @returns The median, or `null` when `values` is empty.
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
 * A count, a `bigint` or a PostgreSQL `numeric` as a finite JavaScript number, and 0 for anything
 * else: `count` arrives as `number` (every count is cast `::int`), a `bigint` column such as
 * `llm_spend_micros` arrives as `bigint`, and a `percentile_cont` result — the type of a median —
 * arrives as `Prisma.Decimal`.
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

// ---------------------------------------------------------------------------------------------
// Constants (AAP 0.5.2, 0.5.4, 0.5.6, 0.5.7)
// ---------------------------------------------------------------------------------------------

/** The `AnalyticsEventName` members the unlinked measures read (AAP 0.5.2, 0.5.7). */
const ANALYTICS_NAMES = {
  signup: 'account_created',
  claimSubmitted: 'lodging_claim_submitted',
  claimResolved: 'lodging_claim_resolved',
  placeOpened: 'suggestion_place_opened',
} as const satisfies Record<string, AnalyticsEventName>;

/**
 * Places with a fresh approved price a partner venue's 2 km neighbourhood needs before it counts as
 * covered (AAP 0.5.7: "at least 10 priced places").
 */
export const NEIGHBORHOOD_COVERAGE_PLACES = 10;

/** Most venues one dashboard names, ordered by meetup count (AAP 0.5.4). */
const MEETUPS_BY_VENUE_LIMIT = 50;

/**
 * The most recent attempt's outcome for a task (AAP 0.5.7): `no_answer` is not a task status, it is
 * a task still `queued` whose latest attempt went unanswered. Ties on `started_at` break by id, so
 * the read is deterministic.
 */
const LATEST_ATTEMPT_OUTCOME = Prisma.sql`(
    SELECT "a"."outcome"::text
      FROM "call_attempt" AS "a"
     WHERE "a"."call_task_id" = "t"."id"
     ORDER BY "a"."started_at" DESC, "a"."id" DESC
     LIMIT 1
  )`;

/**
 * The calls-by-outcome table (AAP 0.5.7), keyed by `CallAttemptOutcome` so a status the shared enum
 * gains cannot be left out of the panel. Every filter tests a distinct status, so a task is counted
 * once; `no_answer` is the one entry that reads the task's latest attempt instead.
 */
const CALL_OUTCOME_MEASURES = {
  completed: Prisma.sql`"t"."status"::text = 'completed'`,
  refused: Prisma.sql`"t"."status"::text = 'refused'`,
  do_not_call: Prisma.sql`"t"."status"::text = 'do_not_call'`,
  unreachable: Prisma.sql`"t"."status"::text = 'unreachable'`,
  needs_review: Prisma.sql`"t"."status"::text = 'needs_review'`,
  no_answer: Prisma.sql`"t"."status"::text = 'queued' AND ${LATEST_ATTEMPT_OUTCOME} = 'no_answer'`,
} satisfies Record<CallAttemptOutcome, Prisma.Sql>;

/** The `count(*)` select items of that table, aliased by outcome name. */
const CALL_OUTCOME_SELECT = Prisma.join(
  Object.entries(CALL_OUTCOME_MEASURES).map(
    ([outcome, condition]) =>
      // The outcome is a literal of the shared enum, never caller input.
      Prisma.sql`count(*) FILTER (WHERE ${condition})::int AS ${Prisma.raw(`"${outcome}"`)}`,
  ),
  ', ',
);

/**
 * The resolution outcomes of `lodging_claim_resolved` (AAP 0.5.7), keyed by `OperatorClaimOutcome`.
 * The panel reads the event's own `outcome` property rather than the claim rows, which are erased
 * with the account (AAP 0.5.2).
 */
const CLAIM_OUTCOME_MEASURES = {
  verified: Prisma.sql`"e"."props"->>'outcome' = 'verified'`,
  rejected: Prisma.sql`"e"."props"->>'outcome' = 'rejected'`,
  unreachable: Prisma.sql`"e"."props"->>'outcome' = 'unreachable'`,
} satisfies Record<OperatorClaimOutcome, Prisma.Sql>;

/** The three `count(*)` select items of {@link CLAIM_OUTCOME_MEASURES}. */
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

// ---------------------------------------------------------------------------------------------
// Row shapes (AAP 0.5.2)
// ---------------------------------------------------------------------------------------------

/** The one row the meetup aggregate returns: the completion, funnel and lifecycle measures. */
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

/** A statement that answers one count, such as the dispute count or the signup count. */
type CountRow = { readonly count: number };

/** One `city_id` group of a per-city breakdown. */
type CityCountRow = { readonly city_id: string; readonly count: number };

/** One venue group of {@link MetricsDto.meetupsByVenue}. */
type VenueCountRow = {
  readonly venue_id: string;
  readonly venue_name: string;
  readonly count: number;
};

/** The partner-venue neighbourhood aggregate: how many venues there are, and how many are covered. */
type CoverageRow = { readonly venues: number; readonly covered: number };

/** The calls-by-outcome row, keyed by outcome because that is how its items are aliased. */
type CallOutcomeRow = Record<CallAttemptOutcome, number>;

/** The current call-task snapshot: the three lifecycle counters, range-free by design. */
type CallLifecycleRow = {
  readonly queued_without_outcome: number;
  readonly in_progress: number;
  readonly cancelled: number;
};

/** One `blocked_reason` group of the operator queue. */
type BlockedReasonRow = { readonly reason: BlockedReason; readonly count: number };

/** One `call_budget_day` row: a city's calls and language-model spend on one local day. */
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

// ---------------------------------------------------------------------------------------------
// Fragments (AAP 0.11.2: parameterized `Prisma.sql` only)
// ---------------------------------------------------------------------------------------------

/**
 * A qualified, double-quoted column identifier built from two code constants. Both parts are
 * checked against `SQL_IDENTIFIER` before they reach the statement, so a name that did not come
 * from this file cannot reach the SQL text.
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
 * The `AND …` fragment for an optional city filter over `alias`.`city_id`, or nothing at all when
 * no city was asked for. Every table this module filters by city carries that column name; a query
 * over `meetup` filters through its venue instead (see {@link meetupWhere}).
 */
function cityEquals(alias: string, cityId: string | undefined): Prisma.Sql {
  return cityId === undefined
    ? Prisma.empty
    : Prisma.sql`AND ${columnOf(alias, 'city_id')} = ${cityId}`;
}

/**
 * The fresh, approved price-record predicate (AAP 0.5.7): an online-menu price captured within
 * {@link FRESHNESS_ONLINE_DAYS} days of `now`, or a phone-quoted or operator-entered one within
 * {@link FRESHNESS_PHONE_OPERATOR_DAYS} days. Both cutoffs are computed from the injected clock, so
 * a test can age a price out of the panel by moving the clock.
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
 * The predicate every meetup measure shares (AAP 0.5.7): the requested range on `meetup.starts_at`,
 * the optional city and variant filters, and the fixture guard for the venue row.
 *
 * The variant filter compares the meetup's own `variant_pairing` as text, never either
 * participant's assignment, so a meetup counts once under a variant filter and no
 * participant-weighted figure exists.
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
 * The joins a call-task statement needs: the task's city is the city of its place or of its
 * lodging (AAP 0.5.2, `COALESCE(pl.city_id, lo.city_id)`).
 *
 * The fixture guard sits in each join's own `ON` condition rather than in the `WHERE`: written the
 * other way round, a filtered-out target would turn into a `NULL` comparison and drop the task row
 * instead of leaving it cityless.
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

/** The `AND …` city filter of a call-task statement, over `COALESCE(pl.city_id, lo.city_id)`. */
function callTaskCity(cityId: string | undefined): Prisma.Sql {
  return cityId === undefined
    ? Prisma.empty
    : Prisma.sql`AND COALESCE("pl"."city_id", "lo"."city_id") = ${cityId}`;
}

/**
 * One count off an aggregate row, as a JavaScript number: the row key is checked against the row's
 * own shape, and an absent row — one no aggregate statement returned — reads as 0.
 */
function countOf<T extends object, K extends keyof T>(row: T | undefined, key: K): number {
  return row === undefined ? 0 : numberOf(row[key]);
}

/** A `date` column as the `YYYY-MM-DD` the contract carries; Prisma reads it at UTC midnight. */
function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Statements (AAP 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * The meetup aggregate: the completion, funnel and lifecycle measures in one indexed pass over
 * `meetup` joined to `venue`.
 *
 * `openWindowMeetups` counts locked meetups whose window has not closed yet, which is what keeps a
 * meetup that may still be completed inside the denominator while the dashboard shows how many are
 * outstanding. The window end is `starts_at + 45 min`, so the predicate is written against
 * `starts_at >= now - 45 min` with `windowEnd` computed by the caller from the injected clock.
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
 * Meetups per partner venue over the range, named so the operator need not look an id up.
 *
 * A meetup counts here once it is committed to — `lockedAt` is set — which is what "meetups per
 * partner venue" measures; a proposal that never locked is not yet a meeting. The limit of
 * {@link MEETUPS_BY_VENUE_LIMIT} keeps one dashboard bounded, and the venue name is the tie-break
 * so the order is deterministic.
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

/**
 * The live active-proof figure per city (AAP 0.5.7): the users holding a proof valid at `now`,
 * excluding a deleted or deletion-requested account, so the figure follows the live roster.
 */
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
 * {@link NEIGHBORHOOD_COVERAGE_PLACES} freshly priced places (AAP 0.5.7).
 *
 * One set-based statement rather than a subquery per venue: the places in the radius join the venue,
 * each place is counted once however many price records it has, and both totals aggregate in SQL.
 * The radius is {@link SUGGESTION_RADIUS_METERS}, the same 2 km the suggestion filter uses, with the
 * indexed place column first so the GiST index is used.
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

/**
 * How often a suggested place was opened, over the range (AAP 0.5.7).
 *
 * The variant filter is deliberately not applied: `suggestion_place_opened` is reported by the
 * client through `POST /events`, and a client event carries no meetup pairing, so filtering it by
 * variant would silently drop every one of them.
 */
function placesOpenedStatement(
  start: Date,
  endExclusive: Date,
  cityId: string | undefined,
): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS "count"
      FROM "analytics_event" AS "e"
     WHERE "e"."name" = ${ANALYTICS_NAMES.placeOpened}
       AND "e"."occurred_at" >= ${start}
       AND "e"."occurred_at" < ${endExclusive}
       ${cityEquals('e', cityId)}
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

/**
 * The current call-task snapshot: what is waiting, what is live and what was set aside.
 *
 * Not range-bound, because a queue is a present-tense thing: a task queued today with no outcome
 * would vanish from a yesterday-to-today window the moment it was dialed.
 */
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
 * The operator queue's blocked tasks by reason, over the statuses a block can hold a task in:
 * waiting, held for review, or unreachable (AAP 0.5.3).
 *
 * `WHERE TRUE` above and the `AND`-prefixed city fragment keep this statement readable: the filter
 * is optional, and the alternative would be a second copy of the joins.
 */
function blockedReasonsStatement(env: AdminMetricsEnv, cityId: string | undefined): Prisma.Sql {
  return Prisma.sql`
    SELECT "t"."blocked_reason"::text AS "reason", count(*)::int AS "count"
      FROM "call_task" AS "t"
      ${callTaskJoins(env)}
     WHERE "t"."blocked_reason" IS NOT NULL
       AND "t"."status"::text IN ('queued', 'needs_review', 'unreachable')
       ${callTaskCity(cityId)}
     GROUP BY "t"."blocked_reason"
  `;
}

/**
 * The per-city, per-local-day calls and language-model spend the caps are drawn against (AAP 0.5.6).
 *
 * `local_date` is the city's own day, so the panel lines up with `CAP_CALLS_PER_CITY_DAY` and
 * `CAP_LLM_USD_PER_CITY_DAY`, which are counted per city per local day as well.
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
 * The lodging-claim measures, from the unlinked events that survive erasure (AAP 0.5.2, 0.5.7).
 *
 * The city filter reads `AnalyticsEvent.cityId`, so it counts a claim only when its emitter set that
 * field: `lodgings/claims.ts`, `admin/lodging-claims.ts` and the workers' `call-results` do.
 *
 * The median is `percentile_cont(0.5)` over the `resolveSeconds` the emitters recorded, rounded to a
 * whole second; the cast is guarded by a digit pattern so one malformed property cannot fail the
 * whole dashboard, and a range with no resolved claim answers `null` rather than 0.
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

/**
 * Signups over the range, from `account_created` (AAP 0.5.7).
 *
 * Neither filter applies: an account is created before any city is claimed or any meetup exists, so
 * a signup has no city and no pairing. The figure is a secondary measure and never the headline
 * (AAP 0.1.1).
 */
function signupsStatement(start: Date, endExclusive: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS "count"
      FROM "analytics_event" AS "e"
     WHERE "e"."name" = ${ANALYTICS_NAMES.signup}
       AND "e"."occurred_at" >= ${start}
       AND "e"."occurred_at" < ${endExclusive}
  `;
}

/** A per-city breakdown in the DTO's own shape (AAP 0.5.4). */
function cityCounts(rows: readonly CityCountRow[]): MetricsDto['activeProofsByCity'] {
  return rows.map((row) => ({ cityId: row.city_id, count: numberOf(row.count) }));
}

// ---------------------------------------------------------------------------------------------
// The dashboard (AAP 0.5.4, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * The operator dashboard for one range, city and variant pairing (AAP 0.5.4, 0.5.7).
 *
 * The statements are independent and run together, so the answer costs one round of queries rather
 * than thirteen. Nothing here writes, so there is no transaction and no row lock; the only non-SQL
 * read is the language-model suspension flag, which fails closed to "suspended" when it cannot be
 * read.
 *
 * @param services - The app's services: the database, the configuration, the logger and the
 *   suspension flag or Redis connection (see {@link AdminMetricsServices}).
 * @param query - The validated query string; an unknown `cityId` is not an error and simply yields
 *   zero figures.
 * @param now - The instant every live measure and both freshness cutoffs are measured from; the
 *   route passes `request.receivedAt` (AAP 0.11.1).
 * @returns The dashboard, field by field, in the shape of {@link MetricsDto}.
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
    opened,
    outcomes,
    lifecycle,
    blocked,
    budgets,
    claims,
    signups,
    suspension,
  ] = await Promise.all([
    services.db.$queryRaw<MeetupMeasureRow[]>(meetupsStatement(where, windowEnd)),
    services.db.$queryRaw<CountRow[]>(disputesStatement(where)),
    services.db.$queryRaw<VenueCountRow[]>(venuesStatement(where)),
    services.db.$queryRaw<CityCountRow[]>(activeProofsStatement(now, cityId)),
    services.db.$queryRaw<CityCountRow[]>(freshPricesStatement(services.env, now, cityId)),
    services.db.$queryRaw<CoverageRow[]>(neighborhoodsStatement(services.env, now, cityId)),
    services.db.$queryRaw<CountRow[]>(placesOpenedStatement(start, endExclusive, cityId)),
    services.db.$queryRaw<CallOutcomeRow[]>(
      callOutcomesStatement(services.env, start, endExclusive, cityId),
    ),
    services.db.$queryRaw<CallLifecycleRow[]>(callLifecycleStatement(services.env, cityId)),
    services.db.$queryRaw<BlockedReasonRow[]>(blockedReasonsStatement(services.env, cityId)),
    services.db.$queryRaw<BudgetDayRow[]>(budgetDaysStatement(query.from, query.to, cityId)),
    services.db.$queryRaw<LodgingClaimRow[]>(lodgingClaimsStatement(start, endExclusive, cityId)),
    services.db.$queryRaw<CountRow[]>(signupsStatement(start, endExclusive)),
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
      placesOpened: countOf(opened[0], 'count'),
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
    signups: countOf(signups[0], 'count'),
  };
}
