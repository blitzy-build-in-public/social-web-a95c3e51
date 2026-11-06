/**
 * The payments contract: the shapes, the gateway interface, the typed failures and the Stripe timing
 * store through which every other part of the API talks to Stripe (AAP 0.5.1, AAP 0.6.2).
 *
 * `apps/api/src/modules/payments/stripe-gateway.ts` is the only file that imports the `stripe` SDK,
 * so nothing below carries a `Stripe.*` type. A provider `PaymentIntent` becomes an
 * {@link IntentState}, a provider failure becomes a {@link PaymentError} subclass and a provider
 * event becomes a {@link VerifiedWebhookEvent} at that boundary. Every other module — `holds.ts`,
 * `operations.ts`, `webhook.ts`, `meetups/accept.ts`, `me/payment-setup.ts`, `settlement/settle.ts` —
 * imports this file and never the SDK, which is what keeps the provider swappable and what the root
 * ESLint `no-restricted-imports` rule enforces.
 *
 * Three invariants hold throughout:
 *   - **Money is integer USD cents** (AAP 0.11.1). No field here is a decimal amount or a currency:
 *     a deposit is 500, 1000 or 2000, and every figure a PaymentIntent reports is converted at the
 *     boundary.
 *   - **No raw card data reaches the API** (AAP 0.3.2). No type here carries a card number, a CVC or
 *     an expiry, because card entry happens only inside a Stripe UI component on the client.
 *   - **A provider event is never ordered by its `created` timestamp**, which has second precision
 *     (AAP 0.2.2, AAP 0.3.2). {@link VerifiedWebhookEvent.createdAt} exists for one purpose only —
 *     the fallback `canceledAt` of a `charge.expired` event ({@link IntentState.canceledAt}) — and
 *     state advances on the PaymentIntent's own forward-only transitions, never on arrival order.
 *
 * @see AAP 0.3.2 for the durable `PaymentOperation` executor, its reconciliation rules and "our
 * cancels versus Stripe's"; AAP 0.5.3 for the deposit and meetup lifecycles these types serve;
 * AAP 0.5.4 for the routes that map these failures onto the error envelope; and AAP 0.12.2 for the
 * `Server-Timing: stripe;dur=` header the timing store below fills.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { PaymentIntentMetadata } from '@tablemate/shared';

/*
 * Domains types: the hold request, what confirming it reports, and the normalized PaymentIntent
 * every caller decides on (AAP 0.5.3, AAP 0.3.2).
 */

/**
 * Every status a PaymentIntent can hold, spelled as the provider spells them (AAP 0.5.3).
 *
 * The deposit lifecycle reads four: `requires_capture` is the `held` hold that carries the 7-day
 * authorization window, `requires_action` is 3-D Secure waiting on the customer, `canceled` is an
 * attempt that ended — ours when {@link IntentState.cancellationReason} is our own reason, Stripe's
 * when it is anything else — and `succeeded` is a captured hold. The remaining three occur between
 * creation and confirmation and map to the deposit's `pending` or `failed`.
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
 * One hold attempt to place and confirm, as `holds.ts` builds it (AAP 0.5.3).
 *
 * Each attempt is its own PaymentIntent carrying `meetupId`, `depositId` and `attempt` as metadata,
 * so a webhook is matched to the attempt it concerns rather than to the deposit alone, and
 * `Deposit.currentPaymentIntentId` points at the attempt that is current.
 *
 * `idempotencyKey` is always `hold:<depositId>:<attempt>`, built by `holds.ts` for the attempt it
 * concerns and reused verbatim by every retry of that attempt (AAP 0.3.2). A superseded attempt and
 * the current one therefore never share a key, which is what lets `operations.ts` replay a create
 * whose answer was lost without risking a second authorization, and what makes a replayed create
 * send byte-identical parameters.
 */
