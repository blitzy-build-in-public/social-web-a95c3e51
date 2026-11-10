/**
 * The deposit lifecycle and the durable `PaymentOperation` planners — the database-only leaf that
 * `meetups/state-machine.ts`, `meetups/queries.ts` and `settlement/settle.ts` import.
 *
 * Every Stripe mutation is a `PaymentOperation` row written inside the domain transaction that decides it, with the
 * status change, the analytics events and the outbox rows, and executed after that transaction commits. Nothing
 * here calls Stripe, reads a clock of its own or opens a transaction.
 */

import { Prisma, type DbTx } from '@tablemate/db';
import type { Deposit, PaymentOperation } from '@tablemate/db';
import {
  DepositStatus,
  FINAL_DEPOSIT_STATUSES,
  type HoldView,
  type PaymentOperationKind,
  type PaymentOperationStatus,
} from '@tablemate/shared';

// Idempotency keys (AAP 0.3.2 "Keys name the PaymentIntent attempt"). Stripe keys keep `:` and the
// attempt number, unlike BullMQ custom job ids, which use `-` because a `:` is reserved there.

/** The key of the hold attempt `attempt` on `depositId`: `hold:<depositId>:<attempt>` (AAP 0.3.2). */
export function holdKey(depositId: string, attempt: number): string {
  return `hold:${depositId}:${attempt}`;
}

/** The key of the release of attempt `attempt`: `release:<depositId>:<attempt>` (AAP 0.3.2). */
export function releaseKey(depositId: string, attempt: number): string {
  return `release:${depositId}:${attempt}`;
}

/** The key of the capture of attempt `attempt`: `capture:<depositId>:<attempt>` (AAP 0.3.2). */
export function captureKey(depositId: string, attempt: number): string {
  return `capture:${depositId}:${attempt}`;
}

/**
 * The key of the refund reversing attempt `attempt`: `refund:<depositId>:<attempt>`. It names the attempt whose money
 * is returned, never the capture's, so two reversals of two captures on one deposit cannot collide.
 */
export function refundKey(depositId: string, attempt: number): string {
  return `refund:${depositId}:${attempt}`;
}

/**
 * The key of the deletion of `userId`'s Stripe customer: `delete_customer:<userId>`. A customer outlives every
 * attempt of every deposit of its owner, so a second `DELETE /me` replays one deletion rather than creating a second
 * operation.
 */
export function deleteCustomerKey(userId: string): string {
  return `delete_customer:${userId}`;
}

// The deposit status table (AAP 0.5.3)

/**
 * The deposit lifecycle as a table: the statuses each status may move to, and no others. `released`, `captured`,
 * `expired` and `refunded` are final, and the two deliberate absences are what Forward-only requires: `held` never
 * returns to `pending`, and `captured` never to `held`. `failed → released` is the row the late-and-orphan rule
 * needs.
 */
export const DEPOSIT_TRANSITIONS: Readonly<Record<DepositStatus, readonly DepositStatus[]>> = {
  pending: ['held', 'requires_action', 'failed', 'released'],
  requires_action: ['held', 'failed', 'released'],
  failed: ['pending', 'released'],
  held: ['released', 'captured', 'expired'],
  released: [],
  captured: ['refunded'],
  expired: [],
  refunded: [],
};

/** Every `DepositStatus`, in the declaration order of the domain enum. */
const DEPOSIT_STATUSES: readonly DepositStatus[] = DepositStatus.options;

/**
 * The deposit statuses {@link releaseAllOpen} acts on: every status that is not final. Derived rather than spelled
 * out, so a status added to the domain enum is either final and excluded, or open and picked up.
 */
const RELEASABLE_DEPOSIT_STATUSES: ReadonlySet<DepositStatus> = new Set(
  DEPOSIT_STATUSES.filter(
    (status) => !FINAL_DEPOSIT_STATUSES.some((finalStatus) => finalStatus === status),
  ),
);

