/**
 * The Stripe webhook: `POST /v1/webhooks/stripe`, applied exactly once in one transaction (AAP 0.3.2, 0.3.3,
 * 0.5.1, 0.5.3, 0.6.2).
 *
 * A provider event is the only thing that moves an authorization no request of ours could observe — a 3-D Secure
 * step completed later, a hold Stripe expired, a capture we asked for — so the endpoint rests on one property:
 * **every database effect of an event, and the record that the event was applied, commit together or not at all.**
 * Five rules follow from it.
 *
 *  1. **Signature first.** `registerRawJsonBody` keeps the received bytes on `request.rawBody` and the gateway
 *     checks the `Stripe-Signature` header against them; a missing header or body, a timestamp outside tolerance or
 *     a signature made with another secret is `400 bad_signature` and applies nothing (AAP 0.3.2, 0.3.3). A signed
 *     body that is no Stripe event at all is acknowledged `200`, logged `stripe_webhook_not_an_event` and applied
 *     to nothing, since it carries no id to dedupe on and no effect to write.
 *  2. **One transaction per event.** The `stripe_event` row is inserted `ON CONFLICT DO NOTHING` and locked, every
 *     effect is applied, then the row is marked `processed`: a replay answers `200` with no effect, and a crash
 *     before the commit rolls the record back with the effects (AAP 0.3.2).
 *  3. **Correlation by PaymentIntent** — through the attempt's durable `hold` operation, then
 *     `Deposit.currentPaymentIntentId`, then the `attempt` metadata this application wrote — never by deposit alone
 *     and never by `created`, which has second precision (AAP 0.2.2, AAP 0.5.3).
 *  4. **Forward-only.** Every deposit write goes through `advanceDeposit`, so a late, historical or out-of-order
 *     event is acknowledged and ignored rather than applied (AAP 0.5.3).
 *  5. **No Stripe call inside the transaction.** An intent missing a field an effect needs is retrieved before it
 *     opens, and these writes only *plan* `PaymentOperation` rows, which the executor runs after the commit with
 *     the settlement sweeper as the backstop.
 *
 * The meetup row is locked before any change to it or to a deposit, so this handler serializes with cancellation,
 * check-in, dispute filing, settlement and an operator resolution. The lines carry an event id, a type, a deposit
 * id, a status word and a failure's short token, and never a payload, a client secret, a customer id, a card detail,
 * an error message or a stack (AAP 0.11.1).
 */

import { z } from 'zod';

import {
  ErrorEnvelope,
  HANDLED_STRIPE_EVENT_TYPES,
  OUR_CANCELLATION_REASON,
  STRIPE_SIGNATURE_HEADER,
  isFinalMeetupStatus,
  type MeetupStatus,
} from '@tablemate/shared';
import { Prisma, type DbTx, type Deposit, type Meetup, type PaymentOperation } from '@tablemate/db';

import { AppError } from '../../plugins/errors.ts';
import type { OpenApiTag } from '../../plugins/openapi.ts';
import { webhookLimits } from '../../plugins/rate-limit.ts';
import { registerRawJsonBody } from '../../plugins/raw-body.ts';

import { applyHoldOutcome, lockMeetup, transition } from '../meetups/state-machine.ts';
import { transact, type AfterCommit } from '../outbox/write.ts';
import { applyHoldLossInTx, compensateLostHold } from '../settlement/settle.ts';

import {
  BadSignatureError,
  PaymentRejectedError,
  PaymentUnavailableError,
  type IntentState,
  type VerifiedWebhookEvent,
} from './gateway.ts';
import {
  advanceDeposit,
  findHoldOperation,
  findOperationForIntent,
  hasCaptureOrRelease,
  planRelease,
} from './holds.ts';
import { runOperationsFor } from './operations.ts';

// Type-only: `app.ts` is the one declaration of the app's type and of what it hands its modules, it is erased at
// compile time, and nothing of that module is read here at runtime.
import type { App, AppServices } from '../../app.ts';

/** The tag the route groups under: a member of the document's own vocabulary (AAP 0.11.2). */
const WEBHOOKS_TAG = 'webhooks' satisfies OpenApiTag;

/**
 * The event types this handler applies (AAP 0.3.3). Every other type is recorded `processed` and acknowledged
 * without effect, so a type Stripe adds later can never fail the endpoint.
 */
const HANDLED_TYPES: ReadonlySet<string> = new Set(HANDLED_STRIPE_EVENT_TYPES);

/**
 * The meetup statuses whose outcome a lost hold can still reverse (AAP 0.3.2): a forfeit has money
 * to give back, while a `completed` or `unattended` settlement releases both holds anyway.
 * `compensateLostHold` decides which of the two it is.
 */
const COMPENSABLE_STATUSES: ReadonlySet<MeetupStatus> = new Set([
  'forfeited',
  'completed',
  'unattended',
]);