export interface HoldRequest {
  /** The Stripe customer the saved card belongs to. */
  customerId: string;
  /** The amount to authorize, in integer USD cents: one of the three deposit levels. */
  amountCents: number;
  /** The meetup the hold belongs to; written to the PaymentIntent's metadata. */
  meetupId: string;
  /** The `Deposit` row the hold belongs to; written to the PaymentIntent's metadata. */
  depositId: string;
  /** The hold attempt number, from 1; written to the PaymentIntent's metadata. */
  attempt: number;
  /** This attempt's provider idempotency key, `hold:<depositId>:<attempt>`. */
  idempotencyKey: string;
}

/**
 * What confirming a hold attempt reports (AAP 0.5.3).
 *
 * The hold is confirmed **on-session** from a card the customer saved earlier, which makes it a
 * customer-initiated authorization carrying the 7-day window AAP 0.2.4 records. It is never confirmed
 * `off_session`: a merchant-initiated hold lasts 5 days for Visa, and a meetup may start up to 5 days
 * after the proposal, so it could expire before there was anything to settle.
 *
 * A card decline and a missing card are ordinary results, not exceptions: `declined` reports
 * `no_saved_card` when the customer has no card at all and Stripe's own `decline_code ?? code`
 * otherwise. The route that asked maps it to `402 hold_failed`, the meetup is unchanged and the
 * attempt may be retried with a fresh attempt number.
 */
export type HoldResult =
  | {
      /** The authorization is in place; the deposit becomes `held`. */
      kind: 'requires_capture';
      /** The PaymentIntent id, recorded on the attempt's `hold` operation and on the deposit. */
      paymentIntentId: string;
      /** The client secret, returned only to the participant the attempt belongs to. */
      clientSecret: string;
      /**
       * The deadline to capture, read from `latest_charge.payment_method_details.card.capture_before`
       * when the provider reports it, otherwise `null`.
       */
      captureBefore: Date | null;
    }
  | {
      /** 3-D Secure must be completed by the customer; the deposit becomes `requires_action`. */
      kind: 'requires_action';
      /** The PaymentIntent id, recorded on the attempt's `hold` operation and on the deposit. */
      paymentIntentId: string;
      /** The client secret the client completes the authentication with. */
      clientSecret: string;
    }
  | {
      /** No authorization was placed, so no money is held. */
      kind: 'declined';
      /** The PaymentIntent that was refused, or `null` when no card was found to confirm with. */
      paymentIntentId: string | null;
      /** `no_saved_card`, or Stripe's `decline_code ?? code`. */
      code: string;
    };

/**
 * One PaymentIntent, normalized (AAP 0.3.2, AAP 0.5.3).
 *
 * This is the authoritative view `operations.ts`, `settlement/settle.ts` and `webhook.ts` decide on.
 * After a timeout, a crash or a refused request, the executor and the settlement's reconciliation
 * retrieve the PaymentIntent and read its actual state here instead of assuming what a lost answer
 * meant: `status` is the provider's own value and the only evidence that an effect happened — a
 * capture reconciles to `succeeded`, a release to `canceled`, and an effect that never ran leaves the
 * intent as it was.
 */
export interface IntentState {
  /** The PaymentIntent id. */
  id: string;
  /** Its status, verbatim from the provider. */
  status: IntentStatus;
  /** The customer it belongs to, or `null` for a PaymentIntent this application did not create. */
  customerId: string | null;
  /**
   * Our own cancellation reason when this application cancelled the attempt, otherwise Stripe's. Any
   * value other than `OUR_CANCELLATION_REASON` — `expired`, the value an expired authorization reads
   * as under the pinned API version — means the hold was **lost** rather than released: the deposit
   * takes the `expired` transition, there is no forfeit, and both parties are notified
   * (AAP 0.3.2, AAP 0.5.3).
   */
  cancellationReason: string | null;
  /** When Stripe cancelled it, recorded as the deposit's `canceledAt`. */
  canceledAt: Date | null;
  /** The capture deadline, from `latest_charge.payment_method_details.card.capture_before`. */
  captureBefore: Date | null;
  /** The authorized amount, in integer USD cents. */
  amountCents: number;
  /** How much may still be captured, in integer USD cents: 0 once captured or cancelled. */
  amountCapturableCents: number;
  /** How much was captured, in integer USD cents: 0 while the hold is uncaptured. */
  amountReceivedCents: number;
  /**
   * True when the latest charge is fully refunded, which is how a reversing `refund` operation
   * confirms that a fenced capture was undone (AAP 0.3.2).
   */
  refunded: boolean;
  /** The client secret, exposed only to the participant whose own attempt it belongs to. */
  clientSecret: string | null;
  /**
   * The attempt metadata this application wrote, parsed with the shared `PaymentIntentMetadata`
   * schema, or `null` when it is absent or malformed — a PaymentIntent created elsewhere carries
   * none.
   */
  metadata: PaymentIntentMetadata | null;
}

