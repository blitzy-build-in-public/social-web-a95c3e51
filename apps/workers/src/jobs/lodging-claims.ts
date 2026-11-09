/**
 * The `lodging-claims` queue: claim resolution, claim expiry and stay expiry (AAP 0.5.3, 0.5.6).
 *
 * {@link resolveClaim} applies one terminal outcome to a claim whose row the caller locked; the operator's resolution,
 * the 72-hour expiry and `call-results` all call it, so an outcome's side effects are written once. `claim-expire` carries
 * `{ claimId }` and runs 72 hours after the claim was created: a claim still unresolved becomes `unreachable` with no
 * penalty and its verification task is cancelled. `stay-expiry` carries `{ cityId }` and runs daily at 00:05 local: every
 * `showStaying` a verified claim can no longer justify is turned off, and any claim of the city still open past its 72
 * hours is expired too, as a backstop for a lost `claim-expire` job.
 *
 * Four rules hold throughout: time comes from the injected clock and city-local reasoning goes through `localDateKey`;
 * every raw statement that reads `lodging` or `venue` carries {@link fixturePredicate}, because raw SQL bypasses the
 * guarded client's fixture filter; every write is guarded on the status it expects, so a second run of the same job leaves
 * the same state; and nothing here calls a third party. The leaderboard rule {@link backfillActivityFacts} implements is
 * stated once, in `@tablemate/db` (`coveringMeetupStatement`), which both this file and the API's
 * `recordActivityForVerifiedClaim` run, so the two paths' facts cannot drift.
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
// Type-only on purpose: `queues.ts` value-imports this file's `process`, so a value import back would close a runtime cycle.
import type { WorkerContext } from '../queues.ts';

// A claim can leave these two statuses only; every other status is terminal, and a terminal claim stays terminal.
const ACTIVE_CLAIM_STATUSES = [
  'pending_call',
  'calling',
] as const satisfies readonly LodgingClaimStatus[];
/** How long an unresolved claim may live: 72 hours from its creation (AAP 0.5.3). */
const CLAIM_EXPIRY_MS = CLAIM_EXPIRY_HOURS * HOUR_MS;
/** The leaderboard's activity window in milliseconds: the last 90 days (AAP 0.5.7). */
const LEADERBOARD_WINDOW_MS = LEADERBOARD_WINDOW_DAYS * DAY_MS;
// A task in one of these has not produced the claim's result, so a resolution cancels it (AAP 0.5.3).
const OUTSTANDING_TASK_STATUSES = [
  'queued',
  'in_progress',
  'needs_review',
  'unreachable',
] as const satisfies readonly CallTaskStatus[];
// A call may genuinely be live in these states, so a cancelled task's attempt is marked `superseded`: the API's relay checks its task before every turn and speaks its closing line (AAP 0.5.3).
const LIVE_ATTEMPT_STATES = [
  'dispatching',
  'dispatch_unknown',
  'dialing',
  'in_progress',
] as const satisfies readonly CallAttemptState[];
const LODGING_VERIFICATION_KIND: CallTaskKind = 'lodging_stay_verification';
// The backstop is a safety net for a lost `claim-expire` job rather than the normal path, so a single run bounds its work and the next daily run continues where it stopped.
const STALE_CLAIM_BATCH = 200;
// A claim as {@link resolveClaim} needs it. `stayFrom`/`stayTo` are the two dates the leaderboard backfill reads: when they are absent {@link stayDates} reads them from the row inside the caller's transaction, so a caller that selected the identity fields alone works unchanged.
export interface ResolvableClaim {
  readonly id: string;
  readonly userId: string;
  readonly lodgingId: string;
  readonly createdAt: Date;
  readonly stayFrom?: Date;
  readonly stayTo?: Date;
}

// What {@link resolveClaim} accepts beyond the claim and the outcome.
export interface ResolveClaimOptions {
  // The verification task that produced this outcome, when one did: it is never cancelled and never superseded — "Only attempts that did not produce the result are ever superseded" (AAP 0.5.3) — and the caller sets its own status.
  readonly byTaskId?: string;
}

