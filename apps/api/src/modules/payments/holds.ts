/**
 * The deposit lifecycle and the durable `PaymentOperation` planners — the database-only leaf that
 * `meetups/state-machine.ts`, `meetups/queries.ts` and `settlement/settle.ts` import.
 *
 * Every Stripe mutation is a `PaymentOperation` row written inside the domain transaction that
 * decides it, with the status change, the analytics events and the outbox rows, and executed by
 * `operations.ts` after that transaction commits (AAP 0.3.2 "Stripe mutations"). Three properties
 * make such a row safe to replay:
 *
 * - **The key names the attempt**, so a superseded attempt and the current one never share a key and
 *   every retry of one operation sends byte-identical parameters under its own key (AAP 0.3.2).
 * - **`seq` is monotonic per deposit and `dependsOnId` names the operation that must finish first**,
 *   so a release never runs before the hold it releases and a refund never before the capture it
 *   reverses. {@link nextSeq} is race-free only because every planner runs inside a caller's
 *   transaction that already holds the meetup row lock (AAP 0.5.3 serialization).
 * - **A deposit moves forward only** ({@link advanceDeposit}, {@link fromStatusesFor}): a late,
 *   historical or backwards provider event is acknowledged and ignored rather than applied.
 *
 * The file is a leaf by design: it imports `@tablemate/db` and `@tablemate/shared` and nothing else —
 * no sibling module, no `plugins/errors.ts`, no `stripe`, no `server-core`. It never opens a
 * transaction, never makes a network call and never decides a caller's error: a planner returns the
 * reason it could not write its row and the caller maps that to the `AppError` the contract names
 * (AAP 0.5.4). A leaf cannot inject the clock either, so a function that writes a timestamp takes
 * `now: Date` last and the caller passes `services.clock.now()`; `createdAt` in particular drives the
 * executor's 12-hour rule (AAP 0.11.1).
 *
 * @see AAP 0.3.2 for keys, claiming, ordering, fencing and reconciliation, 0.5.1 for this module's
 *   place in the payments component, 0.5.2 for the `Deposit` and `PaymentOperation` models, 0.5.3 for
 *   the deposit and meetup lifecycles, 0.5.4 for the error envelope, and 0.8.1 for this file.
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

// ---------------------------------------------------------------------------------------------
// Idempotency keys (AAP 0.3.2 "Keys name the PaymentIntent attempt")
// ---------------------------------------------------------------------------------------------
// Stripe keys keep `:` and the attempt number, unlike BullMQ custom job ids, which use `-` because a
// `:` is reserved there. Only the builders below spell out a Stripe key.

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
 * The key of the refund reversing attempt `attempt`: `refund:<depositId>:<attempt>` (AAP 0.3.2). It
 * names the attempt whose money is returned, never the capture's, so two reversals of two captures on
 * one deposit cannot collide.
 */
export function refundKey(depositId: string, attempt: number): string {
  return `refund:${depositId}:${attempt}`;
}

/**
 * The key of the deletion of `userId`'s Stripe customer: `delete_customer:<userId>` (AAP 0.3.2). A
 * customer outlives every attempt of every deposit of its owner, so this key carries neither and a
 * second `DELETE /me` replays one deletion rather than creating a second operation.
 */
export function deleteCustomerKey(userId: string): string {
  return `delete_customer:${userId}`;
}

// ---------------------------------------------------------------------------------------------
// The deposit status table (AAP 0.5.3)
// ---------------------------------------------------------------------------------------------

