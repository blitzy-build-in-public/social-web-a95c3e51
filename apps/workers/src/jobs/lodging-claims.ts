/**
 * The `lodging-claims` queue: claim resolution, claim expiry and stay expiry (AAP 0.5.3, 0.5.6).
 *
 * Three behaviours live here, and no fourth:
 *
 * - {@link resolveClaim} applies one terminal outcome to a claim whose row the caller locked:
 *   `verified`, `rejected` or `unreachable`. It is what `call-results` calls once a lodging call has
 *   produced an answer (AAP 0.3.2: "`workers` applies that result to the call task and the claim"),
 *   and the operator's resolution and the 72-hour expiry call the same function, so a resolution's
 *   side effects are written once: the guarded status change, the cancellation of the verification
 *   work still outstanding, the leaderboard facts a verified stay backfills, the analytics event the
 *   dashboard's claim measures count, and the claimant's notification (AAP 0.5.2, 0.5.7).
 * - `claim-expire` carries `{ claimId }` and runs 72 hours after the claim was created: a claim that
 *   is still unresolved becomes `unreachable` with no penalty, and its verification task is
 *   cancelled (AAP 0.5.3).
 * - `stay-expiry` carries `{ cityId }` and runs daily at 00:05 local: every `showStaying` a verified
 *   claim can no longer justify is turned off, and any claim of the city still open past its 72
 *   hours is expired as well, as a backstop for a lost `claim-expire` job (AAP 0.5.3, 0.1.1).
 *
 * Four rules hold throughout. Time comes from the injected clock and never from the wall clock, and
 * city-local reasoning goes through `localDateKey` (AAP 0.11.1). Every raw statement that reads
 * `lodging` or `venue` carries {@link fixturePredicate}, because raw SQL bypasses the guarded
 * client's fixture filter (AAP 0.5.2). Every write is guarded on the status it expects, so a second
 * run of the same job leaves the same state (AAP 0.3.2). And nothing here calls a third party: a
 * resolution touches PostgreSQL alone.
 *
 * The leaderboard rule of AAP 0.5.7 that {@link backfillActivityFacts} implements is stated once,
 * in `@tablemate/db` (`coveringMeetupStatement`): `workers` must not import `@tablemate/api`, so
 * that statement lives in the package both processes already depend on, and the API's
 * `recordActivityForVerifiedClaim` runs that same one statement — which is what makes drift
 * impossible rather than merely forbidden (AAP 0.3.2, 0.5.7, 0.8.1).
 *
 * @see AAP 0.5.3 for the lodging-claim lifecycle and the 72-hour expiry, 0.5.6 for the job table and
 *   the 00:05 local schedule, 0.5.7 for the leaderboard and lodging-visibility rules, 0.5.2 for
 *   `LodgingActivityFact`, `AnalyticsEvent` and the booking-detail retention, 0.8.1 for this file.
 */

import {
  Prisma,
  coveringMeetupStatement,
  fixturePredicate,
  type CoveringMeetupRow,
  type DbTx,
} from '@tablemate/db';
import {
  JOB,
  QUEUE,
  QueuePayloadError,
  actorHash,
  isJobName,
  localDateKey,
  pairKey,
  parseJobData,
} from '@tablemate/server-core';
import {
  AnalyticsProps,
  CLAIM_EXPIRY_HOURS,
  DAY_MS,
  HOUR_MS,
  LEADERBOARD_WINDOW_DAYS,
} from '@tablemate/shared';
import type {
  CallAttemptState,
  CallTaskKind,
  CallTaskStatus,
  LodgingClaimStatus,
  OperatorClaimOutcome,
} from '@tablemate/shared';

import { writeNotificationOutbox } from './notifications.ts';
// Type-only on purpose: `queues.ts` value-imports this file's `process`, so a value import back
// would close a runtime cycle. A type-only import is erased on emit.
import type { WorkerContext } from '../queues.ts';

// ---------------------------------------------------------------------------------------------
// The rules, as values (AAP 0.5.3, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * The two statuses a claim may still leave: `pending_call` and `calling`. Every other status is
 * terminal, and a terminal claim stays terminal (AAP 0.5.3).
 */
