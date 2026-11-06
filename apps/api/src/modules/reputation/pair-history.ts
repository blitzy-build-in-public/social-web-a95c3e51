/**
 * The pair's completed-meetup history: the row's identity, its increment and its read
 * (AAP 0.5.2, 0.5.7).
 *
 * `PairHistory` counts the meetups a pair witnessed together, and it is the whole input to the two
 * highest disclosure tiers: `completedCount >= 2` is tier 3, `>= 1` is tier 2 (AAP 0.5.7). The
 * anti-farming rule does not apply to it — that rule restricts the reputation counters of
 * `reputation/counters.ts` — so a pair reaches tier 3 after two meetups however closely spaced
 * (AAP 0.5.7, 0.7.3). The row is pseudonymous and outlives the accounts: `workers` `data-expiry`
 * deletes it only at the financial purge and only for a tombstone member, so an erasure leaves the
 * counterpart's tier and counters unchanged (AAP 0.5.2).
 *
 * `settlement/settle.ts` is the only caller of {@link recordCompletion}, and it calls it inside the
 * settlement transaction and only for a `completed` outcome, which is why that function takes a
 * transaction and never opens one (AAP 0.3.2, 0.5.7). `users/disclosure/tier.ts` and
 * `cities/discovery.ts` read {@link pairHistory} and reuse {@link pairOrder} instead of deriving the
 * pair's order themselves. No clock is read here: `completedAt` arrives from `services.clock`
 * through settlement, and no id is generated (AAP 0.11.1).
 */

import { Prisma, type DbClient, type DbTx } from '@tablemate/db';

/** A pair's completion count, what both functions here return. */
export interface PairCompletion {
  /** Meetups of this pair completed with both participants witnessed present (AAP 0.5.7). */
  readonly completedCount: number;
}

/**
 * The two ids that identify a pair, in the order the caller holds them.
 *
 * Structural, so `settle.ts` passes its meetup row as it stands (AAP 0.5.1).
 */
export interface PairParticipants {
  /** The meetup's initiator. */
  readonly initiatorId: string;
  /** The meetup's recipient. */
  readonly recipientId: string;
}

/**
 * The pair's two ids in canonical order: lowercased, lower id first.
 *
 * The invariant: for canonical lowercase hex UUIDs, JavaScript string order equals PostgreSQL's
 * bytewise `uuid` order, which is what the `pair_history` primary key and the `LEAST`/`GREATEST` of
 * the init migration's `meetup_open_pair_key` index use. One pair therefore has one key whichever
 * side the caller names first, and callers must reuse this function rather than compare ids
 * themselves (AAP 0.5.2, 0.5.7).
 *
 * @param a - One participant's user id.
 * @param b - The other participant's user id.
 * @returns Both ids lowercased, lower first.
 * @throws Error when the ids are equal after lowercasing: a user never pairs with themselves
 *   (`422 self_proposal` stops that upstream), so this is our own invariant violation, not a
 *   caller's mistake, and a plain `Error` is raised rather than an `AppError`.
 */
export function pairOrder(a: string, b: string): { low: string; high: string } {
  const first = a.toLowerCase();
  const second = b.toLowerCase();

  if (first === second) {
    throw new Error('pair_history requires two distinct user ids');
  }

  return first < second ? { low: first, high: second } : { low: second, high: first };
}

/**
 * Records one completed meetup for a pair and returns the pair's new total (AAP 0.5.7).
 *
 * One statement inserts the row or increments it, atomically on the primary key, so no
 * read-modify-write race exists. `first_completed_at` is set by the insert and never touched again;
 * `last_completed_at` only moves forward, so a settlement finishing out of order cannot pull it back.
 * Two settlements of one pair cannot overlap by design — the pair's open-meetup index allows one
 * meetup at a time, and settlement serializes on the meetup row — so the insert is the pair's first
 * completion.
 *
 * Called by settlement alone, for a `completed` outcome, inside the settlement transaction — it
 * never opens a transaction of its own, and `MeetupSettlement`'s primary key is what keeps the
 * increment to exactly one per meetup when settlement runs twice (AAP 0.3.2, 0.5.7). Anti-farming is
 * deliberately not applied here (AAP 0.7.3).
 *
 * @param tx - The settlement transaction's client, never a bare client, so the increment commits
 *   with the rest of the settlement.
 * @param pair - The pair's ids in either order; {@link pairOrder} canonicalizes them.
 * @param completedAt - When the meetup was witnessed, from the injected clock.
 * @returns The pair's completion count including this meetup.
 * @throws Error when the statement returns no row or `pair` names one user twice.
 */
export async function recordCompletion(
  tx: DbTx,
  pair: PairParticipants,
  completedAt: Date,
): Promise<PairCompletion> {
  const { low, high } = pairOrder(pair.initiatorId, pair.recipientId);

  const rows = await tx.$queryRaw<{ completed_count: number }[]>(Prisma.sql`
    INSERT INTO "pair_history"
      ("user_low_id", "user_high_id", "completed_count", "first_completed_at", "last_completed_at")
    VALUES (${low}::uuid, ${high}::uuid, 1, ${completedAt}, ${completedAt})
    ON CONFLICT ("user_low_id", "user_high_id") DO UPDATE
      SET "completed_count" = "pair_history"."completed_count" + 1,
          "last_completed_at" = GREATEST("pair_history"."last_completed_at", EXCLUDED."last_completed_at")
    RETURNING "completed_count"
  `);

  // `INSERT ... RETURNING` always yields exactly one row, so none means the write was lost.
  const row = rows[0];
  if (row === undefined) {
    throw new Error('pair_history increment returned no row');
  }

  return { completedCount: row.completed_count };
}

/**
 * Reads a pair's completion count, or `null` when the pair has never completed a meetup (AAP 0.5.7).
 *
 * Read-only and safe inside or outside a transaction. It selects `completed_count` alone, so a
 * caller deciding a disclosure tier never loads the instants that would widen a response.
 *
 * @param db - The guarded client, or the transaction's client when the caller is already in one.
 * @param a - One participant's user id.
 * @param b - The other participant's user id.
 * @returns The pair's completion count, or `null` when no row exists.
 * @throws Error when the two ids are the same (see {@link pairOrder}).
 */
export async function pairHistory(
  db: DbClient | DbTx,
  a: string,
  b: string,
): Promise<PairCompletion | null> {
  const { low, high } = pairOrder(a, b);

  const row = await db.pairHistory.findUnique({
    where: { userLowId_userHighId: { userLowId: low, userHighId: high } },
    select: { completedCount: true },
  });

  return row === null ? null : { completedCount: row.completedCount };
}
