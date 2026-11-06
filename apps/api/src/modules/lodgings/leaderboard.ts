/**
 * The lodging leaderboard, the witnessed-meetup facts that feed it and the guest counts shown
 * beside it (AAP 0.5.7, 0.5.2, 0.5.4).
 *
 * Three shapes come out of this file: a city's ranked directory ({@link leaderboard}, behind
 * `GET /cities/:cityId/lodgings`), one lodging's standings for its own console
 * ({@link lodgingStats}, behind `GET /lodging-console/stats`) and the rows that record what
 * happened ({@link recordLodgingActivity}, {@link recordActivityForVerifiedClaim}). The two
 * writers are the only statements anywhere that create a `LodgingActivityFact`.
 *
 * The fact rows are the leaderboard's evidence and are deliberately impersonal (AAP 0.5.2): a fact
 * carries a lodging, a meetup, a keyed hash of the pair and the instant of completion, and no user
 * id at all, which is why a lodging's historical score is unchanged by a claim being deleted or an
 * account being erased. That hash (`pairKey`, the order-independent HMAC of the two ids under
 * `ANALYTICS_SALT`) is what lets one pair count once per 30 days without identifying anyone, and
 * the 90-day window {@link scoreFacts} applies is the window the console's 13 weekly points cover.
 *
 * This module is a leaf on purpose. It imports `@tablemate/db`, `@tablemate/server-core`,
 * `@tablemate/shared` and nothing from its own workspace, because `settlement/settle.ts`,
 * `consoles/routes.ts`, `admin/lodging-claims.ts` and the sibling `lodgings/*` modules all import
 * it, and a leaf cannot take part in an import cycle (AAP 0.3.2, AAP 0.5.1). Its services parameter
 * is therefore the app's services object narrowed structurally
 * ({@link LodgingLeaderboardServices}) rather than a type imported from `apps/api/src/app.ts`: that
 * composition root is another file's deliverable, it is not on this file's dependency whitelist,
 * and the narrowed interface states exactly the capabilities these functions use.
 *
 * Two invariants the SQL keeps:
 *
 * - Raw statements are `Prisma.sql` tagged templates with double-quoted identifiers, so no value is
 *   ever concatenated into SQL (AAP 0.11.2), and every statement that reads `lodging` or `venue`
 *   adds {@link fixturePredicate} for that alias, because a raw query bypasses the guarded client's
 *   fixture extension (AAP 0.5.2).
 * - A verified claim stays *active* until the end of its `stayTo` in the lodging's city time
 *   ({@link currentStayPredicate}), never until the end of a UTC day, so the directory's guest
 *   count, a lodging's guest list and the claim rules agree on who is currently staying
 *   (AAP 0.5.3, 0.5.7).
 *
 * @see AAP 0.5.7 for the leaderboard, visibility and claim rules, 0.5.2 for `LodgingActivityFact`
 *   and `LodgingClaim`, 0.5.4 for the directory and console routes, 0.8.1 for this file.
 */

import { Prisma, fixturePredicate, SQL_IDENTIFIER, type DbClient, type DbTx } from '@tablemate/db';
import {
  localDateKey,
  pairKey,
  type Clock,
  type CommonEnv,
  type Logger,
} from '@tablemate/server-core';
import {
  DAY_MS,
  E164,
  LEADERBOARD_CACHE_SECONDS,
  LEADERBOARD_PAIR_DEDUPE_DAYS,
  LEADERBOARD_WINDOW_DAYS,
  LODGING_TREND_WEEKS,
  LodgingSummary,
  toGuestCount,
  type AppEnv,
  type LodgingConsoleStats,
  type LodgingKind,
  type LodgingSort,
  type TrendPoint,
} from '@tablemate/shared';

import type { Redis } from 'ioredis';

// ---------------------------------------------------------------------------------------------
// Windows, keys and table aliases
// ---------------------------------------------------------------------------------------------

/** The activity window, in milliseconds (AAP 0.5.7: the last 90 days). */
const WINDOW_MS = LEADERBOARD_WINDOW_DAYS * DAY_MS;

/** The pair dedupe window, in milliseconds (AAP 0.5.7: one pair counts once in any 30 days). */
const PAIR_DEDUPE_MS = LEADERBOARD_PAIR_DEDUPE_DAYS * DAY_MS;

/** One week, the width of a console trend point (AAP 0.5.4). */
const WEEK_MS = 7 * DAY_MS;

/** The prefix of a city's leaderboard cache key: `leaderboard:<cityId>` (AAP 0.5.7). */
const CACHE_KEY_PREFIX = 'leaderboard:';

/** The alias the directory statement gives `lodging`. */
const LODGING_ALIAS = 'l';

/** The alias {@link currentStayPredicate} expects for `lodging_claim`. */
const CLAIM_ALIAS = 'c';

/** The alias {@link currentStayPredicate} expects for `city`. */
const CITY_ALIAS = 'ci';

/** The alias the venue-covering statement gives `venue`. */
const VENUE_ALIAS = 'v';

/** A calendar date as `YYYY-MM-DD`, the only spelling {@link toDateOnly} accepts. */
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------------------------
// Types (AAP 0.5.2, 0.5.4)
// ---------------------------------------------------------------------------------------------

