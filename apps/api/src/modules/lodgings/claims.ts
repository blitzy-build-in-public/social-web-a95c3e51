/**
 * Lodging claims: creating one, reading its status, deleting it, and the two reads that share the
 * same definition of "active" (AAP 0.5.1, 0.5.3, 0.5.4, 0.5.7).
 *
 * A claim is what a traveler files to have a stay verified by phone: the claim row carries the stay
 * dates, the booking name and reference **encrypted** (AES-256-GCM through `encryptField`, AAP 0.5.2)
 * and the consent that disclosed the lodging exception before it was given (AAP 0.12.2). The three
 * routes of AAP 0.5.4 are built on this file: `POST /me/lodging-claims` ({@link createClaim}),
 * `GET /me/lodging-claims/:id` ({@link getClaim}) and `DELETE /me/lodging-claims/:id`
 * ({@link deleteClaim}). {@link activeClaimFor} serves the caller's own claim on `GET /me`
 * (`MeDto.activeLodgingClaim`), and {@link deleteClaimsForAccount} is what `DELETE /me` calls inside
 * its user transaction (AAP 0.5.3).
 *
 * Four invariants hold throughout:
 *
 *  - **The caller's proof decides everything.** A claim requires a valid proof (AAP 0.5.7); the
 *    stay must lie inside the proof's own dates and the lodging must be in the proof's city, so a
 *    claim can only ever concern the trip the circuit proved. The proof's city is preferred and the
 *    caller's latest valid proof in any city is the fallback, so a traveler holding two overlapping
 *    proofs is told plainly (`422 lodging_other_city`) instead of silently refused.
 *  - **One active claim per user, under an advisory lock.** A claim is active while it is
 *    `pending_call` or `calling`, and a `verified` one stays active until the end of its `stayTo` in
 *    the lodging's city time — the same predicate `lodgings/leaderboard.ts` and `lodgings/visibility.ts`
 *    read through `currentStayPredicate`, so guest counts, guest lists and this rule can never
 *    disagree (AAP 0.5.2, 0.5.3, 0.5.7). The rule depends on `stayTo`, which no index expresses, so
 *    the check runs inside the transaction that inserts the claim, behind
 *    `pg_advisory_xact_lock(hashtext('lodging-claim:<userId>'))`, and two concurrent requests cannot
 *    both pass it.
 *  - **Booking details are write-only here.** They are encrypted before the insert and never
 *    decrypted, logged or returned by anything in this file; `apps/workers` erases the ciphertext at
 *    the first hourly `data-expiry` run after the claim reaches a terminal state, and the delete
 *    paths take it with the row (AAP 0.5.2).
 *  - **Locks are taken in one order, everywhere.** Claim row first, then the claim's call-task rows
 *    (`lodging_claim` → `call_task`), which `apps/workers`' `call-dispatch`, `call-results` and
 *    `lodging-claims` jobs observe too, so this route and those jobs can never deadlock against each
 *    other (AAP 0.5.3, 0.5.6).
 *
 * Every write runs in one `transact`, fenced on the acting user, so a mutation racing `DELETE /me`
 * commits before it or is refused (AAP 0.5.3); the outbox row and the analytics event are written in
 * that same transaction, and the leaderboard cache is dropped only after it commits.
 *
 * @see AAP 0.5.4 for the three routes, their errors and their order, 0.5.7 for the claim rules,
 *   0.5.2 for the model, the encryption and the retention, 0.5.3 for the claim lifecycle and the
 *   account-deletion disposition, and 0.8.1 for this file.
 */

import { Prisma, fixturePredicate, type DbTx } from '@tablemate/db';
import { encryptField } from '@tablemate/server-core';
import type {
  AppEnv,
  CallAttemptState,
  CallTaskStatus,
  LodgingClaimCreated,
  LodgingClaimRequest,
  LodgingClaimStatus,
  LodgingClaimStatusDto,
  MeDto,
} from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { emit } from '../analytics/emit.ts';
import { transact, writeOutbox, type AfterCommit } from '../outbox/write.ts';
import { activeProof, currentProof, type ProofSummary } from '../proofs/validity.ts';
import { currentStayPredicate, invalidateLeaderboard } from './leaderboard.ts';

// Type-only, as everywhere on this branch: `app.ts` is the one declaration of the app's type, it is
// erased at compile time, and nothing of that module is read here at runtime.
import type { AppServices } from '../../app.ts';