// What one `claim-expire` run reports (AAP 0.5.3). `early` is true when the job ran before the claim's 72 hours were up, so the run was a no-op.
export interface ClaimExpireResult {
  readonly expired: boolean;
  readonly early?: boolean;
}

// What one `stay-expiry` run reports (AAP 0.5.3): the `showStaying` flags turned off, and the stale claims the backstop moved to `unreachable`.
export interface StayExpiryResult {
  readonly hidden: number;
  readonly expired: number;
}

export type LodgingClaimsResult = ClaimExpireResult | StayExpiryResult;
// A structural subset of BullMQ's `Job`, so a test can call {@link process} with a plain object. `id` is `claim-expire-<claimId>`, the stable job id that suppresses a duplicate enqueue (AAP 0.3.2).
export interface LodgingClaimsJob {
  readonly id?: string;
  readonly name: string;
  readonly data: unknown;
}

interface LockedClaimRow {
  readonly id: string;
  readonly user_id: string;
  readonly lodging_id: string;
  readonly status: LodgingClaimStatus;
  readonly created_at: Date;
  readonly stay_from: Date;
  readonly stay_to: Date;
}

interface StayDates {
  readonly from: string;
  readonly to: string;
}

// The four cases {@link expireLockedClaim} tells apart.
type ClaimExpiry = 'missing' | 'terminal' | 'early' | 'expired';
// Applies a terminal outcome to a claim, or does nothing when the claim has already left its active state (AAP 0.5.3).
//
// The caller holds the claim's row lock (`SELECT … FROM "lodging_claim" WHERE id = … FOR UPDATE`) inside `tx`, which is what
// makes this resolution and every other writer of that claim serialize: the guarded `updateMany` is the claim's own
// transition, and a claim that is not `pending_call` or `calling` returns `false` with no effect at all.
//
// A resolution that applies the outcome writes five things in the caller's transaction, so all of them commit with the
// status change or none does: every outstanding verification task of the claim is cancelled and each of their possibly live
// attempts marked `superseded`, leaving the task named in `opts.byTaskId` untouched — a cancelled task keeps its
// `outcomeAt`, because `cancelled` is a lifecycle state and not an outcome; on `verified`, {@link backfillActivityFacts}
// credits the lodging's leaderboard with the completed meetups of the stay; an `AnalyticsEvent` named
// `lodging_claim_resolved` carrying the outcome and how long the claim took, the only source of the dashboard's claim
// measures; the claimant's notification as an outbox row in this transaction; and a log line naming the claim and the
// outcome and nothing else — never the booking name, reference, stay dates or phone number.
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

// Cancels the verification work a resolved claim still has outstanding (AAP 0.5.3): exactly the tasks that have not produced a result — the claim's `lodging_stay_verification` tasks in `queued`, `in_progress`, `needs_review` or `unreachable`, less `byTaskId`. Their attempts in a possibly live state are marked `superseded`, the signal the API's relay reads to end the call on its next turn; `outcomeAt` is never written here, because a cancelled task was cancelled.
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

// Credits the lodging's leaderboard with the completed meetups a verified stay covers (AAP 0.5.7). The statement that finds
// them is stated once, in `@tablemate/db` ({@link coveringMeetupStatement}), and the API's `recordActivityForVerifiedClaim`
// runs that same statement: `workers` may not import `@tablemate/api`, so it lives in the package both processes depend on.
//
// A meetup counts when the claim's stay dates cover the meetup's city-local date and the meetup settled inside the 90-day
// activity window; each fact carries the meetup's own `settledAt`, so a backfill never moves a historical score. One fact
// per distinct (lodging, meetup) is inserted with `ON CONFLICT … DO NOTHING` (`skipDuplicates: true`), which makes a second
// resolution of the same claim write nothing. A fact holds no user id: the order-independent pair hash is its only trace of
// the two travelers, which is why deleting the claim or erasing the account leaves the score unchanged.
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

// The stay dates of `claim`, as `YYYY-MM-DD`: the two dates the covering-meetup statement casts to `date`, read from the row only when the caller did not pass them. `@db.Date` reads back as UTC midnight, so the ISO date is the stored one.
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

