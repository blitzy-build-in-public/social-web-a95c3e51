/**
 * The operator's lodging-claim work: the claim queue, the operator's resolution of one claim, and the
 * audited read of a claim's booking details (AAP 0.5.1, 0.5.4, 0.5.3).
 *
 * Three handlers, one per route, and nothing else:
 *
 * - {@link listLodgingClaims} answers `GET /admin/lodging-claims` with the claims an operator still
 *   has to act on — `pending_call` and `calling` (AAP 0.5.3) — each joined to the lodging it
 *   concerns. The booking details are never in that read: a claim's availability is computed in SQL
 *   as a boolean, so no ciphertext ever leaves PostgreSQL on this path.
 * - {@link resolveLodgingClaim} answers `POST /admin/lodging-claims/:id/resolve` and applies one
 *   terminal outcome (`verified`, `rejected`, `unreachable`) to a claim an operator resolved by hand,
 *   which is the fallback when the automated call cannot (AAP 0.5.3). It is the operator's twin of
 *   `apps/workers/src/jobs/lodging-claims.ts`'s `resolveClaim` — the same guarded status change, the
 *   same cancellation of the verification work still outstanding, the same leaderboard backfill on
 *   `verified`, the same analytics event and the same notification — with three differences that are
 *   the operator's alone: the tasks it cancels record `resolvedBy = 'operator'` and lose any
 *   `blockedReason` they were carrying, and it runs inside the API's transaction helper rather than a
 *   worker's own.
 * - {@link bookingDetails} answers the additive `GET /admin/lodging-claims/:id/booking-details`,
 *   whose read is the one exception to the zero-knowledge principle the product rests on and is
 *   therefore audited: every read writes an `OperatorAccessLog` row in the same transaction, and only
 *   a claim that is still open and whose details are not yet erased can be read at all (AAP 0.5.2).
 *
 * Rules that hold across the file:
 *
 * - **Time comes from the caller.** Each handler takes `now` — the route passes
 *   `request.receivedAt` (AAP 0.11.1) — and the module reads no clock of its own.
 * - **The claim row is the serialization point.** A resolution locks it `FOR UPDATE` and only the
 *   claim, never the joined lodging row, so a resolution serializes against a call result, the
 *   72-hour expiry and another operator, without holding a lock on a shared business row.
 * - **Redis stays outside the transaction.** The leaderboard cache is dropped in the transaction's
 *   post-commit callback, and only for a `verified` outcome, so a rollback can never leave a cold
 *   cache behind (AAP 0.3.2, 0.5.7).
 * - **Nothing is erased here.** The booking name and reference are wiped by the workers' hourly
 *   `data-expiry` run at its first pass after the claim becomes terminal, well inside the 24-hour
 *   limit (AAP 0.5.2); the claim's own `claim-expire` job then finds it terminal and does nothing.
 * - **No raw value reaches a log.** The two log lines name a claim id, an outcome and an operator id
 *   and never a booking field, a phone number or a stay date (AAP 0.11.1).
 *
 * @see AAP 0.5.4 for the three routes, their DTOs and their errors, 0.5.3 for the claim and call-task
 *   lifecycles, 0.5.7 for the leaderboard backfill and the claim measures, 0.5.2 for the retention of
 *   the booking fields and of the audit log, 0.8.1 for this file.
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

// Type-only, so this file holds no runtime edge to the module that builds the app — the same
// `AppServices` every module of `apps/api/src/modules` names (AAP 0.5.1).
import type { AppServices } from '../../app.ts';

// ---------------------------------------------------------------------------------------------
// The rules, as values (AAP 0.5.3, 0.5.4)
// ---------------------------------------------------------------------------------------------

/**
 * The most claims one read of the queue returns.
 *
 * A cap rather than a page size: the contract carries no cursor, so an operator who needs an older
 * claim reads it in the database. The queue holds only what is still open, so a standing queue longer
 * than this is itself the signal an operator needs.
 */
