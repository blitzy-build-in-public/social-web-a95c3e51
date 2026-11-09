/**
 * The fixture builders, the flows through the real routes, and the route helpers every integration
 * suite of `apps/api` drives (AAP 0.8.1 "factories"; AAP 0.11.1's table-driven density convention).
 */

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { Prisma, readPoints, setPoint } from '@tablemate/db';
import {
  STRIPE_MOCK_PLACEHOLDERS,
  addLocalDays,
  decryptField,
  emailLookupHash,
  encryptField,
  localDateKey,
  pairKey,
  randomToken,
  sha256Hex,
} from '@tablemate/server-core';
import type { ApiEnv } from '@tablemate/server-core';
import {
  AcceptResponse,
  CHECK_IN_CLOSES_AFTER_MINUTES,
  CheckInResponse,
  DAY_MS,
  DEFAULT_DEPOSIT_CENTS,
  DISPUTE_RESOLUTION_DAYS,
  ErrorEnvelope,
  HOUR_MS,
  MINUTE_MS,
  ProposeResponse,
  RECIPIENT_DEADLINE_HOURS,
  REFRESH_TOKEN_TTL_DAYS,
  VENUE_SECRET_HEADER,
  VenueCodeResponse,
  VerifyResponse,
} from '@tablemate/shared';
import type {
  BlockedReason,
  CallAttemptOutcome,
  CallAttemptState,
  CallTaskKind,
  CallTaskStatus,
  CancelReason,
  CheckInResult,
  Confidence,
  DepositCents,
  DepositStatus,
  DisputeKind,
  DisputeOutcome,
  DisputeResolutionNote,
  DisputeStatus,
  DistanceBucket,
  ErrorCode,
  ItemCategory,
  LatLng,
  LodgingClaimStatus,
  LodgingKind,
  MeetupStatus,
  ParticipantRole,
  PlaceCategory,
  PriceSource,
  ReviewStatus,
  SettlementOutcome,
  TicketType,
  UserRole,
  Variant,
  VariantPairing,
} from '@tablemate/shared';

import {
  bucketFor,
  variantFor,
  variantFromBucket,
} from '../../src/modules/experiment/assignment.ts';
import { issueSecret } from '../../src/modules/consoles/secrets.ts';
import { captureKey, holdKey, refundKey, releaseKey } from '../../src/modules/payments/holds.ts';
import {
  TEST_ISSUER_STEM,
  readCitiesConfig,
  readIssuerConfigs,
  readRegistryFile,
} from '../../src/modules/proofs/registry.ts';
import { hasValidProof, proofValidity } from '../../src/modules/proofs/validity.ts';
import { signAccessToken, verifyAccessToken } from '../../src/plugins/auth.ts';

import { TEST_CARDS } from './stripe-proxy/state.ts';
import type { TestCardId } from './stripe-proxy/state.ts';

// Type-only, and taken from the modules that declare them: the harness module is loaded by Vitest's
// `globalSetup`, so nothing of it is read here at run time, and `App`/`AppServices` are the app's own
// declarations.
import type { App, AppServices } from '../../src/app.ts';
import type { StripeContext, TestApp } from './app.ts';

export interface FactoryContext {
  /** The container a fixture writes through: the guarded client, the environment, the keyring, the clock. */
  readonly services: Pick<AppServices, 'db' | 'env' | 'keyring' | 'clock'>;
  /** The Stripe topology of this run: `mock` reaches the proxy, `test` reaches Stripe's test API. */
  readonly stripe: StripeContext;
  /** The built app, when the context has one: the flows inject requests into it. */
  readonly app?: App;
}

/** The environment one process drives a provider in; the loaded `api` configuration (AAP 0.6.2). */
export type { ApiEnv };

/** Anything Prisma generated an id for, so a builder takes the row it needs and nothing else. */
export interface FixtureRef {
  readonly id: string;
}

/** A per-process counter: unique handles, names and phone numbers within one run, without a query. */
let fixtureCounter = 0;

/** The next fixture number, from 1. */
function nextFixtureNumber(): number {
  fixtureCounter += 1;
  return fixtureCounter;
}

/** The reserved fictional number prefix of AAP 0.5.2: `+1 <area> 555 01xx`. */
const FIXTURE_PHONE_PREFIX = '+141555501';

/** A complete fictional E.164 number, from the range no numbering authority assigns (AAP 0.5.2). */
function fixturePhone(): string {
  return `${FIXTURE_PHONE_PREFIX}${String(nextFixtureNumber() % 100).padStart(2, '0')}`;
}

/** `bytes` random bytes as lowercase hex. */
function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * A PaymentIntent id no code retrieves (AAP 0.5.3), for a deposit that has already reached a final
 * status: the row needs the column filled, and a real authorization for it would be noise at the
 * provider — and, in `test` mode, a real object to clean up.
 */
function syntheticPaymentIntentId(): string {
  return `pi_fixture_${randomHex(12)}`;
}

/**
 * A distinct decimal nullifier for a fixture proof (AAP 0.5.2, 0.5.5).
 *
 * Sixteen random bytes read as one unsigned big-endian integer, far below the BN254 order, scaled by a
 * million and offset by the process counter: unique within a process and, with 128 bits of entropy,
 * unique across the workers of one run — which matters because a suite that shares a database with a
 * sibling process still spends each nullifier exactly once.
 */
function syntheticNullifier(): string {
  return (BigInt(`0x${randomHex(16)}`) * 1_000_000n + BigInt(nextFixtureNumber())).toString();
}

/** The `@db.Date` value of a `YYYY-MM-DD` day: midnight UTC, so no offset can move the calendar day. */
function dateColumn(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

/** A JSON response body's field, or `null` when it is absent or not of that shape. */
function fieldOf(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null) return null;
  return (value as Record<string, unknown>)[name];
}

/**
 * The elements of a JSON response body's list field, as `unknown` each.
 *
 * `Array.isArray` narrows its argument to `any[]`, so the assertion is what keeps every element
 * `unknown` and the callers free of the `no-unsafe-*` lint rules.
 */
function recordsOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/** A string field of a JSON response body, or `null`. */
function stringField(value: unknown, name: string): string | null {
  const field = fieldOf(value, name);
  return typeof field === 'string' ? field : null;
}

/**
 * The `capture_before` instant Stripe reports on an expanded `latest_charge` (AAP 0.2.4): the
 * deadline a deposit's `captureBefore` records, in unix seconds on the wire.
 */
function captureBeforeOf(intent: unknown): Date | null {
  const charge = fieldOf(intent, 'latest_charge');
  const details = fieldOf(charge, 'payment_method_details');
  const card = fieldOf(details, 'card');
  const raw = fieldOf(card, 'capture_before');
  return typeof raw === 'number' ? new Date(raw * 1000) : null;
}

/**
 * The one Stripe origin the `test` and `live` topologies reach; `mock` reaches its proxy instead.
 * Spelled here rather than imported from the SDK, which only `payments/stripe-gateway.ts` may load.
 */
const STRIPE_API_ORIGIN = 'https://api.stripe.com';

/** One parameter value in Stripe's form encoding: a scalar, or a repeated key. */
export type StripeFormValue = string | number | boolean | readonly string[];

/** The parameters of one Stripe request, in Stripe's own bracket notation. */
export type StripeFormParams = Readonly<Record<string, StripeFormValue | undefined>>;

export interface StripeApi {
  /** POST `path` with Stripe's bracket-encoded `params`, optionally under an idempotency key. */
  post<T = unknown>(path: string, params?: StripeFormParams, idempotencyKey?: string): Promise<T>;
  /** GET `path` with a query string. */
  get<T = unknown>(path: string, query?: Readonly<Record<string, string>>): Promise<T>;
}

/** Encode parameters as `application/x-www-form-urlencoded`, repeated keys for an array value. */
function formEncode(params: StripeFormParams): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const values =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? [value]
        : value;
    for (const item of values) {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
    }
  }
  return pairs.join('&');
}

/** Stripe's error `type` and `code` from a failed answer's body, for the `Error` a caller sees. */
function stripeErrorDetail(body: unknown): string {
  const error = fieldOf(body, 'error');
  const parts = [fieldOf(error, 'type'), fieldOf(error, 'code')].filter(
    (part): part is string => typeof part === 'string',
  );
  return parts.length === 0 ? 'no error code' : parts.join('/');
}

/** The origin and the bearer key of this run's Stripe topology. */
function stripeTransport(ctx: FactoryContext): { readonly base: string; readonly key: string } {
  if (ctx.stripe.mode === 'mock') {
    const base = ctx.stripe.apiBase;
    if (base === null) {
      throw new Error('STRIPE_MODE=mock needs the proxy address the globalSetup provides');
    }
    return { base: base.replace(/\/+$/, ''), key: STRIPE_MOCK_PLACEHOLDERS.secretKey };
  }
  return { base: STRIPE_API_ORIGIN, key: ctx.services.env.stripe.secretKey };
}