/**
 * The fault points a test run may throw from (AAP 0.11.2). The first sits inside the transaction, so
 * a throw rolls the event row back with every effect it describes and Stripe's redelivery is applied
 * exactly once; the second sits after the commit, so a throw answers `500` while the committed
 * effects stand and the outbox poller and the sweeper deliver the rest.
 */
const FAULT_AFTER_EVENT_INSERT = 'stripe_webhook.after_event_insert';
const FAULT_AFTER_COMMIT = 'stripe_webhook.after_commit';

/** The log event names this file writes (AAP 0.11.1); none of them carries a payload. */
const RECEIVED = 'stripe_webhook_received';
const NOT_AN_EVENT = 'stripe_webhook_not_an_event';
const LATE_AUTHORIZATION = 'stripe_webhook_late_authorization';
const ORPHAN_AUTHORIZATION = 'stripe_webhook_orphan_authorization';
const HOLD_LOST = 'stripe_webhook_hold_lost';
const INTENT_UNEXPECTED = 'stripe_webhook_intent_state_unexpected';
const OPERATIONS_FAILED = 'stripe_webhook_operations_failed';

/**
 * The one log event name each delivery result writes, keyed by the result rather than written at each return, so
 * every path out of the transaction is logged once and in one shape (AAP 0.11.1).
 */
const OUTCOME_LOGS: Readonly<Record<WebhookOutcome['result'], string>> = {
  applied: 'stripe_webhook_applied',
  ignored: 'stripe_webhook_ignored',
  duplicate: 'stripe_webhook_duplicate',
  unmatched: 'stripe_webhook_unmatched',
};

/** The HTTP status every accepted delivery answers with; Stripe retries anything else. */
const OK = 200;

/** The safe shape a logged failure token may have: a short identifier and nothing else. */
const FAILURE_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * What one delivery decided. `applied` wrote an effect, `ignored` found nothing the event could move (a late
 * authorization, a backwards deposit move, a superseded attempt), `duplicate` replayed an event already
 * `processed`, and `unmatched` named no deposit this application created. All four answer `200`.
 */
export interface WebhookOutcome {
  readonly result: 'applied' | 'ignored' | 'duplicate' | 'unmatched';
  /** The meetup the delivery touched, whose planned operations the handler then runs. */
  readonly meetupId?: string;
}

/** {@link WebhookOutcome} for a delivery that wrote an effect on `meetupId`. */
function applied(meetupId: string): WebhookOutcome {
  return { result: 'applied', meetupId };
}

/** {@link WebhookOutcome} for a delivery that moved nothing, on a known meetup. */
function ignored(meetupId: string): WebhookOutcome {
  return { result: 'ignored', meetupId };
}

/** {@link WebhookOutcome} for a PaymentIntent this application did not create. */
function unmatched(): WebhookOutcome {
  return { result: 'unmatched' };
}

/**
 * One event's PaymentIntent resolved to the deposit attempt it concerns (AAP 0.5.3 "Correlation"). The attempt
 * travels with the deposit because the money decision is made per attempt: a retried deposit has a superseded
 * attempt whose events are history, and the `hold` operation is the only durable record of which attempt a
 * PaymentIntent belongs to.
 */
interface Correlation {
  readonly deposit: Deposit;
  readonly attempt: number;
  /** The attempt's `hold` operation, or null when its create was never planned. */
  readonly holdOp: PaymentOperation | null;
}

/**
 * What every effect of this file is given: the transaction, the providers, the request's logger and the locked
 * rows.
 */
interface EffectContext {
  readonly tx: DbTx;
  readonly services: AppServices;
  /**
   * The request's own logger, so every line written after the response still carries this delivery's request id
   * (AAP 0.11.1).
   */
  readonly log: App['log'];
  readonly after: AfterCommit;
  readonly event: VerifiedWebhookEvent;
  readonly intent: IntentState;
  readonly correlation: Correlation;
  /** The meetup row, locked by this transaction before any change to it or to a deposit. */
  readonly meetup: Meetup;
  /** The instant this request was stamped with, from the injected clock (AAP 0.11.1). */
  readonly now: Date;
}

// ---------------------------------------------------------------------------------------------
// The route (AAP 0.5.1, 0.5.4)
// ---------------------------------------------------------------------------------------------

/**
 * Registers `POST /webhooks/stripe` on the context `app.ts` mounts under `/v1` (AAP 0.5.1).
 *
 * The plugin is encapsulated and is not a `fastify-plugin`, so the content-type parser `registerRawJsonBody`
 * replaces serves this route alone: Stripe signs the exact bytes it sent, and a re-serialized body would fail a
 * check on a genuine request (AAP 0.3.2, 0.3.3). The route carries no bearer guard, no age gate and no user, and it
 * takes only the webhook per-IP counter, because one provider's traffic arrives from a handful of addresses
 * (AAP 0.5.4). It declares no body schema: the shared event list with the gateway's own normalization decide what
 * may reach an effect.
 */
