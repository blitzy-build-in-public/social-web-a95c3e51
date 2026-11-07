/**
 * The spend cap's unit suite (AAP 0.5.6): the pure cost arithmetic, the memory stores that apply
 * the same predicates as the SQL ones, the suspension flag the meter fails closed on, the provider
 * boundary's own error contract over a stub client, every path through `runMetered` and
 * `runMeteredWithin`, and the module graph `src/llm/{adapter,openai,fake}.ts` form, each of the
 * three loaded as its own entry point.
 *
 * Most adapters here are scripted, so a count and a reported usage are exact and every assertion is
 * arithmetic. The fake provider is exercised where its own contract is the subject — the 25 USD
 * boundary over Thai, Indonesian, emoji and base64-like content, the byte-identical count and send,
 * the count mismatch that suspends every city, and the dialogue budget of one voice turn — because
 * its tokenizer is the one the cap is really measured against.
 */

import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';

import { createTestClock } from '../../src/clock.ts';
import type { TestClock } from '../../src/clock.ts';
import type { Logger } from '../../src/logger.ts';
import { EnvValidationError } from '../../src/env/common.ts';
import { loadApiEnv } from '../../src/env/api.ts';
import { loadWorkersEnv } from '../../src/env/workers.ts';
import {
  LlmBudgetRefusedError,
  LlmCountError,
  LlmProviderError,
  LlmSuspendedError,
  LlmTimeoutError,
} from '../../src/llm/adapter.ts';
import {
  FAKE_LLM_PRICES,
  createFakeLlmAdapter,
  serializeFakeInputPart,
} from '../../src/llm/fake.ts';
import type { FakeLlmAdapter } from '../../src/llm/fake.ts';
import type {
  LlmAdapter,
  LlmCallOptions,
  LlmRequest,
  LlmResult,
  LlmUsage,
} from '../../src/llm/adapter.ts';
import {
  LLM_COUNT_MISMATCHES_KEY,
  LLM_SUSPENDED_KEY,
  boundMicros,
  costMicros,
  createLlmSpend,
  createRedisSuspensionStore,
  createSqlSpendStore,
  parseUsdPerMTok,
} from '../../src/llm/spend.ts';
import {
  OPENAI_DEFAULT_TIMEOUT_MS,
  SUPPORTED_MODELS,
  createOpenAiAdapter,
} from '../../src/llm/openai.ts';
import type {
  OpenAiCallOptions,
  OpenAiResponseSummary,
  OpenAiResponsesClient,
} from '../../src/llm/openai.ts';
import type {
  LlmPrices,
  LlmReservation,
  LlmSpend,
  SpendSqlExecutor,
  SpendStore,
  SuspensionRedis,
  SuspensionStore,
} from '../../src/llm/spend.ts';

/**
 * The OpenAI SDK's own entry point, replaced for this file: `openai.ts` imports the client class and
 * three of its error classes, and the real ones must survive (a suite scripts an `AbortError` by
 * name), so only the constructor is taken over. Every other case injects a stub client, so nothing
 * else here depends on the replacement, and `ctor` lets a case read the options the adapter built
 * its own client with.
 */
const ctor = vi.hoisted(() => vi.fn());

vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>();
  class MockOpenAI {
    constructor(options: unknown) {
      ctor(options);
    }
    responses = {};
  }
  return { ...actual, default: MockOpenAI, OpenAI: MockOpenAI };
});

/** A type-level check: a real ioredis client satisfies the contract the suspension store needs. */
export type RedisSatisfiesSuspensionRedis = AssertAssignable<SuspensionRedis, Redis>;

type AssertAssignable<Shape, Candidate extends Shape> = Candidate;

/** AAP 0.5.6's own fake-mode prices, and a pair that makes one counted token cost one micro-dollar. */
const PRICES: LlmPrices = { inputUsdPerMTok: '0.40', outputUsdPerMTok: '1.60' };
const UNIT_PRICES: LlmPrices = { inputUsdPerMTok: '1', outputUsdPerMTok: '1' };

/** 25 USD, `CAP_LLM_USD_PER_CITY_DAY` in micro-dollars. */
const CAP_MICROS = 25_000_000;

/** Text a log line must never carry. */
const SECRET_TEXT = 'MENU-TEXT-THAT-MUST-NOT-BE-LOGGED';

/**
 * The zones the harness knows, so `timezoneFor` throws for anything else. The five launch cities are
 * the ones `config/cities.json` carries, which is what makes a local-day assertion a real one;
 * `auckland` is kept for the easternmost case.
 */
const TIMEZONES: Record<string, string> = {
  lisbon: 'Europe/Lisbon',
  'mexico-city': 'America/Mexico_City',
  medellin: 'America/Bogota',
  'chiang-mai': 'Asia/Bangkok',
  canggu: 'Asia/Makassar',
  auckland: 'Pacific/Auckland',
};

function timezoneFor(cityId: string): string {
  const zone = TIMEZONES[cityId];
  if (zone === undefined) {
    throw new RangeError(`unknown city: ${cityId}`);
  }
  return zone;
}

function request(maxTokens = 100): LlmRequest {
  return { system: SECRET_TEXT, messages: [{ role: 'user', content: SECRET_TEXT }], maxTokens };
}

/** One `call_budget_day` row in memory, with the predicates the SQL statements carry. */
class MemorySpendStore implements SpendStore {
  readonly rows = new Map<string, { spent: number; reserved: number }>();
  /** The highest `spent + reserved` this store has ever held, which the cap bounds. */
  maxObserved = 0;

  row(cityId: string, localDate: string): { spent: number; reserved: number } {
    const key = `${cityId}/${localDate}`;
    const existing = this.rows.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = { spent: 0, reserved: 0 };
    this.rows.set(key, created);
    return created;
  }

  // The three mutators below answer with a promise without being `async`: their bodies run
  // synchronously, which is what makes one reservation atomic, and an `async` method that awaited
  // nothing would say the same thing less plainly.
  tryReserve(args: {
    cityId: string;
    localDate: string;
    micros: number;
    capMicros: number;
  }): Promise<boolean> {
    const row = this.row(args.cityId, args.localDate);
    // Read and write in one synchronous step: the predicate is re-checked against the current row,
    // exactly as PostgreSQL re-evaluates its own `WHERE` under the row lock.
    if (row.spent + row.reserved + args.micros > args.capMicros) {
      return Promise.resolve(false);
    }
    row.reserved += args.micros;
    this.observe(row);
    return Promise.resolve(true);
  }

  charge(reservation: LlmReservation, chargedMicros: number): Promise<void> {
    const row = this.row(reservation.cityId, reservation.localDate);
    row.spent += chargedMicros;
    row.reserved = Math.max(0, row.reserved - Math.min(chargedMicros, reservation.micros));
    this.observe(row);
    return Promise.resolve();
  }

  release(reservation: LlmReservation, micros: number): Promise<void> {
    const row = this.row(reservation.cityId, reservation.localDate);
    row.reserved = Math.max(0, row.reserved - micros);
    this.observe(row);
    return Promise.resolve();
  }

  private observe(row: { spent: number; reserved: number }): void {
    this.maxObserved = Math.max(this.maxObserved, row.spent + row.reserved);
  }
}

/**
 * The suspension flag in memory: with `throwOnRead` set it rejects the way the Redis one does when
 * its connection is lost, and the meter is what fails closed on the rejection.
 */
class MemorySuspensionStore implements SuspensionStore {
  private suspended = false;
  private mismatches = 0;
  throwOnRead = false;

  isSuspended(): Promise<boolean> {
    if (this.throwOnRead) {
      // Rejected rather than thrown, so this store answers as the Redis one does on a lost
      // connection; the meter's fail-closed path never has to know which store it holds.
      return Promise.reject(new Error('redis is down'));
    }
    return Promise.resolve(this.suspended);
  }

  suspend(_reason: 'llm_count_mismatch', _since: Date): Promise<void> {
    this.suspended = true;
    this.mismatches += 1;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.suspended = false;
    return Promise.resolve();
  }

  mismatchCount(): Promise<number> {
    return Promise.resolve(this.mismatches);
  }
}

/** What a {@link ScriptedAdapter} does on the wire. */
interface AdapterScript {
  count: number;
  usage?: LlmUsage | null;
  countThrows?: Error;
  sendThrows?: Error;
  /** Runs inside the count, so a suite can move the clock between a count and a send. */
  onCount?: () => void;
}

/** An adapter that counts and answers exactly as scripted, recording what it was asked to do. */
class ScriptedAdapter implements LlmAdapter {
  readonly provider = 'fake' as const;
  readonly model = 'scripted-1';
  readonly counted: LlmRequest[] = [];
  readonly countSignals: (AbortSignal | undefined)[] = [];
  readonly sent: LlmRequest[] = [];
  readonly sendTimeouts: number[] = [];
  readonly sendSignals: (AbortSignal | undefined)[] = [];
  private readonly script: AdapterScript;

  constructor(script: AdapterScript) {
    this.script = script;
  }

  // Records what it was asked for, then answers synchronously as a promise: a scripted failure is
  // rejected rather than thrown, so the adapter under test catches exactly what a provider returns.
  countInputTokens(request: LlmRequest, options: LlmCallOptions): Promise<number> {
    this.counted.push(request);
    this.countSignals.push(options.signal);
    this.script.onCount?.();
    const failure = this.script.countThrows;
    return failure === undefined ? Promise.resolve(this.script.count) : Promise.reject(failure);
  }

