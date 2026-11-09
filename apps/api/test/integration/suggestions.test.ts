/**
 * Integration tests for `GET /v1/meetups/:id/suggestions` — success criterion 13 and the failure
 * isolation the route owes the meetup flow. Nothing of the suggestions read is stubbed.
 *
 * Two rules the cases turn on: the freshness boundary of each price source is one row per case, and
 * the suggestions window is computed in the city's own zone. Every case starts two hours before a
 * meetup that begins at 13:00 Lisbon wall-clock time on a summer Monday, so the window runs
 * 14:00–23:00 city time — and the fixtures on either side of it are the ones a window computed in
 * UTC would lose or wrongly admit.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Prisma } from '@tablemate/db';
import {
  BUDGET_MAX_CENTS,
  BUDGET_MIN_CENTS,
  CHECK_IN_CLOSES_AFTER_MINUTES,
  DAY_MS,
  DEFAULT_BUDGET_BY_DEPOSIT,
  FRESHNESS_ONLINE_DAYS,
  FRESHNESS_PHONE_OPERATOR_DAYS,
  HOUR_MS,
  MINUTE_MS,
  SUGGESTIONS_MAX,
  SUGGESTIONS_PER_CATEGORY_MAX,
  SUGGESTIONS_SETTLED_ELIGIBLE_HOURS,
  SUGGESTION_RADIUS_METERS,
  SuggestionsResponse,
} from '@tablemate/shared';
import type {
  DepositCents,
  LatLng,
  MeetupStatus,
  PlaceCategory,
  PriceSource,
  TicketType,
} from '@tablemate/shared';

import { createTestApp, type TestApp } from '../support/app.ts';
import {
  callRoute,
  checkIn,
  expectError,
  makeMeetup,
  makePlace,
  makePriceRecords,
  makeUser,
  makeVenue,
  rows,
  stripeModeLabel,
} from '../support/factories.ts';
import type {
  MeetupFixture,
  PlaceFixture,
  PriceItemFixture,
  RouteResponse,
  UserFixture,
  VenueFixture,
} from '../support/factories.ts';

/** The launch city these cases run in: a zone with a summer offset, so UTC and local time differ. */
const CITY = 'lisbon';

const DEPOSIT_CENTS: DepositCents = 1000;

const BUDGET_CENTS = DEFAULT_BUDGET_BY_DEPOSIT[DEPOSIT_CENTS];

/**
 * The meetup's start: Monday 2026-07-13 at 13:00 Lisbon wall-clock time. Lisbon is UTC+1 in July,
 * so the instant is 12:00Z and the suggestions window — an hour after the start to
 * `SUGGESTION_LOCAL_CUTOFF` on the meetup's own local day — is 14:00–23:00 city time. Every
 * opening-hours value below is written in that same city time.
 */
const STARTS_AT = new Date('2026-07-13T12:00:00.000Z');

const BASE = new Date(STARTS_AT.getTime() - 2 * HOUR_MS);

const SETTLE_AFTER_MS = CHECK_IN_CLOSES_AFTER_MINUTES * MINUTE_MS;

const METERS_PER_DEGREE = 111_320;

/** The `opening_hours` values these cases are built from, all in Lisbon wall-clock time. */
const HOURS = {
  always: 'Mo-Su 08:00-23:30',
  late: 'Mo-Su 12:00-23:30',
  /**
   * Open 13:30–14:30 only: inside the window's first half hour in Lisbon time, and wholly before it
   * if the hours are ever evaluated in UTC (12:30–13:30 there, against a window starting at 13:00Z).
   */
  windowOnly: 'Mo-Su 13:30-14:30',
  /**
   * Open only in the window's last half hour, 22:30–23:00 of it. A place like this is the one a
   * window computed in UTC loses: that window ends an hour earlier, at 22:00 Lisbon time.
   */
  eveningOpen: 'Mo-Su 22:30-23:30',
  morningOnly: 'Mo-Su 08:00-12:00',
  /** Shut a quarter of an hour before the window opens — the row a UTC window wrongly admits. */
  beforeWindow: 'Mo-Su 12:30-13:45',
} as const;

const MENU_URL = 'https://fixtures.invalid/tablemate-menu';

function offsetMeters(origin: LatLng, north: number, east: number): LatLng {
  return {
    lat: origin.lat + north / METERS_PER_DEGREE,
    lng: origin.lng + east / (METERS_PER_DEGREE * Math.cos((origin.lat * Math.PI) / 180)),
  };
}

