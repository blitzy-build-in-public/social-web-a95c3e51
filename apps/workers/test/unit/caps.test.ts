/**
 * The per-city call cap and the shared language-model spend cap, proved in-process (AAP 0.5.6):
 * "`apps/workers/test/unit/caps.test.ts` covers concurrent reservations at the boundary,
 * reconciliation, timeout charging and the refused menu request."
 *
 * The call half runs `reserveCall` over an in-memory `call_budget_day` whose two statements are the
 * ones `src/calls/caps.ts` issues, with the same predicate in the `UPDATE`: 41 reservations racing
 * for the last of a 40-call day claim exactly 40 slots, which is criterion 17's rule held at its
 */

import { describe, expect, it } from 'vitest';

import {
  CLASSIFICATION_MAX_OUTPUT_TOKENS,
  CLASSIFICATION_TURN_TIMEOUT_MS,
  CLASSIFICATION_WINDOW_MAX_BYTES,
  DIALOGUE_BUDGET_WINDOW,
  EXPECTED_ANSWERS,
  buildClassificationRequest,
  capDeferral,
  dialogueBudgetMicros,
  releaseCall,
  reserveCall,
} from '../../src/calls/caps.ts';
import {
  EXTRACTION_TIMEOUT_MS,
  buildExtractionRequest,
  chunkText,
  extractMenuItems,
} from '../../src/menus/extract-items.ts';
import {
  FAKE_LLM_PRICES,
  LlmBudgetRefusedError,
  boundMicros,
  costMicros,
  createFakeLlmAdapter,
  createLlmSpend,
  createTestClock,
  localTimeOn,
  nextLocalDayAt,
} from '@tablemate/server-core';
import type {
  FakeLlmOptions,
  LlmAdapter,
  LlmReservation,
  LlmSpend,
  LlmSuspensionReason,
  Logger,
  SpendStore,
  SuspensionStore,
} from '@tablemate/server-core';
import type { RawSqlClient } from '@tablemate/db';

const CITY = 'lisbon';
const LOCAL_DATE = '2026-11-10';
const NEXT_LOCAL_DATE = '2026-11-11';

const CALL_CAP = 40;

const CAP_MICROS = 25_000_000;

/** `LLM_MAX_TURNS_PER_CALL` (AAP 0.5.6): the turns one call's dialogue budget is reserved for. */
const MAX_TURNS = 60;

const DEFERRED_HOUR = '09:00';
const MENU_DEFERRAL_HOUR = '00:05';

/** Every zone of `config/cities.json`, so the deferral is checked on each launch city. */
const ZONES = [
  'Europe/Lisbon',
  'America/Mexico_City',
  'America/Bogota',
  'Asia/Bangkok',
  'Asia/Makassar',
] as const;

const ZONE_BY_CITY: Record<string, string> = { lisbon: 'Europe/Lisbon', canggu: 'Asia/Makassar' };

const MENU_TEXT = 'Bitoque 12,50 €\nFrango 9,90 €';
const MENU_ITEM = {
  name: 'Bitoque',
  category: 'main',
  priceText: '12,50 €',
  currency: 'EUR',
  alcoholic: null,
  perPerson: null,
  ticketType: null,
} as const;

const MENU_REQUEST = buildExtractionRequest(chunkText(MENU_TEXT)[0] ?? '', 'EUR');

// ---------------------------------------------------------------------------------------------
// The in-memory call_budget_day
// ---------------------------------------------------------------------------------------------

/** One `call_budget_day` row: the only column {@link reserveCall} and {@link releaseCall} touch. */
interface BudgetRow {
  calls: number;
}

interface SqlResult {
  rows: BudgetRow[];
  touched: number;
}

/**
 * The minimal raw-SQL executor those two statements run against (AAP 0.11.2): rows in a `Map` keyed
 * by city and local date, and each statement recognised by the SQL text the module writes.
 */
