/**
 * The payments contract: the shapes, the gateway interface, the typed failures and the Stripe timing store through
 * which every other part of the API talks to Stripe.
 * `stripe-gateway.ts` is the only file that imports the `stripe` SDK, so nothing below carries a `Stripe.*` type: a
 * provider `PaymentIntent` becomes an {@link IntentState}, a provider failure a {@link PaymentError} subclass and a
 * provider event a {@link VerifiedWebhookEvent} at that boundary. Every other module imports this file and never the
 * SDK, which keeps the provider swappable and is what the root ESLint `no-restricted-imports` rule enforces.
 * Three invariants hold throughout: money is integer USD cents, with every figure a PaymentIntent reports converted at
 * the boundary; no raw card data reaches the API, because card entry happens only inside a Stripe UI component on the
 * client; and a provider event is never ordered by its `created` timestamp, which has second precision, so state
 * advances on the PaymentIntent's own forward-only transitions.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { PaymentIntentMetadata } from '@tablemate/shared';

/**
 * Every status a PaymentIntent can hold, spelled as the provider spells them: `requires_capture` is the `held` hold
 * carrying the 7-day authorization window, `requires_action` is 3-D Secure waiting on the customer, `canceled` is an
 * attempt that ended — ours when {@link IntentState.cancellationReason} is our own reason, Stripe's otherwise — and
 * `succeeded` is a captured hold. The remaining three occur between creation and confirmation.
 * The table is the declaration and {@link IntentStatus} is derived from it, so the runtime list `stripe-gateway.ts`
 * narrows a provider status against and the type every other module reads cannot drift.
 */
export type IntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'canceled'
  | 'succeeded';

/**
 * One hold attempt to place and confirm, as `holds.ts` builds it.
 * Each attempt is its own PaymentIntent carrying `meetupId`, `depositId` and `attempt` as metadata, so a webhook is
 * matched to the attempt it concerns rather than to the deposit alone, and `Deposit.currentPaymentIntentId` points at
 * the attempt that is current. `idempotencyKey` is always `hold:<depositId>:<attempt>`, built for the attempt it
 * concerns and reused verbatim by every retry: a superseded attempt and the current one therefore never share a key,
 * which is what lets `operations.ts` replay a create whose answer was lost without risking a second authorization.
 */
export interface HoldRequest {
  customerId: string;
  amountCents: number;
  meetupId: string;
  depositId: string;
  attempt: number;
  idempotencyKey: string;
}

/**
 * What confirming a hold attempt reports.
 * The hold is confirmed **on-session** from a card the customer saved earlier, which makes it a customer-initiated
 * authorization carrying the 7-day window. It is never confirmed `off_session`: a merchant-initiated hold lasts 5 days
 * for Visa, and a meetup may start up to 5 days after the proposal, so it could expire before there was anything to
 * settle.
 * A card decline and a missing card are ordinary results, not exceptions: the route that asked maps `declined` to
 * `402 hold_failed`, the meetup is unchanged and the attempt may be retried with a fresh attempt number.
 */
export type HoldResult =
  | {
      /** The authorization is in place; the deposit becomes `held`. */
      kind: 'requires_capture';
      paymentIntentId: string;
      clientSecret: string;
      /** The deadline to capture, read from `latest_charge.payment_method_details.card.capture_before` when the provider reports it, otherwise `null`. */
      captureBefore: Date | null;
    }
  | {
      /** 3-D Secure must be completed by the customer; the deposit becomes `requires_action`. */
      kind: 'requires_action';
      paymentIntentId: string;
      clientSecret: string;
    }
  | {
      /** No authorization was placed, so no money is held. */
      kind: 'declined';
      paymentIntentId: string | null;
      code: string;
    };

/**
 * One PaymentIntent, normalized.
 * This is the authoritative view `operations.ts`, `settlement/settle.ts` and `webhook.ts` decide on: after a timeout, a
 * crash or a refused request they retrieve the PaymentIntent and read its actual state here instead of assuming what a
 * lost answer meant. `status` is the provider's own value and the only evidence that an effect happened — a capture
 * reconciles to `succeeded`, a release to `canceled`, and an effect that never ran leaves the intent as it was.
 */