/**
 * One witnessed-meetup fact as the leaderboard reads it: a row of `LodgingActivityFact`
 * (AAP 0.5.2) without its id and meetup id, which the score never needs.
 *
 * `pairKey` is the keyed pair hash `pairKey(ANALYTICS_SALT, initiatorId, recipientId)`; it is the
 * only trace of the two travelers a fact carries.
 */
export interface ActivityFact {
  readonly lodgingId: string;
  readonly pairKey: string;
  readonly completedAt: Date;
}

/**
 * One lodging's score over the activity window (AAP 0.5.7): how many facts counted, and when.
 *
 * `counted` is ascending and holds one instant per counted fact, which is what the console's
 * weekly trend buckets; `score` is always `counted.length`.
 */
export interface LodgingScore {
  /** Facts of the window that counted: the lodging's `activityScore`. */
  score: number;
  /** The `completedAt` of each counted fact, ascending. */
  counted: Date[];
}

/**
 * What {@link compareForLeaderboard} orders: the four values the ranking rule reads (AAP 0.5.7).
 *
 * `guestCount` is the raw verified-guest count, never the "fewer than 3" label a response renders,
 * because the tie-break needs the number even when the count is too small to disclose.
 */
export interface LeaderboardEntry {
  readonly id: string;
  readonly name: string;
  readonly activityScore: number;
  readonly guestCount: number;
}

/**
 * The meetup {@link recordLodgingActivity} records facts for (AAP 0.5.7).
 *
 * `cityId` is the *venue's* city, because the meetup's local date is defined in the city the
 * meeting happened in; `startsAt` is the UTC instant the meetup started.
 */
export interface LodgingActivityMeetup {
  readonly id: string;
  readonly initiatorId: string;
  readonly recipientId: string;
  readonly startsAt: Date;
  readonly cityId: string;
}

/** The claim {@link recordActivityForVerifiedClaim} backfills facts for (AAP 0.5.2, 0.5.7). */
export interface VerifiedClaimCoverage {
  readonly id: string;
  readonly userId: string;
  readonly lodgingId: string;
  /**
   * First day of the stay. A `Date` (what the `@db.Date` column reads back as) or an already
   * formatted `YYYY-MM-DD`; both are reduced to the calendar date.
   */
  readonly stayFrom: Date | string;
  /** Last day of the stay, in the same two accepted forms as {@link VerifiedClaimCoverage.stayFrom}. */
  readonly stayTo: Date | string;
}

/**
 * The app's services narrowed to what this module uses (AAP 0.3.2, 0.5.7).
 *
 * The app's own services object satisfies this structurally, so nothing here has to import the
 * composition root: `db` is the guarded Prisma client, `redis.client` the cache connection,
 * `clock` the injected clock (never `Date.now()`, AAP 0.11.1), `logger` the redacting pino logger,
 * `env` the validated environment of the process — the API and the workers share it — and
 * `timezoneFor` the configured IANA zone of a city, which is what turns an instant into a
 * city-local date.
 */
export interface LodgingLeaderboardServices {
  /** The guarded Prisma client; raw statements go through it, so they carry their own fixture predicate. */
  readonly db: DbClient;
  /** The Redis connection used for the 60-second leaderboard cache (AAP 0.5.7). */
  readonly redis: { readonly client: Pick<Redis, 'get' | 'set' | 'del'> };
  /** The injected clock (AAP 0.11.1). */
  readonly clock: Clock;
  /** The redacting logger; only cache-outage warnings are written from here (AAP 0.3.2). */
  readonly logger: Pick<Logger, 'warn'>;
  /** The validated environment: `APP_ENV` decides fixture visibility, `ANALYTICS_SALT` keys the pair hash. */
  readonly env: Pick<CommonEnv, 'APP_ENV' | 'ANALYTICS_SALT'>;
  /** The configured IANA zone of a city (`config/cities.json`, AAP 0.6.2). */
  readonly timezoneFor: (cityId: string) => string;
}

// ---------------------------------------------------------------------------------------------
// Scoring (AAP 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * Scores facts by the leaderboard rule of AAP 0.5.7, keyed by lodging id.
 *
 * A fact counts when its `completedAt` is inside the window — `now − 90 days < completedAt ≤ now`,
 * the strict lower bound matching the SQL the directory runs — **and** no previously counted fact
 * of the same (lodging, pair) is 30 days or less earlier: a fact counts when the previous counted
 * fact is *more than* 30 days before it. A fact that did not count never resets the chain, so a
 * pair that meets weekly contributes its 90-day window spaced 30 days apart rather than once.
 *
 * The 30-day boundary is the strict reading of "once in any 30 days": two completions exactly 30
 * days apart are *not* two counted facts here, while `reputation/anti-farming.ts` counts a second
 * completion in the window `(completedAt − 30 days, completedAt]`, where exactly 30 days would
 * count. The stricter rule is the one AAP 0.5.7 states for the leaderboard.
 *
 * Pure and synchronous: the caller passes the facts and the instant, so the same rows always score
 * the same way, and a unit test can pin every boundary without a database. Lodgings with no fact in
 * the window are absent from the result; a caller reads absence as a score of 0. Facts of one
 * (lodging, pair) are ordered by `completedAt` and, for equal instants, by their order in `facts`,
 * so the result does not depend on how the rows arrived.
 *
 * @param facts - The activity facts of one window, in any order.
 * @param now - The instant the 90-day window is measured back from; from `services.clock`.
 * @returns A map from lodging id to its score, holding only lodgings with a counted fact.
 * @see AAP 0.5.7 for the leaderboard rule, 0.5.2 for how the rows are written.
 */
