/**
 * The state of the stateful Stripe proxy, and the test-side helpers that drive it (AAP 0.3.3, 0.4.2).
 *
 * `stripe-mock` v0.206.0 validates a Stripe request but keeps nothing: it cannot answer with the PaymentIntent a
 * caller just created, replay an `Idempotency-Key`, or emit an event. Everything the integration suites need on top
 * of validation lives here, so `STRIPE_MODE=mock` exercises the real gateway over HTTP with no credential (AAP 0.6.2).
 */

import { createHmac, randomBytes } from 'node:crypto';

import type { HandledStripeEventType } from '@tablemate/shared';

// Type-only, and taken from the module that builds the instance: `App` is the plan's one declaration of the app's
// type, and nothing of `app.ts` is read here at runtime.
import type { App } from '../../../src/app.ts';

// Pins and fixtures (AAP 0.2.4, AAP 0.4.2)

/**
 * The Stripe API version every event reports, and the default `stripe-version` response header `./server.ts` sends:
 * the version `stripe` 23.1.0 is pinned to (AAP 0.2.4, AAP 0.3.1).
 */
export const PROXY_API_VERSION = '2026-10-28.endive';

/**
 * How long a hold stays capturable, in seconds: seven days (AAP 0.2.4). A hold is placed on-session and
 * customer-initiated, which is the window Visa, Mastercard and American Express give such an authorization; the
 * merchant-initiated window (about five days for Visa) is shorter than the five days a meetup may start after its
 * proposal, so it is never used. `capture_before` is `authorization + this`.
 */
export const HOLD_VALIDITY_SEC = 7 * 24 * 3600;

/** The path prefix `./server.ts` mounts every control route of {@link CONTROL_ROUTES} under. */
export const CONTROL_PREFIX = '/__proxy';

/**
 * Stripe's published test card ids, which `./server.ts` passes through to `POST /v1/payment_methods/:id/attach` and a
 * suite passes to a control.
 */
export const TEST_CARDS = {
  visa: 'pm_card_visa',
  authenticationRequired: 'pm_card_authenticationRequired',
  chargeDeclined: 'pm_card_chargeDeclined',
} as const;

/** One of {@link TEST_CARDS}' ids. */
export type TestCardId = (typeof TEST_CARDS)[keyof typeof TEST_CARDS];

/**
 * How each card fixture answers a confirmation: the outcome and the last four digits the card and its charge report
 * (AAP 0.3.2). One table drives both, so a fixture cannot report one card's digits with another card's outcome.
 */
const CARD_SPECS: Readonly<
  Record<
    TestCardId,
    { readonly outcome: 'hold' | 'authentication' | 'declined'; readonly last4: string }
  >
> = {
  [TEST_CARDS.visa]: { outcome: 'hold', last4: '4242' },
  [TEST_CARDS.authenticationRequired]: { outcome: 'authentication', last4: '3184' },
  [TEST_CARDS.chargeDeclined]: { outcome: 'declined', last4: '0002' },
};

/** The brand every fixture card reports. */
const CARD_BRAND = 'visa';

/** The expiry every fixture card reports; a fixed date keeps a snapshot comparable between runs. */
const CARD_EXP_MONTH = 12;
const CARD_EXP_YEAR = 2034;

/** What a declined card reports, in the wording Stripe uses (AAP 0.5.4 `402 hold_failed`). */
const CARD_DECLINED_MESSAGE = 'Your card was declined.';

/** What a failed 3-D Secure step reports; the code is the one the deposit lifecycle reads. */
const AUTHENTICATION_FAILED_CODE = 'payment_intent_authentication_failure';
const AUTHENTICATION_FAILED_MESSAGE = 'Your card was not authenticated.';

/**
 * The two reasons Stripe itself cancels an authorization with, as opposed to `OUR_CANCELLATION_REASON`: an
 * abandoned 3-D Secure step, and an authorization that ran past its capture deadline. Either one means the hold was
 * lost rather than released (AAP 0.2.4, AAP 0.3.2).
 */
const CANCELLATION_ABANDONED = 'abandoned';
const CANCELLATION_EXPIRED = 'expired';

/** The 3-D Secure step a card that requires authentication answers with. */
const NEXT_ACTION = { type: 'use_stripe_sdk', use_stripe_sdk: { type: 'three_d_secure_redirect' } };

/** The prefix and lifetime of an ephemeral key; the prefix is a test-only marker, not a credential. */
const EPHEMERAL_KEY_PREFIX = 'ek_test_';
const EPHEMERAL_KEY_TTL_SEC = 3600;

/** How a client secret is spelled: the object id, this infix, then {@link ID_LENGTH} random chars. */
const SECRET_INFIX = '_secret_';

/** The length of every random suffix, and the alphabet it is drawn from. */
const ID_LENGTH = 24;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/*
 * Stripe object shapes (AAP 0.3.3, AAP 0.5.3), each carrying the fields the gateway, the webhook handler and the
 * suites read; `livemode` is always false because no mode but a test ever reaches this state.
 */

/** A Stripe customer, always created with no email, name or phone (AAP 0.1.1, AAP 0.3.2). */
export interface StripeCustomer {
  readonly id: string;
  readonly object: 'customer';
  readonly created: number;
  readonly livemode: false;
  metadata: Record<string, string>;
  /** The card the gateway authorizes against when it is set, else the newest saved card. */
  invoice_settings: { default_payment_method: string | null };
  /**
   * Set by `DELETE /v1/customers/:id`. A retrieve still answers a deleted customer as this stub rather than a `404`,
   * which is what the gateway's `selectPaymentMethod` reads to report `no_saved_card` (AAP 0.3.2).
   */
  deleted?: true;
}

/** A saved card. `created` orders them, and the newest is the gateway's fallback card. */
export interface StripePaymentMethod {
  readonly id: string;
  readonly object: 'payment_method';
  readonly type: 'card';
  readonly card: {
    readonly brand: string;
    readonly last4: string;
    readonly exp_month: number;
    readonly exp_year: number;
  };
  customer: string | null;
  readonly created: number;
  readonly livemode: false;
}

/** A card setup (`POST /me/payment-setup`), on-session and card-only. */
export interface StripeSetupIntent {
  readonly id: string;
  readonly object: 'setup_intent';
  readonly client_secret: string;
  readonly customer: string | null;
  payment_method: string | null;
  status: 'requires_payment_method' | 'succeeded';
  readonly usage: string | null;
  readonly created: number;
  readonly livemode: false;
}

/** The short-lived key the native PaymentSheet needs; the web Payment Element uses none. */
export interface StripeEphemeralKey {
  readonly id: string;
  readonly object: 'ephemeral_key';
  readonly secret: string;
  readonly associated_objects: readonly { readonly type: 'customer'; readonly id: string }[];
  readonly created: number;
  readonly expires: number;
  readonly livemode: false;
}

/**
 * The charge behind a hold. Its `payment_method_details.card.capture_before` is the field `Deposit.captureBefore`
 * records, and it is only ever read from an expanded `latest_charge` (AAP 0.2.4, AAP 0.5.2).
 */
export interface StripeCharge {
  readonly id: string;
  readonly object: 'charge';
  readonly amount: number;
  amount_captured: number;
  amount_refunded: number;
  captured: boolean;
  refunded: boolean;
  readonly status: 'succeeded';
  readonly currency: string;
  readonly customer: string | null;
  readonly payment_intent: string;
  readonly payment_method: string;
  readonly payment_method_details: {
    readonly type: 'card';
    readonly card: {
      readonly brand: string;
      readonly last4: string;
      readonly capture_before: number;
    };
  };
  readonly metadata: Record<string, string>;
  readonly created: number;
  readonly livemode: false;
}