export interface IntentState {
  id: string;
  status: IntentStatus;
  /** The customer it belongs to, or `null` for a PaymentIntent this application did not create. */
  customerId: string | null;
  /**
   * Our own cancellation reason when this application cancelled the attempt, otherwise Stripe's. Any value other than
   * `OUR_CANCELLATION_REASON` — `expired` among the pinned API version's values — means the hold was **lost** rather than
   * released: the deposit takes the `expired` transition, there is no forfeit, and both parties are notified.
   */
  cancellationReason: string | null;
  canceledAt: Date | null;
  captureBefore: Date | null;
  amountCents: number;
  amountCapturableCents: number;
  amountReceivedCents: number;
  /** True when the latest charge is fully refunded, which is how a reversing `refund` operation confirms that a fenced capture was undone. */
  refunded: boolean;
  clientSecret: string | null;
  /** The attempt metadata this application wrote, parsed with the shared `PaymentIntentMetadata` schema, or `null` when it is absent or malformed — a PaymentIntent created elsewhere carries none. */
  metadata: PaymentIntentMetadata | null;
}

/**
 * The result of starting a card setup, the response of `POST /me/payment-setup`: its fields are exactly the shared
 * `PaymentSetupResponse`, so `me/payment-setup.ts` returns it unchanged. The client confirms the SetupIntent with
 * PaymentSheet on native or the Payment Element on web, and the card itself never reaches this API.
 */
export interface SetupResult {
  customerId: string;
  setupIntentClientSecret: string;
  ephemeralKeySecret: string;
}

/**
 * A refund created to undo a capture: the reversing `refund` of a fencing resolution — an operator `no_fault`, or the
 * compensation of a forfeit whose hold turned out to have been lost before the settlement committed — resolved against
 * the PaymentIntent's actual state and reported here so the operation records the provider's id.
 */
export interface RefundResult {
  refundId: string;
  /** The provider's own refund status, `succeeded` or `pending` in practice. */
  status: string;
}

/**
 * The part of a verified event's `data.object` the webhook handler applies: the gateway normalizes the object here so
 * `webhook.ts` never names a `Stripe.*` type, and the handler switches on `kind` and applies the effect of the event
 * type it read.
 */
export type WebhookObject =
  | {
      /** A `payment_intent.*` event: the intent the handler correlates the delivery by. */
      kind: 'payment_intent';
      /** The PaymentIntent id the event names, which is what the handler correlates and re-reads by. */
      intentId: string;
      /**
       * The normalized state the payload carried, or `null` when it lacks a field this build needs — its status above all. A
       * payload may omit a field an effect needs, so `null` means the handler reads the PaymentIntent from the provider before
       * it opens its transaction, never that the delivery failed.
       */
      intent: IntentState | null;
    }
  | {
      /** A `charge.*` event, which the handler correlates by the PaymentIntent it belongs to. */
      kind: 'charge';
      chargeId: string;
      /** The PaymentIntent the charge belongs to, or `null` for a charge made outside this flow. */
      paymentIntentId: string | null;
      /** True when the charge is fully refunded (`charge.refunded`). */
      refunded: boolean;
      /** The capture deadline the charge reports, which is what a `held` deposit records. */
      captureBefore: Date | null;
    }
  | {
      kind: 'setup_intent';
      setupIntentId: string;
      customerId: string | null;
      paymentMethodId: string | null;
    }
  | {
      /** Any other object on a handled event. Applied as a no-op rather than a failure, so a provider payload this API does not model can never fail the endpoint. */
      kind: 'other';
    };

/** A Stripe event whose signature has been verified, in the form the webhook handler consumes. */
export interface VerifiedWebhookEvent {
  id: string;
  /**
   * `event.type`, kept as a plain string rather than the handled set: a type outside `HANDLED_STRIPE_EVENT_TYPES` is
   * acknowledged `200` without effect, so a type the provider adds later cannot fail the endpoint.
   */
  type: string;
  /**
   * `event.created`, used **only** as the fallback `canceledAt` of a `charge.expired` event whose own object carries no
   * cancellation time. It never orders events: the timestamp has second precision, so two events of one second are
   * indistinguishable, and every decision instead reads the state a PaymentIntent actually reports.
   */
  createdAt: Date;
  /** The normalized object the event carried. */
  object: WebhookObject;
}

