/**
 * The Stripe SDK adapter — the only file in the workspace that imports `stripe` (AAP 0.6.2).
 *
 * `./gateway.ts` states what every other module may ask for; this file is the sole implementation and
 * keeps every `Stripe.*` type inside its own boundary, so the provider stays swappable and the seam the
 * root ESLint config enforces is real. Four decisions shape it:
 *
 * - **On-session holds, manual capture, USD** (AAP 0.2.4, AAP 0.3.1). A deposit is authorized with
 *   `capture_method: 'manual'` and `confirm: true` from the card the customer saved earlier, so the
 *   authorization is customer-initiated and carries the 7-day window AAP 0.2.4 records. Merchant-
 *   initiated confirmation is never used — `off_session`, `error_on_requires_action` and
 *   `setup_future_usage` are always left unset — because such a Visa hold lasts about 5 days and a
 *   meetup may start up to 5 days after the proposal, so it could expire before there was anything to
 *   settle.
 * - **The caller owns idempotency** (AAP 0.3.2). Every key arrives from `holds.ts` and is passed
 *   through unchanged, and the client is built with `maxNetworkRetries: 0`, so a request is sent once
 *   and `operations.ts` alone decides whether to replay it.
 * - **A hold loss is never a forfeit** (AAP 0.3.2, AAP 0.5.3). Every cancel carries
 *   `OUR_CANCELLATION_REASON`; a cancellation Stripe made for any other reason — `expired` for an
 *   expired authorization under the pinned API version — or a `charge.expired` event means the hold was
 *   lost, which the deposit lifecycle reads from {@link IntentState.cancellationReason}.
 * - **No card data reaches this API** (AAP 0.3.2). The customer is created with no email, name or
 *   phone, every card entry happens in a Stripe UI component on the client, and nothing here carries a
 *   card number, a CVC or an expiry.
 *
 * Every call is timed by {@link recordStripeMs} for the `Server-Timing: stripe;dur=` header AAP 0.12.2
 * measures the write-latency target against, and every failure becomes a `./gateway.ts` error class.
 *
 * Mode contract (AAP 0.6.2). `mock`, the local stack's default, points the client at the stateful
 * `stripe-proxy` given as `STRIPE_API_BASE` and authenticates with {@link STRIPE_MOCK_PLACEHOLDERS};
 * `test` and `live` use the three values the process's env guard already checked. The proxy must
 * therefore serve every endpoint called here — `customers` retrieve, create and delete;
 * `customers/:id/payment_methods` list; `setup_intents` create; `ephemeral_keys` create;
 * `payment_intents` create, retrieve, cancel and capture; and `refunds` create — which is this file's
 * cross-folder contract with `apps/api/test/support/stripe-proxy`.
 *
 * @see AAP 0.2.4 for the hold lifecycle and the API-version decision, 0.3.2 for the `PaymentOperation`
 * executor this file serves, 0.3.3 for the integration row, 0.5.3 for the state machines these results
 * drive, 0.5.4 for the routes that map them onto the error envelope, and 0.11.1 for the 10-second
 * timeout every external call carries.
 */

import { performance } from 'node:perf_hooks';

import Stripe from 'stripe';

import { STRIPE_MOCK_PLACEHOLDERS } from '@tablemate/server-core';
import type { ApiEnv, Logger } from '@tablemate/server-core';
import { OUR_CANCELLATION_REASON, PaymentIntentMetadata } from '@tablemate/shared';

import {
  BadSignatureError,
  PaymentDeclinedError,
  PaymentIdempotencyError,
  PaymentRejectedError,
  PaymentUnavailableError,
  isPaymentError,
  recordStripeMs,
} from './gateway.ts';
import type {
  HoldRequest,
  HoldResult,
  IntentState,
  IntentStatus,
  PaymentError,
  PaymentsGateway,
  RefundResult,
  SetupResult,
  VerifiedWebhookEvent,
  WebhookObject,
} from './gateway.ts';

