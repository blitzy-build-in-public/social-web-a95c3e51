/**
 * Criterion 7 — the framing experiment's integrity (AAP 0.5.7, 0.11.2, 0.12.1, 0.12.2).
 *
 * Four properties, each the one the request names for the experiment:
 *
 *  - **The split holds.** A thousand accounts created through the real magic-link routes land in
 *    `ExperimentAssignment` once each, `social` for 45%-55% of them, every row carrying the
 *    configured `shareAtAssignment` and an `assignmentId` of its own (AAP 0.12.1).
 *  - **The variant is once-only.** Signing the same addresses in again — and signing in after the
 *    configured split is replaced by the 100% `social` fallback — leaves every stored
 *    `(variant, assignmentId, assignedAt)` as the first sign-in wrote it, while accounts created
 *    after the change take the new split (AAP 0.5.7).
 *  - **Every funnel stage is attributed.** One real proposal, first read, acceptance, lock and pair
 *    of check-ins writes all six stages of `FUNNEL_EVENTS`, each row carrying its actor's stored
 *    variant and `assignmentId` in the columns and in the props, plus the pair's
 *    `Meetup.variantPairing` (AAP 0.5.7, 0.12.1).
 *  - **No event reconnects to a person.** `analytics_event` has no `user_id` column, and no stored
 *    row — no column of it, nothing in its `props` — contains a user id with or without its dashes
 *    (AAP 0.5.2, 0.12.2).
 *
 * Accounts come from `signIn`, the real magic-link and verify routes (AAP 0.5.4), because the
 * assignment is written by the verify transaction; the population passes `consent: false`, since it
 * reads no age-gated route and consents would double a thousand sign-ins' requests. Time comes only
 * from the injected clock, and nothing here logs an address or a token.
 *
 * @see AAP 0.5.7 for the assignment rule, the funnel stages and the attribution, 0.5.2 for the
 *   pseudonymous event row, 0.11.2 for the harness, 0.12.1 for criterion 7, 0.12.2 for the raw-id
 *   constraint it enforces, and 0.8.1 for this file.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { actorHash, waitForRedisReady } from '@tablemate/server-core';
import type { Variant, VariantPairing } from '@tablemate/shared';

import { FUNNEL_EVENTS } from '../../src/modules/analytics/emit.ts';
import { createTestApp } from '../support/app.ts';
import {
  checkIn,
  makeUser,
  makeVenue,
  proposeAndLock,
  signIn,
  stripeModeLabel,
} from '../support/factories.ts';

import type { TestApp } from '../support/app.ts';
import type { SignInResult, UserFixture } from '../support/factories.ts';

/** The population criterion 7 measures, how many sign-ins are in flight at once, and the sample. */
const POPULATION = 1_000;
const SIGN_IN_CONCURRENCY = 20;
const SAMPLE_STEP = 20;

/** How many accounts the split-change case creates after the share is raised. */
const NEW_ACCOUNTS = 50;

/** The band the `social` share must land in, the split every row records, and the 100% fallback. */
const SOCIAL_SHARE_MIN = 0.45;
const SOCIAL_SHARE_MAX = 0.55;
const DEFAULT_SHARE = 0.5;
const SOCIAL_ONLY = '1.0';

/** The IP allowance every app here is built with: a thousand sign-ins arrive from one address. */
const RATE_LIMIT_IP_PER_MIN = '100000';

/** How long the population case may take, over the integration project's 60-second default. */
const POPULATION_TIMEOUT_MS = 300_000;

/** The launch city the funnel's venue stands in, and how far from it each attendee checks in. */
const CITY = 'lisbon';
const CHECK_IN_DISTANCE_M = 30;

/** The population's addresses, the fifty sampled from them, and the split-change case's own. */
const EMAILS = Array.from({ length: POPULATION }, (_, index) => `exp-${index}@example.test`);
const SAMPLED_EMAILS = EMAILS.filter((_, index) => index % SAMPLE_STEP === 0);
const NEW_EMAILS = Array.from({ length: NEW_ACCOUNTS }, (_, i) => `exp-new-${i}@example.test`);

/**
 * The app the file drives. The split-change case replaces it with another built on the same
 * containers and the same per-process secrets, so both read one database (AAP 0.11.2).
 */
let app: TestApp;

/** What the stability cases compare against: the stored assignments, keyed by user id. */
let snapshot = new Map<string, StoredAssignment>();

/** The user id each population address signed in as, so a re-sign-in is matched to its account. */
let accounts = new Map<string, string>();

