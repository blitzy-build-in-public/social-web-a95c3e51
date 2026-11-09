/**
 * Integration tests for the operator routes and the additive `POST /v1/events`.
 *
 * Seven groups, in the order `admin/routes.ts` registers its routes: the guard every `/admin/*` route shares, the dashboard,
 * the dispute queue, the call-task queue, the lodging-claim queue with its audited booking-details read, the crawl-domain,
 * onboarding, report and client-event routes, and the operator's language-model re-enable. Every assertion reads what a handler
 * wrote, and every answer is parsed with the shared schema its route declares.
 *
 * No case moves the clock: an hour-sized jump would expire the 15-minute access token, and the two boundaries these routes
 * judge are reachable by placing a meetup's `startsAt` relative to the frozen instant.
 */
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Prisma } from '@tablemate/db';
import { LLM_COUNT_MISMATCHES_KEY, LLM_SUSPENDED_KEY, QUEUE } from '@tablemate/server-core';
import {
  CLAIM_EXPIRY_HOURS,
  DAY_MS,
  DISPUTE_RESOLUTION_DAYS,
  HOUR_MS,
  MINUTE_MS,
  AdminCallTaskDto,
  AdminCallTasksResponse,
  AdminCrawlDomainDto,
  AdminCrawlDomainsResponse,
  AdminDisputeDto,
  AdminDisputesResponse,
  AdminLlmSuspension,
  AdminLodgingClaimDto,
  AdminLodgingClaimsResponse,
  AdminLodgingDto,
  AdminLodgingsResponse,
  AdminReportsResponse,
  AdminVenueDto,
  AdminVenuesResponse,
  BookingDetailsDto,
  CitiesFile,
  CitiesResponse,
  MetricsDto,
  SecretIssued,
} from '@tablemate/shared';
import type {
  BlockedReason,
  CallTaskStatus,
  CheckInResult,
  CityConfig,
  DisputeOutcome,
  DisputeStatus,
  ErrorCode,
  LodgingClaimStatus,
  MeetupStatus,
  OperatorCallTaskOutcome,
  OperatorClaimOutcome,
} from '@tablemate/shared';

import { DEFAULT_TEST_NOW, createTestApp } from '../support/app.ts';
import {
  callRoute,
  expectError,
  keysDeep,
  makeCallAttempt,
  makeCallTask,
  makeCheckIn,
  makeClaim,
  makeDispute,
  makeLodging,
  makeMeetup,
  makePlace,
  makeUser,
  makeVenue,
  rows,
} from '../support/factories.ts';
import type {
  LodgingFixture,
  PlaceFixture,
  RouteRequest,
  RouteResponse,
  UserFixture,
  VenueFixture,
} from '../support/factories.ts';
import type { TestApp } from '../support/app.ts';

const CITIES_CONFIG_PATH = fileURLToPath(
  new URL('../../../../config/cities.json', import.meta.url),
);

/**
 * The launch cities as `config/cities.json` lists them, parsed by the contract's own schema: the same
 * file `GET /cities` answers in order, so a city added to the pilot changes what this suite expects.
 */
const LAUNCH_CITIES: readonly CityConfig[] = CitiesFile.parse(
  JSON.parse(readFileSync(CITIES_CONFIG_PATH, 'utf8')) as unknown,
).cities;

const LISBON = 'lisbon';
/** A second launch city, whose lodging exists only to prove a hand-entered row carries no OSM ids. */
const MEXICO_CITY = 'mexico-city';
const TODAY = DEFAULT_TEST_NOW.slice(0, 10);
/** A NUL byte between two letters: the one code point PostgreSQL's UTF-8 `text` cannot hold, so a text field carrying it is refused at the boundary rather than answered `500` by the insert. */
const NUL_TEXT = 'a\u0000b';

let t: TestApp;
/** The operator every `/admin/*` case acts as; no card, so no case places a hold for them. */
let operator: UserFixture;
let traveler: UserFixture;
let other: UserFixture;
let venue: VenueFixture;
let lodging: LodgingFixture;
let place: PlaceFixture;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.resetState();
  await t.seedCities();
  operator = await makeUser(t, { role: 'operator', card: 'none' });
  traveler = await makeUser(t);
  other = await makeUser(t);
  venue = await makeVenue(t, { cityId: LISBON });
  lodging = await makeLodging(t, { cityId: LISBON });
  place = await makePlace(t, { cityId: LISBON, category: 'restaurant' });
});

function instant(offsetMs: number): Date {
  return new Date(t.clock.now().getTime() + offsetMs);
}

function dayOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** A booking name unique to one case, generated at run time and never logged. */
function guestName(): string {
  return `Guest ${randomUUID().slice(0, 8)}`;
}

function asOperator(
  method: RouteRequest['method'],
  url: string,
  extra: { body?: Record<string, unknown>; query?: Record<string, string> } = {},
): Promise<RouteResponse> {
  return callRoute(t.app, { method, url, as: operator, ...extra });
}

async function metrics(query: Record<string, string> = {}): Promise<MetricsDto> {
  const response = await asOperator('GET', '/v1/admin/metrics', {
    query: { from: TODAY, to: TODAY, ...query },
  });
  expect(response.status, response.body).toBe(200);
  return MetricsDto.parse(response.json());
}

async function placeRefreshPayloads(): Promise<unknown[]> {
  const jobs = await t.services.queues
    .get(QUEUE.placeRefresh)
    .getJobs(['waiting', 'prioritized', 'delayed']);
  // BullMQ types a payload as `any`; the cast keeps the read out of the lint rules that ban touching
  // an `any` member, and the comparison is on the value itself.
  return jobs.map((job) => job.data as unknown);
}

interface AdminRouteCase {
  readonly name: string;
  readonly method: RouteRequest['method'];
  readonly url: () => string;
  readonly body?: Record<string, unknown>;
}

/**
 * Every route behind `role = operator`, the additive booking-details read included. The group guard runs as an `onRequest` hook,
 * before any parameter or body is validated, so the answer is the guard's whatever a caller sends.
 */
const ADMIN_ROUTES = rows<AdminRouteCase>([
  {
    name: 'the dashboard',
    method: 'GET',
    url: () => `/v1/admin/metrics?from=${TODAY}&to=${TODAY}`,
  },
  { name: 'the city catalogue', method: 'GET', url: () => '/v1/admin/cities' },
  { name: 'the dispute queue', method: 'GET', url: () => '/v1/admin/disputes' },
  {
    name: 'a dispute resolution',
    method: 'POST',
    url: () => `/v1/admin/disputes/${randomUUID()}/resolve`,
    body: { outcome: 'no_fault' },
  },
  { name: 'the call-task queue', method: 'GET', url: () => '/v1/admin/call-tasks' },
  {
    name: 'a call-task resolution',
    method: 'POST',
    url: () => `/v1/admin/call-tasks/${randomUUID()}/resolve`,
    body: { outcome: 'refused' },
  },
  { name: 'the lodging-claim queue', method: 'GET', url: () => '/v1/admin/lodging-claims' },
  {
    name: 'a lodging-claim resolution',
    method: 'POST',
    url: () => `/v1/admin/lodging-claims/${randomUUID()}/resolve`,
    body: { outcome: 'verified' },
  },
  {
    name: 'a claim of booking details',
    method: 'GET',
    url: () => `/v1/admin/lodging-claims/${randomUUID()}/booking-details`,
  },
  {
    name: 'the price-job trigger',
    method: 'POST',
    url: () => '/v1/admin/price-jobs',
    body: { cityId: LISBON, kind: 'menus' },
  },
  { name: 'the venue registry', method: 'GET', url: () => '/v1/admin/venues' },
  {
    name: 'venue onboarding',
    method: 'POST',
    url: () => '/v1/admin/venues',
    body: {
      cityId: LISBON,
      name: 'Fixture Onboarded Venue',
      address: '3 Fixture Street',
      lat: 38.71,
      lng: -9.14,
    },
  },
  {
    name: 'a venue edit',
    method: 'PATCH',
    url: () => `/v1/admin/venues/${randomUUID()}`,
    body: { isActivePartner: false },
  },
  {
    name: 'a venue console secret',
    method: 'POST',
    url: () => `/v1/admin/venues/${randomUUID()}/secret`,
  },
  { name: 'the lodging registry', method: 'GET', url: () => '/v1/admin/lodgings' },
  {
    name: 'lodging onboarding',
    method: 'POST',
    url: () => '/v1/admin/lodgings',
    body: {
      cityId: LISBON,
      name: 'Fixture Onboarded Lodging',
      kind: 'hostel',
      address: '4 Fixture Street',
      phone: null,
      lat: 38.71,
      lng: -9.14,
    },
  },
  {
    name: 'a lodging console secret',
    method: 'POST',
    url: () => `/v1/admin/lodgings/${randomUUID()}/secret`,
  },
  { name: 'the report queue', method: 'GET', url: () => '/v1/admin/reports' },
  { name: 'the crawl-domain queue', method: 'GET', url: () => '/v1/admin/crawl-domains' },
  {
    name: 'a crawl-domain decision',
    method: 'PATCH',
    url: () => '/v1/admin/crawl-domains/example.test',
    body: { decision: 'allowed' },
  },
]);

describe('the operator guard (AAP 0.5.4)', () => {
  it.each(ADMIN_ROUTES)('refuses $name to a traveler and to an anonymous caller', async (route) => {
    const url = route.url();
    const body = route.body === undefined ? {} : { body: route.body };
    // A traveler's own valid token: the guard reads the account's role from its row, so a token can
    // never claim a role the account does not hold (AAP 0.3.3).
    const asTraveler = await callRoute(t.app, { method: route.method, url, as: traveler, ...body });
    expectError(asTraveler, 403, 'operator_only');
    // No bearer at all: refused as a token failure, before any role is considered.
    const anonymous = await callRoute(t.app, { method: route.method, url, ...body });
    expectError(anonymous, 401, 'token_invalid');
  });

  it('admits the operator, so the guard is a filter rather than a wall', async () => {
    expect((await asOperator('GET', '/v1/admin/reports')).status).toBe(200);
    expect((await asOperator('GET', '/v1/admin/crawl-domains')).status).toBe(200);
  });
});

