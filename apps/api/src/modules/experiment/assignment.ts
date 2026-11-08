/**
 * The framing experiment's once-only variant assignment (AAP 0.5.7, 0.8.1).
 *
 * A traveler's variant is the experiment's single variable: it picks the deposit copy on every
 * deposit screen, in every deposit notification and on every deposit-funnel event (AAP 0.1.1,
 * 0.5.7). The assignment therefore has to be deterministic from the account id, stable for the life
 * of the account, and impossible to recompute into a different answer.
 *
 * {@link bucketFor} maps a user id into one of 10000 buckets under `EXPERIMENT_SALT`;
 * {@link variantFromBucket} compares that bucket with the accepted share; {@link assign} records the
 * result at account creation, inside the caller's transaction, and never updates it. So a later
 * split change, a re-login or a second call leaves a stored variant as it was written (AAP 0.5.7),
 * and only account erasure removes the row (AAP 0.5.2), after which {@link variantFor} answers
 * `null`. The rule itself lives in the two pure functions, which is what lets the unit test
 * recompute buckets independently.
 *
 * @see AAP 0.5.1 for the experiment component, 0.5.7 for the rule, 0.6.2 for `EXPERIMENT_SALT` and
 *   `EXPERIMENT_SOCIAL_SHARE`, 0.11.1 for the injected clock.
 */

import { hmac } from '@tablemate/server-core';
import { Variant } from '@tablemate/shared';

import type { DbClient, DbTx } from '@tablemate/db';

// Type-only, so this file holds no runtime edge to the module that builds the app. The two services
// the assignment reads are the environment (the salt and the split) and the injected clock.
import type { AppServices } from '../../app.ts';

/** The bucket count and the basis-point scale of the split: `share * SHARE_BASIS` (AAP 0.5.7). */
export const SHARE_BASIS = 10_000;

/** What an assignment is to every consumer: the stored variant and its audit id (AAP 0.5.2). */
export type ExperimentAssignmentRef = {
  /** `social` or `punitive`, fixed for the life of the account (AAP 0.5.7). */
  readonly variant: Variant;
  /** `ExperimentAssignment.assignmentId`, carried on every funnel event (AAP 0.5.7). */
  readonly assignmentId: string;
};

/**
 * The assignment bucket of `userId`: the whole HMAC-SHA256 digest under `salt`, read big-endian and
 * reduced modulo {@link SHARE_BASIS} (AAP 0.5.7).
 *
 * Pure and keyed, so one user always lands in one bucket and no one can choose a variant by choosing
 * an id. The invariant a test recomputes independently: all 32 digest bytes are read as a single
 * unsigned big-endian integer, never a prefix of them and never a signed 32-bit read.
 *
 * @param salt - `EXPERIMENT_SALT`, which is what makes the bucket unguessable without it.
 * @param userId - The account's user id.
 * @returns A bucket in 0-9999.
 */
export function bucketFor(salt: string, userId: string): number {
  const digest = hmac(salt, userId);
  return Number(BigInt(`0x${digest.toString('hex')}`) % BigInt(SHARE_BASIS));
}

/**
 * The variant a bucket falls in under `share` (AAP 0.5.7): `social` while the bucket is below
 * `round(share * 10000)`, `punitive` from there on.
 *
 * The boundaries are load-bearing: share `0.5` puts bucket 4999 in `social` and 5000 in `punitive`,
 * share `1.0` — the request's "100% social" fallback — puts every bucket in `social`, and share `0`
 * puts every one in `punitive`. `Math.round` is the environment's own basis-point conversion, so the
 * split applied here is the split that was configured.
 *
 * @param bucket - A bucket from {@link bucketFor}, 0-9999.
 * @param share - `EXPERIMENT_SOCIAL_SHARE`, between 0 and 1 inclusive.
 * @returns The variant that bucket holds under that share.
 */
export function variantFromBucket(bucket: number, share: number): Variant {
  return bucket < Math.round(share * SHARE_BASIS) ? 'social' : 'punitive';
}

/**
 * Records the account's variant once, at account creation (AAP 0.5.7).
 *
 * Called by `auth/magic-link.ts` inside the transaction that creates the `User` and emits
 * `account_created`, so it never opens a transaction of its own: the assignment commits or rolls
 * back with the account it belongs to. The insert carries conflict-skip semantics, so a second call
 * leaves an existing row untouched — the variant is never recomputed and never updated, which is
 * what keeps it stable across a re-login or a later split change (AAP 0.5.7).
 *
 * @param tx - The account-creation transaction's client.
 * @param services - The app's services: `env.EXPERIMENT_SALT` and `env.EXPERIMENT_SOCIAL_SHARE` for
 *   the rule, and the injected clock for `assignedAt`.
 * @param userId - The account being created.
 * @returns The stored assignment, whether this call wrote the row or found it already there.
 * @throws Error when the row cannot be read back: the insert and the read run in one transaction, so
 *   a missing row means the write was lost rather than that an assignment is optional.
 */
export async function assign(
  tx: DbTx,
  services: AppServices,
  userId: string,
): Promise<ExperimentAssignmentRef> {
  const share = services.env.EXPERIMENT_SOCIAL_SHARE;
  const variant = variantFromBucket(bucketFor(services.env.EXPERIMENT_SALT, userId), share);

  // With the unique `userId` this compiles to `INSERT ... ON CONFLICT DO NOTHING`, so a stored
  // assignment survives. `upsert` is deliberately not used: it would rewrite the variant.
  await tx.experimentAssignment.createMany({
    data: [{ userId, variant, shareAtAssignment: share, assignedAt: services.clock.now() }],
    skipDuplicates: true,
  });

  const row = await tx.experimentAssignment.findUniqueOrThrow({
    where: { userId },
    select: { variant: true, assignmentId: true },
  });

  return { variant: Variant.parse(row.variant), assignmentId: row.assignmentId };
}

/**
 * Reads a user's stored assignment, or `null` when the account has none (AAP 0.5.7).
 *
 * `me/profile.ts` serves it as `MeDto.variant` and `meetups/propose.ts` reads both participants'
 * assignments to fix the pair's `variantPairing`. Read-only, and safe inside or outside a
 * transaction: a caller already in one passes its `tx`. `null` is the honest answer both before the
 * assignment exists and after account erasure has deleted the row (AAP 0.5.2); a caller may never
 * derive a variant itself when this returns `null`.
 *
 * @param db - The guarded client, or the transaction's client when the caller is in one.
 * @param userId - The user whose variant is wanted.
 * @returns The stored assignment, or `null` when no row exists.
 */
export async function variantFor(
  db: DbClient | DbTx,
  userId: string,
): Promise<ExperimentAssignmentRef | null> {
  const row = await db.experimentAssignment.findUnique({
    where: { userId },
    select: { variant: true, assignmentId: true },
  });

  return row === null
    ? null
    : { variant: Variant.parse(row.variant), assignmentId: row.assignmentId };
}