export function stripeWebhookRoutes(app: App): Promise<void> {
  registerRawJsonBody(app);
  app.post(
    '/webhooks/stripe',
    {
      ...webhookLimits(app),
      schema: {
        tags: [WEBHOOKS_TAG],
        summary: 'Stripe webhook (signature-checked)',
        // A public provider route declares no `security`: its signature is its authentication. The
        // `200` acknowledges the delivery and carries no body, and the two refusals the handler
        // raises are declared beside it: `400 bad_signature` when the header or the raw body is
        // unusable, and `503 payment_unavailable` when a PaymentIntent a missing field cannot be
        // read. Both appear in `docs/api/README.md`, and the document is generated from here.
        response: { [OK]: z.null(), 400: ErrorEnvelope, 503: ErrorEnvelope },
      },
    },
    async (request, reply) => {
      const services = app.services;
      const now = request.receivedAt;
      // The bytes exactly as received and the header that signs them, both required before anything
      // is read from the payload. Neither is logged.
      const header = request.headers[STRIPE_SIGNATURE_HEADER.toLowerCase()];
      const signature = typeof header === 'string' ? header : undefined;
      const rawBody = request.rawBody;
      if (rawBody === undefined || signature === undefined) {
        throw new AppError('bad_signature');
      }
      const event = verifySignature(services, rawBody, signature, now);
      if (event === null) {
        // The bytes were signed, but they are no event: there is nothing to apply and no id to dedupe
        // on, so answering anything but `2xx` would only make the provider redeliver a body that can
        // never be applied — the same reasoning an event naming an unknown intent is acknowledged by.
        request.log.warn({ event: NOT_AN_EVENT }, NOT_AN_EVENT);
        reply.code(OK).send(null);
        return;
      }
      // Ids and the type alone: an event payload is customer data (AAP 0.11.1).
      request.log.info({ event: RECEIVED, eventId: event.id, type: event.type }, RECEIVED);
      if (!HANDLED_TYPES.has(event.type)) {
        await recordUnapplied(services, event, now);
        reply.code(OK).send(null);
        return;
      }
      // One transaction, opened by this module's own entry point: the effect, the record that the
      // event was applied and the rows that plan follow-up provider calls commit together or not at
      // all (AAP 0.3.2, AAP 0.5.1).
      const outcome = await handleStripeEvent(services, request.log, event, now);
      // After the commit: a throw here answers `500` while the effects stand and the redelivery is
      // skipped as a duplicate (AAP 0.11.2).
      await services.faults.hit(FAULT_AFTER_COMMIT, { eventId: event.id });
      const name = OUTCOME_LOGS[outcome.result];
      request.log.info(
        { event: name, eventId: event.id, type: event.type, result: outcome.result },
        name,
      );
      if (outcome.meetupId !== undefined) {
        // Never awaited: the operations a delivery planned are carried out after the response, and
        // the 60-second sweeper is the backstop for anything that does not finish (AAP 0.3.2).
        void runOperationsFor(services, { meetupId: outcome.meetupId }).catch((error: unknown) => {
          request.log.error({
            event: OPERATIONS_FAILED,
            eventId: event.id,
            code: failureToken(error),
          });
        });
      }
      reply.code(OK).send(null);
    },
  );
  // Registration is synchronous, as in every plugin the composition root installs, so the returned
  // promise is already resolved and a caller may await it or not: the declared `Promise<void>` is
  // what keeps this plugin usable wherever Fastify's own plugin types expect one.
  return Promise.resolve();
}

/**
 * Verify the signature and normalize the event (AAP 0.3.2, 0.3.3), mapping `BadSignatureError` onto the contract's
 * `400 bad_signature` and letting anything else — a bug rather than a bad delivery — reach the error plugin as `500
 * internal_error`. The gateway's `null` answer passes straight through: signed bytes that are no event are the
 * route's to acknowledge.
 *
 * @throws AppError `bad_signature` (400) when the header is malformed, the timestamp is outside tolerance or the
 *   signature was made with another secret.
 */
function verifySignature(
  services: AppServices,
  rawBody: Buffer,
  signature: string,
  receivedAt: Date,
): VerifiedWebhookEvent | null {
  try {
    return services.payments.verifyWebhook(rawBody, signature, receivedAt);
  } catch (error) {
    if (error instanceof BadSignatureError) {
      throw new AppError('bad_signature', undefined, { cause: error });
    }
    throw error;
  }
}