/** True when a deposit may move from `from` to `to` (AAP 0.5.3). */
export function canTransitionDeposit(from: DepositStatus, to: DepositStatus): boolean {
  return DEPOSIT_TRANSITIONS[from].some((allowed) => allowed === to);
}

/** The inverse lookup: every status a deposit may hold before it takes `to` (AAP 0.5.3). */
export function fromStatusesFor(to: DepositStatus): DepositStatus[] {
  return DEPOSIT_STATUSES.filter((from) => canTransitionDeposit(from, to));
}

/** A deposit row named by id, with the hold attempt an update concerns (AAP 0.5.3). */
export interface DepositRef {
  readonly depositId: string;
  /** The attempt the caller believes is current; the guarded update matches it or does nothing. */
  readonly attempt: number;
}

/**
 * The fields an event may record while it moves a deposit forward. An absent key leaves the column as it is:
 * `exactOptionalPropertyTypes` keeps `undefined` out of the update rather than clearing a value the event never
 * mentioned.
 */
export interface DepositAdvance {
  /** The authorization's capture deadline, recorded when the hold becomes `held`. */
  readonly captureBefore?: Date;
  /** Stripe's own cancellation time, recorded on a hold loss. */
  readonly canceledAt?: Date;
  /** The PaymentIntent of the attempt that is now current. */
  readonly currentPaymentIntentId?: string;
}

/**
 * The single forward-only, attempt-scoped deposit write: it filters on the deposit's id, its `currentAttempt` and the
 * statuses {@link fromStatusesFor} allows before `to`, so the row moves only when the event still concerns the current
 * attempt and still moves it forward. A false result is ordinary, never an error.
 */
export async function advanceDeposit(
  tx: DbTx,
  ref: DepositRef,
  to: DepositStatus,
  data?: DepositAdvance,
): Promise<boolean> {
  const result = await tx.deposit.updateMany({
    where: { id: ref.depositId, currentAttempt: ref.attempt, status: { in: fromStatusesFor(to) } },
    data: {
      status: to,
      ...(data?.captureBefore !== undefined ? { captureBefore: data.captureBefore } : {}),
      ...(data?.canceledAt !== undefined ? { canceledAt: data.canceledAt } : {}),
      ...(data?.currentPaymentIntentId !== undefined
        ? { currentPaymentIntentId: data.currentPaymentIntentId }
        : {}),
    },
  });
  return result.count === 1;
}

// Operation status tables (AAP 0.3.2)

/**
 * The statuses that end an operation's life: the executor's success, a failure it will not retry, and a plan a later
 * decision superseded before it was sent. None blocks the operation that depends on it.
 */
export const TERMINAL_OPERATION_STATUSES = [
  'succeeded',
  'failed_terminal',
  'fenced',
] as const satisfies readonly PaymentOperationStatus[];

/** True when `status` ends an operation's life (AAP 0.3.2). */
export function isTerminalOperation(status: PaymentOperationStatus): boolean {
  return TERMINAL_OPERATION_STATUSES.some((terminal) => terminal === status);
}

/**
 * The `last_error` values that mean a hold create was handed to the operator: twelve hours without a resolved replay,
 * and an idempotency conflict the gateway could not resolve.
 */
export const HOLD_HAND_OFF_MARKERS = ['unresolved_12h', 'idempotency_error'] as const;

/** One of {@link HOLD_HAND_OFF_MARKERS}: the marker a hand-off writes to an operation's `last_error`. */
export type HoldHandOffMarker = (typeof HOLD_HAND_OFF_MARKERS)[number];

/**
 * True when a `hold` operation was handed to the operator instead of being resolved. Such a row is still
 * `failed_terminal`, and it is **not** proof that the attempt left nothing at Stripe: the create may have succeeded
 * with an answer we never learned, so there may be an authorization under the row.
 */