function createSqlFake(): {
  rows: Map<string, BudgetRow>;
  statements: string[];
  sql: RawSqlClient;
} {
  const rows = new Map<string, BudgetRow>();
  const statements: string[] = [];

  const apply = (text: string, values: readonly unknown[]): SqlResult => {
    statements.push(text);
    const key = `${String(values[0])}|${String(values[1])}`;
    const row = rows.get(key);
    if (text.includes('ON CONFLICT')) {
      // `(city_id, local_date)` is the primary key, so the insert only ever creates the row.
      if (row === undefined) {
        rows.set(key, { calls: 0 });
        return { rows: [], touched: 1 };
      }
      return { rows: [], touched: 0 };
    }
    if (text.includes('GREATEST')) {
      if (row === undefined) {
        return { rows: [], touched: 0 };
      }
      row.calls = Math.max(row.calls - 1, 0);
      return { rows: [], touched: 1 };
    }
    if (text.includes('"calls" = "calls" + 1')) {
      const current = row ?? { calls: 0 };
      rows.set(key, current);
      // The predicate's own text decides whether the cap applies at all: a statement that lost its
      // `"calls" < cap` term updates unconditionally, as PostgreSQL would, and every one of the 41
      // racing reservations then claims a slot.
      if (text.includes('"calls" <') && current.calls >= Number(values[2])) {
        return { rows: [], touched: 0 };
      }
      current.calls += 1;
      return { rows: [current], touched: 1 };
    }
    throw new Error(`unrecognised statement: ${text}`);
  };

  const run = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlResult> => {
    await Promise.resolve();
    return apply(strings.join('?'), values);
  };

  return {
    rows,
    statements,
    sql: {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
        (await run(strings, ...values)).rows,
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
        (await run(strings, ...values)).touched,
    } as unknown as RawSqlClient,
  };
}

// ---------------------------------------------------------------------------------------------
// The language-model counter, its suspension flag and the logger
// ---------------------------------------------------------------------------------------------

/**
 * The `call_budget_day` language-model columns in memory, applying the predicates `spend.ts`'s SQL
 * applies (AAP 0.5.6): a reservation is granted only while `spent + reserved + micros <= capMicros`,
 * a charge moves what was really used out of the reservation, and reserved never drops below zero.
 */
class MemorySpendStore implements SpendStore {
  private readonly rows = new Map<string, { spent: number; reserved: number }>();

  /** The row of one city and local day, created empty on first use as the ensure-row insert does. */
  row(cityId: string, localDate: string): { spent: number; reserved: number } {
    const key = `${cityId}|${localDate}`;
    const existing = this.rows.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = { spent: 0, reserved: 0 };
    this.rows.set(key, created);
    return created;
  }

  tryReserve(args: {
    cityId: string;
    localDate: string;
    micros: number;
    capMicros: number;
  }): Promise<boolean> {
    const row = this.row(args.cityId, args.localDate);
    // Read and write in one synchronous step, as PostgreSQL re-checks the predicate under the row
    // lock it took to update.
    if (row.spent + row.reserved + args.micros > args.capMicros) {
      return Promise.resolve(false);
    }
    row.reserved += args.micros;
    return Promise.resolve(true);
  }

  charge(reservation: LlmReservation, chargedMicros: number): Promise<void> {
    const row = this.row(reservation.cityId, reservation.localDate);
    row.spent += chargedMicros;
    row.reserved = Math.max(0, row.reserved - Math.min(chargedMicros, reservation.micros));
    return Promise.resolve();
  }

  release(reservation: LlmReservation, micros: number): Promise<void> {
    const row = this.row(reservation.cityId, reservation.localDate);
    row.reserved = Math.max(0, row.reserved - micros);
    return Promise.resolve();
  }
}

/** The suspension flag in memory: never set here, so the meter's fail-closed path is not under test. */
class MemorySuspensionStore implements SuspensionStore {
  private suspended = false;
  private mismatches = 0;

  isSuspended(): Promise<boolean> {
    return Promise.resolve(this.suspended);
  }