  complete(request: LlmRequest, options: LlmCallOptions): Promise<LlmResult> {
    this.sent.push(request);
    this.sendTimeouts.push(options.timeoutMs);
    this.sendSignals.push(options.signal);
    const failure = this.script.sendThrows;
    return failure === undefined
      ? Promise.resolve({ text: '', json: null, usage: this.script.usage ?? null })
      : Promise.reject(failure);
  }
}

interface LogEntry {
  level: 'warn' | 'error';
  fields: Record<string, unknown>;
  message: string;
}

/** A logger that keeps every line, so a suite can assert what was and was not written. */
function createCaptureLogger(): { logger: Pick<Logger, 'warn' | 'error'>; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const push = (level: 'warn' | 'error', args: unknown[]): void => {
    const first = args[0];
    const second = args[1];
    entries.push({
      level,
      fields:
        typeof first === 'object' && first !== null
          ? { ...(first as Record<string, unknown>) }
          : {},
      message: typeof second === 'string' ? second : typeof first === 'string' ? first : '',
    });
  };
  return {
    entries,
    logger: {
      warn: (...args: unknown[]): void => push('warn', args),
      error: (...args: unknown[]): void => push('error', args),
    },
  };
}

interface Harness {
  spend: LlmSpend;
  store: MemorySpendStore;
  suspension: MemorySuspensionStore;
  clock: TestClock;
  entries: LogEntry[];
}

function harness(options?: {
  prices?: LlmPrices;
  capMicros?: number;
  suspension?: SuspensionStore;
  clock?: TestClock;
}): Harness {
  const store = new MemorySpendStore();
  const suspension = new MemorySuspensionStore();
  const clock = options?.clock ?? createTestClock();
  const captured = createCaptureLogger();
  const spend = createLlmSpend({
    store,
    suspension: options?.suspension ?? suspension,
    clock,
    capMicros: options?.capMicros ?? CAP_MICROS,
    prices: options?.prices ?? PRICES,
    timezoneFor,
    logger: captured.logger,
  });
  return { spend, store, suspension, clock, entries: captured.entries };
}

describe('parseUsdPerMTok', () => {
  it.each([
    ['0.40', 400_000n],
    ['1', 1_000_000n],
    ['0.000001', 1n],
    ['12.5', 12_500_000n],
  ])('scales %s to micro-dollars per token times 10^6', (value, expected) => {
    expect(parseUsdPerMTok(value)).toBe(expected);
  });

  it.each([
    '0',
    '0.000000',
    '1.0000000',
    '-1',
    '1.',
    '.5',
    '1e3',
    '1e-3',
    ' 1',
    '01',
    'abc',
    '',
    '0.1234567',
  ])('rejects %s', (value) => {
    expect(() => parseUsdPerMTok(value)).toThrow(RangeError);
    expect(() => parseUsdPerMTok(value)).toThrow('invalid_llm_price');
  });
});

describe('costMicros', () => {
  it('rounds one token at 0.40 up to one micro-dollar and prices a million exactly', () => {
    expect(costMicros(1, 0, UNIT_PRICES)).toBe(1);
    expect(costMicros(1_000_000, 0, PRICES)).toBe(400_000);
  });

  it('ceils the exact sum of the input and output parts', () => {
    // 1000 × 0.4 + 100 × 1.6 = 560 micro-dollars exactly; one micro more would still round to 560.
    expect(costMicros(1000, 100, PRICES)).toBe(560);
    expect(boundMicros(1000, 100, PRICES)).toBe(560);
  });

  // AAP 0.5.6: "the cost in micro-dollars is rounded up", which is one ceiling over the exact sum
  // and not one per component — the 1-in/1-out row is 2 where rounding each part would give 3, and
  // the sub-micro rows are 1 where truncating would give 0.
  it.each([
    ['one input token', 1, 0, '0.4', '1.6', 1],
    ['ten input tokens', 10, 0, '0.4', '1.6', 4],
    ['a price a third of a micro-dollar per token', 3, 0, '0.333333', '1.6', 1],
    ['the smallest price the parser accepts', 1, 0, '0.000001', '1.6', 1],
    ['a million tokens', 1_000_000, 0, '2.5', '1.6', 2_500_000],
    ['one input and one output token', 1, 1, '0.4', '1.6', 2],
    ['seven output tokens', 0, 7, '0.4', '1.6', 12],
    ['nothing at all', 0, 0, '0.4', '1.6', 0],
  ])('rounds %s up', (_name, inputTokens, outputTokens, inputPrice, outputPrice, expected) => {
    const prices: LlmPrices = { inputUsdPerMTok: inputPrice, outputUsdPerMTok: outputPrice };
    expect(costMicros(inputTokens, outputTokens, prices)).toBe(expected);
    // The reservation bound is the same ceiling, so a bound can never round below a charge.
    expect(boundMicros(inputTokens, outputTokens, prices)).toBe(expected);
  });

  it.each([
    [-1, 0],
    [1.5, 0],
    [0, -1],
    [0, 0.5],
  ])('rejects the counts (%s, %s)', (inputTokens, outputTokens) => {
    expect(() => costMicros(inputTokens, outputTokens, PRICES)).toThrow(RangeError);
  });

  it('rejects a result beyond Number.MAX_SAFE_INTEGER', () => {
    const huge: LlmPrices = { inputUsdPerMTok: '999999', outputUsdPerMTok: '1' };
    expect(() => costMicros(Number.MAX_SAFE_INTEGER, 0, huge)).toThrow('llm_cost_out_of_range');
  });

  it('rejects a price that is not a positive six-place decimal', () => {
    expect(() => costMicros(1, 0, { inputUsdPerMTok: '0.4', outputUsdPerMTok: '2e-7' })).toThrow(
      'invalid_llm_price',
    );
  });
});

describe('createSqlSpendStore', () => {
  /** An executor that records the statement it was handed and answers with the given rows. */
  function recordingExecutor(rows: unknown[]): { sql: SpendSqlExecutor; statements: string[] } {
    const statements: string[] = [];
    const sql: SpendSqlExecutor = <T>(strings: TemplateStringsArray, ...values: unknown[]) => {
      // Whitespace is collapsed, so an assertion is about the SQL and its parameter order rather
      // than about the indentation the statement is written with.
      statements.push(
        strings
          .reduce(
            (parts: string[], part, index) =>
              index < values.length ? [...parts, part, `$${index + 1}`] : [...parts, part],
            [] as string[],
          )
          .join('')
          .replace(/\s+/g, ' ')
          .trim(),
      );
      return Promise.resolve(rows as T);
    };
    return { sql, statements };
  }

  it('reserves only when a row comes back, and issues the guarded update', async () => {
    const granted = recordingExecutor([{ city_id: 'lisbon' }]);
    const store = createSqlSpendStore(granted.sql);
    const reserved = await store.tryReserve({
      cityId: 'lisbon',
      localDate: '2026-11-04',
      micros: 500,
      capMicros: CAP_MICROS,
    });

    expect(reserved).toBe(true);
    expect(granted.statements).toHaveLength(2);
    expect(granted.statements[0]).toContain('INSERT INTO call_budget_day');
    expect(granted.statements[0]).toContain('ON CONFLICT (city_id, local_date) DO NOTHING');
    const update = granted.statements[1] ?? '';
    expect(update).toContain('UPDATE call_budget_day');
    expect(update).toContain(
      'llm_spend_micros + llm_reserved_micros + CAST($4 AS bigint) <= CAST($5 AS bigint)',
    );
    expect(update).toContain('RETURNING city_id');
  });

  it('reports a refusal when the guarded update touches no row', async () => {
    const refused = recordingExecutor([]);
    const store = createSqlSpendStore(refused.sql);
    const reserved = await store.tryReserve({
      cityId: 'lisbon',
      localDate: '2026-11-04',
      micros: CAP_MICROS,
      capMicros: CAP_MICROS,
    });
    expect(reserved).toBe(false);
  });

  it('charges spent and released in one statement, and releases the remainder', async () => {
    const recording = recordingExecutor([{ city_id: 'lisbon' }]);
    const store = createSqlSpendStore(recording.sql);
    const reservation: LlmReservation = { cityId: 'lisbon', localDate: '2026-11-04', micros: 900 };

    await store.charge(reservation, 400);
    expect(recording.statements[0]).toContain('llm_spend_micros = llm_spend_micros + CAST($1');
    expect(recording.statements[0]).toContain('GREATEST(');
    expect(recording.statements[0]).toContain('LEAST(CAST($2 AS bigint), CAST($3 AS bigint))');

    await store.release(reservation, 500);
    expect(recording.statements[1]).toContain(
      'llm_reserved_micros = GREATEST(llm_reserved_micros - CAST($1 AS bigint), 0)',
    );
  });

  it('issues no statement for a zero release and refuses a negative amount before any SQL', async () => {
    const recording = recordingExecutor([{ city_id: 'lisbon' }]);
    const store = createSqlSpendStore(recording.sql);
    const reservation: LlmReservation = { cityId: 'lisbon', localDate: '2026-11-04', micros: 900 };

    await store.release(reservation, 0);
    expect(recording.statements).toHaveLength(0);

    await expect(store.release(reservation, -1)).rejects.toThrow(RangeError);
    await expect(store.charge(reservation, -1)).rejects.toThrow(RangeError);
    await expect(
      store.tryReserve({
        cityId: 'lisbon',
        localDate: '2026-11-04',
        micros: -1,
        capMicros: CAP_MICROS,
      }),
    ).rejects.toThrow(RangeError);
    expect(recording.statements).toHaveLength(0);
  });
});