/**
 * A PaymentIntent: one hold attempt, one retry or one superseded attempt (AAP 0.3.2, AAP 0.5.3). `latest_charge` is
 * stored as the charge's id and only a response expands it, so a stored snapshot and an event payload always carry the
 * id — the rule the webhook handler correlates by.
 */
export interface StripePaymentIntent {
  readonly id: string;
  readonly object: 'payment_intent';
  readonly amount: number;
  amount_capturable: number;
  amount_received: number;
  readonly currency: string;
  readonly capture_method: string;
  readonly confirmation_method: 'automatic';
  status:
    | 'requires_payment_method'
    | 'requires_confirmation'
    | 'requires_action'
    | 'processing'
    | 'requires_capture'
    | 'canceled'
    | 'succeeded';
  readonly client_secret: string;
  readonly customer: string | null;
  payment_method: string | null;
  readonly payment_method_types: readonly string[];
  metadata: Record<string, string>;
  latest_charge: string | StripeCharge | null;
  next_action: Record<string, unknown> | null;
  last_payment_error: {
    readonly type: 'card_error';
    readonly code: string;
    readonly decline_code?: string;
    readonly message: string;
  } | null;
  cancellation_reason: string | null;
  canceled_at: number | null;
  readonly created: number;
  readonly livemode: false;
}

/** A refund of a captured hold, the reversal of a `no_fault` resolution (AAP 0.3.2). */
export interface StripeRefund {
  readonly id: string;
  readonly object: 'refund';
  readonly amount: number;
  readonly charge: string;
  readonly payment_intent: string;
  readonly status: 'succeeded';
  readonly created: number;
  readonly livemode: false;
}

/**
 * One recorded event, in the shape `stripe.webhooks.constructEvent` and the handler's own normalization read
 * (AAP 0.3.3). `type` is a {@link HandledStripeEventType}, so only a type the API applies can be recorded at all.
 */
export interface StripeEvent {
  readonly id: string;
  readonly object: 'event';
  readonly type: HandledStripeEventType;
  readonly created: number;
  readonly api_version: string;
  readonly livemode: false;
  readonly pending_webhooks: 1;
  readonly data: { readonly object: unknown };
}

/** The error envelope Stripe answers with, which the gateway maps onto its own error classes. */
export interface StripeErrorBody {
  error: {
    type:
      | 'card_error'
      | 'invalid_request_error'
      | 'idempotency_error'
      | 'api_error'
      | 'rate_limit_error';
    code?: string;
    decline_code?: string;
    message: string;
    param?: string;
    payment_intent?: unknown;
  };
}

/** What {@link ProxyState.handleStripe} answers: the status and body `./server.ts` sends. */
export interface StateResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * The parsed parameters of one Stripe request — form fields or query parameters, as `./server.ts` produces them.
 * Every Stripe scalar arrives as a string, so `'true'` is a boolean and an amount is a decimal string; repeated keys
 * (`expand[]=…`, `metadata[meetupId]=…`) arrive as an array or an object.
 */
export type FormValue = string | FormValue[] | { [key: string]: FormValue };

/** One Stripe request's parameters, keyed by name. */
export type StripeParams = { [key: string]: FormValue };

/** One Stripe request, as {@link ProxyState.handleStripe} takes it. */
export interface StripeRequest {
  readonly method: string;
  readonly path: string;
  readonly params: StripeParams;
}

/**
 * One injected transport fault (AAP 0.11.2). `path` is exact or uses `*` for one path segment, and the query string
 * is ignored; `method` is compared upper-case. A rule is consumed by the first request it matches.
 */
export interface FaultRule {
  /**
   * `drop` and `delay` are ambiguous failures: `./server.ts` performs the request and then destroys the socket, or
   * answers after `ms`, so the effect is durable while the caller sees a timeout. `fail` is a definite one: the
   * request is never performed and `status` is answered instead.
   */
  readonly kind: 'drop' | 'delay' | 'fail';
  readonly method: string;
  readonly path: string;
  /** How long a `delay` holds the response. */
  readonly ms?: number;
  /** The status a `fail` answers with. */
  readonly status?: number;
}

/** What {@link ProxyState.paymentIntents} selects on; every given member must match. */
export interface PaymentIntentFilter {
  readonly customer?: string;
  readonly status?: StripePaymentIntent['status'];
  readonly metadata?: Record<string, string>;
}

/** A deep copy of `value`, so a stored object and a returned body never share structure. */
function snapshot<T>(value: T): T {
  return structuredClone(value);
}

/** A random base62 suffix of {@link ID_LENGTH} characters, for an object id or a client secret. */
function randomToken(): string {
  const bytes = randomBytes(ID_LENGTH);
  let token = '';
  for (let index = 0; index < ID_LENGTH; index += 1) {
    token += BASE62[(bytes[index] ?? 0) % BASE62.length];
  }
  return token;
}

/** A Stripe id: the object's prefix, an underscore, then a random suffix. */
function newId(prefix: string): string {
  return `${prefix}_${randomToken()}`;
}

/** A client secret for an object id. */
function clientSecretFor(id: string): string {
  return `${id}${SECRET_INFIX}${randomToken()}`;
}

/**
 * Whether `value` is one of {@link TEST_CARDS}' ids. Narrowing on it tells a stored card and a card fixture apart
 * without a second lookup.
 */
function isTestCard(value: string): value is TestCardId {
  return Object.values(TEST_CARDS).some((id) => id === value);
}

/** The first string value of `key`, tolerating a numeric or boolean scalar from a JSON body. */
function scalar(params: StripeParams, key: string): string | undefined {
  const value: unknown = params[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** The integer value of `key`, or `undefined` when it is absent or not an integer. */
function integer(params: StripeParams, key: string): number | undefined {
  const text = scalar(params, key);
  if (text === undefined) return undefined;
  const value = Number.parseInt(text, 10);
  return Number.isNaN(value) ? undefined : value;
}

/** A `{ key: value }` parameter (`metadata[…]`, `invoice_settings[…]`) as plain string pairs. */
function record(params: StripeParams, key: string): Record<string, string> {
  const value = params[key];
  if (value === undefined || typeof value === 'string' || Array.isArray(value)) return {};
  const pairs: Record<string, string> = {};
  for (const name of Object.keys(value)) {
    const text = scalar(value, name);
    if (text !== undefined) pairs[name] = text;
  }
  return pairs;
}

/** Whether `expand` asks for `name`, given as an array, an indexed object or a single string. */
function expandHas(params: StripeParams, name: string): boolean {
  const value = params.expand;
  if (value === undefined) return false;
  const entries: FormValue[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : Object.values(value);
  return entries.some(
    (entry) => typeof entry === 'string' && (entry === name || entry.endsWith(`.${name}`)),
  );
}

/** The fields of {@link StripeErrorBody} beyond the type and the message. */
type ErrorExtras = Omit<StripeErrorBody['error'], 'type' | 'message'>;

/** One error body. */
function errorBody(
  type: StripeErrorBody['error']['type'],
  message: string,
  extras: ErrorExtras = {},
): StripeErrorBody {
  return { error: { type, message, ...extras } };
}

/** A `200` with `body`. */
function ok(body: unknown): StateResponse {
  return { status: 200, body };
}

/**
 * Stripe's `404` for an identifier it does not hold. `param` names the request parameter that referenced it, which is
 * what a suite asserts on: an unknown `payment_method` reports `payment_method`, not `id`.
 */
function missing(kind: string, id: string, param = 'id'): StateResponse {
  return {
    status: 404,
    body: errorBody('invalid_request_error', `No such ${kind}: '${id}'`, {
      code: 'resource_missing',
      param,
    }),
  };
}

/** Stripe's `400` for an absent required parameter. */
function parameterMissing(param: string): StateResponse {
  return {
    status: 400,
    body: errorBody('invalid_request_error', `Missing required parameter: ${param}`, {
      code: 'parameter_missing',
      param,
    }),
  };
}

/** Stripe's `400` for a request the object's own state does not allow. */
function refused(code: string, message: string): StateResponse {
  return { status: 400, body: errorBody('invalid_request_error', message, { code }) };
}

// The state (AAP 0.3.2, AAP 0.11.2)

/** What {@link createProxyState} may be handed. */
export interface ProxyStateOptions {
  /**
   * The wall clock in milliseconds, read only while `setNow` has pinned nothing. A suite that wants deterministic
   * timestamps without pinning them replaces it (AAP 0.11.1).
   */
  readonly wallClock?: () => number;
}

/** The ids a created customer holds: its own, and the attached card's when one was made. */
export interface CustomerRef {
  readonly customerId: string;
  readonly paymentMethodId: string | null;
}

/** What {@link ProxyState.idempotencyBegin} decided about one key (AAP 0.3.2). */
export type IdempotencyBegin =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly response: StateResponse }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'in_flight' };

/**
 * A control the state refused: an identifier it does not hold (`404`) or an operation the object's current status
 * does not allow (`409`). `./server.ts` maps it to `{ error: { type: 'proxy_error', message } }`.
 */
export class ProxyControlError extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.name = 'ProxyControlError';
    this.status = status;
  }
}

