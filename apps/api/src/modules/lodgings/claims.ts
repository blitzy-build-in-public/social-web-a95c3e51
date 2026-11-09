/**
 * Lodging claims: what a traveler files to have a stay verified by phone, and the routes built on it —
 * `POST /me/lodging-claims`, `GET /me/lodging-claims/:id` and `DELETE /me/lodging-claims/:id`, plus {@link activeClaimFor}
 * for `MeDto.activeLodgingClaim` and {@link deleteClaimsForAccount}, which `DELETE /me` calls inside its user transaction.
 *
 * A claim row carries the stay dates, the booking name and reference encrypted (AES-256-GCM through `encryptField`) and the
 * consent that disclosed the lodging exception before it was given.
 *
 * Four invariants hold throughout: the caller's proof decides everything, so a claim requires a valid proof and the stay must
 * lie inside the proof's own dates in the proof's city; one active claim per user, checked inside the inserting transaction
 * behind `pg_advisory_xact_lock(hashtext('lodging-claim:<userId>'))`; booking details are write-only here, encrypted before the
 * insert and never decrypted, logged or returned, with the workers erasing the ciphertext on the first hourly `data-expiry`
 * run after a terminal state; and locks are taken claim row first, then the claim's call-task rows (`lodging_claim` →
 * `call_task`), the order the workers' jobs observe too, so neither can deadlock.
 *
 * Every write runs in one `transact`, fenced on the acting user, so a mutation racing `DELETE /me` commits before it or is
 * refused; the outbox row and the analytics event are written in that same transaction, and the leaderboard cache is dropped
 * only after it commits.
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

// Type-only: `app.ts` is the one declaration of the app's type, erased at compile time.
import type { AppServices } from '../../app.ts';

/**
 * The two statuses in which a claim is active whatever its dates: `pending_call` and `calling`. Every other status is
 * terminal, and a terminal claim stays terminal. The workers' `lodging-claims` job applies the same list, checked against
 * `LodgingClaimStatus`, so the two cannot drift.
 */
const ACTIVE_CLAIM_STATUSES = [
  'pending_call',
  'calling',
] as const satisfies readonly LodgingClaimStatus[];

/**
 * The call-task statuses a deleted or expired claim cancels: a task that has not produced the claim's result. `completed`,
 * `refused`, `do_not_call` and `cancelled` are terminal and are left exactly as they stand.
 */
const OUTSTANDING_TASK_STATUSES = [
  'queued',
  'in_progress',
  'needs_review',
  'unreachable',
] as const satisfies readonly CallTaskStatus[];

/**
 * The attempt states in which a call may genuinely be live: a claim is `calling` exactly while one of its attempts is in one of
 * these, which is why `DELETE /me/lodging-claims/:id` answers `409 call_in_progress` for them, and why account deletion marks
 * them `superseded`, the signal the voice relay reads before its closing line.
 */
const LIVE_ATTEMPT_STATES = [
  'dispatching',
  'dispatch_unknown',
  'dialing',
  'in_progress',
] as const satisfies readonly CallAttemptState[];

/** The advisory-lock key prefix for one user's claim creation, `lodging-claim:<userId>`: the lock is per user, so two travelers
 * filing claims at the same moment never serialize against each other. */
const CLAIM_LOCK_PREFIX = 'lodging-claim:';

const CLAIM_ALIAS = 'c';

const CITY_ALIAS = 'ci';

const LODGING_ALIAS = 'l';

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The caller's active lodging claim as `GET /me` reports it: exactly `MeDto.activeLodgingClaim`, so the contract and this read
 * cannot drift apart. */
export type ActiveLodgingClaim = NonNullable<MeDto['activeLodgingClaim']>;

/** What {@link deleteClaimsForAccount} deleted, for the account transaction that called it: the claims themselves, and the
 * cities whose leaderboards the deletion changed. */
export interface DeletedClaims {
  readonly claimIds: string[];
  /**
   * The cities holding a lodging whose *verified* claim was deleted, deduplicated. Only these need their cached leaderboard
   * dropped: the live verified-guest count changed for them, while the `LodgingActivityFact` rows behind the score are
   * untouched, so historical standings never move.
   */
  readonly cityIds: string[];
}