// ---------------------------------------------------------------------------------------------
// The rules, as values (AAP 0.5.3, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * The two statuses in which a claim is active whatever its dates: `pending_call` and `calling`
 * (AAP 0.5.3). Every other status is terminal, and a terminal claim stays terminal.
 *
 * The same list is what `apps/workers/src/jobs/lodging-claims.ts` applies when it decides whether a
 * claim may still be resolved; the two cannot drift, because both are checked against
 * `LodgingClaimStatus`.
 */
const ACTIVE_CLAIM_STATUSES = [
  'pending_call',
  'calling',
] as const satisfies readonly LodgingClaimStatus[];

/**
 * The call-task statuses a deleted or expired claim cancels: a task that is `queued`, `in_progress`,
 * `needs_review` or `unreachable` has not produced the claim's result (AAP 0.5.3). `completed`,
 * `refused`, `do_not_call` and `cancelled` are terminal and are left exactly as they stand.
 */
const OUTSTANDING_TASK_STATUSES = [
  'queued',
  'in_progress',
  'needs_review',
  'unreachable',
] as const satisfies readonly CallTaskStatus[];

/**
 * The attempt states in which a call may genuinely be live (AAP 0.3.2, 0.5.3). A claim is `calling`
 * exactly while one of its attempts is in one of these states, which is why
 * `DELETE /me/lodging-claims/:id` answers `409 call_in_progress` for them, and why account deletion
 * marks them `superseded` — the signal the API's voice relay reads before every turn to speak its
 * closing line and end the call.
 */
const LIVE_ATTEMPT_STATES = [
  'dispatching',
  'dispatch_unknown',
  'dialing',
  'in_progress',
] as const satisfies readonly CallAttemptState[];

/**
 * The advisory-lock key prefix for one user's claim creation: `lodging-claim:<userId>` (AAP 0.5.2).
 * The lock is per user, so two travelers filing claims at the same moment never serialize against
 * each other, while two requests from one traveler always do.
 */
const CLAIM_LOCK_PREFIX = 'lodging-claim:';

/** The alias {@link currentStayPredicate} expects for `lodging_claim`. */
const CLAIM_ALIAS = 'c';

/** The alias {@link currentStayPredicate} expects for `city`. */
const CITY_ALIAS = 'ci';

/** The alias a raw statement that reads `lodging` gives it. */
const LODGING_ALIAS = 'l';

/** The one accepted spelling of a calendar date, and the source of its three parts. */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------------------------------------------------------------------------------------------
// Public shapes (AAP 0.5.4)
// ---------------------------------------------------------------------------------------------

/**
 * The caller's active lodging claim as `GET /me` reports it: exactly `MeDto.activeLodgingClaim`, so
 * the contract and this read cannot drift apart (AAP 0.5.4).
 */
export type ActiveLodgingClaim = NonNullable<MeDto['activeLodgingClaim']>;

/**
 * What {@link deleteClaimsForAccount} deleted, for the account transaction that called it
 * (AAP 0.5.3): the claims themselves, and the cities whose leaderboards the deletion changed.
 */
export interface DeletedClaims {
  /** The ids of the deleted `LodgingClaim` rows, in ascending id order. */
  readonly claimIds: string[];
  /**
   * The cities holding a lodging whose *verified* claim was deleted, deduplicated. Only these need
   * their cached leaderboard dropped: the live verified-guest count changed for them, while the
   * impersonal `LodgingActivityFact` rows behind the score are untouched, so historical standings
   * never move (AAP 0.5.2, 0.5.7).
   */
  readonly cityIds: string[];
}

// ---------------------------------------------------------------------------------------------
// Small helpers (AAP 0.5.3, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * Whether `day` is a real calendar date as `YYYY-MM-DD`.
 *
 * The shared `DateOnly` schema checks the spelling, not the calendar: `2026-02-30` and
 * `2026-04-31` pass it, and JavaScript's `Date` would silently roll such a value over to 2 March and
 * 1 May, storing a stay the traveler never asked for. The round-trip through `Date.UTC` rejects
 * exactly those, so a claim's dates are always the dates that were requested.
 */