/**
 * One proxy's state: the Stripe resources it holds, the events it recorded, the idempotency keys it remembers, the
 * transport faults waiting for a request, and the clock a suite pins.
 */
export interface ProxyState {
  /** The proxy's current time in milliseconds: the pin when one is set, else the wall clock. */
  now(): number;
  /**
   * Answer one Stripe request from this state, or `null` for a path it does not model — `./server.ts` then passes
   * `stripe-mock`'s own answer through.
   */
  handleStripe(request: StripeRequest): StateResponse | null;
  /**
   * Claim an idempotency key for a request (AAP 0.3.2). A key belongs to one `POST` and one canonical parameter set:
   * `new` claims it and records it as in flight, so a concurrent duplicate is told `in_flight`; a later identical
   * request `replay`s the stored answer, and different parameters are a `mismatch`. A `GET` or `DELETE` is always
   * `new`, because Stripe ignores keys on them.
   */
  idempotencyBegin(
    key: string,
    method: string,
    path: string,
    params: StripeParams,
  ): IdempotencyBegin;
  /**
   * Store the answer a claimed key now replays. Called for every answer a modelled endpoint produced, a decline and a
   * refusal included — Stripe executed all of them, so a retry must see the same result. It is never called for an
   * answer that came from validation or from a `fail` fault: those model a request Stripe never executed, so
   * `./server.ts` aborts the claim instead.
   */
  idempotencyComplete(key: string, response: StateResponse): void;
  /** Drop a claim, so the key is free and a retry performs the request. */
  idempotencyAbort(key: string): void;
  /** Queue one fault rule; the first request it matches consumes it. */
  addFault(rule: FaultRule): void;
  /** Take the first rule matching this request, removing it; `null` when nothing matches. */
  takeFault(method: string, path: string): FaultRule | null;
  /** Clear every resource, event, key, fault and clock pin. */
  reset(): void;
  /** Pin the clock to `ms`, or hand it back to the wall clock with `null`; returns the pin. */
  setNow(ms: number | null): number | null;
  /** Create a customer, attaching and defaulting a card fixture when one is named. */
  createCustomer(input: { card: TestCardId | null }): CustomerRef;
  /** Attach a card fixture to an existing customer, defaulting it unless told not to. */
  attachCard(
    customerId: string,
    card: TestCardId,
    options?: { makeDefault?: boolean },
  ): { paymentMethodId: string };
  /** Complete the 3-D Secure step a `requires_action` intent is waiting for. */
  complete3ds(paymentIntentId: string): StripePaymentIntent;
  /** Fail that step, which Stripe reports as `payment_intent.payment_failed`. */
  failAuthentication(paymentIntentId: string): StripePaymentIntent;
  /** Abandon it: Stripe cancels the authorization itself (AAP 0.3.2). */
  abandonAuthentication(paymentIntentId: string): StripePaymentIntent;
  /** Lose a hold to its capture deadline — a hold loss, never a forfeit (AAP 0.2.4, AAP 0.3.2). */
  expireHold(paymentIntentId: string): StripePaymentIntent;
  /** The recorded events in order, or the ones after the event `since` (exclusive). */
  events(options?: { since?: string }): StripeEvent[];
  /** Snapshots of the PaymentIntents matching a filter, so "none was created" is assertable. */
  paymentIntents(filter?: PaymentIntentFilter): StripePaymentIntent[];
}

/** One stored card and the fixture it was cloned from, which decides how a confirmation answers. */
interface StoredPaymentMethod {
  readonly card: TestCardId;
  readonly method: StripePaymentMethod;
}

/** One claimed idempotency key: the parameters it was claimed with, and the answer to replay. */
interface IdempotencyEntry {
  readonly fingerprint: string;
  readonly response?: StateResponse;
}

/**
 * Build one proxy's state (AAP 0.3.3, AAP 0.11.2). State lives in this closure and nowhere else, so the module has
 * no side effect and two states in one process cannot see each other's customers, intents or events.
 */
