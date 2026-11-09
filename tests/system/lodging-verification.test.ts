/**
 * Criterion 14 and the lodging-transcript constraint (AAP 0.12.1, AAP 0.12.2): the stay-verification
 * call a lodging claim asks for, and everything the database keeps of it afterwards.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, testWorkersEnv, type TestApp } from '@tablemate/api/test-support/app';
import {
  callRoute,
  expectError,
  makeLodging,
  makeProof,
  makeUser,
  rows,
  type LodgingFixture,
  type RouteResponse,
  type UserFixture,
} from '@tablemate/api/test-support/factories';
import type { SimCall } from '@tablemate/api/test-support/voice-simulator/simulator';
import type { CallAttempt, CallTask, LodgingClaim } from '@tablemate/db';
import {
  CALL_STATUS_CALLBACK_EVENTS,
  JOB,
  QUEUE,
  claimExpireJobId,
  loadWorkersEnv,
  localTimeOn,
} from '@tablemate/server-core';
import {
  AdminLodgingClaimsResponse,
  HOUR_MS,
  LodgingClaimCreated,
  LodgingClaimStatusDto,
  MeDto,
  type LodgingClaimStatus,
} from '@tablemate/shared';
import { process as callDispatch } from '@tablemate/workers/jobs/call-dispatch';
import { process as callResults } from '@tablemate/workers/jobs/call-results';
import { process as dataExpiry, type ExpiryCounts } from '@tablemate/workers/jobs/data-expiry';
import { process as lodgingClaims } from '@tablemate/workers/jobs/lodging-claims';
import {
  closeWorkerContext,
  createWorkerContext,
  type Processor,
  type ProcessorJob,
  type WorkerContext,
} from '@tablemate/workers/queues';

const CITY_ID = 'lisbon';

/** Lisbon's own call language, which the scripted stay answers are spoken in (AAP 0.5.2, 0.5.6). */
const LANGUAGE = 'pt-PT';

const SUITE_DAY = '2026-11-17';
const SUITE_HOUR = '10:00';

/** The hard bound AAP 0.5.6 puts on one call, which the dispatch asks Twilio for as `timeLimit`. */
const CAP_CALL_SECONDS = 300;

/** The booking under verification: a fictional guest and reference, never a real person's. */
const BOOKING_NAME = 'Fixture Guest Ana Lima';
const BOOKING_REFERENCE = 'FIXTURE-REF-0001';

const CLAIMS_PATH = '/v1/me/lodging-claims';
const ADMIN_CLAIMS_PATH = '/v1/admin/lodging-claims';

/**
 * The whole life of an unanswered claim: the 72 hours AAP 0.5.3 gives it from its creation. The
 * figure is written here rather than read from `CLAIM_EXPIRY_HOURS`, because it is the rule the
 * criterion names: a build whose expiry moved would have to fail this suite, not move with it.
 */
const CLAIM_EXPIRY_MS = 72 * HOUR_MS;

const CASE_TIMEOUT_MS = 120_000;

/**
 * The task fields AAP 0.5.2 keeps on a stripped verification task: `id`, `kind` and `lodging_id` (so
 * the one-target check still holds), `status`, `attempts`, `outcome_at`, `blocked_reason`, and
 * `resolved_by`; the attempt fields it keeps (identity and outcome) and those it empties.
 */
const RETAINED_TASK_FIELDS = [
  'id',
  'kind',
  'lodgingId',
  'status',
  'attempts',
  'outcomeAt',
  'blockedReason',
  'resolvedBy',
] as const;
const RETAINED_ATTEMPT_FIELDS = [
  'id',
  'callTaskId',
  'state',
  'outcome',
  'twilioFinalStatus',
  'startedAt',
  'endedAt',
] as const;
const NULLED_ATTEMPT_FIELDS = [
  'twilioCallSid',
  'summary',
  'extractedFields',
  'confidence',
  'durationSec',
  'transcript',
] as const;

let t: TestApp;
let ctx: WorkerContext;

let guest: UserFixture;
let stayFrom: string;
let stayTo: string;
let lodging: LodgingFixture;
let operator: UserFixture;

/**
 * The worker context's mailer: a capture that sends nothing, so no case opens an SMTP connection.
 */
const mailer: WorkerContext['mailer'] = {
  send(): Promise<void> {
    return Promise.resolve();
  },
};

