/**
 * Witnessed-presence counters: the `reputation` block of every profile (AAP 0.5.7, 0.5.2).
 *
 * Two batch reads produce the whole `Reputation` shape. The witness read aggregates
 * `witness_event` over the rows settlement flagged `counts_for_reputation`, for the
 * witnessed-meetup count and for the distinct counterparts, venues and cities taken over those same
 * rows. The no-show read counts `meetup` joined to `meetup_settlement`: a forfeited meetup of the last 90 days
 * whose presence flag is false for the user, which covers the absent party of a `no_show` and the
 * canceller of a `late_cancel` alike, because `settlement/outcomes.ts` records the canceller absent.
 * No counter is stored per user: a reversal to `no_fault` or a hold-loss compensation to `lock_lost`
 * moves the meetup out of `forfeited`, and the no-show leaves the count by itself (AAP 0.5.3).
 *
 * Counters never decay and a block never changes them, so neither read consults `block`. Both are
 * keyed by id and join nothing about the counterpart, so a tombstoned counterpart still counts and a
 * user's counters are identical before and after the counterpart's account is erased (AAP 0.5.2,
 * criterion 10). The witness read joins no meetup either: the 7-year financial purge nulls
 * `witness_event.meetup_id`, and every number it reports comes from the event row itself, so the
 * purge leaves a live user's counters unchanged.
 *
 * Read-only: nothing here writes and no transaction is opened, and time arrives as the `now`
 * argument — `services.clock` in the API — never from the process. Ratings, comments and reviews are
 * out of scope, so witnessed presence is the only reputation input (AAP 0.7.2).
 *
 * @see AAP 0.5.7 for the counter definitions, 0.5.3 for the transitions the no-show read derives
 *   from, 0.5.2 for retention, 0.8.1 for this file.
 */

import { Prisma, type DbClient, type DbTx } from '@tablemate/db';
import { DAY_MS, NO_SHOW_WINDOW_DAYS } from '@tablemate/shared';
import type { Reputation } from '@tablemate/shared';

/** The no-show window in milliseconds (AAP 0.5.7), measured on `meetup.starts_at`. */
const NO_SHOW_WINDOW_MS = NO_SHOW_WINDOW_DAYS * DAY_MS;

/** One aggregated `witness_event` group; every field comes from the event row itself (AAP 0.5.2). */
interface WitnessRow {
  readonly user_id: string;
  readonly witnessed: number;
  readonly counterparts: number;
  readonly venues: number;
  readonly cities: number;
}

/** One aggregated `meetup`/`meetup_settlement` group: how often `user_id` was the absent party. */
interface NoShowRow {
  readonly user_id: string;
  readonly no_shows: number;
}

/** The counters of a user with no witnessed meetup and no no-show: what every id starts from. */
function zeroCounters(): Reputation {
  return {
    witnessedMeetups: 0,
    distinctCounterparts: 0,
    distinctVenues: 0,
    distinctCities: 0,
    noShows90d: 0,
  };
}

/**
 * The reputation counters of several users at once, as a map keyed by user id (AAP 0.5.7).
 *
 * One page of discovery asks for its 20 profiles in a single call, which keeps the read at two
 * statements whatever the page holds (AAP 0.12.2). Ids are deduplicated, an empty list returns an
 * empty map without touching the database, and every requested id is present in the result — at zero
 * when it has no history — so a caller can always read its entry.
 *
 * Works on the guarded client and inside a transaction alike, and opens none of its own. Both
 * statements are parameterized and index-backed: `witness_event` carries `(user_id, completed_at)`
 * and `meetup` carries `(status, starts_at)`, the column each read leads with.
 *
 * @param db - The guarded client or a transaction's client.
 * @param userIds - The users whose counters are wanted; duplicates are collapsed.
 * @param now - The instant the 90-day no-show window is measured back from; from `services.clock`.
 * @returns A map from user id to that user's counters, holding every requested id.
 * @see AAP 0.5.7 for the definitions, 0.5.2 for what survives erasure and the purge.
 */
export async function countersForMany(
  db: DbClient | DbTx,
  userIds: readonly string[],
  now: Date,
): Promise<Map<string, Reputation>> {
  const counters = new Map<string, Reputation>();
  const wanted = [...new Set(userIds)];

  if (wanted.length === 0) {
    return counters;
  }

  for (const userId of wanted) {
    counters.set(userId, zeroCounters());
  }

  const since = new Date(now.getTime() - NO_SHOW_WINDOW_MS);

  // One group per user, taken from the event row alone: no join to `meetup`, `user` or `block`, so
  // the financial purge and a deleted counterpart leave this read unchanged.
  const witnessRows = await db.$queryRaw<WitnessRow[]>(Prisma.sql`
    SELECT "user_id"::text AS "user_id",
           count(*)::int AS "witnessed",
           count(DISTINCT "counterpart_id")::int AS "counterparts",
           count(DISTINCT "venue_id")::int AS "venues",
           count(DISTINCT "city_id")::int AS "cities"
      FROM "witness_event"
     WHERE "counts_for_reputation"
       AND "user_id" = ANY(${wanted}::uuid[])
     GROUP BY "user_id"
  `);

  // The no-show counters: the forfeited meetups of the window in which the user's own presence flag
  // is false, which the lateral values list turns into one row per participant.
  const noShowRows = await db.$queryRaw<NoShowRow[]>(Prisma.sql`
    SELECT "p"."user_id"::text AS "user_id",
           count(*)::int AS "no_shows"
      FROM "meetup" AS "m"
      JOIN "meetup_settlement" AS "s" ON "s"."meetup_id" = "m"."id"
     CROSS JOIN LATERAL (
           VALUES ("m"."initiator_id", "s"."initiator_present"),
                  ("m"."recipient_id", "s"."recipient_present")
         ) AS "p"("user_id", "present")
     WHERE "m"."status" = 'forfeited'
       AND "m"."starts_at" >= ${since}
       AND NOT "p"."present"
       AND "p"."user_id" = ANY(${wanted}::uuid[])
     GROUP BY "p"."user_id"
  `);

  for (const row of witnessRows) {
    const reputation = counters.get(row.user_id);
    if (reputation !== undefined) {
      reputation.witnessedMeetups = row.witnessed;
      reputation.distinctCounterparts = row.counterparts;
      reputation.distinctVenues = row.venues;
      reputation.distinctCities = row.cities;
    }
  }

  for (const row of noShowRows) {
    const reputation = counters.get(row.user_id);
    if (reputation !== undefined) {
      reputation.noShows90d = row.no_shows;
    }
  }

  return counters;
}

/**
 * The reputation counters of one user (AAP 0.5.1, 0.5.7): the two reads of {@link countersForMany},
 * narrowed to a single id.
 *
 * Used wherever one profile is built — `GET /me`, `GET /users/:userId` and the proposal detail's
 * counterpart — so the counters a traveler sees on their own profile are the ones every viewer
 * computes for them. A user with no history and an id with no rows both answer zeros.
 *
 * @param db - The guarded client or a transaction's client.
 * @param userId - The user whose counters are wanted.
 * @param now - The instant the 90-day no-show window is measured back from; from `services.clock`.
 * @returns The user's counters, never `undefined`.
 * @see AAP 0.5.7 and 0.5.2.
 */
export async function countersFor(
  db: DbClient | DbTx,
  userId: string,
  now: Date,
): Promise<Reputation> {
  const counters = await countersForMany(db, [userId], now);
  return counters.get(userId) ?? zeroCounters();
}