/**
 * The result of starting a card setup: the response of `POST /me/payment-setup` (AAP 0.5.4).
 *
 * Its fields are exactly the shared `PaymentSetupResponse`, so `me/payment-setup.ts` returns it
 * unchanged. The client confirms the SetupIntent with PaymentSheet on native or the Payment Element
 * on web, and uses the ephemeral key so those components can manage the customer's saved cards;
 * the card itself never reaches this API (AAP 0.3.2).
 */
export interface SetupResult {
  /** The Stripe customer for the account, created when the caller had none. */
  customerId: string;
  /** The SetupIntent's client secret. */
  setupIntentClientSecret: string;
  /** The ephemeral key secret the Stripe client components authenticate with. */
  ephemeralKeySecret: string;
}

/**
 * A refund created to undo a capture (AAP 0.3.2).
 *
 * The reversing `refund` of a fencing resolution — an operator `no_fault`, or the compensation of a
 * forfeit whose hold turned out to have been lost before the settlement committed — resolves against
 * the PaymentIntent's actual state when it runs, and reports the created refund here so the
 * operation records the provider's id.
 */
export interface RefundResult {
  /** The provider's refund id, recorded on the reversing `refund` operation. */
  refundId: string;
  /** The provider's own refund status, `succeeded` or `pending` in practice. */
  status: string;
}

/**
 * The part of a verified event's `data.object` the webhook handler applies (AAP 0.3.2, AAP 0.3.3).
 *
 * The gateway normalizes the object here so `webhook.ts` never names a `Stripe.*` type: the handler
 * switches on `kind` and applies the effect of the event type it read.
 */
export type WebhookObject =
  | {
      /** A `payment_intent.*` event: the intent's full normalized state. */
      kind: 'payment_intent';
      intent: IntentState;
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
      /** A `setup_intent.succeeded` event: a card was saved for this customer. */
      kind: 'setup_intent';
      setupIntentId: string;
      /** The customer the card was saved for, or `null` when the event does not carry one. */
      customerId: string | null;
      /** The saved payment method, as the provider reports it. */
      paymentMethodId: string | null;
    }
  | {
      /**
       * Any other object on a handled event. Applied as a no-op rather than a failure, so a
       * provider payload this API does not model can never fail the endpoint.
       */
      kind: 'other';
    };

/**
 * A Stripe event whose signature has been verified, in the form the webhook handler consumes
 * (AAP 0.3.2, AAP 0.3.3).
 */
export interface VerifiedWebhookEvent {
  /** `event.id`: the key `StripeEvent` dedupes on, so a redelivery has no second effect. */
  id: string;
  /**
   * `event.type`, kept as a plain string rather than the handled set: a type outside
   * `HANDLED_STRIPE_EVENT_TYPES` is acknowledged `200` without effect, so a type the provider adds
   * later cannot fail the endpoint.
   */
  type: string;
  /**
   * `event.created`, used **only** as the fallback `canceledAt` of a `charge.expired` event whose
   * own object carries no cancellation time. It never orders events: the timestamp has second
   * precision, so two events of one second are indistinguishable, and every decision instead reads
   * the state a PaymentIntent actually reports (AAP 0.2.2, AAP 0.3.2).
   */
  createdAt: Date;
  /** The normalized object the event carried. */
  object: WebhookObject;
}