export function stripeApi(ctx: FactoryContext): StripeApi {
  const { base, key } = stripeTransport(ctx);
  async function send<T>(
    method: 'GET' | 'POST',
    path: string,
    params: StripeFormParams | undefined,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    let url = `${base}${path}`;
    const init: RequestInit = { method, headers };
    if (method === 'GET') {
      const query = params === undefined ? '' : formEncode(params);
      if (query !== '') url += `${path.includes('?') ? '&' : '?'}${query}`;
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      init.body = formEncode(params ?? {});
      if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
    }
    const response = await fetch(url, init);
    const text = await response.text();
    const parsed: unknown = text === '' ? null : (JSON.parse(text) as unknown);
    if (!response.ok) {
      throw new Error(
        `stripe ${method} ${path} failed with ${response.status}: ${stripeErrorDetail(parsed)}`,
      );
    }
    return parsed as T;
  }
  return {
    post: (path, params, idempotencyKey) => send('POST', path, params, idempotencyKey),
    get: (path, query) => send('GET', path, query),
  };
}

/** The card outcome a fixture account is given. `none` leaves the account with no customer at all. */
export type CardFixture = 'visa' | '3ds' | 'declining' | 'none';

/**
 * The card fixture that stands for each outcome (AAP 0.11.2), per topology.
 *
 * `visa` authorizes into a capturable hold, `3ds` waits on 3-D Secure, and `declining` is a card the
 * issuer refuses. The two topologies publish different ids for the last one: the proxy's own fixture
 * is `pm_card_chargeDeclined`, while Stripe's published test method that attaches successfully and
 * then declines the charge is `pm_card_chargeCustomerFail`, which is what a decline fixture needs —
 * an id that cannot be attached would fail at `makeUser` instead of at the charge a case is testing.
 */
const CARD_FIXTURES: Readonly<
  Record<CardFixture, { readonly mock: TestCardId | null; readonly test: string | null }>
> = {
  visa: { mock: TEST_CARDS.visa, test: TEST_CARDS.visa },
  '3ds': { mock: TEST_CARDS.authenticationRequired, test: TEST_CARDS.authenticationRequired },
  declining: { mock: TEST_CARDS.chargeDeclined, test: 'pm_card_chargeCustomerFail' },
  none: { mock: null, test: null },
};

/**
 * The customer and saved card a fixture account is given (AAP 0.3.2).
 *
 * In `mock` the proxy's control route makes both in one call; in `test` the customer is created,
 * the card fixture attached and set as the customer's default, which is the card
 * `stripe-gateway.ts`'s `selectPaymentMethod` reads when a hold is placed.
 */
async function createStripeCustomer(
  ctx: FactoryContext,
  card: CardFixture,
): Promise<{ readonly customerId: string | null; readonly paymentMethodId: string | null }> {
  const fixture = CARD_FIXTURES[card];
  if (fixture.mock === null && fixture.test === null) {
    return { customerId: null, paymentMethodId: null };
  }
  const proxy = ctx.stripe.proxy;
  if (proxy !== null) {
    return proxy.createCustomer({ card: fixture.mock });
  }
  const api = stripeApi(ctx);
  const created = await api.post('/v1/customers');
  const customerId = stringField(created, 'id');
  if (customerId === null) {
    throw new Error('stripe returned no customer id');
  }
  if (fixture.test === null) {
    return { customerId, paymentMethodId: null };
  }
  const cardId = fixture.test;
  const attached = await api.post(`/v1/payment_methods/${encodeURIComponent(cardId)}/attach`, {
    customer: customerId,
  });
  const paymentMethodId = stringField(attached, 'id');
  if (paymentMethodId === null) {
    throw new Error('stripe returned no payment method id');
  }
  await api.post(`/v1/customers/${customerId}`, {
    'invoice_settings[default_payment_method]': paymentMethodId,
  });
  return { customerId, paymentMethodId };
}

/** What {@link makeUser} may set. Every member has the value a plain traveler fixture needs. */
export interface UserFixtureOptions {
  /** Record the 18+ confirmation and the terms version, as `POST /me/consents` does. Default true. */
  readonly consents?: boolean;
  /** The account's role; `operator` reaches the `/admin` routes (AAP 0.3.3). Default `traveler`. */
  readonly role?: UserRole;
  /** The card fixture the account's Stripe customer holds. Default `visa`. */
  readonly card?: CardFixture;
  /** Write the account as a tombstone: every personal field null and `deletedAt` set (AAP 0.5.2). */
  readonly deleted?: boolean;
  /** Set `deletionRequestedAt` and revoke the session, which is the write fence of AAP 0.5.3. */
  readonly deletionRequested?: boolean;
  /** The `homeCountryCode` the "home-city region" of tier 0 carries. Default `PT`. */
  readonly homeCountryCode?: string;
  /** The address the account is created for; a `test-…@example.test` one otherwise. */
  readonly email?: string;
  /** Insert this variant instead of the one the experiment assignment would compute (AAP 0.5.7). */
  readonly variant?: Variant;
}

/**
 * One fixture account, and the handles a case acts as it with (AAP 0.5.2, 0.11.2).
 *
 * `handle` is null only for a tombstone, which keeps no handle; `stripeCustomerId` is null for an
 * account created with `card: 'none'`, which is how a case reaches `402 hold_failed`'s
 * `no_saved_card`; `cardId` is the saved card a live hold is placed against.
 */
export interface UserFixture {
  readonly id: string;
  readonly handle: string | null;
  readonly email: string;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly stripeCustomerId: string | null;
  readonly cardId: string | null;
}

export async function makeUser(
  ctx: FactoryContext,
  options: UserFixtureOptions = {},
): Promise<UserFixture> {
  const { db, env, clock } = ctx.services;
  const now = clock.now();
  const tombstone = options.deleted === true;
  const consented = !tombstone && options.consents !== false;
  const revoked = tombstone || options.deletionRequested === true;
  const role = options.role ?? 'traveler';
  const email = options.email ?? `test-user-${nextFixtureNumber()}-${randomHex(4)}@example.test`;
  const handle = tombstone ? null : `test-user-${nextFixtureNumber()}-${randomHex(4)}`;
  const customer = tombstone
    ? { customerId: null, paymentMethodId: null }
    : await createStripeCustomer(ctx, options.card ?? 'visa');
  const user = await db.user.create({
    data: {
      emailCiphertext: tombstone ? null : encryptField(ctx.services.keyring, email),
      emailLookupHash: tombstone ? null : emailLookupHash(env.EMAIL_LOOKUP_PEPPER, email),
      handle,
      avatarSeed: tombstone ? null : randomHex(8),
      homeCity: tombstone ? null : 'Fixture Home City',
      homeCountryCode: tombstone ? null : (options.homeCountryCode ?? 'PT'),
      role,
      ageConfirmedAt: consented ? now : null,
      termsVersion: consented ? env.TERMS_VERSION : null,
      stripeCustomerId: customer.customerId,
      deletionRequestedAt: options.deletionRequested === true ? now : null,
      deletedAt: tombstone ? now : null,
    },
    select: { id: true },
  });
  if (!tombstone) {
    const variant =
      options.variant ??
      variantFromBucket(bucketFor(env.EXPERIMENT_SALT, user.id), env.EXPERIMENT_SOCIAL_SHARE);
    await db.experimentAssignment.createMany({
      data: [
        {
          userId: user.id,
          variant,
          shareAtAssignment: env.EXPERIMENT_SOCIAL_SHARE,
          assignedAt: now,
        },
      ],
      skipDuplicates: true,
    });
  }
  const session = await db.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: sha256Hex(randomToken()),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_DAYS * DAY_MS),
      revokedAt: revoked ? now : null,
    },
    select: { id: true },
  });
  return {
    id: user.id,
    handle,
    email,
    sessionId: session.id,
    accessToken: await signAccessToken(ctx.services, { sub: user.id, role, sid: session.id }),
    stripeCustomerId: customer.customerId,
    cardId: customer.paymentMethodId,
  };
}

/** What {@link makeProof} may set. */
export interface ProofFixtureOptions {
  /** The city the stay is proved for; its configuration supplies the zone the window is judged in. */
  readonly cityId: string;
  /** The proof's arrival date as `YYYY-MM-DD`. Default: yesterday, in the city's time. */
  readonly arrivalDate?: string;
  /** The proof's departure date as `YYYY-MM-DD`. Default: five days out, in the city's time. */
  readonly departureDate?: string;
  /** Which default dates to use: a valid stay (true, the default) or one that has already ended. */
  readonly validNow?: boolean;
}

/** One fixture proof: the row's id, its spent nullifier and the window it is valid in. */
export interface ProofFixture {
  readonly id: string;
  readonly nullifier: string;
  readonly arrivalDate: string;
  readonly departureDate: string;
  readonly validFrom: Date;
  readonly validTo: Date;
}

export async function makeProof(
  ctx: FactoryContext,
  user: FixtureRef,
  options: ProofFixtureOptions,
): Promise<ProofFixture> {
  const city = await ensureCity(ctx, options.cityId);
  const today = localDateKey(city.timezone, ctx.services.clock.now());
  const validNow = options.validNow !== false;
  const arrivalDate = options.arrivalDate ?? addLocalDays(today, validNow ? -1 : -30);
  const departureDate = options.departureDate ?? addLocalDays(today, validNow ? 5 : -20);
  const { validFrom, validTo } = proofValidity(city.timezone, arrivalDate, departureDate);
  const issuer = readIssuerConfigs().find((entry) => entry.stem === TEST_ISSUER_STEM);
  if (issuer === undefined) {
    throw new Error('config/issuers/tablemate-test.json is missing');
  }
  const registry = readRegistryFile('test');
  const nullifier = syntheticNullifier();
  const proof = await ctx.services.db.$transaction(async (tx) => {
    const row = await tx.itineraryProof.create({
      data: {
        userId: user.id,
        cityId: city.id,
        arrivalDate: dateColumn(arrivalDate),
        departureDate: dateColumn(departureDate),
        issuerId: BigInt(issuer.config.issuerId),
        nullifier,
        validFrom,
        validTo,
        registryRoot: registry.root,
      },
      select: { id: true },
    });
    await tx.spentNullifier.create({
      data: { nullifier, spentAt: ctx.services.clock.now() },
    });
    return row;
  });
  return { id: proof.id, nullifier, arrivalDate, departureDate, validFrom, validTo };
}