describe('createRedisSuspensionStore', () => {
  /** A Redis stand-in holding the two keys, with a switch to make reads fail. */
  function fakeRedis(): {
    redis: SuspensionRedis;
    values: Map<string, string>;
    failReads: boolean;
  } {
    const state = { failReads: false };
    const values = new Map<string, string>();
    const redis: SuspensionRedis = {
      get: (key: string): Promise<string | null> => {
        if (state.failReads) {
          return Promise.reject(new Error('connection lost'));
        }
        return Promise.resolve(values.get(key) ?? null);
      },
      set: (key: string, value: string): Promise<unknown> => {
        values.set(key, value);
        return Promise.resolve('OK');
      },
      incr: (key: string): Promise<number> => {
        const next = Number.parseInt(values.get(key) ?? '0', 10) + 1;
        values.set(key, `${next}`);
        return Promise.resolve(next);
      },
      del: (key: string): Promise<number> => Promise.resolve(values.delete(key) ? 1 : 0),
    };
    return {
      redis,
      values,
      get failReads(): boolean {
        return state.failReads;
      },
      set failReads(next: boolean) {
        state.failReads = next;
      },
    };
  }

  it('suspends through the flag key, counts the event and re-enables on clear', async () => {
    const fake = fakeRedis();
    const store = createRedisSuspensionStore(fake.redis);
    expect(await store.isSuspended()).toBe(false);
    expect(await store.mismatchCount()).toBe(0);

    await store.suspend('llm_count_mismatch', new Date('2026-11-04T12:00:00.000Z'));

    expect(fake.values.has(LLM_SUSPENDED_KEY)).toBe(true);
    expect(fake.values.get(LLM_SUSPENDED_KEY)).toBe(
      '{"since":"2026-11-04T12:00:00.000Z","reason":"llm_count_mismatch"}',
    );
    expect(fake.values.get(LLM_COUNT_MISMATCHES_KEY)).toBe('1');
    expect(await store.isSuspended()).toBe(true);
    expect(await store.mismatchCount()).toBe(1);

    await store.clear();
    expect(await store.isSuspended()).toBe(false);
    expect(await store.mismatchCount()).toBe(1);
  });

  it('rejects an unreadable flag, leaving the meter to fail closed, and reads a bad counter as zero', async () => {
    const fake = fakeRedis();
    const store = createRedisSuspensionStore(fake.redis);
    fake.values.set(LLM_COUNT_MISMATCHES_KEY, 'not-a-number');
    expect(await store.mismatchCount()).toBe(0);

    fake.failReads = true;
    await expect(store.isSuspended()).rejects.toThrow('connection lost');
  });

  it('lets a Redis outage reach the meter, which refuses every city and logs the cause', async () => {
    const fake = fakeRedis();
    const suspension = createRedisSuspensionStore(fake.redis);
    const { spend, entries } = harness({ suspension });
    const adapter = new ScriptedAdapter({ count: 1 });
    fake.failReads = true;

    expect(await spend.reserveLlm('lisbon', 1)).toBeNull();
    await expect(
      spend.runMetered(adapter, request(), { cityId: 'lisbon', timeoutMs: 1000 }),
    ).rejects.toThrow(LlmSuspendedError);
    expect(adapter.counted).toHaveLength(0);
    expect(adapter.sent).toHaveLength(0);

    // The refused reservation and the refused turn each leave exactly one line naming the cause, so
    // the outage is never silent and never mistaken for an operator suspension.
    expect(entries.map((entry) => entry.fields['event'])).toEqual([
      'llm_suspension_store_unavailable',
      'llm_suspension_store_unavailable',
    ]);
    expect(entries.every((entry) => typeof entry.fields['code'] === 'string')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(SECRET_TEXT);
  });
});

describe('createLlmSpend', () => {
  it('refuses a cap or a price that cannot be metered', () => {
    const base = {
      store: new MemorySpendStore(),
      suspension: new MemorySuspensionStore(),
      clock: createTestClock(),
      prices: PRICES,
      timezoneFor,
      logger: createCaptureLogger().logger,
    };
    expect(() => createLlmSpend({ ...base, capMicros: 0 })).toThrow(RangeError);
    expect(() => createLlmSpend({ ...base, capMicros: 1.5 })).toThrow(RangeError);
    expect(() =>
      createLlmSpend({
        ...base,
        capMicros: CAP_MICROS,
        prices: { inputUsdPerMTok: '0.4', outputUsdPerMTok: '0.0000001' },
      }),
    ).toThrow('invalid_llm_price');
  });

  it('books a reservation against the city local day, and refuses one over the cap', async () => {
    const { spend, store } = harness();

    const lisbon = await spend.reserveLlm('lisbon', 700);
    const auckland = await spend.reserveLlm('auckland', 300);
    // The frozen clock reads 2026-11-04T12:00:00Z, which is 2026-11-05 in Auckland: two cities are
    // two counters on two days, not one shared total.
    expect(lisbon).toEqual({ cityId: 'lisbon', localDate: '2026-11-04', micros: 700 });
    expect(auckland).toEqual({ cityId: 'auckland', localDate: '2026-11-05', micros: 300 });
    expect(store.row('lisbon', '2026-11-04').reserved).toBe(700);

    expect(await spend.reserveLlm('lisbon', CAP_MICROS)).toBeNull();
    await expect(spend.reserveLlm('nowhere', 1)).rejects.toThrow(RangeError);
  });

  it('reserves nothing while suspended, without consulting the city configuration', async () => {
    const suspension = new MemorySuspensionStore();
    await suspension.suspend('llm_count_mismatch', new Date('2026-11-04T12:00:00.000Z'));
    const { spend } = harness({ suspension });
    expect(await spend.reserveLlm('nowhere', 1)).toBeNull();
  });

  it('fails closed and logs a code when the suspension flag cannot be read', async () => {
    const suspension = new MemorySuspensionStore();
    suspension.throwOnRead = true;
    const { spend, entries } = harness({ suspension });
    const adapter = new ScriptedAdapter({ count: 1 });

    expect(await spend.reserveLlm('lisbon', 1)).toBeNull();
    await expect(
      spend.runMetered(adapter, request(), { cityId: 'lisbon', timeoutMs: 1000 }),
    ).rejects.toThrow(LlmSuspendedError);
    expect(adapter.counted).toHaveLength(0);
    expect(adapter.sent).toHaveLength(0);
    expect(entries.map((entry) => entry.fields['event'])).toContain(
      'llm_suspension_store_unavailable',
    );
    expect(entries.every((entry) => !JSON.stringify(entry).includes(SECRET_TEXT))).toBe(true);
  });

  it('propagates a store failure rather than reading it as a refusal', async () => {
    const store = new MemorySpendStore();
    const failing: SpendStore = {
      tryReserve: () => Promise.reject(new Error('database is down')),
      charge: store.charge.bind(store),
      release: store.release.bind(store),
    };
    const { spend } = harness({ suspension: new MemorySuspensionStore() });
    const withFailingStore = createLlmSpend({
      store: failing,
      suspension: new MemorySuspensionStore(),
      clock: createTestClock(),
      capMicros: CAP_MICROS,
      prices: PRICES,
      timezoneFor,
      logger: createCaptureLogger().logger,
    });
    await expect(withFailingStore.reserveLlm('lisbon', 1)).rejects.toThrow('database is down');
    await expect(spend.reserveLlm('lisbon', 1)).resolves.not.toBeNull();
  });
});

/** The error a rejected promise carried, for asserting on its fields. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

/** A reservation the meter granted, or a test failure where it should have. */
async function grantedReservation(
  spend: LlmSpend,
  cityId: string,
  micros: number,
): Promise<LlmReservation> {
  const reservation = await spend.reserveLlm(cityId, micros);
  if (reservation === null) {
    throw new Error('expected the meter to grant the reservation');
  }
  return reservation;
}

describe('runMetered', () => {
  it('charges the reported usage and releases the rest of the reservation', async () => {
    const { spend, store, entries } = harness();
    const adapter = new ScriptedAdapter({
      count: 1000,
      usage: { inputTokens: 1000, outputTokens: 40 },
    });

    const charge = await spend.runMetered(adapter, request(100), {
      cityId: 'lisbon',
      timeoutMs: 60_000,
    });

    const row = store.row('lisbon', '2026-11-04');
    expect(charge.countedInputTokens).toBe(1000);
    expect(charge.chargedMicros).toBe(costMicros(1000, 40, PRICES));
    expect(row.spent).toBe(464);
    expect(row.reserved).toBe(0);
    expect(adapter.counted).toHaveLength(1);
    expect(adapter.sent).toHaveLength(1);
    expect(entries).toHaveLength(0);
  });

  it('charges the reservation when the provider reports no usage', async () => {
    const { spend, store, suspension } = harness();
    const adapter = new ScriptedAdapter({ count: 1000, usage: null });

    const charge = await spend.runMetered(adapter, request(100), {
      cityId: 'lisbon',
      timeoutMs: 60_000,
    });

    expect(charge.chargedMicros).toBe(boundMicros(1000, 100, PRICES));
    expect(store.row('lisbon', '2026-11-04').reserved).toBe(0);
    expect(await suspension.isSuspended()).toBe(false);
  });

  it('counts a refused request exactly once and never sends it', async () => {
    const { spend, store, entries } = harness({ capMicros: 100 });
    const adapter = new ScriptedAdapter({ count: 1000 });

    const error = await rejection(
      spend.runMetered(adapter, request(100), { cityId: 'lisbon', timeoutMs: 60_000 }),
    );

    expect(error).toBeInstanceOf(LlmBudgetRefusedError);
    expect((error as LlmBudgetRefusedError).scope).toBe('city_cap');
    expect((error as LlmBudgetRefusedError).boundMicros).toBe(boundMicros(1000, 100, PRICES));
    expect(adapter.counted).toHaveLength(1);
    expect(adapter.sent).toHaveLength(0);
    expect(store.row('lisbon', '2026-11-04').spent).toBe(0);
    expect(store.row('lisbon', '2026-11-04').reserved).toBe(0);
    expect(entries).toHaveLength(0);
  });

  it('sends nothing and reserves nothing when the count fails', async () => {
    const { spend, store } = harness();
    const adapter = new ScriptedAdapter({ count: 0, countThrows: new LlmCountError('provider') });

    const error = await rejection(
      spend.runMetered(adapter, request(100), { cityId: 'lisbon', timeoutMs: 60_000 }),
    );

    expect(error).toBeInstanceOf(LlmCountError);
    expect(adapter.counted).toHaveLength(1);
    expect(adapter.sent).toHaveLength(0);
    expect(store.rows.size).toBe(0);
  });

  it('turns any other count failure, and a count that is not one, into a count error', async () => {
    const { spend } = harness();
    const transport = await rejection(
      spend.runMetered(
        new ScriptedAdapter({ count: 0, countThrows: new Error('socket hung up') }),
        request(),
        {
          cityId: 'lisbon',
          timeoutMs: 60_000,
        },
      ),
    );
    expect(transport).toBeInstanceOf(LlmCountError);
    expect((transport as LlmCountError).reason).toBe('provider');

    const fractional = await rejection(
      spend.runMetered(new ScriptedAdapter({ count: 1.5 }), request(), {
        cityId: 'lisbon',
        timeoutMs: 60_000,
      }),
    );
    expect(fractional).toBeInstanceOf(LlmCountError);
    expect((fractional as LlmCountError).reason).toBe('invalid_count');
  });

  it.each([
    ['a provider error', new LlmProviderError({ status: 500 })],
    ['a timeout', new LlmTimeoutError('timeout')],
    ['an unexpected failure', new Error('unexpected')],
  ])('charges the whole reservation for %s', async (_name, thrown) => {
    const { spend, store } = harness();
    const bound = boundMicros(1000, 100, PRICES);
    const adapter = new ScriptedAdapter({ count: 1000, sendThrows: thrown });

    const error = await rejection(
      spend.runMetered(adapter, request(100), { cityId: 'lisbon', timeoutMs: 60_000 }),
    );

    expect(store.row('lisbon', '2026-11-04').spent).toBe(bound);
    expect(store.row('lisbon', '2026-11-04').reserved).toBe(0);
    expect((error as { chargedMicros?: number }).chargedMicros).toBe(bound);
  });

  it('reports an unexpected send failure as a wrapped provider error', async () => {
    const { spend } = harness();
    const adapter = new ScriptedAdapter({ count: 10, sendThrows: new Error('unexpected') });

    const error = await rejection(
      spend.runMetered(adapter, request(10), { cityId: 'lisbon', timeoutMs: 60_000 }),
    );

    expect(error).toBeInstanceOf(LlmProviderError);
    expect((error as LlmProviderError).cause).toBeInstanceOf(Error);
  });

  it('charges in full, logs once without content and suspends every city on a mismatch', async () => {
    const { spend, store, suspension, entries } = harness();
    const bound = boundMicros(1000, 100, PRICES);
    const adapter = new ScriptedAdapter({
      count: 1000,
      usage: { inputTokens: 1005, outputTokens: 10 },
    });

    const charge = await spend.runMetered(adapter, request(100), {
      cityId: 'lisbon',
      timeoutMs: 60_000,
    });

    // The reported cost of 1005 × 0.4 + 10 × 1.6 is below the bound, so the bound is charged.
    expect(charge.chargedMicros).toBe(bound);
    expect(store.row('lisbon', '2026-11-04').spent).toBe(bound);
    const warns = entries.filter((entry) => entry.fields['event'] === 'llm_count_mismatch');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toBe('llm_count_mismatch');
    expect(warns[0]?.fields).toMatchObject({
      provider: 'fake',
      model: 'scripted-1',
      counted: 1000,
      reportedInput: 1005,
      reportedOutput: 10,
      maxTokens: 100,
    });
    expect(JSON.stringify(entries)).not.toContain(SECRET_TEXT);
    expect(await suspension.mismatchCount()).toBe(1);

    const otherCity = new ScriptedAdapter({ count: 1000 });
    await expect(
      spend.runMetered(otherCity, request(100), { cityId: 'auckland', timeoutMs: 60_000 }),
    ).rejects.toThrow(LlmSuspendedError);
    expect(otherCity.counted).toHaveLength(0);

    await suspension.clear();
    const afterClear = new ScriptedAdapter({
      count: 1000,
      usage: { inputTokens: 1000, outputTokens: 10 },
    });
    await expect(
      spend.runMetered(afterClear, request(100), { cityId: 'auckland', timeoutMs: 60_000 }),
    ).resolves.toBeDefined();
  });

  it('treats an output past maxTokens as a mismatch, and prices an unpriceable usage at the bound', async () => {
    const overOutput = harness();
    const adapter = new ScriptedAdapter({
      count: 10,
      usage: { inputTokens: 10, outputTokens: 11 },
    });
    const charge = await overOutput.spend.runMetered(adapter, request(10), {
      cityId: 'lisbon',
      timeoutMs: 60_000,
    });
    // The bound is cost(10, 10); the reported output past maxTokens costs 22, which is charged.
    expect(charge.chargedMicros).toBe(costMicros(10, 11, PRICES));
    expect(await overOutput.suspension.isSuspended()).toBe(true);

    const unpriceable = harness();
    const fractional = new ScriptedAdapter({
      count: 1000,
      usage: { inputTokens: 1000.5, outputTokens: 10 },
    });
    const second = await unpriceable.spend.runMetered(fractional, request(100), {
      cityId: 'lisbon',
      timeoutMs: 60_000,
    });
    expect(second.chargedMicros).toBe(boundMicros(1000, 100, PRICES));
    expect(await unpriceable.suspension.isSuspended()).toBe(true);
  });

  it('shares one deadline between the count and the send', async () => {
    const { spend, clock } = harness();
    const adapter = new ScriptedAdapter({
      count: 10,
      usage: { inputTokens: 10, outputTokens: 1 },
      onCount: () => clock.advance(5000),
    });

    await spend.runMetered(adapter, request(10), { cityId: 'lisbon', timeoutMs: 3000 });

    // The 3 s turn had 5 s of it consumed by the count, so the send gets the 1 ms floor.
    expect(adapter.sendTimeouts).toEqual([1]);
  });

  it('passes the caller signal to the count and to the send', async () => {
    const { spend } = harness();
    const adapter = new ScriptedAdapter({
      count: 10,
      usage: { inputTokens: 10, outputTokens: 1 },
    });
    const controller = new AbortController();

    await spend.runMetered(adapter, request(10), {
      cityId: 'lisbon',
      timeoutMs: 3000,
      signal: controller.signal,
    });

    // A relay socket that closed, or a cancelled job, cancels the count as well as the send.
    expect(adapter.countSignals).toEqual([controller.signal]);
    expect(adapter.sendSignals).toEqual([controller.signal]);
  });

  it('never lets concurrent requests charge past the cap', async () => {
    const { spend, store } = harness({ prices: UNIT_PRICES });
    const adapter = new ScriptedAdapter({
      count: 1000,
      usage: { inputTokens: 1000, outputTokens: 999_000 },
    });
    expect(boundMicros(1000, 999_000, UNIT_PRICES)).toBe(1_000_000);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        spend.runMetered(adapter, request(999_000), { cityId: 'lisbon', timeoutMs: 60_000 }),
      ),
    );

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const refused = outcomes.filter(
      (outcome) => outcome.status === 'rejected' && outcome.reason instanceof LlmBudgetRefusedError,
    );
    expect(fulfilled).toHaveLength(25);
    expect(refused).toHaveLength(5);
    expect(adapter.counted).toHaveLength(30);
    expect(adapter.sent).toHaveLength(25);

    const row = store.row('lisbon', '2026-11-04');
    expect(row.spent).toBe(CAP_MICROS);
    expect(row.spent + row.reserved).toBeLessThanOrEqual(CAP_MICROS);
  });
});