/*
 * The gateway (AAP 0.5.1, AAP 0.6.2).
 */

/**
 * The one way any other module talks to Stripe (AAP 0.5.1, AAP 0.6.2).
 *
 * `stripe-gateway.ts` implements it against the SDK; `holds.ts`, `operations.ts`, `webhook.ts`,
 * `meetups/accept.ts`, `me/payment-setup.ts` and `settlement/settle.ts` depend on it. Two rules hold
 * for every method: one that can leave the outcome of a provider call unknown throws
 * {@link PaymentUnavailableError} rather than reporting an effect that may not have happened, and
 * every method may be called again under the same idempotency key, because that is how the
 * `PaymentOperation` executor completes an operation a crash interrupted (AAP 0.3.2).
 */
export interface PaymentsGateway {
  /**
   * Place and confirm the authorization for one hold attempt (AAP 0.2.4, AAP 0.5.3).
   *
   * Confirmed on-session from the customer's saved card, so the authorization is
   * customer-initiated and carries the 7-day window. A decline or a missing card is **returned** as
   * the `declined` arm of {@link HoldResult}; it is not thrown.
   *
   * @param request The attempt, its amount and its idempotency key.
   * @throws PaymentUnavailableError when the outcome is unknown — a timeout, a connection error, a
   *   5xx, a 429 or an unrecognized failure — so `operations.ts` reconciles rather than guesses: it
   *   replays the create under the same key, which the provider answers with the stored result of
   *   the first request, and persists the recovered PaymentIntent.
   * @throws PaymentIdempotencyError when replaying the key is refused as an idempotency conflict
   *   that the recovery cannot resolve: a conflict is first resolved by recovering the PaymentIntent
   *   the metadata this application itself wrote on the attempt names — the parameters a replay
   *   derives can differ from the first request's — and only a conflict that finds no such intent, or
   *   one whose status decides nothing, is left for `operations.ts` to log as
   *   `hold_replay_params_changed` and hand to the operator, never to replay again.
   * @throws PaymentRejectedError on a definite 4xx refusal that is not a card error, such as
   *   `resource_missing` or `payment_intent_unexpected_state`: nothing happened, and the caller
   *   retrieves the PaymentIntent to decide.
   */
  createAndConfirmHold(request: HoldRequest): Promise<HoldResult>;

  /**
   * Cancel a hold with our own cancellation reason and report the state after the cancel
   * (AAP 0.3.2).
   *
   * Every cancel carries `OUR_CANCELLATION_REASON`, which is what distinguishes our release from
   * Stripe's own cancellation when the `payment_intent.canceled` webhook arrives: a cancellation
   * with any other reason, or a `charge.expired` event, is a hold loss rather than a release, and
   * the deposit takes the `expired` transition with no forfeit (AAP 0.5.3).
   *
   * @param paymentIntentId The attempt's PaymentIntent.
   * @param idempotencyKey `release:<depositId>:<attempt>`, reused verbatim by every retry.
   * @throws PaymentUnavailableError when the outcome is unknown; the executor then retrieves the
   *   PaymentIntent and records a release that already happened instead of cancelling twice.
   * @throws PaymentRejectedError when the provider refuses the cancel outright, which the executor
   *   resolves by retrieving the PaymentIntent.
   */
  releaseHold(paymentIntentId: string, idempotencyKey: string): Promise<IntentState>;

  /**
   * Capture the full authorized amount of a hold (AAP 0.5.3, AAP 0.5.7).
   *
   * Run for the absent party's hold at a `no_show` settlement and for the canceller's hold on a late
   * cancellation. A deposit is captured whole or not at all, so the full amount is captured.
   *
   * @param paymentIntentId The attempt's PaymentIntent.
   * @param idempotencyKey `capture:<depositId>:<attempt>`, reused verbatim by every retry.
   * @throws PaymentUnavailableError when the outcome is unknown; the executor retrieves the
   *   PaymentIntent and records a capture that already happened rather than capturing twice.
   * @throws PaymentRejectedError when the provider refuses because the authorization is gone. A
   *   capture that fails terminally on an expired hold is the evidence that the hold was lost before
   *   the settlement committed, and is what triggers the no-forfeit compensation of AAP 0.3.2.
   * @throws PaymentDeclinedError when the capture is refused for a card reason.
   */
  captureHold(paymentIntentId: string, idempotencyKey: string): Promise<IntentState>;

