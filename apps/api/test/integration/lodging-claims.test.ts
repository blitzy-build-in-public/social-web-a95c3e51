/**
 * Integration tests for the three lodging-claim routes of AAP 0.5.4 — `POST /me/lodging-claims`,
 * `GET` and `DELETE /me/lodging-claims/:id` — and for the consequences AAP 0.5.3 gives a claim's
 * outcomes (AAP 0.8.1 lists this file; criterion 14's "a claim without consent returns `400`").
 * The suite drives the real app built by `createTestApp` against a real PostgreSQL 16 with PostGIS
 * 3.4 (AAP 0.11.2), so what it proves is what the routes write: the claim's encrypted booking
 * fields, the `create_call_task` outbox row `apps/workers` turns into a verification call, the
 * `lodging_claim_submitted` event, the refusal while a call may genuinely be live, and the deletion
 * that takes the booking ciphertext and the claim's outstanding work with it. The four groups below
 * follow the order AAP 0.5.4 lists the creation errors in, so a request breaking two rules is
 * answered with the earlier one.
 *
 * **The 72-hour expiry itself does not run here.** `claim-expire` lives in
 * `apps/workers/src/jobs/lodging-claims.ts`, and `@tablemate/api` cannot import it without a
 * dependency cycle; the job is covered by that package's own suites and by
 * `tests/system/lodging-verification.test.ts`. The last group therefore writes the state the job
 * produces — a claim `unreachable` with its resolution instant, and its task `cancelled` — and
 * asserts only what the API does with it: the status read, the operator's `422 invalid_outcome` on
 * a terminal claim, the deletion, and the claim that may be filed afterwards.
 *
 * Time comes from the injected test clock throughout (AAP 0.11.1): a claim's consent instant and its
 * resolution instant are asserted against it, and the 72-hour jump is made with it. Every booking
 * name and reference is generated at run time and never logged.
 *
 * @see AAP 0.5.4 for the routes, their errors and their order, 0.5.3 for the claim lifecycle, the
 *   `409 call_in_progress` rule and the deletion semantics, 0.5.7 for the claim rules, 0.5.2 for the
 *   encryption, the advisory lock and the retention of the booking fields, and 0.11.2 for the
 *   harness.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { addLocalDays, decryptField } from '@tablemate/server-core';
import { CLAIM_EXPIRY_HOURS, LodgingClaimCreated, LodgingClaimStatusDto } from '@tablemate/shared';
import type {
  CallAttemptState,
  CallTaskStatus,
  ErrorCode,
  LodgingClaimStatus,
} from '@tablemate/shared';

import { createTestApp } from '../support/app.ts';
import {
  callRoute,
  expectError,
  makeCallAttempt,
  makeCallTask,
  makeClaim,
  makeLodging,
  makeProof,
  makeUser,
  makeVisibility,
  rows,
} from '../support/factories.ts';
import type {
  LodgingFixture,
  ProofFixture,
  RouteResponse,
  UserFixture,
} from '../support/factories.ts';
import type { TestApp } from '../support/app.ts';

/* The fixtures every case builds on (AAP 0.5.2, 0.11.2) */

/** The city the caller's proof is for, and the one the claimable lodging stands in. */
const LISBON = 'lisbon';
/** A second launch city, whose lodging exists only to reach `422 lodging_other_city`. */
const MEXICO_CITY = 'mexico-city';
const CLAIMS_URL = '/v1/me/lodging-claims';
const claimUrl = (id: string): string => `${CLAIMS_URL}/${id}`;
/** The operator's resolution route, which a claim that has left `pending_call` refuses (AAP 0.5.4). */
const resolveUrl = (id: string): string => `/v1/admin/lodging-claims/${id}/resolve`;

/** The one app this file drives; built once and reset between cases by `resetState`. */
let t: TestApp;
let user: UserFixture;
let proof: ProofFixture;
let lodging: LodgingFixture;
/** A lodging of the second city, which exists only to reach `422 lodging_other_city`. */
let otherCity: LodgingFixture;
/** The operator who may resolve a claim by hand, and whose token must be fresh when it is used. */
let operator: UserFixture;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.resetState();
  await t.seedCities();

  user = await makeUser(t);
  // Default proof dates: arrival yesterday and departure five days out, in Lisbon's own time, so
  // the proof is valid now and its window is wide enough for every stay these cases file.
  proof = await makeProof(t, user, { cityId: LISBON });
  lodging = await makeLodging(t, { cityId: LISBON });
  otherCity = await makeLodging(t, { cityId: MEXICO_CITY });
  operator = await makeUser(t, { role: 'operator' });
});