/**
 * The shared `DateOnly` schema checks the spelling, not the calendar: `2026-02-30` would be rolled over by JavaScript's `Date`
 * to 2 March, storing a stay the traveler never asked for. The round-trip through `Date.UTC` rejects exactly those.
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

function dateColumn(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function isoDateColumn(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Whether the requested stay lies inside the proof's own dates: both dates must be real calendar dates, the first must not be
 * after the second, and the stay must be covered by the proof. The comparison is lexicographic on zero-padded `YYYY-MM-DD`
 * strings, which is chronological order.
 */
function stayWithinProof(stayFrom: string, stayTo: string, proof: ProofSummary): boolean {
  if (!isCalendarDate(stayFrom) || !isCalendarDate(stayTo)) {
    return false;
  }
  return stayFrom <= stayTo && stayFrom >= proof.arrivalDate && stayTo <= proof.departureDate;
}

/**
 * The proof a claim is filed against: the caller's valid proof for the lodging's city when one exists, otherwise the caller's
 * latest valid proof in any city, so the city mismatch is answered by its own error rather than as a missing proof.
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
 * The one definition of an active claim, as a SQL predicate: it reads as
 * `"c"."user_id" = <user> AND ("c"."status" IN ('pending_call','calling') OR (<a current verified stay>))`.
 *
 * The caller's `FROM` must join `lodging_claim` as `c`, `lodging` as `l` and `city` as `ci`, with the city reached from the
 * lodging: {@link currentStayPredicate} needs both aliases, and the fixture predicate needs the lodging's alias because a raw
 * read bypasses the guarded client's fixture filter. This fragment is the single definition of "active" for claim creation, for
 * `MeDto.activeLodgingClaim` and for the leaderboard's guest count.
 */
function activeClaimPredicate(appEnv: AppEnv, userId: string, now: Date): Prisma.Sql {
  return Prisma.sql`"c"."user_id" = ${userId}::uuid
       AND ("c"."status"::text IN (${Prisma.join(ACTIVE_CLAIM_STATUSES)})
            OR (${currentStayPredicate(CLAIM_ALIAS, CITY_ALIAS, now)}))
       AND ${fixturePredicate(appEnv, LODGING_ALIAS)}`;
}

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
 * Takes the per-user claim-creation lock for the rest of the transaction.
 *
 * `pg_advisory_xact_lock` is released by the commit or the rollback, never by this file, so the lock cannot outlive the request
 * that took it; the key makes one traveler's claims serialize while leaving every other traveler's alone. The result is cast to
 * `text` so the statement returns a value the driver maps without ambiguity.
 */