/**
 * The one way any other module talks to Stripe: `stripe-gateway.ts` implements it against the SDK, and `holds.ts`,
 * `operations.ts`, `webhook.ts`, `meetups/accept.ts`, `me/payment-setup.ts` and `settlement/settle.ts` depend on it.
 * Two rules hold for every method: one that can leave the outcome of a provider call unknown throws
 * {@link PaymentUnavailableError} rather than reporting an effect that may not have happened, and every method may be
 * called again under the same idempotency key, because that is how the `PaymentOperation` executor completes an
 * operation a crash interrupted.
 */
export interface PaymentsGateway {
  /**
   * Place and confirm the authorization for one hold attempt. Confirmed on-session from the customer's saved card, so the
   * authorization is customer-initiated and carries the 7-day window. A decline or a missing card is **returned** as the
   * `declined` arm of {@link HoldResult}; it is not thrown.
   * @throws PaymentUnavailableError when the outcome is unknown — a timeout, a connection error, a 5xx, a 429 or an
   *   unrecognized failure — so `operations.ts` reconciles rather than guesses: it replays the create under the same key,
   *   which the provider answers with the stored result of the first request.
   * @throws PaymentIdempotencyError when replaying the key is refused as a conflict the recovery cannot resolve: a
   *   conflict is first resolved by recovering the PaymentIntent the metadata this application wrote names, and only one
   *   that finds no such intent, or one whose status decides nothing, is logged as `hold_replay_params_changed` and handed
   *   to the operator, never replayed again.
   * @throws PaymentRejectedError on a definite 4xx refusal that is not a card error, such as `resource_missing` or
   *   `payment_intent_unexpected_state`: nothing happened, and the caller retrieves the PaymentIntent to decide.
   */
  createAndConfirmHold(request: HoldRequest): Promise<HoldResult>;

  /**
   * Cancel a hold with our own cancellation reason and report the state after the cancel.
   * Every cancel carries `OUR_CANCELLATION_REASON`, which is what distinguishes our release from Stripe's own cancellation
   * when the `payment_intent.canceled` webhook arrives: a cancellation with any other reason, or a `charge.expired` event,
   * is a hold loss rather than a release, and the deposit takes the `expired` transition with no forfeit.
   * @throws PaymentUnavailableError when the outcome is unknown; the executor then retrieves the PaymentIntent and records
   *   a release that already happened instead of cancelling twice.
   * @throws PaymentRejectedError when the provider refuses the cancel outright.
   */
  releaseHold(paymentIntentId: string, idempotencyKey: string): Promise<IntentState>;

  /**
   * Capture the full authorized amount of a hold: the absent party's hold at a `no_show` settlement, or the canceller's
   * hold on a late cancellation. A deposit is captured whole or not at all.
   * @throws PaymentUnavailableError when the outcome is unknown; the executor retrieves the PaymentIntent and records a
   *   capture that already happened rather than capturing twice.
   * @throws PaymentRejectedError when the provider refuses because the authorization is gone — the evidence that the hold
   *   was lost before the settlement committed, which triggers the no-forfeit compensation.
   * @throws PaymentDeclinedError when the capture is refused for a card reason.
   */
  captureHold(paymentIntentId: string, idempotencyKey: string): Promise<IntentState>;

  /**
   * Refund a captured hold, written as the reversing operation of a fencing resolution and resolved against the
   * PaymentIntent's actual state when it runs: a captured intent is refunded here, an uncaptured one is cancelled by
   * {@link PaymentsGateway.releaseHold} instead, and an already-cancelled one needs nothing.
   * @throws PaymentUnavailableError when the outcome is unknown; the executor retrieves the PaymentIntent, where a fully
   *   refunded charge reports `refunded`, rather than refunding twice.
   * @throws PaymentRejectedError on a definite 4xx refusal, which the executor settles by retrieving the PaymentIntent.
   */
  refund(paymentIntentId: string, idempotencyKey: string): Promise<RefundResult>;

  /**
   * Create or reuse the customer behind a saved card and start a card setup: `customerId` is `null` for an account that
   * has never set a card up, and the gateway creates the customer then. The SetupIntent it returns is what PaymentSheet
   * (native) or the Payment Element (web) confirms, so no card data reaches this API.
   */
  createSetup(input: { customerId: string | null }): Promise<SetupResult>;