/** What {@link makeVenue} may set. */
export interface VenueFixtureOptions {
  /** The city the venue stands in; its centroid is the default location. */
  readonly cityId: string;
  /** The latitude to write; the city centroid's otherwise. */
  readonly lat?: number;
  /** The longitude to write; the city centroid's otherwise. */
  readonly lng?: number;
  /** Whether the venue is an active partner a proposal may name. Default true. */
  readonly isActivePartner?: boolean;
  /** Issue a console secret, as venue onboarding does. Default true. */
  readonly withSecret?: boolean;
}

/** One fixture venue: where it is, and the console secret that derives its check-in code. */
export interface VenueFixture {
  readonly id: string;
  readonly cityId: string;
  readonly lat: number;
  readonly lng: number;
  readonly secret: string | null;
}

export async function makeVenue(
  ctx: FactoryContext,
  options: VenueFixtureOptions,
): Promise<VenueFixture> {
  const city = await ensureCity(ctx, options.cityId);
  const point = {
    lat: options.lat ?? centroidOf(city).lat,
    lng: options.lng ?? centroidOf(city).lng,
  };
  const material = options.withSecret === false ? null : issueSecret(ctx.services);
  const now = ctx.services.clock.now();
  const venue = await ctx.services.db.$transaction(async (tx) => {
    const row = await tx.venue.create({
      data: {
        cityId: city.id,
        name: `Fixture Venue ${nextFixtureNumber()}`,
        address: '1 Fixture Street',
        isActivePartner: options.isActivePartner !== false,
        isFixture: true,
        secretLookupHash: material?.secretLookupHash ?? null,
        secretCiphertext: material?.secretCiphertext ?? null,
        secretIssuedAt: material === null ? null : now,
      },
      select: { id: true },
    });
    await setPoint(tx, 'venue', row.id, point);
    return row;
  });
  return {
    id: venue.id,
    cityId: city.id,
    lat: point.lat,
    lng: point.lng,
    secret: material?.secret ?? null,
  };
}

/** What {@link makeLodging} may set. */
export interface LodgingFixtureOptions {
  /** The city the lodging stands in. */
  readonly cityId: string;
  /** The latitude to write; the city centroid's otherwise. */
  readonly lat?: number;
  /** The longitude to write; the city centroid's otherwise. */
  readonly lng?: number;
  /** The business number, from the reserved fictional range. */
  readonly phone?: string;
  /** Issue a lodging console secret. Default false. */
  readonly withSecret?: boolean;
  /** Mark the lodging as one that asked not to be called (AAP 0.5.3). Default false. */
  readonly doNotCall?: boolean;
  /** The lodging kind. Default `hostel`. */
  readonly kind?: LodgingKind;
}

/** One fixture lodging. */
export interface LodgingFixture {
  readonly id: string;
  readonly cityId: string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly phone: string;
  readonly secret: string | null;
}

export async function makeLodging(
  ctx: FactoryContext,
  options: LodgingFixtureOptions,
): Promise<LodgingFixture> {
  const city = await ensureCity(ctx, options.cityId);
  const point = {
    lat: options.lat ?? centroidOf(city).lat,
    lng: options.lng ?? centroidOf(city).lng,
  };
  const material = options.withSecret === true ? issueSecret(ctx.services) : null;
  const name = `Fixture Lodging ${nextFixtureNumber()}`;
  const phone = options.phone ?? fixturePhone();
  const now = ctx.services.clock.now();
  const lodging = await ctx.services.db.$transaction(async (tx) => {
    const row = await tx.lodging.create({
      data: {
        cityId: city.id,
        name,
        kind: options.kind ?? 'hostel',
        address: '2 Fixture Street',
        phone,
        phoneSource: 'operator',
        doNotCall: options.doNotCall === true,
        isFixture: true,
        secretLookupHash: material?.secretLookupHash ?? null,
        secretCiphertext: material?.secretCiphertext ?? null,
        secretIssuedAt: material === null ? null : now,
      },
      select: { id: true },
    });
    await setPoint(tx, 'lodging', row.id, point);
    return row;
  });
  return {
    id: lodging.id,
    cityId: city.id,
    name,
    lat: point.lat,
    lng: point.lng,
    phone,
    secret: material?.secret ?? null,
  };
}

/** What {@link makePlace} may set. */
export interface PlaceFixtureOptions {
  /** The city the place stands in. */
  readonly cityId: string;
  /** What the place is measured from; the city centroid unless given. */
  readonly near?: LatLng;
  /** How far due north of `near` the place stands, in metres, which suggestions measure. Default 200. */
  readonly distanceM?: number;
  /** The place's category, one of the four a suggestion may draw from. */
  readonly category: PlaceCategory;
  /** The OpenStreetMap `opening_hours` value suggestions evaluate. Default `Mo-Su 08:00-23:30`. */
  readonly openingHours?: string;
  /** The business number; a reserved fictional one otherwise. */
  readonly phone?: string;
  /** The place's own site. */
  readonly website?: string;
  /** The menu link the pipeline fetches; the `sourceUrl` of an `online_menu` record. */
  readonly menuUrl?: string;
  /** Mark the place as one that asked not to be called (AAP 0.5.3). Default false. */
  readonly doNotCall?: boolean;
}

/** One fixture place: where it is, and what its price records are attributed to. */
export interface PlaceFixture {
  readonly id: string;
  readonly cityId: string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly phone: string;
  readonly menuUrl: string | null;
  readonly website: string | null;
}

export async function makePlace(
  ctx: FactoryContext,
  options: PlaceFixtureOptions,
): Promise<PlaceFixture> {
  const city = await ensureCity(ctx, options.cityId);
  const origin = options.near ?? centroidOf(city);
  const point = offsetNorth(origin, options.distanceM ?? 200);
  const name = `Fixture Place ${nextFixtureNumber()}`;
  const phone = options.phone ?? fixturePhone();
  const place = await ctx.services.db.$transaction(async (tx) => {
    const row = await tx.place.create({
      data: {
        cityId: city.id,
        name,
        category: options.category,
        openingHours: options.openingHours ?? 'Mo-Su 08:00-23:30',
        phone,
        website: options.website ?? null,
        menuUrl: options.menuUrl ?? null,
        doNotCall: options.doNotCall === true,
        isFixture: true,
      },
      select: { id: true },
    });
    await setPoint(tx, 'place', row.id, point);
    return row;
  });
  return {
    id: place.id,
    cityId: city.id,
    name,
    lat: point.lat,
    lng: point.lng,
    phone,
    menuUrl: options.menuUrl ?? null,
    website: options.website ?? null,
  };
}

/** One price item of a capture batch, in the shape the estimate reads. */
export interface PriceItemFixture {
  /** The item's name as the source spelled it. */
  readonly name: string;
  /** The bucket the estimate groups by. */
  readonly itemCategory: ItemCategory;
  /** The amount in integer USD cents, which the batch reports as its price. */
  readonly usdCents: number;
  /** Which pipeline captured it, which the ranking's provenance and the freshness window read. */
  readonly source: PriceSource;
  /** Whether a drink is alcoholic; estimates exclude those from the estimate (AAP 0.5.7). */
  readonly alcoholic?: boolean;
  /** A ticket's per-person flag, required for `ticket` and null otherwise (AAP 0.5.6). */
  readonly perPerson?: boolean;
  /** A ticket's admission kind, required for `ticket` and null otherwise (AAP 0.5.6). */
  readonly ticketType?: TicketType;
  /** The capture instant; the injected clock's now otherwise. */
  readonly capturedAt?: Date;
  /** Whether the record feeds suggestions. Default `approved`. */
  readonly reviewStatus?: ReviewStatus;
}

/** What {@link makePriceRecords} wrote: the batch the records share, and their ids. */
export interface PriceBatchFixture {
  readonly batchId: string;
  readonly ids: readonly string[];
}

export async function makePriceRecords(
  ctx: FactoryContext,
  place: FixtureRef & {
    readonly phone?: string | null;
    readonly website?: string | null;
    readonly menuUrl?: string | null;
  },
  items: readonly PriceItemFixture[],
  options: { readonly batchId?: string } = {},
): Promise<PriceBatchFixture> {
  const batchId = options.batchId ?? randomUUID();
  const now = ctx.services.clock.now();
  const ids: string[] = [];
  for (const item of items) {
    const capturedAt = item.capturedAt ?? now;
    const row = await ctx.services.db.priceRecord.create({
      data: {
        placeId: place.id,
        captureBatchId: batchId,
        itemName: item.name,
        normalizedName: item.name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(),
        itemCategory: item.itemCategory,
        alcoholic: item.alcoholic ?? null,
        perPerson: item.perPerson ?? null,
        ticketType: item.ticketType ?? null,
        priceText: `$${Math.floor(item.usdCents / 100)}.${String(item.usdCents % 100).padStart(2, '0')}`,
        localAmountMinor: item.usdCents,
        currency: 'USD',
        priceUsdCents: item.usdCents,
        source: item.source,
        sourceUrl: priceSourceUrl(item.source, place),
        capturedAt,
        fxDate: dateColumn(localDateKey('UTC', capturedAt)),
        confidence: null,
        reviewStatus: item.reviewStatus ?? 'approved',
        isFixture: true,
      },
      select: { id: true },
    });
    ids.push(row.id);
  }
  return { batchId, ids };
}