/**
 * The deposit lifecycle of AAP 0.5.3 as a table: the statuses each status may move to, and no others.
 * `released`, `captured`, `expired` and `refunded` are final. The two deliberate absences are what the
 * row "Forward-only" requires: `held` never returns to `pending`, and `captured` never to `held`.
 *
 * `failed → released` is the row the late-and-orphan-authorization rule supplies: "the current attempt
 * of a meetup that reached a final state with no capture or release decided for it … marks the attempt
 * `released`". It is what lets a declined attempt's deposit reach a final status, without which the
 * `delete_customer` gate — which runs only once every one of the user's deposits is final — can never
 * open and the Stripe customer is never erased (AAP 0.5.2). It closes a deposit's life and never
 * revives one: `failed` still returns to `pending` for a retry only, `held` still never returns to
 * `pending`, `captured` still never to `held`, and the four final statuses stay final.
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
 * The deposit statuses {@link releaseAllOpen} acts on: every status that is not final, which is what
 * AAP 0.5.3 names as `pending`, `requires_action`, `held` and `failed`. Derived rather than spelled
 * out, so a status added to the domain enum is either final and excluded, or open and picked up.
 *
 * Every status this set holds can reach `released` in {@link DEPOSIT_TRANSITIONS}, which is what makes
 * the {@link advanceDeposit} result {@link releaseAllOpen} discards unable to be false: an open deposit
 * either has nothing left at Stripe for a release to cancel, or keeps the status it had until the
 * executor or the webhook confirms that release. `failed` stays in the set because its release
 * operation is still required — AAP 0.5.3: "Release operations for every non-final deposit attempt".
 */
const RELEASABLE_DEPOSIT_STATUSES: ReadonlySet<DepositStatus> = new Set(
  DEPOSIT_STATUSES.filter(
    (status) => !FINAL_DEPOSIT_STATUSES.some((finalStatus) => finalStatus === status),
  ),
);

/**
 * True when a deposit may move from `from` to `to` (AAP 0.5.3).
 *
 * @param from - The deposit's current status.
 * @param to - The status an event asks it to take.
 * @returns True for an allowed transition, false for anything else, a backwards move included.
 */
export function canTransitionDeposit(from: DepositStatus, to: DepositStatus): boolean {
  return DEPOSIT_TRANSITIONS[from].some((allowed) => allowed === to);
}

/**
 * The inverse lookup: every status a deposit may hold before it takes `to` (AAP 0.5.3).
 *
 * @param to - The status the deposit is about to take.
 * @returns The statuses `to` may be reached from, in the domain enum's order.
 */
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
 * The fields an event may record while it moves a deposit forward (AAP 0.5.2). An absent key leaves
 * the column as it is: `exactOptionalPropertyTypes` keeps `undefined` out of the update rather than
 * clearing a value the event never mentioned.
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
 * The single forward-only, attempt-scoped deposit write (AAP 0.5.3 "Forward-only").
 *
 * It filters on the deposit's id, its `currentAttempt` and the statuses {@link fromStatusesFor} allows
 * before `to`, so the row moves only when the event still concerns the current attempt and still moves
 * it forward; a false result is an event the caller acknowledges and ignores.
 *
 * @param tx - The caller's transaction, already holding the meetup row lock (AAP 0.5.3).
 * @param ref - The deposit and the attempt the event concerns.
 * @param to - The status the deposit takes.
 * @param data - The fields the event records on the way, each left untouched when absent.
 * @returns True when exactly one row moved.
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

// ---------------------------------------------------------------------------------------------
// Operation status tables (AAP 0.3.2)
// ---------------------------------------------------------------------------------------------

/**
 * The statuses that end an operation's life: the executor's success, a failure it will not retry, and
 * a plan a later decision superseded before it was sent (AAP 0.3.2 "Fencing"). None blocks the
 * operation that depends on it.
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
 * The `last_error` values that mean a hold create was handed to the operator: twelve hours without a
 * resolved replay, and an idempotency conflict the gateway could not resolve (AAP 0.3.2).
 */
export const HOLD_HAND_OFF_MARKERS = ['unresolved_12h', 'idempotency_error'] as const;

/** One of {@link HOLD_HAND_OFF_MARKERS}: the marker a hand-off writes to an operation's `last_error`. */
export type HoldHandOffMarker = (typeof HOLD_HAND_OFF_MARKERS)[number];

/**
 * True when a `hold` operation was handed to the operator instead of being resolved (AAP 0.3.2).
 *
 * Such a row is still `failed_terminal`, and it is **not** proof that the attempt left nothing at
 * Stripe: the create may have succeeded with an answer we never learned, so no PaymentIntent id is
 * recorded anywhere and there may be an authorization under the row's key that only an operator can
 * settle. Nothing may assume otherwise — not {@link releaseAllOpen}, which would otherwise declare
 * that authorization released, and not {@link startNewAttempt}, which would otherwise authorize a
 * second time under a new attempt's key while the first may still be live.
 *
 * @param operation - The operation row, or the two fields this reads off one.
 * @returns True for a hold whose create was handed to the operator.
 */