  /**
   * Refund a captured hold (AAP 0.3.2).
   *
   * Written as the reversing operation of a fencing resolution — an operator `no_fault`, or the
   * compensation of a forfeit whose hold turned out to have been lost — and resolved against the
   * PaymentIntent's actual state when it runs: a captured intent is refunded here, an uncaptured one
   * is cancelled by {@link PaymentsGateway.releaseHold} instead, and an already-cancelled one needs
   * nothing.
   *
   * @param paymentIntentId The captured attempt's PaymentIntent.
   * @param idempotencyKey `refund:<depositId>:<attempt>`, reused verbatim by every retry.
   * @throws PaymentUnavailableError when the outcome is unknown; the executor retrieves the
   *   PaymentIntent, where a fully refunded charge reports `refunded`, rather than refunding twice.
   * @throws PaymentRejectedError on a definite 4xx refusal, such as a charge that was never
   *   captured, which the executor settles by retrieving the PaymentIntent.
   */
  refund(paymentIntentId: string, idempotencyKey: string): Promise<RefundResult>;

  /**
   * Create or reuse the customer behind a saved card and start a card setup (AAP 0.5.4).
   *
   * `customerId` is `null` for an account that has never set a card up, and the gateway creates the
   * customer then; otherwise the customer it is given is reused. The SetupIntent it returns is what
   * PaymentSheet (native) or the Payment Element (web) confirms, so no card data reaches this API
   * (AAP 0.3.2).
   *
   * @param input The account's existing customer id, or `null` on first use.
   * @throws PaymentUnavailableError when the outcome is unknown.
   * @throws PaymentRejectedError on a definite 4xx refusal.
   */
  createSetup(input: { customerId: string | null }): Promise<SetupResult>;

  /**
   * Delete the Stripe customer recorded for an erased account (AAP 0.5.3).
   *
   * Run by the `delete_customer` operation once every deposit of the user is final and no dispute on
   * their meetups is open. A customer that was already deleted, or that no longer exists, counts as
   * success, so the operation is safe to replay.
   *
   * @param customerId The Stripe customer to delete.
   * @param idempotencyKey `delete_customer:<userId>`, built by `me/deletion.ts`.
   * @throws PaymentUnavailableError when the outcome is unknown; the operation stays pending and the
   *   copied customer id is cleared only in the transaction that records success.
   */
  deleteCustomer(customerId: string, idempotencyKey: string): Promise<void>;

  /**
   * Read the authoritative state of a PaymentIntent (AAP 0.3.2).
   *
   * Every reconciliation reads this rather than assuming what a lost answer meant: an `executing`
   * operation older than two minutes, a timeout, a refused request and the settlement's check of
   * both authorizations before its transaction all decide on what the provider reports here.
   *
   * @throws PaymentUnavailableError when the PaymentIntent cannot be read; nothing is decided from a
   *   state that could not be observed.
   * @throws PaymentRejectedError when the id does not exist, which the executor resolves as the
   *   absence of an effect.
   */
  retrievePaymentIntent(paymentIntentId: string): Promise<IntentState>;