describe('the dashboard (AAP 0.5.4, 0.5.7)', () => {
  it('answers the operator the same city catalogue the age-gated route serves a traveler', async () => {
    // The operator area is entered by role alone and lies outside the age gate, so its own read of the
    // catalogue is what labels the dashboard's city filter and per-city rows, and the registry's city
    // selects (AAP 0.5.4). The two routes must answer one list, or the operator and the traveler would
    // number the same cities differently.
    const asOperatorCities = await asOperator('GET', '/v1/admin/cities');
    expect(asOperatorCities.status, asOperatorCities.body).toBe(200);
    const asTravelerCities = await callRoute(t.app, {
      method: 'GET',
      url: '/v1/cities',
      as: traveler,
    });
    expect(asTravelerCities.status, asTravelerCities.body).toBe(200);
    const operatorItems = CitiesResponse.parse(asOperatorCities.json()).items;
    expect(operatorItems.map((city) => city.id)).toEqual(LAUNCH_CITIES.map((city) => city.id));
    expect(operatorItems).toEqual(CitiesResponse.parse(asTravelerCities.json()).items);
  });

  it('counts a late cancellation as a no-show and as a late cancellation', async () => {
    // A meetup starting in half an hour is already inside the two-hour free-cancellation window, so
    // the recipient's cancellation is late and the canceller is the absent party (AAP 0.5.3, 0.5.7).
    const meetup = await makeMeetup(t, {
      status: 'locked',
      initiator: traveler,
      recipient: other,
      venue,
      startsAt: instant(30 * MINUTE_MS),
    });
    const cancelled = await callRoute(t.app, {
      method: 'POST',
      url: `/v1/meetups/${meetup.id}/cancel`,
      as: other,
    });
    expect(cancelled.status, cancelled.body).toBe(200);
    expect(cancelled.json<{ lateCancel: boolean }>().lateCancel).toBe(true);
    const dashboard = await metrics();
    expect(dashboard.counts.noShows).toBe(1);
    expect(dashboard.counts.cancelledLate).toBe(1);
    expect(dashboard.counts.cancelledEarly).toBe(0);
    // The rate's terms are `lockedAt` and the check-ins, never the status: the forfeit leaves the
    // denominator standing, so the rate is a real zero rather than null.
    expect(dashboard.completion.lockedMeetups).toBe(1);
    expect(dashboard.completion.bothCheckedIn).toBe(0);
    expect(dashboard.completion.rate).toBe(0);
  });

  it('ranges every meetup measure on startsAt', async () => {
    await makeMeetup(t, { status: 'cancelled', initiator: traveler, recipient: other, venue });
    const outside = await makeMeetup(t, {
      status: 'cancelled',
      initiator: traveler,
      recipient: other,
      venue,
      startsAt: instant(-5 * DAY_MS),
    });
    // The meetup meant for today counts in today's range and the one from five days ago does not: a
    // range applied to `settledAt` or to a creation instant would count both (AAP 0.5.7).
    expect((await metrics()).counts.cancelledEarly).toBe(1);
    expect((await metrics({ from: dayOf(outside.startsAt) })).counts.cancelledEarly).toBe(2);
  });

  it('attributes each meetup to one variant pairing and filters on it', async () => {
    const socialA = await makeUser(t, { variant: 'social', card: 'none' });
    const socialB = await makeUser(t, { variant: 'social', card: 'none' });
    const punitive = await makeUser(t, { variant: 'punitive', card: 'none' });
    await makeMeetup(t, { status: 'cancelled', initiator: socialA, recipient: socialB, venue });
    await makeMeetup(t, { status: 'cancelled', initiator: socialA, recipient: punitive, venue });
    expect((await metrics()).counts.cancelledEarly).toBe(2);
    expect((await metrics({ variant: 'social' })).counts.cancelledEarly).toBe(1);
    expect((await metrics({ variant: 'mixed' })).counts.cancelledEarly).toBe(1);
    expect((await metrics({ variant: 'punitive' })).counts.cancelledEarly).toBe(0);
  });

  it('reports signups from the account_created events, ranged on their own instant', async () => {
    await t.services.db.analyticsEvent.createMany({
      data: [
        { name: 'account_created', occurredAt: t.clock.now() },
        { name: 'account_created', occurredAt: t.clock.now() },
        { name: 'account_created', occurredAt: instant(-30 * DAY_MS) },
      ],
    });
    // A signup belongs to no city and no pairing, so neither filter reaches the figure, and its range
    // falls on `occurred_at` rather than on a meetup's `starts_at` — which is why the thirty-day-old
    // event is left out of a one-day range (AAP 0.5.7).
    expect((await metrics()).signups).toBe(2);
    expect((await metrics({ cityId: MEXICO_CITY, variant: 'punitive' })).signups).toBe(2);
  });

  it.each(
    rows<{
      readonly filter: string;
      readonly query: Record<string, string>;
      readonly opened: number;
      readonly signups: number;
    }>([
      { filter: 'no filter', query: {}, opened: 2, signups: 1 },
      {
        filter: 'a city filter, which narrows places opened alone',
        query: { cityId: LISBON },
        opened: 1,
        signups: 1,
      },
      {
        filter: 'a variant filter, which reaches neither measure',
        query: { variant: 'punitive' },
        opened: 2,
        signups: 1,
      },
    ]),
  )('answers places opened and signups under $filter', async (row) => {
    await t.services.db.analyticsEvent.createMany({
      data: [
        { name: 'suggestion_place_opened', cityId: LISBON, occurredAt: t.clock.now() },
        { name: 'suggestion_place_opened', cityId: MEXICO_CITY, occurredAt: t.clock.now() },
        { name: 'account_created', occurredAt: t.clock.now() },
      ],
    });
    // One aggregate answers both measures without either filter crossing to the other: the city
    // narrows the place openings alone, because an account is created in no city, and the variant
    // reaches neither, because a client-reported opening carries no pairing (AAP 0.5.7).
    const dashboard = await metrics(row.query);
    expect(dashboard.prices.placesOpened).toBe(row.opened);
    expect(dashboard.signups).toBe(row.signups);
  });

  it.each(
    rows<{ readonly name: string; readonly query: Record<string, string> }>([
      { name: 'a missing range', query: { to: TODAY } },
      { name: 'a from that is not a date', query: { from: 'yesterday', to: TODAY } },
      { name: 'a reversed range', query: { from: TODAY, to: '2026-11-01' } },
    ]),
  )('refuses $name with 400 invalid_field', async (row) => {
    const response = await asOperator('GET', '/v1/admin/metrics', { query: row.query });
    expectError(response, 400, 'invalid_field');
  });
});

describe('the dispute queue (AAP 0.5.3, 0.5.4)', () => {
  const disputesUrl = '/v1/admin/disputes';
  const resolveDisputeUrl = (id: string): string => `${disputesUrl}/${id}/resolve`;
  it('lists the open disputes first, flags an overdue one and shows both check-ins', async () => {
    const locked = await makeMeetup(t, {
      status: 'locked',
      initiator: traveler,
      recipient: other,
      venue,
    });
    const overdue = await makeDispute(t, locked, traveler, {
      kind: 'venue_unavailable',
      openedAt: instant(-6 * DAY_MS),
    });
    await makeCheckIn(t, locked, traveler, { result: 'pass' });
    await makeCheckIn(t, locked, other, { result: 'fail' });
    const resolved = await makeDispute(t, locked, other, {
      status: 'resolved',
      outcome: 'settle_by_checkins',
    });
    const response = await asOperator('GET', disputesUrl);
    expect(response.status, response.body).toBe(200);
    const queue = AdminDisputesResponse.parse(response.json());
    expect(queue.items.map((item) => item.status)).toEqual(['open', 'resolved']);
    // The open group comes first, nearest deadline first: it is the operator's work, and the resolved
    // one behind it is context for judging a fresh filing.
    const [open] = queue.items;
    expect(open?.id).toBe(overdue.id);
    expect(open?.kind).toBe('venue_unavailable');
    expect(open?.deadlineAt).toBe(
      new Date(overdue.openedAt.getTime() + DISPUTE_RESOLUTION_DAYS * DAY_MS).toISOString(),
    );
    // Six days after filing, the five-day deadline has passed, so the escalation flag is set.
    expect(open?.overdue).toBe(true);
    // Both participants, initiator first, with what each of them did at the venue: absent is not the
    // same as failed, and an operator settles on exactly this pair (AAP 0.5.7).
    expect(open?.checkIns).toEqual([
      { handle: traveler.handle, result: 'pass' },
      { handle: other.handle, result: 'fail' },
    ]);
    const [, closed] = queue.items;
    expect(closed?.id).toBe(resolved.id);
    expect(closed?.overdue).toBe(false);
  });

  const resolutionRows = rows<{
    readonly name: string;
    readonly outcome: DisputeOutcome;
    readonly startsAtOffsetMs: number;
    readonly checkIns?: { readonly initiator: CheckInResult; readonly recipient: CheckInResult };
    readonly expectedMeetup: MeetupStatus;
  }>([
    {
      name: 'settle_by_checkins on a locked meetup whose window has closed',
      outcome: 'settle_by_checkins',
      startsAtOffsetMs: -HOUR_MS,
      checkIns: { initiator: 'pass', recipient: 'pass' },
      expectedMeetup: 'completed',
    },
    {
      name: 'no_fault on a locked meetup',
      outcome: 'no_fault',
      startsAtOffsetMs: 30 * MINUTE_MS,
      expectedMeetup: 'no_fault',
    },
  ]);
  it.each(resolutionRows)('resolves with $name', async (row) => {
    const meetup = await makeMeetup(t, {
      status: 'locked',
      initiator: traveler,
      recipient: other,
      venue,
      startsAt: instant(row.startsAtOffsetMs),
      ...(row.checkIns === undefined ? {} : { checkIns: row.checkIns }),
    });
    const dispute = await makeDispute(t, meetup, traveler);
    const response = await asOperator('POST', resolveDisputeUrl(dispute.id), {
      body: { outcome: row.outcome },
    });
    expect(response.status, response.body).toBe(200);
    expect(AdminDisputeDto.parse(response.json()).status).toBe('resolved');
    // Both holds are decided by one `release` operation each, planned in the resolution's own
    // transaction and carried out after the commit, never inside it (AAP 0.3.2).
    const stored = await t.services.db.meetup.findUniqueOrThrow({
      where: { id: meetup.id },
      select: { status: true },
    });
    expect(stored.status).toBe(row.expectedMeetup);
    const releases = await t.services.db.paymentOperation.count({
      where: { deposit: { meetupId: meetup.id }, kind: 'release' },
    });
    expect(releases).toBe(2);
  });

  it.each(
    rows<{
      readonly name: string;
      readonly outcome: string;
      readonly meetupStatus?: MeetupStatus;
      readonly disputeStatus?: DisputeStatus;
      readonly httpStatus?: number;
      readonly code?: ErrorCode;
    }>([
      { name: 'an outcome outside the two', outcome: 'refund', meetupStatus: 'locked' },
      {
        name: 'a dispute that is already resolved',
        outcome: 'no_fault',
        meetupStatus: 'locked',
        disputeStatus: 'resolved',
      },
      { name: 'no_fault on a completed meetup', outcome: 'no_fault', meetupStatus: 'completed' },
      { name: 'an unknown dispute', outcome: 'no_fault', httpStatus: 404, code: 'not_found' },
    ]),
  )('refuses $name', async (row) => {
    const meetup =
      row.meetupStatus === undefined
        ? null
        : await makeMeetup(t, {
            status: row.meetupStatus,
            initiator: traveler,
            recipient: other,
            venue,
          });
    const dispute =
      meetup === null
        ? null
        : await makeDispute(t, meetup, traveler, { status: row.disputeStatus ?? 'open' });
    const response = await asOperator('POST', resolveDisputeUrl(dispute?.id ?? randomUUID()), {
      body: { outcome: row.outcome },
    });
    expectError(response, row.httpStatus ?? 422, row.code ?? 'invalid_outcome');
    // A refused resolution changes nothing: a dispute stands exactly as the case seeded it.
    if (dispute !== null) {
      const stored = await t.services.db.dispute.findUniqueOrThrow({
        where: { id: dispute.id },
        select: { status: true },
      });
      expect(stored.status).toBe(row.disputeStatus ?? 'open');
    }
  });
});

/**
 * A menu extraction in the shape the relay records it: a list of slot-tagged items, which `admin/call-tasks.ts` flattens into the
 * `<slot>.<field>` record the operator's form reads.
 */
const MENU_EXTRACTION = {
  kind: 'menu_prices',
  items: [
    {
      slot: 'cheapest_main',
      dish: 'Bacalhau à Brás',
      priceText: '$12.50',
      amountMinor: 1250,
      currency: 'USD',
      confirmed: true,
    },
    {
      slot: 'coffee',
      dish: 'Bica',
      priceText: '$1.20',
      amountMinor: 120,
      currency: 'USD',
      confirmed: false,
    },
  ],
} as const;

/**
 * The prices an operator is told over the phone: a main course, a non-alcoholic drink, and one standard per-person ticket — the
 * one category whose two extra fields the contract requires, because only a standard per-person ticket prices an activity.
 */
const OPERATOR_PRICES = [
  {
    name: 'Bacalhau à Brás',
    category: 'main',
    priceText: '$12.50',
    currency: 'USD',
    alcoholic: null,
    perPerson: null,
    ticketType: null,
    localAmountMinor: 1250,
  },
  {
    name: 'Bica',
    category: 'drink',
    priceText: '$1.20',
    currency: 'USD',
    alcoholic: false,
    perPerson: null,
    ticketType: null,
    localAmountMinor: 120,
  },
  {
    name: 'Museum entry',
    category: 'ticket',
    priceText: '$9.00',
    currency: 'USD',
    alcoholic: null,
    perPerson: true,
    ticketType: 'standard',
    localAmountMinor: 900,
  },
];

/**
 * One price an operator enters, with the two free-text fields left to the row that supplies them: a `main` item whose
 * two ticket fields are both null, which is what the ticket rule admits (AAP 0.5.6).
 */
function operatorPriceEntry(name: string, priceText: string): Record<string, unknown> {
  return {
    name,
    category: 'main',
    priceText,
    currency: 'USD',
    alcoholic: null,
    perPerson: null,
    ticketType: null,
    localAmountMinor: 1250,
  };
}

/**
 * An operator's price holding a NUL byte in one of its two free-text fields, one row per field: the byte passes a bare
 * `z.string()` and PostgreSQL refuses the insert with SQLSTATE 22021, so `400 invalid_field` at the boundary is what
 * the caller is owed instead of a `500` from the batch insert (AAP 0.11.2).
 */
const NUL_OPERATOR_PRICE_ROWS = rows<{
  readonly name: string;
  readonly prices: readonly Record<string, unknown>[];
}>([
  { name: 'a price name', prices: [operatorPriceEntry(NUL_TEXT, '$12.50')] },
  { name: 'a price text', prices: [operatorPriceEntry('Bacalhau à Brás', NUL_TEXT)] },
]);

/**
 * Write one attempt's extraction, which the builder's own option does not admit: it types the payload as a flat record of scalars,
 * while a menu call's extraction is a list of items.
 */