/**
 * The PaymentIntent state this event's effect decides on, retrieved only when the payload lacks a field the effect
 * needs (AAP 0.3.2): an event payload does not expand `latest_charge`, so the capture deadline arrives from the
 * intent itself; a payload may omit a field this build cannot normalize; and a `charge.*` event carries a charge
 * rather than an intent, whose metadata, cancellation instant and refund state are read from it.
 *
 * Every branch answers with a state or `null`, so nothing between the signature check and the receipt line can throw
 * for a delivery whose signature was valid; a read that cannot be observed is the one exception, answering `503
 * payment_unavailable` through {@link retrieveIntent} so the provider redelivers.
 */
async function intentFor(
  services: AppServices,
  log: App['log'],
  event: VerifiedWebhookEvent,
): Promise<IntentState | null> {
  const { object } = event;
  if (object.kind === 'payment_intent') {
    if (object.intent === null) {
      return retrieveIntent(services, log, event, object.intentId);
    }
    const needsDeadline =
      event.type === 'payment_intent.amount_capturable_updated' &&
      object.intent.captureBefore === null;
    return needsDeadline ? retrieveIntent(services, log, event, object.intent.id) : object.intent;
  }
  if (object.kind === 'charge') {
    return object.paymentIntentId === null
      ? null
      : retrieveIntent(services, log, event, object.paymentIntentId);
  }
  // A setup intent is a saved card, not a hold: it concerns no deposit and is applied without one.
  return null;
}

/**
 * Read one PaymentIntent, mapping the gateway's failures onto what this endpoint must answer (AAP 0.3.2). A
 * retrieval that could not be observed answers `503 payment_unavailable`, so Stripe redelivers and nothing is
 * decided from a state nobody saw. A retrieval the provider refuses as missing answers `200` as an unmatched event
 * instead: there is nothing to correlate, no redelivery would ever change that, and retrying it forever would only
 * get the endpoint disabled.
 */
async function retrieveIntent(
  services: AppServices,
  log: App['log'],
  event: VerifiedWebhookEvent,
  paymentIntentId: string,
): Promise<IntentState | null> {
  try {
    return await services.payments.retrievePaymentIntent(paymentIntentId);
  } catch (error) {
    if (error instanceof PaymentUnavailableError) {
      throw new AppError('payment_unavailable', undefined, { cause: error });
    }
    if (error instanceof PaymentRejectedError) {
      log.warn(
        { event: OUTCOME_LOGS.unmatched, eventId: event.id, type: event.type },
        OUTCOME_LOGS.unmatched,
      );
      return null;
    }
    throw error;
  }
}

/**
 * Record an event type this application does not apply, and answer it `200` (AAP 0.3.3). The row is written
 * `processed` in one statement, so the dedupe key still suppresses a second delivery and nothing is left that
 * looks unapplied.
 */
