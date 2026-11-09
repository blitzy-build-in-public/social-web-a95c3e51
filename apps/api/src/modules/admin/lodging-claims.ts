/**
 * The operator's lodging-claim work: the claim queue, the operator's resolution of one claim, and the audited read of a
 * claim's booking details.
 *
 * {@link listLodgingClaims} answers the claims an operator still has to act on — `pending_call` and `calling` — with a
 * claim's availability computed in SQL so no ciphertext ever leaves PostgreSQL on this path. {@link resolveLodgingClaim}
 * is the operator's twin of the workers' `resolveClaim`, cancelling with `resolvedBy = 'operator'` and clearing any
 * `blockedReason`. {@link bookingDetails} is the one exception to the zero-knowledge principle and is audited: every
 * read writes an `OperatorAccessLog` row in the same transaction.
 *
 * Time comes from the caller; a resolution locks the claim row `FOR UPDATE` and never the joined lodging row; the
 * leaderboard cache is dropped post-commit and only for `verified`; and no log line names a booking field, a phone
 * number or a stay date.
 */

import { Prisma, fixturePredicate, type DbTx } from '@tablemate/db';
import { FieldDecryptionError, decryptField } from '@tablemate/server-core';
import { CLAIM_EXPIRY_HOURS, E164, HOUR_MS, OperatorClaimOutcome } from '@tablemate/shared';
import type {
  AdminLodgingClaimDto,
  AdminLodgingClaimsResponse,
  BookingDetailsDto,
  CallAttemptState,
  CallTaskStatus,
  LodgingClaimStatus,
  OperatorAccessPurpose,
  ResolveLodgingClaim,
} from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { emit } from '../analytics/emit.ts';
import { invalidateLeaderboard, recordActivityForVerifiedClaim } from '../lodgings/leaderboard.ts';
import { notify } from '../notifications/enqueue.ts';
import { transact } from '../outbox/write.ts';

// Type-only, so this file holds no runtime edge to the module that builds the app.
import type { AppServices } from '../../app.ts';

/**
 * The most claims one read of the queue returns: a cap rather than a page size, because the contract carries no cursor.
 * The queue holds only what is still open, so a longer queue is itself the signal an operator needs.
 */
export const ADMIN_LODGING_CLAIMS_LIMIT = 200;

/** The alias the raw statements give the joined `lodging`, which {@link fixturePredicate} is given. */
const LODGING_ALIAS = 'l';

/**
 * How long an unresolved claim may live: 72 hours from its creation, reported as `expiresAt` and applied by the workers,
 * never here.
 */
const CLAIM_EXPIRY_MS = CLAIM_EXPIRY_HOURS * HOUR_MS;

/** The two statuses a claim may still leave, so the only ones this queue lists and an operator may resolve. */
const ACTIVE_CLAIM_STATUSES = [
  'pending_call',
  'calling',
] as const satisfies readonly LodgingClaimStatus[];

/** The task statuses that are still outstanding, so a resolution cancels them: those that have not produced the claim's
 * result. */
const OUTSTANDING_TASK_STATUSES = [
  'queued',
  'in_progress',
  'needs_review',
  'unreachable',
] as const satisfies readonly CallTaskStatus[];

/** The attempt states in which a call may genuinely be live, so a cancelled task's attempt is marked `superseded`. */
const LIVE_ATTEMPT_STATES = [
  'dispatching',
  'dispatch_unknown',
  'dialing',
  'in_progress',
] as const satisfies readonly CallAttemptState[];

/** The one purpose for which this module may read a claim's booking details (AAP 0.5.4). */
const MANUAL_VERIFICATION_PURPOSE: OperatorAccessPurpose = 'manual_verification_call';

/** What an unreadable stored value answers with; the ciphertext, the key id and the failure's cause stay in the log,
 * never in the envelope. */
const DETAILS_UNREADABLE = 'The stored booking details could not be read.';

/** What an outcome outside the contract, or on a claim that left its active state, answers with. */
const INVALID_OUTCOME =
  'A lodging claim accepts verified, rejected or unreachable, and only while it is open.';
/** `city_id` is the lodging's city; `details_available` is the SQL boolean `booking_name_ciphertext IS NOT NULL AND
 * details_erased_at IS NULL`, because the queue never reads the ciphertext itself. */
export interface AdminLodgingClaimRow {
  readonly id: string;
  readonly lodging_name: string;
  readonly lodging_phone: string | null;
  readonly city_id: string;
  readonly status: LodgingClaimStatus;
  readonly stay_from: Date;
  readonly stay_to: Date;
  readonly created_at: Date;
  readonly details_available: boolean;
}