/* Helpers (AAP 0.11.1 density: one builder per shape, reused by every case) */

/**
 * Who a request is made as: a fixture account, or a token signed for one. A case that moves the
 * clock past the token's 15 minutes (AAP 0.11.1) signs a fresh one with `tokenFor` and passes it.
 */
type Actor = string | UserFixture;

/** A booking name unique to one case, generated at run time and never logged (AAP 0.11.1). */
function guestName(): string {
  return `Guest ${randomUUID().slice(0, 8)}`;
}

/** The body of a claim for the base lodging, whose stay fits inside the base proof's dates. */
function claimBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lodgingId: lodging.id,
    stayFrom: proof.arrivalDate,
    stayTo: proof.departureDate,
    bookingName: guestName(),
    callConsent: true,
    ...overrides,
  };
}

/** Seed one claim for the base user directly, in the status a case needs (AAP 0.5.2). */
async function seedClaim(status: LodgingClaimStatus = 'pending_call'): Promise<void> {
  await makeClaim(t, user, lodging, { status });
}

/* One route call each, named for what it does rather than for its verb. */
function postClaim(body: Record<string, unknown>, as: Actor = user): Promise<RouteResponse> {
  return callRoute(t.app, { method: 'POST', url: CLAIMS_URL, as, body });
}

function readClaim(claimId: string, as: Actor = user): Promise<RouteResponse> {
  return callRoute(t.app, { method: 'GET', url: claimUrl(claimId), as });
}

function removeClaim(claimId: string, as: Actor = user): Promise<RouteResponse> {
  return callRoute(t.app, { method: 'DELETE', url: claimUrl(claimId), as });
}

/** File one claim through the route and answer its id, asserting the `201` on the way. */
async function fileClaim(body: Record<string, unknown> = claimBody()): Promise<string> {
  const created = await postClaim(body);
  expect(created.status, created.body).toBe(201);
  return LodgingClaimCreated.parse(created.json()).claimId;
}

/** The status one claim reports to its owner, asserting the `200` and the DTO's shape on the way. */
async function statusOf(claimId: string, as: Actor = user): Promise<LodgingClaimStatus> {
  const read = await readClaim(claimId, as);
  expect(read.status, read.body).toBe(200);
  return LodgingClaimStatusDto.parse(read.json()).status;
}

/** The stored claim row, as the assertions read it: no coordinate, no plaintext booking field. */
function claimRow(claimId: string) {
  return t.services.db.lodgingClaim.findUnique({
    where: { id: claimId },
    select: {
      status: true,
      callConsentAt: true,
      detailsErasedAt: true,
      bookingNameCiphertext: true,
      bookingReferenceCiphertext: true,
    },
  });
}

/**
 * Give a claim the verification task `apps/workers` would have created for it, and one attempt in
 * the state the case is about. The task id is answered, because the assertion after a deletion reads
 * the task by its own id: the deletion nulls the claim link a lookup would use.
 */
async function seedVerification(
  claimId: string,
  options: { readonly task: CallTaskStatus; readonly attempt: CallAttemptState },
): Promise<string> {
  const task = await makeCallTask(t, {
    kind: 'lodging_stay_verification',
    lodgingId: lodging.id,
    lodgingClaimId: claimId,
    status: options.task,
  });
  await makeCallAttempt(t, task, { state: options.attempt });
  return task.id;
}

/** One call task as the assertions read it, by the id `seedVerification` answered. */
function taskRow(taskId: string) {
  return t.services.db.callTask.findUnique({
    where: { id: taskId },
    select: { status: true, lodgingClaimId: true },
  });
}

/* Group 1 — the creation refusals, in the contract's order (AAP 0.5.4) */

/**
 * One creation-failure case. The body, the actor and the seeded state are built inside the case
 * rather than at collection time, because each needs the fixtures `beforeEach` has just created.
 */
interface CreationRow {
  readonly name: string;
  readonly status: number;
  readonly code: ErrorCode;
  /** The request body; `claimBody`'s default when absent. */
  readonly body?: () => Record<string, unknown>;
  /** The caller; the base user when absent. */
  readonly actor?: () => Promise<UserFixture>;
  /** Rows seeded before the request, such as the claim that already exists. */
  readonly prepare?: () => Promise<void>;
}

/**
 * The refusal table, in the order `createClaim` checks its rules (AAP 0.5.4). Two rows state the
 * precedence that order implies: a request breaking two rules is answered with the earlier one.
 */