export function isHandedOffHold(operation: Pick<PaymentOperation, 'kind' | 'lastError'>): boolean {
  if (operation.kind !== 'hold') {
    return false;
  }
  const marker = operation.lastError;
  return marker !== null && HOLD_HAND_OFF_MARKERS.some((handOff) => handOff === marker);
}

/**
 * The statuses an operation may still be claimed from: a row left `executing` past two minutes is a call whose
 * answer was lost, not a call that is running.
 */
export const OPEN_OPERATION_STATUSES = [
  'pending',
  'executing',
  'failed_retryable',
] as const satisfies readonly PaymentOperationStatus[];

// Planning an operation (AAP 0.3.2 "Stripe mutations")

/** The columns an operation's kind and its predecessors decide; absent when that kind has none. */
interface OperationExtras {
  readonly dependsOnId?: string;
  readonly paymentIntentId?: string | null;
  /** Set only on `delete_customer`: the customer id copied off the user row. */
  readonly stripeCustomerId?: string | null;
}

/** One row {@link planOperation} inserts: every column a planner sets. */
interface NewOperation extends OperationExtras {
  readonly userId: string;
  readonly depositId: string | null;
  readonly kind: PaymentOperationKind;
  readonly attempt: number | null;
  /** Its order among the deposit's operations, from {@link nextSeq}. */
  readonly seq: number;
  readonly idempotencyKey: string;
}

/**
 * Reads an integer a raw statement returned. PostgreSQL `INTEGER` reaches JavaScript as a number and `BIGINT` as a
 * bigint, and a driver change could hand back a digit string, so all three are accepted rather than assumed.
 */
function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

/** The next free `seq` for a deposit: one past the highest one it already has. A deposit with no operation yet starts at 1. */
export async function nextSeq(tx: DbTx, depositId: string): Promise<number> {
  const rows = await tx.$queryRaw<readonly { nextSeq: number | null }[]>(Prisma.sql`
    SELECT COALESCE(MAX("seq"), 0) + 1 AS "nextSeq"
    FROM "payment_operation"
    WHERE "deposit_id" = ${depositId}::uuid
  `);
  return toInt(rows[0]?.nextSeq ?? null) ?? 1;
}

/**
 * Writes one operation row, or hands back the row its key already names. `skipDuplicates` is PostgreSQL's
 * `ON CONFLICT ("idempotency_key") DO NOTHING`, so re-planning a key that exists — a repeated accept, a second
 * `DELETE /me`, a sweeper pass over a decision already written — is an idempotent no-op.
 */
async function planOperation(tx: DbTx, row: NewOperation, now: Date): Promise<PaymentOperation> {
  const insert: Prisma.PaymentOperationCreateManyInput = {
    userId: row.userId,
    depositId: row.depositId,
    kind: row.kind,
    attempt: row.attempt,
    seq: row.seq,
    dependsOnId: row.dependsOnId ?? null,
    paymentIntentId: row.paymentIntentId ?? null,
    stripeCustomerId: row.stripeCustomerId ?? null,
    idempotencyKey: row.idempotencyKey,
    status: 'pending',
    tries: 0,
    createdAt: now,
  };
  await tx.paymentOperation.createMany({ data: [insert], skipDuplicates: true });
  return tx.paymentOperation.findUniqueOrThrow({ where: { idempotencyKey: row.idempotencyKey } });
}

/** A deposit row with the hold attempt an operation concerns (AAP 0.3.2). */
export interface DepositAttempt {
  readonly deposit: Deposit;
  /** The hold attempt the operation concerns, from 1. */
  readonly attempt: number;
}

/** {@link planRelease}: the intent to cancel, and the hold operation it releases. */
export interface ReleaseRef extends DepositAttempt {
  /** The PaymentIntent to cancel, or null while that attempt's create is still ambiguous. */
  readonly paymentIntentId: string | null;
  readonly dependsOnId?: string;
}