/**
 * The Stripe API version every request is pinned to (AAP 0.2.4, AAP 0.3.1).
 *
 * `satisfies` turns the pin into a compile-time check: the literal must equal the SDK's own
 * `ApiVersion`, so a dependency bump that moves the SDK to a newer version fails the build here
 * instead of silently changing what this API sends — which is what AAP 0.2.4 reasoned about.
 */
export const STRIPE_API_VERSION = '2026-10-28.endive' satisfies Stripe.LatestApiVersion;

/**
 * The API version an ephemeral key is created under, overriding the client's own (AAP 0.3.3).
 *
 * `@stripe/stripe-react-native` 0.38.6, the Expo SDK 52 pin, wraps Stripe iOS 23.28.x, whose API
 * header is pinned to `2020-08-27`, and Stripe's React Native PaymentSheet guide creates the key with
 * that version through a per-request override. Android 20.48's internal version is `2020-03-02`; the
 * criterion-1 Maestro run on Android is what confirms that pairing. The web Payment Element needs no
 * ephemeral key at all — it uses the SetupIntent's client secret alone.
 */
export const EPHEMERAL_KEY_API_VERSION = '2020-08-27';

/** The provider timeout AAP 0.11.1 gives every external call, and how this process identifies itself. */
const STRIPE_TIMEOUT_MS = 10_000;
const APP_INFO: Stripe.AppInfo = { name: 'tablemate-api', version: '0.1.0' };

/** The seconds of signature tolerance Stripe's own SDK defaults to. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/** How many saved cards one hold's card selection considers, so the choice is stable across a replay. */
const CARD_SEARCH_LIMIT = 100;

/**
 * How many of a customer's PaymentIntents one recovery read considers (AAP 0.3.2).
 *
 * A recovery only ever runs from the replay of a live attempt, so the intent the first request made —
 * if it made one — is among the customer's newest, and one page of 100 is enough for it to be there.
 * The provider's search endpoint is refused here instead: its own documentation says not to use it in
 * a read-after-write flow where strict consistency is necessary, because data is searchable in less
 * than a minute, while a list is strongly consistent. Bounding the read also keeps the recovery to
 * one request inside the 10-second timeout rather than a paginated scan.
 */
const HOLD_RECOVERY_LIST_LIMIT = 100;

/** How the SDK's own timeout abort reads, which is the connection failure carrying no distinct `code`. */
const TIMEOUT_MESSAGE = /timed out|timeout/i;

/** `no_saved_card` is what `POST /meetups` turns into `402 hold_failed`; the rest stand in for a value
 * the provider gave no code for, except `resource_missing`, which says a customer is already gone and
 * is what a replayed `delete_customer` counts as success (AAP 0.5.3, AAP 0.5.4). */
const NO_SAVED_CARD = 'no_saved_card';
const CARD_DECLINED = 'card_declined';
const RESOURCE_MISSING = 'resource_missing';
const INVALID_REQUEST = 'invalid_request';

/** The `event` of every failure this file logs, and the type it reports for a non-Stripe failure. */
const STRIPE_CALL_FAILED = 'stripe_call_failed';
const UNKNOWN_ERROR_TYPE = 'unknown_error';

/**
 * Every status a PaymentIntent can hold (AAP 0.5.3), so a status this build does not model can be told
 * apart from one it does. The provider's own type widens to `string` for forward compatibility, which
 * is why the narrowing below exists at all.
 */
const INTENT_STATUSES: readonly IntentStatus[] = [
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'requires_capture',
  'canceled',
  'succeeded',
];

/** The id of a Stripe field that may hold an id, an expanded object, `null` or nothing at all. */
function idOf(value: { id: string } | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : value.id;
}

/**
 * The capture deadline a charge reports (AAP 0.2.4). Only an expanded charge carries it, and it is what
 * `Deposit.captureBefore` records when a deposit becomes `held` (AAP 0.5.2).
 */
function captureBeforeOf(charge: Stripe.Charge | null): Date | null {
  const seconds = charge?.payment_method_details?.card?.capture_before;
  return seconds === undefined ? null : new Date(seconds * 1000);
}