async function recordUnapplied(
  services: AppServices,
  event: VerifiedWebhookEvent,
  now: Date,
): Promise<void> {
  await transact(services, async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "stripe_event" ("id", "type", "status", "received_at", "processed_at")
      VALUES (${event.id}, ${event.type}, 'processed', ${now}::timestamptz, ${now}::timestamptz)
      ON CONFLICT ("id") DO NOTHING
    `);
  });
}

// ---------------------------------------------------------------------------------------------
// The transaction (AAP 0.3.2 "Stripe webhooks")
// ---------------------------------------------------------------------------------------------

/**
 * Apply one verified delivery and report what it decided: the event-application step itself, at the name AAP 0.5.1
 * gives it — `handleStripeEvent(event)`, in a single transaction.
 *
 * It is the whole of this endpoint's transaction. The event's PaymentIntent is resolved first, read from the provider
 * when the payload lacks a field the effect needs (AAP 0.3.2), and everything the event means is then applied in one
 * transaction with the `stripe_event` row: a replay of a row already `processed` has no effect, and a crash before
 * the commit rolls the record back with every effect it describes. No provider call happens inside the transaction —
 * these writes only *plan* `PaymentOperation` rows, which the executor runs after the commit with the settlement
 * sweeper as the backstop. A caller of its own must have verified the signature already: `event` is a
 * {@link VerifiedWebhookEvent}, never a raw body.
 *
 * @throws AppError `payment_unavailable` (503) when an intent that must be read could not be.
 */
export async function handleStripeEvent(
  services: AppServices,
  log: App['log'],
  event: VerifiedWebhookEvent,
  now: Date,
): Promise<WebhookOutcome> {
  const intent = await intentFor(services, log, event);
  return transact(services, (tx, after) =>
    applyDelivery(tx, services, log, after, event, intent, now),
  );
}

/**
 * Apply one delivery in a single transaction (AAP 0.3.2).
 *
 * The order is the order the decisions have to be taken in, and it is the whole of this endpoint's idempotency:
 * claim the event row (a replay stops here), acknowledge a saved card on its own, record an event whose
 * PaymentIntent this application did not create, lock the meetup and re-read the deposit under that lock, apply the
 * effect, and only then mark the event `processed` — so a crash anywhere before the commit rolls the record back
 * with every effect it describes.
 */
async function applyDelivery(
  tx: DbTx,
  services: AppServices,
  log: App['log'],
  after: AfterCommit,
  event: VerifiedWebhookEvent,
  intent: IntentState | null,
  now: Date,
): Promise<WebhookOutcome> {
  const claimed = await claimEvent(tx, services, event, now);
  if (!claimed) {
    return { result: 'duplicate' };
  }
  // A saved card implies no call of ours: a hold authorizes against the customer's default card when
  // one is set and otherwise the newest saved card, so the card just saved is the one a hold confirms
  // against without this application re-pointing the provider's default.
  if (event.object.kind === 'setup_intent') {
    await markProcessed(tx, event, now);
    return { result: 'applied' };
  }
  if (intent === null) {
    await markProcessed(tx, event, now);
    return unmatched();
  }
  const correlation = await correlate(tx, intent, now);
  const meetup = correlation === null ? null : await lockMeetup(tx, correlation.deposit.meetupId);
  const deposit =
    correlation === null
      ? null
      : await tx.deposit.findUnique({ where: { id: correlation.deposit.id } });
  if (correlation === null || meetup === null || deposit === null) {
    await markProcessed(tx, event, now);
    return unmatched();
  }
  const outcome = await applyEffect({
    tx,
    services,
    log,
    after,
    event,
    intent,
    correlation: { ...correlation, deposit },
    meetup,
    now,
  });
  await markProcessed(tx, event, now);
  return outcome;
}

/**
 * Insert and lock this event's row, and report whether it was already applied (AAP 0.3.2). The insert suppresses a
 * concurrent delivery of the same event; the `FOR UPDATE` select is what makes a duplicate that arrives while the
 * first one is still running wait for it and then skip it. The fault point sits between the two and the effects, so
 * a throw there leaves no event row and no effect at all.
 *
 * @returns True when this delivery is the one that applies the event.
 */
async function claimEvent(
  tx: DbTx,
  services: AppServices,
  event: VerifiedWebhookEvent,
  now: Date,
): Promise<boolean> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "stripe_event" ("id", "type", "status", "received_at")
    VALUES (${event.id}, ${event.type}, 'received', ${now}::timestamptz)
    ON CONFLICT ("id") DO NOTHING
  `);
  const rows = await tx.$queryRaw<readonly { status: string }[]>(Prisma.sql`
    SELECT "status" FROM "stripe_event" WHERE "id" = ${event.id} FOR UPDATE
  `);
  await services.faults.hit(FAULT_AFTER_EVENT_INSERT, { eventId: event.id });
  return rows[0]?.status !== 'processed';
}

/** Mark this delivery's event row applied, in the transaction that applied it (AAP 0.3.2). */
async function markProcessed(tx: DbTx, event: VerifiedWebhookEvent, now: Date): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    UPDATE "stripe_event"
       SET "status" = 'processed', "processed_at" = ${now}::timestamptz
     WHERE "id" = ${event.id}
  `);
}

// ---------------------------------------------------------------------------------------------
// Correlation (AAP 0.2.2, AAP 0.5.3)
// ---------------------------------------------------------------------------------------------

/**
 * Resolve a PaymentIntent to the deposit attempt it concerns (AAP 0.5.3 "Correlation").
 *
 * Three lookups, strongest evidence first: the durable `hold` operation recorded for that intent, then
 * `Deposit.currentPaymentIntentId`, then the attempt metadata this application wrote on it — which recovers an
 * ambiguous hold create whose answer was lost, adopting the id the provider reports and closing an operation still
 * open as the success it turned out to be. The executor's own recording is conditional on its claim, so a parallel
 * run stays harmless.
 */
async function correlate(tx: DbTx, intent: IntentState, now: Date): Promise<Correlation | null> {
  const hold = await findOperationForIntent(tx, intent.id, ['hold']);
  if (hold !== null) {
    const deposit = await depositOf(tx, hold.depositId);
    if (deposit !== null) {
      return { deposit, attempt: hold.attempt ?? deposit.currentAttempt, holdOp: hold };
    }
  }
  const byIntent = await tx.deposit.findUnique({
    where: { currentPaymentIntentId: intent.id },
  });
  if (byIntent !== null) {
    const current = await findHoldOperation(tx, byIntent.id, byIntent.currentAttempt);
    return { deposit: byIntent, attempt: byIntent.currentAttempt, holdOp: current };
  }
  const metadata = intent.metadata;
  if (metadata === null) {
    return null;
  }
  const planned = await findHoldOperation(tx, metadata.depositId, metadata.attempt);
  const deposit = await depositOf(tx, metadata.depositId);
  if (planned === null || deposit === null) {
    return null;
  }
  await adoptIntent(tx, planned.id, intent.id, now);
  return { deposit, attempt: metadata.attempt, holdOp: planned };
}

/** The deposit an id names, or null for an attempt whose operation records no deposit. */
async function depositOf(tx: DbTx, depositId: string | null): Promise<Deposit | null> {
  return depositId === null ? null : tx.deposit.findUnique({ where: { id: depositId } });
}

/**
 * Record the PaymentIntent an attempt's own create turned out to have made, and close the operation a lost answer
 * left open (AAP 0.3.2). `payment_intent_id` is filled only where it is still empty, and an operation still
 * `pending` or `failed_retryable` becomes the success it was: the create did reach the provider. An `executing` row
 * is left alone, because its call belongs to the executor that claimed it and that executor records its own result.
 */
async function adoptIntent(
  tx: DbTx,
  operationId: string,
  paymentIntentId: string,
  now: Date,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    UPDATE "payment_operation"
       SET "payment_intent_id" = COALESCE("payment_intent_id", ${paymentIntentId}),
           "status" = CASE
             WHEN "status" IN ('pending', 'failed_retryable') THEN 'succeeded'
             ELSE "status"
           END,
           "completed_at" = CASE
             WHEN "status" IN ('pending', 'failed_retryable') THEN ${now}::timestamptz
             ELSE "completed_at"
           END
     WHERE "id" = ${operationId}::uuid
  `);
}