  /**
   * Delete the Stripe customer recorded for an erased account, run by the `delete_customer` operation once every deposit
   * of the user is final and no dispute on their meetups is open. A customer that was already deleted, or that no longer
   * exists, counts as success, so the operation is safe to replay.
   * @throws PaymentUnavailableError when the outcome is unknown; the copied customer id is cleared only in the transaction
   *   that records success.
   */
  deleteCustomer(customerId: string, idempotencyKey: string): Promise<void>;

  /**
   * Read the authoritative state of a PaymentIntent. Every reconciliation reads this rather than assuming what a lost
   * answer meant: an `executing` operation older than two minutes, a timeout, a refused request and the settlement's
   * check of both authorizations before its transaction all decide on what the provider reports here.
   * @throws PaymentUnavailableError when the PaymentIntent cannot be read; nothing is decided from a state that could not
   *   be observed.
   * @throws PaymentRejectedError when the id does not exist, which the executor resolves as the absence of an effect.
   */
  retrievePaymentIntent(paymentIntentId: string): Promise<IntentState>;

  /**
   * Verify a Stripe event's signature and normalize it.
   * Synchronous, because nothing about a signature check waits and the endpoint must answer `2xx` quickly: the work an
   * event implies happens inside the handler's own transaction. The signature covers the raw request body, so the route
   * passes the unparsed bytes together with the `Stripe-Signature` header, and the secret is the configured
   * `STRIPE_WEBHOOK_SECRET`. `receivedAt` is the request's injected-clock instant, by which the provider's signature
   * tolerance is judged — reading the application clock rather than the wall clock is what lets a suite on the test clock
   * sign an event with a timestamp from its own clock.
   * @returns The verified event, or `null` when the signed bytes are not a Stripe event at all — no non-empty `id` or
   *   `type`. The signature proves who sent the bytes, never what they are, and a delivery carrying no event id can be
   *   neither deduped nor recorded, so `webhook.ts` acknowledges it `200` and applies nothing rather than retrying it
   *   forever.
   * @throws BadSignatureError when the header is missing or malformed, when the timestamp is outside tolerance or when
   *   the signature was made with another secret; `webhook.ts` maps it to `400 bad_signature`.
   */
  verifyWebhook(rawBody: Buffer, signature: string, receivedAt: Date): VerifiedWebhookEvent | null;
}

/**
 * The base of every failure this boundary raises.
 * A message carries a code and nothing else: never a card number, a client secret, an ephemeral key, a customer's email
 * address or the provider's own message, because a message reaches a log line and the error envelope. The provider's
 * error and the signature failure travel in `cause` instead, which is logged and never answered. The prototype is re-set
 * so `instanceof` holds under the ES2023 class output.
 */
export abstract class PaymentError extends Error {
  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A card error on an operation other than placing a hold: hold creation reports a decline as the `declined` arm of
 * {@link HoldResult} rather than throwing, so this is for the rare case where an operation on an already-authorized
 * hold — a capture — is refused for a card reason, which the executor treats as terminal.
 */
export class PaymentDeclinedError extends PaymentError {
  readonly code: string;
  readonly paymentIntentId: string | null;

  constructor(code: string, paymentIntentId: string | null, options?: ErrorOptions) {
    super(`card_declined:${code}`, options);
    this.code = code;
    this.paymentIntentId = paymentIntentId;
  }
}

/**
 * A Stripe call whose outcome is unknown, so nothing may be assumed about its effect. It covers the failures that
 * leave the question open — a timeout, a connection error, a 5xx, a 429 and the `api_error` type, plus any status
 * this application does not model — and `operations.ts` treats it as ambiguous: the operation is reconciled against
 * the PaymentIntent and only then retried, always under its original idempotency key.
 */
export class PaymentUnavailableError extends PaymentError {
  /**
   * Which failure it was: `timeout`, `network`, `server`, `rate_limited`, `api` (a provider-side error),
   * `unexpected_status` (a response this application does not model) or `configuration` (credentials or mode the
   * process cannot use).
   */
  readonly reason:
    | 'timeout'
    | 'network'
    | 'server'
    | 'rate_limited'
    | 'api'
    | 'unexpected_status'
    | 'configuration';
  readonly statusCode: number | undefined;