function setExtraction(attemptId: string, payload: unknown): Promise<unknown> {
  return t.services.db.callAttempt.update({
    where: { id: attemptId },
    data: { extractedFields: payload as Prisma.InputJsonValue },
  });
}

function menuTask(status: CallTaskStatus): Promise<{ id: string }> {
  return makeCallTask(t, { kind: 'menu_prices', placeId: place.id, status });
}

/**
 * A menu-price call task on the fixture place that is carrying the `blockedReason` its own dial hit: the state from which an
 * operator resolves it by hand.
 */
function blockedMenuTask(
  status: CallTaskStatus,
  blockedReason: BlockedReason,
): Promise<{ id: string }> {
  return makeCallTask(t, { kind: 'menu_prices', placeId: place.id, status, blockedReason });
}

function resolveTask(taskId: string, body: Record<string, unknown>): Promise<RouteResponse> {
  return asOperator('POST', `/v1/admin/call-tasks/${taskId}/resolve`, { body });
}

async function callTasks(query: Record<string, string> = {}): Promise<AdminCallTasksResponse> {
  const response = await asOperator('GET', '/v1/admin/call-tasks', { query });
  expect(response.status, response.body).toBe(200);
  return AdminCallTasksResponse.parse(response.json());
}

/**
 * Queue one menu task per entry for a paging case, at the outcome instant that entry names: entries sharing one instant exercise
 * the id tie-break, and `null` is a task with no outcome yet, which the queue's order places last.
 */
async function queuedTasks(outcomeAts: readonly (Date | null)[]): Promise<string[]> {
  const ids: string[] = [];
  for (const outcomeAt of outcomeAts) {
    const task = await makeCallTask(t, {
      kind: 'menu_prices',
      placeId: place.id,
      status: 'needs_review',
      ...(outcomeAt === null ? {} : { outcomeAt }),
    });
    ids.push(task.id);
  }
  return ids;
}

interface QueueIds {
  readonly review: string;
  readonly unreachable: string;
  readonly verification: string;
}

/**
 * The queue the filter cases narrow: two menu tasks on the fixture place — one awaiting review, one unreachable for want of a
 * number — and a lodging verification an operator also has to act on.
 */
async function filteringQueue(): Promise<QueueIds> {
  const review = await makeCallTask(t, {
    kind: 'menu_prices',
    placeId: place.id,
    status: 'needs_review',
    outcomeAt: instant(-HOUR_MS),
  });
  const unreachable = await makeCallTask(t, {
    kind: 'menu_prices',
    placeId: place.id,
    status: 'unreachable',
    blockedReason: 'no_phone',
  });
  const verification = await makeCallTask(t, {
    kind: 'lodging_stay_verification',
    lodgingId: lodging.id,
    status: 'needs_review',
  });
  return { review: review.id, unreachable: unreachable.id, verification: verification.id };
}

/**
 * One filter over that same three-task queue: the query it sends and the rows that must come back. The name filter is typed in
 * lower case although every fixture name begins "Fixture", which is what makes the row prove the match is case-insensitive.
 */
const QUEUE_FILTERS = rows<{
  readonly name: string;
  readonly query: (ids: QueueIds) => Record<string, string>;
  readonly expected: (ids: QueueIds) => readonly string[];
}>([
  {
    name: 'the status an operator still has to resolve',
    query: () => ({ status: 'unreachable' }),
    expected: (ids) => [ids.unreachable],
  },
  {
    name: 'the task kind',
    query: () => ({ kind: 'lodging_stay_verification' }),
    expected: (ids) => [ids.verification],
  },
  {
    name: "the target's name, in whatever case it is typed",
    query: () => ({ q: place.name.toLowerCase() }),
    expected: (ids) => [ids.review, ids.unreachable],
  },
]);