/** {@link planCapture}: the `requires_capture` intent to capture. */
export interface CaptureRef extends DepositAttempt {
  readonly paymentIntentId: string;
}

/** {@link planRefund}: the intent to reverse, and the operation it must wait for. */
export interface RefundRef extends DepositAttempt {
  /** The intent whose money is returned, or null when the executor must resolve it. */
  readonly paymentIntentId: string | null;
  /** The capture this refund reverses, which the executor's ordering waits for. */
  readonly dependsOnId: string;
}

/**
 * Plans the hold of one attempt: `hold:<depositId>:<attempt>`. The PaymentIntent id stays null because it does not
 * exist until the executor creates the intent, and the hold needs no `dependsOnId`: its `seq` is the lowest still
 * open on the deposit.
 */
export async function planHold(
  tx: DbTx,
  ref: DepositAttempt,
  now: Date,
): Promise<PaymentOperation> {
  return planOperation(
    tx,
    {
      userId: ref.deposit.ownerId,
      depositId: ref.deposit.id,
      kind: 'hold',
      attempt: ref.attempt,
      seq: await nextSeq(tx, ref.deposit.id),
      idempotencyKey: holdKey(ref.deposit.id, ref.attempt),
    },
    now,
  );
}

/**
 * Plans the release of one attempt's authorization: `release:<depositId>:<attempt>`. A null `paymentIntentId` is
 * accepted and kept: while an attempt's create is ambiguous there is no id to name, and the executor resolves it from
 * that attempt's hold operation.
 */
export async function planRelease(tx: DbTx, ref: ReleaseRef, now: Date): Promise<PaymentOperation> {
  return planOperation(
    tx,
    {
      userId: ref.deposit.ownerId,
      depositId: ref.deposit.id,
      kind: 'release',
      attempt: ref.attempt,
      seq: await nextSeq(tx, ref.deposit.id),
      idempotencyKey: releaseKey(ref.deposit.id, ref.attempt),
      paymentIntentId: ref.paymentIntentId,
      ...(ref.dependsOnId !== undefined ? { dependsOnId: ref.dependsOnId } : {}),
    },
    now,
  );
}

/**
 * Plans the capture of one attempt's hold: `capture:<depositId>:<attempt>`. The capture is ordered after the hold by
 * its higher `seq` alone: by the time it is claimed, the hold that created the intent is terminal.
 */
export async function planCapture(tx: DbTx, ref: CaptureRef, now: Date): Promise<PaymentOperation> {
  return planOperation(
    tx,
    {
      userId: ref.deposit.ownerId,
      depositId: ref.deposit.id,
      kind: 'capture',
      attempt: ref.attempt,
      seq: await nextSeq(tx, ref.deposit.id),
      idempotencyKey: captureKey(ref.deposit.id, ref.attempt),
      paymentIntentId: ref.paymentIntentId,
    },
    now,
  );
}

/**
 * Plans the refund reversing one attempt: `refund:<depositId>:<attempt>`. `dependsOnId` is required here, so no
 * refund runs while a capture it reverses is outstanding. The executor resolves the intent against its actual state —
 * captured is refunded, uncaptured is cancelled, cancelled needs nothing.
 */
export async function planRefund(tx: DbTx, ref: RefundRef, now: Date): Promise<PaymentOperation> {
  return planOperation(
    tx,
    {
      userId: ref.deposit.ownerId,
      depositId: ref.deposit.id,
      kind: 'refund',
      attempt: ref.attempt,
      seq: await nextSeq(tx, ref.deposit.id),
      idempotencyKey: refundKey(ref.deposit.id, ref.attempt),
      paymentIntentId: ref.paymentIntentId,
      dependsOnId: ref.dependsOnId,
    },
    now,
  );
}

/**
 * Plans the deletion of a user's Stripe customer: `delete_customer:<userId>`. The operation carries its own copy of
 * the customer id, so `account-erasure` can null `User.stripeCustomerId` without losing the id the executor still
 * needs. A null id still writes the row, and the executor treats it as a satisfied no-op.
 */