/** The status of a provider response, or `null` when this build does not model it. */
function toIntentStatus(status: string): IntentStatus | null {
  return INTENT_STATUSES.find((known) => known === status) ?? null;
}

/**
 * One provider PaymentIntent, normalized (AAP 0.3.2, AAP 0.5.3).
 *
 * This is the authoritative view the executor, the settlement and the webhook handler decide on, so
 * nothing is inferred: a `latest_charge` that arrived as an id leaves the capture deadline and the
 * refund flag at their defaults, and `metadata` is the attempt metadata this application wrote or
 * `null` when it is absent or malformed.
 *
 * @throws PaymentUnavailableError with the `unexpected_status` reason when the provider reports a
 *   status this build cannot name: nothing may be decided from a state that cannot be expressed, which
 *   is what that reason exists for.
 */
function toIntentState(intent: Stripe.PaymentIntent): IntentState {
  const status = toIntentStatus(intent.status);
  if (status === null) throw new PaymentUnavailableError('unexpected_status');
  const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
  const metadata = PaymentIntentMetadata.safeParse(intent.metadata);
  const canceledAt = intent.canceled_at;
  return {
    id: intent.id,
    status,
    customerId: idOf(intent.customer),
    cancellationReason: intent.cancellation_reason ?? null,
    canceledAt: canceledAt === null ? null : new Date(canceledAt * 1000),
    captureBefore: captureBeforeOf(charge),
    amountCents: intent.amount,
    amountCapturableCents: intent.amount_capturable,
    amountReceivedCents: intent.amount_received,
    refunded: charge?.refunded ?? false,
    clientSecret: intent.client_secret ?? null,
    metadata: metadata.success ? metadata.data : null,
  };
}

/**
 * The object a verified event carried, reduced to the fields the handler applies (AAP 0.3.2).
 *
 * The whole provider object never leaves this boundary, so a field the provider added cannot reach the
 * database or a response by accident. An object of a kind this API does not model is reported as
 * `other`, which the handler applies as a no-op rather than failing the endpoint.
 */
function toWebhookObject(event: Stripe.Event): WebhookObject {
  const object = event.data.object;
  if (object.object === 'payment_intent') {
    return { kind: 'payment_intent', intent: toIntentState(object) };
  }
  if (object.object === 'charge') {
    return {
      kind: 'charge',
      chargeId: object.id,
      paymentIntentId: idOf(object.payment_intent),
      refunded: object.refunded,
      captureBefore: captureBeforeOf(object),
    };
  }
  if (object.object === 'setup_intent') {
    return {
      kind: 'setup_intent',
      setupIntentId: object.id,
      customerId: idOf(object.customer),
      paymentMethodId: idOf(object.payment_method),
    };
  }
  return { kind: 'other' };
}

/**
 * The customer's newest saved card, by `created` then by `id` (AAP 0.3.2).
 *
 * Deterministic on purpose: a hold replayed under its original idempotency key must send identical
 * parameters, and Stripe answers a replay whose parameters differ with an idempotency error. Ties on
 * `created`, which second-precision timestamps make possible, break on the greater id.
 */
function newestCardId(cards: readonly Stripe.PaymentMethod[]): string | null {
  let newest: Stripe.PaymentMethod | null = null;
  for (const card of cards) {
    const isLater =
      newest === null ||
      card.created > newest.created ||
      (card.created === newest.created && card.id > newest.id);
    if (isLater) newest = card;
  }
  return newest === null ? null : newest.id;
}

/**
 * The first value that is neither absent nor empty.
 *
 * `StripeCardError` assigns `decline_code = raw.decline_code ?? ''`, so a card error that is not an
 * issuer decline carries an empty string rather than a missing field, and `??` alone would report an
 * empty decline code.
 */
function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value !== '');
}

/** The decline code of a card error: Stripe's `decline_code`, then its `code`, then the generic one. */
function cardDeclineCode(error: Stripe.errors.StripeCardError): string {
  return firstNonEmpty(error.decline_code, error.code) ?? CARD_DECLINED;
}