/** The `sourceUrl` of one price record, which is the evidence the source gate stores (AAP 0.5.6). */
function priceSourceUrl(
  source: PriceSource,
  place: {
    readonly phone?: string | null;
    readonly website?: string | null;
    readonly menuUrl?: string | null;
  },
): string {
  if (source === 'phone_quote' && place.phone !== null && place.phone !== undefined) {
    return `tel:${place.phone}`;
  }
  if (source === 'operator_entry') {
    return 'operator:test';
  }
  return place.menuUrl ?? place.website ?? 'https://fixtures.invalid/tablemate-place';
}

async function ensureCity(ctx: FactoryContext, cityId: string) {
  const city = readCitiesConfig().cities.find((entry) => entry.id === cityId);
  if (city === undefined) {
    throw new Error(`config/cities.json holds no city "${cityId}"`);
  }
  const fields = {
    circuitCityId: city.circuitCityId,
    name: city.name,
    countryCode: city.countryCode,
    timezone: city.timezone,
    callLanguage: city.callLanguage,
    currency: city.currency,
    bbox: city.bbox,
  };
  await ctx.services.db.$transaction(async (tx) => {
    await tx.city.upsert({
      where: { id: city.id },
      create: { id: city.id, ...fields },
      update: fields,
    });
    await setPoint(tx, 'city', city.id, city.centroid);
  });
  return city;
}

/** The city's centroid, which every coordinate a builder writes is an offset from. */
function centroidOf(city: { readonly centroid: LatLng }): LatLng {
  return city.centroid;
}

/** A point `meters` due north of `origin`: the same offset `perf-seed.ts` places its places with. */
function offsetNorth(origin: LatLng, meters: number): LatLng {
  return { lat: origin.lat + meters / 111_320, lng: origin.lng };
}

/** Which side of a meetup a settlement fixture concerns: both present, neither, or one of them. */
export type PartyPresence = 'both' | 'neither' | ParticipantRole;

/** What {@link makeMeetup} may replace in a settlement. */
export interface SettlementFixtureOptions {
  /** The outcome to record. Default: the meetup status's own. */
  readonly outcome?: SettlementOutcome;
  /**
   * Who was there. Default: `both` for a completed meetup, `neither` for an unattended one, and the
   * initiator otherwise — which for `no_show` is the attendee and for `late_cancel` the counterparty
   * the canceller's hold is captured for.
   */
  readonly present?: PartyPresence;
}

/** What {@link makeMeetup} may set. A member not given comes from the status table. */
export interface MeetupFixtureOptions {
  /** The lifecycle value the meetup carries, which also decides the shape of everything below. */
  readonly status: MeetupStatus;
  /** The proposing account. */
  readonly initiator: FixtureRef;
  /** The invited account. */
  readonly recipient: FixtureRef;
  /** The partner venue the meetup happens at. */
  readonly venue: FixtureRef;
  /** When it starts. Default: two hours out while the meetup is open, three hours back once final. */
  readonly startsAt?: Date;
  /** The deposit each side holds. Default `DEFAULT_DEPOSIT_CENTS`, the middle level. */
  readonly depositCents?: DepositCents;
  /** Override a side's deposit status; `recipient: null` writes no recipient deposit at all. */
  readonly deposits?: {
    readonly initiator?: DepositStatus;
    readonly recipient?: DepositStatus | null;
  };
  /** Override a side's check-in: `pass`, `fail`, or absent for none. */
  readonly checkIns?: {
    readonly initiator?: CheckInResult;
    readonly recipient?: CheckInResult;
  };
  /** Override the settlement the status implies. */
  readonly settlement?: SettlementFixtureOptions;
  /** Override the cancellation reason a `cancelled` meetup records. */
  readonly cancelReason?: CancelReason;
}

/** One fixture deposit: its owner, its status and the PaymentIntent behind it. */
export interface DepositFixture {
  readonly id: string;
  readonly ownerId: string;
  readonly role: ParticipantRole;
  readonly status: DepositStatus;
  readonly paymentIntentId: string | null;
}

/** One fixture meetup: the rows a case needs to drive its routes and its settlement. */
export interface MeetupFixture {
  readonly id: string;
  readonly status: MeetupStatus;
  readonly startsAt: Date;
  readonly deposits: {
    readonly initiator: DepositFixture | null;
    readonly recipient: DepositFixture | null;
  };
}

/** What one meetup status implies before any override (AAP 0.5.3). */
interface StatusShape {
  /** Each side's deposit status; a null recipient means the meetup never left `proposed`. */
  readonly deposits: {
    readonly initiator: DepositStatus;
    readonly recipient: DepositStatus | null;
  };
  /** Whether the meetup is still `proposed` or `locked`, which decides the default start instant. */
  readonly open: boolean;
  /** Whether both holds were held at some point, so `lockedAt` and the acceptance are recorded. */
  readonly locked: boolean;
  /** The settlement outcome the status records, when it records one. */
  readonly outcome?: SettlementOutcome;
  /** Who was present, under that outcome. */
  readonly present?: PartyPresence;
  /** The cancellation reason a `cancelled` meetup records. */
  readonly cancelReason?: CancelReason;
}

const STATUS_SHAPES: Readonly<Record<MeetupStatus, StatusShape>> = {
  // The proposal is visible once the initiator's hold is held (AAP 0.5.3); a case that overrides the
  // initiator's deposit to `pending` or `failed` gets the invisible proposal `402 hold_failed` leaves.
  proposed: { deposits: { initiator: 'held', recipient: null }, open: true, locked: false },
  locked: { deposits: { initiator: 'held', recipient: 'held' }, open: true, locked: true },
  declined: { deposits: { initiator: 'released', recipient: null }, open: false, locked: false },
  lapsed: { deposits: { initiator: 'released', recipient: null }, open: false, locked: false },
  cancelled: {
    deposits: { initiator: 'released', recipient: 'released' },
    open: false,
    locked: false,
    cancelReason: 'initiator',
  },
  completed: {
    deposits: { initiator: 'released', recipient: 'released' },
    open: false,
    locked: true,
    outcome: 'completed',
    present: 'both',
  },
  forfeited: {
    deposits: { initiator: 'released', recipient: 'released' },
    open: false,
    locked: true,
    outcome: 'no_show',
    present: 'initiator',
  },
  unattended: {
    deposits: { initiator: 'released', recipient: 'released' },
    open: false,
    locked: true,
    outcome: 'unattended',
    present: 'neither',
  },
  // A hold was lost, so no forfeit and no credit apply: one deposit expired, the other was released.
  lock_lost: {
    deposits: { initiator: 'expired', recipient: 'released' },
    open: false,
    locked: true,
  },
  no_fault: {
    deposits: { initiator: 'released', recipient: 'released' },
    open: false,
    locked: true,
  },
};

/** The four deposit statuses AAP 0.5.3 calls final, as a list a status can be looked up in. */
const FINAL_DEPOSIT_STATUSES: readonly DepositStatus[] = [
  'released',
  'captured',
  'refunded',
  'expired',
];

/** The two statuses whose attempt exists at the provider and is still standing. */
function isLiveDeposit(status: DepositStatus): boolean {
  return status === 'held' || status === 'requires_action';
}

/** The settlement a meetup status implies, or the one an option overrides it with; null for none. */
function settlementPlan(
  shape: StatusShape,
  override: SettlementFixtureOptions | undefined,
): { readonly outcome: SettlementOutcome; readonly present: PartyPresence } | null {
  const outcome = override?.outcome ?? shape.outcome;
  if (outcome === undefined) {
    return null;
  }
  const fallback: PartyPresence =
    outcome === 'completed' ? 'both' : outcome === 'unattended' ? 'neither' : 'initiator';
  return { outcome, present: override?.present ?? shape.present ?? fallback };
}

/**
 * Each side's deposit status (AAP 0.5.3): an option's own value where one is given, the settlement's
 * implication otherwise — `completed` and `unattended` release both, a capture outcome captures the
 * side that was not there and releases the side that was — and the status table's row last.
 */
function depositStatuses(
  shape: StatusShape,
  plan: { readonly outcome: SettlementOutcome; readonly present: PartyPresence } | null,
  override: MeetupFixtureOptions['deposits'],
): { readonly initiator: DepositStatus | null; readonly recipient: DepositStatus | null } {
  if (override !== undefined) {
    return {
      initiator: override.initiator ?? shape.deposits.initiator,
      recipient: 'recipient' in override ? (override.recipient ?? null) : shape.deposits.recipient,
    };
  }
  if (plan === null) {
    return shape.deposits;
  }
  if (plan.outcome === 'completed' || plan.outcome === 'unattended') {
    return { initiator: 'released', recipient: 'released' };
  }
  if (plan.present !== 'initiator' && plan.present !== 'recipient') {
    throw new Error(`a ${plan.outcome} settlement needs one side present, not "${plan.present}"`);
  }
  return plan.present === 'initiator'
    ? { initiator: 'released', recipient: 'captured' }
    : { initiator: 'captured', recipient: 'released' };
}

