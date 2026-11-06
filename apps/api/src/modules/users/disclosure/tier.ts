/**
 * Disclosure layer 1 of 3: the tier a viewer has earned toward a target (AAP 0.5.1, 0.5.7).
 *
 * Progressive disclosure releases profile fields per viewer-and-target pair across tiers 0-3, and
 * `computeTier(viewerId, targetId)` is the one decision the other two layers obey: `select.ts` loads
 * only the columns behind that tier's fields and `serialize.ts` copies that tier's keys through its
 * schema, so a field above the viewer's tier is never loaded, let alone returned (AAP 0.5.4, 0.12.2,
 * criterion 5). Three layers rather than one, because a route cannot leak what it never selected.
 *
 * The rule in the order it applies (AAP 0.5.7):
 *
 *   1. a block in either direction -> `'blocked'`, which is the minimum disclosure and not a tier:
 *      `GET /users/:userId` answers `404 user_not_found` (AAP 0.5.4);
 *   2. `completedCount >= 2` -> 3;
 *   3. `completedCount >= 1` -> 2;
 *   4. a shared meetup in status `locked` whose deposits are both `held` -> 1;
 *   5. otherwise 0.
 *
 * Two invariants settle the edge cases. `PairHistory.completedCount` counts every completed meetup,
 * whatever the deposit and however closely the two are spaced, because the anti-farming rule limits
 * the reputation counters and the leaderboard only and does not apply to disclosure: a pair reaches
 * tier 3 after two meetups, and `reputation/anti-farming.ts` is deliberately not consulted here (AAP
 * 0.5.7, 0.7.3). And a meetup with an open dispute stays `locked`, so its pair keeps tier 1 while the
 * dispute stands (AAP 0.5.3).
 *
 * Everything here reads: no transaction is opened, no lock is taken and nothing is written, and the
 * pair facts take `RawSqlClient` rather than the whole client so a caller already inside a
 * transaction (a route about to update a meetup, say) can pass its `tx` (AAP 0.3.2). No clock is read
 * (AAP 0.11.1), and nothing is logged: the ids here are not profile content to spill.
 *
 * @see AAP 0.5.4 for the tier fields, the photo gate and the messaging gate this feeds, 0.5.2 for the
 *   tables read here, 0.12.2 for the constraint that no response carries a field above the viewer's
 *   tier, and 0.8.1 for this file.
 */

import { Prisma, type RawSqlClient } from '@tablemate/db';
import type { TierResult } from '@tablemate/shared';

import { pairOrder } from '../../reputation/pair-history.ts';

/**
 * The four facts about a viewer-and-target pair that decide its tier (AAP 0.5.7).
 *
 * A snapshot of one {@link pairFacts} call: nothing is cached, because a block, a completion or a
 * lock changes the answer at once and a stale tier is a disclosure decision taken on old facts.
 */
export type PairFacts = {
  /** A block row in either direction between the two users (AAP 0.5.4). */
  blocked: boolean;
  /** Meetups the pair completed with both present, from `pair_history` (AAP 0.5.2, 0.5.7). */
  completedCount: number;
  /** A meetup of the pair in status `locked` whose two deposits are both `held` (AAP 0.5.7). */
  sharedLockedBothHeld: boolean;
  /** A meetup of the pair in `locked` or `completed`: the messaging gate (AAP 0.5.4). */
  messageable: boolean;
};

/** The single row {@link pairFacts} selects; column names are PostgreSQL's, so they stay snake_case. */
interface PairFactsRow {
  blocked: boolean;
  completed_count: number | bigint;
  shared_locked_both_held: boolean;
  messageable: boolean;
}

/**
 * Maps a pair's facts onto its disclosure tier (AAP 0.5.7).
 *
 * Pure and total, so the whole rule lives in one readable place and every caller agrees on the
 * order. A block outranks a long history: two completed meetups plus a block still answer `'blocked'`,
 * and a locked meetup plus a block answers `'blocked'` rather than 1, because meeting a blocked
 * person is unsafe and the pair's own history is no reason to keep disclosing (AAP 0.5.3, 0.5.4).
 *
 * @param facts - The pair's facts, from {@link pairFacts} or a caller's own read of the same tables.
 * @returns The tier, or `'blocked'` for a block in either direction.
 */
export function tierFrom(facts: PairFacts): TierResult {
  if (facts.blocked) {
    return 'blocked';
  }

  if (facts.completedCount >= 2) {
    return 3;
  }

  if (facts.completedCount >= 1) {
    return 2;
  }

  return facts.sharedLockedBothHeld ? 1 : 0;
}

/**
 * True when two ids name the same user, tolerating case.
 *
 * Every key in these tables is a lowercase canonical uuid and {@link pairOrder} compares lowercased
 * ids, while a user id can reach a route as caller-supplied path text in any case. Normalizing both
 * sides keeps "a user sees all of their own fields" true for `.../users/<OWN-ID-IN-CAPS>` instead of
 * letting it fall through to a pair query that refuses one user against themselves.
 */
