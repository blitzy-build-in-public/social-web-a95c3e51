/**
 * The anti-farming rule for reputation (AAP 0.5.7, 0.8.1).
 *
 * A completed meetup counts toward reputation when `depositCents >= 500` AND the pair has no
 * counted event in the 30 days before this completion. The window is half-open —
 * `(completedAt - 30 days, completedAt]` — so a counted event exactly 30 days earlier lies outside
 * it and the new completion counts, while one a millisecond inside the window blocks it.
 *
 * The rule limits the reputation counters and the leaderboard score and nothing else (AAP 0.7.3):
 * `pair-history.ts` increments on every completed meetup and the disclosure tiers ignore the rule
 * entirely, so two meetups by one pair still reach tier 3 however close together they fall. The
 * leaderboard's own 30-day `pairKey` dedupe lives in `lodgings/leaderboard.ts` and is deliberately
 * not applied here.
 *
 * {@link countsForReputation} is called from inside the settlement transaction: it opens no
 * transaction of its own, reads no clock and takes the completion time from the caller's injected
 * clock. It ignores blocks and deleted accounts, because blocking never changes counters and a
 * tombstone's retained events still count (AAP 0.5.2, 0.5.7). `witness_event` carries no
 * `is_fixture` column, so no fixture predicate applies to the statement below.
 *
 * @see AAP 0.5.7 for the rule, 0.7.3 for its scope, 0.5.1 for the reputation component's
 *   interface, and 0.11.2 for the parameterized-SQL rule the statement follows.
 */

import { Prisma, type DbClient, type DbTx } from '@tablemate/db';
import {
  ANTI_FARMING_MIN_DEPOSIT_CENTS,
  ANTI_FARMING_WINDOW_DAYS,
  DAY_MS,
} from '@tablemate/shared';

/** The anti-farming window in milliseconds: 30 days (AAP 0.5.7). */
const ANTI_FARMING_WINDOW_MS = ANTI_FARMING_WINDOW_DAYS * DAY_MS;

/**
 * The anti-farming rule itself: the deposit floor and the half-open 30-day window (AAP 0.5.7).
 *
 * Pure by design — no clock and no I/O — so `apps/api/test/unit/anti-farming.test.ts` can pin its
 * boundaries: 499 cents never counts, 500 does, a pair with no counted event counts, and the window
 * ends exactly 30 days before the completion being judged.
 *
 * It limits the reputation counters and the leaderboard score only, never `PairHistory` and never
 * the disclosure tiers (AAP 0.7.3).
 *
 * @param depositCents - The meetup's deposit in integer USD cents.
 * @param lastCountedAt - The pair's most recent counted completion, or null when the pair has none.
 * @param completedAt - When the completion being judged happened, from the caller's injected clock.
 * @returns True when this completion counts toward reputation and the leaderboard.
 */
export function countsForReputationPure(
  depositCents: number,
  lastCountedAt: Date | null,
  completedAt: Date,
): boolean {
  if (depositCents < ANTI_FARMING_MIN_DEPOSIT_CENTS) {
    return false;
  }

  if (lastCountedAt === null) {
    return true;
  }

  return lastCountedAt.getTime() <= completedAt.getTime() - ANTI_FARMING_WINDOW_MS;
}

/** The pair and the completion {@link countsForReputation} judges (AAP 0.5.7). */
export interface CountsForReputationInput {
  /** One participant's user id. */
  readonly userA: string;
  /** The other participant's user id; the pair is read in both orders. */
  readonly userB: string;
  /** When the completion being judged happened, taken from `services.clock` by the caller. */
  readonly completedAt: Date;
  /** The meetup's deposit in integer USD cents. */
  readonly depositCents: number;
  /**
   * The meetup being settled, whose own witness events never count against it. Omitted when the
   * caller is not re-judging a meetup it has already written events for.
   */
  readonly excludeMeetupId?: string;
}

/**
 * Decides whether this completion counts for a pair, by reading the pair's last counted event.
 *
 * Runs inside the settlement transaction and never opens one of its own, so the read and the
 * `WitnessEvent` rows it decides are written under the same meetup row lock (AAP 0.3.2, 0.5.3). It
 * reads no clock: `completedAt` comes from the caller's injected clock (AAP 0.11.1).
 *
 * A deposit below {@link ANTI_FARMING_MIN_DEPOSIT_CENTS} answers false without querying. Otherwise
 * one parameterized statement takes the pair's most recent counted completion inside the half-open
 * window — `("completed_at" > completedAt - 30 days AND "completed_at" <= completedAt)` in either
 * participant order — and hands it to {@link countsForReputationPure}, so the rule itself is stated
 * in exactly one place. `excludeMeetupId` is compared with `IS DISTINCT FROM`, which also keeps
 * rows already purged of their meetup id; such a row still blocks a fresh completion, because a
 * completion that happened in the window blocks one whether or not its meetup survives (AAP 0.5.2).
 *
 * @param tx - The settlement transaction's client, or a plain guarded client outside one.
 * @param input - The pair, the completion time, the deposit and the meetup to leave out.
 * @returns True when the completion counts toward reputation and the leaderboard.
 * @see AAP 0.5.7 for the rule, 0.7.3 for its scope, 0.5.2 for the retained purged rows it reads.
 */
export async function countsForReputation(
  tx: DbTx | DbClient,
  input: CountsForReputationInput,
): Promise<boolean> {
  if (input.depositCents < ANTI_FARMING_MIN_DEPOSIT_CENTS) {
    return false;
  }

  const windowStart = new Date(input.completedAt.getTime() - ANTI_FARMING_WINDOW_MS);
  const excludeMeetup =
    input.excludeMeetupId === undefined
      ? Prisma.empty
      : Prisma.sql`AND "meetup_id" IS DISTINCT FROM ${input.excludeMeetupId}::uuid`;

  const rows = await tx.$queryRaw<{ last: Date | null }[]>(Prisma.sql`
    SELECT max("completed_at") AS "last"
    FROM "witness_event"
    WHERE "counts_for_reputation"
      AND (
        ("user_id" = ${input.userA}::uuid AND "counterpart_id" = ${input.userB}::uuid)
        OR ("user_id" = ${input.userB}::uuid AND "counterpart_id" = ${input.userA}::uuid)
      )
      AND "completed_at" > ${windowStart}::timestamptz
      AND "completed_at" <= ${input.completedAt}::timestamptz
      ${excludeMeetup}
  `);

  return countsForReputationPure(input.depositCents, rows.at(0)?.last ?? null, input.completedAt);
}