export async function planDeleteCustomer(
  tx: DbTx,
  userId: string,
  stripeCustomerId: string | null,
  now: Date,
): Promise<PaymentOperation> {
  return planOperation(
    tx,
    {
      userId,
      depositId: null,
      kind: 'delete_customer',
      attempt: null,
      seq: 0,
      idempotencyKey: deleteCustomerKey(userId),
      stripeCustomerId,
    },
    now,
  );
}

// Attempts, bulk release and fencing (AAP 0.3.2, 0.5.3)

/**
 * The outcome of {@link startNewAttempt}: the new attempt and its hold, or why none was started. `hold_pending` is
 * the caller's `409 hold_pending` and `not_failed` its `409 not_proposed`; `hold_pending` is the answer whenever the
 * current attempt is still unresolved.
 */
export type StartAttemptResult =
  | { readonly ok: true; readonly attempt: number; readonly holdOp: PaymentOperation }
  | { readonly ok: false; readonly reason: 'hold_pending' | 'not_failed' };

/**
 * Starts the next hold attempt of a `failed` deposit (the retry behind `POST /meetups/:id/hold` and a repeated
 * `POST /meetups/:id/accept`).
 *
 * The retry may not proceed while the current attempt is unresolved — a deposit whose attempt never reached a
 * conclusion, or whose create may have left an authorization — because a second authorization is what the rule
 * forbids. Only a `failed` deposit with a resolved attempt starts one, under `hold:<depositId>:<attempt>`.
 */
export async function startNewAttempt(
  tx: DbTx,
  deposit: Deposit,
  now: Date,
): Promise<StartAttemptResult> {
  // A `pending` deposit has not concluded its attempt whatever its hold row says, so there is still
  // something to recover: a create may be in flight, an ambiguous one may be waiting for its replay,
  // and one may have been handed to the operator. None of them may be followed by a second
  // authorization under a new attempt's key (AAP 0.3.2).
  if (deposit.status === 'pending') {
    return { ok: false, reason: 'hold_pending' };
  }
  if (deposit.status !== 'failed') {
    return { ok: false, reason: 'not_failed' };
  }
  // A missing hold row means no create was ever planned for this attempt — the row is written in the
  // same transaction that starts the attempt — so there is no authorization to reconcile and the retry
  // may proceed. A row that is still open is what blocks it.
  const previous = await findHoldOperation(tx, deposit.id, deposit.currentAttempt);
  if (previous !== null && !isTerminalOperation(previous.status)) {
    return { ok: false, reason: 'hold_pending' };
  }
  const attempt = deposit.currentAttempt + 1;
  const moved = await tx.deposit.updateMany({
    where: { id: deposit.id, status: 'failed', currentAttempt: deposit.currentAttempt },
    data: {
      status: 'pending',
      currentAttempt: attempt,
      currentPaymentIntentId: null,
      captureBefore: null,
      canceledAt: null,
    },
  });
  if (moved.count !== 1) {
    return { ok: false, reason: 'not_failed' };
  }
  if (previous !== null && previous.paymentIntentId !== null) {
    await planRelease(
      tx,
      {
        deposit,
        attempt: previous.attempt ?? deposit.currentAttempt,
        paymentIntentId: previous.paymentIntentId,
        dependsOnId: previous.id,
      },
      now,
    );
  }
  return { ok: true, attempt, holdOp: await planHold(tx, { deposit, attempt }, now) };
}

/**
 * Fences the `hold` operations that were planned but never sent, and reports their attempts. Such a row has `tries`
 * 0, no `claimed_at` and is still `pending`, so no call to Stripe was ever made under its key; fencing it guarantees
 * no authorization can be created after the meetup ends. A hold that is `executing` is left alone.
 */