function venuePoint(venue: VenueFixture): LatLng {
  return { lat: venue.lat, lng: venue.lng };
}

function venueSecret(venue: VenueFixture): string {
  if (venue.secret === null) {
    throw new Error('the fixture venue has no console secret');
  }
  return venue.secret;
}

/** The days a price of `source` stays fresh (AAP 0.5.7): 30 for an online menu, 60 for the rest. */
function freshnessWindowDays(source: PriceSource): number {
  return source === 'online_menu' ? FRESHNESS_ONLINE_DAYS : FRESHNESS_PHONE_OPERATOR_DAYS;
}

/**
 * Inject `GET /v1/meetups/:id/suggestions` as `actor`, optionally supplying a budget.
 *
 * The bearer token is signed per request through `TestApp.tokenFor`, so a case that moved the clock
 * past the 15-minute access-token lifetime still acts as the same account. A supplied budget is the
 * route's `perPersonBudgetCents` query parameter, whose presence is also what stores the pair's
 * shared budget.
 */
async function readSuggestions(
  t: TestApp,
  meetup: { readonly id: string },
  actor: UserFixture,
  budgetCents?: number,
): Promise<RouteResponse> {
  return callRoute(t.app, {
    method: 'GET',
    url: `/v1/meetups/${meetup.id}/suggestions`,
    as: await t.tokenFor(actor),
    ...(budgetCents === undefined ? {} : { query: { perPersonBudgetCents: String(budgetCents) } }),
  });
}

function parseSuggestions(response: RouteResponse): SuggestionsResponse {
  return SuggestionsResponse.parse(response.json());
}

function mainItem(usdCents: number, source: PriceSource, capturedAt?: Date): PriceItemFixture {
  return {
    name: 'Main course',
    itemCategory: 'main',
    usdCents,
    source,
    // Spread rather than passed as `undefined`, because `exactOptionalPropertyTypes` is on.
    ...(capturedAt === undefined ? {} : { capturedAt }),
  };
}

async function pricedPlace(
  t: TestApp,
  venue: VenueFixture,
  shape: {
    readonly category: PlaceCategory;
    readonly distanceM: number;
    readonly hours: string;
    readonly near?: LatLng;
    readonly menuUrl?: string;
  },
  ...items: readonly PriceItemFixture[]
): Promise<PlaceFixture> {
  const place = await makePlace(t, {
    cityId: CITY,
    distanceM: shape.distanceM,
    category: shape.category,
    openingHours: shape.hours,
    ...(shape.near === undefined ? {} : { near: shape.near }),
    ...(shape.menuUrl === undefined ? {} : { menuUrl: shape.menuUrl }),
  });
  if (items.length > 0) {
    await makePriceRecords(t, place, items);
  }
  return place;
}

function placeAt(places: ReadonlyMap<number, PlaceFixture>, distanceM: number): PlaceFixture {
  const place = places.get(distanceM);
  if (place === undefined) {
    throw new Error(`no seeded place at ${distanceM} m`);
  }
  return place;
}

interface Base {
  readonly initiator: UserFixture;
  readonly recipient: UserFixture;
  readonly venue: VenueFixture;
}

interface StoredView {
  readonly budgetCents: number | null;
  readonly budgetUpdatedBy: string | null;
  readonly suggestionsFirstViewedAt: Date | null;
}

async function storedView(t: TestApp, meetupId: string): Promise<StoredView> {
  return t.services.db.meetup.findUniqueOrThrow({
    where: { id: meetupId },
    select: { budgetCents: true, budgetUpdatedBy: true, suggestionsFirstViewedAt: true },
  });
}

/**
 * Create a meetup of the base pair in `status`. `makeMeetup` derives a settled meetup's `settledAt`
 * from its start — `startsAt + 45 min` — so a case ages one by moving the start. The base pair may
 * hold one open meetup at a time, which is why each group creates the meetup its own cases act on.
 */
async function meetupIn(
  t: TestApp,
  base: Base,
  status: MeetupStatus,
  options: { readonly settledHoursAgo?: number; readonly depositCents?: DepositCents } = {},
): Promise<MeetupFixture> {
  const reference = t.time.now();
  const hours = options.settledHoursAgo;
  const startsAt =
    hours === undefined
      ? undefined
      : new Date(reference.getTime() - hours * HOUR_MS - SETTLE_AFTER_MS);
  return makeMeetup(t, {
    status,
    initiator: base.initiator,
    recipient: base.recipient,
    venue: base.venue,
    ...(startsAt === undefined ? {} : { startsAt }),
    ...(options.depositCents === undefined ? {} : { depositCents: options.depositCents }),
  });
}

