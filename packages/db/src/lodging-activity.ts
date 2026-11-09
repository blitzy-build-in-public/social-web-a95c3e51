/**
 * The covering-meetup statement (AAP 0.8.1): the one statement that decides whether a verified lodging claim
 * credits a completed meetup to a lodging's leaderboard.
 *
 * It is stated here, in `@tablemate/db`, because two processes run it and neither may import the other: the API's
 * `recordActivityForVerifiedClaim` (`apps/api/src/modules/lodgings/leaderboard.ts`, called by
 * `admin/lodging-claims.ts`) and the workers' `backfillActivityFacts`
 * (`apps/workers/src/jobs/lodging-claims.ts`) — and `workers` must not import `@tablemate/api`. One statement both
 * processes run is what makes drift impossible; two copies, held identical by nothing but documentation, would
 * give one claim two different `activityScore` values depending on which process verified it.
 *
 * The rule {@link coveringMeetupStatement} implements:
 *
 * - The meetup's local date is `(meetup.starts_at AT TIME ZONE city.timezone)::date`, the city being the city of
 *   the meetup's venue.
 * - A verified claim *covers* a meetup when `claim.status = 'verified' AND claim.stay_from <= local_date AND
 *   claim.stay_to >= local_date`; both ends of that window are the caller's calendar dates.
 * - Only meetups inside the activity window are read: `settled_at` is not null and lies after the window start
 *   the caller passes in, which is the leaderboard's 90 days.
 * - A fixture venue's meetups are invisible outside `test` and `demo`: the statement carries
 *   {@link fixturePredicate} for its own `venue` alias, which a `$queryRaw` read needs because it bypasses the
 *   guarded client's fixture filter.
 * - Its answer is a row per covered meetup: the meetup's id, its two participants and its `settled_at`.
 *
 * Every value is a bound parameter, and every identifier reaching the text comes from the module's own alias
 * constants through {@link alias}, so no caller can influence the statement beyond the values it passes.
 */

import type { AppEnv } from '@tablemate/shared';

import { Prisma } from './client.ts';
import { fixturePredicate, SQL_IDENTIFIER } from './fixtures-guard.ts';
/** The alias the statement gives `meetup`. */
const MEETUP_ALIAS = 'm';
/** The alias the statement gives `venue`, and the one {@link fixturePredicate} is given. */
const VENUE_ALIAS = 'v';
/** The alias the statement gives `city`. */
const CITY_ALIAS = 'ci';
/** One alias as the statement's text carries it, checked against {@link SQL_IDENTIFIER} first: a table alias is the only text that reaches this statement unparameterized. @param name - The bare alias, taken from the constants above. @returns The alias with its double quotes. @throws RangeError when `name` is not a plain lower-case SQL identifier. */
function alias(name: string): Prisma.Sql {
  if (!SQL_IDENTIFIER.test(name)) {
    throw new RangeError(`Unsafe SQL identifier: ${name}`);
  }
  return Prisma.raw(`"${name}"`);
}
/** What {@link coveringMeetupStatement} needs about the claim that just became `verified`. */
export interface ClaimCoverage {
  /** The claimant. Only meetups this traveler attended can be covered by their stay, so the statement matches it against either participant. */
  readonly userId: string;
  /** First day of the stay, as `YYYY-MM-DD`; the caller reduces its `@db.Date` value to that. */
  readonly stayFrom: string;
  /** Last day of the stay, in the same spelling. */
  readonly stayTo: string;
}
/** One row of {@link coveringMeetupStatement}: a completed meetup the claim's stay covers. */
export interface CoveringMeetupRow {
  /** The meetup's id, which the fact records against its lodging. */
  readonly id: string;
  /** The meetup's initiator. With {@link CoveringMeetupRow.recipient_id} it keys the pair hash, and it is the only trace of a participant the caller keeps: the fact itself carries no user id. */
  readonly initiator_id: string;
  /** The meetup's recipient. */
  readonly recipient_id: string;
  /** When the meetup settled: the instant each fact records as its `completedAt`. */
  readonly settled_at: Date;
}
/**
 * The `Prisma.Sql` of the covering-meetup select: a `$queryRaw` read of every completed meetup the claim's stay
 * covers, inside the activity window.
 *
 * The caller runs it and keeps everything that follows: the participants' dates are the ones it passes in, the
 * pair hash comes from the row it gets back, and the facts are inserted through
 * `createMany({ skipDuplicates: true })`, which is what makes a second resolution of the same claim write
 * nothing. Running the statement itself changes nothing.
 *
 * @param appEnv - The process's `APP_ENV`, which decides whether a fixture venue's meetups are visible.
 * @param claim - The verified claim: its claimant and both ends of its stay.
 * @param windowStart - The instant the activity window opens; a meetup settled at or before it is outside the
 *   window and is not returned. The caller computes it from its injected clock.
 * @returns The statement, to be run as `tx.$queryRaw<CoveringMeetupRow[]>(...)` in the caller's transaction, so
 *   the facts commit with the resolution that earned them.
 */
export function coveringMeetupStatement(
  appEnv: AppEnv,
  claim: ClaimCoverage,
  windowStart: Date,
): Prisma.Sql {
  const m = alias(MEETUP_ALIAS);
  const v = alias(VENUE_ALIAS);
  const ci = alias(CITY_ALIAS);

  return Prisma.sql`
    SELECT ${m}."id"::text AS "id",
           ${m}."initiator_id"::text AS "initiator_id",
           ${m}."recipient_id"::text AS "recipient_id",
           ${m}."settled_at" AS "settled_at"
      FROM "meetup" AS ${m}
      JOIN "venue" AS ${v} ON ${v}."id" = ${m}."venue_id"
      JOIN "city" AS ${ci} ON ${ci}."id" = ${v}."city_id"
     WHERE ${m}."status" = 'completed'
       AND ${m}."settled_at" IS NOT NULL
       AND ${m}."settled_at" > ${windowStart}
       AND (${m}."initiator_id" = ${claim.userId}::uuid
            OR ${m}."recipient_id" = ${claim.userId}::uuid)
       AND ((${m}."starts_at" AT TIME ZONE ${ci}."timezone")::date
              BETWEEN CAST(${claim.stayFrom} AS date) AND CAST(${claim.stayTo} AS date))
       AND ${fixturePredicate(appEnv, VENUE_ALIAS)}
  `;
}