  /**
   * Verify a Stripe event's signature and normalize it (AAP 0.3.2, AAP 0.3.3).
   *
   * Synchronous, because nothing about a signature check waits and the endpoint must answer `2xx`
   * quickly: the work an event implies happens inside the handler's own transaction. The signature
   * covers the raw request body, so the route passes the unparsed bytes together with the
   * `Stripe-Signature` header, and the secret is the configured `STRIPE_WEBHOOK_SECRET`.
   *
   * `receivedAt` is the request's injected-clock instant (`request.receivedAt`), by which the
   * provider's signature tolerance is judged. Reading the application clock rather than the wall
   * clock is what lets a suite on the test clock sign an event with a timestamp from its own clock
   * (AAP 0.11.1); it takes a third parameter where the parent folder's contract named two.
   *
   * @param rawBody The bytes exactly as received, before any parsing.
   * @param signature The value of the `Stripe-Signature` header.
   * @param receivedAt The instant the request arrived, from the injected clock.
   * @throws BadSignatureError when the header is missing or malformed, when the timestamp is outside
   *   tolerance or when the signature was made with another secret; `webhook.ts` maps it to
   *   `400 bad_signature`.
   */
  verifyWebhook(rawBody: Buffer, signature: string, receivedAt: Date): VerifiedWebhookEvent;
}

/*
 * Typed failures (AAP 0.3.2).
 */

/**
 * The base of every failure this boundary raises (AAP 0.3.2).
 *
 * A message carries a code and nothing else: never a card number, a client secret, an ephemeral key,
 * a customer's email address or the provider's own message, because a message reaches a log line and
 * the error envelope. The provider's error and the signature failure travel in `cause` instead, which
 * is logged and never answered (AAP 0.11.1). The prototype is re-set so `instanceof` holds under the
 * ES2023 class output, where a subclass's own prototype would otherwise be dropped.
 */
export abstract class PaymentError extends Error {
  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A card error on an operation other than placing a hold (AAP 0.3.2, AAP 0.5.3).
 *
 * Hold creation reports a decline as the `declined` arm of {@link HoldResult} rather than throwing;
 * this is for the rare case where an operation on an already-authorized hold — a capture — is refused
 * for a card reason, which the executor treats as the terminal failure it is.
 */
export class PaymentDeclinedError extends PaymentError {
  /** The provider's decline code, `decline_code ?? code`. */
  readonly code: string;
  /** The attempt's PaymentIntent, or `null` when the failing request named none. */
  readonly paymentIntentId: string | null;

  constructor(code: string, paymentIntentId: string | null, options?: ErrorOptions) {
    super(`card_declined:${code}`, options);
    this.code = code;
    this.paymentIntentId = paymentIntentId;
  }
}

/**
 * A Stripe call whose outcome is unknown, so nothing may be assumed about its effect (AAP 0.3.2).
 *
 * It covers the failures that leave the question open — a timeout, a connection error, a 5xx, a 429
 * and the `api_error` type, plus any status this application does not model — and `operations.ts`
 * treats it as ambiguous: the operation is reconciled against the PaymentIntent and only then
 * retried, always under its original idempotency key.
 */
export class PaymentUnavailableError extends PaymentError {
  /**
   * Which failure it was: `timeout`, `network`, `server`, `rate_limited`, `api` (a provider-side
   * error), `unexpected_status` (a response this application does not model) or `configuration`
   * (credentials or mode the process cannot use).
   */
  readonly reason:
    | 'timeout'
    | 'network'
    | 'server'
    | 'rate_limited'
    | 'api'
    | 'unexpected_status'
    | 'configuration';
  /** The provider's HTTP status when there was one, which the log records and no response carries. */
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
 * A Stripe request the provider refused outright (AAP 0.3.2).
 *
 * Added to the failures AAP 0.5.1 names: a definite 4xx that is not a card error, such as
 * `payment_intent_unexpected_state` or `resource_missing`, proves the request had no effect, so
 * nothing is ambiguous about it. The executor therefore retrieves the PaymentIntent and records the
 * state it finds instead of replaying the operation blindly.
 */
export class PaymentRejectedError extends PaymentError {
  /** The provider's error code. */
  readonly code: string;
  /** The HTTP status the provider answered with. */
  readonly statusCode: number;