const creationRows = rows<CreationRow>([
  {
    name: 'a claim filed without consent',
    status: 400,
    code: 'consent_missing',
    body: () => claimBody({ callConsent: false }),
  },
  // Nothing at all is read before the consent that discloses the lodging exception (AAP 0.5.8).
  {
    name: 'no consent on a lodging that does not exist',
    status: 400,
    code: 'consent_missing',
    body: () => claimBody({ callConsent: false, lodgingId: randomUUID() }),
  },
  {
    name: 'a booking name that is only whitespace',
    status: 400,
    code: 'booking_name_empty',
    body: () => claimBody({ bookingName: '   ' }),
  },
  {
    name: 'a lodging that does not exist',
    status: 404,
    code: 'lodging_not_found',
    body: () => claimBody({ lodgingId: randomUUID() }),
  },
  {
    name: 'a caller who holds no proof',
    status: 403,
    code: 'no_valid_proof',
    actor: () => makeUser(t),
  },
  {
    name: 'a caller whose proof has expired',
    status: 403,
    code: 'no_valid_proof',
    actor: async () => {
      const lapsed = await makeUser(t);
      await makeProof(t, lapsed, { cityId: LISBON, validNow: false });
      return lapsed;
    },
  },
  {
    name: 'a second claim while one waits for its call',
    status: 409,
    code: 'active_claim_exists',
    prepare: () => seedClaim(),
  },
  // A verified claim is active until the end of its stay, so it blocks a new one (AAP 0.5.3).
  {
    name: 'a second claim while a verified stay is still running',
    status: 409,
    code: 'active_claim_exists',
    prepare: () => seedClaim('verified'),
  },
  {
    name: 'a stay that starts before the proof does',
    status: 422,
    code: 'claim_dates_invalid',
    body: () =>
      claimBody({
        stayFrom: addLocalDays(proof.arrivalDate, -1),
        stayTo: proof.departureDate,
      }),
  },
  {
    name: 'a stay that ends after the proof does',
    status: 422,
    code: 'claim_dates_invalid',
    body: () =>
      claimBody({
        stayFrom: proof.arrivalDate,
        stayTo: addLocalDays(proof.departureDate, 1),
      }),
  },
  {
    name: 'a stay whose last night precedes its first',
    status: 422,
    code: 'claim_dates_invalid',
    body: () => claimBody({ stayFrom: proof.departureDate, stayTo: proof.arrivalDate }),
  },
  {
    name: 'a lodging in another city',
    status: 422,
    code: 'lodging_other_city',
    body: () => claimBody({ lodgingId: otherCity.id }),
  },
  {
    name: 'a body carrying a key the contract does not have',
    status: 400,
    code: 'invalid_field',
    body: () => claimBody({ roomNumber: '12' }),
  },
]);

describe('POST /me/lodging-claims refusals (AAP 0.5.4)', () => {
  it.each(creationRows)('refuses $name with $status $code', async (row) => {
    if (row.prepare !== undefined) {
      await row.prepare();
    }
    const actor = row.actor === undefined ? user : await row.actor();
    expectError(await postClaim(row.body?.() ?? claimBody(), actor), row.status, row.code);

    // Every refusal happens before the insert, so the caller holds exactly the claim a case seeded
    // and nothing was written for the refused request.
    const claims = await t.services.db.lodgingClaim.count({ where: { userId: actor.id } });
    expect(claims).toBe(row.code === 'active_claim_exists' ? 1 : 0);
  });
});

/* Group 2 — a claim that is filed (AAP 0.5.4, 0.5.2, 0.3.2) */