async function fenceNeverSentHolds(tx: DbTx, depositId: string, now: Date): Promise<number[]> {
  const rows = await tx.$queryRaw<readonly { attempt: number | null }[]>(Prisma.sql`
    UPDATE "payment_operation"
    SET "status" = 'fenced', "completed_at" = ${now}::timestamptz
    WHERE "deposit_id" = ${depositId}::uuid
      AND "kind" = 'hold'
      AND "status" = 'pending'
      AND "tries" = 0
      AND "claimed_at" IS NULL
    RETURNING "attempt"
  `);
  return rows.flatMap((row) => {
    const attempt = toInt(row.attempt);
    return attempt === null ? [] : [attempt];
  });
}

/**
 * Releases every hold of a meetup's deposits that is not final, which serves decline, lapse, cancel, block, account
 * deletion and the release side of `lock_lost`. For each deposit it first fences the holds that were never sent, so
 * the meetup's end cannot race a create into leaving an authorization outstanding at the processor.
 */
export async function releaseAllOpen(
  tx: DbTx,
  meetupId: string,
  now: Date,
): Promise<PaymentOperation[]> {
  const deposits = await depositsForMeetup(tx, meetupId);
  const planned: PaymentOperation[] = [];
  for (const deposit of deposits) {
    if (!RELEASABLE_DEPOSIT_STATUSES.has(deposit.status)) {
      continue;
    }
    // Fencing runs whichever way the decision below goes, so no authorization can follow the meetup's
    // end; what it fenced is read back through the current attempt's hold row, not from its return.
    await fenceNeverSentHolds(tx, deposit.id, now);
    const currentHold = await findHoldOperation(tx, deposit.id, deposit.currentAttempt);
    if (hasNoAuthorization(currentHold)) {
      await advanceDeposit(
        tx,
        { depositId: deposit.id, attempt: deposit.currentAttempt },
        'released',
      );
    }
    for (let attempt = 1; attempt <= deposit.currentAttempt; attempt += 1) {
      const hold = await findHoldOperation(tx, deposit.id, attempt);
      if (hold === null || hold.status === 'fenced') {
        continue;
      }
      if (await hasCaptureOrRelease(tx, deposit.id, attempt)) {
        continue;
      }
      planned.push(
        await planRelease(
          tx,
          { deposit, attempt, paymentIntentId: hold.paymentIntentId, dependsOnId: hold.id },
          now,
        ),
      );
    }
  }
  return planned;
}

/**
 * True when the attempt has no authorization at Stripe to cancel, so nothing will ever confirm a release of it and
 * the deposit may be marked `released` at once.
 *
 * A PaymentIntent id can exist under an attempt's key only once a create was sent under that key, so a `hold`
 * operation that records no id on a terminal row proves the create never reached the provider.
 */
function hasNoAuthorization(hold: PaymentOperation | null): boolean {
  if (hold === null) {
    return true;
  }
  if (isHandedOffHold(hold)) {
    return false;
  }
  return isTerminalOperation(hold.status) && hold.paymentIntentId === null;
}

/** What {@link fenceCaptures} found: what it fenced, and the capture a reversal must wait for. */
export interface FencedCaptures {
  /** The ids of the `pending` and `failed_retryable` captures that were fenced. */
  readonly fencedIds: string[];
  /** A capture still `executing`, which cannot be fenced, or null when there is none. */
  readonly executing: PaymentOperation | null;
  /** The deposit's latest capture in any status after fencing, or null when it has none. */
  readonly capture: PaymentOperation | null;
}

/**
 * Fences the captures a resolution has superseded, so none of them can run afterwards. An operator `no_fault` or a
 * hold-loss compensation supersedes the capture it decided against. A capture still `executing` cannot be fenced —
 * its call is already with Stripe — so it is returned instead.
 */