/** Each side's check-in result: an option's own value, else what the settlement says was there. */
function checkInPlan(
  plan: { readonly outcome: SettlementOutcome; readonly present: PartyPresence } | null,
  override: MeetupFixtureOptions['checkIns'],
): { readonly initiator: CheckInResult | null; readonly recipient: CheckInResult | null } {
  const implied = (role: ParticipantRole): CheckInResult | null => {
    if (plan === null) return null;
    if (plan.outcome === 'completed') return 'pass';
    if (plan.outcome === 'unattended') return null;
    return plan.present === role ? 'pass' : null;
  };
  return {
    initiator: override?.initiator ?? implied('initiator'),
    recipient: override?.recipient ?? implied('recipient'),
  };
}

/** The `forfeitReason` a settlement outcome records on the meetup; null for the other outcomes. */
function forfeitReasonOf(
  plan: { readonly outcome: SettlementOutcome } | null,
): 'no_show' | 'late_cancel' | null {
  if (plan === null || plan.outcome === 'completed' || plan.outcome === 'unattended') return null;
  return plan.outcome;
}

function defaultStartsAt(shape: StatusShape, now: Date): Date {
  return new Date(now.getTime() + (shape.open ? 2 : -3) * HOUR_MS);
}

/** Both accounts' variants as AAP 0.5.7 pairs them: equal, or `mixed` when either holds none. */
async function pairingOf(
  ctx: FactoryContext,
  initiatorId: string,
  recipientId: string,
): Promise<VariantPairing> {
  const [initiator, recipient] = await Promise.all([
    variantFor(ctx.services.db, initiatorId),
    variantFor(ctx.services.db, recipientId),
  ]);
  const left = initiator?.variant ?? null;
  const right = recipient?.variant ?? null;
  return left !== null && left === right ? left : 'mixed';
}

/** The card a hold is placed against: the customer's newest saved one, or null when it holds none. */
async function savedCardOf(ctx: FactoryContext, customerId: string): Promise<string | null> {
  const listed = await stripeApi(ctx).get(
    `/v1/customers/${encodeURIComponent(customerId)}/payment_methods`,
    { type: 'card' },
  );
  const [first] = recordsOf(fieldOf(listed, 'data'));
  return first === undefined ? null : stringField(first, 'id');
}

/**
 * Place one live hold at the provider (AAP 0.3.2): the create the gateway makes — manual capture,
 * confirmed on-session against the owner's saved card, the attempt's metadata and an expanded
 * `latest_charge` — under the attempt's own `hold:<depositId>:<attempt>` key, so the PaymentIntent a
 * fixture records is the one the app's own recovery and settlement rules expect to find.
 */
async function createLiveHold(
  ctx: FactoryContext,
  args: {
    readonly meetupId: string;
    readonly depositId: string;
    readonly amountCents: number;
    readonly customerId: string;
  },
): Promise<{ readonly paymentIntentId: string; readonly captureBefore: Date | null }> {
  const card = await savedCardOf(ctx, args.customerId);
  const created = await stripeApi(ctx).post(
    '/v1/payment_intents',
    {
      amount: args.amountCents,
      currency: 'usd',
      customer: args.customerId,
      ...(card === null ? {} : { payment_method: card }),
      capture_method: 'manual',
      confirm: 'true',
      'metadata[meetupId]': args.meetupId,
      'metadata[depositId]': args.depositId,
      'metadata[attempt]': '1',
      'expand[]': ['latest_charge'],
    },
    holdKey(args.depositId, 1),
  );
  const paymentIntentId = stringField(created, 'id');
  const status = stringField(created, 'status');
  if (paymentIntentId === null || (status !== 'requires_capture' && status !== 'requires_action')) {
    throw new Error(`stripe answered "${status ?? 'nothing'}" where a live hold was placed`);
  }
  return { paymentIntentId, captureBefore: captureBeforeOf(created) };
}

export async function makeMeetup(
  ctx: FactoryContext,
  options: MeetupFixtureOptions,
): Promise<MeetupFixture> {
  const { db, clock } = ctx.services;
  const now = clock.now();
  const shape = STATUS_SHAPES[options.status];
  const plan = settlementPlan(shape, options.settlement);
  const statuses = depositStatuses(shape, plan, options.deposits);
  const checkIns = checkInPlan(plan, options.checkIns);
  const startsAt = options.startsAt ?? defaultStartsAt(shape, now);
  const depositCents = options.depositCents ?? DEFAULT_DEPOSIT_CENTS;
  const variantPairing = await pairingOf(ctx, options.initiator.id, options.recipient.id);
  const proposalVisible =
    options.status === 'proposed' ? statuses.initiator === 'held' : !shape.open || shape.locked;
  const settledAt =
    plan === null ? null : new Date(startsAt.getTime() + CHECK_IN_CLOSES_AFTER_MINUTES * MINUTE_MS);
  const finalAt = shape.open ? null : (settledAt ?? now);
  const bothCheckedInAt =
    checkIns.initiator === 'pass' && checkIns.recipient === 'pass' ? now : null;
  // A witness event names the city it happened in, and only the venue knows it (AAP 0.5.2).
  const venue = await db.venue.findUniqueOrThrow({
    where: { id: options.venue.id },
    select: { cityId: true },
  });

  interface LiveHold {
    readonly role: ParticipantRole;
    readonly ownerId: string;
    readonly depositId: string;
    readonly amountCents: number;
    paymentIntentId: string | null;
  }
  const liveHolds: LiveHold[] = [];
  const written: Record<ParticipantRole, DepositFixture | null> = {
    initiator: null,
    recipient: null,
  };
  const meetup = await db.$transaction(async (tx) => {
    const row = await tx.meetup.create({
      data: {
        initiatorId: options.initiator.id,
        recipientId: options.recipient.id,
        venueId: options.venue.id,
        startsAt,
        depositCents,
        status: options.status,
        cancelReason: options.cancelReason ?? shape.cancelReason ?? null,
        forfeitReason: forfeitReasonOf(plan),
        variantPairing,
        lockedAt: shape.locked ? now : null,
        proposalVisibleAt: proposalVisible ? now : null,
        // The deadline is the earlier of 48 hours out and the start, and exists only once the
        // recipient can see the proposal at all (AAP 0.5.3).
        recipientDeadline: proposalVisible
          ? new Date(
              Math.min(now.getTime() + RECIPIENT_DEADLINE_HOURS * HOUR_MS, startsAt.getTime()),
            )
          : null,
        recipientViewedAt: proposalVisible && options.status !== 'proposed' ? now : null,
        recipientAcceptedAt: shape.locked ? now : null,
        bothCheckedInAt,
        settledAt,
        finalAt,
      },
      select: { id: true },
    });
    const writeDeposit = async (
      role: ParticipantRole,
      ownerId: string,
      status: DepositStatus | null,
    ): Promise<void> => {
      if (status === null) return;
      const live = isLiveDeposit(status);
      const deposit = await tx.deposit.create({
        data: {
          meetupId: row.id,
          ownerId,
          role,
          status,
          amountCents: depositCents,
          currentAttempt: 1,
          currentPaymentIntentId: FINAL_DEPOSIT_STATUSES.includes(status)
            ? syntheticPaymentIntentId()
            : null,
          captureBefore: null,
          canceledAt: status === 'expired' ? now : null,
        },
        select: { id: true, currentPaymentIntentId: true },
      });
      const paymentIntentId = deposit.currentPaymentIntentId;
      const operation = await tx.paymentOperation.create({
        data: {
          userId: ownerId,
          depositId: deposit.id,
          kind: 'hold',
          attempt: 1,
          seq: 1,
          paymentIntentId,
          idempotencyKey: holdKey(deposit.id, 1),
          // A `pending` attempt was planned and never sent, which is the shape `fenceNeverSentHolds`
          // writes; a `failed` one was refused by the card, which `operations.ts` records as terminal;
          // every other status had its create succeed, whatever became of the authorization after.
          status:
            status === 'pending' ? 'fenced' : status === 'failed' ? 'failed_terminal' : 'succeeded',
          tries: status === 'pending' ? 0 : 1,
          completedAt: now,
        },
        select: { id: true },
      });
      const followUp = async (
        kind: 'release' | 'capture' | 'refund',
        seq: number,
        dependsOnId: string,
      ): Promise<string> => {
        const created = await tx.paymentOperation.create({
          data: {
            userId: ownerId,
            depositId: deposit.id,
            kind,
            attempt: 1,
            seq,
            paymentIntentId,
            idempotencyKey:
              kind === 'release'
                ? releaseKey(deposit.id, 1)
                : kind === 'capture'
                  ? captureKey(deposit.id, 1)
                  : refundKey(deposit.id, 1),
            status: 'succeeded',
            tries: 1,
            dependsOnId,
            completedAt: now,
          },
          select: { id: true },
        });
        return created.id;
      };
      if (status === 'released') {
        await followUp('release', 2, operation.id);
      } else if (status === 'captured') {
        await followUp('capture', 2, operation.id);
      } else if (status === 'refunded') {
        const capture = await followUp('capture', 2, operation.id);
        await followUp('refund', 3, capture);
      }
      if (live) {
        liveHolds.push({
          role,
          ownerId,
          depositId: deposit.id,
          amountCents: depositCents,
          paymentIntentId: null,
        });
      }
      written[role] = { id: deposit.id, ownerId, role, status, paymentIntentId };
    };
    await writeDeposit('initiator', options.initiator.id, statuses.initiator);
    if (statuses.recipient !== null) {
      await writeDeposit('recipient', options.recipient.id, statuses.recipient);
    }
    const sides: readonly { readonly role: ParticipantRole; readonly userId: string }[] = [
      { role: 'initiator', userId: options.initiator.id },
      { role: 'recipient', userId: options.recipient.id },
    ];
    for (const side of sides) {
      const result = checkIns[side.role];
      if (result === null) continue;
      await tx.checkIn.create({
        data: {
          meetupId: row.id,
          userId: side.userId,
          result,
          distanceBucket: result === 'pass' ? 'lt_50' : null,
          failureCode: result === 'pass' ? null : 'outside_geofence',
        },
      });
    }
    if (plan !== null && settledAt !== null) {
      const present = (role: ParticipantRole): boolean =>
        plan.present === 'both' || plan.present === role;
      await tx.meetupSettlement.create({
        data: {
          meetupId: row.id,
          outcome: plan.outcome,
          status: 'complete',
          initiatorPresent: present('initiator'),
          recipientPresent: present('recipient'),
          appliedAt: settledAt,
          completedAt: settledAt,
        },
      });
      // Both were there: a witness event each, which is what the reputation counters read, and one
      // pair-history increment. Neither is written for a forfeit or an unattended meetup (AAP 0.5.7).
      if (plan.outcome === 'completed') {
        for (const side of sides) {
          await tx.witnessEvent.create({
            data: {
              meetupId: row.id,
              userId: side.userId,
              counterpartId:
                side.role === 'initiator' ? options.recipient.id : options.initiator.id,
              venueId: options.venue.id,
              cityId: venue.cityId,
              completedAt: settledAt,
              countsForReputation: depositCents >= 500,
            },
          });
        }
        const [low, high] =
          options.initiator.id < options.recipient.id
            ? [options.initiator.id, options.recipient.id]
            : [options.recipient.id, options.initiator.id];
        await tx.pairHistory.upsert({
          where: { userLowId_userHighId: { userLowId: low, userHighId: high } },
          create: {
            userLowId: low,
            userHighId: high,
            completedCount: 1,
            firstCompletedAt: settledAt,
            lastCompletedAt: settledAt,
          },
          update: { completedCount: { increment: 1 }, lastCompletedAt: settledAt },
        });
      }
      // A forfeit credits the party that was there with the absent one's deposit (AAP 0.5.7).
      if (plan.outcome === 'no_show' || plan.outcome === 'late_cancel') {
        const credited = plan.present === 'recipient' ? options.recipient.id : options.initiator.id;
        await tx.tableCreditEntry.create({
          data: { userId: credited, meetupId: row.id, kind: 'grant', amountCents: depositCents },
        });
      }
    }
    return row;
  });
  // The live holds, placed once the rows that name them exist. Each is its own attempt at the
  // provider, so the settlement's reconciliation and the webhook handlers read exactly what they read
  // in production; a fixture never invents a PaymentIntent id the provider does not know.
  for (const hold of liveHolds) {
    const owner = await db.user.findUniqueOrThrow({
      where: { id: hold.ownerId },
      select: { stripeCustomerId: true },
    });
    if (owner.stripeCustomerId === null) {
      throw new Error('a live hold needs an account with a saved card; card "none" leaves none');
    }
    const placed = await createLiveHold(ctx, {
      meetupId: meetup.id,
      depositId: hold.depositId,
      amountCents: hold.amountCents,
      customerId: owner.stripeCustomerId,
    });
    hold.paymentIntentId = placed.paymentIntentId;
    await db.$transaction(async (tx) => {
      await tx.deposit.update({
        where: { id: hold.depositId },
        data: {
          currentPaymentIntentId: placed.paymentIntentId,
          captureBefore: placed.captureBefore,
        },
      });
      await tx.paymentOperation.updateMany({
        where: { depositId: hold.depositId, kind: 'hold', attempt: 1 },
        data: { paymentIntentId: placed.paymentIntentId },
      });
    });
    const previous = written[hold.role];
    if (previous !== null) {
      written[hold.role] = { ...previous, paymentIntentId: placed.paymentIntentId };
    }
  }
  return { id: meetup.id, status: options.status, startsAt, deposits: written };
}