describe('a claim that is filed (AAP 0.5.4)', () => {
  it('answers 201, encrypts the booking details and queues the verification task', async () => {
    const name = guestName();
    const reference = `BOOKING-${randomUUID().slice(0, 12)}`;
    const response = await postClaim(
      claimBody({ bookingName: `  ${name}  `, bookingReference: `  ${reference}  ` }),
    );

    expect(response.status, response.body).toBe(201);
    const created = LodgingClaimCreated.parse(response.json());
    expect(created.status).toBe('pending_call');

    const row = await claimRow(created.claimId);
    expect(row?.status).toBe('pending_call');
    expect(row?.callConsentAt.toISOString()).toBe(t.clock.now().toISOString());
    expect(row?.detailsErasedAt).toBeNull();

    // The booking fields are the AES-256-GCM ciphertext of AAP 0.5.2, and the trimmed value the
    // caller typed is what comes back out of it.
    const storedName = row?.bookingNameCiphertext ?? '';
    expect(storedName).not.toBe('');
    expect(storedName).not.toContain(name);
    expect(decryptField(t.services.keyring, storedName)).toBe(name);
    const storedReference = row?.bookingReferenceCiphertext ?? '';
    expect(storedReference).not.toBe('');
    expect(storedReference).not.toContain(reference);
    expect(decryptField(t.services.keyring, storedReference)).toBe(reference);

    // One outbox row, carrying the claim's id alone: the workers' instruction to verify this claim
    // by phone. The row is written in the claim's own transaction and delivered by the outbox pass
    // the commit kicks, which this case settles before it reads the row (AAP 0.3.2, 0.5.6).
    await t.services.outbox.runOnce();
    const outbox = await t.services.db.outboxMessage.findMany({
      select: { kind: true, payload: true, dispatchedAt: true },
    });
    expect(outbox.map((message) => message.kind)).toEqual(['create_call_task']);
    expect(outbox[0]?.payload).toEqual({ lodgingClaimId: created.claimId });
    expect(outbox[0]?.dispatchedAt).not.toBeNull();

    // One `lodging_claim_submitted` event, the claim measures' only source (AAP 0.5.7), attributed
    // to a salted hash rather than to an account.
    const events = await t.services.db.analyticsEvent.findMany({
      select: { name: true, cityId: true },
    });
    expect(events.map((event) => event.name)).toEqual(['lodging_claim_submitted']);
    expect(events[0]?.cityId).toBe(LISBON);

    // Nothing written for this claim carries a booking field or the caller's identity.
    const written = JSON.stringify({ outbox, events });
    expect(written).not.toContain(name);
    expect(written).not.toContain(reference);
    expect(written).not.toContain(user.id);
  });

  it('accepts a new claim once an earlier verified stay has ended', async () => {
    await makeClaim(t, user, lodging, {
      status: 'verified',
      stayFrom: addLocalDays(proof.arrivalDate, -10),
      stayTo: addLocalDays(proof.arrivalDate, -3),
    });

    const created = await postClaim(claimBody());
    expect(created.status, created.body).toBe(201);
    expect(LodgingClaimCreated.parse(created.json()).status).toBe('pending_call');
  });

  it('answers one caller racing itself with one claim and one 409', async () => {
    const body = claimBody();
    const [first, second] = await Promise.all([postClaim(body), postClaim(body)]);

    const answers = [first, second].sort((left, right) => left.status - right.status);
    expect(answers.map((answer) => answer.status)).toEqual([201, 409]);
    expectError(first.status === 409 ? first : second, 409, 'active_claim_exists');

    // The per-user advisory lock of AAP 0.5.2 is what makes the loser see the winner's row.
    expect(await t.services.db.lodgingClaim.count({ where: { userId: user.id } })).toBe(1);
  });
});

/* Group 3 — reading and deleting a claim (AAP 0.5.3, 0.5.4) */