/** One stored assignment: the three fields stability is about, plus the split it was written under. */
interface StoredAssignment {
  readonly userId: string;
  readonly variant: Variant;
  readonly assignmentId: string;
  /** ISO form, so a comparison never depends on two `Date` objects' identity. */
  readonly assignedAt: string;
  readonly shareAtAssignment: number;
}

/** Build an app on the run's containers, with the IP allowance a thousand sign-ins need. */
function newApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  return createTestApp({ env: { RATE_LIMIT_IP_PER_MIN, ...overrides } });
}

/** Close the app the file drives and build the next one: same containers, same per-process secrets. */
async function rebuildApp(overrides: Record<string, string>): Promise<TestApp> {
  await app.close();
  app = await newApp(overrides);
  // Every connection an app holds is lazy and fail-fast (AAP 0.3.2): a command issued before its
  // first `ready` is rejected rather than queued. `resetState` awaits the one the rate-limit store
  // commands on, and this path replaces the app without one, so it awaits both here.
  await waitForRedisReady(app.services.redis.client);
  await waitForRedisReady(app.services.redis.producer);
  return app;
}

/**
 * Sign every address in through the real routes, at most {@link SIGN_IN_CONCURRENCY} at a time, and
 * answer what each sign-in returned, keyed by address. The batches run one after another: a thousand
 * simultaneous sign-in transactions would exhaust the client's connections and the database's locks
 * without exercising anything the experiment is about.
 */
async function signInAll(
  target: TestApp,
  emails: readonly string[],
): Promise<Map<string, SignInResult>> {
  const signedIn = new Map<string, SignInResult>();

  for (let start = 0; start < emails.length; start += SIGN_IN_CONCURRENCY) {
    const batch = emails.slice(start, start + SIGN_IN_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (email) => [email, await signIn(target, email, { consent: false })] as const),
    );
    for (const [email, result] of results) {
      signedIn.set(email, result);
    }
  }

  return signedIn;
}

/** Every stored assignment, keyed by user id (AAP 0.5.2). */
async function storedAssignments(target: TestApp): Promise<Map<string, StoredAssignment>> {
  const rows = await target.services.db.experimentAssignment.findMany();

  return new Map(
    rows.map((row) => [
      row.userId,
      {
        userId: row.userId,
        variant: row.variant,
        assignmentId: row.assignmentId,
        assignedAt: row.assignedAt.toISOString(),
        shareAtAssignment: row.shareAtAssignment,
      },
    ]),
  );
}

/**
 * Walk the whole deposit funnel once, through the real routes (AAP 0.5.4): two accounts with saved
 * visa cards and a valid proof each, a partner venue, the proposal, the recipient's first read — the
 * read that records it and emits `proposal_viewed` — the acceptance that locks both holds, and both
 * check-ins. The clock stands on the start for both, the one instant where the code the console
 * shows is the code the route validates (AAP 0.5.7).
 *
 * @throws {AssertionError} When a step answers outside its success range, or the second check-in
 *   does not report the pair as both checked in.
 */
async function walkFunnel(target: TestApp): Promise<{
  initiator: UserFixture;
  recipient: UserFixture;
  meetupId: string;
  variantPairing: VariantPairing;
}> {
  const initiator = await makeUser(target, { card: 'visa' });
  const recipient = await makeUser(target, { card: 'visa' });
  const venue = await makeVenue(target, { cityId: CITY });
  const { meetupId, startsAt } = await proposeAndLock(target, { initiator, recipient, venue });

  // The secret the fixture minted, which `checkIn` turns into the console's code by reading it back
  // through `GET /venue/check-in-code` rather than deriving a code of its own.
  expect(venue.secret).not.toBeNull();
  const options = { venueSecret: venue.secret ?? '', distanceM: CHECK_IN_DISTANCE_M };
  const attendee = { id: meetupId, venueId: venue.id };

  target.time.toMeetupPoint({ startsAt }, 'startsAt');
  const first = await checkIn(target, initiator, attendee, options);
  const second = await checkIn(target, recipient, attendee, options);
  expect(first.bothCheckedIn).toBe(false);
  expect(second.bothCheckedIn).toBe(true);

  const meetup = await target.services.db.meetup.findUniqueOrThrow({
    where: { id: meetupId },
    select: { variantPairing: true },
  });

  return { initiator, recipient, meetupId, variantPairing: meetup.variantPairing };
}