describe('runMeteredWithin', () => {
  const scope: LlmReservation = { cityId: 'lisbon', localDate: '2026-11-04', micros: 1000 };

  it('charges a turn inside the reservation and returns what is left of it', async () => {
    const { spend, store } = harness({ prices: UNIT_PRICES });
    await store.tryReserve({ ...scope, capMicros: CAP_MICROS });
    const adapter = new ScriptedAdapter({
      count: 100,
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const turn = await spend.runMeteredWithin(adapter, request(50), {
      reservation: scope,
      remainingMicros: 1000,
      timeoutMs: 3000,
    });

    expect(turn.countedInputTokens).toBe(100);
    expect(turn.chargedMicros).toBe(150);
    expect(turn.remainingMicros).toBe(850);
    expect(store.row('lisbon', '2026-11-04').spent).toBe(150);
    expect(store.row('lisbon', '2026-11-04').reserved).toBe(850);
  });

  it('refuses a turn that does not fit, without sending or charging anything', async () => {
    const { spend, store } = harness({ prices: UNIT_PRICES });
    const adapter = new ScriptedAdapter({
      count: 500,
      usage: { inputTokens: 500, outputTokens: 900 },
    });

    const error = await rejection(
      spend.runMeteredWithin(adapter, request(900), {
        reservation: scope,
        remainingMicros: 1000,
        timeoutMs: 3000,
      }),
    );

    expect(error).toBeInstanceOf(LlmBudgetRefusedError);
    expect((error as LlmBudgetRefusedError).scope).toBe('reservation');
    expect((error as LlmBudgetRefusedError).boundMicros).toBe(1400);
    expect((error as LlmBudgetRefusedError).availableMicros).toBe(1000);
    expect(adapter.counted).toHaveLength(1);
    expect(adapter.sent).toHaveLength(0);
    expect(store.rows.size).toBe(0);
  });

  it('charges the turn bound when the send fails, and reports it on the error', async () => {
    const { spend, store } = harness({ prices: UNIT_PRICES });
    const adapter = new ScriptedAdapter({ count: 100, sendThrows: new LlmTimeoutError('timeout') });

    const error = await rejection(
      spend.runMeteredWithin(adapter, request(50), {
        reservation: scope,
        remainingMicros: 1000,
        timeoutMs: 3000,
      }),
    );

    expect(error).toBeInstanceOf(LlmTimeoutError);
    expect((error as LlmTimeoutError).chargedMicros).toBe(150);
    expect(store.row('lisbon', '2026-11-04').spent).toBe(150);
    expect(store.row('lisbon', '2026-11-04').reserved).toBe(0);
  });

  it('charges a mismatch in full and leaves no remainder', async () => {
    const { spend, store, suspension } = harness({ prices: UNIT_PRICES });
    await store.tryReserve({ ...scope, capMicros: CAP_MICROS });
    const adapter = new ScriptedAdapter({
      count: 100,
      usage: { inputTokens: 1000, outputTokens: 10 },
    });

    const turn = await spend.runMeteredWithin(adapter, request(200), {
      reservation: scope,
      remainingMicros: 1000,
      timeoutMs: 3000,
    });

    // The bound is 100 + 200, but the reported 1000 input tokens cost 1010, charged in full.
    expect(turn.chargedMicros).toBe(1010);
    expect(turn.remainingMicros).toBe(0);
    expect(store.row('lisbon', '2026-11-04').reserved).toBe(0);
    expect(await suspension.isSuspended()).toBe(true);
  });

  it('passes the caller signal to the count and to the classification', async () => {
    const { spend, store } = harness({ prices: UNIT_PRICES });
    await store.tryReserve({ ...scope, capMicros: CAP_MICROS });
    const adapter = new ScriptedAdapter({
      count: 100,
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    const controller = new AbortController();

    await spend.runMeteredWithin(adapter, request(10), {
      reservation: scope,
      remainingMicros: 1000,
      timeoutMs: 3000,
      signal: controller.signal,
    });

    // The turn's count and its classification share the caller's abort as well as its deadline.
    expect(adapter.countSignals).toEqual([controller.signal]);
    expect(adapter.sendSignals).toEqual([controller.signal]);
  });

  it('refuses a turn while suspended, before counting anything', async () => {
    const suspension = new MemorySuspensionStore();
    await suspension.suspend('llm_count_mismatch', new Date('2026-11-04T12:00:00.000Z'));
    const { spend } = harness({ suspension });
    const adapter = new ScriptedAdapter({ count: 10 });

    await expect(
      spend.runMeteredWithin(adapter, request(10), {
        reservation: scope,
        remainingMicros: 100,
        timeoutMs: 3000,
      }),
    ).rejects.toThrow(LlmSuspendedError);
    expect(adapter.counted).toHaveLength(0);
    expect(adapter.sent).toHaveLength(0);
  });
});

describe('reservation bookkeeping', () => {
  it('settles against reported usage, releasing what was not used', async () => {
    const { spend, store } = harness({ prices: UNIT_PRICES });
    const reservation = await grantedReservation(spend, 'lisbon', 1000);

    const charged = await spend.settleLlm(reservation, { inputTokens: 100, outputTokens: 50 });

    expect(charged).toBe(150);
    expect(store.row('lisbon', '2026-11-04').spent).toBe(150);
    expect(store.row('lisbon', '2026-11-04').reserved).toBe(0);
  });

  it.each([
    ['no usage', null],
    ['an unpriceable usage', { inputTokens: -1, outputTokens: 2 }],
  ])('charges the whole reservation for %s', async (_name, usage) => {
    const { spend, store } = harness();
    const reservation = await grantedReservation(spend, 'lisbon', 700);

    const charged = await spend.settleLlm(reservation, usage);

    expect(charged).toBe(700);
    expect(store.row('lisbon', '2026-11-04').spent).toBe(700);
    expect(store.row('lisbon', '2026-11-04').reserved).toBe(0);
  });

  it('releases unused reservation, in full by default, and never a negative amount', async () => {
    const { spend, store } = harness();
    const reservation = await grantedReservation(spend, 'lisbon', 900);

    await spend.releaseLlm(reservation, 400);
    expect(store.row('lisbon', '2026-11-04').reserved).toBe(500);

    await spend.releaseLlm(reservation, 0);
    expect(store.row('lisbon', '2026-11-04').reserved).toBe(500);

    await spend.releaseLlm(reservation);
    expect(store.row('lisbon', '2026-11-04').reserved).toBe(0);

    await expect(spend.releaseLlm(reservation, -1)).rejects.toThrow(RangeError);
  });

  it('counts a request without reserving or sending it', async () => {
    const { spend, store } = harness();
    const adapter = new ScriptedAdapter({ count: 1000 });

    const bound = await spend.countBound(adapter, request(100), { timeoutMs: 3000 });

    expect(bound).toEqual({
      countedInputTokens: 1000,
      boundMicros: boundMicros(1000, 100, PRICES),
    });
    expect(adapter.counted).toHaveLength(1);
    expect(adapter.sent).toHaveLength(0);
    expect(store.rows.size).toBe(0);
  });

  it('multiplies a turn bound into the dialogue budget a call is dialed with', async () => {
    const { spend, store } = harness();

    // `call-dispatch` reserves this before dialing and stores it in `CallAttempt.llmReservedMicros`.
    const budget = spend.dialogueBudgetMicros(150, 60);
    expect(budget).toBe(9000);

    const reservation = await grantedReservation(spend, 'lisbon', budget);
    expect(reservation.micros).toBe(9000);

    await spend.releaseLlm(reservation);
    expect(store.row('lisbon', '2026-11-04').reserved).toBe(0);

    expect(() => spend.dialogueBudgetMicros(-1, 60)).toThrow(RangeError);
    expect(() => spend.dialogueBudgetMicros(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
  });
});

/** The key the adapter is handed; a suite injects the client, so nothing reaches a provider. */
const STUB_API_KEY = 'stub-openai-key';

/** One of the adapter's own models (AAP 0.5.6), so the adapter builds rather than refusing. */
const STUB_MODEL = 'gpt-4.1-mini';

/** What the stub provider answers with, and what it fails with. */
interface ProviderScript {
  /** The count endpoint's answer — `{ input_tokens: n }` — or any value that is not one. */
  count?: unknown;
  countThrows?: Error;
  /** The response body `create` answers, or any value that is not a response body. */
  response?: unknown;
  responseThrows?: Error;
}

/**
 * The OpenAI client as a stub (`OpenAiResponsesClient`): it answers what a test scripts and records
 * the deadline each call carried, so the provider boundary is exercised with no network.
 */
class StubOpenAiClient implements OpenAiResponsesClient {
  readonly countBodies: unknown[] = [];
  readonly countDeadlines: (number | undefined)[] = [];
  readonly sendBodies: unknown[] = [];
  readonly sendDeadlines: (number | undefined)[] = [];
  /** The call options each send carried, so a case can read the retry bound the profile sets. */
  readonly sendOptions: (OpenAiCallOptions | undefined)[] = [];
  private readonly script: ProviderScript;

  constructor(script: ProviderScript) {
    this.script = script;
  }

  readonly responses: OpenAiResponsesClient['responses'] = {
    create: (body, options) => {
      const failure = this.script.responseThrows;
      this.sendBodies.push(body);
      this.sendDeadlines.push(options?.timeout);
      this.sendOptions.push(options);
      return failure === undefined
        ? Promise.resolve(this.script.response as OpenAiResponseSummary)
        : Promise.reject(failure);
    },
    inputTokens: {
      count: (body, options) => {
        const failure = this.script.countThrows;
        this.countBodies.push(body);
        this.countDeadlines.push(options?.timeout);
        return failure === undefined
          ? Promise.resolve(this.script.count as { input_tokens: number })
          : Promise.reject(failure);
      },
    },
  };
}

/** A recorded request body as a record, so a case can compare the keys two calls carried. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('expected the stub client to have recorded a request body');
  }
  return value as Record<string, unknown>;
}

/** The stub client and the real adapter built over it, as one fixture. */
function provider(script: ProviderScript): { client: StubOpenAiClient; adapter: LlmAdapter } {
  const client = new StubOpenAiClient(script);
  return {
    client,
    adapter: createOpenAiAdapter({ apiKey: STUB_API_KEY, model: STUB_MODEL, client }),
  };
}

/**
 * The provider boundary's own contract (AAP 0.5.6): every failure `createOpenAiAdapter` can raise,
 * over a stub client, and the same answers as the meter sees them — the layer where a bare
 * `TypeError` would be rewrapped and a usage read as a figure it cannot trust would charge a
 * mismatch and suspend every city instead of charging the reservation.
 */
describe('createOpenAiAdapter', () => {
  it('passes each call its own deadline, under the extraction ceiling the client defaults to', async () => {
    const { client, adapter } = provider({
      count: { input_tokens: 12 },
      response: { output_text: '{}' },
    });

    await adapter.countInputTokens(request(), { timeoutMs: 1000 });
    await adapter.complete(request(), { timeoutMs: 1000 });

    // AAP 0.11.1: 3 s in a call and 60 s in extraction. The client's own deadline stands at that
    // ceiling, and every call here passes its own, which overrides it.
    expect(OPENAI_DEFAULT_TIMEOUT_MS).toBe(60_000);
    expect(client.countDeadlines).toEqual([1000]);
    expect(client.sendDeadlines).toEqual([1000]);
  });

  it('counts and sends one payload, differing in nothing but the two generation keys', async () => {
    const { client, adapter } = provider({
      count: { input_tokens: 42 },
      response: { output_text: '{"items":[]}', usage: { input_tokens: 42, output_tokens: 7 } },
    });
    const request: LlmRequest = {
      system: 'Extract menu items.',
      messages: [{ role: 'user', content: 'ข้าวผัดกะเพราหมูสับ ไข่ดาว ฿60' }],
      jsonSchema: { name: 'menu_items', schema: { type: 'object', properties: {} } },
      maxTokens: 500,
    };

    expect(await adapter.countInputTokens(request, { timeoutMs: 1000 })).toBe(42);
    const result = await adapter.complete(request, { timeoutMs: 1000 });

    const counted = asRecord(client.countBodies[0]);
    const sent = asRecord(client.sendBodies[0]);
    // AAP 0.5.6: every key the count endpoint saw is sent unchanged. A difference here is what
    // `spend.ts` reads as a count mismatch and suspends every city for.
    for (const key of Object.keys(counted)) {
      expect(sent[key]).toStrictEqual(counted[key]);
    }
    expect(counted).toStrictEqual({
      model: STUB_MODEL,
      instructions: request.system,
      input: [{ role: 'user', content: 'ข้าวผัดกะเพราหมูสับ ไข่ดาว ฿60' }],
      text: {
        format: {
          type: 'json_schema',
          name: 'menu_items',
          schema: { type: 'object', properties: {} },
          strict: true,
        },
      },
    });
    expect(
      Object.keys(sent)
        .filter((key) => !(key in counted))
        .sort(),
    ).toEqual(['max_output_tokens', 'store']);
    expect(sent['max_output_tokens']).toBe(request.maxTokens);
    expect(sent['store']).toBe(false);
    expect(sent['tools']).toBeUndefined();
    // The reported input count equals the count reserved for, which is what keeps the request off
    // the mismatch path.
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    // One reservation covers exactly one sent request (AAP 0.5.6): no automatic retry is left on.
    expect(client.sendOptions[0]).toMatchObject({ maxRetries: 0 });
  });

  it('builds its own client, retries off, when no client is injected', () => {
    ctor.mockClear();

    const adapter = createOpenAiAdapter({ apiKey: STUB_API_KEY, model: SUPPORTED_MODELS[0] });

    expect(adapter.provider).toBe('openai');
    expect(ctor).toHaveBeenCalledTimes(1);
    // The deadline is the ceiling AAP 0.11.1 sets, so a call that forgot its own cannot inherit the
    // SDK's ten-minute default.
    expect(ctor.mock.calls[0]?.[0]).toMatchObject({
      apiKey: STUB_API_KEY,
      maxRetries: 0,
      timeout: OPENAI_DEFAULT_TIMEOUT_MS,
    });
  });

  it('refuses a model outside SUPPORTED_MODELS before it builds a client', () => {
    ctor.mockClear();

    expect(() => createOpenAiAdapter({ apiKey: STUB_API_KEY, model: 'gpt-unknown-0' })).toThrow(
      RangeError,
    );
    expect(() => createOpenAiAdapter({ apiKey: STUB_API_KEY, model: 'gpt-unknown-0' })).toThrow(
      'unsupported_llm_model',
    );
    expect(ctor).not.toHaveBeenCalled();
  });

  it.each([
    ['a null answer', null],
    ['an undefined answer', undefined],
    ['an answer without the field', {}],
    ['a string count', { input_tokens: '12' }],
    ['a fractional count', { input_tokens: 1.5 }],
    ['a negative count', { input_tokens: -1 }],
  ])('rejects %s as an invalid count and sends nothing', async (_name, answer) => {
    const { client, adapter } = provider({ count: answer });

    const error = await rejection(adapter.countInputTokens(request(), { timeoutMs: 1000 }));

    expect(error).toBeInstanceOf(LlmCountError);
    expect((error as LlmCountError).reason).toBe('invalid_count');
    expect(error).not.toBeInstanceOf(TypeError);
    expect(client.sendBodies).toHaveLength(0);
  });

  it('classifies an unexpected count failure as the provider and an abort as a timeout', async () => {
    const transport = provider({ countThrows: new Error('socket hung up') });
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const aborting = provider({ countThrows: aborted });

    const failed = await rejection(
      transport.adapter.countInputTokens(request(), { timeoutMs: 1000 }),
    );
    const abortedCount = await rejection(
      aborting.adapter.countInputTokens(request(), { timeoutMs: 1000 }),
    );

    expect((failed as LlmCountError).reason).toBe('provider');
    expect((abortedCount as LlmCountError).reason).toBe('timeout');
    expect((abortedCount as LlmCountError).cause).toBe(aborted);
  });

  it('returns a valid count as it stands', async () => {
    const { adapter } = provider({ count: { input_tokens: 12 } });

    expect(await adapter.countInputTokens(request(), { timeoutMs: 1000 })).toBe(12);
  });

  it.each([
    ['a null body', null],
    ['an undefined body', undefined],
    ['a body that is not an object', 'not-a-response'],
  ])('reports %s as a provider error, never a TypeError', async (_name, body) => {
    const { adapter } = provider({ count: { input_tokens: 10 }, response: body });

    const error = await rejection(adapter.complete(request(), { timeoutMs: 1000 }));

    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as LlmProviderError).status).toBeNull();
  });

  it('charges the whole reservation and logs nothing when the reply carried no body', async () => {
    const { spend, store, suspension, entries } = harness();
    const { adapter } = provider({ count: { input_tokens: 10 }, response: null });
    const bound = boundMicros(10, 100, PRICES);

    const error = await rejection(
      spend.runMetered(adapter, request(), { cityId: 'lisbon', timeoutMs: 60_000 }),
    );

    expect((error as LlmProviderError).chargedMicros).toBe(bound);
    expect(store.row('lisbon', '2026-11-04').spent).toBe(bound);
    expect(store.row('lisbon', '2026-11-04').reserved).toBe(0);
    expect(entries).toHaveLength(0);
    expect(await suspension.isSuspended()).toBe(false);
  });

  it.each([
    ['no usage', null],
    ['a usage that is not an object', 'nonsense'],
    ['a usage whose fields are not numbers', { input_tokens: 'x', output_tokens: 1 }],
  ])(
    'reports %s as no usage, charging the reservation without suspending',
    async (_name, usage) => {
      const { spend, store, suspension, entries } = harness();
      const { adapter } = provider({
        count: { input_tokens: 10 },
        response: { output_text: '{}', usage },
      });
      const bound = boundMicros(10, 100, PRICES);

      const direct = await adapter.complete(request(), { timeoutMs: 1000 });
      const charge = await spend.runMetered(adapter, request(), {
        cityId: 'lisbon',
        timeoutMs: 60_000,
      });

      expect(direct.usage).toBeNull();
      expect(charge.chargedMicros).toBe(bound);
      expect(store.row('lisbon', '2026-11-04').spent).toBe(bound);
      expect(store.row('lisbon', '2026-11-04').reserved).toBe(0);
      expect(entries).toHaveLength(0);
      expect(await suspension.isSuspended()).toBe(false);
    },
  );

  it.each([
    ['round numbers', { input_tokens: 10, output_tokens: 4 }, { inputTokens: 10, outputTokens: 4 }],
    [
      'a fractional figure',
      { input_tokens: 1.5, output_tokens: 0 },
      { inputTokens: 1.5, outputTokens: 0 },
    ],
  ])('reports %s of usage as they stand', async (_name, usage, expected) => {
    const { adapter } = provider({
      count: { input_tokens: 10 },
      response: { output_text: '{}', usage },
    });

    // A figure that is not a whole count still travels: the meter is what classifies it.
    expect((await adapter.complete(request(), { timeoutMs: 1000 })).usage).toEqual(expected);
  });
});

/**
 * The module graph `src/llm/{adapter,openai,fake}.ts` forms at start-up: `adapter.ts` imports both
 * provider factories while each provider imports back `adapter.ts`'s error classes and
 * `assertLlmRequest`, so the cycle is safe only while no module reads an imported binding at its
 * own top level. Each case resets the registry and imports one module as the graph's entry point,
 * which is the order a process gets it in, and then uses that module's own exports; a top-level
 * read added later meets its import's temporal dead zone here instead of when the process starts.
 * The fresh registry hands back new class identities, so an assertion reads `provider`, `model` or
 * a code and never `instanceof` against the classes this file imported statically.
 */
describe('the llm module graph', () => {
  it('builds the adapter factory when adapter.ts is the entry point', async () => {
    vi.resetModules();

    const adapter = await import('../../src/llm/adapter.ts');
    const built = adapter.createLlmAdapter({ provider: 'fake' });

    expect(built.provider).toBe('fake');
    // `LlmError` is a class binding the providers import back, so it must be constructible here.
    expect(typeof adapter.LlmError).toBe('function');
    expect(new adapter.LlmError('llm_suspended', 'llm_suspended').code).toBe('llm_suspended');
  });

  it('builds the OpenAI adapter when openai.ts is the entry point', async () => {
    vi.resetModules();

    const openai = await import('../../src/llm/openai.ts');
    const built = openai.createOpenAiAdapter({
      apiKey: STUB_API_KEY,
      model: STUB_MODEL,
      client: new StubOpenAiClient({}),
    });

    expect(built.provider).toBe('openai');
    expect(built.model).toBe(STUB_MODEL);
    expect(openai.SUPPORTED_MODELS).toContain(STUB_MODEL);
  });

  it('builds the fake adapter when fake.ts is the entry point', async () => {
    vi.resetModules();

    const fake = await import('../../src/llm/fake.ts');
    const built = fake.createFakeLlmAdapter({});

    expect(built.provider).toBe('fake');
    expect(built.model).toBe('fake');
  });
});

/**
 * The cap's own boundary and the contract it rests on (AAP 0.5.6), over the fake provider: the one
 * adapter whose count and send are both local, and whose tokenizer counts Thai, Indonesian, emoji
 * and base64-like content the way a real one does. Every figure below is money against
 * `CAP_LLM_USD_PER_CITY_DAY`, so a rounding, reservation or counting mistake is a spend breach
 * rather than a wrong answer.
 */
describe('the fake provider under the city cap', () => {
  /** Prices that end the boundary loop in tens of requests: 150 and 600 USD per million tokens. */
  const BOUNDARY_PRICES: LlmPrices = { inputUsdPerMTok: '150', outputUsdPerMTok: '600' };
  /** The city and the local day the frozen clock reads: 2026-11-04T12:00:00Z in Lisbon. */
  const CITY = 'lisbon';
  const LOCAL_DATE = '2026-11-04';
  /** Menu content from the fixture languages, which no log line and no error may carry. */
  const THAI_TEXT = 'ข้าวผัดกะเพราหมูสับ ไข่ดาว ฿60\n';
  const INDONESIAN_TEXT = 'Nasi goreng spesial Rp 45.000\n';

  /** The item of `items` at `index` by rotation, or a test failure for an empty list. */
  function nth<T>(items: readonly T[], index: number): T {
    const item = items[index % items.length];
    if (item === undefined) {
      throw new RangeError('the list to rotate over is empty');
    }
    return item;
  }

  /** One request over `content`, with the schema or token bound a real caller would give it. */
  function req(
    content: string,
    options?: { maxTokens?: number; jsonSchema?: LlmRequest['jsonSchema'] },
  ): LlmRequest {
    const base: LlmRequest = {
      system: 'Extract menu items.',
      messages: [{ role: 'user', content }],
      maxTokens: options?.maxTokens ?? 500,
    };
    const jsonSchema = options?.jsonSchema;
    return jsonSchema === undefined ? base : { ...base, jsonSchema };
  }

  /** A structured-output schema of the size a menu extraction registers: two hundred properties. */
  function largeMenuSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 200 }, (_unused, index) => [
          `field_${index}`,
          { type: 'string', description: `the ${index}th field of one menu item` },
        ]),
      ),
      required: [],
      additionalProperties: false,
    };
  }

  /** The five shapes the boundary is measured with, each as large as real extraction content. */
  function boundaryRequests(): LlmRequest[] {
    return [
      req(THAI_TEXT.repeat(40), { maxTokens: 500 }),
      req(INDONESIAN_TEXT.repeat(60), { maxTokens: 500 }),
      req('🍜☕️🍺🥗'.repeat(200), { maxTokens: 500 }),
      req(randomBytes(3000).toString('base64'), { maxTokens: 500 }),
      req('Menu page text.', {
        maxTokens: 500,
        jsonSchema: { name: 'menu_items', schema: largeMenuSchema() },
      }),
    ];
  }

  /** The fake provider's count of one request: four UTF-8 bytes per token, rounded up. */
  function countOf(request: LlmRequest): number {
    return Math.ceil(Buffer.byteLength(serializeFakeInputPart(request), 'utf8') / 4);
  }

  interface Refusal {
    readonly error: LlmBudgetRefusedError;
    readonly request: LlmRequest;
    readonly countedBefore: number;
    readonly sentBefore: number;
    readonly spentBefore: number;
  }

  /**
   * Run the rotating requests until one does not fit the cap. Each round records what the provider
   * had been asked for before the call, so the refusal can be asserted on: the count grew by exactly
   * one, the send never happened, and the day's spent figure was already too high for the bound.
   */
  async function runToRefusal(
    spend: LlmSpend,
    store: MemorySpendStore,
    fake: FakeLlmAdapter,
  ): Promise<Refusal> {
    const requests = boundaryRequests();
    for (let round = 0; round < 200; round += 1) {
      const request = nth(requests, round);
      const countedBefore = fake.calls.counted.length;
      const sentBefore = fake.calls.sent.length;
      const spentBefore = store.row(CITY, LOCAL_DATE).spent;
      try {
        await spend.runMetered(fake, request, { cityId: CITY, timeoutMs: 1000 });
      } catch (error) {
        if (!(error instanceof LlmBudgetRefusedError)) {
          throw error;
        }
        return { error, request, countedBefore, sentBefore, spentBefore };
      }
    }
    throw new Error('the cap never refused a request');
  }

  it('never charges past 25 USD, and counts the refused request once without sending it', async () => {
    const { spend, store } = harness({ prices: BOUNDARY_PRICES });
    const fake = createFakeLlmAdapter({});

    const refusal = await runToRefusal(spend, store, fake);
    const row = store.row(CITY, LOCAL_DATE);

    // The refusal is the counted bound that no longer fits, and it names the city cap.
    expect(refusal.error.scope).toBe('city_cap');
    expect(refusal.error.boundMicros).toBe(
      boundMicros(countOf(refusal.request), refusal.request.maxTokens, BOUNDARY_PRICES),
    );
    expect(refusal.error.boundMicros + refusal.spentBefore).toBeGreaterThan(CAP_MICROS);
    // Counted once, sent never.
    expect(fake.calls.counted).toHaveLength(refusal.countedBefore + 1);
    expect(fake.calls.sent).toHaveLength(refusal.sentBefore);
    // And the counter itself never crossed the cap, at any point between a reservation and its
    // charge: `maxObserved` is the highest total the store ever held.
    expect(row.spent).toBeLessThanOrEqual(CAP_MICROS);
    expect(row.reserved).toBe(0);
    expect(store.maxObserved).toBeLessThanOrEqual(CAP_MICROS);
  });

  it('reopens the city headroom on its next local day, not on the wall clock alone', async () => {
    const { spend, store, clock } = harness({ prices: BOUNDARY_PRICES });
    await runToRefusal(spend, store, createFakeLlmAdapter({}));

    // The 25 USD of the day just spent are not spendable again before the day ends.
    expect(await spend.reserveLlm(CITY, CAP_MICROS)).toBeNull();

    clock.advance(24 * 3_600_000);

    // 2026-11-05T12:00Z in Lisbon is 2026-11-05, a fresh key with its own full cap.
    expect(await spend.reserveLlm(CITY, CAP_MICROS)).toEqual({
      cityId: CITY,
      localDate: '2026-11-05',
      micros: CAP_MICROS,
    });
  });

  it.each([
    ['Thai', THAI_TEXT.repeat(40)],
    ['Indonesian', INDONESIAN_TEXT.repeat(60)],
    ['emoji', '🍜☕️🍺🥗'.repeat(200)],
    ['a base64-like string', randomBytes(3000).toString('base64')],
  ])('counts and sends the identical payload for %s content', async (_name, content) => {
    const { spend, store } = harness({ prices: FAKE_LLM_PRICES });
    const fake = createFakeLlmAdapter({});
    const request = req(content, { maxTokens: 500 });

    const charge = await spend.runMetered(fake, request, { cityId: CITY, timeoutMs: 1000 });

    const part = serializeFakeInputPart(request);
    // AAP 0.5.6: the payload the count endpoint is given is byte-identical to the one sent.
    expect(fake.calls.counted).toEqual([part]);
    expect(fake.calls.sent).toEqual([part]);
    // And the reservation was the provider's own count plus `maxTokens`, charged at what the
    // provider reported — the count it reserved for, and one output token.
    const counted = countOf(request);
    expect(charge.countedInputTokens).toBe(counted);
    expect(charge.chargedMicros).toBe(costMicros(counted, 1, FAKE_LLM_PRICES));
    expect(store.row(CITY, LOCAL_DATE).spent).toBe(charge.chargedMicros);
    expect(store.row(CITY, LOCAL_DATE).reserved).toBe(0);
  });

  it('sends nothing at all when the provider cannot count the payload', async () => {
    const { spend, store, entries } = harness({ prices: FAKE_LLM_PRICES });
    const fake = createFakeLlmAdapter({ failCount: true });

    const error = await rejection(
      spend.runMetered(fake, req(THAI_TEXT), { cityId: CITY, timeoutMs: 1000 }),
    );

    expect(error).toBeInstanceOf(LlmCountError);
    expect(fake.calls.counted).toHaveLength(1);
    expect(fake.calls.sent).toHaveLength(0);
    expect(store.rows.size).toBe(0);
    expect(JSON.stringify(entries)).not.toContain(THAI_TEXT);
  });

  it('charges the full bound, logs counts only and suspends every city on a reported mismatch', async () => {
    const { spend, store, suspension, entries } = harness({ prices: FAKE_LLM_PRICES });
    const fake = createFakeLlmAdapter({ reportedInputDelta: 1 });
    const request = req(THAI_TEXT, { maxTokens: 500 });
    const counted = countOf(request);

    const charge = await spend.runMetered(fake, request, { cityId: CITY, timeoutMs: 1000 });

    // The reported cost is below the bound, so the whole reservation is charged (AAP 0.5.6).
    expect(charge.chargedMicros).toBe(boundMicros(counted, request.maxTokens, FAKE_LLM_PRICES));
    expect(store.row(CITY, LOCAL_DATE).spent).toBe(charge.chargedMicros);
    expect(store.row(CITY, LOCAL_DATE).reserved).toBe(0);

    const warns = entries.filter((entry) => entry.fields['event'] === 'llm_count_mismatch');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields).toMatchObject({
      provider: 'fake',
      model: 'fake',
      counted,
      reportedInput: counted + 1,
      maxTokens: request.maxTokens,
    });
    expect(JSON.stringify(entries)).not.toContain(THAI_TEXT);
    expect(await suspension.mismatchCount()).toBe(1);

    // Suspension is global: no other city may reserve or count anything until it is cleared.
    expect(await spend.reserveLlm('canggu', 1)).toBeNull();
    const otherCity = createFakeLlmAdapter({});
    const suspended = await rejection(
      spend.runMetered(otherCity, request, { cityId: 'canggu', timeoutMs: 1000 }),
    );
    expect(suspended).toBeInstanceOf(LlmSuspendedError);
    expect(otherCity.calls.counted).toHaveLength(0);
    expect(otherCity.calls.sent).toHaveLength(0);

    await suspension.clear();

    await expect(
      spend.runMetered(otherCity, request, { cityId: 'canggu', timeoutMs: 1000 }),
    ).resolves.toBeDefined();
    expect(otherCity.calls.sent).toHaveLength(1);
  });

  it('spends one voice turn inside the dialogue budget the call already holds', async () => {
    const { spend, store } = harness({ prices: FAKE_LLM_PRICES });
    const fake = createFakeLlmAdapter({});
    // The classification template with a 2,000-byte conversation window, the turn `call-dispatch`
    // reserves the largest of (AAP 0.5.6), with the provider's minimum output bound.
    const turn = req('callee: '.concat('x'.repeat(2000)), { maxTokens: 16 });
    const counted = countOf(turn);
    const turnBound = boundMicros(counted, turn.maxTokens, FAKE_LLM_PRICES);
    const budget = spend.dialogueBudgetMicros(turnBound, 3);

    const reservation = await spend.reserveLlm('chiang-mai', budget);
    if (reservation === null) {
      throw new Error('expected the dialogue budget to be reserved');
    }
    const row = () => store.row('chiang-mai', LOCAL_DATE);
    expect(row()).toEqual({ spent: 0, reserved: budget });

    // A turn whose bound does not fit what is left of the call is not sent.
    const refused = await rejection(
      spend.runMeteredWithin(fake, turn, {
        reservation,
        remainingMicros: turnBound - 1,
        timeoutMs: 3000,
      }),
    );
    expect(refused).toBeInstanceOf(LlmBudgetRefusedError);
    expect((refused as LlmBudgetRefusedError).scope).toBe('reservation');
    expect(fake.calls.sent).toHaveLength(0);
    expect(row()).toEqual({ spent: 0, reserved: budget });

    // One that fits moves exactly its own cost from reserved to spent.
    const charge = await spend.runMeteredWithin(fake, turn, {
      reservation,
      remainingMicros: turnBound,
      timeoutMs: 3000,
    });
    const actual = costMicros(counted, 1, FAKE_LLM_PRICES);
    expect(charge.chargedMicros).toBe(actual);
    expect(charge.remainingMicros).toBe(turnBound - actual);
    expect(row()).toEqual({ spent: actual, reserved: budget - actual });
  });

  it.each([
    ['canggu', '2026-11-05'],
    ['chiang-mai', '2026-11-05'],
    ['lisbon', '2026-11-04'],
    ['mexico-city', '2026-11-04'],
    ['medellin', '2026-11-04'],
  ])('books %s against its own local day at 17:30Z', async (cityId, localDate) => {
    const clock = createTestClock();
    clock.set(new Date('2026-11-04T17:30:00.000Z'));
    const { spend } = harness({ clock });

    // Makassar and Bangkok are already on the 5th, Lisbon, Mexico City and Bogotá are still on the
    // 4th: the counter is keyed by the city's own day, never by UTC.
    expect(await spend.reserveLlm(cityId, 1)).toEqual({ cityId, localDate, micros: 1 });
  });
});