describe('reading and deleting a claim (AAP 0.5.4)', () => {
  it('reads the caller their own claim and hides it from everyone else', async () => {
    const claimId = await fileClaim();
    const stranger = await makeUser(t);

    const own = await readClaim(claimId);
    expect(own.status, own.body).toBe(200);
    // The status and, once resolved, the instant: no booking field is in the shape (AAP 0.5.2).
    expect(Object.keys(own.json<object>()).sort()).toEqual(['status']);
    expect(await statusOf(claimId)).toBe('pending_call');

    expectError(await readClaim(claimId, stranger), 404, 'claim_not_found');
    expectError(await removeClaim(claimId, stranger), 404, 'claim_not_found');
    expectError(await readClaim(randomUUID()), 404, 'claim_not_found');
    expect(await statusOf(claimId)).toBe('pending_call');
  });

  /** The four states in which a call may genuinely be live (AAP 0.3.2, 0.5.3). */
  const liveRows = rows<{ readonly state: CallAttemptState }>([
    { state: 'dispatching' },
    { state: 'dispatch_unknown' },
    { state: 'dialing' },
    { state: 'in_progress' },
  ]);

  it.each(liveRows)('refuses a delete while an attempt is $state', async (row) => {
    const claim = await makeClaim(t, user, lodging);
    await seedVerification(claim.id, { task: 'in_progress', attempt: row.state });

    expectError(await removeClaim(claim.id), 409, 'call_in_progress');
    expect(await claimRow(claim.id)).not.toBeNull();
  });

  /** One non-live outcome: the seeded state, and the task status the deletion leaves behind. */
  interface OutcomeRow {
    readonly name: string;
    readonly task: CallTaskStatus;
    readonly attempt: CallAttemptState;
    readonly expectedTask: CallTaskStatus;
  }

  /**
   * Deletion succeeds after each non-live outcome of AAP 0.5.3: an ended call leaves the task queued
   * for its second attempt, a task in the operator queue and an unreachable one are cancelled with
   * it, and a terminal refusal is left exactly as it stands.
   */
  const outcomeRows = rows<OutcomeRow>([
    {
      name: 'an ended attempt whose task is still queued',
      task: 'queued',
      attempt: 'ended',
      expectedTask: 'cancelled',
    },
    {
      name: 'a task waiting in the operator queue',
      task: 'needs_review',
      attempt: 'ended',
      expectedTask: 'cancelled',
    },
    { name: 'a refused task', task: 'refused', attempt: 'ended', expectedTask: 'refused' },
    {
      name: 'a do-not-call task',
      task: 'do_not_call',
      attempt: 'ended',
      expectedTask: 'do_not_call',
    },
    {
      name: 'an unreachable task',
      task: 'unreachable',
      attempt: 'ended',
      expectedTask: 'cancelled',
    },
    {
      name: 'a dispatch that never reached the provider',
      task: 'queued',
      attempt: 'dispatch_failed',
      expectedTask: 'cancelled',
    },
  ]);

  it.each(outcomeRows)('deletes a claim after $name', async (row) => {
    const claim = await makeClaim(t, user, lodging);
    const taskId = await seedVerification(claim.id, { task: row.task, attempt: row.attempt });
    await makeVisibility(t, user, claim, true);

    const deleted = await removeClaim(claim.id);
    expect(deleted.status, deleted.body).toBe(204);

    // The claim row goes with its booking ciphertext, the visibility toggle cascades, and the task
    // stays behind with no link to the claim that is gone (AAP 0.5.2, 0.5.3).
    const surviving = await t.services.db.lodgingClaim.findMany({
      select: { bookingNameCiphertext: true },
    });
    expect(surviving).toEqual([]);
    expect(await t.services.db.lodgingVisibility.count({ where: { userId: user.id } })).toBe(0);

    const task = await taskRow(taskId);
    expect(task?.status).toBe(row.expectedTask);
    expect(task?.lodgingClaimId).toBeNull();
  });
});

/* Group 4 — the 72-hour expiry's consequences (AAP 0.5.3) */

describe('a claim that waited 72 hours in the operator queue (AAP 0.5.3)', () => {
  it('is unreachable, cannot be resolved by hand, is deleted, and does not block a claim', async () => {
    const claimId = await fileClaim();
    const taskId = await seedVerification(claimId, { task: 'needs_review', attempt: 'ended' });

    // The expiry itself is the workers' `claim-expire` job, which this package cannot import (see
    // this file's header): the state that job produces is written here, and the API's answer to it
    // is what the case asserts.
    t.time.advance({ hours: CLAIM_EXPIRY_HOURS, minutes: 1 });
    const expiredAt = t.clock.now();
    await t.services.db.lodgingClaim.update({
      where: { id: claimId },
      data: { status: 'unreachable', resolvedAt: expiredAt },
    });
    await t.services.db.callTask.update({ where: { id: taskId }, data: { status: 'cancelled' } });

    // An access token lives 15 minutes of the test clock (AAP 0.11.1), so every request after the
    // three-day jump is made as a freshly signed token.
    const callerToken = await t.tokenFor(user);
    const operatorToken = await t.tokenFor(operator);

    const read = await readClaim(claimId, callerToken);
    expect(read.status, read.body).toBe(200);
    expect(Object.keys(read.json<object>()).sort()).toEqual(['resolvedAt', 'status']);
    expect(LodgingClaimStatusDto.parse(read.json())).toEqual({
      status: 'unreachable',
      resolvedAt: expiredAt.toISOString(),
    });

    // A terminal claim accepts no operator outcome: only `pending_call` and `calling` may be
    // resolved, which is what makes the expiry, a second click and a late call result harmless.
    const resolution = await callRoute(t.app, {
      method: 'POST',
      url: resolveUrl(claimId),
      as: operatorToken,
      body: { outcome: 'verified' },
    });
    expectError(resolution, 422, 'invalid_outcome');

    expect((await removeClaim(claimId, callerToken)).status).toBe(204);

    // The expired claim no longer blocks the caller, whose proof is still valid three days on.
    const later = await postClaim(
      claimBody({
        stayFrom: addLocalDays(proof.arrivalDate, 1),
        stayTo: proof.departureDate,
      }),
      callerToken,
    );
    expect(later.status, later.body).toBe(201);
    expect(LodgingClaimCreated.parse(later.json()).status).toBe('pending_call');
  });
});