function cursorShaped(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Queries the read refuses before it runs: a cursor the codec cannot read, a page size outside the contract's own bound, and a
 * parameter the queue does not carry, which its strict schema answers rather than ignoring.
 */
const QUEUE_BAD_QUERIES = rows<{ readonly name: string; readonly query: Record<string, string> }>([
  { name: 'a cursor that is not the position a page ended on', query: { cursor: 'not-a-cursor' } },
  {
    name: 'a cursor whose instant is not the one this queue writes',
    query: { cursor: cursorShaped({ t: `${TODAY}T00:00:00.000Z`, i: randomUUID() }) },
  },
  {
    name: 'a cursor whose id is not an id',
    query: { cursor: cursorShaped({ t: null, i: 'nope' }) },
  },
  { name: 'a page size above the one the contract allows', query: { limit: '501' } },
  { name: 'a parameter the queue does not carry', query: { page: '2' } },
  { name: 'a search term holding a NUL byte', query: { q: NUL_TEXT } },
]);

/**
 * One operator resolution of a task that was carrying a `blockedReason`: the status it waits in, the reason its own dial hit, the
 * outcome the operator records, and the body that outcome needs.
 *
 * Three rows pair the reason with the status the lifecycle gives it — a dispatch that could not be reconciled and a vendor that
 * ran out of retries wait in `needs_review`, an invalid number is `unreachable` — so the case proves the clearing from both
 * statuses an operator resolves from.
 */
const BLOCKED_RESOLUTIONS = rows<{
  readonly name: string;
  readonly status: CallTaskStatus;
  readonly blockedReason: BlockedReason;
  readonly outcome: OperatorCallTaskOutcome;
  readonly body: Record<string, unknown>;
}>([
  {
    name: 'completed',
    status: 'needs_review',
    blockedReason: 'dispatch_unknown',
    outcome: 'completed',
    body: { outcome: 'completed', prices: OPERATOR_PRICES },
  },
  {
    name: 'refused',
    status: 'needs_review',
    blockedReason: 'vendor_unavailable',
    outcome: 'refused',
    body: { outcome: 'refused' },
  },
  {
    name: 'do_not_call',
    status: 'unreachable',
    blockedReason: 'not_allowlisted',
    outcome: 'do_not_call',
    body: { outcome: 'do_not_call' },
  },
  {
    name: 'unreachable',
    status: 'unreachable',
    blockedReason: 'invalid_number',
    outcome: 'unreachable',
    body: { outcome: 'unreachable' },
  },
]);

describe('the call-task queue (AAP 0.5.3, 0.5.4)', () => {
  it('lists the tasks an operator still has to act on, and nothing of a booking', async () => {
    const name = guestName();
    const review = await makeCallTask(t, {
      kind: 'menu_prices',
      placeId: place.id,
      status: 'needs_review',
      outcomeAt: instant(-HOUR_MS),
    });
    const attempt = await makeCallAttempt(t, review, {
      state: 'ended',
      outcome: 'needs_review',
      summary: 'Two prices read back',
    });
    await setExtraction(attempt.id, MENU_EXTRACTION);
    // Neither of the next two belongs in the queue: a task whose call has not run yet, and one an
    // operator already resolved, which is out of the queue however it stands (AAP 0.5.3).
    const waiting = await menuTask('queued');
    const alreadyResolved = await menuTask('needs_review');
    await t.services.db.callTask.update({
      where: { id: alreadyResolved.id },
      data: { resolvedBy: 'operator' },
    });
    const claim = await makeClaim(t, other, lodging, { bookingName: name });
    const verification = await makeCallTask(t, {
      kind: 'lodging_stay_verification',
      lodgingId: lodging.id,
      lodgingClaimId: claim.id,
      status: 'unreachable',
      blockedReason: 'no_phone',
    });
    const response = await asOperator('GET', '/v1/admin/call-tasks');
    expect(response.status, response.body).toBe(200);
    const queue = AdminCallTasksResponse.parse(response.json());
    const ids = queue.items.map((item) => item.id);
    expect(ids).toContain(review.id);
    expect(ids).toContain(verification.id);
    expect(ids).not.toContain(waiting.id);
    expect(ids).not.toContain(alreadyResolved.id);
    // A menu task carries the values its call extracted, flattened slot by slot, so the operator
    // approves or corrects a price rather than transcribing one (AAP 0.5.4).
    expect(queue.items.find((item) => item.id === review.id)?.extractedFields).toEqual({
      'cheapest_main.dish': 'Bacalhau à Brás',
      'cheapest_main.priceText': '$12.50',
      'cheapest_main.amountMinor': 1250,
      'cheapest_main.currency': 'USD',
      'cheapest_main.confirmed': true,
      'coffee.dish': 'Bica',
      'coffee.priceText': '$1.20',
      'coffee.amountMinor': 120,
      'coffee.currency': 'USD',
      'coffee.confirmed': false,
    });
    // A verification task is listed, because an operator must see it waiting, but it carries no
    // extraction and no summary: a lodging call's content does not outlive its claim (AAP 0.5.2).
    const lodgingTask = queue.items.find((item) => item.id === verification.id);
    expect(lodgingTask?.kind).toBe('lodging_stay_verification');
    expect(lodgingTask?.targetName).toBe(lodging.name);
    expect(lodgingTask?.cityId).toBe(LISBON);
    expect(lodgingTask?.extractedFields).toBeNull();
    expect(lodgingTask?.lastSummary).toBeNull();
    expect(lodgingTask?.blockedReason).toBe('no_phone');
    expect(response.body).not.toContain(name);
  });

  it('answers exactly the page its limit names, and says another page follows', async () => {
    const ids = await queuedTasks([instant(-HOUR_MS), null, null]);
    const page = await callTasks({ limit: '2' });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(ids.length);
    expect(page.nextCursor).not.toBeNull();
  });

  it('walks the whole queue by its cursor, with no duplicate and no omission', async () => {
    const at = instant(-HOUR_MS);
    const ids = await queuedTasks([at, at, null, null, null]);
    const whole = await callTasks({ limit: String(ids.length) });
    const seen: string[] = [];
    let cursor: string | null = null;
    // One iteration per page and one more, so a cursor that never ends fails on the loop's own bound
    // rather than hanging.
    for (let page = 0; page <= ids.length; page += 1) {
      const answer = await callTasks(cursor === null ? { limit: '2' } : { limit: '2', cursor });
      seen.push(...answer.items.map((item) => item.id));
      cursor = answer.nextCursor;
      if (cursor === null) break;
    }
    // The queue read whole is the yardstick: two rows at a time must reproduce it row for row, so a
    // cursor that skipped, repeated or reordered a row fails here, and the walk ends on a null cursor
    // (AAP 0.5.4).
    expect(seen).toEqual(whole.items.map((item) => item.id));
    expect(new Set(seen).size).toBe(ids.length);
    expect(whole.nextCursor).toBeNull();
    expect(cursor).toBeNull();
  });

  it('counts the whole filtered queue while the page holds one of its rows', async () => {
    const ids = await filteringQueue();
    const page = await callTasks({ status: 'needs_review', limit: '1' });
    // The count names both tasks the status matches and the page carries the first of them, so an
    // operator reads how much of the queue is still behind the control (AAP 0.5.4).
    expect(page.items.map((item) => item.id)).toEqual([ids.review]);
    expect(page.total).toBe(2);
    expect(page.nextCursor).not.toBeNull();
  });

  it.each(QUEUE_FILTERS)('narrows the queue by $name', async (row) => {
    const ids = await filteringQueue();
    const expected = row.expected(ids);
    const answer = await callTasks(row.query(ids));
    expect(answer.total).toBe(expected.length);
    expect(answer.items.map((item) => item.id).sort()).toEqual([...expected].sort());
  });

  it.each(QUEUE_BAD_QUERIES)('refuses $name with 400 invalid_field', async (row) => {
    const response = await asOperator('GET', '/v1/admin/call-tasks', { query: row.query });
    expectError(response, 400, 'invalid_field');
  });

  it('stores the prices an operator was told as one operator_entry batch', async () => {
    const task = await menuTask('needs_review');
    const response = await resolveTask(task.id, { outcome: 'completed', prices: OPERATOR_PRICES });
    expect(response.status, response.body).toBe(200);
    expect(AdminCallTaskDto.parse(response.json()).status).toBe('completed');
    // The DTO carries neither fact, and both are what makes the task terminal: read them off the row.
    const stored = await t.services.db.callTask.findUniqueOrThrow({
      where: { id: task.id },
      select: { outcomeAt: true, resolvedBy: true },
    });
    expect(stored.resolvedBy).toBe('operator');
    expect(stored.outcomeAt?.toISOString()).toBe(t.clock.now().toISOString());
    const records = await t.services.db.priceRecord.findMany({
      where: { placeId: place.id },
      select: {
        captureBatchId: true,
        itemCategory: true,
        itemName: true,
        normalizedName: true,
        perPerson: true,
        priceUsdCents: true,
        reviewStatus: true,
        source: true,
        sourceUrl: true,
        ticketType: true,
      },
    });
    expect(records).toHaveLength(OPERATOR_PRICES.length);
    // One call is one capture batch, and the operator is the review, so every row is approved as it
    // is stored, attributed to the number that was called (AAP 0.5.6).
    expect(new Set(records.map((record) => record.captureBatchId)).size).toBe(1);
    for (const record of records) {
      expect(record.source).toBe('operator_entry');
      expect(record.reviewStatus).toBe('approved');
      expect(record.sourceUrl).toBe(`tel:${place.phone}`);
    }
    // The amounts are the cents the operator entered, under the names the estimate groups by, and the
    // ticket keeps the two fields that let an activity be priced at all (AAP 0.5.6, 0.5.7).
    const main = records.find((record) => record.itemCategory === 'main');
    expect(main?.priceUsdCents).toBe(1250);
    expect(main?.normalizedName).toBe('bacalhau à brás');
    const ticket = records.find((record) => record.itemCategory === 'ticket');
    expect(ticket?.itemName).toBe('Museum entry');
    expect(ticket?.perPerson).toBe(true);
    expect(ticket?.ticketType).toBe('standard');
    expect(ticket?.priceUsdCents).toBe(900);
    for (const record of records.filter((candidate) => candidate.itemCategory !== 'ticket')) {
      expect(record.perPerson).toBeNull();
      expect(record.ticketType).toBeNull();
    }
  });

  /** The prices an operator reads out in a city that does not price in USD (AAP 0.5.6). */
  const MXN_PRICE = {
    name: 'Tacos al pastor',
    category: 'main',
    priceText: '$85',
    currency: 'MXN',
    alcoholic: null,
    perPerson: null,
    ticketType: null,
    localAmountMinor: 8500,
  } as const;
  /** The rate the conversion cases store: 0.05 USD a peso, so 8,500 minor units are 425 cents. */
  const MXN_USD_PER_UNIT = '0.05';
  const MXN_USD_CENTS = 425;
  /**
   * A non-USD price entry before and after the FX table holds a rate for its currency (AAP 0.5.6): `rateDaysBefore` is how many
   * days before the capture day the case's one `FxRate` row belongs to, so the conversion has to take the latest rate at or
   * before that day; `code` is the code the answer carries, or `null` for the row whose entry is stored.
   */
  const FX_RESOLUTIONS = rows<{
    readonly name: string;
    readonly rateDaysBefore: number | null;
    readonly httpStatus: number;
    readonly code: ErrorCode | null;
  }>([
    {
      name: 'a currency the table has no rate for',
      rateDaysBefore: null,
      httpStatus: 503,
      code: 'fx_rate_unavailable',
    },
    {
      name: 'a rate at or before the capture day',
      rateDaysBefore: 2,
      httpStatus: 200,
      code: null,
    },
  ]);
  it.each(FX_RESOLUTIONS)('answers a non-USD price with $name', async (row) => {
    const rateDay =
      row.rateDaysBefore === null
        ? null
        : `${dayOf(instant(-row.rateDaysBefore * DAY_MS))}T00:00:00.000Z`;
    if (rateDay !== null) {
      await t.services.db.fxRate.create({
        data: {
          currency: MXN_PRICE.currency,
          date: new Date(rateDay),
          usdPerUnit: MXN_USD_PER_UNIT,
        },
      });
    }
    const task = await menuTask('needs_review');
    const response = await resolveTask(task.id, { outcome: 'completed', prices: [MXN_PRICE] });
    expect(response.status, response.body).toBe(row.httpStatus);
    const stored = await t.services.db.callTask.findUniqueOrThrow({
      where: { id: task.id },
      select: { outcomeAt: true, resolvedBy: true, status: true },
    });
    const records = await t.services.db.priceRecord.findMany({
      where: { placeId: place.id },
      select: {
        currency: true,
        fxDate: true,
        localAmountMinor: true,
        priceUsdCents: true,
        source: true,
      },
    });
    if (row.code === null) {
      // The conversion runs on the capture day's own rate, and the stored row keeps that rate's date,
      // which is what `fx_date` records (AAP 0.5.6).
      expect(AdminCallTaskDto.parse(response.json()).status).toBe('completed');
      expect(stored.status).toBe('completed');
      expect(stored.resolvedBy).toBe('operator');
      expect(records).toHaveLength(1);
      const [record] = records;
      expect(record?.source).toBe('operator_entry');
      expect(record?.currency).toBe(MXN_PRICE.currency);
      expect(record?.localAmountMinor).toBe(MXN_PRICE.localAmountMinor);
      expect(record?.priceUsdCents).toBe(MXN_USD_CENTS);
      expect(record?.fxDate?.toISOString()).toBe(rateDay);
    } else {
      // A currency the table cannot price yet is the conversion's own dependency, so the entry is
      // answered with the code that names it, and the message names the currency the operator has to
      // price in USD instead, rather than `422 invalid_outcome`, which AAP 0.5.4 reserves for an
      // outcome or a transition the call-task lifecycle refuses (AAP 0.5.4, 0.5.6). Nothing is
      // stored and the task stays in the queue, so the identical entry succeeds once a rate exists.
      const envelope = expectError(response, row.httpStatus, row.code);
      expect(envelope.error.message).toContain(MXN_PRICE.currency);
      expect(stored.status).toBe('needs_review');
      expect(stored.resolvedBy).toBeNull();
      expect(stored.outcomeAt).toBeNull();
      expect(records).toHaveLength(0);
    }
    // The rate this case wrote is deleted with it: the table is another case's input too, and the one
    // that has to answer 503 needs it empty.
    await t.services.db.fxRate.deleteMany({ where: { currency: MXN_PRICE.currency } });
  });

  it.each(
    rows<{ readonly name: string; readonly outcome: OperatorCallTaskOutcome }>([
      { name: 'refused', outcome: 'refused' },
      { name: 'unreachable', outcome: 'unreachable' },
    ]),
  )('records $name on the task and stores no price', async (row) => {
    const task = await menuTask('needs_review');
    const response = await resolveTask(task.id, { outcome: row.outcome });
    expect(response.status, response.body).toBe(200);
    expect(AdminCallTaskDto.parse(response.json()).status).toBe(row.outcome);
    const stored = await t.services.db.callTask.findUniqueOrThrow({
      where: { id: task.id },
      select: { resolvedBy: true },
    });
    expect(stored.resolvedBy).toBe('operator');
    expect(await t.services.db.priceRecord.count({ where: { placeId: place.id } })).toBe(0);
  });

  it.each(
    rows<{
      readonly name: string;
      readonly outcome: OperatorCallTaskOutcome;
      readonly status: CallTaskStatus;
    }>([
      // One task in each status the queue still holds, the `unreachable` one being the state the
      // queue reader actually acts on, so the refusal is shown to be the request schema's rather
      // than a state the task stands in (AAP 0.5.3, 0.5.4).
      { name: 'refused', outcome: 'refused', status: 'unreachable' },
      { name: 'do_not_call', outcome: 'do_not_call', status: 'needs_review' },
      { name: 'unreachable', outcome: 'unreachable', status: 'needs_review' },
    ]),
  )('refuses prices supplied with $name rather than dropping them', async (row) => {
    const task = await menuTask(row.status);
    const response = await resolveTask(task.id, { outcome: row.outcome, prices: OPERATOR_PRICES });
    // The refusal is the request schema's, so the resolution never ran: prices the operator's entry
    // form sent with an outcome that stores nothing are answered rather than accepted and discarded
    // (AAP 0.5.3, 0.5.4). The task is untouched — still in the queue, with no resolver and no outcome
    // instant — nothing was written for its place, and no side effect of the outcome was applied.
    expectError(response, 400, 'invalid_field');
    const stored = await t.services.db.callTask.findUniqueOrThrow({
      where: { id: task.id },
      select: { outcomeAt: true, resolvedBy: true, status: true },
    });
    expect(stored.status).toBe(row.status);
    expect(stored.resolvedBy).toBeNull();
    expect(stored.outcomeAt).toBeNull();
    expect(await t.services.db.priceRecord.count({ where: { placeId: place.id } })).toBe(0);
    const target = await t.services.db.place.findUniqueOrThrow({
      where: { id: place.id },
      select: { doNotCall: true },
    });
    expect(target.doNotCall).toBe(false);
  });

  it.each(NUL_OPERATOR_PRICE_ROWS)(
    'refuses $name holding a NUL byte with 400 invalid_field',
    async (row) => {
      const task = await menuTask('needs_review');
      const response = await resolveTask(task.id, { outcome: 'completed', prices: row.prices });
      // The refusal is the entry's own schema, so the resolution never ran: the task keeps the status
      // it was queued in, with no resolver and no outcome instant, and the batch insert it would have
      // made never happens, so nothing is stored for the task's place (AAP 0.11.2, 0.5.4).
      expectError(response, 400, 'invalid_field');
      const stored = await t.services.db.callTask.findUniqueOrThrow({
        where: { id: task.id },
        select: { outcomeAt: true, resolvedBy: true, status: true },
      });
      expect(stored.status).toBe('needs_review');
      expect(stored.resolvedBy).toBeNull();
      expect(stored.outcomeAt).toBeNull();
      expect(await t.services.db.priceRecord.count({ where: { placeId: place.id } })).toBe(0);
    },
  );

  it.each(BLOCKED_RESOLUTIONS)(
    'clears the block reason of a task it resolves $name',
    async (row) => {
      const task = await blockedMenuTask(row.status, row.blockedReason);
      const response = await resolveTask(task.id, row.body);
      expect(response.status, response.body).toBe(200);
      // The answer reports the task as the operator left it: the terminal status is what the row now
      // means, and a reason written while the dial was out of reach no longer describes it, because a
      // resolved task has left the dialing path either way (AAP 0.5.3, 0.5.4).
      const resolved = AdminCallTaskDto.parse(response.json());
      expect(resolved.status).toBe(row.outcome);
      expect(resolved.blockedReason).toBeNull();
      const stored = await t.services.db.callTask.findUniqueOrThrow({
        where: { id: task.id },
        select: { blockedReason: true, resolvedBy: true, status: true },
      });
      expect(stored.status).toBe(row.outcome);
      expect(stored.resolvedBy).toBe('operator');
      expect(stored.blockedReason).toBeNull();
    },
  );
  it('stops every other task of a place that asked not to be called', async () => {
    const task = await menuTask('needs_review');
    // Both companions are waiting out a block of their own, in the two statuses a `do_not_call`
    // cancels that carry one: a task held off by the allowlist while it stays `queued`, and one the
    // dispatch could not reconcile (AAP 0.5.3, 0.5.6).
    const companion = await blockedMenuTask('queued', 'not_allowlisted');
    const held = await blockedMenuTask('needs_review', 'dispatch_unknown');
    const live = await makeCallAttempt(t, companion, { state: 'in_progress' });
    const response = await resolveTask(task.id, { outcome: 'do_not_call' });
    expect(response.status, response.body).toBe(200);
    const flagged = await t.services.db.place.findUniqueOrThrow({
      where: { id: place.id },
      select: { doNotCall: true },
    });
    expect(flagged.doNotCall).toBe(true);
    // The whole place is stopped, and the attempt that may be live right now is marked superseded —
    // the flag the relay reads before its next turn (AAP 0.5.3). A cancelled task was cancelled
    // rather than reaching an outcome, so it records neither a resolver nor an instant, and the block
    // reason it was carrying goes with the status: a task the place has asked to stop calling is
    // stopped rather than blocked, and the lifecycle panel counts it as cancelled alone (AAP 0.5.7).
    for (const other of [companion, held]) {
      const cancelled = await t.services.db.callTask.findUniqueOrThrow({
        where: { id: other.id },
        select: { blockedReason: true, outcomeAt: true, resolvedBy: true, status: true },
      });
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.resolvedBy).toBeNull();
      expect(cancelled.outcomeAt).toBeNull();
      expect(cancelled.blockedReason).toBeNull();
    }
    const superseded = await t.services.db.callAttempt.findUniqueOrThrow({
      where: { id: live.id },
      select: { superseded: true },
    });
    expect(superseded.superseded).toBe(true);
  });

  it('refuses a ticket price with no ticketType with 400 invalid_field', async () => {
    const task = await menuTask('needs_review');
    const response = await resolveTask(task.id, {
      outcome: 'completed',
      prices: [
        {
          name: 'Museum entry',
          category: 'ticket',
          priceText: '$9.00',
          currency: 'USD',
          alcoholic: null,
          perPerson: true,
          ticketType: null,
          localAmountMinor: 900,
        },
      ],
    });
    // The refusal is the request schema's, before the handler runs: nothing was stored and the task
    // stands exactly as it was (AAP 0.5.4, 0.5.6).
    expectError(response, 400, 'invalid_field');
    expect(await t.services.db.priceRecord.count({ where: { placeId: place.id } })).toBe(0);
    const stored = await t.services.db.callTask.findUniqueOrThrow({
      where: { id: task.id },
      select: { status: true },
    });
    expect(stored.status).toBe('needs_review');
  });

  it.each(
    rows<{
      readonly name: string;
      readonly outcome: string;
      readonly status?: CallTaskStatus;
      readonly lodgingTask?: boolean;
      readonly resolvedByOperator?: boolean;
      readonly httpStatus?: number;
      readonly code?: ErrorCode;
    }>([
      { name: 'an outcome outside the operators four', outcome: 'maybe', status: 'needs_review' },
      // `refused` is the outcome the kind check alone refuses: it needs no target, no price and no
      // transition, so a case that dropped the check would wrongly apply it (AAP 0.5.3).
      {
        name: 'every outcome on a lodging verification',
        outcome: 'refused',
        status: 'needs_review',
        lodgingTask: true,
      },
      { name: 'a task that is already completed', outcome: 'refused', status: 'completed' },
      { name: 'a task that is already refused', outcome: 'refused', status: 'refused' },
      { name: 'a task that is already do_not_call', outcome: 'refused', status: 'do_not_call' },
      { name: 'a task that is already cancelled', outcome: 'refused', status: 'cancelled' },
      {
        name: 'a task an operator already resolved',
        outcome: 'refused',
        status: 'needs_review',
        resolvedByOperator: true,
      },
      { name: 'an unknown task', outcome: 'refused', httpStatus: 404, code: 'not_found' },
    ]),
  )('refuses $name', async (row) => {
    let taskId: string = randomUUID();
    let status: CallTaskStatus | undefined;
    if (row.status !== undefined) {
      status = row.status;
      const claim = row.lodgingTask === true ? await makeClaim(t, traveler, lodging) : null;
      const task =
        claim === null
          ? await menuTask(status)
          : await makeCallTask(t, {
              kind: 'lodging_stay_verification',
              lodgingId: lodging.id,
              lodgingClaimId: claim.id,
              status,
            });
      taskId = task.id;
      if (row.resolvedByOperator === true) {
        await t.services.db.callTask.update({
          where: { id: taskId },
          data: { resolvedBy: 'operator' },
        });
      }
    }
    expectError(
      await resolveTask(taskId, { outcome: row.outcome }),
      row.httpStatus ?? 422,
      row.code ?? 'invalid_outcome',
    );
    // A refused task keeps exactly the state the case seeded.
    if (status !== undefined) {
      const stored = await t.services.db.callTask.findUniqueOrThrow({
        where: { id: taskId },
        select: { status: true },
      });
      expect(stored.status).toBe(status);
    }
  });
});