/**
 * The startup refusal that protects the spend profile (AAP 0.5.6): a reservation bounds the spend
 * only while `LLM_MODEL` is a model the count endpoint and the price list were checked against, so
 * a process configured with anything else must not start. The full mode matrix belongs to
 * `apps/api/test/unit/env-guard.test.ts`; the model guard is asserted here because this suite is the
 * one that depends on the count-then-send profile holding.
 */
describe('the LLM_MODEL guard', () => {
  /** The credential used here: not a key shape any provider issues, so it may stand in source. */
  const LLM_KEY = 'test-llm-key';
  /** 32 random bytes, the only form `FIELD_ENCRYPTION_KEY` accepts. */
  const FIELD_KEY = randomBytes(32).toString('base64');
  const SALTS = 'a'.repeat(40);
  const SHARED = {
    APP_ENV: 'test',
    DATABASE_URL: 'postgres://tablemate@localhost:5432/tablemate',
    REDIS_URL: 'redis://localhost:6379',
    FIELD_ENCRYPTION_KEY: FIELD_KEY,
    FIELD_ENCRYPTION_KEY_ID: 'k1',
    ANALYTICS_SALT: SALTS,
    TELEPHONY_MODE: 'off',
    LLM_PROVIDER: 'openai',
    LLM_API_KEY: LLM_KEY,
    LLM_PRICE_INPUT_USD_PER_MTOK: '0.40',
    LLM_PRICE_OUTPUT_USD_PER_MTOK: '1.60',
  };

  /** A complete raw environment for one process, from the scope tables of AAP 0.6.2. */
  function rawEnvFor(process: 'api' | 'workers'): Record<string, string> {
    const shared = {
      ...SHARED,
      API_PUBLIC_URL: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:8080',
    };
    if (process === 'workers') {
      return {
        ...shared,
        SMTP_URL: 'smtp://localhost:1025',
        EMAIL_FROM: 'noreply@tablemate.test',
        CRAWLER_CONTACT_URL: 'https://tablemate.test/bot',
      };
    }
    return {
      ...shared,
      VENUE_CONSOLE_ORIGIN: 'http://localhost:8090',
      ARTIFACTS_BASE_URL: 'http://localhost:8070',
      JWT_SECRET: SALTS,
      EMAIL_LOOKUP_PEPPER: SALTS,
      EXPERIMENT_SALT: SALTS,
      NULLIFIER_SALT: '12345',
      TERMS_VERSION: '2026-11-04',
      STRIPE_MODE: 'mock',
      STRIPE_API_BASE: 'http://localhost:12100',
    };
  }

  /** The error a synchronous call threw, for asserting on its fields. */
  function thrownBy(call: () => unknown): unknown {
    try {
      call();
    } catch (error: unknown) {
      return error;
    }
    throw new Error('expected the call to throw');
  }

  it.each([
    ['api', loadApiEnv],
    ['workers', loadWorkersEnv],
  ] as const)('%s accepts a supported model and refuses any other', (_process, load) => {
    const raw = rawEnvFor(_process);

    expect(load({ ...raw, LLM_MODEL: SUPPORTED_MODELS[0] }).llm).toMatchObject({
      provider: 'openai',
      model: SUPPORTED_MODELS[0],
      prices: { inputUsdPerMTok: '0.40', outputUsdPerMTok: '1.60' },
    });

    const error = thrownBy(() => load({ ...raw, LLM_MODEL: 'gpt-unknown-0' }));

    expect(error).toBeInstanceOf(EnvValidationError);
    const issues = (error as EnvValidationError).issues;
    expect(issues.some((issue) => issue.variable === 'LLM_MODEL')).toBe(true);
    // A refusal names variables and reasons, never a value of one (AAP 0.12.2).
    expect(String((error as Error).message)).not.toContain(LLM_KEY);
    expect(JSON.stringify(issues)).not.toContain(LLM_KEY);
  });
});