export async function fenceCaptures(
  tx: DbTx,
  depositId: string,
  now: Date,
): Promise<FencedCaptures> {
  const rows = await tx.$queryRaw<readonly { id: string }[]>(Prisma.sql`
    UPDATE "payment_operation"
    SET "status" = 'fenced', "completed_at" = ${now}::timestamptz
    WHERE "deposit_id" = ${depositId}::uuid
      AND "kind" = 'capture'
      AND "status" IN ('pending', 'failed_retryable')
    RETURNING "id"
  `);
  const executing = await tx.paymentOperation.findFirst({
    where: { depositId, kind: 'capture', status: 'executing' },
    orderBy: { seq: 'desc' },
  });
  const capture = await tx.paymentOperation.findFirst({
    where: { depositId, kind: 'capture' },
    orderBy: { seq: 'desc' },
  });
  return { fencedIds: rows.map((row) => row.id), executing, capture };
}

/**
 * Plans the refund that reverses a capture. The reversal depends on `captureOp`, so a refund can never run before an
 * outstanding capture is reconciled, and it carries that capture's attempt and PaymentIntent so the executor can
 * resolve it against the intent's actual state.
 */
export async function planReversal(
  tx: DbTx,
  deposit: Deposit,
  captureOp: PaymentOperation,
  now: Date,
): Promise<PaymentOperation> {
  return planRefund(
    tx,
    {
      deposit,
      attempt: captureOp.attempt ?? deposit.currentAttempt,
      paymentIntentId: captureOp.paymentIntentId,
      dependsOnId: captureOp.id,
    },
    now,
  );
}

// Lookups and views (AAP 0.5.3, 0.5.4)

/** The `hold` operation of one deposit attempt, by its key (AAP 0.3.2). */
export async function findHoldOperation(
  tx: DbTx,
  depositId: string,
  attempt: number,
): Promise<PaymentOperation | null> {
  return tx.paymentOperation.findUnique({
    where: { idempotencyKey: holdKey(depositId, attempt) },
  });
}

/**
 * The operation of the named kinds recorded for a PaymentIntent, earliest first. The webhook handler uses it to turn
 * a PaymentIntent id back into the attempt it concerns; it reads the `paymentIntentId` index.
 */
export async function findOperationForIntent(
  tx: DbTx,
  paymentIntentId: string,
  kinds?: readonly PaymentOperationKind[],
): Promise<PaymentOperation | null> {
  return tx.paymentOperation.findFirst({
    where: { paymentIntentId, kind: { in: kinds === undefined ? ['hold'] : [...kinds] } },
    orderBy: { seq: 'asc' },
  });
}

/**
 * True when a capture or a release is already planned for this attempt. It backs the late and orphan authorization
 * rule: a `requires_capture` event arriving after the money decision was taken is acknowledged and ignored, because
 * the decision is durable already and the executor's own retrieval settles the actual state.
 */
export async function hasCaptureOrRelease(
  tx: DbTx,
  depositId: string,
  attempt: number,
): Promise<boolean> {
  const found = await tx.paymentOperation.findFirst({
    where: { depositId, attempt, kind: { in: ['capture', 'release'] } },
    select: { id: true },
  });
  return found !== null;
}

/**
 * A meetup's deposits, ordered by role: the role enum's declaration order, so `initiator` precedes `recipient` and a
 * caller needing a stable pairing — the settlement that retrieves both PaymentIntents — reads the same order every
 * time.
 */
export async function depositsForMeetup(tx: DbTx, meetupId: string): Promise<Deposit[]> {
  return tx.deposit.findMany({ where: { meetupId }, orderBy: { role: 'asc' } });
}

/**
 * The caller-visible hold state of one side of a meetup: `none` when that side has no deposit, otherwise the current
 * attempt's status. `meetups/queries.ts` and the `MeetupStatusFrame` push both read it, so the two surfaces cannot
 * disagree.
 */
export function holdView(deposit: Pick<Deposit, 'status'> | null): HoldView {
  return deposit === null ? 'none' : deposit.status;
}