beforeAll(async () => {
  t = await createTestApp();
  // Listening is what gives the simulator an address for the signed callbacks and the relay socket it
  // opens, and `listen` points it there (AAP 0.11.2).
  t.simulator.setTarget(await t.listen());

  ctx = await createWorkerContext(loadWorkersEnv(testWorkersEnv()), {
    clock: t.clock,
    llm: t.llm,
    twilioHttpClient: t.simulator.httpClient,
    mailer,
  });
});

afterAll(async () => {
  await closeWorkerContext(ctx);
  await t.close();
});

beforeEach(async () => {
  await t.resetState();
  await t.seedCities();
  t.simulator.reset();
  t.simulator.setTarget(await t.listen());

  t.time.at(localTimeOn('Europe/Lisbon', SUITE_DAY, SUITE_HOUR));

  guest = await makeUser(t);
  // The proof's own window is what the claim's stay dates have to sit inside (AAP 0.5.7).
  const proof = await makeProof(t, guest, { cityId: CITY_ID });
  stayFrom = proof.arrivalDate;
  stayTo = proof.departureDate;
  lodging = await makeLodging(t, { cityId: CITY_ID });
  operator = await makeUser(t, { role: 'operator' });
});

type WorkerQueue = ReturnType<WorkerContext['queues']['get']>;

const PENDING_JOB_STATES = ['waiting', 'delayed', 'prioritized'] as const;

function processorJob(job: { id?: string; name: string; data: unknown }): ProcessorJob {
  return { name: job.name, data: job.data, ...(job.id === undefined ? {} : { id: job.id }) };
}

/**
 * Deliver every pending outbox row, then run every job waiting on `queue` through `processor`.
 * @param queue - the queue to take the pending jobs from.
 * @param processor - the file's `process`, which is the only thing a job is run by.
 * @returns how many jobs this pass ran.
 */
async function drain(queue: WorkerQueue, processor: Processor): Promise<number> {
  await t.services.outbox.runOnce();

  const jobs = await queue.getJobs([...PENDING_JOB_STATES], 0, -1, true);
  for (const job of jobs) {
    await processor(processorJob(job), ctx);
    await job.remove();
  }

  return jobs.length;
}

function pick<T extends object, K extends keyof T>(row: T, fields: readonly K[]): Record<K, T[K]> {
  const picked = {} as Record<K, T[K]>;
  for (const field of fields) {
    picked[field] = row[field];
  }
  return picked;
}

/**
 * Assert that every named field holds exactly `null`, one boolean per field: the field still set
 * would be the call's own `CallSid`, which no failure may print (AAP 0.11.1).
 */
function expectNullFields<T extends object>(
  row: T,
  fields: readonly (keyof T)[],
  label: string,
): void {
  for (const field of fields) {
    expect(row[field] === null, `${label}: ${String(field)} is null`).toBe(true);
  }
}

/**
 * One stay date as the stay script's template renders it (AAP 0.5.6): the `@db.Date` value in UTC,
 * with Luxon's `DATE_FULL` options — year, full month name and day — in the call's language, so the
 * question a case looks for is the one the dialogue really spoke.
 */