const CLAIMS_URL = '/v1/admin/lodging-claims';

function bookingUrl(claimId: string): string {
  return `${CLAIMS_URL}/${claimId}/booking-details`;
}

function resolveClaim(claimId: string, outcome: string): Promise<RouteResponse> {
  return asOperator('POST', `${CLAIMS_URL}/${claimId}/resolve`, { body: { outcome } });
}

async function lodgingClaims(): Promise<AdminLodgingClaimsResponse> {
  const response = await asOperator('GET', CLAIMS_URL);
  expect(response.status, response.body).toBe(200);
  return AdminLodgingClaimsResponse.parse(response.json());
}

describe('the lodging-claim queue (AAP 0.5.3, 0.5.4)', () => {
  it('lists the open claims with their expiry and whether their details are readable', async () => {
    const claim = await makeClaim(t, traveler, lodging, { bookingName: guestName() });
    const stored = await t.services.db.lodgingClaim.findUniqueOrThrow({
      where: { id: claim.id },
      select: { createdAt: true },
    });
    const [listed] = (await lodgingClaims()).items;
    expect(listed?.id).toBe(claim.id);
    expect(listed?.lodgingName).toBe(lodging.name);
    expect(listed?.lodgingPhone).toBe(lodging.phone);
    expect(listed?.cityId).toBe(LISBON);
    expect(listed?.status).toBe('pending_call');
    expect(listed?.detailsAvailable).toBe(true);
    // The expiry is derived, never stored: 72 hours after the claim was created, which is the instant
    // `claim-expire-<claimId>` moves a claim still waiting here to `unreachable` (AAP 0.5.3).
    expect(listed?.expiresAt).toBe(
      new Date(stored.createdAt.getTime() + CLAIM_EXPIRY_HOURS * HOUR_MS).toISOString(),
    );
    // Erased details are no longer readable — the first hourly run after a terminal state wipes the
    // two ciphertexts (AAP 0.5.2) — and neither are the details of a claim carrying no name at all.
    await t.services.db.lodgingClaim.update({
      where: { id: claim.id },
      data: { detailsErasedAt: t.clock.now() },
    });
    expect((await lodgingClaims()).items[0]?.detailsAvailable).toBe(false);
    await t.services.db.lodgingClaim.update({
      where: { id: claim.id },
      data: { bookingNameCiphertext: null, detailsErasedAt: null },
    });
    expect((await lodgingClaims()).items[0]?.detailsAvailable).toBe(false);
    // A terminal claim has left the queue: it is the operator's work only while it is open.
    await t.services.db.lodgingClaim.update({
      where: { id: claim.id },
      data: { resolvedAt: t.clock.now(), status: 'verified' },
    });
    expect((await lodgingClaims()).items).toEqual([]);
  });

  it.each(
    rows<{
      readonly name: string;
      readonly status: LodgingClaimStatus;
      readonly outcome: OperatorClaimOutcome;
      readonly backfills: boolean;
    }>([
      {
        name: 'verified from pending_call',
        status: 'pending_call',
        outcome: 'verified',
        backfills: true,
      },
      { name: 'verified while calling', status: 'calling', outcome: 'verified', backfills: true },
      {
        name: 'rejected from pending_call',
        status: 'pending_call',
        outcome: 'rejected',
        backfills: false,
      },
      {
        name: 'unreachable while calling',
        status: 'calling',
        outcome: 'unreachable',
        backfills: false,
      },
    ]),
  )('resolves $name', async (row) => {
    // A completed meetup the claimant was part of, on the stay's first day: a `verified` outcome
    // backfills one leaderboard fact for it and the other outcomes backfill none (AAP 0.5.7).
    const meetup = await makeMeetup(t, {
      status: 'completed',
      initiator: traveler,
      recipient: other,
      venue,
    });
    const claim = await makeClaim(t, traveler, lodging, { status: row.status });
    const task = await makeCallTask(t, {
      kind: 'lodging_stay_verification',
      lodgingId: lodging.id,
      lodgingClaimId: claim.id,
      status: 'queued',
    });
    const attempt = await makeCallAttempt(t, task, { state: 'dialing' });
    const response = await resolveClaim(claim.id, row.outcome);
    expect(response.status, response.body).toBe(200);
    const resolved = AdminLodgingClaimDto.parse(response.json());
    expect(resolved.id).toBe(claim.id);
    expect(resolved.status).toBe(row.outcome);
    const storedClaim = await t.services.db.lodgingClaim.findUniqueOrThrow({
      where: { id: claim.id },
      select: { resolvedAt: true },
    });
    expect(storedClaim.resolvedAt?.toISOString()).toBe(t.clock.now().toISOString());
    // The verification work still outstanding is cancelled, and the attempt that may be live right
    // now is marked superseded — the flag the relay reads before its next turn (AAP 0.5.3).
    const storedTask = await t.services.db.callTask.findUniqueOrThrow({
      where: { id: task.id },
      select: { resolvedBy: true, status: true },
    });
    expect(storedTask.status).toBe('cancelled');
    expect(storedTask.resolvedBy).toBe('operator');
    const storedAttempt = await t.services.db.callAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
      select: { superseded: true },
    });
    expect(storedAttempt.superseded).toBe(true);
    // One measure per resolution, carrying no link that could reconnect it to the guest (AAP 0.5.2).
    const events = await t.services.db.analyticsEvent.findMany({
      where: { name: 'lodging_claim_resolved' },
      select: { actorHash: true, cityId: true, props: true },
    });
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.actorHash).not.toBeNull();
    expect(event?.cityId).toBe(LISBON);
    const props = event?.props as { outcome?: unknown; resolveSeconds?: unknown };
    expect(props.outcome).toBe(row.outcome);
    // The seconds the claim lived, which the dashboard reports as its median resolution time; the
    // row's creation instant is the database's own, so only the shape is asserted here.
    expect(typeof props.resolveSeconds).toBe('number');
    expect(Number(props.resolveSeconds)).toBeGreaterThanOrEqual(0);
    const facts = await t.services.db.lodgingActivityFact.findMany({
      where: { lodgingId: lodging.id },
      select: { meetupId: true },
    });
    expect(facts.map((fact) => fact.meetupId)).toEqual(row.backfills ? [meetup.id] : []);
  });

  it('cancels an outstanding verification task of a resolved claim with no block reason left', async () => {
    // Where a lodging verification reaches the operator queue when the lodging has no number at all:
    // `unreachable` with `blockedReason = no_phone`, which is the reason the dashboard counts beside
    // its open calls (AAP 0.5.3, 0.5.6). Resolving the claim ends the work still outstanding on it,
    // and the reason goes with the status: a cancelled task is stopped rather than blocked, and no
    // dial is coming for it (AAP 0.5.3).
    const claim = await makeClaim(t, traveler, lodging, { status: 'calling' });
    const task = await makeCallTask(t, {
      kind: 'lodging_stay_verification',
      lodgingId: lodging.id,
      lodgingClaimId: claim.id,
      status: 'unreachable',
      blockedReason: 'no_phone',
    });
    const response = await resolveClaim(claim.id, 'verified');
    expect(response.status, response.body).toBe(200);
    const stored = await t.services.db.callTask.findUniqueOrThrow({
      where: { id: task.id },
      select: { blockedReason: true, resolvedBy: true, status: true },
    });
    expect(stored.status).toBe('cancelled');
    expect(stored.resolvedBy).toBe('operator');
    expect(stored.blockedReason).toBeNull();
  });

  it.each(
    rows<{
      readonly name: string;
      readonly outcome: string;
      readonly status?: LodgingClaimStatus;
      readonly httpStatus?: number;
      readonly code?: ErrorCode;
    }>([
      { name: 'an outcome outside the three', outcome: 'maybe', status: 'pending_call' },
      { name: 'a claim that is already verified', outcome: 'verified', status: 'verified' },
      { name: 'a claim that already expired', outcome: 'unreachable', status: 'unreachable' },
      { name: 'an unknown claim', outcome: 'verified', httpStatus: 404, code: 'claim_not_found' },
    ]),
  )('refuses $name', async (row) => {
    const claim =
      row.status === undefined
        ? null
        : await makeClaim(t, traveler, lodging, { status: row.status });
    const response = await resolveClaim(claim?.id ?? randomUUID(), row.outcome);
    expectError(response, row.httpStatus ?? 422, row.code ?? 'invalid_outcome');
    // A terminal claim stays terminal: the refusal leaves the row exactly as it stood.
    if (claim !== null) {
      const stored = await t.services.db.lodgingClaim.findUniqueOrThrow({
        where: { id: claim.id },
        select: { status: true },
      });
      expect(stored.status).toBe(row.status);
    }
  });

  it('answers the decrypted booking details once, under no-store, and audits the read', async () => {
    const name = guestName();
    const reference = `BOOKING-${randomUUID().slice(0, 12)}`;
    const claim = await makeClaim(t, traveler, lodging, {
      bookingName: name,
      bookingReference: reference,
    });
    const stored = await t.services.db.lodgingClaim.findUniqueOrThrow({
      where: { id: claim.id },
      select: { bookingNameCiphertext: true },
    });
    const response = await asOperator('GET', bookingUrl(claim.id));
    expect(response.status, response.body).toBe(200);
    expect(String(response.headers['cache-control'])).toContain('no-store');
    const details = BookingDetailsDto.parse(response.json());
    expect(details.claimId).toBe(claim.id);
    expect(details.bookingName).toBe(name);
    expect(details.bookingReference).toBe(reference);
    // The one read of a booking field outside the voice relay, audited in the same transaction as the
    // read it made possible; the log itself holds no booking data (AAP 0.5.2).
    const logs = await t.services.db.operatorAccessLog.findMany({
      select: { accessedAt: true, lodgingClaimId: true, operatorId: true, purpose: true },
    });
    expect(logs).toHaveLength(1);
    const [access] = logs;
    expect(access?.operatorId).toBe(operator.id);
    expect(access?.lodgingClaimId).toBe(claim.id);
    expect(access?.purpose).toBe('manual_verification_call');
    expect(access?.accessedAt.toISOString()).toBe(t.clock.now().toISOString());
    // What is stored stays ciphertext under the process keyring: the name is not in the column.
    expect(stored.bookingNameCiphertext).not.toContain(name);
  });

  it.each(
    rows<{
      readonly name: string;
      readonly setup: 'unknown' | 'terminal' | 'erased';
      readonly httpStatus: number;
      readonly code: ErrorCode;
    }>([
      { name: 'an unknown claim', setup: 'unknown', httpStatus: 404, code: 'claim_not_found' },
      {
        name: 'a claim that is already terminal',
        setup: 'terminal',
        httpStatus: 409,
        code: 'details_unavailable',
      },
      {
        name: 'a claim whose details were erased',
        setup: 'erased',
        httpStatus: 409,
        code: 'details_unavailable',
      },
    ]),
  )('refuses the booking details of $name', async (row) => {
    let claimId: string = randomUUID();
    if (row.setup !== 'unknown') {
      const claim = await makeClaim(t, traveler, lodging, {
        status: row.setup === 'terminal' ? 'verified' : 'pending_call',
      });
      claimId = claim.id;
      if (row.setup === 'erased') {
        await t.services.db.lodgingClaim.update({
          where: { id: claimId },
          data: { detailsErasedAt: t.clock.now() },
        });
      }
    }
    expectError(await asOperator('GET', bookingUrl(claimId)), row.httpStatus, row.code);
    // An unauditable read does not happen: a refusal writes no access-log row (AAP 0.5.2).
    expect(await t.services.db.operatorAccessLog.count()).toBe(0);
  });
});