/** The decline code of a refused PaymentIntent, in the same order. */
function declinedCode(error: Stripe.PaymentIntent['last_payment_error']): string {
  return firstNonEmpty(error?.decline_code, error?.code) ?? CARD_DECLINED;
}

/** Whether a connection failure is the SDK's own timeout abort rather than a network fault. */
function isTimeoutFailure(error: Stripe.errors.StripeConnectionError): boolean {
  // The abort carries no `code` of its own, only the message below; the code check covers a socket that
  // reported the timeout itself.
  return error.code === 'ETIMEDOUT' || TIMEOUT_MESSAGE.test(error.message);
}

/** The failure `timed` mapped, re-shaped so every `throw` in this file throws an `Error`. */
function toPaymentError(error: unknown): PaymentError {
  return isPaymentError(error)
    ? error
    : new PaymentUnavailableError('api', undefined, { cause: error });
}

/** The attempt's client secret, which every hold result other than a decline carries (AAP 0.5.3). */
function requireClientSecret(clientSecret: string | null): string {
  if (clientSecret === null) throw new PaymentUnavailableError('unexpected_status');
  return clientSecret;
}

/** The client configuration, pointed at the stateful proxy when the stack runs without credentials. */
function stripeClientConfig(stripeEnv: ApiEnv['stripe']): Stripe.StripeConfig {
  const config: Stripe.StripeConfig = {
    apiVersion: STRIPE_API_VERSION,
    timeout: STRIPE_TIMEOUT_MS,
    maxNetworkRetries: 0,
    telemetry: false,
    appInfo: APP_INFO,
  };
  if (stripeEnv.mode !== 'mock') return config;
  const url = new URL(stripeEnv.apiBase);
  return {
    ...config,
    host: url.hostname,
    port: Number(url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : url.port),
    protocol: url.protocol === 'https:' ? 'https' : 'http',
  };
}

/**
 * Build the payment gateway the API runs on (AAP 0.5.1, AAP 0.6.2).
 *
 * The configuration is the parsed `stripe` group of the process's own environment, so this file reads
 * no environment variable and re-checks nothing the env guard already decided.
 *
 * @param stripeEnv The process's Stripe configuration: the proxy URL and the fixed placeholders in
 *   `mock`, the three checked values in `test` and `live`.
 * @param deps The logger every provider failure is recorded through (AAP 0.11.1).
 * @returns The gateway. Every failure it raises is a `./gateway.ts` error class, and every method may be
 *   called again under the same idempotency key, which is how `operations.ts` completes an operation a
 *   crash interrupted (AAP 0.3.2).
 */