async function lockClaimCreation(tx: DbTx, userId: string): Promise<void> {
  await tx.$queryRaw<{ lock: string }[]>(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${CLAIM_LOCK_PREFIX + userId})::bigint)::text AS "lock"
  `);
}

interface LockedClaimRow {
  readonly id: string;
  readonly lodging_id: string;
  readonly status: LodgingClaimStatus;
}

interface LockedTaskRow {
  readonly id: string;
  readonly status: CallTaskStatus;
}

/** Locks one claim of one user, or answers `null` when there is no such row: ownership is part of the `WHERE`, so another
 * traveler's claim is indistinguishable from a claim that does not exist. */
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
 * Locks every claim of one user, ordered by id, or answers an empty list. Ordered by id on purpose: two transactions deleting
 * overlapping sets of claims acquire them in the same order, so neither can deadlock. The caller locks the tasks next.
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
 * Always called after the claims themselves are locked: **`lodging_claim` before `call_task`**, the cross-app contract this file
 * keeps with the workers' jobs. Both sides state it, because a job that took the two in the other order could deadlock against a
 * deletion.
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
 * Cancels the tasks that have not produced the claim's result. Only the outstanding statuses move, and `outcomeAt` is never
 * written: a cancelled task was cancelled, it did not reach an outcome. Terminal tasks stay terminal, because the status filter
 * is part of the update itself.
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
 * Marks a possibly live call's attempt `superseded`. The voice relay re-reads its task's status and its attempt's `superseded`
 * flag before every turn and ends the call, so a call whose claim is being deleted stops at its next turn.
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
 * The cities whose cached leaderboard a deletion invalidates: those of the lodgings behind the deleted claims that were
 * `verified`, deduplicated. Read through the guarded client, so a fixture lodging is absent outside `test` and `demo`.
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

/**
 * Files a lodging claim for the caller and asks the workers to verify the stay by phone.
 *
 * The errors are checked in exactly the order AAP 0.5.4 lists them, so a request that breaks two rules is answered with the
 * first one:
 *
 *  1. `400 consent_missing` — the lodging exception was not consented to, the disclosure that the lodging will learn a guest
 *     with this name uses Tablemate. Nothing is read or written before it is given.
 *  2. `400 booking_name_empty` — the booking name is empty after trimming.
 *  3. `404 lodging_not_found` — no such lodging, a fixture outside `test` and `demo`, or one that has left the OpenStreetMap
 *     directory (`osmMissingAt` set).
 *  4. `403 no_valid_proof` — the caller holds no proof valid now, with the city preference of {@link proofForLodging}.
 *  5. `409 active_claim_exists` — an active claim of the caller's already exists.
 *  6. `422 claim_dates_invalid` — the stay is reversed or falls outside the proof's dates.
 *  7. `422 lodging_other_city` — the lodging is not in the proof's city.
 *
 * Checks 3 to 7 run inside one fenced transaction, behind the per-user advisory lock, because the active-claim rule depends on
 * `stayTo` and no index can enforce it. The insert, the `create_call_task` outbox row and the `lodging_claim_submitted` event
 * commit together. The verification task itself and its 72-hour expiry timer belong to the workers. The booking name and
 * reference are encrypted before the insert and never logged.
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

/**
 * The caller's own claim as it now stands.
 *
 * Ownership is part of the query, so another traveler's claim is answered exactly like a claim that does not exist:
 * `404 claim_not_found`, never a hint that the id is real. The response carries the status and, once the claim has reached
 * `verified`, `rejected` or `unreachable`, the instant it did — the `resolvedAt` key is absent until then; the booking name and
 * reference are never read here.
 *
 * A plain read: it opens no transaction, takes no lock and changes nothing.
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
  const resolvedAt = row.resolvedAt?.toISOString();
  // The key is absent while the claim is unresolved and holds the instant once it is (AAP 0.5.4).
  return resolvedAt === undefined ? { status: row.status } : { status: row.status, resolvedAt };
}

/**
 * Deletes the caller's claim, with its booking details and its verification work. The claim row is locked first and its call
 * tasks next, the one order this file and the workers keep. Then:
 *
 *  - `409 call_in_progress` when one of the claim's attempts is still in a state in which a call may genuinely be live. The
 *    claim is `calling` exactly while such an attempt exists, so this is the one refusal that protects a real phone call;
 *    account deletion is not subject to it.
 *  - Every task that has not produced the claim's result is `cancelled`; terminal tasks stay terminal.
 *  - The claim row is deleted, which takes the booking ciphertext with it, cascades the `LodgingVisibility` row and nulls the
 *    cancelled tasks' `lodging_claim_id` (the schema's `onDelete: SetNull` and `Cascade`).
 *  - A deleted `verified` claim changes the lodging's live verified-guest count, so its city's cached leaderboard is dropped
 *    after the commit, through the transaction's `after` hook. The `LodgingActivityFact` rows are untouched.
 *
 * The write runs in one fenced transaction: a deletion racing `DELETE /me` is serialized with it, so neither can leave a
 * half-deleted set of claims.
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
 * Deletes every lodging claim of an account, cancelling its verification work.
 *
 * Called by `me/deletion.ts` **inside** its own transaction, which already holds `SELECT … FOR UPDATE` on the user row: this
 * function therefore opens no transaction of its own and takes no fence. It locks the account's claims and then their call
 * tasks, the same order {@link deleteClaim} takes.
 *
 * It differs from the user-facing {@link deleteClaim} in the one place AAP 0.5.3 requires: a claim in `calling` is deleted too,
 * rather than answered `409 call_in_progress`. The verification task is cancelled and its possibly live attempt is marked
 * `superseded`, which keeps `call-results` from applying that call's result to a claim that no longer exists.
 *
 * The caller registers the leaderboard invalidations it needs by passing its own `after`, because the commit that makes the
 * deletion durable is the caller's.
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
 * The caller's active claim, or `null`.
 *
 * "Active" is the one definition of {@link activeClaimPredicate}: `pending_call`, `calling`, or `verified` with the stay not
 * yet over in the lodging's city time. `me/profile.ts` reads this, so the meaning of active lives here alone.
 *
 * The shape is `MeDto.activeLodgingClaim` exactly, with the stay dates as `YYYY-MM-DD` and the visibility the caller set
 * (`showStaying` from `LodgingVisibility`, false when the caller has no row for this claim). The booking name, the reference
 * and the verification transcript are deliberately absent. A plain read: no transaction, no lock, nothing written.
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