/** Every stored row of the six funnel stages, oldest first (AAP 0.5.7). */
async function funnelRows(target: TestApp) {
  return target.services.db.analyticsEvent.findMany({
    where: { name: { in: [...FUNNEL_EVENTS] } },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
}

/** A stored `props` value read as a plain record, so a case asserts one key at a time. */
function propsOf(props: unknown): Record<string, unknown> {
  return typeof props === 'object' && props !== null && !Array.isArray(props)
    ? (props as Record<string, unknown>)
    : {};
}

/**
 * Assert that no analytics row reconnects to a person (AAP 0.5.2, 0.12.2): the table carries no
 * `user_id` column, no stored row contains any user id in either spelling — the raw uuid and the
 * same 32 hex digits without its dashes — and no `actorHash` is itself a user id.
 *
 * Each row is serialized whole, every column and the whole `props` included, so a leak through a
 * column this scan does not name is found by the same comparison. The event id, the `assignmentId`
 * and the `meetupId` are ids of their own and name no account, which is the point: only a person's
 * id would.
 */
async function expectNoRawUserIds(target: TestApp): Promise<void> {
  const columns = await target.services.db.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'analytics_event'
  `;
  const names = columns.map((column) => column.column_name);
  // A wrong table name would otherwise leave the scan checking nothing at all.
  expect(names.length).toBeGreaterThan(0);
  expect(names).not.toContain('user_id');

  const users = await target.services.db.user.findMany({ select: { id: true } });
  const events = await target.services.db.analyticsEvent.findMany();
  expect(users.length).toBeGreaterThan(0);
  expect(events.length).toBeGreaterThan(0);

  const needles = new Set<string>();
  for (const user of users) {
    needles.add(user.id.replaceAll('-', '').toLowerCase());
    needles.add(user.id.toLowerCase());
  }

  const leaks: string[] = [];
  for (const event of events) {
    const serialized = JSON.stringify(event).toLowerCase();
    for (const needle of needles) {
      if (serialized.includes(needle))
        leaks.push(`${event.id} (${event.name}) holds an account id`);
    }
    if (event.actorHash !== null && needles.has(event.actorHash.toLowerCase())) {
      leaks.push(`${event.id} (${event.name}) acts as a raw account id`);
    }
  }
  expect(leaks).toEqual([]);
}

beforeAll(async () => {
  app = await newApp();
});

afterAll(async () => {
  await app.close();
});

describe('the population of new accounts', () => {
  beforeAll(async () => {
    // The population cases build on one another, so the reset belongs to their own group rather
    // than to the file: the first case signs the population in, and each case that reads it asserts
    // it first, so a missing population fails on its own terms instead of cascading into whichever
    // case ran next.
    await app.resetState();
    await app.seedCities();
  });

  it(
    'assigns a thousand accounts once each and lands the social share inside its band',
    { timeout: POPULATION_TIMEOUT_MS },
    async () => {
      const signedIn = await signInAll(app, EMAILS);
      expect(signedIn.size).toBe(POPULATION);

      const stored = await storedAssignments(app);
      expect(stored.size).toBe(POPULATION);

      // One account, one assignment — a shared `assignmentId` would attribute two travellers'
      // funnels to one record — and every row written by the account-creation transaction under the
      // run's own split (AAP 0.5.7). Each filter reports the rows it found rather than failing on
      // the first, which is what a check at population scale needs.
      const rows = [...stored.values()];
      expect(new Set(rows.map((row) => row.assignmentId)).size).toBe(POPULATION);
      expect(rows.filter((row) => row.assignmentId === '')).toEqual([]);
      expect(rows.filter((row) => row.shareAtAssignment !== DEFAULT_SHARE)).toEqual([]);

      const social = rows.filter((row) => row.variant === 'social').length;
      expect(social / rows.length).toBeGreaterThanOrEqual(SOCIAL_SHARE_MIN);
      expect(social / rows.length).toBeLessThanOrEqual(SOCIAL_SHARE_MAX);

      // What the stability cases compare against: the account each address signed in as, and the
      // assignment that sign-in stored.
      accounts = new Map([...signedIn].map(([email, result]) => [email, result.userId]));
      snapshot = new Map(stored);
      expect(accounts.size).toBe(POPULATION);
    },
  );

  it('leaves every stored variant, assignment id and assignment time as the first sign-in wrote it', async () => {
    // The population this case reads and the maps the first case filled: named first, so a missing
    // population fails as itself rather than as a mismatch against an assignment that is not there.
    expect(await app.services.db.user.count(), 'the population the first case signed in').toBe(
      POPULATION,
    );

    const signedIn = await signInAll(app, SAMPLED_EMAILS);
    expect(signedIn.size).toBe(SAMPLED_EMAILS.length);

    const stored = await storedAssignments(app);
    expect(stored.size).toBe(POPULATION);
    // A returning address resolves its account and creates no second one (AAP 0.5.4).
    expect(await app.services.db.user.count()).toBe(POPULATION);

    for (const [email, result] of signedIn) {
      expect(result.userId).toBe(accounts.get(email));
      expect(stored.get(result.userId)).toEqual(snapshot.get(result.userId));
    }
  });

  it('keeps the stored assignments when the split changes, and assigns new accounts under it', async () => {
    await rebuildApp({ EXPERIMENT_SOCIAL_SHARE: SOCIAL_ONLY });
    try {
      // The population this case starts from, the same one the first case signed in: asserted here
      // so a missing one fails before the sign-ins that would otherwise report it as nothing.
      expect(await app.services.db.user.count(), 'the population the first case signed in').toBe(
        POPULATION,
      );

      const signedIn = await signInAll(app, SAMPLED_EMAILS);
      const stored = await storedAssignments(app);
      expect(stored.size).toBe(POPULATION);
      for (const [email, result] of signedIn) {
        expect(result.userId).toBe(accounts.get(email));
        // The row is unchanged even though the split that would produce it no longer is: a variant
        // is never recomputed, and `shareAtAssignment` records the split it was written under.
        expect(stored.get(result.userId)).toEqual(snapshot.get(result.userId));
      }

      const created = await signInAll(app, NEW_EMAILS);
      const fresh = await storedAssignments(app);
      expect(fresh.size).toBe(POPULATION + NEW_ACCOUNTS);
      for (const result of created.values()) {
        expect(fresh.get(result.userId)?.variant).toBe('social');
        expect(fresh.get(result.userId)?.shareAtAssignment).toBe(1);
      }
    } finally {
      // The funnel cases below read the default split, which this case replaced.
      await rebuildApp({});
    }
  });

  it(
    'stores a thousand account_created events with no raw user id on any of them',
    { timeout: POPULATION_TIMEOUT_MS },
    async () => {
      // What the scan is about: the population the first case signed in, plus the accounts the
      // split-change case created after it, each of which wrote an `account_created` event.
      expect(
        await app.services.db.user.count(),
        'the population the first case signed in and the accounts the split-change case added',
      ).toBe(POPULATION + NEW_ACCOUNTS);

      await expectNoRawUserIds(app);
    },
  );
});

describe('the deposit funnel', () => {
  beforeEach(async () => {
    // A fresh database and the five cities: each case walks its own funnel and reads only that.
    await app.resetState();
    await app.seedCities();
  });

  it(`${stripeModeLabel()} attributes every funnel stage to its actor's stored variant`, async () => {
    const walked = await walkFunnel(app);
    const events = await funnelRows(app);

    // All six stages, and nothing outside them: the funnel is counted from these rows (AAP 0.5.7).
    expect([...new Set(events.map((event) => event.name))].sort()).toEqual(
      [...FUNNEL_EVENTS].sort(),
    );

    // Both participants, reached from the hashes their own events carry, so every row is resolved to
    // the account that acted and none is excused by an unreadable `actorHash`.
    const actors = new Map([
      [actorHash(app.env.ANALYTICS_SALT, walked.initiator.id), walked.initiator],
      [actorHash(app.env.ANALYTICS_SALT, walked.recipient.id), walked.recipient],
    ]);
    const assignments = await storedAssignments(app);

    for (const event of events) {
      expect(event.meetupId).toBe(walked.meetupId);
      const actor = actors.get(event.actorHash ?? '');
      expect(actor).toBeDefined();
      const assignment = actor === undefined ? undefined : assignments.get(actor.id);
      expect(assignment).toBeDefined();

      // The row's two experiment columns, the same two values in the props the emitter copies from
      // the stored assignment, and the pairing the meetup fixed at the proposal (AAP 0.12.1).
      const props = propsOf(event.props);
      expect(event.variant).not.toBeNull();
      expect(event.assignmentId).not.toBeNull();
      expect(event.variant).toBe(assignment?.variant);
      expect(event.assignmentId).toBe(assignment?.assignmentId);
      expect(props['variant']).toBe(assignment?.variant);
      expect(props['assignmentId']).toBe(assignment?.assignmentId);
      expect(props['variantPairing']).toBe(walked.variantPairing);
    }
  });

  it('stores no raw user id on any analytics event of the funnel', async () => {
    await walkFunnel(app);
    await expectNoRawUserIds(app);
  });
});