interface EligiblePlace {
  readonly category: PlaceCategory;
  readonly distanceM: number;
  readonly hours: string;
  readonly usdCents: number;
}

/**
 * The fifteen eligible places of criterion 13: five restaurants (the first linked to the meetup's
 * own venue so it becomes a partner place at 0 m), four cafes, three bars and three activities —
 * each within 2 km, open in the window and priced at or under the budget.
 *
 * The distances and prices are chosen so both limits bind and the order is decided by the rules:
 * five estimates sit in the 70%–100% band and rank before the cheaper ones, so the walk in rank
 * order fills exactly ten of the twelve candidates left after the three-per-category limit.
 */
const ELIGIBLE_PLACES: readonly EligiblePlace[] = [
  { category: 'restaurant', distanceM: 0, hours: HOURS.always, usdCents: 2600 },
  { category: 'restaurant', distanceM: 300, hours: HOURS.late, usdCents: 2400 },
  { category: 'restaurant', distanceM: 500, hours: HOURS.windowOnly, usdCents: 2300 },
  { category: 'restaurant', distanceM: 700, hours: HOURS.always, usdCents: 1200 },
  { category: 'restaurant', distanceM: 900, hours: HOURS.always, usdCents: 1000 },
  { category: 'cafe', distanceM: 200, hours: HOURS.always, usdCents: 2200 },
  { category: 'cafe', distanceM: 400, hours: HOURS.always, usdCents: 900 },
  { category: 'cafe', distanceM: 600, hours: HOURS.always, usdCents: 800 },
  { category: 'cafe', distanceM: 800, hours: HOURS.always, usdCents: 700 },
  { category: 'bar', distanceM: 250, hours: HOURS.always, usdCents: 2500 },
  { category: 'bar', distanceM: 450, hours: HOURS.eveningOpen, usdCents: 1500 },
  { category: 'bar', distanceM: 650, hours: HOURS.always, usdCents: 1400 },
  { category: 'activity', distanceM: 350, hours: HOURS.always, usdCents: 1800 },
  { category: 'activity', distanceM: 550, hours: HOURS.always, usdCents: 1100 },
  { category: 'activity', distanceM: 750, hours: HOURS.always, usdCents: 1000 },
];

function ticketItem(
  name: string,
  usdCents: number,
  perPerson: boolean,
  ticketType: TicketType,
): PriceItemFixture {
  return { name, itemCategory: 'ticket', usdCents, source: 'online_menu', perPerson, ticketType };
}

function eligibleItem(row: EligiblePlace): PriceItemFixture {
  if (row.category === 'activity') {
    return ticketItem('Admission', row.usdCents, true, 'standard');
  }
  return mainItem(row.usdCents, 'online_menu');
}

/**
 * Write the eligible set, one place and its single price record at a time, and return the places
 * keyed by their distance from the venue. Every price is captured at the clock's now, so each is
 * fresh for its source and the ranked list's `priceVerifiedAt` is the instant a case reads.
 */
async function seedEligibleSet(
  t: TestApp,
  venue: VenueFixture,
): Promise<Map<number, PlaceFixture>> {
  const seeded = new Map<number, PlaceFixture>();
  for (const row of ELIGIBLE_PLACES) {
    const place = await pricedPlace(
      t,
      venue,
      { category: row.category, distanceM: row.distanceM, hours: row.hours },
      eligibleItem(row),
    );
    seeded.set(row.distanceM, place);
  }
  return seeded;
}

/**
 * The places criterion 13's response must not carry, keyed by the reason each is out: beyond the
 * radius, unpriced, shut in the window, stale, awaiting review, or over the budget. Each is
 * otherwise eligible, so a place appearing in the response would be a rule failing rather than a
 * fixture that never qualified.
 */
