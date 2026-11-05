/**
 * The spend cap's unit suite (AAP 0.5.6): the pure cost arithmetic, the memory stores that apply the
 * same predicates as the SQL ones, the fail-closed suspension flag, and every path through
 * `runMetered` and `runMeteredWithin`.
 *
 * The adapters here are scripted rather than the fake provider, so a count and a reported usage are
 * exact and every assertion is arithmetic: the fake provider's byte-based tokenizer is exercised by
 * the integration suites, which need whole pipelines.
 */

import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';

import { createTestClock } from '../../src/clock.ts';
import type { TestClock } from '../../src/clock.ts';
import type { Logger } from '../../src/logger.ts';
import {
  LlmBudgetRefusedError,
  LlmCountError,
  LlmProviderError,
  LlmSuspendedError,
  LlmTimeoutError,
} from '../../src/llm/adapter.ts';
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
import type {
  LlmPrices,
  LlmReservation,
  LlmSpend,
  SpendSqlExecutor,
  SpendStore,
  SuspensionRedis,
  SuspensionStore,
} from '../../src/llm/spend.ts';

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

/** The zones the harness knows, so `timezoneFor` throws for anything else. */
const TIMEZONES: Record<string, string> = {
  lisbon: 'Europe/Lisbon',
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
  sqlIssued = 0;

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

  async tryReserve(args: {
    cityId: string;
    localDate: string;
    micros: number;
    capMicros: number;
  }): Promise<boolean> {
    const row = this.row(args.cityId, args.localDate);
    // Read and write in one synchronous step: the predicate is re-checked against the current row,
    // exactly as PostgreSQL re-evaluates its own `WHERE` under the row lock.
    if (row.spent + row.reserved + args.micros > args.capMicros) {
      return false;
    }
    row.reserved += args.micros;
    return true;
  }

  async charge(reservation: LlmReservation, chargedMicros: number): Promise<void> {
    const row = this.row(reservation.cityId, reservation.localDate);
    row.spent += chargedMicros;
    row.reserved = Math.max(0, row.reserved - Math.min(chargedMicros, reservation.micros));
  }

  async release(reservation: LlmReservation, micros: number): Promise<void> {
    const row = this.row(reservation.cityId, reservation.localDate);
    row.reserved = Math.max(0, row.reserved - micros);
  }
}

/** The suspension flag in memory, failing closed the way the Redis one does. */
class MemorySuspensionStore implements SuspensionStore {
  private suspended = false;
  private mismatches = 0;
  throwOnRead = false;

  async isSuspended(): Promise<boolean> {
    if (this.throwOnRead) {
      throw new Error('redis is down');
    }
    return this.suspended;
  }

  async suspend(_reason: 'llm_count_mismatch', _since: Date): Promise<void> {
    this.suspended = true;
    this.mismatches += 1;
  }

  async clear(): Promise<void> {
    this.suspended = false;
  }

  async mismatchCount(): Promise<number> {
    return this.mismatches;
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
  readonly sent: LlmRequest[] = [];
  readonly sendTimeouts: number[] = [];
  private readonly script: AdapterScript;

  constructor(script: AdapterScript) {
    this.script = script;
  }

  async countInputTokens(request: LlmRequest): Promise<number> {
    this.counted.push(request);
    this.script.onCount?.();
    if (this.script.countThrows !== undefined) {
      throw this.script.countThrows;
    }
    return this.script.count;
  }

  async complete(request: LlmRequest, options: LlmCallOptions): Promise<LlmResult> {
    this.sent.push(request);
    this.sendTimeouts.push(options.timeoutMs);
    if (this.script.sendThrows !== undefined) {
      throw this.script.sendThrows;
    }
    return { text: '', json: null, usage: this.script.usage ?? null };
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

  it.each(['0', '0.000000', '1.0000000', '-1', '1.', '.5', '1e3', ' 1', '01', ''])(
    'rejects %s',
    (value) => {
      expect(() => parseUsdPerMTok(value)).toThrow(RangeError);
      expect(() => parseUsdPerMTok(value)).toThrow('invalid_llm_price');
    },
  );
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

  it('fails closed when the flag cannot be read, and reads a corrupt counter as zero', async () => {
    const fake = fakeRedis();
    const store = createRedisSuspensionStore(fake.redis);
    fake.values.set(LLM_COUNT_MISMATCHES_KEY, 'not-a-number');
    expect(await store.mismatchCount()).toBe(0);

    fake.failReads = true;
    expect(await store.isSuspended()).toBe(true);
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