export function createProxyState(options: ProxyStateOptions = {}): ProxyState {
  const wallClock = options.wallClock ?? ((): number => Date.now());
  const customers = new Map<string, StripeCustomer>();
  const paymentMethods = new Map<string, StoredPaymentMethod>();
  const setupIntents = new Map<string, StripeSetupIntent>();
  const intents = new Map<string, StripePaymentIntent>();
  const charges = new Map<string, StripeCharge>();
  const refunds = new Map<string, StripeRefund>();
  const idempotency = new Map<string, IdempotencyEntry>();
  let recorded: StripeEvent[] = [];
  let faults: FaultRule[] = [];
  let pinnedMs: number | null = null;
  function now(): number {
    return pinnedMs ?? wallClock();
  }
  function nowSec(): number {
    return Math.floor(now() / 1000);
  }
  function recordEvent(type: HandledStripeEventType, object: unknown): void {
    recorded.push({
      id: newId('evt'),
      object: 'event',
      type,
      created: nowSec(),
      api_version: PROXY_API_VERSION,
      livemode: false,
      pending_webhooks: 1,
      data: { object: snapshot(object) },
    });
  }
  /** One card fixture as a stored card. The caller registers it, so a lookup can never mint one. */
  function newCard(customerId: string | null, card: TestCardId): StoredPaymentMethod {
    const spec = CARD_SPECS[card];
    return {
      card,
      method: {
        id: newId('pm'),
        object: 'payment_method',
        type: 'card',
        card: {
          brand: CARD_BRAND,
          last4: spec.last4,
          exp_month: CARD_EXP_MONTH,
          exp_year: CARD_EXP_YEAR,
        },
        customer: customerId,
        created: nowSec(),
        livemode: false,
      },
    };
  }
  function newCustomer(metadata: Record<string, string>): StripeCustomer {
    return {
      id: newId('cus'),
      object: 'customer',
      created: nowSec(),
      livemode: false,
      metadata,
      invoice_settings: { default_payment_method: null },
    };
  }
  /** The charge a stored intent points at, or `undefined` when it has none yet. */
  function chargeOf(intent: StripePaymentIntent): StripeCharge | undefined {
    const id =
      typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id;
    return id === undefined ? undefined : charges.get(id);
  }
  /**
   * One intent as a response body. `latest_charge` stays the stored id unless the request expanded it, and the
   * expanded charge is cloned so a later capture cannot rewrite a body already returned.
   */
  function serializeIntent(intent: StripePaymentIntent, expand: boolean): StripePaymentIntent {
    const copy = snapshot(intent);
    const id =
      typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id;
    if (id === undefined) {
      copy.latest_charge = null;
      return copy;
    }
    const charge = charges.get(id);
    copy.latest_charge = expand && charge !== undefined ? snapshot(charge) : id;
    return copy;
  }
  /** The card a 3-D Secure completion charges against, cloned when the intent's card is not stored. */
  function storedMethodFor(intent: StripePaymentIntent): StoredPaymentMethod {
    const id = typeof intent.payment_method === 'string' ? intent.payment_method : null;
    return (
      (id === null ? undefined : paymentMethods.get(id)) ??
      newCard(intent.customer, TEST_CARDS.visa)
    );
  }
  /**
   * The card a confirmation uses when the request names none: the customer's default, else the newest saved card, which
   * is how Stripe answers a `confirm` against a customer's own card (AAP 0.3.2).
   */
  function fallbackCard(customerId: string | null): string | null {
    if (customerId === null) return null;
    const customer = customers.get(customerId);
    if (customer === undefined || customer.deleted === true) return null;
    const preferred = customer.invoice_settings.default_payment_method;
    if (preferred !== null) return preferred;
    const cards = [...paymentMethods.values()]
      .filter((stored) => stored.method.customer === customerId)
      .map((stored) => stored.method)
      .sort(newestFirst);
    return cards[0]?.id ?? null;
  }
  /**
   * Resolve the card a confirmation charges against: a stored card, or a test-card id cloned into a new `pm_…`
   * attached to the customer, as Stripe's test mode does with these ids. An id that is neither is `404 resource_missing`.
   */
  function resolveCard(
    customerId: string | null,
    requested: string | null,
  ): { ok: true; stored: StoredPaymentMethod } | { ok: false; response: StateResponse } {
    if (requested === null) return { ok: false, response: parameterMissing('payment_method') };
    const stored = paymentMethods.get(requested);
    if (stored !== undefined) {
      if (stored.method.customer === null && customerId !== null)
        stored.method.customer = customerId;
      return { ok: true, stored };
    }
    if (!isTestCard(requested))
      return { ok: false, response: missing('payment_method', requested, 'payment_method') };
    const cloned = newCard(customerId, requested);
    paymentMethods.set(cloned.method.id, cloned);
    return { ok: true, stored: cloned };
  }
  /** The `400` a capture, cancel or confirm reports from a status that does not allow it. */
  function wrongIntentState(intent: StripePaymentIntent): StateResponse {
    return {
      status: 400,
      body: errorBody(
        'invalid_request_error',
        `This PaymentIntent's status is ${intent.status}, which does not allow this operation.`,
        { code: 'payment_intent_unexpected_state', payment_intent: serializeIntent(intent, false) },
      ),
    };
  }
  /** The same refusal for a setup intent, which the gateway reads for its own failure class. */
  function wrongSetupState(intent: StripeSetupIntent): StateResponse {
    return refused(
      'setup_intent_unexpected_state',
      `This SetupIntent's status is ${intent.status}, which does not allow this operation.`,
    );
  }
  /** The charge an authorization creates, carrying the capture deadline every hold reports. */
  function createCharge(intent: StripePaymentIntent, stored: StoredPaymentMethod): StripeCharge {
    const charge: StripeCharge = {
      id: newId('ch'),
      object: 'charge',
      amount: intent.amount,
      amount_captured: 0,
      amount_refunded: 0,
      captured: false,
      refunded: false,
      status: 'succeeded',
      currency: intent.currency,
      customer: intent.customer,
      payment_intent: intent.id,
      payment_method: stored.method.id,
      payment_method_details: {
        type: 'card',
        card: {
          brand: stored.method.card.brand,
          last4: stored.method.card.last4,
          capture_before: nowSec() + HOLD_VALIDITY_SEC,
        },
      },
      metadata: { ...intent.metadata },
      created: nowSec(),
      livemode: false,
    };
    charges.set(charge.id, charge);
    return charge;
  }
  // The modelled endpoints (AAP 0.3.3, AAP 0.5.3)
  function createCustomerResource(params: StripeParams): StateResponse {
    const customer = newCustomer(record(params, 'metadata'));
    customers.set(customer.id, customer);
    return ok(snapshot(customer));
  }
  function retrieveCustomer(id: string): StateResponse {
    const customer = customers.get(id);
    if (customer === undefined) return missing('customer', id);
    if (customer.deleted === true)
      return ok({ id, object: 'customer', deleted: true, livemode: false });
    return ok(snapshot(customer));
  }
  function updateCustomer(id: string, params: StripeParams): StateResponse {
    const customer = customers.get(id);
    if (customer === undefined || customer.deleted === true) return missing('customer', id);
    const metadata = record(params, 'metadata');
    if (Object.keys(metadata).length > 0) customer.metadata = metadata;
    const settings = params.invoice_settings;
    if (settings !== undefined && typeof settings !== 'string' && !Array.isArray(settings)) {
      const preferred = scalar(settings, 'default_payment_method');
      if (preferred !== undefined) {
        customer.invoice_settings = { default_payment_method: preferred === '' ? null : preferred };
      }
    }
    return ok(snapshot(customer));
  }
  function deleteCustomerResource(id: string): StateResponse {
    const customer = customers.get(id);
    if (customer === undefined || customer.deleted === true) return missing('customer', id);
    customer.deleted = true;
    return ok({ id, object: 'customer', deleted: true, livemode: false });
  }
  function listCards(customerId: string | null, params: StripeParams): StateResponse {
    if (customerId !== null && !customers.has(customerId))
      return missing('customer', customerId, 'customer');
    const type = scalar(params, 'type');
    const data = [...paymentMethods.values()]
      .filter(
        (stored) =>
          (customerId === null || stored.method.customer === customerId) &&
          (type === undefined || stored.method.type === type),
      )
      .map((stored) => stored.method)
      .sort(newestFirst)
      .map((method) => snapshot(method));
    return ok({ object: 'list', data, has_more: false, url: '/v1/payment_methods' });
  }
  function retrieveCard(id: string): StateResponse {
    const stored = paymentMethods.get(id);
    return stored === undefined ? missing('payment_method', id) : ok(snapshot(stored.method));
  }
  function attachCardResource(id: string, params: StripeParams): StateResponse {
    const customerId = scalar(params, 'customer');
    if (customerId === undefined) return parameterMissing('customer');
    const customer = customers.get(customerId);
    if (customer === undefined || customer.deleted === true)
      return missing('customer', customerId, 'customer');
    const resolved = resolveCard(customerId, id);
    if (!resolved.ok) return resolved.response;
    // Attaching re-points a card that another customer already held, which is what Stripe does.
    resolved.stored.method.customer = customerId;
    return ok(snapshot(resolved.stored.method));
  }
  function createSetupIntentResource(params: StripeParams): StateResponse {
    const id = newId('seti');
    const intent: StripeSetupIntent = {
      id,
      object: 'setup_intent',
      client_secret: clientSecretFor(id),
      customer: scalar(params, 'customer') ?? null,
      payment_method: null,
      status: 'requires_payment_method',
      usage: scalar(params, 'usage') ?? null,
      created: nowSec(),
      livemode: false,
    };
    setupIntents.set(id, intent);
    return ok(snapshot(intent));
  }
  function retrieveSetupIntent(id: string): StateResponse {
    const intent = setupIntents.get(id);
    return intent === undefined ? missing('setup_intent', id) : ok(snapshot(intent));
  }
  function confirmSetupIntent(id: string, params: StripeParams): StateResponse {
    const intent = setupIntents.get(id);
    if (intent === undefined) return missing('setup_intent', id);
    if (intent.status !== 'requires_payment_method') return wrongSetupState(intent);
    const requested = scalar(params, 'payment_method') ?? intent.payment_method;
    const resolved = resolveCard(intent.customer, requested);
    if (!resolved.ok) return resolved.response;
    intent.payment_method = resolved.stored.method.id;
    intent.status = 'succeeded';
    recordEvent('setup_intent.succeeded', snapshot(intent));
    return ok(snapshot(intent));
  }
  function createEphemeralKeyResource(params: StripeParams): StateResponse {
    const customerId = scalar(params, 'customer');
    if (customerId === undefined) return parameterMissing('customer');
    const created = nowSec();
    return ok({
      id: newId('ephkey'),
      object: 'ephemeral_key',
      secret: `${EPHEMERAL_KEY_PREFIX}${randomToken()}`,
      associated_objects: [{ type: 'customer', id: customerId }],
      created,
      expires: created + EPHEMERAL_KEY_TTL_SEC,
      livemode: false,
    });
  }
  function createIntent(params: StripeParams): StateResponse {
    const amount = integer(params, 'amount');
    if (amount === undefined) return parameterMissing('amount');
    const id = newId('pi');
    const intent: StripePaymentIntent = {
      id,
      object: 'payment_intent',
      amount,
      amount_capturable: 0,
      amount_received: 0,
      currency: scalar(params, 'currency') ?? 'usd',
      capture_method: scalar(params, 'capture_method') ?? 'automatic',
      confirmation_method: 'automatic',
      status: 'requires_payment_method',
      client_secret: clientSecretFor(id),
      customer: scalar(params, 'customer') ?? null,
      payment_method: scalar(params, 'payment_method') ?? null,
      payment_method_types: ['card'],
      metadata: record(params, 'metadata'),
      latest_charge: null,
      next_action: null,
      last_payment_error: null,
      cancellation_reason: null,
      canceled_at: null,
      created: nowSec(),
      livemode: false,
    };
    intents.set(id, intent);
    // A create that confirms is the hold's own request, so its answer is the confirmed state and the
    // idempotency key that carried it replays that answer (AAP 0.2.4, AAP 0.3.2).
    if (scalar(params, 'confirm') === 'true') return applyConfirmation(intent, params);
    if (intent.payment_method !== null) intent.status = 'requires_confirmation';
    return ok(serializeIntent(intent, expandHas(params, 'latest_charge')));
  }
  /** Confirm one intent against its card, applying the outcome that card's fixture stands for. */
  function applyConfirmation(intent: StripePaymentIntent, params: StripeParams): StateResponse {
    const requested =
      scalar(params, 'payment_method') ??
      (typeof intent.payment_method === 'string' ? intent.payment_method : null) ??
      fallbackCard(intent.customer);
    const resolved = resolveCard(intent.customer, requested);
    if (!resolved.ok) return resolved.response;
    const outcome = CARD_SPECS[resolved.stored.card].outcome;
    const expand = expandHas(params, 'latest_charge');
    intent.payment_method = resolved.stored.method.id;
    if (outcome === 'declined') {
      intent.status = 'requires_payment_method';
      intent.last_payment_error = {
        type: 'card_error',
        code: 'card_declined',
        decline_code: 'generic_decline',
        message: CARD_DECLINED_MESSAGE,
      };
      recordEvent('payment_intent.payment_failed', serializeIntent(intent, false));
      // A decline is a result rather than a transport failure: the gateway reads the attached
      // PaymentIntent, `holds.ts` answers `402 hold_failed`, and the meetup stays `proposed` so the
      // attempt may be retried (AAP 0.5.3).
      return {
        status: 402,
        body: errorBody('card_error', CARD_DECLINED_MESSAGE, {
          code: 'card_declined',
          decline_code: 'generic_decline',
          param: 'payment_method',
          payment_intent: serializeIntent(intent, false),
        }),
      };
    }
    if (outcome === 'authentication') {
      intent.status = 'requires_action';
      intent.next_action = { ...NEXT_ACTION };
      return ok(serializeIntent(intent, expand));
    }
    const charge = createCharge(intent, resolved.stored);
    intent.status = 'requires_capture';
    intent.amount_capturable = intent.amount;
    intent.latest_charge = charge.id;
    recordEvent('payment_intent.amount_capturable_updated', serializeIntent(intent, false));
    return ok(serializeIntent(intent, expand));
  }
  /** Confirm an intent that has not been confirmed yet, applying its card's outcome (AAP 0.2.4). */
  function confirmIntent(id: string, params: StripeParams): StateResponse {
    const intent = intents.get(id);
    if (intent === undefined) return missing('payment_intent', id);
    // A confirmation is accepted only before the intent has one: re-confirming an authorization that
    // already exists would invent a second one for the same attempt, which is the outcome the
    // idempotency and recovery rules exist to prevent (AAP 0.3.2).
    if (intent.status !== 'requires_payment_method' && intent.status !== 'requires_confirmation')
      return wrongIntentState(intent);
    return applyConfirmation(intent, params);
  }
  function retrieveIntent(id: string, params: StripeParams): StateResponse {
    const intent = intents.get(id);
    return intent === undefined
      ? missing('payment_intent', id)
      : ok(serializeIntent(intent, expandHas(params, 'latest_charge')));
  }
  /**
   * A customer's PaymentIntents, newest first. The gateway's own hold recovery lists them to find the intent of an
   * attempt Stripe answered an idempotency conflict for (AAP 0.3.2), so the list has to hold what this state created.
   */
  function listIntents(params: StripeParams): StateResponse {
    const customer = scalar(params, 'customer');
    const data = [...intents.values()]
      .filter((intent) => customer === undefined || intent.customer === customer)
      .sort(newestFirst)
      .map((intent) => serializeIntent(intent, expandHas(params, 'latest_charge')));
    return ok({ object: 'list', data, has_more: false, url: '/v1/payment_intents' });
  }
  function captureIntent(id: string, params: StripeParams): StateResponse {
    const intent = intents.get(id);
    if (intent === undefined) return missing('payment_intent', id);
    // Only a held authorization is capturable, so a capture of an expired or already-captured hold
    // fails here rather than capturing nothing — the terminal failure AAP 0.3.2's compensation runs on.
    if (intent.status !== 'requires_capture') return wrongIntentState(intent);
    const charge = chargeOf(intent);
    intent.status = 'succeeded';
    intent.amount_capturable = 0;
    intent.amount_received = intent.amount;
    if (charge !== undefined) {
      charge.captured = true;
      charge.amount_captured = intent.amount;
    }
    recordEvent('payment_intent.succeeded', serializeIntent(intent, false));
    return ok(serializeIntent(intent, expandHas(params, 'latest_charge')));
  }
  function cancelIntent(id: string, params: StripeParams): StateResponse {
    const intent = intents.get(id);
    if (intent === undefined) return missing('payment_intent', id);
    if (intent.status === 'succeeded' || intent.status === 'canceled')
      return wrongIntentState(intent);
    intent.status = 'canceled';
    intent.cancellation_reason = scalar(params, 'cancellation_reason') ?? null;
    intent.canceled_at = nowSec();
    intent.amount_capturable = 0;
    recordEvent('payment_intent.canceled', serializeIntent(intent, false));
    return ok(serializeIntent(intent, expandHas(params, 'latest_charge')));
  }
  function createRefund(params: StripeParams): StateResponse {
    const intentId = scalar(params, 'payment_intent');
    if (intentId === undefined) return parameterMissing('payment_intent');
    const intent = intents.get(intentId);
    if (intent === undefined) return missing('payment_intent', intentId);
    const charge = intent.status === 'succeeded' ? chargeOf(intent) : undefined;
    if (charge === undefined) {
      return refused(
        'charge_not_refundable',
        `Charge for PaymentIntent ${intentId} is not refundable.`,
      );
    }
    if (charge.refunded) {
      return refused('charge_already_refunded', `Charge ${charge.id} has already been refunded.`);
    }
    const refund: StripeRefund = {
      id: newId('re'),
      object: 'refund',
      amount: integer(params, 'amount') ?? charge.amount,
      charge: charge.id,
      payment_intent: intent.id,
      status: 'succeeded',
      created: nowSec(),
      livemode: false,
    };
    refunds.set(refund.id, refund);
    charge.refunded = true;
    charge.amount_refunded = refund.amount;
    recordEvent('charge.refunded', snapshot(charge));
    return ok(snapshot(refund));
  }
  // Routing (AAP 0.3.3)

  /** One modelled endpoint: the method, the path pattern and the handler that answers it. */
  interface Route {
    readonly method: string;
    /** Anchored against the request path with no query string; `([^/]+)` is one path segment. */
    readonly pattern: RegExp;
    readonly handler: (match: RegExpExecArray, params: StripeParams) => StateResponse;
  }
  function route(method: string, pattern: string, handler: Route['handler']): Route {
    return { method, pattern: new RegExp(`^${pattern}$`), handler };
  }
  /** The one path segment a route matched. */
  function segmentOf(match: RegExpExecArray): string {
    return match[1] ?? '';
  }
  const ROUTES: readonly Route[] = [
    route('POST', '/v1/customers', (_match, params) => createCustomerResource(params)),
    route('GET', '/v1/customers/([^/]+)', (match) => retrieveCustomer(segmentOf(match))),
    route('POST', '/v1/customers/([^/]+)', (match, params) =>
      updateCustomer(segmentOf(match), params),
    ),
    route('DELETE', '/v1/customers/([^/]+)', (match) => deleteCustomerResource(segmentOf(match))),
    route('GET', '/v1/customers/([^/]+)/payment_methods', (match, params) =>
      listCards(segmentOf(match), params),
    ),
    route('GET', '/v1/payment_methods', (_match, params) =>
      listCards(scalar(params, 'customer') ?? null, params),
    ),
    route('GET', '/v1/payment_methods/([^/]+)', (match) => retrieveCard(segmentOf(match))),
    route('POST', '/v1/payment_methods/([^/]+)/attach', (match, params) =>
      attachCardResource(segmentOf(match), params),
    ),
    route('POST', '/v1/setup_intents', (_match, params) => createSetupIntentResource(params)),
    route('GET', '/v1/setup_intents/([^/]+)', (match) => retrieveSetupIntent(segmentOf(match))),
    route('POST', '/v1/setup_intents/([^/]+)/confirm', (match, params) =>
      confirmSetupIntent(segmentOf(match), params),
    ),
    route('POST', '/v1/ephemeral_keys', (_match, params) => createEphemeralKeyResource(params)),
    route('POST', '/v1/payment_intents', (_match, params) => createIntent(params)),
    route('GET', '/v1/payment_intents', (_match, params) => listIntents(params)),
    route('GET', '/v1/payment_intents/([^/]+)', (match, params) =>
      retrieveIntent(segmentOf(match), params),
    ),
    route('POST', '/v1/payment_intents/([^/]+)/confirm', (match, params) =>
      confirmIntent(segmentOf(match), params),
    ),
    route('POST', '/v1/payment_intents/([^/]+)/capture', (match, params) =>
      captureIntent(segmentOf(match), params),
    ),
    route('POST', '/v1/payment_intents/([^/]+)/cancel', (match, params) =>
      cancelIntent(segmentOf(match), params),
    ),
    route('POST', '/v1/refunds', (_match, params) => createRefund(params)),
  ];
  function handleStripe(request: StripeRequest): StateResponse | null {
    const method = request.method.toUpperCase();
    const path = request.path.split('?')[0] ?? request.path;
    for (const entry of ROUTES) {
      if (entry.method !== method) continue;
      const match = entry.pattern.exec(path);
      if (match !== null) return entry.handler(match, request.params);
    }
    return null;
  }
  // Idempotency (AAP 0.3.2)
  function idempotencyBegin(
    key: string,
    method: string,
    path: string,
    params: StripeParams,
  ): IdempotencyBegin {
    // A key is honoured on a `POST` alone: Stripe ignores the header on a read or a delete, so a
    // caller that sent one anyway must not be able to make two different reads collide.
    if (method.toUpperCase() !== 'POST') return { kind: 'new' };
    const fingerprint = requestFingerprint(method, path, params);
    const entry = idempotency.get(key);
    if (entry === undefined) {
      idempotency.set(key, { fingerprint });
      return { kind: 'new' };
    }
    if (entry.fingerprint !== fingerprint) return { kind: 'mismatch' };
    return entry.response === undefined
      ? { kind: 'in_flight' }
      : { kind: 'replay', response: snapshot(entry.response) };
  }
  function idempotencyComplete(key: string, response: StateResponse): void {
    const entry = idempotency.get(key);
    idempotency.set(key, {
      fingerprint: entry?.fingerprint ?? '',
      response: snapshot(response),
    });
  }
  function idempotencyAbort(key: string): void {
    idempotency.delete(key);
  }
  // Transport faults (AAP 0.11.2)
  function addFault(rule: FaultRule): void {
    faults.push(rule);
  }
  function takeFault(method: string, path: string): FaultRule | null {
    const target = path.split('?')[0] ?? path;
    const wanted = method.toUpperCase();
    const index = faults.findIndex(
      (rule) => rule.method.toUpperCase() === wanted && matchesPath(rule.path, target),
    );
    if (index < 0) return null;
    const [taken] = faults.splice(index, 1);
    return taken ?? null;
  }
  // Controls (AAP 0.11.2)
  function reset(): void {
    customers.clear();
    paymentMethods.clear();
    setupIntents.clear();
    intents.clear();
    charges.clear();
    refunds.clear();
    idempotency.clear();
    recorded = [];
    faults = [];
    pinnedMs = null;
  }
  function setNow(ms: number | null): number | null {
    pinnedMs = ms;
    return pinnedMs;
  }
  function requireIntent(id: string): StripePaymentIntent {
    const intent = intents.get(id);
    if (intent === undefined) throw new ProxyControlError(404, `No such PaymentIntent: '${id}'`);
    return intent;
  }
  /**
   * Refuse a control the intent's status cannot apply to. Inventing the effect the test asked for would put a state
   * in the proxy that Stripe could never report (AAP 0.11.2).
   */
  function requireStatus(
    intent: StripePaymentIntent,
    allowed: readonly string[],
    operation: string,
  ): void {
    if (allowed.includes(intent.status)) return;
    throw new ProxyControlError(
      409,
      `PaymentIntent ${intent.id} is ${intent.status}; ${operation} needs ${allowed.join(' or ')}`,
    );
  }
  function complete3ds(paymentIntentId: string): StripePaymentIntent {
    const intent = requireIntent(paymentIntentId);
    requireStatus(intent, ['requires_action'], 'a 3-D Secure completion');
    const charge = createCharge(intent, storedMethodFor(intent));
    intent.status = 'requires_capture';
    intent.amount_capturable = intent.amount;
    intent.next_action = null;
    intent.latest_charge = charge.id;
    recordEvent('payment_intent.amount_capturable_updated', serializeIntent(intent, false));
    return snapshot(intent);
  }
  function failAuthentication(paymentIntentId: string): StripePaymentIntent {
    const intent = requireIntent(paymentIntentId);
    requireStatus(intent, ['requires_action'], 'an authentication failure');
    intent.status = 'requires_payment_method';
    intent.next_action = null;
    intent.last_payment_error = {
      type: 'card_error',
      code: AUTHENTICATION_FAILED_CODE,
      message: AUTHENTICATION_FAILED_MESSAGE,
    };
    recordEvent('payment_intent.payment_failed', serializeIntent(intent, false));
    return snapshot(intent);
  }
  function abandonAuthentication(paymentIntentId: string): StripePaymentIntent {
    const intent = requireIntent(paymentIntentId);
    requireStatus(intent, ['requires_action', 'requires_payment_method'], 'an abandonment');
    intent.status = 'canceled';
    intent.cancellation_reason = CANCELLATION_ABANDONED;
    intent.canceled_at = nowSec();
    intent.next_action = null;
    intent.amount_capturable = 0;
    recordEvent('payment_intent.canceled', serializeIntent(intent, false));
    return snapshot(intent);
  }
  function expireHold(paymentIntentId: string): StripePaymentIntent {
    const intent = requireIntent(paymentIntentId);
    requireStatus(intent, ['requires_capture'], 'an expiry');
    // Stripe reports the expired authorization and then the cancellation that follows it, in that
    // order, and both are read: the first is what says the hold was lost, the second carries the
    // `expired` reason that tells a loss from a release of ours (AAP 0.2.4, AAP 0.3.2).
    const charge = chargeOf(intent);
    if (charge !== undefined) recordEvent('charge.expired', snapshot(charge));
    intent.status = 'canceled';
    intent.cancellation_reason = CANCELLATION_EXPIRED;
    intent.canceled_at = nowSec();
    intent.amount_capturable = 0;
    recordEvent('payment_intent.canceled', serializeIntent(intent, false));
    return snapshot(intent);
  }
  function createCustomer(input: { card: TestCardId | null }): CustomerRef {
    if (input.card !== null && !isTestCard(input.card)) {
      throw new ProxyControlError(409, 'Unknown card fixture passed to createCustomer');
    }
    const customer = newCustomer({});
    customers.set(customer.id, customer);
    if (input.card === null) return { customerId: customer.id, paymentMethodId: null };
    const stored = newCard(customer.id, input.card);
    paymentMethods.set(stored.method.id, stored);
    customer.invoice_settings = { default_payment_method: stored.method.id };
    return { customerId: customer.id, paymentMethodId: stored.method.id };
  }
  function attachCard(
    customerId: string,
    card: TestCardId,
    options: { makeDefault?: boolean } = {},
  ): { paymentMethodId: string } {
    const customer = customers.get(customerId);
    if (customer === undefined || customer.deleted === true) {
      throw new ProxyControlError(404, `No such customer: '${customerId}'`);
    }
    if (!isTestCard(card))
      throw new ProxyControlError(409, 'Unknown card fixture passed to attachCard');
    const stored = newCard(customerId, card);
    paymentMethods.set(stored.method.id, stored);
    if (options.makeDefault !== false) {
      customer.invoice_settings = { default_payment_method: stored.method.id };
    }
    return { paymentMethodId: stored.method.id };
  }
  function events(options: { since?: string } = {}): StripeEvent[] {
    const since = options.since;
    if (since === undefined) return recorded.map(snapshot);
    const index = recorded.findIndex((event) => event.id === since);
    if (index < 0) throw new ProxyControlError(404, `No such event: '${since}'`);
    return recorded.slice(index + 1).map(snapshot);
  }
  function paymentIntents(filter: PaymentIntentFilter = {}): StripePaymentIntent[] {
    return [...intents.values()]
      .filter(
        (intent) =>
          (filter.customer === undefined || intent.customer === filter.customer) &&
          (filter.status === undefined || intent.status === filter.status) &&
          matchesMetadata(intent.metadata, filter.metadata),
      )
      .map(snapshot);
  }
  return {
    now,
    handleStripe,
    idempotencyBegin,
    idempotencyComplete,
    idempotencyAbort,
    addFault,
    takeFault,
    reset,
    setNow,
    createCustomer,
    attachCard,
    complete3ds,
    failAuthentication,
    abandonAuthentication,
    expireHold,
    events,
    paymentIntents,
  };
}

