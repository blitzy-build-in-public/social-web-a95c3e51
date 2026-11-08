/**
 * Integration tests for the operator routes of AAP 0.5.4 and the additive `POST /v1/events`
 * (AAP 0.8.1 lists this file; AAP 0.5.3 requires each operator outcome, the `do_not_call` side
 * effects and the refusal for lodging tasks; AAP 0.5.7 requires a late cancellation asserted through
 * `GET /admin/metrics`).
 *
 * Six groups, in the order `admin/routes.ts` registers its routes: the guard every `/admin/*` route
 * shares, the dashboard, the dispute queue, the call-task queue, the lodging-claim queue with its
 * audited booking-details read, and the crawl-domain, onboarding, report and client-event routes.
 * The real app `createTestApp` builds runs against real PostgreSQL with PostGIS and real Redis, so
 * every assertion reads what a handler wrote: the status a resolution applied, the release
 * operations a `no_fault` planned, the prices an outcome stored, the audit row the booking-details
 * read wrote, and the job onboarding enqueued.
 *
 * **No case moves the clock.** AAP 0.11.1's 15-minute access token would expire under an hour-sized
 * jump, and the two boundaries these routes judge — the free-cancellation window of AAP 0.5.3 and
 * the check-in window's close — are reachable by placing a meetup's `startsAt` relative to the frozen
 * instant. Every answer is parsed with the shared schema its route declares, so a field the contract
 * does not carry fails the case rather than passing an assertion nobody wrote.
 *
 * @see AAP 0.5.4 for the routes, their guards and their errors, 0.5.3 for the lifecycles the
 *   resolutions apply, 0.5.7 for the metric definitions, 0.5.2 for the encrypted fields and the audit
 *   log, 0.3.2 for the after-commit enqueue, 0.11.2 for the harness, and 0.8.1 for this file.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Prisma } from '@tablemate/db';
import { QUEUE } from '@tablemate/server-core';
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
  AdminLodgingClaimDto,
  AdminLodgingClaimsResponse,
  AdminLodgingDto,
  AdminLodgingsResponse,
  AdminReportsResponse,
  AdminVenueDto,
  AdminVenuesResponse,
  BookingDetailsDto,
  MetricsDto,
  SecretIssued,
} from '@tablemate/shared';
import type {
  CallTaskStatus,
  CheckInResult,
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

/* Fixtures and helpers (AAP 0.11.1 density: one builder per shape, reused by every case) */

/** The city every fixture meetup, venue and place stands in. */
const LISBON = 'lisbon';
/** A second launch city, whose lodging exists only to prove a hand-entered row carries no OSM ids. */
const MEXICO_CITY = 'mexico-city';
/** The frozen clock's own day, as `MetricsQuery.from` and `.to` carry it (AAP 0.11.1). */
const TODAY = DEFAULT_TEST_NOW.slice(0, 10);

let t: TestApp;
/** The operator every `/admin/*` case acts as; no card, so no case places a hold for them. */
let operator: UserFixture;
/** The initiator of every fixture meetup. */
let traveler: UserFixture;
/** The invited counterpart of every fixture meetup. */
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

/** An instant `offsetMs` from the frozen clock, which every `startsAt` override is built from. */
function instant(offsetMs: number): Date {
  return new Date(t.clock.now().getTime() + offsetMs);
}

/** The `YYYY-MM-DD` day an instant falls in. */
function dayOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** A booking name unique to one case, generated at run time and never logged. */
function guestName(): string {
  return `Guest ${randomUUID().slice(0, 8)}`;
}

/** Inject one request as the operator. */
function asOperator(
  method: RouteRequest['method'],
  url: string,
  extra: { body?: Record<string, unknown>; query?: Record<string, string> } = {},
): Promise<RouteResponse> {
  return callRoute(t.app, { method, url, as: operator, ...extra });
}

/** `GET /admin/metrics` as the operator, parsed into the contract's dashboard (AAP 0.5.7). */
async function metrics(query: Record<string, string> = {}): Promise<MetricsDto> {
  const response = await asOperator('GET', '/v1/admin/metrics', {
    query: { from: TODAY, to: TODAY, ...query },
  });

  expect(response.status, response.body).toBe(200);
  return MetricsDto.parse(response.json());
}