export const ADMIN_LODGING_CLAIMS_LIMIT = 200;

/**
 * The alias the raw statements give the joined `lodging`, which {@link fixturePredicate} is given: the
 * claim's own columns are addressed as `c` in those statements, spelled once and read there.
 */
const LODGING_ALIAS = 'l';

/**
 * How long an unresolved claim may live: 72 hours from its creation (AAP 0.5.3). Reported as
 * `expiresAt` — the instant `claim-expire-<claimId>` moves a claim still waiting in this queue to
 * `unreachable` with no penalty — and applied by the workers' job, never here.
 */
const CLAIM_EXPIRY_MS = CLAIM_EXPIRY_HOURS * HOUR_MS;

/**
 * The two statuses a claim may still leave, so the only ones this queue lists and the only ones an
 * operator may resolve. Every other status is terminal, and a terminal claim stays terminal
 * (AAP 0.5.3).
 */
const ACTIVE_CLAIM_STATUSES = [
  'pending_call',
  'calling',
] as const satisfies readonly LodgingClaimStatus[];

/**
 * The task statuses that are still outstanding, so a resolution cancels them: a verification task
 * that is `queued`, `in_progress`, `needs_review` or `unreachable` has not produced the claim's
 * result (AAP 0.5.3).
 */
const OUTSTANDING_TASK_STATUSES = [
  'queued',
  'in_progress',
  'needs_review',
  'unreachable',
] as const satisfies readonly CallTaskStatus[];

/**
 * The attempt states in which a call may genuinely be live, so a cancelled task's attempt is marked
 * superseded: the relay checks that flag before every turn, speaks its closing line and ends the call
 * (AAP 0.5.3).
 */
const LIVE_ATTEMPT_STATES = [
  'dispatching',
  'dispatch_unknown',
  'dialing',
  'in_progress',
] as const satisfies readonly CallAttemptState[];

/** The one purpose for which this module may read a claim's booking details (AAP 0.5.4). */
const MANUAL_VERIFICATION_PURPOSE: OperatorAccessPurpose = 'manual_verification_call';

/**
 * What an unreadable stored value answers with. The message is a fixed sentence: the ciphertext, the
 * key id and the reason a {@link decryptField} call failed stay in the log's narrowed cause chain and
 * never in the envelope (AAP 0.11.1).
 */
const DETAILS_UNREADABLE = 'The stored booking details could not be read.';

/** What an outcome outside the contract, or on a claim that left its active state, answers with. */
const INVALID_OUTCOME =
  'A lodging claim accepts verified, rejected or unreachable, and only while it is open.';

// ---------------------------------------------------------------------------------------------
// Types (AAP 0.5.2, 0.5.4)
// ---------------------------------------------------------------------------------------------

/**
 * One row of the claim queue: the claim and the lodging it concerns, read through
 * {@link toAdminLodgingClaimDto}.
 *
 * `city_id` is the lodging's city, which is the city every figure of the claim is counted under; the
 * route and the dashboard both need it. `details_available` is the SQL boolean
 * `booking_name_ciphertext IS NOT NULL AND details_erased_at IS NULL` — the queue never reads the
 * ciphertext itself (AAP 0.5.2).
 */
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

/**
 * A locked claim as {@link resolveLodgingClaim} reads it: the queue's own fields plus the two ids a
 * resolution acts on — the claimant, whose analytics event and notification it writes, and the
 * lodging, whose leaderboard it may credit.
 */
interface LockedClaimRow extends AdminLodgingClaimRow {
  readonly user_id: string;
  readonly lodging_id: string;
}

/**
 * A shared claim as {@link bookingDetails} reads it: the two stored ciphertexts — the only read of
 * them anywhere in the API outside the voice relay (AAP 0.5.2) — and the three fields that decide
 * whether they may be opened at all.
 */