/*
 * The control routes (AAP 0.11.2)
 */

/** The name of one control route: also the name of the {@link ProxyState} control it drives. */
export type ControlName =
  | 'health'
  | 'reset'
  | 'setNow'
  | 'createCustomer'
  | 'attachCard'
  | 'complete3ds'
  | 'failAuthentication'
  | 'abandonAuthentication'
  | 'expireHold'
  | 'addFault'
  | 'events'
  | 'paymentIntents';

/** One control route: the method it answers and its path template, whose `:id` is a path segment. */
export interface ControlRoute {
  readonly method: 'GET' | 'POST';
  readonly path: string;
}

/**
 * The control routes, declared once for both sides: `./server.ts` routes by them and {@link proxyControl} builds its
 * requests from them, so a path renamed on one side can never leave the other pointing at nothing.
 */
export const CONTROL_ROUTES: Readonly<Record<ControlName, ControlRoute>> = {
  health: { method: 'GET', path: `${CONTROL_PREFIX}/health` },
  reset: { method: 'POST', path: `${CONTROL_PREFIX}/reset` },
  setNow: { method: 'POST', path: `${CONTROL_PREFIX}/clock` },
  createCustomer: { method: 'POST', path: `${CONTROL_PREFIX}/customers` },
  attachCard: { method: 'POST', path: `${CONTROL_PREFIX}/customers/:id/cards` },
  complete3ds: { method: 'POST', path: `${CONTROL_PREFIX}/payment_intents/:id/complete_3ds` },
  failAuthentication: {
    method: 'POST',
    path: `${CONTROL_PREFIX}/payment_intents/:id/fail_authentication`,
  },
  abandonAuthentication: {
    method: 'POST',
    path: `${CONTROL_PREFIX}/payment_intents/:id/abandon_authentication`,
  },
  expireHold: { method: 'POST', path: `${CONTROL_PREFIX}/payment_intents/:id/expire` },
  addFault: { method: 'POST', path: `${CONTROL_PREFIX}/faults` },
  events: { method: 'GET', path: `${CONTROL_PREFIX}/events` },
  paymentIntents: { method: 'POST', path: `${CONTROL_PREFIX}/payment_intents/query` },
};

