/**
 * The lodging leaderboard, the witnessed-meetup facts that feed it and the guest counts shown beside it.
 *
 * The fact rows are impersonal: a fact carries a lodging, a meetup, a keyed pair hash and the completion instant,
 * never a user id, so a lodging's historical score survives a deleted claim or an erased account. Six invariants
 * this module keeps: raw statements name double-quoted identifiers and add {@link fixturePredicate} for every
 * `lodging`/`venue` alias, because a raw query bypasses the guarded client's fixture extension; the cached board is
 * a projection of the process's fixture policy, so its key carries `APP_ENV` and a process outside `test`/`demo` is
 * never served a board a fixture-allowing process computed; a verified claim stays active to the end of its `stayTo`
 * in the lodging's city time, never to the end of a UTC day; a deleted or erasure-pending traveler is not a current
 * guest; the directory bound is ordered so it cannot drop a scored lodging, is logged when it bites, and a lodging it
 * left out is answered with its own numbers rather than `404`. A leaf on purpose: it imports no module of its own
 * workspace, so no import cycle reaches it.
 */

import {
  Prisma,
  coveringMeetupStatement,
  fixturePredicate,
  SQL_IDENTIFIER,
  type CoveringMeetupRow,
  type DbClient,
  type DbTx,
} from '@tablemate/db';
import {
  addLocalDays,
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

const WINDOW_MS = LEADERBOARD_WINDOW_DAYS * DAY_MS;

const PAIR_DEDUPE_MS = LEADERBOARD_PAIR_DEDUPE_DAYS * DAY_MS;

/** The width of a console trend point: a step back by city-local dates, never by a multiple of 24 h. */
const WEEK_DAYS = 7;

const CACHE_KEY_PREFIX = 'leaderboard:';

/** The version stamped into a city's cached board. */
export const LEADERBOARD_CACHE_VERSION = 1;

// A bounded answer stays visible rather than read as a complete one: a directory read past
// LODGING_DIRECTORY_LIMIT or a lodging whose window facts reached LODGING_ACTIVITY_FACTS_LIMIT is logged under its
// own event, carrying the city or the lodging and the bound and nothing else.
const LODGINGS_TRUNCATED = 'lodgings_truncated';
const LODGING_ACTIVITY_FACTS_CAPPED = 'lodging_activity_facts_capped';

const LODGING_ALIAS = 'l';

const CLAIM_ALIAS = 'c';

const CITY_ALIAS = 'ci';

const USER_ALIAS = 'u';

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One witnessed-meetup fact as the leaderboard reads it: a row of `LodgingActivityFact` without its id and meetup
 * id, which the score never needs. `pairKey` is the only trace of the two travelers a fact carries.
 */
export interface ActivityFact {
  readonly lodgingId: string;
  readonly pairKey: string;
  readonly completedAt: Date;
}

/**
 * One lodging's score over the activity window: `counted` is ascending and holds one instant per counted fact, which
 * the console's weekly trend buckets, and `score` is always `counted.length`.
 */
export interface LodgingScore {
  score: number;
  counted: Date[];
}

/**
 * What {@link compareForLeaderboard} orders: `guestCount` is the raw verified-guest count, never the label a
 * response renders below the threshold, because the tie-break needs the number even when it cannot be disclosed.
 */
export interface LeaderboardEntry {
  readonly id: string;
  readonly name: string;
  readonly activityScore: number;
  readonly guestCount: number;
}

/**
 * The meetup {@link recordLodgingActivity} records facts for: `cityId` is the *venue's* city, because the meetup's
 * local date is defined in the city the meeting happened in.
 */
export interface LodgingActivityMeetup {
  readonly id: string;
  readonly initiatorId: string;
  readonly recipientId: string;
  readonly startsAt: Date;
  readonly cityId: string;
}

export interface VerifiedClaimCoverage {
  readonly id: string;
  readonly userId: string;
  readonly lodgingId: string;
  /** First day of the stay: a `Date` or an already formatted `YYYY-MM-DD`, both reduced to the calendar date. */
  readonly stayFrom: Date | string;
  readonly stayTo: Date | string;
}

/**
 * The app's services narrowed to what this module uses, satisfied structurally so nothing here imports the
 * composition root. `clock` is the injected clock, never `Date.now()`.
 */
export interface LodgingLeaderboardServices {
  readonly db: DbClient;
  readonly redis: { readonly client: Pick<Redis, 'get' | 'set' | 'del'> };
  readonly clock: Clock;
  readonly logger: Pick<Logger, 'warn'>;
  readonly env: Pick<CommonEnv, 'APP_ENV' | 'ANALYTICS_SALT'>;
  readonly timezoneFor: (cityId: string) => string;
}

/**
 * Scores facts by the leaderboard rule, keyed by lodging id.
 *
 * A fact counts when `now − 90 days < completedAt <= now`, the strict lower bound matching the SQL the directory
 * runs, **and** no counted fact of the same (lodging, pair) is 30 days or less earlier; a fact that did not count
 * never resets the chain, so a pair meeting weekly contributes its window spaced 30 days apart rather than once. The
 * 30-day boundary is the strict reading of "once in any 30 days": two completions exactly 30 days apart are not two
 * counted facts here, while `reputation/anti-farming.ts` counts the second over `(completedAt - 30 days,
 * completedAt]`. Pure and synchronous, so a unit test can pin every boundary without a database; a lodging with no
 * fact in the window is absent from the result, which a caller reads as a score of 0, and facts of one (lodging,
 * pair) are ordered by `completedAt` and then by their order in `facts`, so the result does not depend on how the
 * rows arrived.
 */
export function scoreFacts(facts: readonly ActivityFact[], now: Date): Map<string, LodgingScore> {
  const nowMs = now.getTime();
  const windowStartMs = nowMs - WINDOW_MS;
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
 * Name, then id, so the order is total. Generic over anything named and identified, so the same definition serves
 * both the scored entries and the serialized summaries.
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
 * The directory's ranking rule: lodgings that witnessed a meetup in the window first, by score descending, then by
 * current verified guest count descending, then by name; lodgings scoring 0 follow, alphabetically. `id` breaks a
 * final tie, so the order is total and a response does not reshuffle between two reads of the same data.
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
 * The verified-guest count as the contract renders it: the number from `GUEST_COUNT_THRESHOLD` upward, or the label
 * below it, so nobody is singled out by a count of one or two.
 *
 * Re-exported from `@tablemate/shared` rather than reimplemented: the threshold, the label and the client's rendering
 * of that label must have exactly one definition.
 */
export { toGuestCount };

/** Rejects an alias before it is interpolated into SQL text (AAP 0.11.2). */
function assertSqlAlias(alias: string): void {
  if (!SQL_IDENTIFIER.test(alias)) {
    throw new RangeError(`Expected a lower-case SQL identifier, received "${alias}"`);
  }
}

/**
 * The one definition of "a current verified guest", as a SQL fragment: `status = 'verified' AND stay_to >= (now AT
 * TIME ZONE city.timezone)::date`, so a verified claim stops being active at the *end of its `stayTo` in the
 * lodging's city time*, not at the end of a UTC day, and the guest count, a guest list and the claim rules cannot
 * disagree about who is staying.
 *
 * The caller's `FROM` must join the claim table under `claimAlias` and the city table under `cityAlias`, with the
 * city reached from the lodging; `lodgings/claims.ts` and `lodgings/visibility.ts` reuse this fragment so all three
 * readers cannot drift apart. `now` is bound as a parameter and cast, never concatenated, and the two aliases are
 * the only text that reaches the SQL — validated against the shared identifier pattern first.
 *
 * @throws RangeError when an alias is not a plain lower-case identifier.
 */
export function currentStayPredicate(claimAlias: string, cityAlias: string, now: Date): Prisma.Sql {
  assertSqlAlias(claimAlias);
  assertSqlAlias(cityAlias);
  const claim = Prisma.raw(`"${claimAlias}"`);
  const city = Prisma.raw(`"${cityAlias}"`);
  return Prisma.sql`${claim}."status" = 'verified' AND ${claim}."stay_to" >= (CAST(${now} AS timestamptz) AT TIME ZONE ${city}."timezone")::date`;
}

/**
 * The one definition of "a traveler this deployment still counts", as a SQL fragment: `deleted_at IS NULL AND
 * deletion_requested_at IS NULL`, so a traveler who asked for erasure, or whose account is a tombstone, stops being
 * a current guest at once — the `lodging_claim` row that names them outlives `DELETE /me` until `account-erasure`
 * removes it. `lodgings/visibility.ts` excludes the same two states from the guest list it renders, so the count
 * beside a lodging and the guests listed under it cannot disagree.
 *
 * The caller's `FROM` must join the user table to the claim's owner, which is why this takes the alias rather than
 * naming one. No value reaches the SQL: the alias is the only text, validated against the shared identifier pattern
 * first.
 *
 * @throws RangeError when the alias is not a plain lower-case identifier.
 */
function liveTravelerPredicate(userAlias: string): Prisma.Sql {
  assertSqlAlias(userAlias);
  const user = Prisma.raw(`"${userAlias}"`);
  return Prisma.sql`${user}."deleted_at" IS NULL AND ${user}."deletion_requested_at" IS NULL`;
}

/**
 * How many currently verified guests each of `lodgingIds` has. Every current verified guest counts, whether or not
 * they opted in to the guest list: the number is a fact about the lodging, and `showStaying` decides only whether
 * their profile is listed. A current guest is also a traveler this deployment still counts, so the statement joins
 * `"user"` and drops a deleted or erasure-pending account, which is what makes the count agree with the guest list
 * `lodgings/visibility.ts` renders. The number returned is the raw count, because the caller decides whether it can
 * be shown — a caller serializing it goes through {@link toGuestCount}.
 *
 * One grouped statement answers a whole page of directory rows and every requested id is present in the result, at 0
 * when the lodging has no current guest, so a caller can read its entry unconditionally. `appEnv` is an explicit
 * parameter rather than something read from the process, because the statement reads `lodging` and a raw query
 * bypasses the guarded client's fixture filter.
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
      JOIN "user" AS "u" ON "u"."id" = "c"."user_id"
     WHERE "c"."lodging_id" = ANY(${wanted}::uuid[])
       AND ${currentStayPredicate(CLAIM_ALIAS, CITY_ALIAS, now)}
       AND ${liveTravelerPredicate(USER_ALIAS)}
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

/**
 * The cache key of a city's leaderboard, keyed by the environment as well as the city because the board is a
 * projection of the process's fixture policy: without `APP_ENV` in the key, a process outside `test` and `demo`
 * reading a Redis it shares with a fixture-allowing process would be served that process's fixture-bearing board.
 * Each environment therefore keeps its own entry, and the 60-second TTL each writer sets bounds how long one stands.
 */
function leaderboardCacheKey(appEnv: AppEnv, cityId: string): string {
  return `${CACHE_KEY_PREFIX}${appEnv}:${cityId}`;
}

function normalizePhone(phone: string | null): string | null {
  return phone !== null && E164.safeParse(phone).success ? phone : null;
}

/**
 * The one mapping from a listed lodging's row to the summary the contract publishes: field by field, never a spread
 * of the row, so a column added to `lodging` cannot reach a client. The phone goes through {@link normalizePhone}
 * and the guest count through `toGuestCount`, and both the directory and one lodging's detail page map through this
 * function rather than each spelling the DTO out, so the two answers for one lodging cannot describe it differently.
 */
function toLodgingSummary(row: LodgingRow, activityScore: number, rank: number): LodgingSummary {
  return {
    id: row.id,
    cityId: row.city_id,
    name: row.name,
    kind: row.kind,
    address: row.address,
    phone: normalizePhone(row.phone),
    rank,
    activityScore,
    guestCount: toGuestCount(Number(row.guests)),
  };
}

function toActivityFacts(rows: readonly FactRow[]): ActivityFact[] {
  return rows.map((row) => ({
    lodgingId: row.lodging_id,
    pairKey: row.pair_key,
    completedAt: row.completed_at,
  }));
}

/**
 * How many lodgings one city's directory answers, and the largest id list its fact read is driven from. The
 * directory answers a city's listed lodgings in full otherwise, and a city's bounding box holds every hostel, hotel
 * and guest house OpenStreetMap has, so that list — and with it the value cached in Redis and the payload a
 * client renders — would grow with the ingestion rather than with any decision of ours. AAP 0.5.4 fixes no
 * cursor for this route, so a cap is the resolution rather than a contract change.
 *
 * The statement asks for one row beyond this bound and reads it as a sentinel: it is dropped before a board is
 * built, and its presence reports the truncation. The order it cuts in keeps the ranking's own inputs as far ahead
 * as SQL can express them, so the bound cannot drop a lodging that witnessed a meetup while one that witnessed
 * nothing survives it. A silently cut directory would read as a complete one, which is why the cut is made visible.
 */
export const LODGING_DIRECTORY_LIMIT = 500;

/**
 * How many activity facts of the window one lodging's score reads, newest first. This is the score's saturation
 * point rather than a judgement about a lodging: the rows are scored only for lodgings the directory lists, and the
 * statement reads one row beyond this bound per lodging so that a lodging which exceeded it is reported through
 * `lodging_activity_facts_capped`. A lodging that exceeded it would report the capped number rather than its own, so
 * the bound is set far beyond any count a pilot city's meetup history reaches.
 */
export const LODGING_ACTIVITY_FACTS_LIMIT = 1000;

/**
 * The window facts of the lodgings the directory listed, capped per lodging. Driven by the id list the directory
 * statement returned, so it reads no lodging the answer cannot show, and every row carries its own newest-first
 * position among its lodging's window facts: the rows past {@link LODGING_ACTIVITY_FACTS_LIMIT} are the sentinel and
 * are dropped here, and the lodging they belonged to is reported through `lodging_activity_facts_capped`, so a score
 * that reports the capped number is visible rather than read as an exact one.
 *
 * The window predicate is the one {@link scoreFacts} applies, so the rows read and the rows scored agree. The
 * statement's own `lodging` join carries {@link fixturePredicate}, because every statement in this file that reads
 * `lodging` carries it, and that predicate is one value per lodging, so joining cannot change which of a lodging's
 * own facts survive the cap.
 */
async function readWindowFacts(
  services: LodgingLeaderboardServices,
  lodgingIds: readonly string[],
  now: Date,
): Promise<ActivityFact[]> {
  if (lodgingIds.length === 0) {
    return [];
  }
  const rows = await services.db.$queryRaw<BoundedFactRow[]>(Prisma.sql`
    SELECT "r"."lodging_id"::text AS "lodging_id",
           "r"."pair_key" AS "pair_key",
           "r"."completed_at" AS "completed_at",
           "r"."seq"::int AS "seq"
      FROM unnest(${lodgingIds}::uuid[]) AS "d"("lodging_id")
      JOIN "lodging" AS "l" ON "l"."id" = "d"."lodging_id"
      JOIN LATERAL (
        SELECT "f"."lodging_id",
               "f"."pair_key",
               "f"."completed_at",
               row_number() OVER (ORDER BY "f"."completed_at" DESC) AS "seq"
          FROM "lodging_activity_fact" AS "f"
         WHERE "f"."lodging_id" = "d"."lodging_id"
           AND "f"."completed_at" > ${new Date(now.getTime() - WINDOW_MS)}
           AND "f"."completed_at" <= ${now}
      ) AS "r" ON true
     WHERE "r"."seq" <= ${LODGING_ACTIVITY_FACTS_LIMIT + 1}
       AND ${fixturePredicate(services.env.APP_ENV, LODGING_ALIAS)}
  `);
  const capped = new Set<string>();
  const facts: ActivityFact[] = [];
  for (const row of rows) {
    if (row.seq > LODGING_ACTIVITY_FACTS_LIMIT) {
      capped.add(row.lodging_id);
      continue;
    }
    facts.push({
      lodgingId: row.lodging_id,
      pairKey: row.pair_key,
      completedAt: row.completed_at,
    });
  }
  for (const lodgingId of capped) {
    services.logger.warn(
      { event: LODGING_ACTIVITY_FACTS_CAPPED, lodgingId, limit: LODGING_ACTIVITY_FACTS_LIMIT },
      'a lodging holds more facts in the window than the score reads; the oldest are left out of it',
    );
  }
  return facts;
}

async function computeLeaderboard(
  services: LodgingLeaderboardServices,
  cityId: string,
  now: Date,
): Promise<LodgingSummary[]> {
  const appEnv = services.env.APP_ENV;
  const windowStart = new Date(now.getTime() - WINDOW_MS);
  // The guest count as the statement's own expression, written once and read twice — as the `guests` column and as
  // the count the order breaks a score tie by — so the number the directory answers and the number it orders by
  // cannot disagree. It counts exactly what `guestCountFor` counts, joining `"user"` and dropping a deleted or
  // erasure-pending traveler, so the directory's number and one lodging's guest list cannot disagree either.
  const guests = Prisma.sql`(SELECT count(*)::int
            FROM "lodging_claim" AS "c"
            JOIN "city" AS "ci" ON "ci"."id" = "l"."city_id"
            JOIN "user" AS "u" ON "u"."id" = "c"."user_id"
           WHERE "c"."lodging_id" = "l"."id"
             AND ${currentStayPredicate(CLAIM_ALIAS, CITY_ALIAS, now)}
             AND ${liveTravelerPredicate(USER_ALIAS)})`;
  // One statement for the city's listed lodgings, ordered as the bound cuts in: a lodging with a fact inside the
  // window first, then the current verified guest count, then name and id. That order is not the board's order —
  // `scoreFacts` and `compareForLeaderboard` are the one implementation of the ranking rule — but it states the
  // ranking's own inputs as far as SQL can, so a city past LODGING_DIRECTORY_LIMIT loses unscored lodgings rather than
  // scored ones. The row past the bound is a sentinel: dropped here, and its presence reports the truncation.
  const lodgingRows = await services.db.$queryRaw<LodgingRow[]>(Prisma.sql`
    SELECT "l"."id"::text AS "id",
           "l"."city_id" AS "city_id",
           "l"."name" AS "name",
           "l"."kind" AS "kind",
           "l"."address" AS "address",
           "l"."phone" AS "phone",
           ${guests} AS "guests"
      FROM "lodging" AS "l"
     WHERE "l"."city_id" = ${cityId}
       AND "l"."osm_missing_at" IS NULL
       AND ${fixturePredicate(appEnv, LODGING_ALIAS)}
     ORDER BY (EXISTS (SELECT 1
                         FROM "lodging_activity_fact" AS "f"
                        WHERE "f"."lodging_id" = "l"."id"
                          AND "f"."completed_at" > ${windowStart}
                          AND "f"."completed_at" <= ${now})) DESC,
              "guests" DESC,
              "l"."name" ASC,
              "l"."id" ASC
     LIMIT ${LODGING_DIRECTORY_LIMIT + 1}
  `);
  const truncated = lodgingRows.length > LODGING_DIRECTORY_LIMIT;
  const listed = truncated ? lodgingRows.slice(0, LODGING_DIRECTORY_LIMIT) : lodgingRows;
  if (truncated) {
    services.logger.warn(
      { event: LODGINGS_TRUNCATED, cityId, limit: LODGING_DIRECTORY_LIMIT },
      'the city holds more lodgings than the directory answers; the rest are left out of it',
    );
  }
  const scores = scoreFacts(
    await readWindowFacts(
      services,
      listed.map((row) => row.id),
      now,
    ),
    now,
  );
  const scored = listed.map((row) => ({
    id: row.id,
    name: row.name,
    activityScore: scores.get(row.id)?.score ?? 0,
    guestCount: Number(row.guests),
    row,
  }));
  scored.sort((a, b) => compareForLeaderboard(a, b));
  // Field by field through the one mapping this module has, so a column added to `lodging` cannot reach a client and
  // one lodging's detail page is described exactly as the board describes it.
  const items = scored.map((entry, index) =>
    toLodgingSummary(entry.row, entry.activityScore, index + 1),
  );
  return LodgingSummary.array().parse(items);
}

/**
 * One city's cached board, and the version stamp that gates a hit: `items` holds the board
 * {@link computeLeaderboard} returned, which is `LodgingSummary.array().parse` over every item it built, so a board
 * is validated before it is ever stored and this process is its only producer.
 */
interface LeaderboardCacheEntry {
  readonly v: number;
  readonly items: LodgingSummary[];
}

/**
 * True when `value` is a cache entry this process may serve: an object stamped with the current
 * {@link LEADERBOARD_CACHE_VERSION} whose `items` is an array. The items themselves are not re-validated — the
 * write path validated them and the stamp says the stored shape is the one this process reads — so an entry of
 * another version, a bare array, a non-object and anything else a stale or foreign writer left behind are refused
 * and the board is recomputed instead.
 */
function isLeaderboardCacheEntry(value: unknown): value is LeaderboardCacheEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const entry = value as { readonly v?: unknown; readonly items?: unknown };
  return entry.v === LEADERBOARD_CACHE_VERSION && Array.isArray(entry.items);
}

/**
 * A cached directory, or `null` when there is none to use. Never throws. `null` is the only answer that is not a
 * board, and each reason for it is logged under its own event: an unreadable Redis, an entry that is not JSON, and
 * an entry that is not a board of {@link LEADERBOARD_CACHE_VERSION} — a bare array written before the board was
 * stamped, a shape written by a version this process does not read. Every one of them makes the caller recompute and
 * rewrite the entry, so an entry that cannot be used heals on the next read within its TTL.
 *
 * The board is not re-validated here: {@link computeLeaderboard} validated it on the miss path and
 * {@link writeLeaderboardCache} stored exactly that value, so the version stamp is what gates a hit and the CPU a
 * read spends does not scale with the board's size.
 */
async function readLeaderboardCache(
  services: LodgingLeaderboardServices,
  cityId: string,
): Promise<LodgingSummary[] | null> {
  const key = leaderboardCacheKey(services.env.APP_ENV, cityId);
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
  if (!isLeaderboardCacheEntry(decoded)) {
    services.logger.warn(
      { event: 'leaderboard_cache_invalid', cityId },
      'leaderboard cache entry is not a board of this version; the board is recomputed',
    );
    return null;
  }
  return decoded.items;
}

/**
 * Caches the activity-ordered board for its TTL, stamped with {@link LEADERBOARD_CACHE_VERSION}; a failure is
 * ignored. `items` is the board {@link computeLeaderboard} has just validated against `LodgingSummary`, so this is
 * the one validation the cached board gets and the one place it is stored, and a hit is gated by the version stamp
 * alone rather than by a pass over the board.
 */
async function writeLeaderboardCache(
  services: LodgingLeaderboardServices,
  cityId: string,
  items: readonly LodgingSummary[],
): Promise<void> {
  const entry: LeaderboardCacheEntry = { v: LEADERBOARD_CACHE_VERSION, items: [...items] };
  try {
    await services.redis.client.set(
      leaderboardCacheKey(services.env.APP_ENV, cityId),
      JSON.stringify(entry),
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
 * The recomputation of each city's board that this process already has in flight, keyed by the city. Per process and
 * never shared: a second API replica keeps its own map, and both replicas still read and write the one cached board
 * in Redis.
 */
const boardsInFlight = new Map<string, Promise<LodgingSummary[]>>();

/**
 * Recomputes a city's board, and hands the callers that arrive while it runs the same board. A cold city, and
 * equally a city {@link invalidateLeaderboard} has just dropped after the commit that changed it, is the one moment
 * every concurrent reader of the directory has work to do, so the first caller computes and caches the board and
 * each caller that joins it is answered with that one board; the entry is removed as soon as the recomputation
 * settles, whether it produced a board or threw, so a failure is never cached and no settled board is held for the
 * life of the process.
 *
 * @throws Whatever the statements or `LodgingSummary` raised; every caller that joined receives the same rejection.
 */
async function coalesceLeaderboard(
  services: LodgingLeaderboardServices,
  cityId: string,
): Promise<LodgingSummary[]> {
  const running = boardsInFlight.get(cityId);
  if (running !== undefined) {
    return await running;
  }
  const started = recomputeLeaderboard(services, cityId);
  boardsInFlight.set(cityId, started);
  try {
    return await started;
  } finally {
    // Only this caller's own entry is dropped, so a later recomputation of the same city can never have its entry
    // removed by the one it replaced.
    if (boardsInFlight.get(cityId) === started) {
      boardsInFlight.delete(cityId);
    }
  }
}

/**
 * The one recomputation {@link coalesceLeaderboard} shares: the city's scored and ranked board, then its cache
 * entry. The order is the load-bearing part: the cache is written before the promise resolves, so a caller that
 * starts a recomputation right after this one settled reads the entry it wrote rather than computing a third board.
 */
async function recomputeLeaderboard(
  services: LodgingLeaderboardServices,
  cityId: string,
): Promise<LodgingSummary[]> {
  const computed = await computeLeaderboard(services, cityId, services.clock.now());
  await writeLeaderboardCache(services, cityId, computed);
  return computed;
}

/**
 * A city's lodgings in the order the caller asked for, each with its rank, activity score and current verified
 * guest count.
 *
 * The activity order is what is cached, because it carries the ranks: on `sort=activity` the rows come back exactly
 * as scored and ranked, and on `sort=name` the same rows are re-sorted alphabetically while keeping the rank each
 * holds on the board, so the console and the directory cannot show two different standings for one lodging. The
 * board is served from Redis for its TTL and recomputed otherwise; a Redis outage, an unreadable entry or a stale
 * cache is logged and never fails the read, because the directory is a read over PostgreSQL tables that stay
 * available. The answer is bounded at {@link LODGING_DIRECTORY_LIMIT} in the order {@link computeLeaderboard}
 * describes, which keeps the lodgings that witnessed a meetup, and the cut is logged through `lodgings_truncated`
 * rather than answered as if the directory were complete. A recomputation is coalesced per process, so the callers
 * arriving while a cold or just-invalidated city is computed share one board rather than each paying for one; that
 * board must be treated as read-only, which is why `sort=name` sorts a copy. The route has already checked that the
 * city exists and that the caller holds a proof for it, and a city with no lodging answers an empty list.
 *
 * @throws ZodError when a row cannot satisfy `LodgingSummary`, which is a defect rather than a client error.
 */
export async function leaderboard(
  services: LodgingLeaderboardServices,
  cityId: string,
  sort: LodgingSort,
): Promise<LodgingSummary[]> {
  const cached = await readLeaderboardCache(services, cityId);
  const board = cached ?? (await coalesceLeaderboard(services, cityId));
  return sort === 'name' ? [...board].sort(compareByName) : board;
}

/**
 * Drops a city's cached board. Callers run it only **after** the transaction that changed what the board counts
 * has committed — `lodgings/claims.ts` after deleting a verified claim, `admin/lodging-claims.ts` after resolving
 * one `verified` — so a rollback cannot leave a cold cache behind a change that never happened. A Redis failure is
 * logged and swallowed: the entry then simply lives out its TTL.
 */
export async function invalidateLeaderboard(
  services: LodgingLeaderboardServices,
  cityId: string,
): Promise<void> {
  try {
    await services.redis.client.del(leaderboardCacheKey(services.env.APP_ENV, cityId));
  } catch {
    services.logger.warn(
      { event: 'leaderboard_cache_unavailable', cityId },
      'leaderboard cache invalidation failed; the entry expires on its own',
    );
  }
}

/**
 * The whole calendar days between two city-local date keys, positive when `later` is the later date. Both keys are
 * the fixed-width `YYYY-MM-DD` spelling {@link localDateKey} produces, and each is read at its own UTC midnight, so
 * the difference is a whole number of days that no zone offset and no DST transition can enter. That is what makes
 * a trend point seven *local* days.
 */
function calendarDaysBetween(earlier: string, later: string): number {
  const from = Date.parse(`${earlier}T00:00:00.000Z`);
  const to = Date.parse(`${later}T00:00:00.000Z`);
  return Math.round((to - from) / DAY_MS);
}

/**
 * The weekly points of the 90-day trend, oldest first, summing to the lodging's score. A point covers seven
 * city-local calendar days and point 0 is the week just ended; its `weekStart` is today's local date stepped back a
 * whole number of weeks, and a fact joins it by its own local date's distance from today in calendar days, because a
 * millisecond window taken back from the current instant lands on the wrong local date after a DST change. The clamp
 * keeps a fact completing exactly on a boundary inside the trend rather than past its end, and every counted fact
 * lands in one of the 13 points, so the points always sum to the score.
 *
 * Exported so the unit rows can pin that bucketing at the boundary itself.
 */
export function trendFromCounted(counted: readonly Date[], tz: string, now: Date): TrendPoint[] {
  const today = localDateKey(tz, now);
  const buckets = new Array<number>(LODGING_TREND_WEEKS).fill(0);
  for (const instant of counted) {
    const days = calendarDaysBetween(localDateKey(tz, instant), today);
    const index = Math.min(Math.max(Math.floor(days / WEEK_DAYS), 0), LODGING_TREND_WEEKS - 1);
    buckets[index] = (buckets[index] ?? 0) + 1;
  }
  const trend: TrendPoint[] = [];
  for (let index = LODGING_TREND_WEEKS - 1; index >= 0; index -= 1) {
    trend.push({
      weekStart: addLocalDays(today, -(index + 1) * WEEK_DAYS),
      activityScore: buckets[index] ?? 0,
    });
  }
  return trend;
}

/**
 * One lodging's facts inside the window, at most {@link LODGING_ACTIVITY_FACTS_LIMIT} of them, newest first. The
 * read behind {@link lodgingSummary} and {@link lodgingStats}, applying the same bound in the same order that
 * {@link readWindowFacts} applies per lodging when the board scores a whole city, because the two must agree:
 * without the bound here a lodging past it would report the bound on the directory and its own larger number on its
 * console, and the score would depend on which reader asked.
 */
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
     ORDER BY "f"."completed_at" DESC
     LIMIT ${LODGING_ACTIVITY_FACTS_LIMIT}
  `);
  return toActivityFacts(rows);
}

/**
 * The standings the lodging console renders.
 *
 * `rank` is the lodging's position in its city's activity order and is 1 or greater even for a lodging scoring 0. A
 * lodging that has left the directory (`osmMissingAt` set) has no position at all: its own facts still score it and
 * it is placed after every listed lodging, so its console keeps reporting activity while the directory stays free
 * of a lodging OpenStreetMap no longer has.
 *
 * `activityScore` and `weeklyTrend` come from this lodging's own facts, read fresh, so the 13 points always sum to
 * the score; only `rank` can trail a change by up to the cache's life, and the guest count is
 * {@link guestCountFor}'s live read, so a removal is reflected at once. `rank` is read from the activity board
 * rather than counted by a statement of its own, so that this console and the directory answer with one number,
 * from the single implementation of the ranking rule; a second implementation in SQL could drift from it and place
 * the console out of step with the directory. A board cut at {@link LODGING_DIRECTORY_LIMIT} reports
 * `listed.length + 1` for a lodging the cut left out, the same position it gives a lodging that left the directory,
 * rather than a position no statement can count: the score is the pair chain {@link scoreFacts} walks, not a number
 * SQL can rank by.
 *
 * @throws Error when no such lodging exists, which the console route cannot produce and which must not be answered
 *   as a standing.
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

/**
 * One lodging's summary, built from that lodging's own row, facts and guests rather than from its city's board. The
 * directory answers a city's lodgings up to {@link LODGING_DIRECTORY_LIMIT}, cut in the order the ranking's own
 * inputs imply, so a city holding more lodgings than that has some the board does not carry; the detail route
 * answers the board's own entry whenever the board carries the lodging, and falls back to this function for one the
 * cut left out, whose row exists and which must therefore be answered with its own numbers rather than as `404
 * lodging_not_found`: a lodging that does not exist and a directory that was cut are different facts.
 *
 * Every field comes from a source the directory uses too — the summary fields from the row through
 * {@link toLodgingSummary}, the score from the lodging's own window facts through {@link readLodgingFacts} and
 * {@link scoreFacts}, and the guest count from {@link guestCountFor} — so a lodging both answers carry is
 * described identically. `rank` is `listedCount + 1`: the position {@link lodgingStats} already gives a lodging the
 * cut left out, and the only position reachable without a second implementation of the ranking rule. The row read
 * carries the two conditions the directory's own statement carries, `osm_missing_at IS NULL` and
 * {@link fixturePredicate}, so a lodging that has left OpenStreetMap or is a fixture this policy may not see is
 * answered as one that does not exist.
 *
 * @throws ZodError when the row cannot satisfy `LodgingSummary`, which is a defect rather than a client error.
 */
export async function lodgingSummary(
  services: LodgingLeaderboardServices,
  lodgingId: string,
  listedCount: number,
): Promise<LodgingSummary | null> {
  const now = services.clock.now();
  const rows = await services.db.$queryRaw<LodgingFields[]>(Prisma.sql`
    SELECT "l"."id"::text AS "id",
           "l"."city_id" AS "city_id",
           "l"."name" AS "name",
           "l"."kind" AS "kind",
           "l"."address" AS "address",
           "l"."phone" AS "phone"
      FROM "lodging" AS "l"
     WHERE "l"."id" = ${lodgingId}::uuid
       AND "l"."osm_missing_at" IS NULL
       AND ${fixturePredicate(services.env.APP_ENV, LODGING_ALIAS)}
  `);
  const fields = rows[0];
  if (fields === undefined) {
    return null;
  }
  const guests = await guestCountFor(services.db, [lodgingId], now, services.env.APP_ENV);
  const counted = scoreFacts(await readLodgingFacts(services.db, lodgingId, now), now).get(
    lodgingId,
  );
  return LodgingSummary.parse(
    toLodgingSummary(
      { ...fields, guests: guests.get(lodgingId) ?? 0 },
      counted?.score ?? 0,
      listedCount + 1,
    ),
  );
}

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
 * Records the activity facts of a completed meetup, inside the settlement's transaction. Called by
 * `settlement/settle.ts` for a `completed` outcome only — both attendees present — and for nothing else.
 *
 * The rule this function implements, which the workers apply as well when they verify a claim
 * (`apps/workers/src/jobs/lodging-claims.ts` reads the covering meetups with the one statement of `@tablemate/db`,
 * {@link coveringMeetupStatement}, because the workers cannot import the API):
 *
 * - meetup local date = `(meetup.starts_at AT TIME ZONE city.timezone)::date`, the city being the meetup venue's.
 * - A verified claim *covers* a meetup when `claim.status = 'verified' AND claim.stay_from <= local_date AND
 *   claim.stay_to >= local_date`.
 * - `pair_key = pairKey(ANALYTICS_SALT, initiatorId, recipientId)`, the order-independent HMAC.
 * - One fact per distinct (lodging, meetup): `createMany({ skipDuplicates: true })` spells the `ON CONFLICT` in
 *   Prisma terms, and it is what makes a second settlement run of the same meetup write nothing and report 0.
 *
 * A meetup therefore credits every lodging where either attendee held a verified claim covering that day — one
 * fact per lodging, however many of the two stayed there — and the fact carries the pair hash and the settlement
 * instant, never a user id.
 */
export async function recordLodgingActivity(
  tx: DbTx,
  services: LodgingLeaderboardServices,
  meetup: LodgingActivityMeetup,
  completedAt: Date = services.clock.now(),
): Promise<number> {
  const localDate = localDateKey(services.timezoneFor(meetup.cityId), meetup.startsAt);
  const participants = [meetup.initiatorId, meetup.recipientId];
  // A verified claim covering the meetup's local date, by either participant. Only the claim table is read, so no
  // fixture predicate is needed: a claim is user data, and a fixture lodging outside `test`/`demo` has no claim
  // pointing at it.
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
 * Backfills the activity facts of a claim that just became `verified`, inside the transaction that resolves it. A
 * stay that turns out to be genuine credits the lodging's board with the meetups the same traveler attended during
 * those dates, so the ranking reflects where travelers actually met rather than only which claims were verified
 * before the meeting happened.
 *
 * The statement that finds those meetups is stated once, in `@tablemate/db`: {@link coveringMeetupStatement} builds
 * it, and both this function and the workers' `backfillActivityFacts` run that one statement, which is what makes
 * the two paths' facts impossible to drift apart. Its rule: the meetup's local date is `(meetup.starts_at AT TIME
 * ZONE city.timezone)::date` for the city of the meetup's venue, and a verified claim *covers* a meetup when
 * `claim.status = 'verified' AND claim.stay_from <= local_date AND claim.stay_to >= local_date`. What this function
 * adds is the rest of the rule: `pair_key = pairKey(ANALYTICS_SALT, initiatorId, recipientId)`, and one fact per
 * distinct (lodging, meetup) — `createMany({ skipDuplicates: true })` — which is what makes a second
 * resolution of the same claim write nothing.
 *
 * Only meetups settled inside the activity window are read, because an older one could not count, and each fact
 * carries the meetup's own `settledAt` as its completion time, so backfilling never moves a historical score to
 * today.
 */
export async function recordActivityForVerifiedClaim(
  tx: DbTx,
  services: LodgingLeaderboardServices,
  claim: VerifiedClaimCoverage,
): Promise<number> {
  const now = services.clock.now();
  const stayFrom = toDateOnly(claim.stayFrom);
  const stayTo = toDateOnly(claim.stayTo);
  const rows = await tx.$queryRaw<CoveringMeetupRow[]>(
    coveringMeetupStatement(
      services.env.APP_ENV,
      { userId: claim.userId, stayFrom, stayTo },
      new Date(now.getTime() - WINDOW_MS),
    ),
  );
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

interface LodgingRow {
  readonly id: string;
  readonly city_id: string;
  readonly name: string;
  readonly kind: LodgingKind;
  readonly address: string | null;
  readonly phone: string | null;
  readonly guests: number;
}

/**
 * The same row without its guest count: what {@link lodgingSummary}'s own read of one lodging selects, because that
 * read takes the count from `guestCountFor` instead of computing it in its own statement.
 */
type LodgingFields = Omit<LodgingRow, 'guests'>;

interface FactRow {
  readonly lodging_id: string;
  readonly pair_key: string;
  readonly completed_at: Date;
}

/**
 * One row of the capped window-facts statement: a fact with its lodging's own newest-first position
 * ({@link LODGING_ACTIVITY_FACTS_LIMIT}).
 */
interface BoundedFactRow extends FactRow {
  readonly seq: number;
}

interface LodgingIdRow {
  readonly lodging_id: string;
}

interface GuestCountRow {
  readonly lodging_id: string;
  readonly guests: number;
}