interface BookingClaimRow {
  readonly id: string;
  readonly status: LodgingClaimStatus;
  readonly details_erased_at: Date | null;
  readonly booking_name_ciphertext: string | null;
  readonly booking_reference_ciphertext: string | null;
}

// ---------------------------------------------------------------------------------------------
// Mapping (AAP 0.5.4)
// ---------------------------------------------------------------------------------------------

/**
 * The one mapper from a claim row to {@link AdminLodgingClaimDto}, shared by both handlers that
 * answer with a claim.
 *
 * Every field is copied by name, so a column added to `lodging_claim` or to `lodging` can never reach
 * an operator without a change here, and no ciphertext is named at all. Two fields are derived rather
 * than stored: `expiresAt`, which is `createdAt + 72 h` (AAP 0.5.3), and the phone, which is answered
 * as `null` when what the lodging carries is not an E.164 number the response schema accepts — the
 * shape is the contract's, and the alternative would be a serialization failure that hides a claim
 * from the queue.
 *
 * @param row - A claim row of the queue or of a claim lock.
 * @returns The contract's claim shape.
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

/** A stored phone number when it is the E.164 form the contract accepts, and `null` otherwise. */
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

/** True while a claim can still be resolved: `pending_call` or `calling` (AAP 0.5.3). */
function isActiveClaim(status: LodgingClaimStatus): boolean {
  return ACTIVE_CLAIM_STATUSES.some((active) => active === status);
}

// ---------------------------------------------------------------------------------------------
// The queue (AAP 0.5.4)
// ---------------------------------------------------------------------------------------------