// ---------------------------------------------------------------------------------------------
// The effects (AAP 0.3.2, AAP 0.5.3)
// ---------------------------------------------------------------------------------------------

/** Whether the event concerns the attempt that is currently the deposit's (AAP 0.5.3). */
function isCurrent(ctx: EffectContext): boolean {
  return ctx.correlation.attempt === ctx.correlation.deposit.currentAttempt;
}

/**
 * Apply the effect of one handled event type. Every branch writes only what its event means and leaves the
 * meetup's own side effects to the state machine: `applyHoldOutcome` owns the proposal becoming visible, the lock,
 * the status frame and the deposit-funnel events, and `transition` owns the releases, the notifications and the
 * automatic dispute resolution of an ended meetup.
 */
async function applyEffect(ctx: EffectContext): Promise<WebhookOutcome> {
  switch (ctx.event.type) {
    case 'payment_intent.amount_capturable_updated':
      return applyAuthorization(ctx);
    case 'payment_intent.payment_failed':
      return applyHoldFailure(ctx);
    case 'payment_intent.canceled':
      return applyProviderCancellation(ctx);
    case 'charge.expired':
      // Stripe's own expiry is a hold loss whether or not a release of ours is pending, and its
      // instant is the provider's when it reports one (AAP 0.3.2).
      return applyHoldLoss(ctx, ctx.intent.canceledAt ?? ctx.event.createdAt);
    case 'payment_intent.succeeded':
      return applyCapture(ctx);
    case 'charge.refunded':
      return applyRefund(ctx);
    default:
      // Every type outside HANDLED_STRIPE_EVENT_TYPES was answered before this transaction and a
      // `setup_intent.succeeded` was answered above: nothing here can apply to a deposit.
      return ignored(ctx.meetup.id);
  }
}

/**
 * Apply an authorization that is now `requires_capture` (AAP 0.5.3).
 *
 * The late-and-orphan rule, in the order that never leaves an authorization outstanding at the processor. A
 * **late** authorization — a capture or a release is already planned for the attempt — is acknowledged, because the
 * money decision is durable and the executor's own retrieval settles the actual state. An **orphan** — a superseded
 * attempt's, or one that arrived after the meetup ended — gets an immediate release, marked `released` only on the
 * current attempt; a final meetup is never moved back to `locked`. Otherwise the hold is the meetup's and
 * `applyHoldOutcome` takes it.
 *
 * Both the release and the marking are conditioned on the state the handler retrieved, never on the payload: only a
 * `requires_capture` authorization is released. One the provider has taken away is the hold loss its cancellation
 * reported, so the deposit takes the state the lifecycle gives a loss — `expired` with the provider's own
 * `canceledAt` on a `held` attempt, `failed` on one that never became a hold — rather than a release that would hide
 * it from the no-forfeit compensation (AAP 0.3.2, AAP 0.5.3).
 */