export function createStripeGateway(
  stripeEnv: ApiEnv['stripe'],
  deps: { logger: Logger },
): PaymentsGateway {
  const { logger } = deps;
  const client = new Stripe(
    stripeEnv.mode === 'mock' ? STRIPE_MOCK_PLACEHOLDERS.secretKey : stripeEnv.secretKey,
    stripeClientConfig(stripeEnv),
  );
  // The placeholders are the values the env loader puts in the `mock` variant, which is what makes the
  // proxy's webhook signing secret verify (AAP 0.6.2).
  const webhookSecret =
    stripeEnv.mode === 'mock' ? STRIPE_MOCK_PLACEHOLDERS.webhookSecret : stripeEnv.webhookSecret;

  /**
   * Map one provider failure onto the failure the executor decides on (AAP 0.3.2).
   *
   * Only the fields a log line needs are recorded — never the provider's `raw` error, a request's
   * parameters, a client secret or the secret key (AAP 0.3.2 Logs). The mapping is what makes an
   * outcome decidable: a definite 4xx proves nothing happened, while everything else leaves the
   * question open so the executor reconciles by retrieving the PaymentIntent.
   */
  function mapStripeError(op: string, error: unknown): PaymentError {
    if (!(error instanceof Stripe.errors.StripeError)) {
      logger.warn(
        { event: STRIPE_CALL_FAILED, op, type: UNKNOWN_ERROR_TYPE },
        'stripe call failed',
      );
      return new PaymentUnavailableError('api', undefined, { cause: error });
    }
    const fields = {
      event: STRIPE_CALL_FAILED,
      op,
      type: error.type,
      code: error.code,
      statusCode: error.statusCode,
      requestId: error.requestId,
    };
    if (
      error instanceof Stripe.errors.StripeAuthenticationError ||
      error instanceof Stripe.errors.StripePermissionError
    ) {
      // Credentials or a mode the process cannot use: louder than a transient provider failure, because
      // nothing will succeed until the configuration is fixed.
      logger.error(fields, 'stripe call failed');
      return new PaymentUnavailableError('configuration', error.statusCode, { cause: error });
    }
    logger.warn(fields, 'stripe call failed');
    if (error instanceof Stripe.errors.StripeCardError) {
      return new PaymentDeclinedError(cardDeclineCode(error), idOf(error.payment_intent), {
        cause: error,
      });
    }
    if (error instanceof Stripe.errors.StripeIdempotencyError) {
      return new PaymentIdempotencyError({ cause: error });
    }
    if (error instanceof Stripe.errors.StripeConnectionError) {
      return new PaymentUnavailableError(
        isTimeoutFailure(error) ? 'timeout' : 'network',
        undefined,
        {
          cause: error,
        },
      );
    }
    if (error instanceof Stripe.errors.StripeRateLimitError) {
      return new PaymentUnavailableError('rate_limited', 429, { cause: error });
    }
    if (error instanceof Stripe.errors.StripeInvalidRequestError) {
      const statusCode = error.statusCode ?? 400;
      if (statusCode < 500) {
        return new PaymentRejectedError(error.code ?? INVALID_REQUEST, statusCode, {
          cause: error,
        });
      }
    }
    // A 5xx the provider answered — which the SDK reports as `StripeAPIError` — is a provider-side
    // failure rather than a refusal, so it stays ambiguous; anything else is an unclassified error.
    const statusCode = error.statusCode;
    if (statusCode !== undefined && statusCode >= 500) {
      return new PaymentUnavailableError('server', statusCode, { cause: error });
    }
    return new PaymentUnavailableError('api', statusCode, { cause: error });
  }

  /**
   * Run one Stripe call, record its duration and map its failure (AAP 0.3.2, AAP 0.12.2).
   *
   * The duration comes from `node:perf_hooks`' monotonic clock and is recorded in `finally`, so a
   * failed call is timed too. No wall-clock time is read anywhere in this file, which is what the clock
   * rule of AAP 0.11.1 requires.
   */
  async function timed<T>(op: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await fn();
    } catch (error) {
      throw mapStripeError(op, error);
    } finally {
      recordStripeMs(performance.now() - startedAt);
    }
  }

  /**
   * The card this attempt authorizes against: the customer's default when one is set, otherwise the
   * newest saved card (AAP 0.3.2). `null` means there is no card at all to authorize against.
   */
  async function selectPaymentMethod(customerId: string): Promise<string | null> {
    const customer = await timed('hold:customer', () => client.customers.retrieve(customerId));
    // A deleted customer cannot be authorized against; the caller reports `no_saved_card`.
    if (customer.deleted) return null;
    const preferred = idOf(customer.invoice_settings.default_payment_method);
    if (preferred !== null) return preferred;
    const cards = await timed('hold:cards', () =>
      client.customers.listPaymentMethods(customerId, { type: 'card', limit: CARD_SEARCH_LIMIT }),
    );
    return newestCardId(cards.data);
  }

  /**
   * The result a create the provider refused as an idempotency conflict did not lose (AAP 0.3.2).
   *
   * A replay sends a `payment_method` re-derived from the customer's live state, so it stops being
   * the first request's as soon as a card is saved or the default is re-pointed in between; the
   * provider then answers `idempotency_error` and the attempt would stay unresolved until the
   * twelve-hour rule. The first request is not lost, though: it wrote this attempt's `depositId` and
   * `attempt` into the PaymentIntent's metadata when it confirmed it, which is what finds that intent
   * again. What comes back is reported exactly as the first request's own answer would have been, and
   * `operations.ts` persists the id on the operation and on the deposit.
   *
   * The read is a list of the customer's own PaymentIntents, newest first, bounded by
   * {@link HOLD_RECOVERY_LIST_LIMIT} and timed by {@link timed} like every other call here, so it is
   * measured for `Server-Timing` and its failures are mapped.
   *
   * @param request The attempt being replayed, whose metadata is the link to its own intent.
   * @param cause The conflict being resolved, rethrown when nothing resolves it.
   * @throws PaymentIdempotencyError when no listed PaymentIntent carries this attempt's metadata, or
   *   when the one that does reports a status nothing can be decided from: an attempt that cannot be
   *   resolved is left unresolved for the operator rather than guessed at.
   */
  async function recoverHoldAttempt(
    request: HoldRequest,
    cause: PaymentIdempotencyError,
  ): Promise<HoldResult> {
    const listed = await timed('hold:recover', () =>
      client.paymentIntents.list({
        customer: request.customerId,
        limit: HOLD_RECOVERY_LIST_LIMIT,
        // The result reports the deposit's `captureBefore`, which only an expanded charge carries
        // (AAP 0.2.4).
        expand: ['data.latest_charge'],
      }),
    );

    const matches = listed.data.filter((intent) => {
      const metadata = PaymentIntentMetadata.safeParse(intent.metadata);
      return (
        metadata.success &&
        metadata.data.depositId === request.depositId &&
        metadata.data.attempt === request.attempt
      );
    });

    if (matches.length > 1) {
      // A second intent under this attempt's metadata means the provider no longer held the first
      // request's idempotency result when a later send arrived; the newest is this attempt's own.
      logger.warn(
        {
          event: 'stripe_hold_recovery_multiple',
          op: 'hold:recover',
          depositId: request.depositId,
          attempt: request.attempt,
          count: matches.length,
        },
        'several PaymentIntents carry this attempt metadata',
      );
    }

    // Newest first, so the leading match is the intent this attempt's own create made.
    const recovered = matches[0];

    if (recovered === undefined) throw cause;

    switch (recovered.status) {
      case 'requires_capture': {
        const state = toIntentState(recovered);
        return {
          kind: 'requires_capture',
          paymentIntentId: state.id,
          clientSecret: requireClientSecret(state.clientSecret),
          captureBefore: state.captureBefore,
        };
      }
      case 'requires_action': {
        const state = toIntentState(recovered);
        return {
          kind: 'requires_action',
          paymentIntentId: state.id,
          clientSecret: requireClientSecret(state.clientSecret),
        };
      }
      case 'requires_payment_method':
        return {
          kind: 'declined',
          paymentIntentId: recovered.id,
          code: declinedCode(recovered.last_payment_error),
        };
      default:
        // `processing`, `requires_confirmation`, `canceled` and `succeeded` leave the attempt open —
        // its authorization may still be settling, or may already be gone — so nothing is decided
        // from them. The conflict stands, and `operations.ts` hands the unresolved operation to the
        // operator rather than replaying it (AAP 0.3.2).
        logger.warn(
          {
            event: 'stripe_hold_recovery_undecidable',
            op: 'hold:recover',
            depositId: request.depositId,
            attempt: request.attempt,
            status: recovered.status,
            paymentIntentId: recovered.id,
          },
          'recovered PaymentIntent has an undecidable status',
        );
        throw cause;
    }
  }

  /** Place and confirm one hold attempt (AAP 0.2.4, AAP 0.5.3). */
  async function createAndConfirmHold(request: HoldRequest): Promise<HoldResult> {
    const paymentMethodId = await selectPaymentMethod(request.customerId);
    if (paymentMethodId === null) {
      return { kind: 'declined', paymentIntentId: null, code: NO_SAVED_CARD };
    }

    let intent: Stripe.PaymentIntent;
    try {
      intent = await timed('hold:create', () =>
        client.paymentIntents.create(
          {
            amount: request.amountCents,
            currency: 'usd',
            customer: request.customerId,
            payment_method: paymentMethodId,
            // A card-only intent is expressed as the allowed list on this API version: the pre-2024
            // `payment_method_types` parameter does not exist on the pinned version's create params.
            // A single method type also means no `return_url` is needed.
            allowed_payment_method_types: ['card'],
            capture_method: 'manual',
            confirm: true,
            use_stripe_sdk: true,
            metadata: {
              meetupId: request.meetupId,
              depositId: request.depositId,
              attempt: String(request.attempt),
            },
            expand: ['latest_charge'],
          },
          { idempotencyKey: request.idempotencyKey },
        ),
      );
    } catch (error) {
      // A declined card is an ordinary result of proposing rather than an exception: `holds.ts` maps
      // this arm to `402 hold_failed`, the meetup stays `proposed` and the attempt may be retried.
      if (error instanceof PaymentDeclinedError) {
        return { kind: 'declined', paymentIntentId: error.paymentIntentId, code: error.code };
      }
      // A conflict says this send's parameters are not the first request's, not that the first
      // request is lost: the attempt's own PaymentIntent is recovered before the conflict stands.
      if (error instanceof PaymentIdempotencyError) {
        return await recoverHoldAttempt(request, error);
      }
      throw toPaymentError(error);
    }

    switch (intent.status) {
      case 'requires_capture': {
        const state = toIntentState(intent);
        return {
          kind: 'requires_capture',
          paymentIntentId: state.id,
          clientSecret: requireClientSecret(state.clientSecret),
          captureBefore: state.captureBefore,
        };
      }
      case 'requires_action': {
        const state = toIntentState(intent);
        return {
          kind: 'requires_action',
          paymentIntentId: state.id,
          clientSecret: requireClientSecret(state.clientSecret),
        };
      }
      case 'requires_payment_method':
        return {
          kind: 'declined',
          paymentIntentId: intent.id,
          code: declinedCode(intent.last_payment_error),
        };
      default:
        // A create that reached none of the three outcomes above leaves the caller unable to decide, so
        // it is reported as unknown and the executor reconciles by retrieving the PaymentIntent. The id
        // is in the logger's redaction list; the status is what makes this line readable.
        logger.warn(
          {
            event: 'stripe_hold_unexpected_status',
            op: 'hold:create',
            status: intent.status,
            paymentIntentId: intent.id,
          },
          'hold returned an unmodeled status',
        );
        throw new PaymentUnavailableError('unexpected_status');
    }
  }

  /** Cancel a hold with our own cancellation reason, and report the state after the cancel (AAP 0.3.2). */
  async function releaseHold(
    paymentIntentId: string,
    idempotencyKey: string,
  ): Promise<IntentState> {
    const intent = await timed('hold:release', () =>
      client.paymentIntents.cancel(
        paymentIntentId,
        { cancellation_reason: OUR_CANCELLATION_REASON, expand: ['latest_charge'] },
        { idempotencyKey },
      ),
    );
    return toIntentState(intent);
  }

  /** Capture the full authorized amount of a hold (AAP 0.5.3, AAP 0.5.7). */
  async function captureHold(
    paymentIntentId: string,
    idempotencyKey: string,
  ): Promise<IntentState> {
    const intent = await timed('hold:capture', () =>
      client.paymentIntents.capture(
        paymentIntentId,
        { expand: ['latest_charge'] },
        { idempotencyKey },
      ),
    );
    return toIntentState(intent);
  }

  /**
   * Refund a captured hold (AAP 0.3.2).
   *
   * @throws PaymentUnavailableError when the outcome is unknown, or when a created refund reports no
   *   status at all — the reversing operation is then reconciled against the PaymentIntent rather than
   *   recording a provider state this application invented.
   */
  async function refund(paymentIntentId: string, idempotencyKey: string): Promise<RefundResult> {
    const created = await timed('hold:refund', () =>
      client.refunds.create(
        { payment_intent: paymentIntentId, reason: OUR_CANCELLATION_REASON },
        { idempotencyKey },
      ),
    );
    const status = created.status;
    if (status === null) throw new PaymentUnavailableError('unexpected_status');
    return { refundId: created.id, status };
  }

  /**
   * Create or reuse the customer behind a saved card, and start a card setup (AAP 0.3.3, AAP 0.5.4).
   *
   * No email, name or phone is sent: profiles are pseudonymous (AAP 0.1.1), so a new customer is an
   * empty record that the client's own Stripe component attaches a card to.
   */
  async function createSetup(input: { customerId: string | null }): Promise<SetupResult> {
    const customerId =
      input.customerId ?? (await timed('setup:customer', () => client.customers.create({}))).id;
    const setupIntent = await timed('setup:intent', () =>
      client.setupIntents.create({
        customer: customerId,
        usage: 'on_session',
        allowed_payment_method_types: ['card'],
      }),
    );
    const ephemeralKey = await timed('setup:ephemeral_key', () =>
      client.ephemeralKeys.create(
        { customer: customerId },
        { apiVersion: EPHEMERAL_KEY_API_VERSION },
      ),
    );
    const setupIntentClientSecret = setupIntent.client_secret;
    const ephemeralKeySecret = ephemeralKey.secret;
    if (setupIntentClientSecret === null || ephemeralKeySecret === undefined) {
      throw new PaymentUnavailableError('unexpected_status');
    }
    return { customerId, setupIntentClientSecret, ephemeralKeySecret };
  }

  /** Delete the Stripe customer recorded for an erased account (AAP 0.5.3). */
  async function deleteCustomer(customerId: string, idempotencyKey: string): Promise<void> {
    try {
      await timed('customer:delete', () =>
        client.customers.del(customerId, {}, { idempotencyKey }),
      );
    } catch (error) {
      // A customer that is already gone counts as success, so the `delete_customer` operation is safe
      // to replay after a crash.
      if (error instanceof PaymentRejectedError && error.code === RESOURCE_MISSING) return;
      throw toPaymentError(error);
    }
  }

  /** Read the authoritative state of a PaymentIntent (AAP 0.3.2). */
  async function retrievePaymentIntent(paymentIntentId: string): Promise<IntentState> {
    const intent = await timed('payment_intent:retrieve', () =>
      client.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] }),
    );
    return toIntentState(intent);
  }

  /**
   * Verify a Stripe event's signature and normalize it (AAP 0.3.2, AAP 0.3.3).
   *
   * Synchronous, because nothing about a signature check waits and the endpoint must answer `2xx`
   * quickly. The tolerance is judged against `receivedAt`, the request's injected-clock instant, which
   * is what lets a suite on the test clock sign an event with a timestamp from that clock (AAP 0.11.1).
   *
   * @throws BadSignatureError when the header is missing or malformed, when the timestamp is outside
   *   tolerance, or when the signature was made with another secret; `webhook.ts` maps it to
   *   `400 bad_signature`. A body whose signature verifies but whose object cannot be normalized is not
   *   a signature failure, and is reported as unavailable instead.
   */
  function verifyWebhook(
    rawBody: Buffer,
    signature: string,
    receivedAt: Date,
  ): VerifiedWebhookEvent {
    let event: Stripe.Event;
    try {
      event = client.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
        SIGNATURE_TOLERANCE_SECONDS,
        undefined,
        // The SDK divides this argument by 1000 before subtracting the header's unix-seconds timestamp,
        // so it is milliseconds: seconds would leave the tolerance comparing a tiny number and accepting
        // an arbitrarily old event.
        receivedAt.getTime(),
      );
    } catch (error) {
      throw new BadSignatureError({ cause: error });
    }
    return {
      id: event.id,
      type: event.type,
      createdAt: new Date(event.created * 1000),
      object: toWebhookObject(event),
    };
  }

  return {
    createAndConfirmHold,
    releaseHold,
    captureHold,
    refund,
    createSetup,
    deleteCustomer,
    retrievePaymentIntent,
    verifyWebhook,
  };
}