const ACTIVE_CLAIM_STATUSES = [
  'pending_call',
  'calling',
] as const satisfies readonly LodgingClaimStatus[];

/** How long an unresolved claim may live: 72 hours from its creation (AAP 0.5.3). */
const CLAIM_EXPIRY_MS = CLAIM_EXPIRY_HOURS * HOUR_MS;

/** The leaderboard's activity window in milliseconds: the last 90 days (AAP 0.5.7). */
const LEADERBOARD_WINDOW_MS = LEADERBOARD_WINDOW_DAYS * DAY_MS;

/**
 * The task statuses that are still outstanding, so a resolution cancels them: a task that is
 * `queued`, `in_progress`, `needs_review` or `unreachable` has not produced the claim's result
 * (AAP 0.5.3).
 */
const OUTSTANDING_TASK_STATUSES = [
  'queued',
  'in_progress',
  'needs_review',
  'unreachable',
] as const satisfies readonly CallTaskStatus[];

/**
 * The attempt states in which a call may genuinely be live, so a cancelled task's attempt is
 * superseded: the API relay checks its task before every turn and speaks its closing line
 * (AAP 0.5.3).
 */
const LIVE_ATTEMPT_STATES = [
  'dispatching',
  'dispatch_unknown',
  'dialing',
  'in_progress',
] as const satisfies readonly CallAttemptState[];

/** The one task kind that verifies a claim (AAP 0.5.6). */
const LODGING_VERIFICATION_KIND: CallTaskKind = 'lodging_stay_verification';

/**
 * Most claims one `stay-expiry` run expires. The backstop is a safety net for a lost
 * `claim-expire` job rather than the normal path, so a single run bounds its work and the next
 * daily run continues where it stopped.
 */
const STALE_CLAIM_BATCH = 200;

// ---------------------------------------------------------------------------------------------
// Types (AAP 0.5.3, 0.5.6)
// ---------------------------------------------------------------------------------------------

/**
 * A claim as {@link resolveClaim} needs it: the row's identity, its owner, the lodging it claims
 * and the instant it was created.
 *
 * `stayFrom` and `stayTo` are the two dates the leaderboard backfill reads. A caller that already
 * holds the claim row passes them; when they are absent, {@link stayDates} reads them from the
 * row inside the caller's transaction, so a caller that selected only the identity fields works
 * unchanged.
 */
export interface ResolvableClaim {
  readonly id: string;
  readonly userId: string;
  readonly lodgingId: string;
  readonly createdAt: Date;
  /** First day of the stay, when the caller holds it. */
  readonly stayFrom?: Date;
  /** Last day of the stay, when the caller holds it. */
  readonly stayTo?: Date;
}

/** What {@link resolveClaim} accepts beyond the claim and the outcome. */
export interface ResolveClaimOptions {
  /**
   * The verification task that produced this outcome, when one did. It is never cancelled and never
   * superseded — AAP 0.5.3: "Only attempts that did not produce the result are ever superseded" —
   * and its own status is the caller's to set, in the same transaction.
   */
  readonly byTaskId?: string;
}

/** What one `claim-expire` run reports (AAP 0.5.3). */
export interface ClaimExpireResult {
  /** Whether this run moved the claim to `unreachable`. */
  readonly expired: boolean;
  /** True when the job ran before the claim's 72 hours were up, so the run was a no-op. */
  readonly early?: boolean;
}

/** What one `stay-expiry` run reports (AAP 0.5.3). */
export interface StayExpiryResult {
  /** How many `showStaying` flags the run turned off. */
  readonly hidden: number;
  /** How many stale claims the backstop moved to `unreachable`. */
  readonly expired: number;
}

/** What one run of this queue's processor reports. */
export type LodgingClaimsResult = ClaimExpireResult | StayExpiryResult;

/**
 * The `lodging-claims` job as a processor receives it: a structural subset of BullMQ's `Job`, so a
 * test can call {@link process} with a plain object.
 */
export interface LodgingClaimsJob {
  /** BullMQ's job id — `claim-expire-<claimId>`, the stable id of AAP 0.3.2. */
  readonly id?: string;
  /** The job name: `claim-expire` or `stay-expiry`. */
  readonly name: string;
  /** The job's data, held by the queue's schema to `{ claimId }` or `{ cityId }`. */
  readonly data: unknown;
}