export function scoreFacts(facts: readonly ActivityFact[], now: Date): Map<string, LodgingScore> {
  const nowMs = now.getTime();
  const windowStartMs = nowMs - WINDOW_MS;

  // Group first, because the pair chain of one lodging is independent of every other lodging's.
  const groups = new Map<
    string,
    { lodgingId: string; instants: { at: number; order: number }[] }
  >();
  let order = 0;

  for (const fact of facts) {
    order += 1;
    const at = fact.completedAt.getTime();
    if (!(at > windowStartMs && at <= nowMs)) {
      continue;
    }
    // A NUL cannot occur in a UUID or in a hex HMAC, so the join cannot merge two groups.
    const key = `${fact.lodgingId}\u0000${fact.pairKey}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { lodgingId: fact.lodgingId, instants: [{ at, order }] });
    } else {
      group.instants.push({ at, order });
    }
  }

  const counted = new Map<string, Date[]>();

  for (const group of groups.values()) {
    group.instants.sort((a, b) => a.at - b.at || a.order - b.order);
    let lastCountedMs: number | null = null;
    for (const instant of group.instants) {
      if (lastCountedMs === null || instant.at - lastCountedMs > PAIR_DEDUPE_MS) {
        lastCountedMs = instant.at;
        const instants = counted.get(group.lodgingId);
        // A fresh `Date` per counted fact: a caller's own `Date` instances stay untouched.
        if (instants === undefined) {
          counted.set(group.lodgingId, [new Date(instant.at)]);
        } else {
          instants.push(new Date(instant.at));
        }
      }
    }
  }

  const scores = new Map<string, LodgingScore>();
  for (const [lodgingId, instants] of counted) {
    instants.sort((a, b) => a.getTime() - b.getTime());
    scores.set(lodgingId, { score: instants.length, counted: instants });
  }

  return scores;
}

/**
 * Name, then id, so the order is total: the last two keys of {@link compareForLeaderboard} and the
 * whole order of `sort=name`. Generic over anything named and identified, so the same definition
 * serves both the scored entries and the serialized summaries.
 */
function compareByName<T extends { readonly id: string; readonly name: string }>(
  a: T,
  b: T,
): number {
  const byName = a.name.localeCompare(b.name, 'en');
  if (byName !== 0) {
    return byName;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The directory's ranking rule of AAP 0.5.7, as a comparator for `Array.prototype.sort`.
 *
 * Lodgings that witnessed a meetup in the window come first, ordered by score descending, then by
 * current verified guest count descending, then by name; lodgings scoring 0 follow, alphabetically.
 * `id` breaks a final tie so the order is total and a response does not reshuffle between two reads
 * of the same data.
 *
 * Pure, and exported so the rule can be unit-tested without a database.
 */
export function compareForLeaderboard(a: LeaderboardEntry, b: LeaderboardEntry): number {
  const aScored = a.activityScore > 0;
  const bScored = b.activityScore > 0;

  if (aScored !== bScored) {
    return aScored ? -1 : 1;
  }

  if (aScored) {
    if (a.activityScore !== b.activityScore) {
      return b.activityScore - a.activityScore;
    }
    if (a.guestCount !== b.guestCount) {
      return b.guestCount - a.guestCount;
    }
  }

  return compareByName(a, b);
}

/**
 * The verified-guest count as the contract renders it (AAP 0.5.4, criterion 15): the number from
 * `GUEST_COUNT_THRESHOLD` upward, or the label below it, so a traveler is never singled out by a
 * count of one or two.
 *
 * Re-exported from `@tablemate/shared` rather than reimplemented: the threshold, the label and the
 * client's rendering of that label must have exactly one definition.
 */
export { toGuestCount };

// ---------------------------------------------------------------------------------------------
// SQL helpers (AAP 0.5.2, 0.5.3, 0.5.7)
// ---------------------------------------------------------------------------------------------

/** Rejects an alias before it is interpolated into SQL text (AAP 0.11.2). */
function assertSqlAlias(alias: string): void {
  if (!SQL_IDENTIFIER.test(alias)) {
    throw new RangeError(`Expected a lower-case SQL identifier, received "${alias}"`);
  }
}

/**
 * The one definition of "a current verified guest", as a SQL fragment (AAP 0.5.3, 0.5.7).
 *
 * It reads as `"<claimAlias>"."status" = 'verified' AND "<claimAlias>"."stay_to" >= (now AT TIME
 * ZONE "<cityAlias>"."timezone")::date`: a verified claim stops being active at the *end of its
 * `stayTo` in the lodging's city time*, not at the end of a UTC day, so the guest count, a guest
 * list and the claim rules never disagree about who is staying.
 *
 * The caller's `FROM` must join the claim table under `claimAlias` and the city table under
 * `cityAlias`, with the city reached from the lodging (`"city" AS "ci" ON "ci"."id" = "l"."city_id"`).
 * `lodgings/claims.ts` and `lodgings/visibility.ts` reuse this fragment so all three readers cannot
 * drift apart.
 *
 * `now` is bound as a parameter and cast, never concatenated, and the two aliases are the only text
 * that reaches the SQL — validated against the shared identifier pattern first, which is why this
 * is safe despite interpolating identifiers (AAP 0.11.2).
 *
 * @param claimAlias - The alias of `lodging_claim` in the caller's statement.
 * @param cityAlias - The alias of `city` in the caller's statement.
 * @param now - The instant the city-local "today" is derived from; from `services.clock`.
 * @returns The SQL fragment, ready to be interpolated into a `Prisma.sql` statement.
 * @throws RangeError when an alias is not a plain lower-case identifier.
 * @see AAP 0.5.3 for a claim's active period, 0.5.7 for the guest count rule.
 */
export function currentStayPredicate(claimAlias: string, cityAlias: string, now: Date): Prisma.Sql {
  assertSqlAlias(claimAlias);
  assertSqlAlias(cityAlias);
  const claim = Prisma.raw(`"${claimAlias}"`);
  const city = Prisma.raw(`"${cityAlias}"`);
  return Prisma.sql`${claim}."status" = 'verified' AND ${claim}."stay_to" >= (CAST(${now} AS timestamptz) AT TIME ZONE ${city}."timezone")::date`;
}

/**
 * How many currently verified guests each of `lodgingIds` has (AAP 0.5.7 "Lodging visibility").
 *
 * Every current verified guest counts, whether or not they opted in to the guest list: the number
 * is a fact about the lodging, and `showStaying` decides only whether their tier-0 profile is
 * listed. The number is the raw count, because the caller decides whether it can be shown — a
 * caller serializing it goes through {@link toGuestCount}, which turns anything below
 * `GUEST_COUNT_THRESHOLD` into the label instead of a number that could single a guest out.
 *
 * One grouped statement answers a whole page of directory rows, and every requested id is present
 * in the result (at 0 when the lodging has no current guest), so a caller can read its entry
 * unconditionally. Works on the guarded client and inside a transaction alike, and opens none of
 * its own.
 *
 * `appEnv` is an explicit parameter rather than something read from the process, because the
 * statement reads `lodging` and a raw query bypasses the guarded client's fixture filter
 * (AAP 0.5.2): the caller that owns the process's environment states which one the count is for,
 * the way `calls/priority.ts` does for its own raw statements.
 *
 * @param db - The guarded client or a transaction's client.
 * @param lodgingIds - The lodgings to count; duplicates are collapsed, an empty list returns an
 *   empty map without touching the database.
 * @param now - The instant the city-local "today" is derived from; from `services.clock`.
 * @param appEnv - The process's `APP_ENV`, which decides fixture visibility.
 * @returns A map from lodging id to its current verified guest count, holding every requested id.
 */
export async function guestCountFor(
  db: DbClient | DbTx,
  lodgingIds: readonly string[],
  now: Date,
  appEnv: AppEnv,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const wanted = [...new Set(lodgingIds)];

  for (const lodgingId of wanted) {
    counts.set(lodgingId, 0);
  }

  if (wanted.length === 0) {
    return counts;
  }

  const rows = await db.$queryRaw<GuestCountRow[]>(Prisma.sql`
    SELECT "c"."lodging_id"::text AS "lodging_id",
           count(*)::int AS "guests"
      FROM "lodging_claim" AS "c"
      JOIN "lodging" AS "l" ON "l"."id" = "c"."lodging_id"
      JOIN "city" AS "ci" ON "ci"."id" = "l"."city_id"
     WHERE "c"."lodging_id" = ANY(${wanted}::uuid[])
       AND ${currentStayPredicate(CLAIM_ALIAS, CITY_ALIAS, now)}
       AND ${fixturePredicate(appEnv, LODGING_ALIAS)}
     GROUP BY "c"."lodging_id"
  `);

  for (const row of rows) {
    if (counts.has(row.lodging_id)) {
      counts.set(row.lodging_id, Number(row.guests));
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------------------------
// The city leaderboard (AAP 0.5.4, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * The cache key of a city's leaderboard: `leaderboard:<cityId>` (AAP 0.5.7).
 *
 * Keyed by city and not by environment, because a deployment owns its Redis: BullMQ's fixed queue
 * names and job ids already require one Redis per deployment, and no environment's stack is
 * pointed at another's. Everything a key holds is therefore a copy of what that deployment's own
 * database returned, and a stale entry can only ever be this city's own board.
 */
function leaderboardCacheKey(cityId: string): string {
  return `${CACHE_KEY_PREFIX}${cityId}`;
}

/** The stored number as a `LodgingSummary` can carry it: E.164, or no number at all. */
function normalizePhone(phone: string | null): string | null {
  return phone !== null && E164.safeParse(phone).success ? phone : null;
}

/** The facts of one statement, reduced to what scoring reads. */
function toActivityFacts(rows: readonly FactRow[]): ActivityFact[] {
  return rows.map((row) => ({
    lodgingId: row.lodging_id,
    pairKey: row.pair_key,
    completedAt: row.completed_at,
  }));
}

/** The activity-ordered directory from the database: two statements, then the pure rules. */
async function computeLeaderboard(
  services: LodgingLeaderboardServices,
  cityId: string,
  now: Date,
): Promise<LodgingSummary[]> {
  const appEnv = services.env.APP_ENV;

  // One statement for the city's listed lodgings, each with its current verified guest count as a
  // correlated subquery; one for every fact inside the window, served by
  // `lodging_activity_fact (lodging_id, completed_at)`.
  const lodgingRows = await services.db.$queryRaw<LodgingRow[]>(Prisma.sql`
    SELECT "l"."id"::text AS "id",
           "l"."city_id" AS "city_id",
           "l"."name" AS "name",
           "l"."kind" AS "kind",
           "l"."address" AS "address",
           "l"."phone" AS "phone",
           (SELECT count(*)::int
              FROM "lodging_claim" AS "c"
              JOIN "city" AS "ci" ON "ci"."id" = "l"."city_id"
             WHERE "c"."lodging_id" = "l"."id"
               AND ${currentStayPredicate(CLAIM_ALIAS, CITY_ALIAS, now)}) AS "guests"
      FROM "lodging" AS "l"
     WHERE "l"."city_id" = ${cityId}
       AND "l"."osm_missing_at" IS NULL
       AND ${fixturePredicate(appEnv, LODGING_ALIAS)}
  `);

  const factRows = await services.db.$queryRaw<FactRow[]>(Prisma.sql`
    SELECT "f"."lodging_id"::text AS "lodging_id",
           "f"."pair_key" AS "pair_key",
           "f"."completed_at" AS "completed_at"
      FROM "lodging_activity_fact" AS "f"
      JOIN "lodging" AS "l" ON "l"."id" = "f"."lodging_id"
     WHERE "l"."city_id" = ${cityId}
       AND "f"."completed_at" > ${new Date(now.getTime() - WINDOW_MS)}
       AND "f"."completed_at" <= ${now}
       AND ${fixturePredicate(appEnv, LODGING_ALIAS)}
  `);

  const scores = scoreFacts(toActivityFacts(factRows), now);

  const scored = lodgingRows.map((row) => ({
    id: row.id,
    name: row.name,
    activityScore: scores.get(row.id)?.score ?? 0,
    guestCount: Number(row.guests),
    row,
  }));

  scored.sort((a, b) => compareForLeaderboard(a, b));

  // Field by field, never a spread of the row: a column added to `lodging` cannot reach a client.
  const items = scored.map((entry, index) => ({
    id: entry.row.id,
    cityId: entry.row.city_id,
    name: entry.row.name,
    kind: entry.row.kind,
    address: entry.row.address,
    phone: normalizePhone(entry.row.phone),
    rank: index + 1,
    activityScore: entry.activityScore,
    guestCount: toGuestCount(entry.guestCount),
  }));

  return LodgingSummary.array().parse(items);
}

/** A cached directory, or `null` when there is none to use. Never throws (AAP 0.5.7). */
async function readLeaderboardCache(
  services: LodgingLeaderboardServices,
  cityId: string,
): Promise<LodgingSummary[] | null> {
  const key = leaderboardCacheKey(cityId);
  let raw: string | null;

  try {
    raw = await services.redis.client.get(key);
  } catch {
    services.logger.warn(
      { event: 'leaderboard_cache_unavailable', cityId },
      'leaderboard cache read failed; the board is computed from the database',
    );
    return null;
  }

  if (raw === null) {
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    services.logger.warn(
      { event: 'leaderboard_cache_invalid', cityId },
      'leaderboard cache entry is not JSON; the board is recomputed',
    );
    return null;
  }

  const parsed = LodgingSummary.array().safeParse(decoded);
  if (!parsed.success) {
    services.logger.warn(
      { event: 'leaderboard_cache_invalid', cityId },
      'leaderboard cache entry does not match the contract; the board is recomputed',
    );
    return null;
  }

  return parsed.data;
}

/** Caches the activity-ordered board for {@link LEADERBOARD_CACHE_SECONDS}. A failure is ignored. */
async function writeLeaderboardCache(
  services: LodgingLeaderboardServices,
  cityId: string,
  items: readonly LodgingSummary[],
): Promise<void> {
  try {
    await services.redis.client.set(
      leaderboardCacheKey(cityId),
      JSON.stringify(items),
      'EX',
      LEADERBOARD_CACHE_SECONDS,
    );
  } catch {
    services.logger.warn(
      { event: 'leaderboard_cache_unavailable', cityId },
      'leaderboard cache write failed; the board is still answered',
    );
  }
}

/**
 * A city's lodgings in the order the caller asked for, each with its rank, activity score and
 * current verified guest count (AAP 0.5.4 `GET /cities/:cityId/lodgings`, AAP 0.5.7).
 *
 * The activity order is what is cached, because it is the order that carries the ranks: on
 * `sort=activity` the rows come back exactly as scored and ranked, and on `sort=name` the same rows
 * are re-sorted alphabetically while keeping the rank each holds on the board, so the console and
 * the directory can never show two different standings for one lodging.
 *
 * The board is served from Redis for `LEADERBOARD_CACHE_SECONDS` and recomputed otherwise; a Redis
 * outage, an unreadable entry or a stale cache is logged and never fails the read, because the
 * directory is a read over PostgreSQL tables that stay available (AAP 0.3.2). The route has already
 * checked that the city exists and that the caller holds a proof for it, so neither is re-checked
 * here; a city with no lodging answers an empty list.
 *
 * @param services - The app's services, narrowed to what this module uses.
 * @param cityId - The city whose directory is wanted.
 * @param sort - `activity` (the default) or `name` (AAP 0.5.4).
 * @returns The city's lodgings, ranked; an empty array for a city with no listed lodging.
 * @throws ZodError when a row cannot satisfy `LodgingSummary`, which is a defect rather than a
 *   client error: the stored data and this mapping would have to disagree.
 * @see AAP 0.5.7 for the scoring and ranking rules, 0.5.4 for the route and its DTO.
 */
export async function leaderboard(
  services: LodgingLeaderboardServices,
  cityId: string,
  sort: LodgingSort,
): Promise<LodgingSummary[]> {
  const cached = await readLeaderboardCache(services, cityId);

  if (cached !== null) {
    return sort === 'name' ? [...cached].sort(compareByName) : cached;
  }

  const computed = await computeLeaderboard(services, cityId, services.clock.now());
  await writeLeaderboardCache(services, cityId, computed);

  return sort === 'name' ? [...computed].sort(compareByName) : computed;
}

/**
 * Drops a city's cached board (AAP 0.5.7).
 *
 * Callers run it only **after** the transaction that changed what the board counts has committed —
 * `lodgings/claims.ts` after deleting a verified claim and `admin/lodging-claims.ts` after
 * resolving one `verified` — so a rollback cannot leave a cold cache behind a change that never
 * happened. A Redis failure is logged and swallowed: the entry then simply lives out its
 * `LEADERBOARD_CACHE_SECONDS`.
 *
 * @param services - The app's services, narrowed to what this module uses.
 * @param cityId - The city whose entry is dropped.
 */
export async function invalidateLeaderboard(
  services: LodgingLeaderboardServices,
  cityId: string,
): Promise<void> {
  try {
    await services.redis.client.del(leaderboardCacheKey(cityId));
  } catch {
    services.logger.warn(
      { event: 'leaderboard_cache_unavailable', cityId },
      'leaderboard cache invalidation failed; the entry expires on its own',
    );
  }
}

// ---------------------------------------------------------------------------------------------
// One lodging's console standings (AAP 0.5.4)
// ---------------------------------------------------------------------------------------------

/** The weekly points of the 90-day trend, oldest first, summing to the lodging's score. */
function trendFromCounted(counted: readonly Date[], tz: string, now: Date): TrendPoint[] {
  const nowMs = now.getTime();
  const buckets = new Array<number>(LODGING_TREND_WEEKS).fill(0);

  for (const instant of counted) {
    // Bucket 0 is the week just ended: a fact 3 days old scores in the most recent point, a fact 91
    // days old in the oldest. The clamp keeps a fact completing exactly on a boundary inside the
    // trend rather than past its end.
    const weeks = Math.floor((nowMs - instant.getTime()) / WEEK_MS);
    const index = Math.min(Math.max(weeks, 0), LODGING_TREND_WEEKS - 1);
    buckets[index] = (buckets[index] ?? 0) + 1;
  }

  const trend: TrendPoint[] = [];
  for (let index = LODGING_TREND_WEEKS - 1; index >= 0; index -= 1) {
    trend.push({
      weekStart: localDateKey(tz, new Date(nowMs - (index + 1) * WEEK_MS)),
      activityScore: buckets[index] ?? 0,
    });
  }

  return trend;
}

/** One lodging's facts inside the window, in any order. */
async function readLodgingFacts(
  db: DbClient | DbTx,
  lodgingId: string,
  now: Date,
): Promise<ActivityFact[]> {
  const rows = await db.$queryRaw<FactRow[]>(Prisma.sql`
    SELECT "f"."lodging_id"::text AS "lodging_id",
           "f"."pair_key" AS "pair_key",
           "f"."completed_at" AS "completed_at"
      FROM "lodging_activity_fact" AS "f"
     WHERE "f"."lodging_id" = ${lodgingId}::uuid
       AND "f"."completed_at" > ${new Date(now.getTime() - WINDOW_MS)}
       AND "f"."completed_at" <= ${now}
  `);

  return toActivityFacts(rows);
}

/**
 * The standings the lodging console renders (AAP 0.5.4 `GET /lodging-console/stats`).
 *
 * `rank` is the lodging's position in its city's activity order and is 1 or greater even for a
 * lodging scoring 0. A lodging that has left the directory (`osmMissingAt` set, AAP 0.5.6) has no
 * position at all: its own facts still score it and it is placed after every listed lodging
 * (`listed.length + 1`), so its console keeps reporting activity while the directory stays free of
 * a lodging OpenStreetMap no longer has.
 *
 * `activityScore` and `weeklyTrend` come from this lodging's own facts, read fresh: the score is
 * exactly the number of counted facts, and the 13 weekly points bucket those same facts, so the
 * points always sum to the score. The rank comes from the cached board, and the guest count from
 * {@link guestCountFor}, which is why those two can trail a change by up to the cache's life.
 *
 * `rank` is read from the activity board rather than counted by a statement of its own, so that
 * this console and the directory answer with one number: the position has to be the one the
 * board's own order gives it, from the single implementation of the ranking rule
 * ({@link scoreFacts}' pair chain and {@link compareForLeaderboard}'s `en` name order), and a
 * second implementation in SQL could drift from either and place the console out of step with
 * the directory. The cost is bounded by the cache: a warm city costs a cache read, and a cold
 * one at most one recomputation of a board the directory asks for anyway.
 *
 * @param services - The app's services, narrowed to what this module uses.
 * @param lodgingId - The lodging whose standings are wanted.
 * @returns The console's DTO, built field by field.
 * @throws Error when no such lodging exists, which the console route cannot produce (it resolved
 *   the lodging from its own secret first) and which must not be answered as a standing.
 */
export async function lodgingStats(
  services: LodgingLeaderboardServices,
  lodgingId: string,
): Promise<LodgingConsoleStats> {
  const now = services.clock.now();

  const lodging = await services.db.lodging.findUnique({
    where: { id: lodgingId },
    select: { id: true, cityId: true },
  });

  if (lodging === null) {
    throw new Error(`lodgingStats: no lodging with id ${lodgingId}`);
  }

  const listed = await leaderboard(services, lodging.cityId, 'activity');
  const position = listed.findIndex((item) => item.id === lodgingId);
  const rank = position === -1 ? listed.length + 1 : position + 1;

  const counted = scoreFacts(await readLodgingFacts(services.db, lodgingId, now), now).get(
    lodgingId,
  );
  const guests = await guestCountFor(services.db, [lodgingId], now, services.env.APP_ENV);

  return {
    rank,
    activityScore: counted?.counted.length ?? 0,
    verifiedGuests: toGuestCount(guests.get(lodgingId) ?? 0),
    weeklyTrend: trendFromCounted(
      counted?.counted ?? [],
      services.timezoneFor(lodging.cityId),
      now,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Writing facts (AAP 0.5.2, 0.5.7)
// ---------------------------------------------------------------------------------------------

/** A calendar date in the one spelling the SQL casts accept. */
function toDateOnly(value: Date | string): string {
  if (typeof value !== 'string') {
    return value.toISOString().slice(0, 10);
  }
  if (!LOCAL_DATE_RE.test(value)) {
    throw new RangeError(`Expected a calendar date as YYYY-MM-DD, received "${value}"`);
  }
  return value;
}

/**
 * Records the activity facts of a completed meetup, inside the settlement's transaction
 * (AAP 0.5.7). Called by `settlement/settle.ts` for a `completed` outcome only — both attendees
 * present — and for nothing else.
 *
 * The rule this function implements, which `apps/workers/src/jobs/call-results.ts` must write
 * identically when it verifies a claim, because the workers cannot import the API:
 *
 * - Meetup local date = `(meetup.starts_at AT TIME ZONE city.timezone)::date`, the city being the
 *   meetup venue's city.
 * - A verified claim *covers* a meetup when `claim.status = 'verified' AND claim.stay_from <=
 *   local_date AND claim.stay_to >= local_date`.
 * - `pair_key = pairKey(ANALYTICS_SALT, initiatorId, recipientId)` (server-core; order-independent
 *   HMAC).
 * - One fact per distinct (lodging, meetup); insert with `ON CONFLICT (lodging_id, meetup_id) DO
 *   NOTHING`.
 *
 * So a meetup credits every lodging where either attendee held a verified claim covering that day
 * — one fact per lodging, however many of the two stayed there — and the fact carries the pair hash
 * and the settlement instant, never a user id. `createMany({ skipDuplicates: true })` is what
 * spells the `ON CONFLICT` in Prisma terms, and it is what makes a second settlement run of the
 * same meetup write nothing and report 0.
 *
 * @param tx - The settlement's transaction client; the facts commit with the outcome they describe.
 * @param services - The app's services, narrowed to what this module uses.
 * @param meetup - The settled meetup: its id, both participants, `startsAt` and the venue's city.
 * @param completedAt - The instant recorded on each fact; the settlement time by default.
 * @returns The number of facts inserted, 0 when nobody held a verified claim covering the day or
 *   when the facts already existed.
 */
export async function recordLodgingActivity(
  tx: DbTx,
  services: LodgingLeaderboardServices,
  meetup: LodgingActivityMeetup,
  completedAt: Date = services.clock.now(),
): Promise<number> {
  const localDate = localDateKey(services.timezoneFor(meetup.cityId), meetup.startsAt);
  const participants = [meetup.initiatorId, meetup.recipientId];

  // A verified claim covering the meetup's local date, by either participant. Only the claim table
  // is read, so no fixture predicate is needed: a claim is user data, and a fixture lodging outside
  // `test`/`demo` has no claim pointing at it.
  const rows = await tx.$queryRaw<LodgingIdRow[]>(Prisma.sql`
    SELECT DISTINCT "c"."lodging_id"::text AS "lodging_id"
      FROM "lodging_claim" AS "c"
     WHERE "c"."user_id" = ANY(${participants}::uuid[])
       AND "c"."status" = 'verified'
       AND "c"."stay_from" <= CAST(${localDate} AS date)
       AND "c"."stay_to" >= CAST(${localDate} AS date)
  `);

  if (rows.length === 0) {
    return 0;
  }

  const pair = pairKey(services.env.ANALYTICS_SALT, meetup.initiatorId, meetup.recipientId);

  const inserted = await tx.lodgingActivityFact.createMany({
    data: rows.map((row) => ({
      lodgingId: row.lodging_id,
      meetupId: meetup.id,
      pairKey: pair,
      completedAt,
    })),
    skipDuplicates: true,
  });

  return inserted.count;
}

/**
 * Backfills the activity facts of a claim that just became `verified` (AAP 0.5.7). Called by
 * `admin/lodging-claims.ts` inside the transaction that resolves the claim.
 *
 * A stay that turns out to be genuine credits the lodging's board with the meetups the same
 * traveler attended during those dates, so the ranking reflects where travelers actually met rather
 * than only which claims were verified before the meeting happened.
 *
 * The rule is the same one {@link recordLodgingActivity} implements, and is repeated here verbatim
 * because the workers must write it identically: meetup local date =
 * `(meetup.starts_at AT TIME ZONE city.timezone)::date` with the city being the meetup venue's
 * city; a verified claim *covers* a meetup when `claim.status = 'verified' AND claim.stay_from <=
 * local_date AND claim.stay_to >= local_date`; `pair_key = pairKey(ANALYTICS_SALT, initiatorId,
 * recipientId)`; one fact per distinct (lodging, meetup), inserted with `ON CONFLICT (lodging_id,
 * meetup_id) DO NOTHING`.
 *
 * Only meetups settled inside the activity window are read, because an older one could not count;
 * each fact carries the meetup's own `settledAt` as its completion time, so backfilling never
 * moves a historical score to today. Running it twice writes nothing the second time.
 *
 * @param tx - The transaction that resolves the claim.
 * @param services - The app's services, narrowed to what this module uses.
 * @param claim - The claim that became verified: its id, owner, lodging and stay dates.
 * @returns The number of facts inserted.
 */
export async function recordActivityForVerifiedClaim(
  tx: DbTx,
  services: LodgingLeaderboardServices,
  claim: VerifiedClaimCoverage,
): Promise<number> {
  const now = services.clock.now();
  const stayFrom = toDateOnly(claim.stayFrom);
  const stayTo = toDateOnly(claim.stayTo);

  const rows = await tx.$queryRaw<ClaimMeetupRow[]>(Prisma.sql`
    SELECT "m"."id"::text AS "id",
           "m"."initiator_id"::text AS "initiator_id",
           "m"."recipient_id"::text AS "recipient_id",
           "m"."settled_at" AS "settled_at"
      FROM "meetup" AS "m"
      JOIN "venue" AS "v" ON "v"."id" = "m"."venue_id"
      JOIN "city" AS "ci" ON "ci"."id" = "v"."city_id"
     WHERE "m"."status" = 'completed'
       AND "m"."settled_at" IS NOT NULL
       AND "m"."settled_at" > ${new Date(now.getTime() - WINDOW_MS)}
       AND ("m"."initiator_id" = ${claim.userId}::uuid
            OR "m"."recipient_id" = ${claim.userId}::uuid)
       AND (("m"."starts_at" AT TIME ZONE "ci"."timezone")::date
              BETWEEN CAST(${stayFrom} AS date) AND CAST(${stayTo} AS date))
       AND ${fixturePredicate(services.env.APP_ENV, VENUE_ALIAS)}
  `);

  if (rows.length === 0) {
    return 0;
  }

  const inserted = await tx.lodgingActivityFact.createMany({
    data: rows.map((row) => ({
      lodgingId: claim.lodgingId,
      meetupId: row.id,
      pairKey: pairKey(services.env.ANALYTICS_SALT, row.initiator_id, row.recipient_id),
      completedAt: row.settled_at,
    })),
    skipDuplicates: true,
  });

  return inserted.count;
}

// ---------------------------------------------------------------------------------------------
// Statement row shapes
// ---------------------------------------------------------------------------------------------

/** One row of the directory statement: a listed lodging with its current verified guest count. */
interface LodgingRow {
  readonly id: string;
  readonly city_id: string;
  readonly name: string;
  readonly kind: LodgingKind;
  readonly address: string | null;
  readonly phone: string | null;
  readonly guests: number;
}

/** One row of a facts statement. */
interface FactRow {
  readonly lodging_id: string;
  readonly pair_key: string;
  readonly completed_at: Date;
}

/** One row of the covering-claims statement. */
interface LodgingIdRow {
  readonly lodging_id: string;
}

/** One grouped row of the guest-count statement. */
interface GuestCountRow {
  readonly lodging_id: string;
  readonly guests: number;
}

/** One row of the claimant's completed-meetup statement. */
interface ClaimMeetupRow {
  readonly id: string;
  readonly initiator_id: string;
  readonly recipient_id: string;
  readonly settled_at: Date;
}