function sameUser(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Reads the four facts about a viewer-and-target pair in one round trip (AAP 0.5.7).
 *
 * A single `SELECT` with no `FROM` — four scalar sub-expressions, which PostgreSQL evaluates once —
 * so it is one parameterized statement and always returns exactly one row. Only ids are parameters:
 * the status words are written into the SQL text because `meetup.status` and `deposit.status` are the
 * `meetup_status` and `deposit_status` enum types, and a bound `text` parameter compared against an
 * enum column has no operator while an untyped literal coerces to it. Those literals come from the
 * shared `MeetupStatus` and `DepositStatus` values and never vary.
 *
 * The pair's meetups are matched with an explicit `OR` over `initiator_id` and `recipient_id`, not
 * `LEAST`/`GREATEST`, so the ordinary indexes on those two columns serve the lookup. Read-only: it
 * opens no transaction and takes no lock, so it is safe inside a caller's transaction.
 *
 * @param db - The guarded client, or the transaction's client when the caller is already in one.
 * @param viewerId - The id of the user doing the looking.
 * @param targetId - The id of the user being looked at.
 * @returns The pair's facts, each read fresh.
 * @throws Error when the two ids are the same ({@link pairOrder} refuses a self pair) or when the
 *   statement returns no row, which its `FROM`-less shape makes impossible: a tier is never invented
 *   for a pair we could not measure, so the request fails instead of disclosing on a guess.
 */
export async function pairFacts(
  db: RawSqlClient,
  viewerId: string,
  targetId: string,
): Promise<PairFacts> {
  const { low, high } = pairOrder(viewerId, targetId);

  const rows = await db.$queryRaw<PairFactsRow[]>(Prisma.sql`
    SELECT
      EXISTS (
        SELECT 1 FROM "block"
        WHERE ("blocker_id" = ${viewerId}::uuid AND "blocked_id" = ${targetId}::uuid)
           OR ("blocker_id" = ${targetId}::uuid AND "blocked_id" = ${viewerId}::uuid)
      ) AS "blocked",
      COALESCE((
        SELECT "completed_count" FROM "pair_history"
        WHERE "user_low_id" = ${low}::uuid AND "user_high_id" = ${high}::uuid
      ), 0) AS "completed_count",
      EXISTS (
        SELECT 1 FROM "meetup" m
        WHERE ((m."initiator_id" = ${viewerId}::uuid AND m."recipient_id" = ${targetId}::uuid)
            OR (m."initiator_id" = ${targetId}::uuid AND m."recipient_id" = ${viewerId}::uuid))
          AND m."status" = 'locked'
          AND (
            SELECT count(*) FROM "deposit" d
            WHERE d."meetup_id" = m."id" AND d."status" = 'held'
          ) = 2
      ) AS "shared_locked_both_held",
      EXISTS (
        SELECT 1 FROM "meetup" m
        WHERE ((m."initiator_id" = ${viewerId}::uuid AND m."recipient_id" = ${targetId}::uuid)
            OR (m."initiator_id" = ${targetId}::uuid AND m."recipient_id" = ${viewerId}::uuid))
          AND m."status" IN ('locked', 'completed')
      ) AS "messageable"
  `);

  const row = rows[0];
  if (row === undefined) {
    throw new Error('disclosure pair facts returned no row');
  }

  return {
    blocked: row.blocked,
    // `COALESCE` over an `integer` column arrives as a number, but a bigint-typed driver result is
    // converted rather than trusted, so a count above int range cannot become a wrong comparison.
    completedCount: Number(row.completed_count),
    sharedLockedBothHeld: row.shared_locked_both_held,
    messageable: row.messageable,
  };
}

/**
 * Decides the disclosure tier of a viewer toward a target (AAP 0.5.1, 0.5.4, 0.5.7).
 *
 * A user's own row is never gated: self-view answers 3 without a query, because all four tiers'
 * fields are the user's own. Every other pair is measured by {@link pairFacts} and mapped by
 * {@link tierFrom}.
 *
 * @param db - The guarded client, or the transaction's client when the caller is already in one.
 * @param viewerId - The id of the user doing the looking.
 * @param targetId - The id of the user being looked at; `GET /users/:userId/photo` uses the result
 *   against `PHOTO_MIN_TIER` as well.
 * @returns The tier, or `'blocked'` for a block in either direction.
 */
export async function computeTier(
  db: RawSqlClient,
  viewerId: string,
  targetId: string,
): Promise<TierResult> {
  return sameUser(viewerId, targetId) ? 3 : tierFrom(await pairFacts(db, viewerId, targetId));
}

/**
 * Whether the viewer may message the target: the `canMessage` field of a tier 1 profile (AAP 0.5.4).
 *
 * The messaging gate is a property of the pair, not of the target: history and a block, never a tier.
 * A block closes it in either direction, and it stays closed for a user against themselves.
 *
 * @param facts - The pair's facts, as {@link pairFacts} returned them.
 * @param viewerId - The id of the user doing the looking.
 * @param targetId - The id of the user being looked at.
 * @returns True only for an unblocked pair with a locked or completed meetup.
 */
export function canMessageFrom(facts: PairFacts, viewerId: string, targetId: string): boolean {
  return !facts.blocked && facts.messageable && !sameUser(viewerId, targetId);
}