/** A locked claim: the queue's own fields plus the two ids a resolution acts on — the claimant, whose analytics event
 * and notification it writes, and the lodging, whose leaderboard it may credit. */
interface LockedClaimRow extends AdminLodgingClaimRow {
  readonly user_id: string;
  readonly lodging_id: string;
}

/**
 * A shared claim as {@link bookingDetails} reads it: the two stored ciphertexts — the only read of them anywhere in the
 * API outside the voice relay — and the three fields that decide whether they may be opened.
 */
interface BookingClaimRow {
  readonly id: string;
  readonly status: LodgingClaimStatus;
  readonly details_erased_at: Date | null;
  readonly booking_name_ciphertext: string | null;
  readonly booking_reference_ciphertext: string | null;
}

/**
 * Every field is copied by name, so a column added to `lodging_claim` or `lodging` can never reach an operator without a
 * change here. Two fields are derived: `expiresAt`, which is `createdAt + 72 h`, and the phone, answered as `null` when
 * the lodging carries no E.164 number the response schema accepts, because the alternative would be a serialization
 * failure that hides a claim from the queue.
 */
export function toAdminLodgingClaimDto(row: AdminLodgingClaimRow): AdminLodgingClaimDto {
  return {
    id: row.id,
    lodgingName: row.lodging_name,
    lodgingPhone: e164OrNull(row.lodging_phone),
    cityId: row.city_id,
    status: row.status,
    stayFrom: toDateOnly(row.stay_from),
    stayTo: toDateOnly(row.stay_to),
    createdAt: row.created_at.toISOString(),
    expiresAt: new Date(row.created_at.getTime() + CLAIM_EXPIRY_MS).toISOString(),
    detailsAvailable: row.details_available,
  };
}

function e164OrNull(phone: string | null): string | null {
  const parsed = E164.safeParse(phone);
  return parsed.success ? parsed.data : null;
}

/** A stored `@db.Date` day as `YYYY-MM-DD`: it reads back as UTC midnight, so the date is the date. */
function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Whole seconds between a claim's creation and its resolution, never negative (AAP 0.5.7). */
function elapsedSeconds(now: Date, createdAt: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 1000));
}

function isActiveClaim(status: LodgingClaimStatus): boolean {
  return ACTIVE_CLAIM_STATUSES.some((active) => active === status);
}

/**
 * Read-only: the queue is a view of what an operator has to act on, and the decision that acts on a claim belongs to
 * {@link resolveLodgingClaim}, which locks the row it changes. A claim resolved between this read and the operator's
 * click is refused there with `422 invalid_outcome`, which keeps a terminal claim terminal.
 *
 * The statement computes availability as a boolean, so the booking ciphertext is never part of the row this process
 * holds. It is raw SQL, which is why it carries {@link fixturePredicate}: a raw query bypasses the guarded client's
 * fixture filter.
 */
export async function listLodgingClaims(
  services: AppServices,
): Promise<AdminLodgingClaimsResponse> {
  const rows = await services.db.$queryRaw<AdminLodgingClaimRow[]>(Prisma.sql`
    SELECT "c"."id"::text AS "id",
           "l"."name" AS "lodging_name",
           "l"."phone" AS "lodging_phone",
           "l"."city_id" AS "city_id",
           "c"."status"::text AS "status",
           "c"."stay_from" AS "stay_from",
           "c"."stay_to" AS "stay_to",
           "c"."created_at" AS "created_at",
           ("c"."booking_name_ciphertext" IS NOT NULL AND "c"."details_erased_at" IS NULL)
             AS "details_available"
      FROM "lodging_claim" AS "c"
      JOIN "lodging" AS "l" ON "l"."id" = "c"."lodging_id"
     WHERE "c"."status" IN ('pending_call', 'calling')
       AND ${fixturePredicate(services.env.APP_ENV, LODGING_ALIAS)}
     ORDER BY "c"."created_at", "c"."id"
     LIMIT ${ADMIN_LODGING_CLAIMS_LIMIT}::int
  `);
  return { items: rows.map(toAdminLodgingClaimDto) };
}

/**
 * Refusals come in the route's order: an outcome outside {@link OperatorClaimOutcome} is `422 invalid_outcome` before
 * anything is locked, a claim that does not exist is `404 claim_not_found`, and a claim that already left `pending_call`
 * or `calling` is `422 invalid_outcome` — which is what makes a second click, a racing call result and the 72-hour
 * expiry harmless. An operator whose own account requested deletion is `401 token_invalid`, raised by the fence before
 * any write.
 *
 * One transaction under the claim's row lock writes everything the resolution means, so it all commits with the status
 * change or none does: the status change with `resolvedAt` from `now`; the cancellation of the outstanding verification
 * work; on `verified`, the leaderboard facts the stay backfills for the meetups the claimant held inside it; the
 * `lodging_claim_resolved` analytics event, whose `outcome` and `resolveSeconds` are the dashboard's claim measures; and
 * the claimant's notification as an outbox row in this transaction.
 *
 * The cached leaderboard is dropped only after the commit and only for `verified`, through the post-commit callback. The
 * booking details are deliberately untouched: the workers' next hourly `data-expiry` run erases them once the claim is
 * terminal. `now` is the caller's.
 */