/** Newest first by `created`, ties broken by the greater id — the order Stripe lists in. */
function newestFirst(
  left: { readonly created: number; readonly id: string },
  right: { readonly created: number; readonly id: string },
): number {
  if (left.created !== right.created) return right.created - left.created;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

/** Whether every pair `wanted` names is present in `metadata`; `undefined` selects everything. */
function matchesMetadata(
  metadata: Record<string, string>,
  wanted?: Record<string, string>,
): boolean {
  if (wanted === undefined) return true;
  return Object.entries(wanted).every(([key, value]) => metadata[key] === value);
}

/**
 * The canonical form of a parameter tree: every object's keys sorted, recursively. Two requests that differ only in
 * the order a client serialized their fields fingerprint the same, which is what makes an idempotency comparison
 * about the request rather than about its spelling (AAP 0.3.2).
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

/** The method, the path and the parameters one idempotency key was claimed with. */
function requestFingerprint(method: string, path: string, params: StripeParams): string {
  return `${method.toUpperCase()} ${path.split('?')[0] ?? path} ${canonical(params)}`;
}

/** Escape a literal path fragment, so a `*` in a fault rule stays the only wildcard. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether a fault rule's path matches, with `*` standing for exactly one path segment. */
function matchesPath(pattern: string, path: string): boolean {
  if (!pattern.includes('*')) return pattern === path;
  const source = pattern.split('*').map(escapeRegExp).join('[^/]*');
  return new RegExp(`^${source}$`).test(path);
}

/*
 * Test-side helpers (AAP 0.11.2)
 */

/**
 * The typed client one Vitest worker drives the proxy with over HTTP, while the state itself lives in the
 * `globalSetup` process or in the compose service.
 */
export interface ProxyControl {
  /** Stripe's published test card ids, re-exposed so a suite needs one import for both. */
  readonly TEST_CARDS: typeof TEST_CARDS;
  /** Clear the proxy's whole state, which a suite does between cases. */
  reset(): Promise<void>;
  /** Pin the proxy clock to an instant, or hand it back to the wall clock with `null`. */
  setNow(at: Date | number | string | null): Promise<number | null>;
  /** Create a customer, attaching a card fixture when one is named. */
  createCustomer(input: { card: TestCardId | null }): Promise<CustomerRef>;
  /** Attach a card fixture to an existing customer. */
  attachCard(
    customerId: string,
    card: TestCardId,
    options?: { makeDefault?: boolean },
  ): Promise<{ paymentMethodId: string }>;
  /** Complete the 3-D Secure step an intent is waiting for. */
  complete3ds(paymentIntentId: string): Promise<StripePaymentIntent>;
  /** Fail that step, which Stripe reports as `payment_intent.payment_failed`. */
  failAuthentication(paymentIntentId: string): Promise<StripePaymentIntent>;
  /** Abandon it, so Stripe cancels the authorization itself. */
  abandonAuthentication(paymentIntentId: string): Promise<StripePaymentIntent>;
  /** Lose a hold to its capture deadline. */
  expireHold(paymentIntentId: string): Promise<StripePaymentIntent>;
  /** Perform the next matching request and then drop the connection: an ambiguous result. */
  dropNextResponse(input: { method: string; path: string }): Promise<void>;
  /** Perform the next matching request and answer after `ms`, past the gateway's own timeout. */
  delayNext(input: { method: string; path: string; ms: number }): Promise<void>;
  /** Refuse the next matching request with `status`, without performing it. */
  failNext(input: { method: string; path: string; status: number }): Promise<void>;
  /** The recorded events in order, or the ones after the event `since`. */
  events(options?: { since?: string }): Promise<StripeEvent[]>;
  /** Snapshots of the PaymentIntents matching a filter. */
  paymentIntents(filter?: PaymentIntentFilter): Promise<StripePaymentIntent[]>;
  /** The proxy's liveness answer, which the compose healthcheck reads too. */
  health(): Promise<{ readonly status: string }>;
}

/** What one control request may carry: the `:id` segment, a query string and a JSON body. */
interface ControlCall {
  readonly id?: string;
  readonly query?: Record<string, string>;
  readonly body?: unknown;
}

/** An instant as milliseconds; `null` stays `null`, which unpins the clock. */
function toMillis(at: Date | number | string | null): number | null {
  if (at === null) return null;
  if (at instanceof Date) return at.getTime();
  if (typeof at === 'number') return at;
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) throw new RangeError(`unparseable instant: '${at}'`);
  return parsed;
}