export function isHandedOffHold(operation: Pick<PaymentOperation, 'kind' | 'lastError'>): boolean {
  if (operation.kind !== 'hold') {
    return false;
  }

  const marker = operation.lastError;
  return marker !== null && HOLD_HAND_OFF_MARKERS.some((handOff) => handOff === marker);
}

/**
 * The statuses an operation may still be claimed from (AAP 0.3.2). A row left `executing` past two
 * minutes is a call whose answer was lost, not a call that is running.
 */
export const OPEN_OPERATION_STATUSES = [
  'pending',
  'executing',
  'failed_retryable',
] as const satisfies readonly PaymentOperationStatus[];

// ---------------------------------------------------------------------------------------------
// Planning an operation (AAP 0.3.2 "Stripe mutations")
// ---------------------------------------------------------------------------------------------

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
 * Reads an integer a raw statement returned. PostgreSQL `INTEGER` reaches JavaScript as a number and
 * `BIGINT` as a bigint, and a driver change could hand back a digit string, so all three are accepted
 * rather than assumed.
 *
 * @param value - The column value as the driver reported it.
 * @returns The integer, or null when the value is not one.
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

/**
 * The next free `seq` for a deposit: one past the highest one it already has (AAP 0.3.2). A deposit
 * with no operation yet starts at 1.
 *
 * @param tx - The caller's transaction, already holding the meetup row lock.
 * @param depositId - The deposit whose operations are ordered.
 * @returns The next `seq`, an integer of at least 1.
 */
export async function nextSeq(tx: DbTx, depositId: string): Promise<number> {
  const rows = await tx.$queryRaw<readonly { nextSeq: number | null }[]>(Prisma.sql`
    SELECT COALESCE(MAX("seq"), 0) + 1 AS "nextSeq"
    FROM "payment_operation"
    WHERE "deposit_id" = ${depositId}::uuid
  `);

  return toInt(rows[0]?.nextSeq ?? null) ?? 1;
}