export async function resolveLodgingClaim(
  services: AppServices,
  operatorId: string,
  claimId: string,
  body: ResolveLodgingClaim,
  now: Date,
): Promise<AdminLodgingClaimDto> {
  const outcome = OperatorClaimOutcome.safeParse(body.outcome);
  if (!outcome.success) {
    throw new AppError('invalid_outcome', INVALID_OUTCOME);
  }
  const resolved = await transact(
    services,
    async (tx, after) => {
      const claim = await lockClaim(services, tx, claimId);
      if (claim === null) {
        throw new AppError('claim_not_found');
      }
      if (!isActiveClaim(claim.status)) {
        throw new AppError('invalid_outcome', INVALID_OUTCOME);
      }
      // Guarded on the status the lock just read: under the lock this cannot match no row, and if it
      // ever did, a resolution must not report success for a claim it did not change.
      const applied = await tx.lodgingClaim.updateMany({
        where: { id: claim.id, status: { in: [...ACTIVE_CLAIM_STATUSES] } },
        data: { status: outcome.data, resolvedAt: now },
      });
      if (applied.count === 0) {
        throw new AppError('invalid_outcome', INVALID_OUTCOME);
      }
      await cancelOutstandingVerification(tx, claim.id);
      if (outcome.data === 'verified') {
        await recordActivityForVerifiedClaim(tx, services, {
          id: claim.id,
          userId: claim.user_id,
          lodgingId: claim.lodging_id,
          stayFrom: claim.stay_from,
          stayTo: claim.stay_to,
        });
        after(() => invalidateLeaderboard(services, claim.city_id));
      }
      await emit(tx, services, 'lodging_claim_resolved', claim.user_id, {
        cityId: claim.city_id,
        props: {
          outcome: outcome.data,
          resolveSeconds: elapsedSeconds(now, claim.created_at),
        },
      });
      await notify(tx, claim.user_id, 'lodging_claim_resolved', { lodgingClaimId: claim.id });
      return { ...toAdminLodgingClaimDto(claim), status: outcome.data };
    },
    { fenceUserId: operatorId },
  );
  services.logger.info(
    { event: 'lodging_claim_resolved', claimId: resolved.id, outcome: outcome.data },
    'lodging_claim_resolved',
  );
  return resolved;
}

/**
 * Cancels the verification work a resolved claim still has outstanding: exactly the tasks that have not produced a
 * result, and `outcomeAt` is never written here, because a cancelled task was cancelled rather than reaching an outcome.
 * Its `blockedReason` is cleared with its status — the task is stopped, not blocked.
 *
 * A cancelled task's attempt in a possibly live state is marked `superseded`, which is the whole handshake with a relay
 * that may be speaking to the business right now: it reads the flag before every turn, speaks its closing line and ends
 * the call.
 */
async function cancelOutstandingVerification(tx: DbTx, claimId: string): Promise<number> {
  const tasks = await tx.callTask.findMany({
    where: { lodgingClaimId: claimId, status: { in: [...OUTSTANDING_TASK_STATUSES] } },
    select: { id: true },
  });
  if (tasks.length === 0) {
    return 0;
  }
  const taskIds = tasks.map((task) => task.id);
  await tx.callTask.updateMany({
    where: { id: { in: taskIds } },
    data: { status: 'cancelled', resolvedBy: 'operator', blockedReason: null },
  });
  await tx.callAttempt.updateMany({
    where: {
      callTaskId: { in: taskIds },
      state: { in: [...LIVE_ATTEMPT_STATES] },
      superseded: false,
    },
    data: { superseded: true },
  });
  return taskIds.length;
}

/**
 * Locks one claim for the rest of the caller's transaction and returns it, or `null` when no such claim exists: the lock
 * is the claim's serialization point, taken by the 72-hour expiry, a call result and this resolution before they read a
 * status, so the first writer wins.
 *
 * `FOR UPDATE OF "c"` locks the claim row alone — the join to `lodging` is there to read the name, the phone and the
 * city, and locking a shared business row would serialize resolutions against unrelated work. Raw SQL, so it carries
 * {@link fixturePredicate} for the lodging it joins.
 */