  suspend(_reason: LlmSuspensionReason, _since: Date): Promise<void> {
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

/** One line a captured logger kept: the level and the fields object, which is all pino receives here. */
interface LogLine {
  level: 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
}

/** A logger that keeps every line, so a case can assert what was written — and what was not. */
function createCaptureLogger(): {
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  lines: LogLine[];
} {
  const lines: LogLine[] = [];
  const push = (level: LogLine['level'], args: unknown[]): void => {
    const first = args[0];
    lines.push({
      level,
      fields: typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : {},
    });
  };

  return {
    lines,
    logger: {
      info: (...args: unknown[]): void => push('info', args),
      warn: (...args: unknown[]): void => push('warn', args),
      error: (...args: unknown[]): void => push('error', args),
    },
  };
}

interface Harness {
  store: MemorySpendStore;
  spend: LlmSpend;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  lines: LogLine[];
}

/** The meter over fresh memory stores, a frozen clock and the fake provider's own prices. */
function createHarness(): Harness {
  const store = new MemorySpendStore();
  const { logger, lines } = createCaptureLogger();
  const clock = createTestClock({
    start: localTimeOn('Europe/Lisbon', LOCAL_DATE, '10:00'),
    mode: 'frozen',
  });

  return {
    store,
    logger,
    lines,
    spend: createLlmSpend({
      store,
      suspension: new MemorySuspensionStore(),
      clock,
      capMicros: CAP_MICROS,
      prices: FAKE_LLM_PRICES,
      timezoneFor: (cityId: string): string => {
        const zone = ZONE_BY_CITY[cityId];
        if (zone === undefined) {
          throw new RangeError(`unknown city: ${cityId}`);
        }
        return zone;
      },
      logger,
    }),
  };
}

/** The extraction dependencies with the city and currency fixed, so a case varies only its adapter. */
function extractionDeps(
  llm: LlmAdapter,
  spend: LlmSpend,
  logger: Pick<Logger, 'info' | 'warn'>,
): Parameters<typeof extractMenuItems>[1] {
  return { llm, spend, cityId: CITY, currency: 'EUR', logger };
}

/**
 * The figures one extraction chunk is measured against, taken from a probe adapter that sends
 * nothing: the provider's count for exactly {@link MENU_REQUEST}, the reservation bound that count
 * produces, and the charge the fake provider's reported usage — the count itself and one output
 * token — settles at.
 */
async function menuArithmetic(): Promise<{ counted: number; bound: number; charged: number }> {
  const probe = createFakeLlmAdapter();
  const counted = await probe.countInputTokens(MENU_REQUEST, {
    timeoutMs: EXTRACTION_TIMEOUT_MS,
  });
  return {
    counted,
    bound: boundMicros(counted, MENU_REQUEST.maxTokens, FAKE_LLM_PRICES),
    charged: costMicros(counted, 1, FAKE_LLM_PRICES),
  };
}

async function largestTurnBound(llm: LlmAdapter): Promise<number> {
  const bounds = await Promise.all(
    EXPECTED_ANSWERS.map(async (expected) => {
      const request = buildClassificationRequest(DIALOGUE_BUDGET_WINDOW, expected);
      const counted = await llm.countInputTokens(request, {
        timeoutMs: CLASSIFICATION_TURN_TIMEOUT_MS,
      });
      return boundMicros(counted, request.maxTokens, FAKE_LLM_PRICES);
    }),
  );
  return Math.max(...bounds);
}

// ---------------------------------------------------------------------------------------------
// The call cap (AAP 0.5.6, criterion 17)
// ---------------------------------------------------------------------------------------------

describe('reserveCall', () => {
  it('lets exactly the cap through when 41 reservations race for the last slot', async () => {
    const { statements, rows, sql } = createSqlFake();
    const claimed = await Promise.all(
      Array.from({ length: CALL_CAP + 1 }, () => reserveCall(sql, CITY, LOCAL_DATE, CALL_CAP)),
    );
    expect(claimed.filter((granted) => granted)).toHaveLength(CALL_CAP);
    expect(claimed.filter((granted) => !granted)).toHaveLength(1);
    expect(rows.get(`${CITY}|${LOCAL_DATE}`)?.calls).toBe(CALL_CAP);
    // The guarantee lives in the statement's own predicate, so the statement must carry it: without
    // `calls < cap` PostgreSQL updates unconditionally and the 41st reservation would be granted.
    const update = statements.find((text) => text.includes('"calls" = "calls" + 1'));
    expect(update).toContain('"calls" <');
    expect(update).toContain('RETURNING');
  });

  it('rejects a local date that is not YYYY-MM-DD and a cap that is not a non-negative integer', async () => {
    const { statements, sql } = createSqlFake();
    await expect(reserveCall(sql, CITY, '10/11/2026', CALL_CAP)).rejects.toThrow(RangeError);
    await expect(reserveCall(sql, CITY, LOCAL_DATE, 40.5)).rejects.toThrow(RangeError);
    await expect(releaseCall(sql, CITY, 'yesterday')).rejects.toThrow(RangeError);
    expect(statements).toEqual([]);
  });

  it.each([
    ['another city', 'canggu', LOCAL_DATE],
    ['another local day', CITY, NEXT_LOCAL_DATE],
  ])('%s counts against its own row', async (_label, cityId, localDate) => {
    const { rows, sql } = createSqlFake();
    await Promise.all(
      Array.from({ length: CALL_CAP }, () => reserveCall(sql, CITY, LOCAL_DATE, CALL_CAP)),
    );
    expect(await reserveCall(sql, cityId, localDate, CALL_CAP)).toBe(true);
    expect(rows.get(`${cityId}|${localDate}`)?.calls).toBe(1);
    expect(rows.get(`${CITY}|${LOCAL_DATE}`)?.calls).toBe(CALL_CAP);
  });
});

describe('releaseCall', () => {
  it('gives a slot back, and never pushes the day below zero', async () => {
    const { rows, sql } = createSqlFake();
    await Promise.all(
      Array.from({ length: CALL_CAP }, () => reserveCall(sql, CITY, LOCAL_DATE, CALL_CAP)),
    );
    await releaseCall(sql, CITY, LOCAL_DATE);
    expect(rows.get(`${CITY}|${LOCAL_DATE}`)?.calls).toBe(CALL_CAP - 1);
    expect(await reserveCall(sql, CITY, LOCAL_DATE, CALL_CAP)).toBe(true);
    expect(rows.get(`${CITY}|${LOCAL_DATE}`)?.calls).toBe(CALL_CAP);
    // A slot given back twice — a retried job, a definite rejection plus a late reconciliation —
    // must not push the day below zero and hand out slots it never had.
    const second = createSqlFake();
    await reserveCall(second.sql, CITY, LOCAL_DATE, CALL_CAP);
    await releaseCall(second.sql, CITY, LOCAL_DATE);
    await releaseCall(second.sql, CITY, LOCAL_DATE);
    expect(second.rows.get(`${CITY}|${LOCAL_DATE}`)?.calls).toBe(0);
  });
});

describe('capDeferral', () => {
  it.each(ZONES)('%s defers to 09:00 on the following local day', (tz) => {
    const next = localTimeOn(tz, NEXT_LOCAL_DATE, DEFERRED_HOUR).toISOString();
    const afternoon = localTimeOn(tz, LOCAL_DATE, '14:00');
    expect(capDeferral(tz, afternoon).toISOString()).toBe(
      nextLocalDayAt(tz, afternoon, DEFERRED_HOUR).toISOString(),
    );
    expect(capDeferral(tz, afternoon).toISOString()).toBe(next);
    // A late evening rolls forward too: today's 09:00 is already past, so it would defer nothing.
    expect(capDeferral(tz, localTimeOn(tz, LOCAL_DATE, '23:30')).toISOString()).toBe(next);
  });

  it('rejects an unknown zone', () => {
    expect(() =>
      capDeferral('Mars/Olympus', localTimeOn('Europe/Lisbon', LOCAL_DATE, '14:00')),
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// The language-model spend cap (AAP 0.5.6)
// ---------------------------------------------------------------------------------------------

type FailureCase = readonly [label: string, options: FakeLlmOptions, sent: boolean];

/**
 * The two ways a chunk loses itself alone: a send the provider failed (its tokens may already be
 * billed, so its reservation is charged) and a count that could never become a request (nothing was
 * reserved, so nothing is charged).
 */
const FAILURE_CASES: readonly FailureCase[] = [
  ['a send that failed', { failComplete: true }, true],
  ['a count that could not be established', { failCount: true }, false],
];

describe('extractMenuItems under the city cap', () => {
  it('charges the reported usage and releases the rest of the reservation', async () => {
    const { logger, store, spend } = createHarness();
    const { charged, bound } = await menuArithmetic();
    const llm = createFakeLlmAdapter({ respond: () => ({ items: [MENU_ITEM] }) });
    const result = await extractMenuItems(MENU_TEXT, extractionDeps(llm, spend, logger));
    expect(result.items).toEqual([MENU_ITEM]);
    expect(result.drops).toEqual({});
    // One count, one send: the count is the reservation's own evidence, never a second request.
    expect(llm.calls.counted).toHaveLength(1);
    expect(llm.calls.sent).toHaveLength(1);
    expect(llm.calls.sent[0]).toBe(llm.calls.counted[0]);
    const row = store.row(CITY, LOCAL_DATE);
    expect(row.spent).toBe(charged);
    expect(row.reserved).toBe(0);
    expect(row.spent).toBeLessThanOrEqual(bound);
    expect(row.spent).toBeLessThan(bound);
  });

  it.each(FAILURE_CASES)(
    '%s costs this chunk alone, charging the reservation only when one was taken',
    async (_label, options, sent) => {
      const { lines, logger, store, spend } = createHarness();
      const { bound } = await menuArithmetic();
      const llm = createFakeLlmAdapter(options);
      const result = await extractMenuItems(MENU_TEXT, extractionDeps(llm, spend, logger));
      // A failed chunk is dropped, not thrown: `menu-ingest` keeps the place and its remaining
      // chunks, and the phone fallback still applies (AAP 0.5.6).
      expect(result).toEqual({ items: [], drops: { llm_error: 1 } });
      expect(llm.calls.counted).toHaveLength(1);
      expect(llm.calls.sent).toHaveLength(sent ? 1 : 0);
      const row = store.row(CITY, LOCAL_DATE);
      // A send whose answer was lost may already have been billed, so its whole reservation is
      // charged; a count that failed never reached a reservation at all.
      expect(row.spent).toBe(sent ? bound : 0);
      expect(row.reserved).toBe(0);
      const failed = lines.find((line) => line.fields['event'] === 'menu_extract_chunk_failed');
      expect(failed).toMatchObject({
        level: 'warn',
        fields: {
          cityId: CITY,
          chunk: 1,
          code: sent ? 'llm_provider_error' : 'llm_count_failed',
        },
      });
      // Counts, ids and codes only: no byte of the menu, and no item name or price, reaches a line.
      expect(JSON.stringify(lines)).not.toContain('Bitoque');
      expect(JSON.stringify(lines)).not.toContain('12,50');
    },
  );

  it('refuses a chunk that does not fit the city day without ever sending it', async () => {
    const { logger, store, spend } = createHarness();
    const { bound } = await menuArithmetic();
    const row = store.row(CITY, LOCAL_DATE);
    row.spent = CAP_MICROS - (bound - 1);
    const llm = createFakeLlmAdapter({ respond: () => ({ items: [MENU_ITEM] }) });
    await expect(
      extractMenuItems(MENU_TEXT, extractionDeps(llm, spend, logger)),
    ).rejects.toBeInstanceOf(LlmBudgetRefusedError);
    expect(llm.calls.counted).toHaveLength(1);
    expect(llm.calls.sent).toHaveLength(0);
    expect(row.spent).toBe(CAP_MICROS - (bound - 1));
    expect(row.reserved).toBe(0);
  });

  it.each(['Europe/Lisbon', 'Asia/Makassar'])(
    'defers the refused job to 00:05 local the next day in %s',
    (tz) => {
      const now = localTimeOn(tz, LOCAL_DATE, '10:00');
      expect(nextLocalDayAt(tz, now, MENU_DEFERRAL_HOUR).toISOString()).toBe(
        localTimeOn(tz, NEXT_LOCAL_DATE, MENU_DEFERRAL_HOUR).toISOString(),
      );
    },
  );
});

describe('dialogueBudgetMicros', () => {
  it('reserves the largest counted turn over a full window for every turn of the call', async () => {
    const { store, spend } = createHarness();
    const llm = createFakeLlmAdapter();
    const perTurn = await largestTurnBound(llm);
    const budget = await dialogueBudgetMicros({
      llm,
      spend,
      prices: FAKE_LLM_PRICES,
      maxTurns: MAX_TURNS,
      timeoutMs: CLASSIFICATION_TURN_TIMEOUT_MS,
    });
    expect(budget).toBe(MAX_TURNS * perTurn);
    expect(budget).toBeGreaterThan(0);
    const half = await dialogueBudgetMicros({
      llm,
      spend,
      prices: FAKE_LLM_PRICES,
      maxTurns: MAX_TURNS / 2,
      timeoutMs: CLASSIFICATION_TURN_TIMEOUT_MS,
    });
    expect(half).toBe((MAX_TURNS / 2) * perTurn);
    // Counting a turn sends nothing and reserves nothing: the budget is a figure before it is a
    // reservation, which is why a call that cannot reserve it is simply never dialed.
    expect(store.row(CITY, LOCAL_DATE)).toEqual({ spent: 0, reserved: 0 });
    expect(llm.calls.sent).toHaveLength(0);
  });

  it('counts the bounded window once per expected answer', async () => {
    const llm = createFakeLlmAdapter();
    await largestTurnBound(llm);
    expect(EXPECTED_ANSWERS).toHaveLength(4);
    expect(llm.calls.counted).toHaveLength(EXPECTED_ANSWERS.length);
    expect(CLASSIFICATION_WINDOW_MAX_BYTES).toBe(2_000);
    expect(buildClassificationRequest(DIALOGUE_BUDGET_WINDOW, 'confirmation').maxTokens).toBe(
      CLASSIFICATION_MAX_OUTPUT_TOKENS,
    );
  });
});
