/**
 * Disclosure layer 1 of 3: the tier a viewer has earned toward a target.
 *
 * `computeTier(viewerId, targetId)` is the one decision the other two layers obey: `select.ts` loads only the columns behind that
 * tier's fields and `serialize.ts` copies that tier's keys through its schema, so a field above the viewer's tier is never loaded, let
 * alone returned.
 *
 * The rule in the order it applies: a block in either direction is `'blocked'`, which is the minimum disclosure and not a tier; then
 * `completedCount >= 2` is 3, `>= 1` is 2, a shared meetup in status `locked` whose deposits are both `held` is 1, and otherwise 0.
 * `PairHistory.completedCount` counts every completed meetup, whatever the deposit and however closely the two are spaced, because the
 * anti-farming rule limits the reputation counters and the leaderboard only.
 *
 * Everything here reads: no transaction, no lock, no clock, and nothing is logged.
 */
import { Prisma, type RawSqlClient } from '@tablemate/db';
import type { TierResult } from '@tablemate/shared';

import { pairOrder } from '../../reputation/pair-history.ts';

/** The four facts about a viewer-and-target pair that decide its tier: a snapshot of one {@link pairFacts} call, never cached, because
 * a stale tier is a disclosure decision taken on old facts. */
export type PairFacts = {
  /** A block row in either direction between the two users (AAP 0.5.4). */
  blocked: boolean;
  completedCount: number;
  /** A meetup of the pair in status `locked` whose two deposits are both `held` (AAP 0.5.7). */
  sharedLockedBothHeld: boolean;
  /** A meetup of the pair in `locked` or `completed`: the messaging gate (AAP 0.5.4). */
  messageable: boolean;
};

interface PairFactsRow {
  blocked: boolean;
  completed_count: number | bigint;
  shared_locked_both_held: boolean;
  messageable: boolean;
}

/** One row of {@link pairFactsFor}'s page statement: the four facts, plus the id they belong to. */
interface PagePairFactsRow extends PairFactsRow {
  target_id: string;
}

/**
 * Maps a pair's facts onto its disclosure tier: pure and total, so the whole rule lives in one place. A block outranks a long history —
 * two completed meetups plus a block still answer `'blocked'` — because meeting a blocked person is unsafe.
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
 * True when two ids name the same user, tolerating case: every key in these tables is a lowercase canonical uuid while a user id can
 * reach a route as caller-supplied path text in any case, and normalizing both sides keeps "a user sees all of their own fields" true
 * for a capitalized own id.
 */
function sameUser(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Reads the four facts about a viewer-and-target pair in one round trip: a single `SELECT` with no `FROM` — four scalar sub-expressions
 * PostgreSQL evaluates once — so it is one parameterized statement returning exactly one row. Only ids are parameters: the status words
 * are written into the SQL text because a bound `text` parameter compared against an enum column has no operator, and they come from the
 * shared status values. Read-only, so it is safe inside a caller's transaction, and the meetups are matched with an explicit `OR` over
 * `initiator_id` and `recipient_id` so the ordinary indexes on those columns serve the lookup.
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
    // A bigint-typed driver result is converted rather than trusted, so a count above int range cannot
    // become a wrong comparison.
    completedCount: Number(row.completed_count),
    sharedLockedBothHeld: row.shared_locked_both_held,
    messageable: row.messageable,
  };
}

/**
 * Reads the four facts of a whole page of viewer-and-target pairs in one round trip: the same `EXISTS` block subquery, `pair_history`
 * count and two meetup tests as {@link pairFacts}, so a page costs one statement instead of one per row.
 *
 * The `pair_history` key is rebuilt with `LEAST`/`GREATEST` because one statement cannot call {@link pairOrder}, and stored ids are
 * lowercase canonical uuids, which `LEAST` orders the same way. A self id must not be passed: a user against themselves has no row in
 * either table, so their facts would come back as "no block, no history" and `tierFrom` would answer 0 where their own view is 3.
 */
export async function pairFactsFor(
  db: RawSqlClient,
  viewerId: string,
  targetIds: readonly string[],
): Promise<Map<string, PairFacts>> {
  const facts = new Map<string, PairFacts>();
  const wanted = [...new Set(targetIds.map((id) => id.toLowerCase()))];
  if (wanted.length === 0) {
    return facts;
  }
  const rows = await db.$queryRaw<PagePairFactsRow[]>(Prisma.sql`
    SELECT t."target_id"::text AS "target_id",
      EXISTS (
        SELECT 1 FROM "block"
        WHERE ("blocker_id" = ${viewerId}::uuid AND "blocked_id" = t."target_id")
           OR ("blocker_id" = t."target_id" AND "blocked_id" = ${viewerId}::uuid)
      ) AS "blocked",
      COALESCE((
        SELECT "completed_count" FROM "pair_history"
        WHERE "user_low_id" = LEAST(${viewerId}::uuid, t."target_id")
          AND "user_high_id" = GREATEST(${viewerId}::uuid, t."target_id")
      ), 0) AS "completed_count",
      EXISTS (
        SELECT 1 FROM "meetup" m
        WHERE ((m."initiator_id" = ${viewerId}::uuid AND m."recipient_id" = t."target_id")
            OR (m."initiator_id" = t."target_id" AND m."recipient_id" = ${viewerId}::uuid))
          AND m."status" = 'locked'
          AND (
            SELECT count(*) FROM "deposit" d
            WHERE d."meetup_id" = m."id" AND d."status" = 'held'
          ) = 2
      ) AS "shared_locked_both_held",
      EXISTS (
        SELECT 1 FROM "meetup" m
        WHERE ((m."initiator_id" = ${viewerId}::uuid AND m."recipient_id" = t."target_id")
            OR (m."initiator_id" = t."target_id" AND m."recipient_id" = ${viewerId}::uuid))
          AND m."status" IN ('locked', 'completed')
      ) AS "messageable"
      FROM unnest(${wanted}::uuid[]) AS t("target_id")
  `);
  for (const row of rows) {
    facts.set(row.target_id, {
      blocked: row.blocked,
      // As in {@link pairFacts}: a bigint-typed driver result is converted rather than trusted.
      completedCount: Number(row.completed_count),
      sharedLockedBothHeld: row.shared_locked_both_held,
      messageable: row.messageable,
    });
  }
  if (facts.size !== wanted.length) {
    throw new Error('disclosure pair facts returned no entry for a requested id');
  }
  return facts;
}

/**
 * Decides the disclosure tier of a viewer toward a target: a user's own row is never gated and answers 3 without a query, because all
 * four tiers' fields are the user's own; every other pair is measured by {@link pairFacts} and mapped by {@link tierFrom}.
 */
export async function computeTier(
  db: RawSqlClient,
  viewerId: string,
  targetId: string,
): Promise<TierResult> {
  return sameUser(viewerId, targetId) ? 3 : tierFrom(await pairFacts(db, viewerId, targetId));
}

/** Whether the viewer may message the target: the gate is a property of the pair, not of the target — a block closes it in either
 * direction, and it stays closed for a user against themselves. */
export function canMessageFrom(facts: PairFacts, viewerId: string, targetId: string): boolean {
  return !facts.blocked && facts.messageable && !sameUser(viewerId, targetId);
}