describe('the crawl-domain review (AAP 0.5.4, 0.5.6)', () => {
  it('lists the unreviewed domains first and records an operator decision over an older one', async () => {
    await t.services.db.crawlDomainPolicy.createMany({
      data: [
        {
          domain: 'menu.example.com',
          decision: 'allowed',
          reason: 'operator_review',
          checkedAt: instant(-DAY_MS),
          overriddenBy: operator.id,
        },
        {
          domain: 'delivery.example.net',
          decision: 'prohibited',
          reason: 'blocklist',
          checkedAt: instant(-2 * DAY_MS),
          overriddenBy: null,
        },
        {
          domain: 'unreviewed.example.org',
          decision: 'uncertain',
          reason: 'awaiting_review',
          checkedAt: instant(-3 * DAY_MS),
          overriddenBy: null,
        },
      ],
    });
    const response = await asOperator('GET', '/v1/admin/crawl-domains');
    expect(response.status, response.body).toBe(200);
    const queue = AdminCrawlDomainsResponse.parse(response.json());
    // The domains nobody has read yet come first, newest check first among the decided ones: ordering
    // by the decision alone would put `uncertain` on top only because it is the enum's last member.
    expect(queue.items.map((item) => item.domain)).toEqual([
      'unreviewed.example.org',
      'menu.example.com',
      'delivery.example.net',
    ]);
    expect(queue.items[0]?.overridden).toBe(false);
    expect(queue.items[1]?.overridden).toBe(true);
    // `overriddenBy` holds a user id, so the DTO carries the fact and never the id (AAP 0.5.4).
    expect(keysDeep(queue.items)).not.toContain('overriddenBy');
    const decided = await asOperator('PATCH', '/v1/admin/crawl-domains/unreviewed.example.org', {
      body: { decision: 'allowed' },
    });
    expect(decided.status, decided.body).toBe(200);
    const dto = AdminCrawlDomainDto.parse(decided.json());
    expect(dto.decision).toBe('allowed');
    expect(dto.reason).toBe('operator_review');
    expect(dto.overridden).toBe(true);
    expect(dto.checkedAt).toBe(t.clock.now().toISOString());
    const stored = await t.services.db.crawlDomainPolicy.findUniqueOrThrow({
      where: { domain: 'unreviewed.example.org' },
      select: { decision: true, overriddenBy: true },
    });
    expect(stored.decision).toBe('allowed');
    expect(stored.overriddenBy).toBe(operator.id);
  });

  it.each(
    rows<{ readonly name: string; readonly decision: string }>([
      {
        name: 'uncertain, which is where an unreviewed domain already sits',
        decision: 'uncertain',
      },
      { name: 'an unknown value', decision: 'maybe' },
    ]),
  )('refuses $name with 422 invalid_outcome', async (row) => {
    const response = await asOperator('PATCH', '/v1/admin/crawl-domains/pending.example.com', {
      body: { decision: row.decision },
    });
    expectError(response, 422, 'invalid_outcome');
    // The upsert never ran, so no row was written for a domain nobody may decide.
    const rows = await t.services.db.crawlDomainPolicy.count({
      where: { domain: 'pending.example.com' },
    });
    expect(rows).toBe(0);
  });
});

/** How many lodgings one page of the registry holds when the read names no `limit`. */
const REGISTRY_PAGE = 200;

/** `GET /admin/lodgings` as the operator, parsed into the contract's own page (AAP 0.5.4). */
async function lodgings(query: Record<string, string> = {}): Promise<AdminLodgingsResponse> {
  const response = await asOperator('GET', '/v1/admin/lodgings', { query });
  expect(response.status, response.body).toBe(200);
  return AdminLodgingsResponse.parse(response.json());
}

/** One fixture lodging under a name the read's own (city, name, id) order is known by. */
async function namedLodging(cityId: string, name: string): Promise<LodgingFixture> {
  const row = await makeLodging(t, { cityId });
  await t.services.db.lodging.update({ where: { id: row.id }, data: { name } });
  return { ...row, name };
}

/**
 * The registry the filter cases narrow: three named lodgings in Lisbon and one in Mexico City, whose names fix the order the
 * answer must come back in without any case reading an id back.
 */
interface RegistryFixture {
  readonly central: LodgingFixture;
  readonly miradouro: LodgingFixture;
  readonly alfama: LodgingFixture;
  readonly roma: LodgingFixture;
}

async function registryFixture(): Promise<RegistryFixture> {
  return {
    central: await namedLodging(LISBON, 'Albergue Central'),
    miradouro: await namedLodging(LISBON, 'Hostel Miradouro'),
    alfama: await namedLodging(LISBON, 'Pensão Alfama'),
    roma: await namedLodging(MEXICO_CITY, 'Hostal Roma Norte'),
  };
}

/** One filter over that registry: the query it sends and the rows that must come back. */
const REGISTRY_FILTERS = rows<{
  readonly name: string;
  readonly query: (fixture: RegistryFixture) => Record<string, string>;
  readonly expected: (fixture: RegistryFixture) => readonly string[];
}>([
  {
    name: 'the city the lodging stands in',
    query: () => ({ cityId: MEXICO_CITY }),
    expected: (fixture) => [fixture.roma.id],
  },
  {
    name: "the lodging's name, in whatever case it is typed",
    query: () => ({ q: 'ALFAMA' }),
    expected: (fixture) => [fixture.alfama.id],
  },
  {
    name: 'a city and a search term together',
    query: () => ({ cityId: LISBON, q: 'hostel' }),
    expected: (fixture) => [fixture.miradouro.id],
  },
]);

/**
 * Queries the registry read refuses before it runs (AAP 0.5.4): a cursor this read did not write — the queue read's own payload
 * shape, an id that is not an id, and an id no lodging carries — a page size outside the contract's bound, and a parameter the
 * registry does not carry.
 */
const REGISTRY_BAD_QUERIES = rows<{
  readonly name: string;
  readonly query: Record<string, string>;
}>([
  { name: 'a cursor that is not a cursor', query: { cursor: 'not-a-cursor' } },
  {
    name: "a cursor of the call queue's shape",
    query: { cursor: cursorShaped({ t: null, i: randomUUID() }) },
  },
  { name: 'a cursor whose id is not an id', query: { cursor: cursorShaped({ i: 'nope' }) } },
  {
    name: 'a cursor naming no lodging the registry lists',
    query: { cursor: cursorShaped({ i: randomUUID() }) },
  },
  { name: 'a page size below the one the contract allows', query: { limit: '0' } },
  { name: 'a page size above the one the contract allows', query: { limit: '501' } },
  { name: 'a page size that is not a number', query: { limit: 'many' } },
  { name: 'a parameter the registry does not carry', query: { city: LISBON } },
  { name: 'a search term holding a NUL byte', query: { q: NUL_TEXT } },
]);

/** `GET /admin/venues` as the operator, parsed into the contract's own page (AAP 0.5.4). */
async function venueRegistry(query: Record<string, string> = {}): Promise<AdminVenuesResponse> {
  const response = await asOperator('GET', '/v1/admin/venues', { query });
  expect(response.status, response.body).toBe(200);
  return AdminVenuesResponse.parse(response.json());
}

/** One fixture venue under a name of the test's own: {@link VenueFixture} plus the name its place in the read's order is known by. */
interface NamedVenue extends VenueFixture {
  readonly name: string;
}

/** One fixture venue under a name the read's own (city, name, id) order is known by. */
async function namedVenue(cityId: string, name: string): Promise<NamedVenue> {
  const row = await makeVenue(t, { cityId });
  await t.services.db.venue.update({ where: { id: row.id }, data: { name } });
  return { ...row, name };
}

/**
 * The name the case's own venue — the one `beforeEach` created — is given, so the place the fifth row holds in the read's own
 * order is known rather than guessed from its generated name. It sorts between the two Lisbon names the fixture adds around it.
 */
const HOME_VENUE_NAME = 'Pastelaria do Bairro';

/**
 * The registry the venue filter cases narrow: the case's own venue under a known name, three named venues in Lisbon and one in
 * Mexico City, whose names fix the order the answer must come back in without any case reading an id back.
 */
interface VenueRegistryFixture {
  readonly home: string;
  readonly central: NamedVenue;
  readonly miradouro: NamedVenue;
  readonly alfama: NamedVenue;
  readonly roma: NamedVenue;
}

async function venueRegistryFixture(): Promise<VenueRegistryFixture> {
  await t.services.db.venue.update({ where: { id: venue.id }, data: { name: HOME_VENUE_NAME } });
  return {
    home: HOME_VENUE_NAME,
    central: await namedVenue(LISBON, 'Cafe Central'),
    miradouro: await namedVenue(LISBON, 'Bar Miradouro'),
    alfama: await namedVenue(LISBON, 'Taberna Alfama'),
    roma: await namedVenue(MEXICO_CITY, 'Cantina Roma Norte'),
  };
}

/** One filter over that registry: the query it sends and the rows that must come back. */
const VENUE_REGISTRY_FILTERS = rows<{
  readonly name: string;
  readonly query: (fixture: VenueRegistryFixture) => Record<string, string>;
  readonly expected: (fixture: VenueRegistryFixture) => readonly string[];
}>([
  {
    name: 'the city the venue stands in',
    query: () => ({ cityId: MEXICO_CITY }),
    expected: (fixture) => [fixture.roma.id],
  },
  {
    name: "the venue's name, in whatever case it is typed",
    query: () => ({ q: 'ALFAMA' }),
    expected: (fixture) => [fixture.alfama.id],
  },
  {
    name: 'a city and a search term together',
    query: () => ({ cityId: LISBON, q: 'miradouro' }),
    expected: (fixture) => [fixture.miradouro.id],
  },
]);

/**
 * Queries the venue registry read refuses before it runs (AAP 0.5.4): a cursor this read did not write — the queue read's own
 * payload shape, an id that is not an id, and an id no venue carries — a page size outside the contract's bound, and a
 * parameter the registry does not carry.
 */
const VENUE_REGISTRY_BAD_QUERIES = rows<{
  readonly name: string;
  readonly query: Record<string, string>;
}>([
  { name: 'a cursor that is not a cursor', query: { cursor: 'not-a-cursor' } },
  {
    name: "a cursor of the call queue's shape",
    query: { cursor: cursorShaped({ t: null, i: randomUUID() }) },
  },
  { name: 'a cursor whose id is not an id', query: { cursor: cursorShaped({ i: 'nope' }) } },
  {
    name: 'a cursor naming no venue the registry lists',
    query: { cursor: cursorShaped({ i: randomUUID() }) },
  },
  { name: 'a page size below the one the contract allows', query: { limit: '0' } },
  { name: 'a page size above the one the contract allows', query: { limit: '501' } },
  { name: 'a page size that is not a number', query: { limit: 'many' } },
  { name: 'a parameter the registry does not carry', query: { city: LISBON } },
  { name: 'a search term holding a NUL byte', query: { q: NUL_TEXT } },
]);