async function seedIneligibleSet(
  t: TestApp,
  venue: VenueFixture,
): Promise<Map<string, PlaceFixture>> {
  const origin = venuePoint(venue);
  const now = t.time.now();
  const seeded = new Map<string, PlaceFixture>();
  const seed = async (
    key: string,
    shape: Parameters<typeof pricedPlace>[2],
    ...items: readonly PriceItemFixture[]
  ): Promise<PlaceFixture> => {
    const place = await pricedPlace(t, venue, shape, ...items);
    seeded.set(key, place);
    return place;
  };
  // 2.1 km due north, and 2.19 km north-east: the radius is a distance, not a north-only bound.
  await seed(
    'beyond_radius',
    { category: 'restaurant', distanceM: 2100, hours: HOURS.always },
    mainItem(1500, 'online_menu'),
  );
  await seed(
    'beyond_radius_diagonal',
    {
      category: 'restaurant',
      distanceM: 0,
      hours: HOURS.always,
      near: offsetMeters(origin, 1600, 1500),
    },
    mainItem(1500, 'online_menu'),
  );
  // No price record at all, and the two rows on either side of the window's opening instant: one shut
  // at 13:45 Lisbon time, one open across the window from a later start.
  await seed('unpriced', { category: 'bar', distanceM: 1400, hours: HOURS.always });
  await seed(
    'before_window',
    { category: 'cafe', distanceM: 1100, hours: HOURS.beforeWindow },
    mainItem(1200, 'online_menu'),
  );
  await seed(
    'closed_in_window',
    { category: 'cafe', distanceM: 1300, hours: HOURS.morningOnly },
    mainItem(1400, 'online_menu'),
  );
  // No `opening_hours` value at all: priced, and never open (AAP 0.5.7).
  const noHours = await seed(
    'no_opening_hours',
    { category: 'cafe', distanceM: 1200, hours: HOURS.always },
    mainItem(1300, 'online_menu'),
  );
  await t.services.db.place.update({ where: { id: noHours.id }, data: { openingHours: null } });
  // Stale on both sources it carries: 31 days old online, 61 by phone.
  await seed(
    'stale_prices',
    { category: 'bar', distanceM: 1500, hours: HOURS.always },
    mainItem(1500, 'online_menu', new Date(now.getTime() - (FRESHNESS_ONLINE_DAYS + 1) * DAY_MS)),
    mainItem(
      1600,
      'phone_quote',
      new Date(now.getTime() - (FRESHNESS_PHONE_OPERATOR_DAYS + 1) * DAY_MS),
    ),
  );
  // Only a record awaiting operator review, which the price query never reads (AAP 0.5.6).
  await seed(
    'needs_review',
    { category: 'bar', distanceM: 1600, hours: HOURS.always },
    {
      name: 'Main course',
      itemCategory: 'main',
      usdCents: 1500,
      source: 'online_menu',
      reviewStatus: 'needs_review',
    },
  );
  // Fresh, open, and priced above the 3,000-cent budget.
  await seed(
    'over_budget',
    { category: 'restaurant', distanceM: 1700, hours: HOURS.always },
    mainItem(BUDGET_CENTS + 1000, 'online_menu'),
  );
  return seeded;
}

interface EligibilityRow {
  readonly label: string;
  readonly status: MeetupStatus;
  readonly settledHoursAgo?: number;
}

/** The statuses the route refuses with `409 meetup_not_locked`, a proposal among them. */
const NOT_LOCKED_ROWS: readonly EligibilityRow[] = [
  { label: 'proposed', status: 'proposed' },
  { label: 'forfeited', status: 'forfeited' },
  { label: 'completed and settled 25 hours ago', status: 'completed', settledHoursAgo: 25 },
];

/** The statuses it serves: a locked meetup, and a completed one inside the 24-hour window. */
const SERVED_ROWS: readonly EligibilityRow[] = [
  { label: 'locked', status: 'locked' },
  { label: 'completed and settled 23 hours ago', status: 'completed', settledHoursAgo: 23 },
  // Both ends of the window are inclusive (AAP 0.5.4): exactly 24 hours still serves.
  {
    label: `completed and settled exactly ${SUGGESTIONS_SETTLED_ELIGIBLE_HOURS} hours ago`,
    status: 'completed',
    settledHoursAgo: SUGGESTIONS_SETTLED_ELIGIBLE_HOURS,
  },
];

interface FreshnessRow {
  readonly label: string;
  readonly source: PriceSource;
  readonly ageDays: number;
  readonly fresh: boolean;
}