/**
 * Writes one operation row, or hands back the row its key already names (AAP 0.3.2).
 *
 * `skipDuplicates` is PostgreSQL's `ON CONFLICT ("idempotency_key") DO NOTHING`, so re-planning a key
 * that exists — a repeated accept, a second `DELETE /me`, a sweeper pass over a decision already
 * written — is an idempotent no-op. The unique violation it suppresses must never be caught instead:
 * in PostgreSQL any error aborts the whole transaction, taking the status change, the analytics events
 * and the outbox rows the caller decided with it.
 *
 * @param tx - The caller's transaction, already holding the meetup row lock.
 * @param row - The operation to plan, with its key already built.
 * @param now - The injected clock's instant, written to `createdAt` so the executor's 12-hour rule
 *   measures from when the decision was taken.
 * @returns The operation row, newly written or already present.
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
 * Plans the hold of one attempt: `hold:<depositId>:<attempt>` (AAP 0.5.3).
 *
 * The PaymentIntent id stays null because it does not exist until the executor creates the intent.
 * The hold needs no `dependsOnId`: its `seq` is the lowest still open on the deposit.
 *
 * @param tx - The caller's transaction, already holding the meetup row lock.
 * @param ref - The deposit and the attempt to hold.
 * @param now - The injected clock's instant.
 * @returns The `hold` operation row.
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
 * Plans the release of one attempt's authorization: `release:<depositId>:<attempt>` (AAP 0.5.3).
 *
 * A null `paymentIntentId` is accepted and kept: while an attempt's create is ambiguous there is no id
 * to name, and the executor resolves it from that attempt's hold operation, whose replay is the only
 * way to learn it.
 *
 * @param tx - The caller's transaction, already holding the meetup row lock.
 * @param ref - The deposit, the attempt, the intent to cancel and the hold it follows.
 * @param now - The injected clock's instant.
 * @returns The `release` operation row.
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
 * Plans the capture of one attempt's hold: `capture:<depositId>:<attempt>` (AAP 0.5.3).
 *
 * The capture is ordered after the hold by its higher `seq` alone: by the time it is claimed, the hold
 * that created the intent is terminal (AAP 0.3.2 ordering).
 *
 * @param tx - The caller's transaction, already holding the meetup row lock.
 * @param ref - The deposit, the attempt and the intent to capture.
 * @param now - The injected clock's instant.
 * @returns The `capture` operation row.
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
 * Plans the refund reversing one attempt: `refund:<depositId>:<attempt>` (AAP 0.3.2 "Fencing").
 *
 * `dependsOnId` is required here, so no refund runs while a capture it reverses is outstanding. The
 * executor resolves the intent against its actual state — captured is refunded, uncaptured is
 * cancelled, cancelled needs nothing — so a null `paymentIntentId` only means the id must come from
 * the deposit's current attempt.
 *
 * @param tx - The caller's transaction, already holding the meetup row lock.
 * @param ref - The deposit, the attempt, the intent to reverse and the operation it depends on.
 * @param now - The injected clock's instant.
 * @returns The `refund` operation row.
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
 * Plans the deletion of a user's Stripe customer: `delete_customer:<userId>` (AAP 0.5.3).
 *
 * The operation carries its own copy of the customer id, so `account-erasure` can null
 * `User.stripeCustomerId` without losing the id the executor still needs (AAP 0.5.2). A null id still
 * writes the row — the executor treats it as a satisfied no-op — so "a user has exactly one deletion
 * operation" holds whether or not a card was ever saved.
 *
 * @param tx - The caller's transaction, already holding the user row lock (AAP 0.5.3).
 * @param userId - The user whose customer is deleted; the operation's explicit target.
 * @param stripeCustomerId - The id to delete, or null when the user has no customer.
 * @param now - The injected clock's instant.
 * @returns The `delete_customer` operation row.
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

// ---------------------------------------------------------------------------------------------
// Attempts, bulk release and fencing (AAP 0.3.2, 0.5.3)
// ---------------------------------------------------------------------------------------------

/**
 * The outcome of {@link startNewAttempt}: the new attempt and its hold, or why none was started.
 *
 * `hold_pending` is the caller's `409 hold_pending` and `not_failed` its `409 not_proposed`
 * (AAP 0.5.4). `hold_pending` is the answer whenever the current attempt is still unresolved — a
 * create in flight, an ambiguous create waiting for its replay, or one handed to the operator —
 * because the meetup **is** proposed, so `409 not_proposed` would tell the client it is not;
 * `not_failed` is the answer only when this deposit has nothing left to recover. This leaf names the
 * reason and leaves the mapping to the route.
 */
export type StartAttemptResult =
  | { readonly ok: true; readonly attempt: number; readonly holdOp: PaymentOperation }
  | { readonly ok: false; readonly reason: 'hold_pending' | 'not_failed' };