/** A venue an operator enters, with the two free-text fields left to the row that supplies them. */
function venueEntry(name: string, address: string): Record<string, unknown> {
  return { cityId: LISBON, name, address, lat: 38.71, lng: -9.14 };
}

/**
 * The onboarding bodies that carry a NUL byte in a free-text field, one row per route and field: the byte passes a
 * bare `z.string()` and PostgreSQL refuses it with SQLSTATE 22021, so `400 invalid_field` at the boundary is what the
 * caller is owed instead of a `500` from the insert (AAP 0.11.2). Each row sends its own request, because the edit
 * route needs a venue that already exists.
 */
const NUL_ONBOARDING_ROWS = rows<{
  readonly name: string;
  readonly send: () => Promise<RouteResponse>;
}>([
  {
    name: 'a venue name',
    send: () =>
      asOperator('POST', '/v1/admin/venues', { body: venueEntry(NUL_TEXT, '3 Fixture Street') }),
  },
  {
    name: 'a venue address',
    send: () =>
      asOperator('POST', '/v1/admin/venues', {
        body: venueEntry('Fixture NUL Address Venue', NUL_TEXT),
      }),
  },
  {
    name: 'a venue name on the edit route',
    send: async () => {
      const created = await asOperator('POST', '/v1/admin/venues', {
        body: venueEntry('Fixture NUL Edit Venue', '3 Fixture Street'),
      });
      const onboarded = AdminVenueDto.parse(created.json());
      return asOperator('PATCH', `/v1/admin/venues/${onboarded.id}`, { body: { name: NUL_TEXT } });
    },
  },
  {
    name: 'a lodging name',
    send: () =>
      asOperator('POST', '/v1/admin/lodgings', {
        body: {
          cityId: LISBON,
          name: NUL_TEXT,
          kind: 'hostel',
          address: '4 Fixture Street',
          phone: null,
          lat: 38.71,
          lng: -9.14,
        },
      }),
  },
]);

describe('venue and lodging onboarding (AAP 0.5.4, 0.5.6)', () => {
  it('onboards a venue, refreshes its city and issues its console secret once', async () => {
    const created = await asOperator('POST', '/v1/admin/venues', {
      body: {
        cityId: LISBON,
        name: 'Fixture Onboarded Venue',
        address: '3 Fixture Street',
        lat: 38.71,
        lng: -9.14,
      },
    });
    expect(created.status, created.body).toBe(201);
    const venueDto = AdminVenueDto.parse(created.json());
    expect(venueDto.cityId).toBe(LISBON);
    expect(venueDto.name).toBe('Fixture Onboarded Venue');
    expect(venueDto.isActivePartner).toBe(true);
    expect(venueDto.secretIssuedAt).toBeNull();
    // Onboarding changes what the weekly refresh covers, so the city's refresh is queued in an
    // after-commit callback — which is why it is already waiting when the answer arrives (AAP 0.3.2).
    expect(await placeRefreshPayloads()).toContainEqual({ cityId: LISBON });
    const updated = await asOperator('PATCH', `/v1/admin/venues/${venueDto.id}`, {
      body: { isActivePartner: false },
    });
    expect(updated.status, updated.body).toBe(200);
    expect(AdminVenueDto.parse(updated.json()).isActivePartner).toBe(false);
    const issued = await asOperator('POST', `/v1/admin/venues/${venueDto.id}/secret`);
    expect(issued.status, issued.body).toBe(200);
    expect(String(issued.headers['cache-control'])).toContain('no-store');
    const { secret } = SecretIssued.parse(issued.json());
    expect(secret.length).toBeGreaterThan(0);
    // Stored as a lookup hash beside a ciphertext, because the code generator needs the secret itself,
    // and never as the plaintext (AAP 0.3.2).
    const stored = await t.services.db.venue.findUniqueOrThrow({
      where: { id: venueDto.id },
      select: { secretCiphertext: true, secretIssuedAt: true, secretLookupHash: true },
    });
    expect(stored.secretLookupHash).not.toBeNull();
    expect(stored.secretCiphertext).not.toBeNull();
    expect(stored.secretIssuedAt?.toISOString()).toBe(t.clock.now().toISOString());
    // No read carries the secret or either stored form of it: the issue route is the one answer with
    // the plaintext, and the registry names none of the three (AAP 0.5.4).
    const registry = await asOperator('GET', '/v1/admin/venues');
    expect(registry.status, registry.body).toBe(200);
    const listed = AdminVenuesResponse.parse(registry.json());
    expect(listed.items.find((item) => item.id === venueDto.id)?.secretIssuedAt).toBe(
      t.clock.now().toISOString(),
    );
    const leaked = keysDeep(listed).filter(
      (path) => path.endsWith('secretLookupHash') || path.endsWith('secretCiphertext'),
    );
    expect(leaked).toEqual([]);
    expect(registry.body).not.toContain(secret);
    expect(registry.body).not.toContain('secretLookupHash');
    expect(registry.body).not.toContain('secretCiphertext');
    const unknown = await asOperator('POST', `/v1/admin/venues/${randomUUID()}/secret`);
    expectError(unknown, 404, 'not_found');
  });

  it('enters a lodging by hand and refreshes its city when its secret is issued', async () => {
    const created = await asOperator('POST', '/v1/admin/lodgings', {
      body: {
        cityId: MEXICO_CITY,
        name: 'Fixture Onboarded Lodging',
        kind: 'guesthouse',
        address: '4 Fixture Street',
        phone: null,
        lat: 19.43,
        lng: -99.13,
      },
    });
    expect(created.status, created.body).toBe(201);
    const lodgingDto = AdminLodgingDto.parse(created.json());
    expect(lodgingDto.cityId).toBe(MEXICO_CITY);
    expect(lodgingDto.name).toBe('Fixture Onboarded Lodging');
    expect(lodgingDto.kind).toBe('guesthouse');
    expect(lodgingDto.phone).toBeNull();
    expect(lodgingDto.secretIssuedAt).toBeNull();
    // The two operator-managed facts the weekly refresh preserves, and the absence of any
    // OpenStreetMap identity: a hand-entered row is never overwritten by an ingest (AAP 0.5.6).
    expect(lodgingDto.phoneSource).toBe('operator');
    expect(lodgingDto.doNotCall).toBe(false);
    expect(keysDeep(lodgingDto).filter((path) => path.startsWith('osm'))).toEqual([]);
    // No refresh yet: a lodging is not a partner until a console secret is issued, which is what
    // changes the neighbourhood the price pipeline covers.
    expect(await placeRefreshPayloads()).toEqual([]);
    const issued = await asOperator('POST', `/v1/admin/lodgings/${lodgingDto.id}/secret`);
    expect(issued.status, issued.body).toBe(200);
    expect(SecretIssued.parse(issued.json()).secret.length).toBeGreaterThan(0);
    expect(await placeRefreshPayloads()).toContainEqual({ cityId: MEXICO_CITY });
    const stored = await t.services.db.lodging.findUniqueOrThrow({
      where: { id: lodgingDto.id },
      select: { secretCiphertext: true, secretLookupHash: true },
    });
    expect(stored.secretLookupHash).not.toBeNull();
    expect(stored.secretCiphertext).not.toBeNull();
    const registry = await asOperator('GET', '/v1/admin/lodgings');
    const listed = AdminLodgingsResponse.parse(registry.json());
    const leaked = keysDeep(listed).filter(
      (path) =>
        path.endsWith('secretLookupHash') ||
        path.endsWith('secretCiphertext') ||
        path.startsWith('items[].osm'),
    );
    expect(leaked).toEqual([]);
    const unknown = await asOperator('POST', `/v1/admin/lodgings/${randomUUID()}/secret`);
    expectError(unknown, 404, 'not_found');
  });

  it('answers every lodging when the registry fits one page, in (city, name, id) order', async () => {
    const fixture = await registryFixture();
    // No query at all, which is what a client that knows none of the filters sends: one page in the
    // read's own order — city first, then the name — with the count the filters match and no cursor,
    // because the page holds the whole registry (AAP 0.5.4).
    const page = await lodgings();
    expect(page.total).toBe(5);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((item) => item.name)).toEqual([
      fixture.central.name,
      lodging.name,
      fixture.miradouro.name,
      fixture.alfama.name,
      fixture.roma.name,
    ]);
    expect(page.items.map((item) => item.cityId)).toEqual([
      LISBON,
      LISBON,
      LISBON,
      LISBON,
      MEXICO_CITY,
    ]);
  });

  it.each(REGISTRY_FILTERS)('narrows the registry by $name', async (row) => {
    const fixture = await registryFixture();
    const expected = row.expected(fixture);
    const page = await lodgings(row.query(fixture));
    expect(page.items.map((item) => item.id)).toEqual(expected);
    // The count is of the rows the filters match, never of the rows the page happens to hold.
    expect(page.total).toBe(expected.length);
    expect(page.nextCursor).toBeNull();
  });

  it.each(REGISTRY_BAD_QUERIES)('refuses $name with 400 invalid_field', async (row) => {
    const response = await asOperator('GET', '/v1/admin/lodgings', { query: row.query });
    expectError(response, 400, 'invalid_field');
  });

  it.each(NUL_ONBOARDING_ROWS)(
    'refuses $name holding a NUL byte with 400 invalid_field',
    async (row) => {
      expectError(await row.send(), 400, 'invalid_field');
    },
  );

  it('pages a registry larger than one page, so the lodging just entered stays reachable', async () => {
    for (let seeded = 0; seeded < REGISTRY_PAGE - 1; seeded += 1) {
      await makeLodging(t, { cityId: LISBON });
    }
    // One row of a later city, so the walk below crosses a city boundary and the city filter has two
    // cities to choose between.
    const elsewhere = await namedLodging(MEXICO_CITY, 'Hostal Roma Norte');
    // The row the QA report could not reach: entered through the route an operator uses, with a long name that sorts after every
    // fixture name, so it is the 201st Lisbon row and no first page holds it.
    const entered = await asOperator('POST', '/v1/admin/lodgings', {
      body: {
        cityId: LISBON,
        name: `zz QA Long Name ${randomUUID().slice(0, 8)} ${'Lodging '.repeat(6)}`,
        kind: 'hostel',
        address: '5 Fixture Street',
        phone: null,
        lat: 38.72,
        lng: -9.15,
      },
    });
    expect(entered.status, entered.body).toBe(201);
    const created = AdminLodgingDto.parse(entered.json());
    const total = REGISTRY_PAGE + 2;
    const first = await lodgings();
    // One page holds exactly the bound, in (city, name, id) order, and says how many rows it leaves
    // behind: the count is of the whole registry, not of the page (AAP 0.5.4).
    expect(first.items).toHaveLength(REGISTRY_PAGE);
    expect(first.total).toBe(total);
    expect(first.nextCursor).not.toBeNull();
    const cities = first.items.map((item) => item.cityId);
    const names = first.items.map((item) => item.name);
    expect(cities).toEqual([...cities].sort());
    expect(names).toEqual([...names].sort());
    expect(first.items.map((item) => item.id)).not.toContain(created.id);
    // The search is what makes a row reachable whatever the registry holds, which is the read the
    // registry screen sends once a lodging has been entered (AAP 0.5.4).
    const searched = await lodgings({ q: created.name });
    expect(searched.total).toBe(1);
    expect(searched.items.map((item) => item.id)).toEqual([created.id]);
    // The city filter narrows the registry itself rather than one page of it: Lisbon holds the bound
    // plus the row just entered, so it still pages, and the later city holds its one row.
    const lisbon = await lodgings({ cityId: LISBON });
    expect(lisbon.total).toBe(REGISTRY_PAGE + 1);
    expect(lisbon.items).toHaveLength(REGISTRY_PAGE);
    expect(lisbon.nextCursor).not.toBeNull();
    const mexico = await lodgings({ cityId: MEXICO_CITY });
    expect(mexico.total).toBe(1);
    expect(mexico.items.map((item) => item.id)).toEqual([elsewhere.id]);
    expect(mexico.nextCursor).toBeNull();
    // A page size the query names is the page the read answers, while the count stays the registry's.
    const limited = await lodgings({ limit: '3' });
    expect(limited.items).toHaveLength(3);
    expect(limited.total).toBe(total);
    expect(limited.nextCursor).not.toBeNull();
    // Walking the cursor reproduces the whole registry row for row: the read answered in one page is
    // the yardstick, so a cursor that skipped, repeated or reordered a row fails here, and the walk
    // reaches the row the first page left out and ends on a null cursor (AAP 0.5.4).
    const whole = await lodgings({ limit: '500' });
    expect(whole.items).toHaveLength(total);
    expect(whole.nextCursor).toBeNull();
    const seen = first.items.map((item) => item.id);
    let cursor: string | null = first.nextCursor;
    // One iteration per remaining page and one more, so a cursor that never ends fails on the loop's
    // own bound rather than hanging.
    for (let page = 0; page <= total; page += 1) {
      const answer = await lodgings(cursor === null ? {} : { cursor });
      expect(answer.total).toBe(total);
      seen.push(...answer.items.map((item) => item.id));
      cursor = answer.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(whole.items.map((item) => item.id));
    expect(seen).toContain(created.id);
    expect(new Set(seen).size).toBe(total);
    expect(cursor).toBeNull();
  });

  it('answers every venue when the registry fits one page, in (city, name, id) order', async () => {
    const fixture = await venueRegistryFixture();
    // No query at all, which is what a client that knows none of the filters sends: one page in the
    // read's own order — city first, then the name — with the count the filters match and no cursor,
    // because the page holds the whole registry (AAP 0.5.4).
    const page = await venueRegistry();
    expect(page.total).toBe(5);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((item) => item.name)).toEqual([
      fixture.miradouro.name,
      fixture.central.name,
      fixture.home,
      fixture.alfama.name,
      fixture.roma.name,
    ]);
    expect(page.items.map((item) => item.cityId)).toEqual([
      LISBON,
      LISBON,
      LISBON,
      LISBON,
      MEXICO_CITY,
    ]);
  });

  it.each(VENUE_REGISTRY_FILTERS)('narrows the venue registry by $name', async (row) => {
    const fixture = await venueRegistryFixture();
    const expected = row.expected(fixture);
    const page = await venueRegistry(row.query(fixture));
    expect(page.items.map((item) => item.id)).toEqual(expected);
    // The count is of the rows the filters match, never of the rows the page happens to hold.
    expect(page.total).toBe(expected.length);
    expect(page.nextCursor).toBeNull();
  });

  it.each(VENUE_REGISTRY_BAD_QUERIES)('refuses $name with 400 invalid_field', async (row) => {
    const response = await asOperator('GET', '/v1/admin/venues', { query: row.query });
    expectError(response, 400, 'invalid_field');
  });

  it('pages a venue registry larger than one page, so the venue just entered stays reachable', async () => {
    for (let seeded = 0; seeded < REGISTRY_PAGE - 1; seeded += 1) {
      await makeVenue(t, { cityId: LISBON });
    }
    // One row of a later city, so the walk below crosses a city boundary and the city filter has two
    // cities to choose between.
    const elsewhere = await namedVenue(MEXICO_CITY, 'Cantina Roma Norte');
    // The row the QA report could not reach: entered through the route an operator uses, with a long name that sorts after every
    // fixture name, so it is the 201st Lisbon row and no first page holds it.
    const entered = await asOperator('POST', '/v1/admin/venues', {
      body: {
        cityId: LISBON,
        name: `zz QA Long Name ${randomUUID().slice(0, 8)} ${'Venue '.repeat(8)}`,
        address: '6 Fixture Street',
        lat: 38.72,
        lng: -9.15,
      },
    });
    expect(entered.status, entered.body).toBe(201);
    const created = AdminVenueDto.parse(entered.json());
    const total = REGISTRY_PAGE + 2;
    const first = await venueRegistry();
    // One page holds exactly the bound, in (city, name, id) order, and says how many rows it leaves
    // behind: the count is of the whole registry, not of the page (AAP 0.5.4).
    expect(first.items).toHaveLength(REGISTRY_PAGE);
    expect(first.total).toBe(total);
    expect(first.nextCursor).not.toBeNull();
    const cities = first.items.map((item) => item.cityId);
    const names = first.items.map((item) => item.name);
    expect(cities).toEqual([...cities].sort());
    expect(names).toEqual([...names].sort());
    expect(first.items.map((item) => item.id)).not.toContain(created.id);
    // The search is what makes a row reachable whatever the registry holds, which is the read the
    // registry screen sends once a venue has been entered (AAP 0.5.4).
    const searched = await venueRegistry({ q: created.name });
    expect(searched.total).toBe(1);
    expect(searched.items.map((item) => item.id)).toEqual([created.id]);
    // The city filter narrows the registry itself rather than one page of it: Lisbon holds the bound
    // plus the row just entered, so it still pages, and the later city holds its one row.
    const lisbon = await venueRegistry({ cityId: LISBON });
    expect(lisbon.total).toBe(REGISTRY_PAGE + 1);
    expect(lisbon.items).toHaveLength(REGISTRY_PAGE);
    expect(lisbon.nextCursor).not.toBeNull();
    const mexico = await venueRegistry({ cityId: MEXICO_CITY });
    expect(mexico.total).toBe(1);
    expect(mexico.items.map((item) => item.id)).toEqual([elsewhere.id]);
    expect(mexico.nextCursor).toBeNull();
    // A page size the query names is the page the read answers, while the count stays the registry's.
    const limited = await venueRegistry({ limit: '3' });
    expect(limited.items).toHaveLength(3);
    expect(limited.total).toBe(total);
    expect(limited.nextCursor).not.toBeNull();
    // Walking the cursor reproduces the whole registry row for row: the read answered in one page is
    // the yardstick, so a cursor that skipped, repeated or reordered a row fails here, and the walk
    // reaches the row the first page left out and ends on a null cursor (AAP 0.5.4).
    const whole = await venueRegistry({ limit: '500' });
    expect(whole.items).toHaveLength(total);
    expect(whole.nextCursor).toBeNull();
    const seen = first.items.map((item) => item.id);
    let cursor: string | null = first.nextCursor;
    // One iteration per remaining page and one more, so a cursor that never ends fails on the loop's
    // own bound rather than hanging.
    for (let page = 0; page <= total; page += 1) {
      const answer = await venueRegistry(cursor === null ? {} : { cursor });
      expect(answer.total).toBe(total);
      seen.push(...answer.items.map((item) => item.id));
      cursor = answer.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(whole.items.map((item) => item.id));
    expect(seen).toContain(created.id);
    expect(new Set(seen).size).toBe(total);
    expect(cursor).toBeNull();
  });
});