/** The four boundaries of AAP 0.5.7: both ends of each source's freshness window. */
const FRESHNESS_ROWS: readonly FreshnessRow[] = [
  {
    label: `an online-menu price exactly ${FRESHNESS_ONLINE_DAYS} days old is fresh`,
    source: 'online_menu',
    ageDays: FRESHNESS_ONLINE_DAYS,
    fresh: true,
  },
  {
    label: `an online-menu price ${FRESHNESS_ONLINE_DAYS + 1} days old is stale`,
    source: 'online_menu',
    ageDays: FRESHNESS_ONLINE_DAYS + 1,
    fresh: false,
  },
  {
    label: `a phone quote exactly ${FRESHNESS_PHONE_OPERATOR_DAYS} days old is fresh`,
    source: 'phone_quote',
    ageDays: FRESHNESS_PHONE_OPERATOR_DAYS,
    fresh: true,
  },
  {
    label: `a phone quote ${FRESHNESS_PHONE_OPERATOR_DAYS + 1} days old is stale`,
    source: 'phone_quote',
    ageDays: FRESHNESS_PHONE_OPERATOR_DAYS + 1,
    fresh: false,
  },
];

describe(`GET /v1/meetups/:id/suggestions ${stripeModeLabel()} (criterion 13)`, () => {
  let t: TestApp;
  let base: Base;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.resetState();
    await t.seedCities();
    // The base instant, set before any fixture is written: a session, a meetup and a price record all
    // date from the clock a case reads them at.
    t.time.at(BASE);
    base = {
      initiator: await makeUser(t, {}),
      recipient: await makeUser(t, {}),
      venue: await makeVenue(t, { cityId: CITY }),
    };
  });
  describe('the ranked day plan of criterion 13', () => {
    let meetup: MeetupFixture;
    let eligible: Map<number, PlaceFixture>;
    let ineligible: Map<string, PlaceFixture>;
    beforeEach(async () => {
      meetup = await meetupIn(t, base, 'locked');
      eligible = await seedEligibleSet(t, base.venue);
      ineligible = await seedIneligibleSet(t, base.venue);
      // The meetup's own venue is linked to the place at 0 m, which is what makes that place a partner
      // place: the first ranking key puts it before every other candidate (AAP 0.5.7).
      await t.services.db.venue.update({
        where: { id: base.venue.id },
        data: { placeId: placeAt(eligible, 0).id },
      });
    });
    it('serves at most ten places, within every filter, with the partner place first', async () => {
      const response = await readSuggestions(t, meetup, base.initiator, BUDGET_CENTS);
      expect(response.status).toBe(200);
      const parsed = parseSuggestions(response);
      expect(parsed.budgetCents).toBe(BUDGET_CENTS);
      expect(parsed.emptyReason).toBeUndefined();
      expect(parsed.items).toHaveLength(SUGGESTIONS_MAX);
      const [first] = parsed.items;
      expect(first?.placeId).toBe(placeAt(eligible, 0).id);
      expect(first?.isPartnerVenue).toBe(true);
      expect(first?.distanceM).toBe(0);
      // Everything returned is inside the radius, inside the budget, priced from a record fresh for its
      // own source, and no category reached a fourth place (AAP 0.5.7).
      const perCategory = new Map<PlaceCategory, number>();
      for (const item of parsed.items) {
        expect(item.distanceM).toBeLessThanOrEqual(SUGGESTION_RADIUS_METERS);
        expect(item.estimatedCostRange.estimateCents).toBeLessThanOrEqual(BUDGET_CENTS);
        expect(Date.parse(item.priceVerifiedAt)).toBeGreaterThanOrEqual(
          BASE.getTime() - freshnessWindowDays(item.priceSource) * DAY_MS,
        );
        perCategory.set(item.category, (perCategory.get(item.category) ?? 0) + 1);
      }
      for (const count of perCategory.values()) {
        expect(count).toBeLessThanOrEqual(SUGGESTIONS_PER_CATEGORY_MAX);
      }
      // The restaurant open 13:30–14:30 only is served, and its hours are rendered in the city's own
      // time: read in UTC the same value would render as 12:30–13:30, before the window opens.
      const windowOnly = parsed.items.find((item) => item.placeId === placeAt(eligible, 500).id);
      expect(windowOnly?.openingHoursToday).toBe('13:30–14:30');
      // The bar open 22:30–23:30 is served too, which a window computed in UTC would lose: that window
      // would end an hour earlier, at 22:00 Lisbon time, leaving the bar shut in it.
      expect(parsed.items.map((item) => item.placeId)).toContain(placeAt(eligible, 450).id);
      // Not one ineligible place is present, under any of the reasons it was built for.
      const returned = new Set(parsed.items.map((item) => item.placeId));
      for (const [reason, place] of ineligible) {
        expect({ reason, returned: returned.has(place.id) }).toEqual({ reason, returned: false });
      }
    });
  });
  describe('the freshness boundary of each price source', () => {
    it.each(rows(FRESHNESS_ROWS))('honours the boundary where $label', async (row) => {
      const meetup = await meetupIn(t, base, 'locked');
      const capturedAt = new Date(BASE.getTime() - row.ageDays * DAY_MS);
      const place = await pricedPlace(
        t,
        base.venue,
        { category: 'cafe', distanceM: 300, hours: HOURS.always },
        mainItem(2300, row.source, capturedAt),
      );
      const parsed = parseSuggestions(
        await readSuggestions(t, meetup, base.initiator, BUDGET_CENTS),
      );
      const returned = parsed.items.map((item) => item.placeId);
      if (row.fresh) {
        expect(returned).toEqual([place.id]);
        expect(parsed.items[0]?.priceVerifiedAt).toBe(capturedAt.toISOString());
        return;
      }
      // A place whose only price is stale is not priced at all, which is the first empty reason.
      expect(returned).toEqual([]);
      expect(parsed.emptyReason).toBe('no_priced_places');
    });
  });
  describe('eligibility and the contract errors (AAP 0.5.4, 0.7.3)', () => {
    it('answers 404 for a meetup that does not exist', async () => {
      const response = await readSuggestions(t, { id: randomUUID() }, base.initiator);
      expectError(response, 404, 'meetup_not_found');
    });
    it('answers 403 for a traveler who is not a participant', async () => {
      const meetup = await meetupIn(t, base, 'locked');
      const stranger = await makeUser(t, {});
      expectError(await readSuggestions(t, meetup, stranger), 403, 'not_participant');
    });
    it.each(rows(NOT_LOCKED_ROWS))('answers 409 for a $label meetup', async (row) => {
      const meetup = await meetupIn(
        t,
        base,
        row.status,
        row.settledHoursAgo === undefined ? {} : { settledHoursAgo: row.settledHoursAgo },
      );
      const response = await readSuggestions(t, meetup, base.initiator, BUDGET_CENTS);
      expectError(response, 409, 'meetup_not_locked');
      // The status is checked before anything is written: the supplied budget was not stored.
      expect((await storedView(t, meetup.id)).budgetCents).toBeNull();
    });
    it.each(rows(SERVED_ROWS))('serves a $label meetup', async (row) => {
      const meetup = await meetupIn(
        t,
        base,
        row.status,
        row.settledHoursAgo === undefined ? {} : { settledHoursAgo: row.settledHoursAgo },
      );
      const response = await readSuggestions(t, meetup, base.initiator, BUDGET_CENTS);
      expect(response.status).toBe(200);
      const parsed = parseSuggestions(response);
      expect(parsed.budgetCents).toBe(BUDGET_CENTS);
      expect(parsed.items).toEqual([]);
      expect(parsed.emptyReason).toBe('no_priced_places');
    });
    it.each(rows([BUDGET_MIN_CENTS - 1, BUDGET_MAX_CENTS + 1]))(
      'answers 422 for a per-person budget of %i cents, and stores nothing',
      async (budgetCents) => {
        const meetup = await meetupIn(t, base, 'locked');
        const response = await readSuggestions(t, meetup, base.initiator, budgetCents);
        expectError(response, 422, 'budget_out_of_range');
        expect((await storedView(t, meetup.id)).budgetCents).toBeNull();
      },
    );
    it.each(rows([BUDGET_MIN_CENTS, BUDGET_MAX_CENTS]))(
      'serves a per-person budget of %i cents and stores it for the pair',
      async (budgetCents) => {
        const meetup = await meetupIn(t, base, 'locked');
        const parsed = parseSuggestions(
          await readSuggestions(t, meetup, base.initiator, budgetCents),
        );
        expect(parsed.budgetCents).toBe(budgetCents);
        expect(parsed.emptyReason).toBe('no_priced_places');
        expect((await storedView(t, meetup.id)).budgetCents).toBe(budgetCents);
      },
    );
  });
  describe("the pair's shared budget and the first view", () => {
    it("ranks against the deposit level's default while the pair has stored none", async () => {
      const meetup = await meetupIn(t, base, 'locked');
      const parsed = parseSuggestions(await readSuggestions(t, meetup, base.initiator));
      expect(parsed.budgetCents).toBe(BUDGET_CENTS);
      // The default is computed, never written: the pair's own budget column stays empty, and the read
      // still stamps its first view, which is the other write this route owes (AAP 0.5.4).
      const stored = await storedView(t, meetup.id);
      expect(stored.budgetCents).toBeNull();
      expect(stored.suggestionsFirstViewedAt).toEqual(BASE);
    });
    it('lets either attendee replace the shared budget, the latest write winning', async () => {
      const meetup = await meetupIn(t, base, 'locked');
      const supplied = parseSuggestions(await readSuggestions(t, meetup, base.initiator, 2000));
      expect(supplied.budgetCents).toBe(2000);
      const afterInitiator = await storedView(t, meetup.id);
      expect(afterInitiator.budgetCents).toBe(2000);
      expect(afterInitiator.budgetUpdatedBy).toBe(base.initiator.id);
      // The recipient reads the budget the initiator stored, without supplying one of their own.
      const shared = parseSuggestions(await readSuggestions(t, meetup, base.recipient));
      expect(shared.budgetCents).toBe(2000);
      const replaced = parseSuggestions(await readSuggestions(t, meetup, base.recipient, 4000));
      expect(replaced.budgetCents).toBe(4000);
      const afterRecipient = await storedView(t, meetup.id);
      expect(afterRecipient.budgetCents).toBe(4000);
      expect(afterRecipient.budgetUpdatedBy).toBe(base.recipient.id);
    });
    it('stamps the first view once, on the first read, and never moves it', async () => {
      const meetup = await meetupIn(t, base, 'locked');
      expect((await storedView(t, meetup.id)).suggestionsFirstViewedAt).toBeNull();
      const first = await readSuggestions(t, meetup, base.initiator);
      expect(first.status).toBe(200);
      expect((await storedView(t, meetup.id)).suggestionsFirstViewedAt).toEqual(BASE);
      // A later read, by the other attendee and half an hour on, leaves the stamp where it is.
      t.time.advance({ minutes: 30 });
      const later = await readSuggestions(t, meetup, base.recipient, 2000);
      expect(later.status).toBe(200);
      expect((await storedView(t, meetup.id)).suggestionsFirstViewedAt).toEqual(BASE);
    });
  });
  describe('empty reasons, tickets and provenance (AAP 0.5.6, 0.5.7)', () => {
    it('names no_priced_places when nothing near the venue carries a price', async () => {
      const meetup = await meetupIn(t, base, 'locked');
      const parsed = parseSuggestions(
        await readSuggestions(t, meetup, base.initiator, BUDGET_CENTS),
      );
      expect(parsed.items).toEqual([]);
      expect(parsed.emptyReason).toBe('no_priced_places');
    });
    it('names none_open when every priced place is shut in the window', async () => {
      const meetup = await meetupIn(t, base, 'locked');
      await pricedPlace(
        t,
        base.venue,
        { category: 'cafe', distanceM: 300, hours: HOURS.morningOnly },
        mainItem(1500, 'online_menu'),
      );
      const parsed = parseSuggestions(
        await readSuggestions(t, meetup, base.initiator, BUDGET_CENTS),
      );
      expect(parsed.items).toEqual([]);
      expect(parsed.emptyReason).toBe('none_open');
    });
    it('names budget_too_low when every open place is over it, and stores the raised budget', async () => {
      const meetup = await meetupIn(t, base, 'locked');
      await pricedPlace(
        t,
        base.venue,
        { category: 'cafe', distanceM: 300, hours: HOURS.always },
        mainItem(BUDGET_MIN_CENTS + 400, 'online_menu'),
      );
      const parsed = parseSuggestions(
        await readSuggestions(t, meetup, base.initiator, BUDGET_MIN_CENTS),
      );
      expect(parsed.items).toEqual([]);
      expect(parsed.emptyReason).toBe('budget_too_low');
      expect(parsed.budgetCents).toBe(BUDGET_MIN_CENTS);
      expect((await storedView(t, meetup.id)).budgetCents).toBe(BUDGET_MIN_CENTS);
    });
    it('prices an activity by its standard per-person ticket, leaving a concession-only one out', async () => {
      const meetup = await meetupIn(t, base, 'locked');
      const standard = await pricedPlace(
        t,
        base.venue,
        { category: 'activity', distanceM: 300, hours: HOURS.always },
        ticketItem('Admission', 1200, true, 'standard'),
      );
      await pricedPlace(
        t,
        base.venue,
        { category: 'activity', distanceM: 400, hours: HOURS.always },
        ticketItem('Concession admission', 800, true, 'concession'),
        ticketItem('Family admission', 2000, false, 'group'),
      );
      const parsed = parseSuggestions(
        await readSuggestions(t, meetup, base.initiator, BUDGET_CENTS),
      );
      // Only the standard ticket is an estimate, and the lowest listed one decides it (AAP 0.5.6).
      expect(parsed.items.map((item) => item.placeId)).toEqual([standard.id]);
      expect(parsed.items[0]?.estimatedCostRange).toEqual({
        estimateCents: 1200,
        lowCents: 1200,
        highCents: 1200,
      });
    });
    it('reports the provenance of the prices used, the oldest capture as the verification', async () => {
      const meetup = await meetupIn(t, base, 'locked');
      const phoneCapturedAt = new Date(BASE.getTime() - 10 * DAY_MS);
      const onlineCapturedAt = new Date(BASE.getTime() - 5 * DAY_MS);
      const place = await pricedPlace(
        t,
        base.venue,
        { category: 'restaurant', distanceM: 300, hours: HOURS.always, menuUrl: MENU_URL },
        mainItem(1500, 'phone_quote', phoneCapturedAt),
        {
          name: 'House coffee',
          itemCategory: 'drink',
          usdCents: 300,
          source: 'online_menu',
          alcoholic: false,
          capturedAt: onlineCapturedAt,
        },
      );
      const parsed = parseSuggestions(
        await readSuggestions(t, meetup, base.initiator, BUDGET_CENTS),
      );
      const item = parsed.items.find((entry) => entry.placeId === place.id);
      // The estimate is the median main plus the median non-alcoholic drink, and both records are
      // reported with the source, the instant and the URL they were read from (AAP 0.5.7).
      expect(item?.estimatedCostRange.estimateCents).toBe(1800);
      expect(item?.priceSource).toBe('phone_quote');
      expect(item?.priceVerifiedAt).toBe(phoneCapturedAt.toISOString());
      const used = item?.itemsUsed ?? [];
      expect(used).toHaveLength(2);
      const quote = used.find((entry) => entry.source === 'phone_quote');
      expect(quote?.priceUsdCents).toBe(1500);
      expect(quote?.sourceUrl).toBe(`tel:${place.phone}`);
      expect(quote?.capturedAt).toBe(phoneCapturedAt.toISOString());
      const menu = used.find((entry) => entry.source === 'online_menu');
      expect(menu?.priceUsdCents).toBe(300);
      expect(menu?.sourceUrl).toBe(MENU_URL);
      expect(menu?.capturedAt).toBe(onlineCapturedAt.toISOString());
    });
  });
  describe('a failure of the read stays on this route (AAP 0.3.2, 0.12.2)', () => {
    it('answers 503 while the price table cannot be read, and a check-in still succeeds', async () => {
      const meetup = await meetupIn(t, base, 'locked');
      await pricedPlace(
        t,
        base.venue,
        { category: 'cafe', distanceM: 300, hours: HOURS.always },
        mainItem(1500, 'online_menu'),
      );
      // Check-in opens fifteen minutes before the start, so the meetup is inside its window.
      t.time.toMeetupPoint(meetup, 'startsAt');
      // The price table is renamed rather than emptied, so every statement naming it fails while the
      // rename lasts. The `finally` undoes it even when an assertion above throws, because the database
      // is shared by the whole run.
      const isolate = Prisma.sql`ALTER TABLE "price_record" RENAME TO "price_record_isolation"`;
      const restore = Prisma.sql`ALTER TABLE "price_record_isolation" RENAME TO "price_record"`;
      try {
        await t.services.db.$executeRaw(isolate);
        const failed = await readSuggestions(t, meetup, base.initiator, BUDGET_CENTS);
        expectError(failed, 503, 'suggestions_unavailable');
        // The meetup flow reads no prices: the attendee can still check in.
        const checked = await checkIn(
          t,
          base.initiator,
          { id: meetup.id, venueId: base.venue.id },
          { venueSecret: venueSecret(base.venue), distanceM: 30 },
        );
        expect(checked.status).toBe('locked');
        expect(checked.bothCheckedIn).toBe(false);
      } finally {
        await t.services.db.$executeRaw(restore);
      }
      const recovered = await readSuggestions(t, meetup, base.initiator, BUDGET_CENTS);
      expect(recovered.status).toBe(200);
      expect(parseSuggestions(recovered).items).toHaveLength(1);
    });
  });
});
