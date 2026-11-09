/**
 * Integration tests for `POST /v1/admin/price-jobs` and the daily caps it refuses a city for.
 * Both caps are read from the loaded environment rather than a literal, so a changed
 * `CAP_CALLS_PER_CITY_DAY` or `CAP_LLM_USD_PER_CITY_DAY` moves these cases with it.
 */

import assert from 'node:assert/strict';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { JOB, QUEUE, localDateKey } from '@tablemate/server-core';
import { PriceJobResponse } from '@tablemate/shared';
import type { ErrorCode, PriceJobKind, UserRole } from '@tablemate/shared';

import { createTestApp } from '../support/app.ts';
import type { TestApp } from '../support/app.ts';
import { callRoute, expectError, makeUser, rows } from '../support/factories.ts';
import type { RouteResponse } from '../support/factories.ts';

const PRICE_JOBS = '/v1/admin/price-jobs';

const CITY = 'canggu';

const UNKNOWN_CITY = 'atlantis';

/** 18:00 UTC is 02:00 the next day in Canggu, so the UTC date and the city's local date disagree. */
const AFTER_LOCAL_MIDNIGHT = '2026-11-16T18:00:00.000Z';

const QUEUE_FOR_KIND = {
  menus: QUEUE.menuIngest,
  calls: QUEUE.callDispatch,
} as const;

const JOB_FOR_KIND = {
  menus: JOB[QUEUE.menuIngest].ingestCity,
  calls: JOB[QUEUE.callDispatch].dispatchCity,
} as const;

const KINDS: readonly { readonly kind: PriceJobKind }[] = [{ kind: 'menus' }, { kind: 'calls' }];

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.resetState();
  await t.seedCities();
});

async function operatorToken(): Promise<string> {
  return (await makeUser(t, { role: 'operator' })).accessToken;
}

function postPriceJob(token: string, body: Record<string, unknown>): Promise<RouteResponse> {
  return callRoute(t.app, { method: 'POST', url: PRICE_JOBS, as: token, body });
}

/** The city's local calendar date at `at`, which is what keys its daily budgets (AAP 0.5.6). */
function localToday(cityId: string, at: Date = t.time.now()): string {
  return localDateKey(t.services.timezoneFor(cityId), at);
}

interface DayUsage {
  readonly calls?: number;
  readonly llmSpendMicros?: number;
  readonly llmReservedMicros?: number;
}

async function recordUsage(cityId: string, localDate: string, usage: DayUsage): Promise<void> {
  await t.services.db.callBudgetDay.create({
    data: {
      cityId,
      // The `@db.Date` column takes the day as midnight UTC, so no zone can move the calendar day.
      localDate: new Date(`${localDate}T00:00:00.000Z`),
      calls: usage.calls ?? 0,
      llmSpendMicros: BigInt(usage.llmSpendMicros ?? 0),
      llmReservedMicros: BigInt(usage.llmReservedMicros ?? 0),
    },
  });
}

/**
 * A day that has used up `kind`'s cap: the calls it was allotted, or the committed language-model
 * spend it was allotted, split across both columns so that neither reaches the cap on its own — the
 * route reads the two together (AAP 0.5.6), and a day charged one way only would be refused by a
 * mistake the split rules out.
 */
function cappedUsage(kind: PriceJobKind): DayUsage {
  if (kind === 'calls') {
    return { calls: t.env.CAP_CALLS_PER_CITY_DAY };
  }
  const spend = Math.floor(t.env.capLlmMicrosPerCityDay / 2);
  return { llmSpendMicros: spend, llmReservedMicros: t.env.capLlmMicrosPerCityDay - spend };
}

interface Refusal {
  readonly name: string;
  readonly role: UserRole;
  readonly body: Record<string, unknown>;
  readonly status: number;
  readonly code: ErrorCode;
}

/**
 * The three refusals of AAP 0.5.4, one fault per case. The operator guard runs on `onRequest` and so
 * decides the traveler's case; the shared schema is validated before the handler and so decides the
 * two body cases; the unknown city is the handler's own.
 */
const REFUSALS: readonly Refusal[] = [
  {
    name: 'a traveler is refused with 403 operator_only',
    role: 'traveler',
    body: { cityId: CITY, kind: 'menus' },
    status: 403,
    code: 'operator_only',
  },
  {
    name: 'an unconfigured city is refused with 404 city_not_found',
    role: 'operator',
    body: { cityId: UNKNOWN_CITY, kind: 'menus' },
    status: 404,
    code: 'city_not_found',
  },
  {
    name: 'a kind that is neither menus nor calls is refused with 400 invalid_field',
    role: 'operator',
    body: { cityId: CITY, kind: 'both' },
    status: 400,
    code: 'invalid_field',
  },
  {
    name: 'a body without a cityId is refused with 400 invalid_field',
    role: 'operator',
    body: { kind: 'menus' },
    status: 400,
    code: 'invalid_field',
  },
];

describe('refusals (AAP 0.5.4)', () => {
  it.each(rows(REFUSALS))('$name', async ({ role, body, status, code }) => {
    const token = (await makeUser(t, { role })).accessToken;
    expectError(await postPriceJob(token, body), status, code);
  });
});

describe('daily caps (AAP 0.5.6)', () => {
  it.each(rows(KINDS))(
    'a $kind job is refused with 429 daily_cap_reached once the local day is at its cap',
    async ({ kind }) => {
      await recordUsage(CITY, localToday(CITY), cappedUsage(kind));
      expectError(
        await postPriceJob(await operatorToken(), { cityId: CITY, kind }),
        429,
        'daily_cap_reached',
      );
      const queue = t.services.queues.get(QUEUE_FOR_KIND[kind]);
      expect(await queue.getWaitingCount()).toBe(0);
    },
  );
  it('a capped row on another local day does not block the request', async () => {
    const now = t.time.at(AFTER_LOCAL_MIDNIGHT);
    const cityDate = localToday(CITY, now);
    const utcDate = localDateKey('UTC', now);
    // The row below is keyed to the UTC date, which is still yesterday in Canggu. A route that
    // compared the cap against UTC instead of the city's own day would refuse here, so this case is
    // the one that fails if the local-day key is ever widened.
    expect(cityDate).not.toBe(utcDate);
    await recordUsage(CITY, utcDate, { calls: t.env.CAP_CALLS_PER_CITY_DAY });
    const response = await postPriceJob(await operatorToken(), { cityId: CITY, kind: 'calls' });
    expect(response.status).toBe(202);
  });
  it('a day one call below the cap still queues the job', async () => {
    await recordUsage(CITY, localToday(CITY), { calls: t.env.CAP_CALLS_PER_CITY_DAY - 1 });
    const response = await postPriceJob(await operatorToken(), { cityId: CITY, kind: 'calls' });
    expect(response.status).toBe(202);
  });
});

describe('queued jobs (AAP 0.5.4, 0.5.6)', () => {
  it.each(rows(KINDS))(
    'a $kind job answers its id and is queued as the city fan-out',
    async ({ kind }) => {
      const response = await postPriceJob(await operatorToken(), { cityId: CITY, kind });
      const queue = QUEUE_FOR_KIND[kind];
      expect(response.status).toBe(202);
      const { jobId } = PriceJobResponse.parse(response.json());
      const queued = await t.services.queues.get(queue).getJob(jobId);
      assert.ok(queued !== undefined, `no job ${jobId} in the ${queue} queue`);
      assert.equal(queued.name, JOB_FOR_KIND[kind]);
      assert.deepEqual(queued.data, { cityId: CITY });
    },
  );
});