describe('the report queue and the client event (AAP 0.5.2, 0.5.4)', () => {
  it('lists the report a traveler filed with both handles and the meetup it concerns', async () => {
    const meetup = await makeMeetup(t, {
      status: 'completed',
      initiator: traveler,
      recipient: other,
      venue,
    });
    const reason = `Fixture complaint ${randomUUID().slice(0, 8)}`;
    const filed = await callRoute(t.app, {
      method: 'POST',
      url: `/v1/users/${other.id}/report`,
      as: traveler,
      body: { reason },
    });
    expect(filed.status, filed.body).toBe(204);
    const response = await asOperator('GET', '/v1/admin/reports');
    expect(response.status, response.body).toBe(200);
    const queue = AdminReportsResponse.parse(response.json());
    expect(queue.items).toHaveLength(1);
    const [report] = queue.items;
    expect(report?.reporterHandle).toBe(traveler.handle);
    expect(report?.reportedHandle).toBe(other.handle);
    expect(report?.reason).toBe(reason);
    expect(report?.createdAt).toBe(t.clock.now().toISOString());
    // The pair's most recent meetup is the operator's context, whichever status it holds, and the only
    // meetup the report could be about (AAP 0.5.2).
    expect(report?.meetupId).toBe(meetup.id);
  });

  it('records a client-reported place opening for a participant and refuses everyone else', async () => {
    const meetup = await makeMeetup(t, {
      status: 'completed',
      initiator: traveler,
      recipient: other,
      venue,
    });
    const recorded = await callRoute(t.app, {
      method: 'POST',
      url: '/v1/events',
      as: traveler,
      body: {
        name: 'suggestion_place_opened',
        meetupId: meetup.id,
        placeId: place.id,
        placeCategory: 'restaurant',
      },
    });
    expect(recorded.status, recorded.body).toBe(204);
    const events = await t.services.db.analyticsEvent.findMany({
      where: { name: 'suggestion_place_opened' },
      select: { actorHash: true, cityId: true, meetupId: true, occurredAt: true, props: true },
    });
    expect(events).toHaveLength(1);
    // The actor reaches the table as the HMAC of its id under `ANALYTICS_SALT` and never in the clear,
    // and the city comes from the meetup's venue rather than from the body (AAP 0.5.2).
    const [event] = events;
    expect(event?.actorHash).not.toBeNull();
    expect(event?.actorHash).not.toBe(traveler.id);
    expect(event?.meetupId).toBe(meetup.id);
    expect(event?.cityId).toBe(LISBON);
    expect(event?.occurredAt.toISOString()).toBe(t.clock.now().toISOString());
    expect(event?.props).toEqual({ placeId: place.id, placeCategory: 'restaurant' });
    // A name outside the one-member client vocabulary, and a meetup the caller is not a participant
    // of, answer the same way: the route is no oracle for which meetup ids exist (AAP 0.5.4, 0.5.7).
    const stranger = await makeUser(t, { card: 'none' });
    const unlisted = await callRoute(t.app, {
      method: 'POST',
      url: '/v1/events',
      as: traveler,
      body: { name: 'meetup_locked', meetupId: meetup.id, placeId: place.id },
    });
    expectError(unlisted, 400, 'invalid_field');
    const notAMember = await callRoute(t.app, {
      method: 'POST',
      url: '/v1/events',
      as: stranger,
      body: {
        name: 'suggestion_place_opened',
        meetupId: meetup.id,
        placeId: place.id,
        placeCategory: 'restaurant',
      },
    });
    expectError(notAMember, 400, 'invalid_field');
    expect(await t.services.db.analyticsEvent.count()).toBe(1);
  });
});

/**
 * The re-enable AAP 0.5.6 requires and only an operator can make: a counted-versus-reported input-token mismatch suspends
 * language-model use in every city, and the Calls panel's control ends the suspension. The flag lives in the Redis the app and the
 * suite share, so a case sets it exactly as `SuspensionStore.suspend` does, then reads what the route left behind.
 *
 * The route's own `503 service_unavailable` refusal is not staged here: a Redis that answers nothing is refused at the limiter
 * first. `apps/api/test/unit/admin-llm-suspension.test.ts` covers it.
 */
describe('the language-model re-enable (AAP 0.5.6)', () => {
  const reEnableUrl = '/v1/admin/language-model/re-enable';
  /** The suspension a mismatch sets: the shared flag, and a cumulative counter worth noticing. */
  async function suspendLanguageModel(mismatches: number): Promise<void> {
    await t.services.redis.client.set(
      LLM_SUSPENDED_KEY,
      JSON.stringify({ since: t.clock.now().toISOString(), reason: 'llm_count_mismatch' }),
    );
    await t.services.redis.client.set(LLM_COUNT_MISMATCHES_KEY, String(mismatches));
  }
  it('clears the flag the dashboard reports and leaves the mismatch counter standing', async () => {
    await suspendLanguageModel(3);
    const before = await metrics();
    expect(before.calls.llmSuspended).toBe(true);
    expect(before.calls.llmCountMismatches).toBe(3);
    const response = await asOperator('POST', reEnableUrl);
    expect(response.status, response.body).toBe(200);
    // The answer is the flag as the clear left it, beside the counter: the count is the spend panel's
    // evidence, and only the flag is the suspension (AAP 0.5.6).
    expect(AdminLlmSuspension.parse(response.json())).toEqual({ suspended: false, mismatches: 3 });
    expect(await t.services.redis.client.get(LLM_SUSPENDED_KEY)).toBeNull();
    expect(await t.services.redis.client.get(LLM_COUNT_MISMATCHES_KEY)).toBe('3');
    const after = await metrics();
    expect(after.calls.llmSuspended).toBe(false);
    expect(after.calls.llmCountMismatches).toBe(3);
  });

  it('answers a flag that is already clear, so a second press is harmless', async () => {
    // `resetState` flushed the flag with the rest of Redis, which is the state an operator reaches by
    // pressing the control after the suspension has gone.
    const response = await asOperator('POST', reEnableUrl);
    expect(response.status, response.body).toBe(200);
    expect(AdminLlmSuspension.parse(response.json())).toEqual({ suspended: false, mismatches: 0 });
  });

  it('refuses a traveler and an anonymous caller', async () => {
    const asTraveler = await callRoute(t.app, { method: 'POST', url: reEnableUrl, as: traveler });
    expectError(asTraveler, 403, 'operator_only');
    // No bearer at all: refused as a token failure, before any role is considered.
    const anonymous = await callRoute(t.app, { method: 'POST', url: reEnableUrl });
    expectError(anonymous, 401, 'token_invalid');
  });
});