function renderedStayDate(date: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function claimRow(claimId: string): Promise<LodgingClaim> {
  return t.services.db.lodgingClaim.findUniqueOrThrow({ where: { id: claimId } });
}

/** One call task by id, which is the only key the strip leaves on it. */
function taskById(taskId: string): Promise<CallTask> {
  return t.services.db.callTask.findUniqueOrThrow({ where: { id: taskId } });
}

async function taskOfClaim(claimId: string): Promise<CallTask> {
  const tasks = await t.services.db.callTask.findMany({ where: { lodgingClaimId: claimId } });
  expect(tasks.length, 'the claim opened exactly one verification task').toBe(1);

  const [task] = tasks;
  if (task === undefined) {
    throw new Error('the claim opened no verification task');
  }
  return task;
}

function attemptOfTask(taskId: string): Promise<CallAttempt> {
  return t.services.db.callAttempt.findFirstOrThrow({ where: { callTaskId: taskId } });
}

function callbackCount(callSid: string): Promise<number> {
  return t.services.db.voiceCallbackEvent.count({ where: { callSid } });
}

function theOnlyCall(phone: string): SimCall {
  const calls = t.simulator.callsTo(phone);
  expect(calls.length, 'the dispatch dialed the lodging once').toBe(1);

  const [call] = calls;
  if (call === undefined) {
    throw new Error('the dispatch dialed no call');
  }
  return call;
}

function runHourlyExpiry(): Promise<ExpiryCounts> {
  return dataExpiry({ name: JOB[QUEUE.dataExpiry].hourly, data: { step: 'hourly' } }, ctx);
}

async function scheduledClaimExpiry(claimId: string) {
  const jobs = await ctx.queues.get(QUEUE.lodgingClaims).getJobs(['delayed'], 0, -1, true);
  return jobs.find((job) => job.id === claimExpireJobId(claimId));
}

interface ClaimDraft {
  /** The consent as the client sends it; absent means the field is left out of the body entirely. */
  readonly callConsent?: boolean;
}

function submitClaim(draft: ClaimDraft, as: string | UserFixture = guest): Promise<RouteResponse> {
  return callRoute(t.app, {
    method: 'POST',
    url: CLAIMS_PATH,
    as,
    body: {
      lodgingId: lodging.id,
      stayFrom,
      stayTo,
      bookingName: BOOKING_NAME,
      bookingReference: BOOKING_REFERENCE,
      ...(draft.callConsent === undefined ? {} : { callConsent: draft.callConsent }),
    },
  });
}

/**
 * Submit a consented claim through the route the app uses, and answer its `201` body.
 * @param as - the bearer token to send, so a case that jumped the clock by days can sign a fresh one
 * @returns the created claim's id and status.
 */
async function createClaim(as: string | UserFixture = guest): Promise<LodgingClaimCreated> {
  const answer = await submitClaim({ callConsent: true }, as);
  expect(answer.status, 'a consented claim is created').toBe(201);

  const created = LodgingClaimCreated.parse(answer.json());
  await t.services.db.lodgingClaim.update({
    where: { id: created.claimId },
    data: { createdAt: t.time.now() },
  });

  const stamped = await claimRow(created.claimId);
  expect(stamped.createdAt.getTime(), 'the claim is stamped by the injected clock').toBe(
    t.time.now().getTime(),
  );

  return created;
}

interface StayCall {
  readonly claimId: string;
  readonly claim: LodgingClaim;
  readonly task: CallTask;
  readonly attempt: CallAttempt;
  readonly call: SimCall;
}

/**
 * Take one claim from the route to a settled stay call: the create-task job opens the verification
 * task, the city's dispatch run dials it, the scripted answer plays, and the result the relay
 * recorded is applied by `call-results`.
 * @param scenario - which scripted answer the lodging gives.
 * @returns the claim, its resolved task and attempt, and the call the simulator played.
 */
async function runStayCall(scenario: OutcomeRow['scenario']): Promise<StayCall> {
  const { claimId } = await createClaim();

  const created = await drain(ctx.queues.get(QUEUE.callDispatch), callDispatch);
  expect(created, 'the create_call_task row opened one dispatch job').toBe(1);

  const task = await taskOfClaim(claimId);
  expect(task.status, 'a callable lodging leaves its task queued').toBe('queued');

  t.simulator.setScenarioFor(lodging.phone, scenario);
  await callDispatch(
    { name: JOB[QUEUE.callDispatch].dispatchCity, data: { cityId: CITY_ID } },
    ctx,
  );
  await t.simulator.waitIdle();

  const applied = await drain(ctx.queues.get(QUEUE.callResults), callResults);
  expect(applied, 'the relay queued one call result to apply').toBe(1);

  return {
    claimId,
    claim: await claimRow(claimId),
    task: await taskById(task.id),
    attempt: await attemptOfTask(task.id),
    call: theOnlyCall(lodging.phone),
  };
}

interface OutcomeRow {
  readonly scenario: 'yes' | 'no';
  readonly status: LodgingClaimStatus;
}

const OUTCOMES: readonly OutcomeRow[] = rows([
  { scenario: 'yes', status: 'verified' },
  { scenario: 'no', status: 'rejected' },
]);

const MISSING_CONSENT: readonly { readonly label: string; readonly draft: ClaimDraft }[] = rows([
  { label: 'refused', draft: { callConsent: false } },
  { label: 'omitted', draft: {} },
]);

describe(
  'lodging stay verification (AAP 0.12.1 criterion 14, AAP 0.12.2)',
  { timeout: CASE_TIMEOUT_MS },
  () => {
    it.each(MISSING_CONSENT)(
      'answers 400 consent_missing when the consent is $label, and writes nothing',
      async ({ draft }) => {
        expectError(await submitClaim(draft), 400, 'consent_missing');
        expect(await t.services.db.lodgingClaim.count()).toBe(0);
        expect(
          await t.services.db.outboxMessage.count({ where: { kind: 'create_call_task' } }),
        ).toBe(0);
      },
    );

    it.each(OUTCOMES)(
      'a $scenario answer resolves the claim $status and keeps no transcript',
      async ({ scenario, status }) => {
        const { claimId, claim, task, attempt, call } = await runStayCall(scenario);
        const answer = await callRoute(t.app, {
          method: 'GET',
          url: `${CLAIMS_PATH}/${claimId}`,
          as: guest,
        });
        expect(answer.status).toBe(200);
        const dto = LodgingClaimStatusDto.parse(answer.json());
        expect(dto.status).toBe(status);
        expect(dto.resolvedAt).toBe(claim.resolvedAt?.toISOString());
        expect(claim.status).toBe(status);
        expect(task.kind).toBe('lodging_stay_verification');
        expect(task.status).toBe('completed');
        expect(task.resolvedBy).toBe('agent');
        expect(task.outcomeAt).not.toBeNull();
        expect(task.attempts).toBe(1);
        expect(attempt.outcome).toBe('completed');
        expect(attempt.confidence).toBe('high');
        expect(attempt.state).toBe('ended');
        const disclosure = call.spoken[0];
        const heard = call.spoken.map((line) => line.text).join('\n');
        expect(disclosure?.source).toBe('welcome_greeting');
        expect(disclosure?.text).toBe(call.twiml.welcomeGreeting);
        expect(disclosure?.lang).toBe(LANGUAGE);
        expect(heard.includes('Tablemate'), 'the disclosure names the assistant').toBe(true);
        expect(
          call.spoken
            .filter((line) => line.source === 'text')
            .every((line) => line.lang === LANGUAGE),
          'the dialogue stays in the city language',
        ).toBe(true);
        expect(call.languageSwitches, 'nothing switched the language mid-call').toEqual([]);
        expect(heard.includes(BOOKING_NAME), 'the question names the guest it asks about').toBe(
          true,
        );
        expect(
          heard.includes(renderedStayDate(stayFrom, LANGUAGE)) &&
            heard.includes(renderedStayDate(stayTo, LANGUAGE)),
          'the question renders both stay dates as the template does',
        ).toBe(true);
        const me = await callRoute(t.app, { method: 'GET', url: '/v1/me', as: guest });
        expect(me.status).toBe(200);
        expect(
          heard.includes(MeDto.parse(me.json()).handle),
          'no utterance carries the handle',
        ).toBe(false);
        expect(heard.includes(BOOKING_REFERENCE), 'no utterance carries the reference').toBe(false);
        expect(call.createParams?.record).toBe(false);
        expect(call.createParams?.timeLimit).toBe(CAP_CALL_SECONDS);
        expect(call.createParams?.statusCallbackEvent).toEqual([...CALL_STATUS_CALLBACK_EVENTS]);
        expect(call.failures, 'the scripted call ran without a failure').toEqual([]);
        // A lodging call keeps no transcript at any point (AAP 0.5.6, 0.12.2).
        expect(attempt.transcript === null, 'the attempt keeps no transcript').toBe(true);
        expect(attempt.transcriptDeleteAt === null, 'no transcript deadline is set').toBe(true);
      },
    );

    it.each(OUTCOMES)(
      'erases the booking details of a $scenario claim and strips its call rows',
      async ({ scenario }) => {
        const {
          claimId,
          claim,
          task: taskBefore,
          attempt: attemptBefore,
        } = await runStayCall(scenario);
        const callSid = attemptBefore.twilioCallSid;
        if (callSid === null) {
          throw new Error('the attempt never adopted its call sid');
        }
        expect(await callbackCount(callSid)).toBeGreaterThan(0);
        expect(claim.detailsErasedAt === null, 'nothing is erased before the hourly run').toBe(
          true,
        );
        t.time.advance({ hours: 1 });
        const counts = await runHourlyExpiry();
        expect(counts['bookingDetailsErased']).toBe(1);
        expect(counts['lodgingCallTasksStripped']).toBe(1);
        expect(counts['lodgingCallAttemptsStripped']).toBe(1);
        expect(counts['lodgingCallCallbacksDeleted']).toBeGreaterThan(0);
        const erased = await claimRow(claimId);
        expect(
          erased.bookingNameCiphertext === null && erased.bookingReferenceCiphertext === null,
          'both booking fields are gone',
        ).toBe(true);
        expect(erased.status).toBe(claim.status);
        expect(erased.resolvedAt?.getTime()).toBe(claim.resolvedAt?.getTime());
        const erasedAt = erased.detailsErasedAt;
        const resolvedAt = claim.resolvedAt;
        if (erasedAt === null || resolvedAt === null) {
          throw new Error('the claim carries no erase or resolution instant');
        }
        const erasedAfterMs = erasedAt.getTime() - resolvedAt.getTime();
        expect(erasedAfterMs).toBeGreaterThan(0);
        expect(erasedAfterMs).toBeLessThan(HOUR_MS * 24);
        const taskAfter = await taskById(taskBefore.id);
        expect(pick(taskAfter, RETAINED_TASK_FIELDS)).toEqual(
          pick(taskBefore, RETAINED_TASK_FIELDS),
        );
        expect(taskAfter.lodgingClaimId === null, 'the stripped task keeps no claim link').toBe(
          true,
        );
        const attemptAfter = await attemptOfTask(taskBefore.id);
        expect(pick(attemptAfter, RETAINED_ATTEMPT_FIELDS)).toEqual(
          pick(attemptBefore, RETAINED_ATTEMPT_FIELDS),
        );
        expectNullFields(attemptAfter, NULLED_ATTEMPT_FIELDS, 'the stripped attempt');
        expect(attemptAfter.llmReservedMicros).toBe(0n);
        expect(await callbackCount(callSid)).toBe(0);
        // A second run of the same step changes nothing, which is what makes it safe to retry.
        const again = await runHourlyExpiry();
        expect(again['bookingDetailsErased']).toBe(0);
        expect(again['lodgingCallTasksStripped']).toBe(0);
        expect(again['lodgingCallAttemptsStripped']).toBe(0);
        expect(again['lodgingCallCallbacksDeleted']).toBe(0);
      },
    );

    it('hands a claim no call can resolve to the operator and expires it at 72 hours', async () => {
      await t.services.db.lodging.update({ where: { id: lodging.id }, data: { phone: null } });
      const { claimId } = await createClaim();
      const created = await drain(ctx.queues.get(QUEUE.callDispatch), callDispatch);
      expect(created, 'the create_call_task row opened one dispatch job').toBe(1);
      const task = await taskOfClaim(claimId);
      expect(task.kind).toBe('lodging_stay_verification');
      expect(task.status).toBe('unreachable');
      expect(task.blockedReason).toBe('no_phone');
      expect(task.outcomeAt).not.toBeNull();
      expect(t.simulator.calls.length, 'nothing was dialed').toBe(0);
      const pending = await callRoute(t.app, {
        method: 'GET',
        url: `${CLAIMS_PATH}/${claimId}`,
        as: guest,
      });
      expect(pending.status).toBe(200);
      expect(LodgingClaimStatusDto.parse(pending.json()).status).toBe('pending_call');
      const queue = await callRoute(t.app, {
        method: 'GET',
        url: ADMIN_CLAIMS_PATH,
        as: operator,
      });
      expect(queue.status).toBe(200);
      const listed = AdminLodgingClaimsResponse.parse(queue.json()).items.find(
        (item) => item.id === claimId,
      );
      expect(listed?.status).toBe('pending_call');
      expect(listed?.detailsAvailable).toBe(true);
      const expiry = await scheduledClaimExpiry(claimId);
      if (expiry === undefined) {
        throw new Error('the claim scheduled no expiry job');
      }
      expect(expiry.name).toBe(JOB[QUEUE.lodgingClaims].claimExpire);
      expect(expiry.opts.delay).toBe(CLAIM_EXPIRY_MS);
      const expiryJob = processorJob(expiry);
      t.time.advance(CLAIM_EXPIRY_MS - 1_000);
      expect(await lodgingClaims(expiryJob, ctx)).toEqual({ expired: false, early: true });
      expect((await claimRow(claimId)).status).toBe('pending_call');
      t.time.advance({ seconds: 1 });
      expect(await lodgingClaims(expiryJob, ctx)).toEqual({ expired: true });
      const expired = await claimRow(claimId);
      expect(expired.status).toBe('unreachable');
      expect(expired.resolvedAt).not.toBeNull();
      expect((await taskById(task.id)).status).toBe('cancelled');
      const second = await createClaim(await t.tokenFor(guest));
      expect(second.claimId).not.toBe(claimId);
      expect((await runHourlyExpiry())['bookingDetailsErased']).toBe(1);
      const first = await claimRow(claimId);
      expect(
        first.bookingNameCiphertext === null && first.bookingReferenceCiphertext === null,
        'the expired claim keeps no booking details',
      ).toBe(true);
      expect(first.detailsErasedAt).not.toBeNull();
    });
  },
);