/** One row of the claim lock: the fields {@link resolveClaim} and the expiry run read. */
interface LockedClaimRow {
  readonly id: string;
  readonly user_id: string;
  readonly lodging_id: string;
  readonly status: LodgingClaimStatus;
  readonly created_at: Date;
  readonly stay_from: Date;
  readonly stay_to: Date;
}

/** The two calendar dates of a stay, in the one spelling the SQL casts accept. */
interface StayDates {
  readonly from: string;
  readonly to: string;
}

/** What one locked attempt to expire a claim found; the four cases {@link expireLockedClaim} tells apart. */
type ClaimExpiry = 'missing' | 'terminal' | 'early' | 'expired';

// ---------------------------------------------------------------------------------------------
// Resolving a claim (AAP 0.5.3, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * Applies a terminal outcome to a claim, or does nothing when the claim has already left its
 * active state (AAP 0.5.3).
 *
 * The caller holds the claim's row lock (`SELECT … FROM "lodging_claim" WHERE id = … FOR UPDATE`)
 * inside `tx`, which is what makes a resolution and every other writer of that claim serialize: the
 * guarded `updateMany` below is the claim's own transition, and a claim that is not `pending_call`
 * or `calling` returns `false` with no effect at all. Terminal claims stay terminal, and
 * `call-results` refuses to change one (AAP 0.5.3).
 *
 * A resolution that does apply the outcome writes five things in the caller's transaction, so all
 * of them commit with the status change or none does:
 *
 * 1. Every outstanding verification task of the claim is cancelled, and each of their possibly live
 *    attempts is marked `superseded`. The task named in `opts.byTaskId` — the one that produced
 *    this result — is left untouched, and a cancelled task keeps its `outcomeAt`: `cancelled` is a
 *    lifecycle state, not an outcome (AAP 0.5.3, 0.5.7).
 * 2. On `verified`, {@link backfillActivityFacts} credits the lodging's leaderboard with the
 *    completed meetups of the stay.
 * 3. An `AnalyticsEvent` named `lodging_claim_resolved`, carrying the outcome and how long the
 *    claim took to resolve. These events are the only source of the dashboard's claim measures and
 *    survive erasure unlinked (AAP 0.5.2, 0.5.7).
 * 4. The claimant's `lodging_claim_resolved` notification, as an outbox row in this transaction, so
 *    the message and the state it describes commit together (AAP 0.3.2).
 * 5. A log line naming the claim and the outcome and nothing else: never the booking name,
 *    reference, stay dates or phone number (AAP 0.11.1).
 *
 * @param tx - The caller's transaction, already holding the claim row lock.
 * @param ctx - The worker context: `env.ANALYTICS_SALT` keys the actor hash and the pair hash, the
 *   injected clock stamps the outcome, and the logger records it.
 * @param claim - The claim being resolved: its id, owner, lodging, creation instant and, when the
 *   caller holds them, its stay dates.
 * @param outcome - The terminal status to apply.
 * @param opts - The verification task that produced the outcome, when one did.
 * @returns `true` when this call applied the outcome, `false` when the claim was already terminal
 *   or gone, so a second run of the same job is a no-op.
 * @see AAP 0.5.3 for the claim lifecycle, 0.5.7 for the leaderboard and claim-measure rules, 0.3.2
 *   for the transactional outbox.
 */
export async function resolveClaim(
  tx: DbTx,
  ctx: WorkerContext,
  claim: ResolvableClaim,
  outcome: OperatorClaimOutcome,
  opts: ResolveClaimOptions = {},
): Promise<boolean> {
  const now = ctx.clock.now();

  const applied = await tx.lodgingClaim.updateMany({
    where: { id: claim.id, status: { in: [...ACTIVE_CLAIM_STATUSES] } },
    data: { status: outcome, resolvedAt: now },
  });

  if (applied.count === 0) {
    return false;
  }

  await cancelOutstandingVerification(tx, claim.id, opts.byTaskId);

  if (outcome === 'verified') {
    await backfillActivityFacts(tx, ctx, claim, now);
  }

  await tx.analyticsEvent.create({
    data: {
      name: 'lodging_claim_resolved',
      actorHash: actorHash(ctx.env.ANALYTICS_SALT, claim.userId),
      cityId: await cityOfLodging(tx, claim.lodgingId),
      props: claimEventProps(outcome, elapsedSeconds(now, claim.createdAt)),
      occurredAt: now,
    },
  });

  await writeNotificationOutbox(tx, now, {
    kind: 'lodging_claim_resolved',
    userId: claim.userId,
    lodgingClaimId: claim.id,
  });

  ctx.logger.info(
    { event: 'lodging_claim_resolved', claimId: claim.id, outcome },
    'lodging_claim_resolved',
  );

  return true;
}