/**
 * Starts the next hold attempt of a `failed` deposit (AAP 0.5.3 `failed → pending`).
 *
 * This is the retry behind `POST /meetups/:id/hold` and a repeated `POST /meetups/:id/accept`. The
 * rule it enforces is that the retry may not proceed while the current attempt is unresolved, which
 * is either a `pending` deposit — its attempt never reached a conclusion, be that a create in
 * flight, an ambiguous create being replayed, or one handed to the operator — or a `failed` deposit
 * whose current attempt's `hold` row is not terminal. Both answer `hold_pending`, because an
 * ambiguous create's replay is the only way to learn its PaymentIntent id and a second attempt would
 * risk a second authorization (AAP 0.3.2). A deposit with nothing to recover answers `not_failed`:
 * `held`, `requires_action`, `released`, `captured`, `expired`, `refunded`, or a `failed` deposit
 * whose hold row is terminal, and that last one starts attempt `n + 1`. A superseded attempt never
 * keeps its authorization: its PaymentIntent, when the hold recorded one, is released under its own
 * attempt's key.
 *
 * The guarded deposit move runs before anything is planned, so a refused retry writes nothing, and it
 * clears `currentPaymentIntentId`, `captureBefore` and `canceledAt`, which all belong to the attempt
 * that just ended — a stale `canceledAt` would otherwise read as a hold loss of the new attempt in the
 * settlement compensation rule.
 *
 * @param tx - The caller's transaction, already holding the meetup row lock.
 * @param deposit - The deposit as the caller read it.
 * @param now - The injected clock's instant.
 * @returns The new attempt and its `hold` operation, or the reason none was started.
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
 * Fences the `hold` operations that were planned but never sent, and reports their attempts.
 *
 * Such a row has `tries` 0, no `claimed_at` and is still `pending`, so no call to Stripe was ever made
 * under its key; fencing it guarantees no authorization can be created after the meetup ends. A hold
 * that is `executing` or `failed_retryable` is deliberately left alone: it may have reached Stripe,
 * and its replay is the only way to learn the PaymentIntent id a release needs.
 *
 * @param tx - The caller's transaction, already holding the meetup row lock.
 * @param depositId - The deposit whose unsent holds are fenced.
 * @param now - The injected clock's instant, written to `completedAt`.
 * @returns The attempt numbers that were fenced.
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
 * Releases every hold of a meetup's deposits that is not final (AAP 0.5.3 "Release operations for
 * every non-final deposit attempt").
 *
 * It serves decline, lapse, cancel, block, account deletion and the release side of `lock_lost`. For
 * each deposit it first fences the holds that were never sent, so the meetup's end can never be
 * followed by a new authorization, and then plans one release per attempt that might hold one; a
 * release already planned under its attempt's key is a no-op, so a repeated call is safe.
 *
 * The deposit moves to `released` only when its current attempt has nothing left at Stripe for a
 * release to cancel; a hold that was fenced as never sent is one way an attempt ends that way.
 * Otherwise the executor or the webhook confirms the cancel and {@link advanceDeposit} records it then,
 * so a release that fails is retried rather than believed.
 *
 * @param tx - The caller's transaction, already holding the meetup row lock.
 * @param meetupId - The meetup whose deposits are released.
 * @param now - The injected clock's instant.
 * @returns The release operations this call wrote; an attempt that already has one is left to its
 *   existing operation, so a repeated call adds nothing and returns fewer rows.
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
 * True when the attempt has no authorization at Stripe to cancel, so nothing will ever confirm a
 * release of it and the deposit may be marked `released` at once.
 *
 * A PaymentIntent id can exist under an attempt's key only once a create was sent under that key, so a
 * `hold` operation that records no id on a terminal row is proof that nothing is outstanding there. A
 * definite rejection never creates an intent and ends the row terminal; {@link fenceNeverSentHolds}
 * only fences a row that was never claimed and never tried, so a fenced row is the same proof. An
 * ambiguous create is deliberately none of these: it stays `executing` or `failed_retryable` until its
 * replay resolves it (AAP 0.3.2), and an attempt with no `hold` operation at all never had a create
 * planned for it.
 *
 * A row that is not terminal is no proof, however few times it was tried: a claimed row may still
 * reach Stripe, because claiming reserves the call and a replay under the same key performs it. Such a
 * row is what {@link fenceNeverSentHolds} leaves alone, and the attempt it belongs to keeps the
 * deposit's status until the executor or the webhook confirms the release. A `failed` deposit whose
 * hold was never sent is still released at once, because the fence in this same transaction moves that
 * row to `fenced`: terminal, and carrying no id.
 *
 * A **handed-off** row ({@link isHandedOffHold}) is the third case, and the one this function must
 * never wave through: its status is terminal and it records no id, yet the create may have succeeded
 * with an answer we never learned, so an authorization under its key may still be live. Declaring the
 * deposit `released` over it would say an authorization was released that nobody has cancelled, which
 * AAP 0.5.3's "never leaves an authorization outstanding" forbids; the attempt is therefore left to
 * the operator, and the deposit keeps its status.
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
 * Fences the captures a resolution has superseded, so none of them can run afterwards (AAP 0.3.2
 * "Fencing").
 *
 * An operator `no_fault` or a hold-loss compensation supersedes the capture it decided against. A
 * capture still `executing` cannot be fenced — its call is already with Stripe — so it is returned
 * instead and the reversal that depends on it waits for it to finish, then applies the same rule.
 * Fencing happens first, so `capture` is what a reversal must depend on whatever the outcome.
 *
 * @param tx - The caller's transaction, already holding the meetup row lock.
 * @param depositId - The deposit whose captures are fenced.
 * @param now - The injected clock's instant, written to `completedAt`.
 * @returns The fenced ids, the executing capture and the deposit's latest capture.
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
 * Plans the refund that reverses a capture (AAP 0.3.2 "Fencing").
 *
 * The reversal depends on `captureOp`, so a refund can never run before an outstanding capture is
 * reconciled, and it carries that capture's attempt and PaymentIntent so the executor can resolve it
 * against the intent's actual state.
 *
 * @param tx - The caller's transaction, already holding the meetup row lock.
 * @param deposit - The deposit whose decision is being reversed.
 * @param captureOp - The capture the reversal follows, from {@link fenceCaptures}.
 * @param now - The injected clock's instant.
 * @returns The `refund` operation row.
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

// ---------------------------------------------------------------------------------------------
// Lookups and views (AAP 0.5.3, 0.5.4)
// ---------------------------------------------------------------------------------------------

/**
 * The `hold` operation of one deposit attempt, by its key (AAP 0.3.2).
 *
 * @param tx - The caller's transaction, or any client in its chain.
 * @param depositId - The deposit the attempt belongs to.
 * @param attempt - The attempt number, from 1.
 * @returns The operation, or null when that attempt was never planned.
 */
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
 * The operation of the named kinds recorded for a PaymentIntent, earliest first (AAP 0.3.2).
 *
 * The webhook handler uses it to turn a PaymentIntent id back into the attempt it concerns: the hold
 * by default, and whatever other kinds a rule needs. It reads the `paymentIntentId` index.
 *
 * @param tx - The caller's transaction.
 * @param paymentIntentId - The provider id to correlate.
 * @param kinds - The kinds to search, defaulting to the `hold` operation.
 * @returns The earliest matching operation, or null when this intent is unknown to Tablemate.
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
 * True when a capture or a release is already planned for this attempt (AAP 0.5.3).
 *
 * It backs the late and orphan authorization rule: a `requires_capture` event arriving after the money
 * decision was taken is acknowledged and ignored, because the decision is durable already and the
 * executor's own retrieval settles the actual state.
 *
 * @param tx - The caller's transaction.
 * @param depositId - The deposit the attempt belongs to.
 * @param attempt - The attempt number, from 1.
 * @returns True when a `capture` or `release` operation exists for that attempt.
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
 * A meetup's deposits, ordered by role (AAP 0.5.3).
 *
 * The order is the role enum's declaration order, so `initiator` precedes `recipient` and a caller
 * needing a stable pairing — the settlement that retrieves both PaymentIntents, for instance — reads
 * the same order every time.
 *
 * @param tx - The caller's transaction.
 * @param meetupId - The meetup whose deposits are read.
 * @returns The deposits, `initiator` first, then `recipient`.
 */
export async function depositsForMeetup(tx: DbTx, meetupId: string): Promise<Deposit[]> {
  return tx.deposit.findMany({ where: { meetupId }, orderBy: { role: 'asc' } });
}

/**
 * The caller-visible hold state of one side of a meetup (AAP 0.5.4).
 *
 * `MeetupDto.initiatorHold` and `.recipientHold` carry `none` when that side has no deposit and
 * otherwise the current attempt's status, which is what this returns. `meetups/queries.ts` and the
 * `MeetupStatusFrame` push of the WebSocket both read it, so the two surfaces cannot disagree.
 *
 * @param deposit - The side's deposit, or null when that side has not placed one.
 * @returns `none` for a missing deposit, otherwise the deposit's current status.
 */
export function holdView(deposit: Pick<Deposit, 'status'> | null): HoldView {
  return deposit === null ? 'none' : deposit.status;
}