/**
 * The operator's claim queue: every claim that is still open, oldest first (AAP 0.5.4).
 *
 * Read-only, so it opens no transaction and takes no lock: the queue is a view of what an operator
 * has to act on, and the decision that acts on a claim belongs to {@link resolveLodgingClaim}, which
 * locks the row it changes. A claim that is resolved between this read and the operator's click is
 * refused there with `422 invalid_outcome`, which is the answer that keeps a terminal claim terminal.
 *
 * The statement selects the claim's own columns and the lodging's name, phone and city, and computes
 * availability as a boolean, so the booking ciphertext is never part of the row this process holds. It
 * is raw SQL because that expression has no Prisma client equivalent, which is also why it carries
 * {@link fixturePredicate}: a raw query bypasses the guarded client's fixture filter (AAP 0.5.2).
 *
 * @param services - The app's services: the guarded database client and the environment the fixture
 *   rule reads (see {@link AppServices}).
 * @returns The open claims, mapped field by field; an empty `items` array when the queue is clear.
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

// ---------------------------------------------------------------------------------------------
// Operator resolution (AAP 0.5.3, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * Applies an operator's terminal outcome to a lodging claim (AAP 0.5.4, 0.5.3).
 *
 * Refusals come in the route's order: an outcome outside {@link OperatorClaimOutcome} is
 * `422 invalid_outcome` before anything is locked, a claim that does not exist is
 * `404 claim_not_found`, and a claim that already left `pending_call` or `calling` is
 * `422 invalid_outcome` — which is what makes a second click, a racing call result and the 72-hour
 * expiry all harmless.
 *
 * One transaction, under the claim's row lock, writes everything the resolution means, so all of it
 * commits with the status change or none does:
 *
 * 1. The guarded status change to the outcome, with `resolvedAt` from `now`.
 * 2. The cancellation of the verification work still outstanding — its tasks become `cancelled` with
 *    `resolvedBy = 'operator'`, and an attempt in a possibly live state becomes `superseded`, which
 *    is the flag the voice relay reads before its next turn.
 * 3. On `verified`, the leaderboard facts the stay backfills, for the completed meetups the claimant
 *    held inside the stay (AAP 0.5.7).
 * 4. The `lodging_claim_resolved` analytics event, whose `outcome` and `resolveSeconds` are the
 *    dashboard's claim measures and whose city is the lodging's (AAP 0.5.7).
 * 5. The claimant's `lodging_claim_resolved` notification, as an outbox row in this transaction, so
 *    the message and the state it describes commit together (AAP 0.3.2).
 *
 * The lodging's cached leaderboard is dropped only after the commit and only for `verified`, through
 * the transaction's post-commit callback, so a rollback leaves no cold cache behind a change that
 * never happened, and a Redis outage costs nothing but the cache's own lifetime (AAP 0.3.2, 0.5.7).
 *
 * The booking details are deliberately untouched: the workers' next hourly `data-expiry` run erases
 * them once the claim is terminal, well inside the 24-hour limit (AAP 0.5.2).
 *
 * @param services - The app's services (see {@link AppServices}): the database and outbox the
 *   transaction is opened through, the injected clock and the keyring the leaderboard uses.
 * @param operatorId - The operator acting; the claim's write fence, and the only account this
 *   resolution is fenced against (AAP 0.5.3).
 * @param claimId - The claim to resolve.
 * @param body - The validated `ResolveLodgingClaim`; `outcome` is checked here against the contract.
 * @param now - The instant the resolution is recorded at, from `request.receivedAt` — this module
 *   reads no clock of its own (AAP 0.11.1).
 * @returns The resolved claim, as the queue would map it, with its new status; the route answers `200`.
 * @throws {AppError} `invalid_outcome` for an outcome outside the contract, for a claim that is
 *   already terminal, and for the impossible case of a guarded update that matches nothing;
 *   `claim_not_found` for an id no claim holds; `token_invalid` when the acting operator's own account
 *   has requested deletion, raised by the fence before any write.
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
 * Cancels the verification work a resolved claim still has outstanding (AAP 0.5.3).
 *
 * Exactly the tasks that have not produced a result are cancelled: the claim's tasks in `queued`,
 * `in_progress`, `needs_review` or `unreachable`. A task that is already terminal — `completed`,
 * `refused`, `do_not_call` or `cancelled` — is left exactly as it stands, and `outcomeAt` is never
 * written here, because a cancelled task was cancelled rather than reaching an outcome (AAP 0.5.3,
 * 0.5.7). Its `blockedReason` is cleared with its status: the task is stopped, not blocked, and a
 * reason written while a dial was still out of reach would describe a call that is never coming
 * (AAP 0.5.3).
 *
 * A cancelled task's attempt in a possibly live state is marked `superseded`. That is the whole
 * handshake with the relay that may be speaking to the business right now: it reads the flag before
 * every turn, speaks its closing line and ends the call, and any result or callback that arrives
 * afterwards is recorded on the attempt alone and never applied (AAP 0.5.3).
 *
 * @param tx - The transaction that is resolving the claim, which the cancellations commit with.
 * @param claimId - The resolved claim.
 * @returns How many tasks this call cancelled.
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
 * Locks one claim for the rest of the caller's transaction and returns it, or `null` when no such
 * claim exists (AAP 0.5.3).
 *
 * The lock is the claim's serialization point: the 72-hour expiry, a call result and this resolution
 * all take it before they read a status, so the first writer wins and every later one sees its
 * result. `FOR UPDATE OF "c"` locks the claim row alone — the join to `lodging` is there to read the
 * name, the phone and the city, and locking a shared business row would serialize resolutions against
 * unrelated work in the same city.
 *
 * The row carries the same columns as the queue's read, plus the two ids a resolution acts on; like
 * that read it is raw SQL and carries {@link fixturePredicate} for the lodging it joins (AAP 0.5.2).
 *
 * @param services - The app's services, read for `APP_ENV` in the fixture predicate.
 * @param tx - The transaction the lock is held in; it must be the transaction that resolves the
 *   claim, because a lock is released at commit.
 * @param claimId - The claim to lock.
 * @returns The locked row, or `null` when the claim does not exist.
 * @throws Whatever the statement raised — an aborted transaction, a lost connection — which the
 *   errors plugin answers as `500 internal_error`.
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

// ---------------------------------------------------------------------------------------------
// Audited booking details (AAP 0.5.2, 0.5.4)
// ---------------------------------------------------------------------------------------------

/**
 * Reads a claim's decrypted booking name and reference for an operator's manual verification call
 * (AAP 0.5.4, 0.5.2).
 *
 * This is the one route that returns a booking name, and it is the reason the audit log exists: every
 * read inserts its `OperatorAccessLog` row in the same transaction as the read, so no operator can see
 * a guest's name without a record of it, and a failure to decrypt rolls the audit row back with the
 * read — an unauditable read does not happen.
 *
 * Only a claim that is still open and whose details have not been erased is readable: a claim that
 * left `pending_call` or `calling`, one whose `detailsErasedAt` is set, or one that carries no name
 * answers `409 details_unavailable`. The first hourly `data-expiry` run after a claim reaches a
 * terminal state erases the two ciphertexts (AAP 0.5.2), so the window is the claim's own resolution
 * plus at most an hour.
 *
 * The claim is read `FOR SHARE`, which is the weakest lock that still does the job: it keeps the
 * erasure's own update off the row for the length of this read, while letting two operators read the
 * same claim's details at the same time.
 *
 * The decrypted values leave the process only in this answer: they are never logged, cached, retried
 * or echoed in an error, and the one log line this route writes names the claim and the operator
 * (AAP 0.11.1). `routes.ts` sets `Cache-Control: no-store` on the reply.
 *
 * @param services - The app's services (see {@link AppServices}): the database, the outbox and the
 *   field keyring the two ciphertexts are opened with.
 * @param operatorId - The operator whose read is audited, and the write fence of this transaction.
 * @param claimId - The claim whose details are wanted.
 * @param now - The instant the access is recorded at, from `request.receivedAt` (AAP 0.11.1).
 * @returns The decrypted name and, when the claim carries one, the reference.
 * @throws {AppError} `claim_not_found` for an id no claim holds; `details_unavailable` for a claim
 *   that is terminal, erased or holds no name; `internal_error` when a stored value cannot be
 *   decrypted under this process's keyring — a defect of the stored data rather than the caller's
 *   fault, and deliberately not a client error; `token_invalid` when the acting operator's own
 *   account has requested deletion, raised by the fence before any read.
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
 * Reads one claim's status, erasure mark and two ciphertexts, shared for the length of the caller's
 * transaction, or `null` when no such claim exists (AAP 0.5.2).
 *
 * No join, so no fixture predicate is needed: `lodging_claim` is user data rather than a fixture-
 * bearing table, and the one field of the lodging this route could have needed — a name to render —
 * is not part of an answer that exists to be read aloud on a phone call.
 *
 * @param tx - The transaction the share lock is held in.
 * @param claimId - The claim to read.
 * @returns The claim's details row, or `null` when the claim does not exist.
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
 * Opens one stored field, or reports the failure as ours (AAP 0.5.2, 0.11.1).
 *
 * A {@link FieldDecryptionError} means the value was written under a key this process does not hold,
 * that its payload was altered at rest, or that the row is not the shape `encryptField` writes. None
 * of those is the caller's mistake, so it becomes a `500 internal_error` rather than a client error
 * the operator would be told to retry against: a key the ring has lost needs an operator to fix the
 * environment, not the claim. The failure is attached as the cause, so the errors plugin logs the
 * reason and the key id while the envelope carries this fixed sentence alone; the ciphertext, the
 * plaintext and the key material stay inside this frame.
 *
 * @param services - The app's services, read for the field keyring.
 * @param ciphertext - The `<keyId>.<base64url>` value to open.
 * @returns The plaintext.
 * @throws {AppError} `internal_error` when the value cannot be decrypted; any other thrown value is
 *   rethrown unchanged, because it is a bug rather than an unreadable row.
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