/** What {@link makeCheckIn} may set. */
export interface CheckInFixtureOptions {
  /** The stored result. Default `pass`. */
  readonly result?: CheckInResult;
  /** The stored bucket for a pass. Default `lt_50`. */
  readonly distanceBucket?: DistanceBucket;
  /** The stored failure code for a fail. Default `outside_geofence`. */
  readonly failureCode?: string;
}

/** One fixture check-in: only the result and the bucket are ever stored (AAP 0.5.2). */
export interface CheckInFixture {
  readonly id: string;
  readonly userId: string;
  readonly result: CheckInResult;
}

export async function makeCheckIn(
  ctx: FactoryContext,
  meetup: FixtureRef,
  user: FixtureRef,
  options: CheckInFixtureOptions = {},
): Promise<CheckInFixture> {
  const result = options.result ?? 'pass';
  const row = await ctx.services.db.$transaction(async (tx) => {
    const checkIn = await tx.checkIn.create({
      data: {
        meetupId: meetup.id,
        userId: user.id,
        result,
        distanceBucket: result === 'pass' ? (options.distanceBucket ?? 'lt_50') : null,
        failureCode: result === 'pass' ? null : (options.failureCode ?? 'outside_geofence'),
      },
      select: { id: true },
    });
    if (result === 'pass') {
      const passes = await tx.checkIn.count({ where: { meetupId: meetup.id, result: 'pass' } });
      const target = await tx.meetup.findUniqueOrThrow({
        where: { id: meetup.id },
        select: { bothCheckedInAt: true },
      });
      if (passes >= 2 && target.bothCheckedInAt === null) {
        await tx.meetup.update({
          where: { id: meetup.id },
          data: { bothCheckedInAt: ctx.services.clock.now() },
        });
      }
    }
    return checkIn;
  });
  return { id: row.id, userId: user.id, result };
}

/** What {@link makeDispute} may set. */
export interface DisputeFixtureOptions {
  /** The subject, which marks the penalty-free venue case. Default `other`. */
  readonly kind?: DisputeKind;
  /** The dispute's state. Default `open`. */
  readonly status?: DisputeStatus;
  /** When it was filed. Default now. */
  readonly openedAt?: Date;
  /** The free text reason. Default a fixture sentence, never a real complaint. */
  readonly reason?: string;
  /** The operator's outcome, for a resolved dispute. */
  readonly outcome?: DisputeOutcome;
  /** The automatic resolution's note, for a dispute a block or a hold loss resolved. */
  readonly resolutionNote?: DisputeResolutionNote;
}

/** One fixture dispute, with the deadline the escalation job reads. */
export interface DisputeFixture {
  readonly id: string;
  readonly status: DisputeStatus;
  readonly openedAt: Date;
  readonly deadlineAt: Date;
}

export async function makeDispute(
  ctx: FactoryContext,
  meetup: FixtureRef,
  filer: FixtureRef,
  options: DisputeFixtureOptions = {},
): Promise<DisputeFixture> {
  const now = ctx.services.clock.now();
  const openedAt = options.openedAt ?? now;
  const status = options.status ?? 'open';
  const row = await ctx.services.db.dispute.create({
    data: {
      meetupId: meetup.id,
      filedById: filer.id,
      kind: options.kind ?? 'other',
      reason: options.reason ?? 'Fixture dispute',
      status,
      outcome: options.outcome ?? null,
      resolutionNote: options.resolutionNote ?? null,
      openedAt,
      deadlineAt: new Date(openedAt.getTime() + DISPUTE_RESOLUTION_DAYS * DAY_MS),
      resolvedAt: status === 'resolved' ? now : null,
    },
    select: { id: true, deadlineAt: true },
  });
  return { id: row.id, status, openedAt, deadlineAt: row.deadlineAt };
}

/** What {@link makeClaim} may set. */
export interface ClaimFixtureOptions {
  /** The stay's first day as `YYYY-MM-DD`. Default today. */
  readonly stayFrom?: string;
  /** The stay's last day as `YYYY-MM-DD`. Default five days out. */
  readonly stayTo?: string;
  /** The claim's state. Default `pending_call`. */
  readonly status?: LodgingClaimStatus;
  /** The name the verification call asks about. Default `Fixture Guest`. */
  readonly bookingName?: string;
  /** The booking reference, encrypted like the name when given. */
  readonly bookingReference?: string;
}

/** One fixture lodging claim, and the consent it records. */
export interface ClaimFixture {
  readonly id: string;
  readonly userId: string;
  readonly lodgingId: string;
  readonly status: LodgingClaimStatus;
  readonly stayFrom: string;
  readonly stayTo: string;
}