async function applyAuthorization(ctx: EffectContext): Promise<WebhookOutcome> {
  const { tx, services, log, after, event, intent, correlation, meetup, now } = ctx;
  const { deposit, attempt, holdOp } = correlation;
  if (await hasCaptureOrRelease(tx, deposit.id, attempt)) {
    log.info(
      { event: LATE_AUTHORIZATION, eventId: event.id, depositId: deposit.id, attempt },
      LATE_AUTHORIZATION,
    );
    return ignored(meetup.id);
  }
  if (!isCurrent(ctx) || isFinalMeetupStatus(meetup.status)) {
    // The state the provider reports decides here, exactly as it does on the path below: an event's
    // payload is historical, so an authorization the provider has already taken away gets no release
    // and no `released` marking — a cancelled one is the hold loss its cancellation reported, and any
    // other state left nothing to release (AAP 0.3.2, AAP 0.5.3).
    if (intent.status === 'canceled') {
      return applyProviderCancellation(ctx);
    }
    if (intent.status !== 'requires_capture') {
      log.info(
        {
          event: INTENT_UNEXPECTED,
          eventId: event.id,
          depositId: deposit.id,
          status: intent.status,
        },
        INTENT_UNEXPECTED,
      );
      return ignored(meetup.id);
    }
    await planRelease(
      tx,
      {
        deposit,
        attempt,
        paymentIntentId: intent.id,
        ...(holdOp === null ? {} : { dependsOnId: holdOp.id }),
      },
      now,
    );
    if (isCurrent(ctx)) {
      await advanceDeposit(tx, { depositId: deposit.id, attempt }, 'released');
    }
    log.info(
      {
        event: ORPHAN_AUTHORIZATION,
        eventId: event.id,
        depositId: deposit.id,
        attempt,
        status: meetup.status,
      },
      ORPHAN_AUTHORIZATION,
    );
    return applied(meetup.id);
  }
  // The state the provider reports is the one this event is applied from. A retrieval that no longer
  // shows an authorization means the attempt ended, and the cancellation's own event moves the
  // deposit (AAP 0.3.2).
  if (intent.status !== 'requires_capture') {
    log.info(
      {
        event: INTENT_UNEXPECTED,
        eventId: event.id,
        depositId: deposit.id,
        status: intent.status,
      },
      INTENT_UNEXPECTED,
    );
    return ignored(meetup.id);
  }
  const result = await applyHoldOutcome(tx, services, after, {
    depositId: deposit.id,
    attempt,
    paymentIntentId: intent.id,
    outcome: 'held',
    captureBefore: intent.captureBefore,
    source: 'webhook',
  });
  return result.effect === 'ignored' ? ignored(meetup.id) : applied(meetup.id);
}

/**
 * Apply a hold attempt that failed at authentication (AAP 0.5.3): `requires_action → failed`, which lets the
 * attempt's owner retry with a fresh attempt while the meetup is still `proposed`. A superseded attempt is history
 * and is ignored: only the deposit's current attempt decides its status.
 */
async function applyHoldFailure(ctx: EffectContext): Promise<WebhookOutcome> {
  const { tx, services, after, intent, correlation, meetup } = ctx;
  if (!isCurrent(ctx)) {
    return ignored(meetup.id);
  }
  const result = await applyHoldOutcome(tx, services, after, {
    depositId: correlation.deposit.id,
    attempt: correlation.attempt,
    paymentIntentId: intent.id,
    outcome: 'failed',
    source: 'webhook',
  });
  return result.effect === 'ignored' ? ignored(meetup.id) : applied(meetup.id);
}

/**
 * Apply a `payment_intent.canceled` event (AAP 0.3.2, AAP 0.5.3). The cancellation reason is what separates the two
 * meanings of the same event: our own reason confirms the release we asked for, so the deposit ends `released`; any
 * other reason — `expired`, the value an expired authorization reads as under the pinned API version — is Stripe's
 * own cancellation, so the hold was lost rather than released and never becomes a forfeit.
 */
async function applyProviderCancellation(ctx: EffectContext): Promise<WebhookOutcome> {
  const { tx, intent, correlation, meetup, now } = ctx;
  if (intent.cancellationReason === OUR_CANCELLATION_REASON) {
    const moved = await advanceDeposit(
      tx,
      { depositId: correlation.deposit.id, attempt: correlation.attempt },
      'released',
    );
    return moved ? applied(meetup.id) : ignored(meetup.id);
  }
  return applyHoldLoss(ctx, intent.canceledAt ?? now);
}

/**
 * Apply a hold Stripe took away rather than released (AAP 0.3.2, AAP 0.5.3).
 *
 * The deposit's own status decides which situation this is. An attempt that never became a hold (`pending` or
 * `requires_action`) was an abandoned 3-D Secure step, so it `failed` and may be retried while the meetup is
 * `proposed`. A `held` current attempt is a lost hold: `locked` takes `lock_lost` through `applyHoldLossInTx` and
 * `proposed` through the state machine's own `hold_lost` transition, both of which mark the deposit `expired`,
 * release the counterpart's hold, notify both parties, emit `lock_lost` and resolve an open dispute with the note
 * `hold_expired`, forfeiting nothing. A meetup that already ended keeps its outcome: the deposit ends `expired`,
 * and only a forfeit can still be reversed, which `compensateLostHold` decides from Stripe's cancellation instant
 * against `MeetupSettlement.appliedAt`.
 */