/**
 * Cancels the verification work a resolved claim still has outstanding (AAP 0.5.3).
 *
 * Exactly the tasks that have not produced a result are cancelled: the claim's
 * `lodging_stay_verification` tasks in `queued`, `in_progress`, `needs_review` or `unreachable`,
 * less `byTaskId`, whose own status the caller sets. Their attempts in a possibly live state are
 * marked `superseded`, which is the signal the API's relay reads: it speaks the closing line and
 * ends the call on its next turn.
 *
 * A task that is already terminal — `completed`, `refused`, `do_not_call` or `cancelled` — is left
 * exactly as it stands, and `outcomeAt` is never written here: a cancelled task was cancelled, it
 * did not reach an outcome (AAP 0.5.3, 0.5.7).
 *
 * @param tx - The caller's transaction.
 * @param claimId - The resolved claim.
 * @param byTaskId - The task that produced the result, if any; it is never cancelled.
 * @returns How many tasks this call cancelled.
 * @see AAP 0.5.3 for the call-task lifecycle, "Terminal tasks stay terminal".
 */
async function cancelOutstandingVerification(
  tx: DbTx,
  claimId: string,
  byTaskId?: string,
): Promise<number> {
  const where: Prisma.CallTaskWhereInput = {
    lodgingClaimId: claimId,
    kind: LODGING_VERIFICATION_KIND,
    status: { in: [...OUTSTANDING_TASK_STATUSES] },
  };

  if (byTaskId !== undefined) {
    where.id = { not: byTaskId };
  }

  const tasks = await tx.callTask.findMany({ where, select: { id: true } });

  if (tasks.length === 0) {
    return 0;
  }

  const taskIds = tasks.map((task) => task.id);

  await tx.callTask.updateMany({
    where: { id: { in: taskIds } },
    data: { status: 'cancelled' },
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
 * Credits the lodging's leaderboard with the completed meetups a verified stay covers (AAP 0.5.7).
 *
 * The statement that finds them is stated once, in `@tablemate/db`
 * ({@link coveringMeetupStatement}, `packages/db/src/lodging-activity.ts`), and both this function
 * and the API's `recordActivityForVerifiedClaim` (`apps/api/src/modules/lodgings/leaderboard.ts`)
 * run that one statement: `workers` may not import `@tablemate/api`, so it lives in the package both
 * processes already depend on, which is what makes the two paths' facts impossible to drift apart.
 * What that statement states:
 *
 * - The meetup's local date is `(meetup.starts_at AT TIME ZONE city.timezone)::date`, the city being
 *   the meetup venue's city.
 * - A verified claim *covers* a meetup when the claim covers that date:
 *   `claim.stay_from <= local_date AND claim.stay_to >= local_date`, both ends being the stay dates
 *   this function reads and passes in.
 * - Only meetups inside the 90-day activity window are read, from the window start this function
 *   computes.
 *
 * What this function adds to the rows the statement returns: `pair_key` is
 * `pairKey(ANALYTICS_SALT, initiatorId, recipientId)`, the order-independent HMAC of the two ids, and
 * one fact per distinct (lodging, meetup) is inserted with `ON CONFLICT (lodging_id, meetup_id) DO
 * NOTHING` — `createMany({ skipDuplicates: true })` in Prisma's terms, which is what makes a second
 * resolution of the same claim write nothing.
 *
 * Each fact carries the meetup's own `settledAt` as its completion instant, so a backfill never
 * moves a historical score to today. A fact holds no user id: the pair hash is its only trace of the
 * two travelers, which is why deleting the claim or erasing the account leaves the lodging's score
 * unchanged (AAP 0.5.2).
 *
 * @param tx - The caller's transaction, which the facts commit with.
 * @param ctx - The worker context: `env.APP_ENV` decides fixture visibility in the raw statement and
 *   `env.ANALYTICS_SALT` keys the pair hash.
 * @param claim - The claim that became `verified`.
 * @param now - The instant the 90-day window is measured back from; from the injected clock.
 * @returns How many facts were inserted: 0 when the stay covers no completed meetup, or when the
 *   facts already existed.
 * @see AAP 0.5.7 for the leaderboard rule, 0.5.2 for what a fact holds.
 */
async function backfillActivityFacts(
  tx: DbTx,
  ctx: WorkerContext,
  claim: ResolvableClaim,
  now: Date,
): Promise<number> {
  const stay = await stayDates(tx, claim);

  if (stay === null) {
    return 0;
  }

  const rows = await tx.$queryRaw<CoveringMeetupRow[]>(
    coveringMeetupStatement(
      ctx.env.APP_ENV,
      { userId: claim.userId, stayFrom: stay.from, stayTo: stay.to },
      new Date(now.getTime() - LEADERBOARD_WINDOW_MS),
    ),
  );

  if (rows.length === 0) {
    return 0;
  }

  const inserted = await tx.lodgingActivityFact.createMany({
    data: rows.map((row) => ({
      lodgingId: claim.lodgingId,
      meetupId: row.id,
      pairKey: pairKey(ctx.env.ANALYTICS_SALT, row.initiator_id, row.recipient_id),
      completedAt: row.settled_at,
    })),
    skipDuplicates: true,
  });

  return inserted.count;
}

/**
 * The stay dates of `claim`, as `YYYY-MM-DD`: the two dates the covering-meetup statement casts to
 * `date`. Read from the row only when the caller did not pass them, which leaves a caller that
 * selected the identity fields alone working unchanged. `@db.Date` reads back as UTC midnight, so
 * the ISO date is the stored calendar date.
 */
async function stayDates(tx: DbTx, claim: ResolvableClaim): Promise<StayDates | null> {
  if (claim.stayFrom !== undefined && claim.stayTo !== undefined) {
    return { from: toDateOnly(claim.stayFrom), to: toDateOnly(claim.stayTo) };
  }

  const row = await tx.lodgingClaim.findUnique({
    where: { id: claim.id },
    select: { stayFrom: true, stayTo: true },
  });

  return row === null ? null : { from: toDateOnly(row.stayFrom), to: toDateOnly(row.stayTo) };
}

/** A stored calendar date as its `YYYY-MM-DD` form. */
function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Whole seconds between a claim's creation and its resolution, never negative (AAP 0.5.7). */
function elapsedSeconds(now: Date, createdAt: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 1000));
}

// ---------------------------------------------------------------------------------------------
// Processing a job (AAP 0.5.6)
// ---------------------------------------------------------------------------------------------

/**
 * Runs one `lodging-claims` job (AAP 0.5.6).
 *
 * `claim-expire` locks its claim, and expires it only when it is still active and at least 72 hours
 * old: a claim that reaches the job early is a no-op that reports `early`, a claim already resolved
 * or gone reports `expired: false`, and a claim in the operator queue expires exactly as any other
 * does, its task becoming `cancelled`.
 *
 * `stay-expiry` loads the city's configured zone, turns off every ended stay's `showStaying` and
 * expires the city's stale claims, reporting both counts.
 *
 * @param job - The BullMQ job: its name must be one of this queue's two, and its data `{ claimId }`
 *   or `{ cityId }` accordingly.
 * @param ctx - The worker context: configuration, clock, logger and database.
 * @returns What the run did, in the shape its job name reports.
 * @throws QueuePayloadError when the name is not one this queue accepts, or when the data does not
 *   satisfy that job's schema. `Error` when the named city is not configured.
 * @see AAP 0.5.3 for both expiries, 0.5.6 for the queue and its schedule.
 */
export async function process(
  job: LodgingClaimsJob,
  ctx: WorkerContext,
): Promise<LodgingClaimsResult> {
  const queue = QUEUE.lodgingClaims;

  // A name this queue does not accept has no schema to parse against, so it is refused here rather
  // than parsed as one of the two jobs: a foreign job arriving on this queue is a wiring fault.
  if (!isJobName(queue, job.name)) {
    throw new QueuePayloadError(`${queue}/${job.name}`);
  }

  if (job.name === JOB[queue].claimExpire) {
    const { claimId } = parseJobData(queue, JOB[queue].claimExpire, job.data);

    return await runClaimExpire(ctx, claimId);
  }

  const { cityId } = parseJobData(queue, JOB[queue].stayExpiry, job.data);

  return await runStayExpiry(ctx, cityId);
}

// ---------------------------------------------------------------------------------------------
// Claim expiry (AAP 0.5.3)
// ---------------------------------------------------------------------------------------------

/**
 * Expires one claim 72 hours after it was created (AAP 0.5.3: "unresolved … no penalty").
 *
 * A claim that is still `pending_call` or `calling` at that age becomes `unreachable`, which is a
 * terminal status: the user sees their claim resolved without a penalty, the verification task still
 * outstanding is cancelled, and a call that may be live is ended at its next turn.
 *
 * @param ctx - The worker context.
 * @param claimId - The claim the job names.
 * @returns Whether the claim was expired, and whether the run was early.
 * @see AAP 0.5.3 for the claim lifecycle and its 72-hour expiry.
 */
async function runClaimExpire(ctx: WorkerContext, claimId: string): Promise<ClaimExpireResult> {
  const outcome = await expireLockedClaim(ctx, claimId, ctx.clock.now());

  if (outcome === 'expired') {
    return { expired: true };
  }

  if (outcome === 'early') {
    return { expired: false, early: true };
  }

  return { expired: false };
}

/**
 * Locks one claim and expires it when both conditions hold: it is still active, and it is at least
 * 72 hours old (AAP 0.5.3).
 *
 * The lock is what makes this safe to run concurrently with a call result or an operator resolution:
 * the second runner finds the claim terminal and reports it, so the resolution happens exactly once.
 * A claim that does not exist is reported as `missing` rather than raised, because a purged claim's
 * delayed job is not a failure.
 *
 * @param ctx - The worker context.
 * @param claimId - The claim to expire.
 * @param now - The instant the claim's age is measured against; from the injected clock.
 * @returns Which of the four cases the locked claim was in.
 * @see AAP 0.5.3 for the claim lifecycle, 0.3.2 for idempotent jobs.
 */
async function expireLockedClaim(
  ctx: WorkerContext,
  claimId: string,
  now: Date,
): Promise<ClaimExpiry> {
  return await ctx.db.$transaction(async (tx) => {
    const claim = await lockClaim(tx, claimId);

    if (claim === null) {
      return 'missing';
    }

    if (!isActiveClaim(claim.status)) {
      return 'terminal';
    }

    if (now.getTime() < claim.created_at.getTime() + CLAIM_EXPIRY_MS) {
      return 'early';
    }

    const resolved = await resolveClaim(tx, ctx, asResolvableClaim(claim), 'unreachable');

    return resolved ? 'expired' : 'terminal';
  });
}

// ---------------------------------------------------------------------------------------------
// Stay expiry (AAP 0.5.3, 0.1.1)
// ---------------------------------------------------------------------------------------------

/**
 * Runs the daily 00:05 local step for one city (AAP 0.5.6): the stays that have ended stop being
 * advertised, and the claims a lost `claim-expire` job left open are expired.
 *
 * The city's zone is loaded from `City.timezone`, which is the only way a city-local date is
 * derived, and the date the visibility statement compares against comes from
 * `localDateKey(timezone, now)` — never from a UTC day (AAP 0.11.1).
 *
 * @param ctx - The worker context.
 * @param cityId - The city the scheduler names.
 * @returns How many visibility flags were turned off and how many claims the backstop expired.
 * @throws Error when the city is not configured, which means the scheduler and the `city` table
 *   disagree about the pilot's cities — a wiring fault rather than a transient failure.
 * @see AAP 0.5.3 for the end of a stay, 0.1.1 for the reliability the backstop serves.
 */
async function runStayExpiry(ctx: WorkerContext, cityId: string): Promise<StayExpiryResult> {
  const now = ctx.clock.now();
  const city = await ctx.db.city.findUnique({
    where: { id: cityId },
    select: { timezone: true },
  });

  if (city === null) {
    // The slug is configuration, not personal data, so naming it is what lets an operator fix the
    // mismatch between the scheduler and the `city` table (AAP 0.11.1).
    throw new Error(`the stay-expiry job named no configured city: "${cityId}"`);
  }

  const hidden = await hideEndedStays(ctx, cityId, localDateKey(city.timezone, now), now);
  const expired = await expireStaleClaims(ctx, cityId, now);

  ctx.logger.info({ event: 'stay_expiry', cityId, hidden, expired }, 'stay_expiry');

  return { hidden, expired };
}

/**
 * Turns `showStaying` off for every verified claim whose last day of the stay has passed
 * (AAP 0.5.3).
 *
 * A verified claim is *active* until the end of its `stayTo` in the lodging's city time and no
 * longer, which is the period `currentStayPredicate` in
 * `apps/api/src/modules/lodgings/leaderboard.ts` expresses as `stay_to >= (now AT TIME ZONE
 * city.timezone)::date`. The statement below is that predicate's complement, written with the date
 * this run derived from the clock: `stay_to < today` holds exactly when
 * `endOfLocalDay(timezone, stayTo) < now`, so the toggle follows the rule the guest count and the
 * guest list follow. `sort=activity` and the console's stats are unaffected: the leaderboard reads
 * facts, not visibility.
 *
 * The statement is one guarded update, so a second run of the same day changes no row, and it writes
 * `updated_at` by hand because raw SQL bypasses the column's own maintenance.
 *
 * @param ctx - The worker context: `env.APP_ENV` decides fixture visibility in the statement.
 * @param cityId - The city whose visibility rows are in scope.
 * @param today - The city's local date, `YYYY-MM-DD`, derived from the injected clock.
 * @param now - The instant written to `updated_at`.
 * @returns How many rows were updated.
 * @see AAP 0.5.3 for a claim's active period, 0.5.7 for lodging visibility.
 */
async function hideEndedStays(
  ctx: WorkerContext,
  cityId: string,
  today: string,
  now: Date,
): Promise<number> {
  return await ctx.db.$executeRaw(Prisma.sql`
    UPDATE "lodging_visibility" AS "lv"
       SET "show_staying" = false,
           "updated_at" = ${now}::timestamptz
      FROM "lodging_claim" AS "lc"
      JOIN "lodging" AS "l" ON "l"."id" = "lc"."lodging_id"
     WHERE "lv"."lodging_claim_id" = "lc"."id"
       AND "lv"."show_staying" = true
       AND "lc"."status" = 'verified'
       AND "l"."city_id" = ${cityId}
       AND "lc"."stay_to" < CAST(${today} AS date)
       AND ${fixturePredicate(ctx.env.APP_ENV, 'l')}
  `);
}

/**
 * Expires the city's claims that are still open past their 72 hours (AAP 0.5.3, 0.1.1).
 *
 * This is a backstop, not the normal path: `claim-expire` fires 72 hours after a claim is created,
 * and this run exists so that a delayed job lost with Redis cannot leave a claim open forever and a
 * lodging's console showing a call that will never happen. It is idempotent with `claim-expire` —
 * both call {@link expireLockedClaim}, whose lock and guards make the second runner a no-op — and it
 * bounds each run to {@link STALE_CLAIM_BATCH} claims, so a backlog is worked off over the following
 * days rather than in one long transaction.
 *
 * One transaction per claim, taken only once the claim is known to be stale, keeps the locking as
 * short as the resolution itself.
 *
 * @param ctx - The worker context.
 * @param cityId - The city whose claims are in scope, read through the lodging that owns them.
 * @param now - The instant a claim's age is measured against; from the injected clock.
 * @returns How many claims this run expired.
 * @see AAP 0.5.3 for the 72-hour expiry, 0.3.2 for idempotent work.
 */
async function expireStaleClaims(ctx: WorkerContext, cityId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - CLAIM_EXPIRY_MS);

  const stale = await ctx.db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "c"."id"::text AS "id"
      FROM "lodging_claim" AS "c"
      JOIN "lodging" AS "l" ON "l"."id" = "c"."lodging_id"
     WHERE "l"."city_id" = ${cityId}
       AND "c"."status" IN ('pending_call', 'calling')
       AND "c"."created_at" <= ${cutoff}::timestamptz
       AND ${fixturePredicate(ctx.env.APP_ENV, 'l')}
     ORDER BY "c"."created_at"
     LIMIT ${STALE_CLAIM_BATCH}::int
  `);

  let expired = 0;

  for (const row of stale) {
    const outcome = await expireLockedClaim(ctx, row.id, now);

    if (outcome === 'expired') {
      expired += 1;
    }
  }

  return expired;
}

// ---------------------------------------------------------------------------------------------
// Row locks and conversions (AAP 0.5.3)
// ---------------------------------------------------------------------------------------------

/**
 * Locks one claim row for the rest of the caller's transaction and returns it, or `null` when no
 * such claim exists (AAP 0.5.3).
 *
 * The lock is the serialization point of a claim: the expiry jobs, the operator's resolution and
 * `call-results` all take it before they read a status, so the first writer wins and every later one
 * sees its result. Ids come back as text and the stay dates as `@db.Date` days, which is how the
 * conversion to {@link ResolvableClaim} reads them.
 *
 * @param tx - The transaction the lock is held in; it must be the transaction that resolves the
 *   claim, because a lock is released at commit.
 * @param claimId - The claim to lock.
 * @returns The locked row, or `null` when the claim does not exist.
 * @throws Error when the statement cannot run at all — an aborted transaction, a lost connection —
 *   which the queue retries.
 */
async function lockClaim(tx: DbTx, claimId: string): Promise<LockedClaimRow | null> {
  const rows = await tx.$queryRaw<LockedClaimRow[]>(Prisma.sql`
    SELECT "c"."id"::text AS "id",
           "c"."user_id"::text AS "user_id",
           "c"."lodging_id"::text AS "lodging_id",
           "c"."status"::text AS "status",
           "c"."created_at" AS "created_at",
           "c"."stay_from" AS "stay_from",
           "c"."stay_to" AS "stay_to"
      FROM "lodging_claim" AS "c"
     WHERE "c"."id" = ${claimId}::uuid
       FOR UPDATE
  `);

  return rows[0] ?? null;
}

/** True while a claim can still be resolved: `pending_call` or `calling` (AAP 0.5.3). */
function isActiveClaim(status: LodgingClaimStatus): boolean {
  return ACTIVE_CLAIM_STATUSES.some((active) => active === status);
}

/** A locked row in the shape {@link resolveClaim} takes. */
function asResolvableClaim(row: LockedClaimRow): ResolvableClaim {
  return {
    id: row.id,
    userId: row.user_id,
    lodgingId: row.lodging_id,
    createdAt: row.created_at,
    stayFrom: row.stay_from,
    stayTo: row.stay_to,
  };
}

/**
 * The `props` column of a claim's analytics event: the two measure fields of AAP 0.5.7, checked
 * against the shared strict `AnalyticsProps` schema before they are stored, so a key the contract
 * does not define cannot reach the table. Built as the plain record `Prisma.InputJsonValue` accepts.
 */
function claimEventProps(
  outcome: OperatorClaimOutcome,
  resolveSeconds: number,
): Record<string, string | number> {
  const props = AnalyticsProps.parse({ outcome, resolveSeconds });
  const json: Record<string, string | number> = {};

  if (props.outcome !== undefined) {
    json['outcome'] = props.outcome;
  }
  if (props.resolveSeconds !== undefined) {
    json['resolveSeconds'] = props.resolveSeconds;
  }

  return json;
}

/**
 * The city a lodging belongs to, for the claim event's `cityId` column, or `null` when the row is
 * not readable in this environment. A claim is user data on a business, so the lookup is a plain
 * read; the column is nullable for the same reason (AAP 0.5.2).
 */
async function cityOfLodging(tx: DbTx, lodgingId: string): Promise<string | null> {
  const lodging = await tx.lodging.findUnique({
    where: { id: lodgingId },
    select: { cityId: true },
  });

  return lodging?.cityId ?? null;
}