export async function makeClaim(
  ctx: FactoryContext,
  user: FixtureRef,
  lodging: FixtureRef,
  options: ClaimFixtureOptions = {},
): Promise<ClaimFixture> {
  const now = ctx.services.clock.now();
  const today = localDateKey('UTC', now);
  const stayFrom = options.stayFrom ?? today;
  const stayTo = options.stayTo ?? addLocalDays(today, 5);
  const status = options.status ?? 'pending_call';
  const terminal = status === 'verified' || status === 'rejected' || status === 'unreachable';
  const row = await ctx.services.db.lodgingClaim.create({
    data: {
      userId: user.id,
      lodgingId: lodging.id,
      stayFrom: dateColumn(stayFrom),
      stayTo: dateColumn(stayTo),
      bookingNameCiphertext: encryptField(
        ctx.services.keyring,
        options.bookingName ?? 'Fixture Guest',
      ),
      bookingReferenceCiphertext:
        options.bookingReference === undefined
          ? null
          : encryptField(ctx.services.keyring, options.bookingReference),
      callConsentAt: now,
      status,
      resolvedAt: terminal ? now : null,
      detailsErasedAt: null,
    },
    select: { id: true },
  });
  return { id: row.id, userId: user.id, lodgingId: lodging.id, status, stayFrom, stayTo };
}

export async function makeVisibility(
  ctx: FactoryContext,
  user: FixtureRef,
  claim: FixtureRef,
  showStaying: boolean,
): Promise<void> {
  await ctx.services.db.lodgingVisibility.upsert({
    where: { userId: user.id },
    create: { userId: user.id, lodgingClaimId: claim.id, showStaying },
    update: { lodgingClaimId: claim.id, showStaying },
  });
}

/** What {@link makeCallTask} may set. Exactly one of `placeId` and `lodgingId` is required. */
export interface CallTaskFixtureOptions {
  /** The dialogue the task runs. */
  readonly kind: CallTaskKind;
  /** The place a menu-price call asks about. */
  readonly placeId?: string;
  /** The lodging a stay-verification call asks about. */
  readonly lodgingId?: string;
  /** The claim a stay-verification call belongs to. */
  readonly lodgingClaimId?: string;
  /** The task's state. Default `queued`. */
  readonly status?: CallTaskStatus;
  /** How many calls have been made. Default 0. */
  readonly attempts?: number;
  /** How many definite vendor refusals have happened. Default 0. */
  readonly vendorFailures?: number;
  /** When the next attempt is due. Default now. */
  readonly nextAttemptAt?: Date;
  /** Why the task is not being dialed. */
  readonly blockedReason?: BlockedReason;
  /** When the task reached its current outcome, which the metrics date it by (AAP 0.5.7). */
  readonly outcomeAt?: Date;
  /** The operator queue's order within a band. Default 0. */
  readonly priority?: number;
}

/** One fixture call task. */
export interface CallTaskFixture {
  readonly id: string;
  readonly kind: CallTaskKind;
  readonly status: CallTaskStatus;
}

export async function makeCallTask(
  ctx: FactoryContext,
  options: CallTaskFixtureOptions,
): Promise<CallTaskFixture> {
  const status = options.status ?? 'queued';
  const row = await ctx.services.db.callTask.create({
    data: {
      kind: options.kind,
      placeId: options.placeId ?? null,
      lodgingId: options.lodgingId ?? null,
      lodgingClaimId: options.lodgingClaimId ?? null,
      status,
      attempts: options.attempts ?? 0,
      vendorFailures: options.vendorFailures ?? 0,
      nextAttemptAt: options.nextAttemptAt ?? ctx.services.clock.now(),
      outcomeAt: options.outcomeAt ?? null,
      blockedReason: options.blockedReason ?? null,
      priority: options.priority ?? 0,
      resolvedBy: null,
    },
    select: { id: true },
  });
  return { id: row.id, kind: options.kind, status };
}

/** What {@link makeCallAttempt} may set. */
export interface CallAttemptFixtureOptions {
  /** The dispatch state. Default `ended`. */
  readonly state?: CallAttemptState;
  /** What the call produced. */
  readonly outcome?: CallAttemptOutcome;
  /** The provider's call id; a fixture one otherwise, so the unique column stays unique. */
  readonly twilioCallSid?: string;
  /** The structured fields the dialogue extracted, which the operator queue shows. */
  readonly extractedFields?: Readonly<Record<string, string | number | boolean>>;
  /** The extraction confidence. */
  readonly confidence?: Confidence;
  /** The call's short summary. */
  readonly summary?: string;
  /** The language-model budget the attempt reserved, in micro-dollars. Default 0. */
  readonly llmReservedMicros?: bigint;
  /** How long the call lasted. */
  readonly durationSec?: number;
}

/** One fixture call attempt. */
export interface CallAttemptFixture {
  readonly id: string;
  readonly state: CallAttemptState;
  readonly outcome: CallAttemptOutcome | null;
}

export async function makeCallAttempt(
  ctx: FactoryContext,
  task: FixtureRef,
  options: CallAttemptFixtureOptions = {},
): Promise<CallAttemptFixture> {
  const now = ctx.services.clock.now();
  const state = options.state ?? 'ended';
  const ended = state === 'ended';
  const row = await ctx.services.db.callAttempt.create({
    data: {
      callTaskId: task.id,
      twilioCallSid: options.twilioCallSid ?? `CA${randomHex(16)}`,
      state,
      superseded: false,
      twilioFinalStatus: ended ? 'completed' : null,
      outcome: options.outcome ?? null,
      // A nullable JSON column needs Prisma's own null marker rather than plain `null`.
      extractedFields: options.extractedFields ?? Prisma.DbNull,
      summary: options.summary ?? null,
      confidence: options.confidence ?? null,
      transcript: null,
      transcriptDeleteAt: null,
      durationSec: options.durationSec ?? (ended ? 60 : null),
      startedAt: now,
      endedAt: ended ? now : null,
      llmReservedMicros: options.llmReservedMicros ?? 0n,
    },
    select: { id: true },
  });
  return { id: row.id, state, outcome: options.outcome ?? null };
}

/** One lodging-activity fact to write (AAP 0.5.7). */
export interface ActivityFactFixture {
  /** The pair that met: the key is the same whichever way round they are given. */
  readonly pair: readonly [FixtureRef, FixtureRef];
  /** When the meetup completed. Default now. */
  readonly completedAt?: Date;
  /** The meetup it belongs to; a fresh id otherwise, so the unique key stays unique. */
  readonly meetupId?: string;
}

export async function makeActivityFacts(
  ctx: FactoryContext,
  lodging: FixtureRef,
  facts: readonly ActivityFactFixture[],
): Promise<readonly string[]> {
  const now = ctx.services.clock.now();
  const ids: string[] = [];
  for (const fact of facts) {
    const [left, right] = fact.pair;
    const row = await ctx.services.db.lodgingActivityFact.create({
      data: {
        lodgingId: lodging.id,
        meetupId: fact.meetupId ?? randomUUID(),
        pairKey: pairKey(ctx.services.env.ANALYTICS_SALT, left.id, right.id),
        completedAt: fact.completedAt ?? now,
      },
      select: { id: true },
    });
    ids.push(row.id);
  }
  return ids;
}

export async function makeBlock(
  ctx: FactoryContext,
  blocker: FixtureRef,
  blocked: FixtureRef,
): Promise<void> {
  await ctx.services.db.block.create({
    data: { blockerId: blocker.id, blockedId: blocked.id, createdAt: ctx.services.clock.now() },
  });
}

/**
 * A signed-in fixture account: the row's id, and the session a request is made as.
 *
 * {@link UserFixture} satisfies it. The flows sign a **fresh** token per request through
 * `TestApp.tokenFor` rather than reusing the one `makeUser` minted, so a case that advanced the test
 * clock past the access token's 15 minutes still acts as the same account.
 */
export interface ActorRef extends FixtureRef {
  readonly sessionId: string;
}

/** What {@link proposeAndLock} may set. */
export interface ProposeAndLockOptions {
  /** The account that proposes, whose hold is placed by the proposal. */
  readonly initiator: ActorRef;
  /** The account invited, whose hold is placed by the acceptance. */
  readonly recipient: ActorRef;
  /** The partner venue the meetup happens at. */
  readonly venue: FixtureRef;
  /** When it starts. Default two hours out, inside the five-day horizon of AAP 0.5.4. */
  readonly startsAt?: Date;
  /** The deposit each side holds. Default `DEFAULT_DEPOSIT_CENTS`. */
  readonly depositCents?: DepositCents;
  /**
   * Whether to write a valid proof for both accounts first, for the venue's city. Default true:
   * proposing requires one from each side (AAP 0.5.4), so the flow supplies it and writes nothing
   * when the account already holds a valid one. A case about `403 no_valid_proof` passes `false`.
   */
  readonly proofs?: boolean;
}

/** The meetup a successful proposal and acceptance left: its id and the instant it starts at. */
export interface ProposeAndLockResult {
  readonly meetupId: string;
  readonly startsAt: Date;
}