/** The `place-refresh` payloads the queue holds, in every state a job waits in (AAP 0.3.2). */
async function placeRefreshPayloads(): Promise<unknown[]> {
  const jobs = await t.services.queues
    .get(QUEUE.placeRefresh)
    .getJobs(['waiting', 'prioritized', 'delayed']);

  // BullMQ types a payload as `any`; the cast keeps the read out of the lint rules that ban touching
  // an `any` member, and the comparison is on the value itself.
  return jobs.map((job) => job.data as unknown);
}

/* Group 1 — the guard every operator route shares (AAP 0.5.4) */

/** One route of the contract, named for the case title and built with ids at call time. */
interface AdminRouteCase {
  readonly name: string;
  readonly method: RouteRequest['method'];
  readonly url: () => string;
  readonly body?: Record<string, unknown>;
}

/**
 * Every route AAP 0.5.4 puts behind `role = operator`, the additive booking-details read included.
 * The group guard runs as an `onRequest` hook, before any parameter or body is validated, so the
 * answer is the guard's whatever a caller sends.
 */
const ADMIN_ROUTES = rows<AdminRouteCase>([
  {
    name: 'the dashboard',
    method: 'GET',
    url: () => `/v1/admin/metrics?from=${TODAY}&to=${TODAY}`,
  },
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

/* Group 2 — the dashboard (AAP 0.5.4, 0.5.7) */

describe('the dashboard (AAP 0.5.4, 0.5.7)', () => {
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

/* Group 3 — the dispute queue (AAP 0.5.3, 0.5.4) */

describe('the dispute queue (AAP 0.5.3, 0.5.4)', () => {
  /** The dispute routes, named once and used by every case below. */
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

  /** One row of the resolution table: the meetup's fixture state and the outcome applied to it. */
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

/* Group 4 — the call-task queue (AAP 0.5.3, 0.5.4) */

/**
 * A menu extraction in the shape the relay records it (AAP 0.5.6): a list of slot-tagged items, which
 * `admin/call-tasks.ts` flattens into the `<slot>.<field>` record the operator's form reads.
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
 * The prices an operator is told over the phone: a main course, a non-alcoholic drink, and one
 * standard per-person ticket — the one category whose two extra fields the contract requires, because
 * only a standard per-person ticket prices an activity (AAP 0.5.6, 0.5.7).
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
 * Write one attempt's extraction, which the builder's own option does not admit: it types the payload
 * as a flat record of scalars, while a menu call's extraction is a list of items (AAP 0.5.2). The cast
 * is the honest one — a JSON column Prisma types structurally rather than by the values it holds.
 */
function setExtraction(attemptId: string, payload: unknown): Promise<unknown> {
  return t.services.db.callAttempt.update({
    where: { id: attemptId },
    data: { extractedFields: payload as Prisma.InputJsonValue },
  });
}

/** A menu-price call task on the fixture place, in the state a case needs. */
function menuTask(status: CallTaskStatus): Promise<{ id: string }> {
  return makeCallTask(t, { kind: 'menu_prices', placeId: place.id, status });
}

/** `POST /admin/call-tasks/:id/resolve` as the operator. */
function resolveTask(taskId: string, body: Record<string, unknown>): Promise<RouteResponse> {
  return asOperator('POST', `/v1/admin/call-tasks/${taskId}/resolve`, { body });
}

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

  it('stops every other task of a place that asked not to be called', async () => {
    const task = await menuTask('needs_review');
    const companion = await menuTask('queued');
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
    // rather than reaching an outcome, so it records neither a resolver nor an instant.
    const cancelled = await t.services.db.callTask.findUniqueOrThrow({
      where: { id: companion.id },
      select: { outcomeAt: true, resolvedBy: true, status: true },
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.resolvedBy).toBeNull();
    expect(cancelled.outcomeAt).toBeNull();

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

/* Group 5 — lodging claims and the audited booking-details read (AAP 0.5.2, 0.5.3, 0.5.4) */

const CLAIMS_URL = '/v1/admin/lodging-claims';

/** The additive audited read of one claim's decrypted booking details (AAP 0.5.4). */
function bookingUrl(claimId: string): string {
  return `${CLAIMS_URL}/${claimId}/booking-details`;
}

/** `POST /admin/lodging-claims/:id/resolve` as the operator. */
function resolveClaim(claimId: string, outcome: string): Promise<RouteResponse> {
  return asOperator('POST', `${CLAIMS_URL}/${claimId}/resolve`, { body: { outcome } });
}

/** `GET /admin/lodging-claims` as the operator, parsed into the contract. */
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

/* Group 6 — crawl domains, onboarding, reports and the client event (AAP 0.5.2, 0.5.4, 0.5.6) */

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