/** The proxy's own message inside an error answer, when it sent one. */
function proxyMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { error } = body as { error?: unknown };
  if (typeof error !== 'object' || error === null) return undefined;
  const { message } = error as { message?: unknown };
  return typeof message === 'string' ? message : undefined;
}

/** What a failed control reports: the proxy's own message when its body held one, else the body. */
async function failureDetail(response: Response): Promise<string> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  return proxyMessage(parsed) ?? text;
}

/**
 * Build the client one worker drives the proxy with. `baseUrl` is the control address `setup` published for this
 * run's proxy.
 */
export function proxyControl(baseUrl: string): ProxyControl {
  const base = baseUrl.replace(/\/+$/, '');
  async function call<T>(control: ControlName, options: ControlCall = {}): Promise<T> {
    const entry = CONTROL_ROUTES[control];
    const path =
      options.id === undefined
        ? entry.path
        : entry.path.replace(':id', encodeURIComponent(options.id));
    const query = new URLSearchParams(options.query ?? {}).toString();
    const init: RequestInit = {
      method: entry.method,
      headers: { 'content-type': 'application/json' },
    };
    if (entry.method === 'POST') init.body = JSON.stringify(options.body ?? {});
    const response = await fetch(`${base}${path}${query === '' ? '' : `?${query}`}`, init);
    if (!response.ok) {
      throw new Error(
        `stripe-proxy ${control} failed with ${response.status}: ${await failureDetail(response)}`,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
  return {
    TEST_CARDS,
    async reset() {
      await call<void>('reset');
    },
    async setNow(at) {
      const answer = await call<{ nowMs: number | null }>('setNow', {
        body: { nowMs: toMillis(at) },
      });
      return answer.nowMs;
    },
    createCustomer: (input) => call<CustomerRef>('createCustomer', { body: input }),
    attachCard: (customerId, card, options) =>
      call<{ paymentMethodId: string }>('attachCard', {
        id: customerId,
        body: { card, makeDefault: options?.makeDefault ?? true },
      }),
    complete3ds: (paymentIntentId) =>
      call<StripePaymentIntent>('complete3ds', { id: paymentIntentId }),
    failAuthentication: (paymentIntentId) =>
      call<StripePaymentIntent>('failAuthentication', { id: paymentIntentId }),
    abandonAuthentication: (paymentIntentId) =>
      call<StripePaymentIntent>('abandonAuthentication', { id: paymentIntentId }),
    expireHold: (paymentIntentId) =>
      call<StripePaymentIntent>('expireHold', { id: paymentIntentId }),
    async dropNextResponse(input) {
      await call<void>('addFault', { body: { kind: 'drop', ...input } });
    },
    async delayNext(input) {
      await call<void>('addFault', { body: { kind: 'delay', ...input } });
    },
    async failNext(input) {
      await call<void>('addFault', { body: { kind: 'fail', ...input } });
    },
    async events(options) {
      const answer = await call<{ data: StripeEvent[] }>(
        'events',
        options?.since === undefined ? {} : { query: { since: options.since } },
      );
      return answer.data;
    },
    async paymentIntents(filter) {
      const answer = await call<{ data: StripePaymentIntent[] }>('paymentIntents', {
        body: filter ?? {},
      });
      return answer.data;
    },
    health: () => call<{ status: string }>('health'),
  };
}

/** The route the API serves Stripe webhooks on, which {@link deliverStripeEvents} posts to. */
const WEBHOOK_PATH = '/v1/webhooks/stripe';

/** The part of a Fastify injection result a webhook assertion reads: the status and the body. */
export interface WebhookResponse {
  readonly statusCode: number;
  readonly body: string;
  json<T = unknown>(): T;
}

/**
 * Sign one webhook payload exactly as Stripe signs a delivery (AAP 0.3.2, AAP 0.3.3).
 *
 * `stripe.webhooks.constructEvent` inside `stripe-gateway.ts` checks this shape and nothing else: one
 * `t=<unix seconds>` and one `v1=<hex HMAC-SHA256 of "t.payload">`, with the timestamp inside its 300 second
 * tolerance. The signature is over the bytes a caller sends, so a caller signs the exact string it posts.
 */
export function signStripePayload(payload: string, secret: string, tSec: number): string {
  const signature = createHmac('sha256', secret).update(`${tSec}.${payload}`).digest('hex');
  return `t=${tSec},v1=${signature}`;
}

/**
 * Deliver recorded events to the API's webhook endpoint, in the order given (AAP 0.3.2, AAP 0.11.2). The proxy never
 * posts an event itself, because the order, the duplicates and the delay are what the suite is testing: a replay of
 * an already processed event, or a historical `requires_capture` arriving after a settlement, are cases here.
 */
export async function deliverStripeEvents(
  app: Pick<App, 'inject' | 'services'>,
  events: readonly object[],
  secret: string,
  options: { tSec?: number } = {},
): Promise<WebhookResponse[]> {
  const tSec = options.tSec ?? Math.floor(app.services.clock.nowMs() / 1000);
  const responses: WebhookResponse[] = [];
  for (const event of events) {
    const payload = JSON.stringify(event);
    responses.push(
      await app.inject({
        method: 'POST',
        url: WEBHOOK_PATH,
        headers: {
          'content-type': 'application/json',
          'stripe-signature': signStripePayload(payload, secret, tSec),
        },
        payload,
      }),
    );
  }
  return responses;
}