export async function proposeAndLock(
  t: TestApp,
  options: ProposeAndLockOptions,
): Promise<ProposeAndLockResult> {
  const startsAt = options.startsAt ?? new Date(t.services.clock.nowMs() + 2 * HOUR_MS);
  if (options.proofs !== false) {
    const venue = await t.services.db.venue.findUniqueOrThrow({
      where: { id: options.venue.id },
      select: { cityId: true },
    });
    for (const actor of [options.initiator, options.recipient]) {
      const holds = await hasValidProof(
        t.services.db,
        actor.id,
        venue.cityId,
        t.services.clock.now(),
      );
      if (!holds) {
        await makeProof(t, actor, { cityId: venue.cityId });
      }
    }
  }
  const proposed = await callRoute(t.app, {
    method: 'POST',
    url: '/v1/meetups',
    as: await t.tokenFor(options.initiator),
    body: {
      recipientId: options.recipient.id,
      venueId: options.venue.id,
      startsAt: startsAt.toISOString(),
      depositCents: options.depositCents ?? DEFAULT_DEPOSIT_CENTS,
    },
  });
  assert.equal(
    proposed.status,
    201,
    `POST /v1/meetups answered ${proposed.status}: ${proposed.body}`,
  );
  const created = ProposeResponse.parse(proposed.json());
  const viewed = await callRoute(t.app, {
    method: 'GET',
    url: `/v1/meetups/${created.meetupId}`,
    as: await t.tokenFor(options.recipient),
  });
  assert.equal(viewed.status, 200, `GET /v1/meetups/:id answered ${viewed.status}: ${viewed.body}`);
  const accepted = await callRoute(t.app, {
    method: 'POST',
    url: `/v1/meetups/${created.meetupId}/accept`,
    as: await t.tokenFor(options.recipient),
  });
  assert.equal(
    accepted.status,
    200,
    `POST /v1/meetups/:id/accept answered ${accepted.status}: ${accepted.body}`,
  );
  const locked = AcceptResponse.parse(accepted.json());
  assert.equal(
    locked.status,
    'locked',
    'the recipient hold did not authorize without customer action',
  );
  return { meetupId: created.meetupId, startsAt };
}

/** What {@link checkIn} may set. */
export interface CheckInFlowOptions {
  /** The venue's console secret, which derives the code the console would display. */
  readonly venueSecret: string;
  /** How far from the venue the device is, due north, in metres. Default 20. */
  readonly distanceM?: number;
  /** The code to submit, instead of the one the console endpoint answers with. */
  readonly code?: string;
}

export async function checkIn(
  t: TestApp,
  user: ActorRef,
  meetup: { readonly id: string; readonly venueId: string },
  options: CheckInFlowOptions,
): Promise<CheckInResponse> {
  let code = options.code;
  if (code === undefined) {
    const displayed = await callRoute(t.app, {
      method: 'GET',
      url: '/v1/venue/check-in-code',
      headers: { [VENUE_SECRET_HEADER]: options.venueSecret },
    });
    assert.equal(
      displayed.status,
      200,
      `GET /v1/venue/check-in-code answered ${displayed.status}: ${displayed.body}`,
    );
    code = VenueCodeResponse.parse(displayed.json()).code;
  }
  const points = await readPoints(t.services.db, 'venue', [meetup.venueId], t.env.APP_ENV);
  const venue = points.get(meetup.venueId);
  assert.ok(venue !== undefined, 'the venue has no stored location to measure the geofence from');
  const at = offsetNorth(venue, options.distanceM ?? 20);
  const response = await callRoute(t.app, {
    method: 'POST',
    url: `/v1/meetups/${meetup.id}/check-in`,
    as: await t.tokenFor(user),
    body: { code, lat: at.lat, lng: at.lng },
  });
  assert.equal(
    response.status,
    200,
    `POST /v1/meetups/:id/check-in answered ${response.status}: ${response.body}`,
  );
  return CheckInResponse.parse(response.json());
}

/** What {@link signIn} may set. */
export interface SignInOptions {
  /** Record the 18+ confirmation and the terms version. Default true. */
  readonly consent?: boolean;
}

/** The account a magic-link sign-in produced. */
export interface SignInResult {
  readonly userId: string;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly user: VerifyResponse['user'];
}

export async function signIn(
  t: TestApp,
  email: string,
  options: SignInOptions = {},
): Promise<SignInResult> {
  const requested = await callRoute(t.app, {
    method: 'POST',
    url: '/v1/auth/magic-link',
    body: { email },
  });
  assert.equal(
    requested.status,
    202,
    `POST /v1/auth/magic-link answered ${requested.status}: ${requested.body}`,
  );
  const pending = await t.services.db.magicLinkToken.findFirst({
    where: { emailLookupHash: emailLookupHash(t.env.EMAIL_LOOKUP_PEPPER, email), usedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { deliveryTokenCiphertext: true },
  });
  const ciphertext = pending?.deliveryTokenCiphertext ?? null;
  assert.ok(
    ciphertext !== null,
    'the magic link holds no delivery token: the link was already sent, or the token expired',
  );
  const verified = await callRoute(t.app, {
    method: 'POST',
    url: '/v1/auth/verify',
    body: { token: decryptField(t.services.keyring, ciphertext) },
  });
  assert.equal(
    verified.status,
    200,
    `POST /v1/auth/verify answered ${verified.status}: ${verified.body}`,
  );
  const session = VerifyResponse.parse(verified.json());
  const claims = await verifyAccessToken(t.services, session.accessToken);
  if (options.consent !== false) {
    const consented = await callRoute(t.app, {
      method: 'POST',
      url: '/v1/me/consents',
      as: session.accessToken,
      body: { adult: true, termsVersion: t.env.TERMS_VERSION },
    });
    assert.equal(
      consented.status,
      200,
      `POST /v1/me/consents answered ${consented.status}: ${consented.body}`,
    );
  }
  return {
    userId: claims.sub,
    sessionId: claims.sid,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    user: session.user,
  };
}

/** One injected request. */
export interface RouteRequest {
  /** The HTTP method. */
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The path, with its query string already in it if it has one. */
  readonly url: string;
  /** Who the request is made as: a bearer token, or something carrying one. */
  readonly as?: string | { readonly accessToken: string };
  /** The JSON body, which needs no `content-type`: Fastify's inject sets it. */
  readonly body?: string | object;
  /** Extra headers, such as a console secret or a webhook signature. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Query parameters, appended to `url`. */
  readonly query?: Readonly<Record<string, string>>;
}

/** One injected answer, before it is parsed. */
export interface RouteResponse {
  readonly status: number;
  /** The body exactly as it was sent, which is what a signature assertion re-reads. */
  readonly body: string;
  readonly headers: Readonly<Record<string, string | string[] | number | undefined>>;
  /** The body parsed as JSON; the schema for it belongs to the caller. */
  json<T = unknown>(): T;
}

export async function callRoute(app: App, request: RouteRequest): Promise<RouteResponse> {
  const encoded = request.query === undefined ? '' : new URLSearchParams(request.query).toString();
  const url =
    encoded === ''
      ? request.url
      : `${request.url}${request.url.includes('?') ? '&' : '?'}${encoded}`;
  const headers: Record<string, string> = { ...request.headers };
  const bearer = typeof request.as === 'string' ? request.as : request.as?.accessToken;
  if (bearer !== undefined) {
    headers.authorization = `Bearer ${bearer}`;
  }
  const injected = await app.inject({
    method: request.method,
    url,
    headers,
    ...(request.body === undefined ? {} : { payload: request.body }),
  });
  return {
    status: injected.statusCode,
    body: injected.body,
    headers: injected.headers,
    json: <T>() => JSON.parse(injected.body) as T,
  };
}

export function expectError(
  response: RouteResponse,
  status: number,
  code: ErrorCode,
): ErrorEnvelope {
  assert.equal(
    response.status,
    status,
    `expected ${status} ${code}, received ${response.status}: ${response.body}`,
  );
  const parsed = ErrorEnvelope.safeParse(response.json());
  if (!parsed.success) {
    assert.fail(`the body is not the error envelope: ${response.body}`);
  }
  assert.equal(
    parsed.data.error.code,
    code,
    `expected ${code}, received ${parsed.data.error.code}`,
  );
  return parsed.data;
}

export function keysDeep(value: unknown): string[] {
  const paths = new Set<string>();
  collectKeys(value, '', paths);
  return [...paths].sort();
}

/** Add `value`'s leaf paths to `paths`, under `prefix`. */
function collectKeys(value: unknown, prefix: string, paths: Set<string>): void {
  if (Array.isArray(value)) {
    const items = value as readonly unknown[];
    for (const item of items) {
      collectKeys(item, `${prefix}[]`, paths);
    }
    if (items.length === 0 && prefix !== '') {
      paths.add(`${prefix}[]`);
    }
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
      collectKeys(child, prefix === '' ? name : `${prefix}.${name}`, paths);
    }
    return;
  }
  if (prefix !== '') {
    paths.add(prefix);
  }
}

export function rows<T>(table: readonly T[]): T[] {
  return [...table];
}

/** The two labels every recorded result is tagged with (AAP 0.12.1). */
export type StripeModeLabel = '[stripe:mock]' | '[stripe:test]';

export function stripeModeLabel(
  mode: 'mock' | 'test' = process.env['STRIPE_MODE'] === 'test' ? 'test' : 'mock',
): StripeModeLabel {
  return mode === 'test' ? '[stripe:test]' : '[stripe:mock]';
}