// Runs one `lodging-claims` job (AAP 0.5.6). `claim-expire` locks its claim and expires it only when it is still active and at least 72 hours old: one that reaches the job early reports `early`, one already resolved or gone `expired: false`, and one in the operator queue expires exactly as any other does. `stay-expiry` loads the city's zone, turns off every ended stay's `showStaying` and expires the city's stale claims, reporting both counts.
export async function process(
  job: LodgingClaimsJob,
  ctx: WorkerContext,
): Promise<LodgingClaimsResult> {
  const queue = QUEUE.lodgingClaims;
  // A name this queue does not accept has no schema to parse against, so it is refused here rather than parsed as one of the two jobs: a foreign job arriving on this queue is a wiring fault.
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

// Expires one claim 72 hours after it was created (AAP 0.5.3: "unresolved … no penalty"). A claim still `pending_call` or `calling` at that age becomes `unreachable`, a terminal status: the user sees the claim resolved without a penalty, the verification task outstanding is cancelled, and a call that may be live is ended at its next turn.
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

// Locks one claim and expires it when both conditions hold: it is still active, and it is at least 72 hours old (AAP 0.5.3). The lock makes this safe to run concurrently with a call result or an operator resolution — the second runner finds the claim terminal and reports it — and a claim that does not exist is reported `missing` rather than raised.
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

// Runs the daily 00:05 local step for one city (AAP 0.5.6): the stays that have ended stop being advertised, and the claims a lost `claim-expire` job left open are expired. The city's zone comes from `City.timezone` and the date compared against comes from `localDateKey(timezone, now)` — never from a UTC day.
async function runStayExpiry(ctx: WorkerContext, cityId: string): Promise<StayExpiryResult> {
  const now = ctx.clock.now();
  const city = await ctx.db.city.findUnique({
    where: { id: cityId },
    select: { timezone: true },
  });
  if (city === null) {
    // The id is configuration, not personal data, so naming it lets an operator fix the mismatch between the scheduler and the `city` table.
    throw new Error(`the stay-expiry job named no configured city: "${cityId}"`);
  }
  const hidden = await hideEndedStays(ctx, cityId, localDateKey(city.timezone, now), now);
  const expired = await expireStaleClaims(ctx, cityId, now);
  ctx.logger.info({ event: 'stay_expiry', cityId, hidden, expired }, 'stay_expiry');
  return { hidden, expired };
}

// Turns `showStaying` off for every verified claim whose last day of the stay has passed (AAP 0.5.3). A verified claim is *active* until the end of its `stayTo` in the lodging's city time and no longer, which `currentStayPredicate` in `apps/api/src/modules/lodgings/leaderboard.ts` expresses. The statement below is that predicate's complement, written with the date this run derived from the clock, so the toggle follows the rule the guest count and the guest list follow. It is one guarded update, so a second run of the same day changes no row.
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

// Expires the city's claims that are still open past their 72 hours (AAP 0.5.3). This is a backstop, not the normal path: `claim-expire` fires 72 hours after a claim is created, and this run exists so that a delayed job lost with Redis cannot leave a claim open forever. It is idempotent with `claim-expire` — both call {@link expireLockedClaim}, whose lock and guards make the second runner a no-op — and it bounds each run to {@link STALE_CLAIM_BATCH} claims.
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

// Locks one claim row for the rest of the caller's transaction and returns it, or `null` when no such claim exists (AAP 0.5.3). The lock is the serialization point of a claim: the expiry jobs, the operator's resolution and `call-results` all take it before they read a status, so the first writer wins and every later one sees its result.
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

function isActiveClaim(status: LodgingClaimStatus): boolean {
  return ACTIVE_CLAIM_STATUSES.some((active) => active === status);
}

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

// The `props` column of a claim's analytics event: the two measure fields of AAP 0.5.7, checked against the shared strict `AnalyticsProps` schema before they are stored, so a key the contract does not define cannot reach the table.
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

// The city a lodging belongs to, for the claim event's `cityId` column, or `null` when the row is not readable in this environment: a claim is user data on a business, so the column is nullable for the same reason.
async function cityOfLodging(tx: DbTx, lodgingId: string): Promise<string | null> {
  const lodging = await tx.lodging.findUnique({
    where: { id: lodgingId },
    select: { cityId: true },
  });
  return lodging?.cityId ?? null;
}