  constructor(code: string, statusCode: number, options?: ErrorOptions) {
    super(`payment_rejected:${code}:${statusCode}`, options);
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * A replayed idempotency key whose parameters differ from the first request's (AAP 0.3.2).
 *
 * The provider raises it as an `idempotency_error`, and it means the attempt was not replayed — the
 * original request stands and the new parameters were never sent. `operations.ts` logs
 * `hold_replay_params_changed` and leaves the hold to the 12-hour rule rather than sending a second
 * authorization, because an attempt whose parameters changed cannot be recovered by replaying it.
 */
export class PaymentIdempotencyError extends PaymentError {
  constructor(options?: ErrorOptions) {
    super('idempotency_error', options);
  }
}

/**
 * A webhook whose signature did not verify: a missing or malformed header, a timestamp outside
 * tolerance, or a signature made with another secret (AAP 0.3.2, AAP 0.3.3).
 *
 * `webhook.ts` maps it to `400 bad_signature` and applies nothing.
 */
export class BadSignatureError extends PaymentError {
  constructor(options?: ErrorOptions) {
    super('bad_signature', options);
  }
}

/** The names of the failures {@link isPaymentError} accepts when a second copy of this module loaded. */
const PAYMENT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'PaymentDeclinedError',
  'PaymentUnavailableError',
  'PaymentRejectedError',
  'PaymentIdempotencyError',
  'BadSignatureError',
]);

/**
 * Whether a thrown value is a {@link PaymentError}.
 *
 * A second copy of this module in one process — a test double, a duplicated ESM graph — fails
 * `instanceof`, so a value that names one of these failures is accepted too: the executor reads only
 * the class and the fields it declares.
 */
export function isPaymentError(error: unknown): error is PaymentError {
  if (error instanceof PaymentError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const name: unknown = (error as { name?: unknown }).name;
  return typeof name === 'string' && PAYMENT_ERROR_NAMES.has(name);
}

/*
 * The Stripe timing store (AAP 0.12.2).
 */

/**
 * The milliseconds spent inside Stripe calls on the current request (AAP 0.12.2).
 *
 * AAP 0.12.2 measures the write-latency target excluding Stripe, so k6 subtracts the value reported
 * in the `Server-Timing: stripe;dur=` header from each write it times. The store is an
 * `AsyncLocalStorage` rather than a field on the request because `stripe-gateway.ts` is called from
 * the executor and from domain functions that never see the Fastify request, and it is per-request
 * because one process serves many.
 */
const stripeTimingStore = new AsyncLocalStorage<{ ms: number }>();

/**
 * Run `cb` inside a fresh timing store, so everything it awaits accumulates into one figure.
 *
 * `app.ts` calls it from an `onRequest` hook as `withStripeTimingStore(done)` — the callback-style
 * hook — which propagates the store through the rest of the request lifecycle, including the async
 * continuations of the handlers. Each request therefore starts at zero, and background work that
 * never enters a store accumulates nowhere.
 *
 * @param cb The callback to run inside the new store.
 * @returns Whatever `cb` returns.
 */
export function withStripeTimingStore<T>(cb: () => T): T {
  return stripeTimingStore.run({ ms: 0 }, cb);
}

/**
 * Add one Stripe call's duration to the current request's store.
 *
 * `stripe-gateway.ts` measures the duration with `node:perf_hooks`' monotonic `performance.now()`,
 * so this is a measured duration rather than wall-clock time and the clock rule of AAP 0.11.1 is
 * untouched. Outside a store — the settlement sweeper, a queue processor — this is a no-op, and a
 * negative or non-finite value is ignored because it would corrupt the sum.
 *
 * @param ms The duration of one Stripe call, in milliseconds.
 */
export function recordStripeMs(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const store = stripeTimingStore.getStore();
  if (store === undefined) return;
  store.ms += ms;
}

/**
 * The milliseconds recorded so far on the current request, rounded to one decimal for the
 * `Server-Timing` header, or 0 outside a store.
 */
export function currentStripeMs(): number {
  const store = stripeTimingStore.getStore();
  if (store === undefined) return 0;
  return Math.round(store.ms * 10) / 10;
}