async function lockClaim(
  services: AppServices,
  tx: DbTx,
  claimId: string,
): Promise<LockedClaimRow | null> {
  const rows = await tx.$queryRaw<LockedClaimRow[]>(Prisma.sql`
    SELECT "c"."id"::text AS "id",
           "c"."user_id"::text AS "user_id",
           "c"."lodging_id"::text AS "lodging_id",
           "l"."name" AS "lodging_name",
           "l"."phone" AS "lodging_phone",
           "l"."city_id" AS "city_id",
           "c"."status"::text AS "status",
           "c"."stay_from" AS "stay_from",
           "c"."stay_to" AS "stay_to",
           "c"."created_at" AS "created_at",
           ("c"."booking_name_ciphertext" IS NOT NULL AND "c"."details_erased_at" IS NULL)
             AS "details_available"
      FROM "lodging_claim" AS "c"
      JOIN "lodging" AS "l" ON "l"."id" = "c"."lodging_id"
     WHERE "c"."id" = ${claimId}::uuid
       AND ${fixturePredicate(services.env.APP_ENV, LODGING_ALIAS)}
       FOR UPDATE OF "c"
  `);
  return rows[0] ?? null;
}

/**
 * This is the one route that returns a booking name, and it is the reason the audit log exists: every read inserts its
 * `OperatorAccessLog` row in the same transaction as the read, so no operator sees a guest's name without a record of
 * it, and a failure to decrypt rolls the audit row back — an unauditable read does not happen.
 *
 * Only a claim that is still open and whose details are not yet erased is readable; anything else is
 * `409 details_unavailable`, and the window is the claim's own resolution plus at most one hourly `data-expiry` run. The
 * claim is read `FOR SHARE`: it keeps the erasure's update off the row while letting two operators read the same claim at
 * once. The decrypted values leave the process only in this answer and the one log line names the claim and the operator;
 * `routes.ts` sets `Cache-Control: no-store`.
 */
export async function bookingDetails(
  services: AppServices,
  operatorId: string,
  claimId: string,
  now: Date,
): Promise<BookingDetailsDto> {
  const details = await transact(
    services,
    async (tx) => {
      const claim = await shareClaim(tx, claimId);
      if (claim === null) {
        throw new AppError('claim_not_found');
      }
      if (
        !isActiveClaim(claim.status) ||
        claim.details_erased_at !== null ||
        claim.booking_name_ciphertext === null
      ) {
        throw new AppError('details_unavailable');
      }
      const bookingName = openField(services, claim.booking_name_ciphertext);
      const bookingReference =
        claim.booking_reference_ciphertext === null
          ? null
          : openField(services, claim.booking_reference_ciphertext);
      await tx.operatorAccessLog.create({
        data: {
          operatorId,
          lodgingClaimId: claim.id,
          accessedAt: now,
          purpose: MANUAL_VERIFICATION_PURPOSE,
        },
      });
      return { claimId: claim.id, bookingName, bookingReference };
    },
    { fenceUserId: operatorId },
  );
  services.logger.info(
    { event: 'booking_details_accessed', claimId: details.claimId, operatorId },
    'booking_details_accessed',
  );
  return details;
}

/**
 * Reads one claim's status, erasure mark and two ciphertexts, shared for the length of the caller's transaction, or
 * `null` when no such claim exists. No join, so no fixture predicate: `lodging_claim` is user data rather than a
 * fixture-bearing table.
 */
async function shareClaim(tx: DbTx, claimId: string): Promise<BookingClaimRow | null> {
  const rows = await tx.$queryRaw<BookingClaimRow[]>(Prisma.sql`
    SELECT "c"."id"::text AS "id",
           "c"."status"::text AS "status",
           "c"."details_erased_at" AS "details_erased_at",
           "c"."booking_name_ciphertext" AS "booking_name_ciphertext",
           "c"."booking_reference_ciphertext" AS "booking_reference_ciphertext"
      FROM "lodging_claim" AS "c"
     WHERE "c"."id" = ${claimId}::uuid
       FOR SHARE
  `);
  return rows[0] ?? null;
}

/**
 * Opens one stored field, or reports the failure as ours. A {@link FieldDecryptionError} means the value was written
 * under a key this process does not hold, was altered at rest, or is not the shape `encryptField` writes: none of those
 * is the caller's mistake, so it becomes a `500 internal_error` with the failure attached as the cause, which the errors
 * plugin logs as the reason and key id.
 */
function openField(services: AppServices, ciphertext: string): string {
  try {
    return decryptField(services.keyring, ciphertext);
  } catch (error) {
    if (!(error instanceof FieldDecryptionError)) {
      throw error;
    }
    throw new AppError('internal_error', DETAILS_UNREADABLE, { cause: error });
  }
}