function isCalendarDate(day: string): boolean {
  const parts = ISO_DATE_RE.exec(day);
  if (parts === null) {
    return false;
  }
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const dayOfMonth = Number(parts[3]);
  const at = new Date(Date.UTC(year, month - 1, dayOfMonth));
  return (
    at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === dayOfMonth
  );
}

/** The UTC midnight a `@db.Date` column stores for a `YYYY-MM-DD` date (AAP 0.5.2). */
function dateColumn(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** The `YYYY-MM-DD` a `@db.Date` column reads back as, at UTC midnight. */
function isoDateColumn(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Whether the requested stay lies inside the proof's own dates (AAP 0.5.7 "Claim rules").
 *
 * Both dates must be real calendar dates, the first must not be after the second, and the stay must
 * be covered by the proof: `arrivalDate <= stayFrom` and `stayTo <= departureDate`. The comparison
 * is lexicographic on zero-padded `YYYY-MM-DD` strings, which is chronological order, so no date
 * parsing is involved.
 */
function stayWithinProof(stayFrom: string, stayTo: string, proof: ProofSummary): boolean {
  if (!isCalendarDate(stayFrom) || !isCalendarDate(stayTo)) {
    return false;
  }
  return stayFrom <= stayTo && stayFrom >= proof.arrivalDate && stayTo <= proof.departureDate;
}

/**
 * The proof a claim is filed against (AAP 0.5.7): the caller's valid proof for the lodging's city
 * when one exists, otherwise the caller's latest valid proof in any city, so the city mismatch is
 * answered by its own error rather than as a missing proof.
 */
async function proofForLodging(
  tx: DbTx,
  userId: string,
  cityId: string,
  now: Date,
): Promise<ProofSummary | null> {
  const forCity = await activeProof(tx, userId, cityId, now);
  return forCity ?? (await currentProof(tx, userId, now));
}

/**
 * The one definition of an active claim, as a SQL predicate (AAP 0.5.3, 0.5.7): it reads as
 * `"c"."user_id" = <user> AND ("c"."status" IN ('pending_call','calling') OR (<a current verified
 * stay>))`.
 *
 * The caller's `FROM` must join `lodging_claim` as `c`, `lodging` as `l` and `city` as `ci`, with the
 * city reached from the lodging — {@link currentStayPredicate} needs both aliases, and the fixture
 * predicate needs the lodging's alias because a raw read bypasses the guarded client's fixture
 * filter (AAP 0.5.2). This fragment is the single definition of "active" for claim creation, for
 * `MeDto.activeLodgingClaim` and for the leaderboard's guest count, so a claim cannot be active for
 * one reader and not for another.
 */
function activeClaimPredicate(appEnv: AppEnv, userId: string, now: Date): Prisma.Sql {
  return Prisma.sql`"c"."user_id" = ${userId}::uuid
       AND ("c"."status"::text IN (${Prisma.join(ACTIVE_CLAIM_STATUSES)})
            OR (${currentStayPredicate(CLAIM_ALIAS, CITY_ALIAS, now)}))
       AND ${fixturePredicate(appEnv, LODGING_ALIAS)}`;
}

/** Whether the user already holds an active claim, read through {@link activeClaimPredicate}. */
async function hasActiveClaim(
  tx: DbTx,
  appEnv: AppEnv,
  userId: string,
  now: Date,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "c"."id"::text AS "id"
      FROM "lodging_claim" AS "c"
      JOIN "lodging" AS "l" ON "l"."id" = "c"."lodging_id"
      JOIN "city" AS "ci" ON "ci"."id" = "l"."city_id"
     WHERE ${activeClaimPredicate(appEnv, userId, now)}
     LIMIT 1
  `);

  return rows.length > 0;
}

/**
 * Takes the per-user claim-creation lock for the rest of the transaction (AAP 0.5.2).
 *
 * `pg_advisory_xact_lock` is released by the commit or the rollback, never by this file, so the lock
 * cannot outlive the request that took it. The key is `hashtext('lodging-claim:<userId>')`, which
 * makes one traveler's claims serialize while leaving every other traveler's alone; a hash collision
 * would only delay an unrelated claim, never let a second active claim through. The result is cast to
 * `text` so the statement returns a value the driver maps without ambiguity.
 */
async function lockClaimCreation(tx: DbTx, userId: string): Promise<void> {
  await tx.$queryRaw<{ lock: string }[]>(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${CLAIM_LOCK_PREFIX + userId})::bigint)::text AS "lock"
  `);
}

/**
 * A locked `lodging_claim` row, selected `FOR UPDATE`.
 *
 * `status` is cast to `text` in the statement, so the read depends on no PostgreSQL enum type name
 * and PostgreSQL's own enum still guarantees that only a contract value can be stored.
 */
interface LockedClaimRow {
  readonly id: string;
  readonly lodging_id: string;
  readonly status: LodgingClaimStatus;
}

/** A locked `call_task` row, selected `FOR UPDATE`. */
interface LockedTaskRow {
  readonly id: string;
  readonly status: CallTaskStatus;
}

/**
 * Locks one claim of one user, or answers `null` when there is no such row (AAP 0.5.4).
 *
 * Ownership is part of the `WHERE`, so another traveler's claim is indistinguishable from a claim
 * that does not exist: both answer `404 claim_not_found`.
 */
async function lockClaim(
  tx: DbTx,
  claimId: string,
  userId: string,
): Promise<LockedClaimRow | null> {
  const rows = await tx.$queryRaw<LockedClaimRow[]>(Prisma.sql`
    SELECT "c"."id"::text AS "id",
           "c"."lodging_id"::text AS "lodging_id",
           "c"."status"::text AS "status"
      FROM "lodging_claim" AS "c"
     WHERE "c"."id" = ${claimId}::uuid
       AND "c"."user_id" = ${userId}::uuid
       FOR UPDATE
  `);

  return rows[0] ?? null;
}

/**
 * Locks every claim of one user, ordered by id, or answers an empty list (AAP 0.5.3).
 *
 * Ordered by id on purpose: two transactions deleting overlapping sets of claims then acquire them
 * in the same order, so neither can deadlock against the other. The caller locks the tasks next, which
 * is the one order this file and `apps/workers` both keep.
 */
async function lockClaimsOfUser(tx: DbTx, userId: string): Promise<LockedClaimRow[]> {
  return tx.$queryRaw<LockedClaimRow[]>(Prisma.sql`
    SELECT "c"."id"::text AS "id",
           "c"."lodging_id"::text AS "lodging_id",
           "c"."status"::text AS "status"
      FROM "lodging_claim" AS "c"
     WHERE "c"."user_id" = ${userId}::uuid
     ORDER BY "c"."id"
       FOR UPDATE
  `);
}

/**
 * Locks the call tasks of `claimIds`, ordered by id (AAP 0.5.3).
 *
 * Always called after the claims themselves are locked: **`lodging_claim` before `call_task`**, the
 * cross-app contract this file keeps with `apps/workers`' `call-dispatch`, `call-results` and
 * `lodging-claims` jobs. Both sides state it, because a job that took the two in the other order
 * could deadlock against a deletion.
 */
async function lockTasksOfClaims(tx: DbTx, claimIds: readonly string[]): Promise<LockedTaskRow[]> {
  if (claimIds.length === 0) {
    return [];
  }

  return tx.$queryRaw<LockedTaskRow[]>(Prisma.sql`
    SELECT "t"."id"::text AS "id",
           "t"."status"::text AS "status"
      FROM "call_task" AS "t"
     WHERE "t"."lodging_claim_id" = ANY(${[...claimIds]}::uuid[])
     ORDER BY "t"."id"
       FOR UPDATE
  `);
}

/** Whether any of these tasks has an attempt that may genuinely be live (AAP 0.5.3). */
async function hasLiveAttempt(tx: DbTx, taskIds: readonly string[]): Promise<boolean> {
  if (taskIds.length === 0) {
    return false;
  }

  const attempt = await tx.callAttempt.findFirst({
    where: { callTaskId: { in: [...taskIds] }, state: { in: [...LIVE_ATTEMPT_STATES] } },
    select: { id: true },
  });

  return attempt !== null;
}

/**
 * Cancels the tasks that have not produced the claim's result (AAP 0.5.3).
 *
 * Only the outstanding statuses move, and `outcomeAt` is never written: a cancelled task was
 * cancelled, it did not reach an outcome (AAP 0.5.7). Terminal tasks stay terminal even when the
 * deletion happens later, because the status filter is part of the update itself.
 */
async function cancelOutstandingTasks(tx: DbTx, taskIds: readonly string[]): Promise<void> {
  if (taskIds.length === 0) {
    return;
  }

  await tx.callTask.updateMany({
    where: { id: { in: [...taskIds] }, status: { in: [...OUTSTANDING_TASK_STATUSES] } },
    data: { status: 'cancelled' },
  });
}

/**
 * Marks a possibly live call's attempt `superseded` (AAP 0.5.3).
 *
 * The API's voice relay re-reads its task's status and its attempt's `superseded` flag before every
 * turn, speaks the closing template and ends the call, so a call whose claim is being deleted stops
 * at its next turn and `call-results` never applies its result to a deleted claim.
 */
async function supersedeLiveAttempts(tx: DbTx, taskIds: readonly string[]): Promise<void> {
  if (taskIds.length === 0) {
    return;
  }

  await tx.callAttempt.updateMany({
    where: {
      callTaskId: { in: [...taskIds] },
      state: { in: [...LIVE_ATTEMPT_STATES] },
      superseded: false,
    },
    data: { superseded: true },
  });
}

/**
 * The cities whose cached leaderboard a deletion invalidates: those of the lodgings behind the
 * deleted claims that were `verified`, deduplicated (AAP 0.5.7).
 *
 * Read through the guarded client, so a fixture lodging is simply absent outside `test` and `demo` —
 * where it is not listed at all and its cached board therefore cannot be stale (AAP 0.5.2).
 */
async function verifiedClaimCityIds(
  tx: DbTx,
  claims: readonly LockedClaimRow[],
): Promise<string[]> {
  const lodgingIds = [
    ...new Set(
      claims.filter((claim) => claim.status === 'verified').map((claim) => claim.lodging_id),
    ),
  ];

  if (lodgingIds.length === 0) {
    return [];
  }

  const lodgings = await tx.lodging.findMany({
    where: { id: { in: lodgingIds } },
    select: { cityId: true },
  });

  return [...new Set(lodgings.map((lodging) => lodging.cityId))];
}

// ---------------------------------------------------------------------------------------------
// POST /me/lodging-claims (AAP 0.5.4, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * Files a lodging claim for the caller and asks `apps/workers` to verify the stay by phone
 * (AAP 0.5.4 `POST /me/lodging-claims`).
 *
 * The errors are checked in exactly the order AAP 0.5.4 lists them, so a request that breaks two
 * rules is answered with the first one:
 *
 *  1. `400 consent_missing` — the lodging exception was not consented to. The consent is what
 *     discloses that the lodging will learn a guest with this name uses Tablemate (AAP 0.5.8,
 *     0.12.2), so nothing is read or written before it is given; the check is pure and runs outside
 *     the transaction.
 *  2. `400 booking_name_empty` — the booking name is empty after trimming. Also pure.
 *  3. `404 lodging_not_found` — no such lodging, a fixture outside `test` and `demo` (the guarded
 *     client filters it, AAP 0.5.2), or one that has left the OpenStreetMap directory
 *     (`osmMissingAt` set, AAP 0.5.6).
 *  4. `403 no_valid_proof` — the caller holds no proof valid now, with the city preference of
 *     {@link proofForLodging}.
 *  5. `409 active_claim_exists` — an active claim of the caller's already exists.
 *  6. `422 claim_dates_invalid` — the stay is reversed or falls outside the proof's dates.
 *  7. `422 lodging_other_city` — the lodging is not in the proof's city.
 *
 * Checks 3 to 7 run inside one fenced transaction, behind the per-user advisory lock, because the
 * active-claim rule depends on `stayTo` and no index can enforce it (AAP 0.5.2). The insert, the
 * `create_call_task` outbox row and the `lodging_claim_submitted` event commit together, so the
 * worker is told to verify exactly the claims that exist, and nothing is announced for a claim that
 * rolled back. The verification task itself, its 72-hour expiry timer and the operator-queue routing
 * for a lodging with no callable number belong to `apps/workers` (AAP 0.5.3, 0.5.6).
 *
 * The booking name and reference are encrypted before the insert and never logged.
 *
 * @param services - The app's services: the guarded client, the injected clock, the keyring, the
 *   logger and the outbox dispatcher.
 * @param userId - The authenticated caller, and the claim's owner.
 * @param body - The validated `LodgingClaimRequest`.
 * @returns The new claim's id and its initial status, which the route answers `201` with.
 * @throws AppError one of the seven codes above.
 * @see AAP 0.5.7 for the claim rules, 0.5.2 for the advisory lock and the encryption, 0.5.3 for the
 *   claim lifecycle, 0.5.4 for the route and its error order.
 */
export async function createClaim(
  services: AppServices,
  userId: string,
  body: LodgingClaimRequest,
): Promise<LodgingClaimCreated> {
  if (body.callConsent !== true) {
    throw new AppError('consent_missing');
  }

  const bookingName = body.bookingName.trim();
  if (bookingName.length === 0) {
    throw new AppError('booking_name_empty');
  }

  const bookingReference = body.bookingReference?.trim();
  const now = services.clock.now();
  const appEnv = services.env.APP_ENV;

  const created = await transact(
    services,
    async (tx) => {
      await lockClaimCreation(tx, userId);

      const lodging = await tx.lodging.findFirst({
        where: { id: body.lodgingId, osmMissingAt: null },
        select: { id: true, cityId: true },
      });
      if (lodging === null) {
        throw new AppError('lodging_not_found');
      }

      const proof = await proofForLodging(tx, userId, lodging.cityId, now);
      if (proof === null) {
        throw new AppError('no_valid_proof');
      }

      if (await hasActiveClaim(tx, appEnv, userId, now)) {
        throw new AppError('active_claim_exists');
      }

      if (!stayWithinProof(body.stayFrom, body.stayTo, proof)) {
        throw new AppError('claim_dates_invalid');
      }

      if (lodging.cityId !== proof.cityId) {
        throw new AppError('lodging_other_city');
      }

      const claim = await tx.lodgingClaim.create({
        data: {
          userId,
          lodgingId: lodging.id,
          stayFrom: dateColumn(body.stayFrom),
          stayTo: dateColumn(body.stayTo),
          bookingNameCiphertext: encryptField(services.keyring, bookingName),
          bookingReferenceCiphertext:
            bookingReference === undefined || bookingReference.length === 0
              ? null
              : encryptField(services.keyring, bookingReference),
          callConsentAt: now,
          status: 'pending_call',
        },
        select: { id: true },
      });

      await writeOutbox(tx, 'create_call_task', { lodgingClaimId: claim.id });
      await emit(tx, services, 'lodging_claim_submitted', userId, { cityId: lodging.cityId });

      return { claimId: claim.id, lodgingId: lodging.id };
    },
    { fenceUserId: userId },
  );

  // Logged after the commit: the line names a claim that exists. Never the booking name, the
  // reference or the stay dates (AAP 0.11.1).
  services.logger.info(
    { event: 'lodging_claim_created', claimId: created.claimId, lodgingId: created.lodgingId },
    'lodging_claim_created',
  );

  return { claimId: created.claimId, status: 'pending_call' };
}

// ---------------------------------------------------------------------------------------------
// GET and DELETE /me/lodging-claims/:id (AAP 0.5.3, 0.5.4)
// ---------------------------------------------------------------------------------------------

/**
 * The caller's own claim as it now stands (AAP 0.5.4 `GET /me/lodging-claims/:id`).
 *
 * Ownership is part of the query, so another traveler's claim is answered exactly like a claim that
 * does not exist: `404 claim_not_found`, never a hint that the id is real. The response carries the
 * status and, once the claim has reached `verified`, `rejected` or `unreachable`, the instant it did;
 * the booking name and reference are not part of the contract and are never read here (AAP 0.5.2).
 *
 * A plain read: it opens no transaction, takes no lock and changes nothing.
 *
 * @param services - The app's services, read for the guarded client alone.
 * @param userId - The authenticated caller.
 * @param claimId - The claim to read, as a UUID from the route's schema.
 * @returns The claim's status and resolution instant.
 * @throws AppError `claim_not_found` (404) when the caller holds no such claim.
 */
export async function getClaim(
  services: AppServices,
  userId: string,
  claimId: string,
): Promise<LodgingClaimStatusDto> {
  const row = await services.db.lodgingClaim.findFirst({
    where: { id: claimId, userId },
    select: { status: true, resolvedAt: true },
  });

  if (row === null) {
    throw new AppError('claim_not_found');
  }

  return { status: row.status, resolvedAt: row.resolvedAt?.toISOString() ?? null };
}

/**
 * Deletes the caller's claim, with its booking details and its verification work (AAP 0.5.3,
 * 0.5.4 `DELETE /me/lodging-claims/:id`).
 *
 * The claim row is locked first and its call tasks next, the one order this file and `apps/workers`
 * keep. Then:
 *
 *  - `409 call_in_progress` when one of the claim's attempts is still in a state in which a call may
 *    genuinely be live. The claim is `calling` exactly while such an attempt exists, so this is the
 *    one refusal that protects a real phone call; the traveler can delete the claim the moment it
 *    ends, and account deletion is not subject to it (AAP 0.5.3, `deleteClaimsForAccount`).
 *  - Every task that has not produced the claim's result is `cancelled`; terminal tasks stay
 *    terminal.
 *  - The claim row is deleted, which takes the booking ciphertext with it, cascades the
 *    `LodgingVisibility` row and nulls the cancelled tasks' `lodging_claim_id` (the schema's
 *    `onDelete: SetNull` and `Cascade`), so no route can read the deleted claim's details afterwards.
 *  - A deleted `verified` claim changes the lodging's live verified-guest count, so its city's cached
 *    leaderboard is dropped — after the commit, through the transaction's `after` hook, so a rollback
 *    cannot leave a cold cache behind a change that never happened, and a Redis failure cannot fail
 *    the deletion (AAP 0.3.2, 0.5.7). The `LodgingActivityFact` rows are untouched, so historical
 *    standings do not move (AAP 0.5.2).
 *
 * The write runs in one fenced transaction: a deletion racing `DELETE /me` is serialized with it, so
 * neither can leave a half-deleted set of claims (AAP 0.5.3).
 *
 * @param services - The app's services: the guarded client, the injected clock, the logger, the
 *   outbox dispatcher and the Redis connection the cache invalidation uses.
 * @param userId - The authenticated caller, and the claim's owner.
 * @param claimId - The claim to delete.
 * @throws AppError `claim_not_found` (404) when the caller holds no such claim, `call_in_progress`
 *   (409) while one of its calls may be live.
 */
export async function deleteClaim(
  services: AppServices,
  userId: string,
  claimId: string,
): Promise<void> {
  await transact(
    services,
    async (tx, after) => {
      const claim = await lockClaim(tx, claimId, userId);
      if (claim === null) {
        throw new AppError('claim_not_found');
      }

      const tasks = await lockTasksOfClaims(tx, [claim.id]);
      const taskIds = tasks.map((task) => task.id);

      if (await hasLiveAttempt(tx, taskIds)) {
        throw new AppError('call_in_progress');
      }

      await cancelOutstandingTasks(tx, taskIds);

      // Read before the delete, because the row that names the city is about to go.
      const cityIds = await verifiedClaimCityIds(tx, [claim]);

      await tx.lodgingClaim.delete({ where: { id: claim.id } });

      for (const cityId of cityIds) {
        after(async () => {
          await invalidateLeaderboard(services, cityId);
        });
      }
    },
    { fenceUserId: userId },
  );

  services.logger.info({ event: 'lodging_claim_deleted', claimId }, 'lodging_claim_deleted');
}

/**
 * Deletes every lodging claim of an account, cancelling its verification work (AAP 0.5.3).
 *
 * Called by `me/deletion.ts` **inside** its own transaction, which already holds `SELECT … FOR UPDATE`
 * on the user row: this function therefore opens no transaction of its own and takes no fence. It
 * locks the account's claims and then their call tasks, the same order {@link deleteClaim} takes.
 *
 * It differs from the user-facing {@link deleteClaim} in the one place AAP 0.5.3 requires: a claim in
 * `calling` is deleted too, rather than answered `409 call_in_progress`. The verification task is
 * cancelled and its possibly live attempt is marked `superseded`, which is the signal the API's voice
 * relay reads before every turn to speak its closing line and end the call, and which keeps
 * `call-results` from applying that call's result to a claim that no longer exists. Only attempts that
 * did not produce a result are superseded, and a terminal task is left exactly as it stands.
 *
 * The claims' ciphertext goes with the rows. The caller registers the leaderboard invalidations it
 * needs by passing its own `after`: the commit that makes the deletion durable is the caller's, so the
 * cache can only be dropped from its transaction's hook (AAP 0.3.2).
 *
 * @param tx - The account-deletion transaction, whose client this function must use.
 * @param services - The app's services, read for the logger and the Redis connection the invalidation
 *   uses.
 * @param userId - The account being deleted.
 * @param after - The deletion transaction's `after` hook. When supplied, each city whose lodgings lost
 *   a `verified` claim is registered for invalidation; omit it in a caller that has no hook.
 * @returns The deleted claim ids and the cities whose cached leaderboards changed.
 */
export async function deleteClaimsForAccount(
  tx: DbTx,
  services: AppServices,
  userId: string,
  after?: AfterCommit,
): Promise<DeletedClaims> {
  const claims = await lockClaimsOfUser(tx, userId);
  if (claims.length === 0) {
    return { claimIds: [], cityIds: [] };
  }

  const claimIds = claims.map((claim) => claim.id);
  const tasks = await lockTasksOfClaims(tx, claimIds);
  const taskIds = tasks.map((task) => task.id);

  await cancelOutstandingTasks(tx, taskIds);
  await supersedeLiveAttempts(tx, taskIds);

  const cityIds = await verifiedClaimCityIds(tx, claims);

  await tx.lodgingClaim.deleteMany({ where: { id: { in: claimIds } } });

  if (after !== undefined) {
    for (const cityId of cityIds) {
      after(async () => {
        await invalidateLeaderboard(services, cityId);
      });
    }
  }

  return { claimIds, cityIds };
}

// ---------------------------------------------------------------------------------------------
// MeDto.activeLodgingClaim (AAP 0.5.3, 0.5.4)
// ---------------------------------------------------------------------------------------------

/** One row of the active-claim read, as {@link activeClaimFor} selects it. */
interface ActiveClaimRow {
  readonly id: string;
  readonly lodging_id: string;
  readonly lodging_name: string;
  readonly status: LodgingClaimStatus;
  readonly stay_from: Date;
  readonly stay_to: Date;
  readonly show_staying: boolean;
}

/**
 * The caller's active claim, or `null` (AAP 0.5.4 `GET /me`).
 *
 * "Active" is the one definition of {@link activeClaimPredicate}: `pending_call`, `calling`, or
 * `verified` with the stay not yet over in the lodging's city time. `me/profile.ts` reads this, so
 * the meaning of active lives here alone and the profile, the claim rules and the leaderboard cannot
 * drift apart (AAP 0.5.3, 0.5.7).
 *
 * The shape is `MeDto.activeLodgingClaim` exactly, with the stay dates as `YYYY-MM-DD` and the
 * visibility the caller set (`showStaying` from `LodgingVisibility`, false when the caller has no row
 * for this claim). The booking name, the reference and the verification transcript are deliberately
 * absent: nothing in this response can disclose a booking (AAP 0.5.2).
 *
 * A plain read: no transaction, no lock, nothing written.
 *
 * @param services - The app's services: the guarded client, the injected clock and the process's
 *   environment, which decides fixture visibility.
 * @param userId - The authenticated caller.
 * @returns The active claim, or `null` when the caller has none.
 */
export async function activeClaimFor(
  services: AppServices,
  userId: string,
): Promise<ActiveLodgingClaim | null> {
  const now = services.clock.now();

  const rows = await services.db.$queryRaw<ActiveClaimRow[]>(Prisma.sql`
    SELECT "c"."id"::text AS "id",
           "c"."lodging_id"::text AS "lodging_id",
           "l"."name" AS "lodging_name",
           "c"."status"::text AS "status",
           "c"."stay_from" AS "stay_from",
           "c"."stay_to" AS "stay_to",
           COALESCE("v"."show_staying", false) AS "show_staying"
      FROM "lodging_claim" AS "c"
      JOIN "lodging" AS "l" ON "l"."id" = "c"."lodging_id"
      JOIN "city" AS "ci" ON "ci"."id" = "l"."city_id"
      LEFT JOIN "lodging_visibility" AS "v" ON "v"."lodging_claim_id" = "c"."id"
     WHERE ${activeClaimPredicate(services.env.APP_ENV, userId, now)}
     ORDER BY "c"."created_at" DESC, "c"."id" DESC
     LIMIT 1
  `);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  // Field by field, never a spread of the row: a column added to `lodging_claim` cannot reach a
  // response (AAP 0.5.4).
  return {
    id: row.id,
    lodgingId: row.lodging_id,
    lodgingName: row.lodging_name,
    status: row.status,
    stayFrom: isoDateColumn(row.stay_from),
    stayTo: isoDateColumn(row.stay_to),
    showStaying: row.show_staying,
  };
}