  constructor(
    reason:
      | 'timeout'
      | 'network'
      | 'server'
      | 'rate_limited'
      | 'api'
      | 'unexpected_status'
      | 'configuration',
    statusCode?: number,
    options?: ErrorOptions,
  ) {
    super(
      `payment_unavailable:${reason}${statusCode === undefined ? '' : `:${statusCode}`}`,
      options,
    );
    this.reason = reason;
    this.statusCode = statusCode;
  }
}

/**
 * A Stripe request the provider refused outright: a definite 4xx that is not a card error, such as
 * `payment_intent_unexpected_state` or `resource_missing`, proves the request had no effect, so the executor retrieves
 * the PaymentIntent and records the state it finds instead of replaying the operation blindly.
 */
export class PaymentRejectedError extends PaymentError {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, options?: ErrorOptions) {
    super(`payment_rejected:${code}:${statusCode}`, options);
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * A replayed idempotency key whose parameters differ from the first request's. The provider raises it as an
 * `idempotency_error`, and it means the attempt was not replayed — the original request stands. `operations.ts`
 * logs `hold_replay_params_changed` and leaves the hold to the 12-hour rule rather than sending a second
 * authorization.
 */
export class PaymentIdempotencyError extends PaymentError {
  constructor(options?: ErrorOptions) {
    super('idempotency_error', options);
  }
}

/**
 * A webhook whose signature did not verify: a missing or malformed header, a timestamp outside tolerance, or a
 * signature made with another secret. `webhook.ts` maps it to `400 bad_signature` and applies nothing.
 */
export class BadSignatureError extends PaymentError {
  constructor(options?: ErrorOptions) {
    super('bad_signature', options);
  }
}

const PAYMENT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'PaymentDeclinedError',
  'PaymentUnavailableError',
  'PaymentRejectedError',
  'PaymentIdempotencyError',
  'BadSignatureError',
]);

/**
 * Whether a thrown value is a {@link PaymentError}: a second copy of this module in one process — a test double, a
 * duplicated ESM graph — fails `instanceof`, so a value that names one of these failures is accepted too.
 */
export function isPaymentError(error: unknown): error is PaymentError {
  if (error instanceof PaymentError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const name: unknown = (error as { name?: unknown }).name;
  return typeof name === 'string' && PAYMENT_ERROR_NAMES.has(name);
}

/**
 * The per-request Stripe duration store. AAP 0.12.2 measures the write-latency target excluding Stripe, so k6
 * subtracts the value reported in the `Server-Timing: stripe;dur=` header from each write it times. It is an
 * `AsyncLocalStorage` rather than a field on the request because `stripe-gateway.ts` is called from the executor
 * and from domain functions that never see the Fastify request, and it is per-request because one process serves
 * many.
 */
const stripeTimingStore = new AsyncLocalStorage<{ ms: number }>();

/**
 * Run `cb` inside a fresh timing store, so everything it awaits accumulates into one figure. `app.ts` calls it from
 * an `onRequest` hook as `withStripeTimingStore(done)`, which propagates the store through the rest of the request
 * lifecycle. Each request therefore starts at zero, and background work that never enters a store accumulates
 * nowhere.
 */
export function withStripeTimingStore<T>(cb: () => T): T {
  return stripeTimingStore.run({ ms: 0 }, cb);
}

/**
 * Add one Stripe call's duration to the current request's store. The duration is measured with `node:perf_hooks`'
 * monotonic `performance.now()`, so this is a measured duration rather than wall-clock time and the clock rule is
 * untouched. Outside a store — the settlement sweeper, a queue processor — this is a no-op, and a negative or
 * non-finite value is ignored because it would corrupt the sum.
 */
export function recordStripeMs(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const store = stripeTimingStore.getStore();
  if (store === undefined) return;
  store.ms += ms;
}

/** The milliseconds recorded so far on the current request, rounded to one decimal for the `Server-Timing` header, or 0 outside a store. */
export function currentStripeMs(): number {
  const store = stripeTimingStore.getStore();
  if (store === undefined) return 0;
  return Math.round(store.ms * 10) / 10;
}