async function applyHoldLoss(ctx: EffectContext, canceledAt: Date): Promise<WebhookOutcome> {
  const { tx, services, after, intent, correlation, meetup } = ctx;
  const { deposit, attempt } = correlation;
  if (deposit.status === 'pending' || deposit.status === 'requires_action') {
    const result = await applyHoldOutcome(tx, services, after, {
      depositId: deposit.id,
      attempt,
      paymentIntentId: intent.id,
      outcome: 'failed',
      source: 'webhook',
    });
    return result.effect === 'ignored' ? ignored(meetup.id) : applied(meetup.id);
  }
  if (deposit.status !== 'held' || !isCurrent(ctx)) {
    return ignored(meetup.id);
  }
  if (meetup.status === 'locked') {
    const loss = await applyHoldLossInTx(tx, services, after, meetup.id, [
      { depositId: deposit.id, canceledAt },
    ]);
    if (!loss.applied) {
      return ignored(meetup.id);
    }
    logHoldLost(ctx);
    return applied(meetup.id);
  }
  if (meetup.status === 'proposed') {
    await transition(tx, services, after, meetup, {
      type: 'hold_lost',
      depositId: deposit.id,
      canceledAt,
      source: 'webhook',
    });
    logHoldLost(ctx);
    return applied(meetup.id);
  }
  await advanceDeposit(tx, { depositId: deposit.id, attempt }, 'expired', { canceledAt });
  if (COMPENSABLE_STATUSES.has(meetup.status)) {
    after(async () => {
      await compensateLostHold(services, meetup.id, {
        depositId: deposit.id,
        reason: 'hold_lost_before_apply',
        canceledAt,
      });
    });
  }
  logHoldLost(ctx);
  return applied(meetup.id);
}

/**
 * Apply a capture this application asked for (AAP 0.5.3): `held → captured` on the attempt the capture belongs to.
 * A capture for a superseded attempt, or one that arrives after the deposit already moved, is refused by the
 * forward-only update.
 */
async function applyCapture(ctx: EffectContext): Promise<WebhookOutcome> {
  const { tx, correlation, meetup } = ctx;
  if (!isCurrent(ctx)) {
    return ignored(meetup.id);
  }
  const moved = await advanceDeposit(
    tx,
    { depositId: correlation.deposit.id, attempt: correlation.attempt },
    'captured',
  );
  return moved ? applied(meetup.id) : ignored(meetup.id);
}

/**
 * Apply a reversal of a capture (AAP 0.3.2). Only a fully refunded charge moves the deposit, and only from
 * `captured`: a partial refund leaves the deposit as it stands, and the reversal the executor planned is what makes
 * it `refunded`, so this event and that operation agree rather than race.
 */
async function applyRefund(ctx: EffectContext): Promise<WebhookOutcome> {
  const { tx, event, intent, correlation, meetup } = ctx;
  const refunded = intent.refunded || (event.object.kind === 'charge' && event.object.refunded);
  if (!refunded || !isCurrent(ctx)) {
    return ignored(meetup.id);
  }
  const moved = await advanceDeposit(
    tx,
    { depositId: correlation.deposit.id, attempt: correlation.attempt },
    'refunded',
  );
  return moved ? applied(meetup.id) : ignored(meetup.id);
}

/** Write the one log line a hold loss produces, ids and a status word alone (AAP 0.11.1). */
function logHoldLost(ctx: EffectContext): void {
  ctx.log.info(
    {
      event: HOLD_LOST,
      eventId: ctx.event.id,
      meetupId: ctx.meetup.id,
      depositId: ctx.correlation.deposit.id,
      status: ctx.meetup.status,
    },
    HOLD_LOST,
  );
}

// ---------------------------------------------------------------------------------------------
// Failures on a log line (AAP 0.11.1)
// ---------------------------------------------------------------------------------------------

/**
 * A failure's own short token, for a log line: its string `code` (`payment_rejected`), else its class name
 * (`PaymentUnavailableError`), and never its message or its stack (AAP 0.11.1). pino writes a message and a stack as
 * strings, and a stack carries the whole cause chain, so key-based redaction cannot rewrite either: a provider
 * failure's message can quote the `Customer` id or the `PaymentIntent` id it concerns — exactly the values this
 * endpoint's log lines may not carry. Anything that is not a plain short identifier becomes `Error`.
 */
function failureToken(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'Error';
  }
  const { code, name } = error as { code?: unknown; name?: unknown };
  const token = typeof code === 'string' && code.length > 0 ? code : name;
  if (typeof token !== 'string' || !FAILURE_TOKEN_PATTERN.test(token)) {
    return 'Error';
  }
  return token;
}
