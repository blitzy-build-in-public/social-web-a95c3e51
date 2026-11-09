import type { Clock } from '../clock.ts';
import type { Logger } from '../logger.ts';
import { localDateKey } from '../time/city-time.ts';
import {
  LlmBudgetRefusedError,
  LlmCountError,
  LlmProviderError,
  LlmSuspendedError,
  LlmTimeoutError,
} from './contract.ts';
import type { LlmAdapter, LlmCallOptions, LlmRequest, LlmResult, LlmUsage } from './contract.ts';

/** The prices one token is charged at, in USD per million tokens (AAP 0.5.6). */
export interface LlmPrices {
  /** `LLM_PRICE_INPUT_USD_PER_MTOK`, exactly as the environment holds it. */
  inputUsdPerMTok: string;
  /** `LLM_PRICE_OUTPUT_USD_PER_MTOK`, exactly as the environment holds it. */
  outputUsdPerMTok: string;
}

const USD_PER_MTOK_RE = /^(0|[1-9]\d*)(\.\d{1,6})?$/;

const PRICE_SCALE = 1_000_000n;

/**
 * A price scaled by {@link PRICE_SCALE}, or `RangeError('invalid_llm_price')` for anything else.
 */
export function parseUsdPerMTok(value: string): bigint {
  if (!USD_PER_MTOK_RE.test(value)) {
    throw new RangeError('invalid_llm_price');
  }
  const [wholeText = '', fractionText = ''] = value.split('.');
  const fraction = fractionText === '' ? 0n : BigInt(fractionText.padEnd(6, '0'));
  const scaled = BigInt(wholeText) * PRICE_SCALE + fraction;
  if (scaled <= 0n) {
    // A zero price would make every reservation free and defeat the cap.
    throw new RangeError('invalid_llm_price');
  }
  return scaled;
}

const parsedPrices = new Map<string, bigint>();

function scaledPrice(value: string): bigint {
  const cached = parsedPrices.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = parseUsdPerMTok(value);
  parsedPrices.set(value, parsed);
  return parsed;
}

/**
 * The cost of a request in micro-dollars, rounded up (AAP 0.5.6): one ceiling over `input ×
 * inputPrice + output × outputPrice`, computed exactly in `BigInt`.
 */
export function costMicros(inputTokens: number, outputTokens: number, prices: LlmPrices): number {
  assertCount(inputTokens, 'inputTokens');
  assertCount(outputTokens, 'outputTokens');
  const exact =
    BigInt(inputTokens) * scaledPrice(prices.inputUsdPerMTok) +
    BigInt(outputTokens) * scaledPrice(prices.outputUsdPerMTok);
  return microsOf((exact + PRICE_SCALE - 1n) / PRICE_SCALE);
}

/**
 * The reservation bound of a request in micro-dollars: its counted input tokens at the input price
 * plus `maxTokens` at the output price, rounded up (AAP 0.5.6).
 */
export function boundMicros(
  countedInputTokens: number,
  maxTokens: number,
  prices: LlmPrices,
): number {
  return costMicros(countedInputTokens, maxTokens, prices);
}

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, received ${value}`);
  }
}

function microsOf(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('llm_cost_out_of_range');
  }
  return Number(value);
}

function assertMicros(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, received ${value}`);
  }
}

/** One reservation as plain data (AAP 0.5.6). */
export interface LlmReservation {
  /** The city whose local day the reservation was made against. */
  readonly cityId: string;
  /** The city-local `YYYY-MM-DD` it belongs to; a later day is a separate counter. */
  readonly localDate: string;
  /** The micro-dollars held reserved for this request. */
  readonly micros: number;
}

/** The counter the cap is kept in (AAP 0.5.6). */
export interface SpendStore {
  /**
   * Add `micros` to the day's reserved total, but only while `spent + reserved + micros <=
   * capMicros` still holds; `false` when the request does not fit.
   */
  tryReserve(args: {
    cityId: string;
    localDate: string;
    micros: number;
    capMicros: number;
  }): Promise<boolean>;
  /**
   * Settle `chargedMicros`: add it to the day's spent total and remove `min(chargedMicros,
   * reservation.micros)` from the reserved total, so a remainder stays reserved.
   */
  charge(reservation: LlmReservation, chargedMicros: number): Promise<void>;
  /** Remove `micros` from the day's reserved total, never below zero. */
  release(reservation: LlmReservation, micros: number): Promise<void>;
}

/** A tagged-template SQL executor: `(strings, ...values) => rows`. */
export type SpendSqlExecutor = <T = unknown>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

interface BudgetRow {
  city_id: string;
}

/**
 * The Postgres-backed counter (AAP 0.5.6), over the `call_budget_day` row of the city and local
 * day.
 */
export function createSqlSpendStore(sql: SpendSqlExecutor): SpendStore {
  const ensureRow = async (cityId: string, localDate: string): Promise<void> => {
    await sql<BudgetRow[]>`
      INSERT INTO call_budget_day (city_id, local_date)
      VALUES (${cityId}, CAST(${localDate} AS date))
      ON CONFLICT (city_id, local_date) DO NOTHING
      RETURNING city_id`;
  };
  return {
    async tryReserve(args: {
      cityId: string;
      localDate: string;
      micros: number;
      capMicros: number;
    }) {
      assertMicros(args.micros, 'micros');
      assertMicros(args.capMicros, 'capMicros');
      await ensureRow(args.cityId, args.localDate);
      const rows = await sql<BudgetRow[]>`
        UPDATE call_budget_day
           SET llm_reserved_micros = llm_reserved_micros + CAST(${args.micros} AS bigint)
         WHERE city_id = ${args.cityId}
           AND local_date = CAST(${args.localDate} AS date)
           AND llm_spend_micros + llm_reserved_micros + CAST(${args.micros} AS bigint)
               <= CAST(${args.capMicros} AS bigint)
        RETURNING city_id`;
      return rows.length > 0;
    },
    async charge(reservation: LlmReservation, chargedMicros: number) {
      assertMicros(chargedMicros, 'chargedMicros');
      await sql<BudgetRow[]>`
        UPDATE call_budget_day
           SET llm_spend_micros = llm_spend_micros + CAST(${chargedMicros} AS bigint),
               llm_reserved_micros = GREATEST(
                 llm_reserved_micros
                   - LEAST(CAST(${chargedMicros} AS bigint), CAST(${reservation.micros} AS bigint)),
                 0
               )
         WHERE city_id = ${reservation.cityId}
           AND local_date = CAST(${reservation.localDate} AS date)
        RETURNING city_id`;
    },
    async release(reservation: LlmReservation, micros: number) {
      assertMicros(micros, 'micros');
      if (micros === 0) {
        return;
      }
      await sql<BudgetRow[]>`
        UPDATE call_budget_day
           SET llm_reserved_micros = GREATEST(llm_reserved_micros - CAST(${micros} AS bigint), 0)
         WHERE city_id = ${reservation.cityId}
           AND local_date = CAST(${reservation.localDate} AS date)
        RETURNING city_id`;
    },
  };
}

/** Why use was suspended: the only reason AAP 0.5.6 names. */
export type LlmSuspensionReason = 'llm_count_mismatch';

/**
 * The global suspension flag (AAP 0.5.6): a count mismatch suspends use in every city until an
 * operator re-enables it.
 */
export interface SuspensionStore {
  /**
   * Whether use is currently suspended anywhere. A store that cannot read the flag rejects instead
   * of answering, and {@link createLlmSpend} fails closed on that.
   */
  isSuspended(): Promise<boolean>;
  /** Suspend every city for `reason` as of `since`, counting the event for the dashboard. */
  suspend(reason: LlmSuspensionReason, since: Date): Promise<void>;
  /** The operator re-enable step. */
  clear(): Promise<void>;
  /** How many mismatches have been recorded, for `MetricsDto.calls.llmCountMismatches`. */
  mismatchCount(): Promise<number>;
}

/** The commands {@link createRedisSuspensionStore} needs. */
export interface SuspensionRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  incr(key: string): Promise<number>;
  del(key: string): Promise<number>;
}

/** The suspension flag's key: set means suspended, absent means running. */
export const LLM_SUSPENDED_KEY = 'llm:suspended';

/** The cumulative mismatch counter's key, read by the operator dashboard. */
export const LLM_COUNT_MISMATCHES_KEY = 'llm:count_mismatches';

/** The Redis-backed suspension flag (AAP 0.5.6), shared by every process through one key. */
export function createRedisSuspensionStore(redis: SuspensionRedis): SuspensionStore {
  return {
    async isSuspended() {
      return (await redis.get(LLM_SUSPENDED_KEY)) !== null;
    },
    async suspend(reason: LlmSuspensionReason, since: Date) {
      const value = JSON.stringify({ since: since.toISOString(), reason });
      await redis.set(LLM_SUSPENDED_KEY, value);
      await redis.incr(LLM_COUNT_MISMATCHES_KEY);
    },
    async clear() {
      await redis.del(LLM_SUSPENDED_KEY);
    },
    async mismatchCount() {
      const raw = await redis.get(LLM_COUNT_MISMATCHES_KEY);
      if (raw === null) {
        return 0;
      }
      const parsed = Number.parseInt(raw, 10);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
    },
  };
}

/** What {@link createLlmSpend} needs (AAP 0.5.6). */
export interface CreateLlmSpendDeps {
  /** The per-city-local-day counter. */
  store: SpendStore;
  /** The global suspension flag. */
  suspension: SuspensionStore;
  /** The injected clock (AAP 0.11.1); time is never read any other way. */
  clock: Clock;
  /** `CAP_LLM_USD_PER_CITY_DAY` in micro-dollars: the default 25 USD is 25,000,000. */
  capMicros: number;
  /** The two prices a request is charged at. */
  prices: LlmPrices;
  /** The IANA zone of a city, from `config/cities.json`. */
  timezoneFor: (cityId: string) => string;
  /** Records mismatch, suspension and charge failures: counts, ids and codes only (AAP 0.11.1). */
  logger: Pick<Logger, 'warn' | 'error'>;
}

/** What a metered request cost (AAP 0.5.6). */
export interface LlmCallCharge {
  /** The provider's reply. */
  readonly result: LlmResult;
  /** The micro-dollars charged for it, settled against the reservation. */
  readonly chargedMicros: number;
  /** The count reserved for; `docs/menu-extraction.md` records it as the profile's evidence. */
  readonly countedInputTokens: number;
}

/** What one voice turn cost and what the call's dialogue budget holds afterwards (AAP 0.5.6). */
export interface LlmTurnCharge extends LlmCallCharge {
  /** The remaining budget; the relay keeps `CallAttempt.llmReservedMicros` at it. */
  readonly remainingMicros: number;
}

/** What a caller gives one request metered against its city's cap (AAP 0.5.6). */
export interface MeteredCallOptions {
  /** The city whose cap the request is metered against. */
  cityId: string;
  /** The deadline shared by its count and its send: 60 s for menu extraction. */
  timeoutMs: number;
  /** Aborts the count and the send. */
  signal?: AbortSignal;
}

/** What a caller gives one turn metered inside a reservation the call already holds (AAP 0.5.6). */
export interface MeteredWithinOptions {
  /** The reservation already held, whose city and local day the charge is booked against. */
  reservation: LlmReservation;
  /** What is left of it. */
  remainingMicros: number;
  /** The deadline shared by its count and its classification: 3 s for a turn. */
  timeoutMs: number;
  /** Aborts the count and the classification. */
  signal?: AbortSignal;
}

/**
 * The spend meter its callers use (AAP 0.5.1, AAP 0.5.6): the relay and `call-dispatch` work
 * through reservations, while `menu-ingest` and the menu evaluation call {@link
 * LlmSpend.runMetered}.
 */
export interface LlmSpend {
  /**
   * Reserve `micros` against `cityId`'s budget for its current local day; `null` when use is
   * suspended or the request does not fit `capMicros`.
   */
  reserveLlm(cityId: string, micros: number): Promise<LlmReservation | null>;
  /** Settle a reservation against reported usage, or charge it in full for `null` usage. */
  settleLlm(reservation: LlmReservation, usage: LlmUsage | null): Promise<number>;
  /** Release `micros` of unused reservation, defaulting to all of it: a dialogue budget at end. */
  releaseLlm(reservation: LlmReservation, micros?: number): Promise<void>;
  /**
   * The counted bound of a request without reserving or sending it; the count endpoint is free, and
   * the classification template is owned by the voice agent.
   */
  countBound(
    adapter: LlmAdapter,
    request: LlmRequest,
    options: { timeoutMs: number },
  ): Promise<{ countedInputTokens: number; boundMicros: number }>;
  /** `LLM_MAX_TURNS_PER_CALL` turns of dialogue budget, reserved before a call is dialed. */
  dialogueBudgetMicros(turnBoundMicros: number, maxTurns: number): number;
  /** Count, reserve, send and reconcile one request against the city's day (menu extraction). */
  runMetered(
    adapter: LlmAdapter,
    request: LlmRequest,
    options: MeteredCallOptions,
  ): Promise<LlmCallCharge>;
  /** Count, send and reconcile one voice turn inside the reservation the call already holds. */
  runMeteredWithin(
    adapter: LlmAdapter,
    request: LlmRequest,
    options: MeteredWithinOptions,
  ): Promise<LlmTurnCharge>;
}

/** Build the spend meter over the injected stores (AAP 0.5.6). */
export function createLlmSpend(deps: CreateLlmSpendDeps): LlmSpend {
  const { store, suspension, clock, timezoneFor, logger, prices } = deps;
  const capMicros = deps.capMicros;
  if (!Number.isSafeInteger(capMicros) || capMicros <= 0) {
    throw new RangeError(`capMicros must be a positive safe integer, received ${capMicros}`);
  }
  parseUsdPerMTok(prices.inputUsdPerMTok);
  parseUsdPerMTok(prices.outputUsdPerMTok);
  /** The call options for a send, with `signal` omitted rather than set to `undefined`. */
  const callOptions = (timeoutMs: number, signal: AbortSignal | undefined): LlmCallOptions =>
    signal === undefined ? { timeoutMs } : { timeoutMs, signal };
  /**
   * What is left of `timeoutMs` since `startedMs`, never below 1 ms: the count and the send of one
   * request share one deadline (AAP 0.5.6).
   */
  const elapsed = (startedMs: number, timeoutMs: number): number =>
    Math.max(1, timeoutMs - (clock.nowMs() - startedMs));
  /** Whether every city is suspended; an unreadable flag reads as suspended (fail closed). */
  const suspended = async (): Promise<boolean> => {
    try {
      return await suspension.isSuspended();
    } catch (error) {
      logger.error({ event: 'llm_suspension_store_unavailable', code: errorCode(error) });
      return true;
    }
  };
  /**
   * The provider's authoritative count for `request`. A count failure means the request is not sent
   * and nothing is reserved for it (AAP 0.5.6), so every failure becomes an `LlmCountError`.
   */
  const count = async (
    adapter: LlmAdapter,
    request: LlmRequest,
    options: { timeoutMs: number; signal?: AbortSignal | undefined },
  ): Promise<number> => {
    let value: number;
    try {
      value = await adapter.countInputTokens(
        request,
        callOptions(options.timeoutMs, options.signal),
      );
    } catch (error) {
      if (error instanceof LlmCountError) {
        throw error;
      }
      throw new LlmCountError('provider', { cause: error });
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new LlmCountError('invalid_count');
    }
    return value;
  };
  /**
   * What to charge for a completed request, and whether the count profile held (AAP 0.5.6): no
   * reported usage charges the whole bound, and a reported input count other than the reserved one
   * is a mismatch.
   */
  const reconcile = (
    counted: number,
    request: LlmRequest,
    result: LlmResult,
  ): { chargedMicros: number; mismatch: boolean } => {
    const bound = boundMicros(counted, request.maxTokens, prices);
    const usage = result.usage;
    if (usage === null) {
      return { chargedMicros: bound, mismatch: false };
    }
    const priceable = representable(usage);
    const reported = priceable ? costMicros(usage.inputTokens, usage.outputTokens, prices) : bound;
    if (!priceable || usage.inputTokens !== counted || usage.outputTokens > request.maxTokens) {
      return { chargedMicros: Math.max(bound, reported), mismatch: true };
    }
    return { chargedMicros: reported, mismatch: false };
  };
  /**
   * Record a mismatch: one warning carrying counts and the provider identity and nothing of the
   * request, then the suspension that stops every city until an operator re-enables it (AAP 0.5.6).
   */
  const onMismatch = async (
    adapter: LlmAdapter,
    counted: number,
    usage: LlmUsage | null,
    request: LlmRequest,
  ): Promise<void> => {
    logger.warn(
      {
        event: 'llm_count_mismatch',
        provider: adapter.provider,
        model: adapter.model,
        counted,
        reportedInput: usage?.inputTokens ?? null,
        reportedOutput: usage?.outputTokens ?? null,
        maxTokens: request.maxTokens,
      },
      'llm_count_mismatch',
    );
    try {
      await suspension.suspend('llm_count_mismatch', clock.now());
    } catch (error) {
      logger.error({ event: 'llm_suspension_failed', code: errorCode(error) });
    }
  };
  const reserveLlm = async (cityId: string, micros: number): Promise<LlmReservation | null> => {
    assertMicros(micros, 'micros');
    if (await suspended()) {
      return null;
    }
    const localDate = localDateKey(timezoneFor(cityId), clock.now());
    const granted = await store.tryReserve({ cityId, localDate, micros, capMicros });
    return granted ? { cityId, localDate, micros } : null;
  };
  const settleLlm = async (
    reservation: LlmReservation,
    usage: LlmUsage | null,
  ): Promise<number> => {
    const charged =
      usage !== null && representable(usage)
        ? costMicros(usage.inputTokens, usage.outputTokens, prices)
        : reservation.micros;
    await store.charge(reservation, charged);
    const unused = reservation.micros - charged;
    if (unused > 0) {
      await store.release(reservation, unused);
    }
    return charged;
  };
  const releaseLlm = async (
    reservation: LlmReservation,
    micros: number = reservation.micros,
  ): Promise<void> => {
    assertMicros(micros, 'micros');
    if (micros === 0) {
      return;
    }
    await store.release(reservation, micros);
  };
  const countBound = async (
    adapter: LlmAdapter,
    request: LlmRequest,
    options: { timeoutMs: number },
  ): Promise<{ countedInputTokens: number; boundMicros: number }> => {
    const countedInputTokens = await count(adapter, request, { timeoutMs: options.timeoutMs });
    return {
      countedInputTokens,
      boundMicros: boundMicros(countedInputTokens, request.maxTokens, prices),
    };
  };
  const dialogueBudgetMicros = (turnBoundMicros: number, maxTurns: number): number => {
    assertMicros(turnBoundMicros, 'turnBoundMicros');
    assertMicros(maxTurns, 'maxTurns');
    const budget = turnBoundMicros * maxTurns;
    if (!Number.isSafeInteger(budget)) {
      throw new RangeError('dialogue budget is not a safe integer');
    }
    return budget;
  };
  const runMetered = async (
    adapter: LlmAdapter,
    request: LlmRequest,
    options: MeteredCallOptions,
  ): Promise<LlmCallCharge> => {
    if (await suspended()) {
      throw new LlmSuspendedError();
    }
    const startedMs = clock.nowMs();
    const countedInputTokens = await count(adapter, request, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    const bound = boundMicros(countedInputTokens, request.maxTokens, prices);
    const reservation = await reserveLlm(options.cityId, bound);
    if (reservation === null) {
      /**
       * The request was counted once and is not sent; a refusal that turns out to be a suspension
       * reports the suspension, so the caller does not retry into a stopped meter.
       */
      if (await suspended()) {
        throw new LlmSuspendedError();
      }
      throw new LlmBudgetRefusedError({ boundMicros: bound, scope: 'city_cap' });
    }
    let result: LlmResult;
    try {
      result = await adapter.complete(
        request,
        callOptions(elapsed(startedMs, options.timeoutMs), options.signal),
      );
    } catch (error) {
      try {
        // Tokens may already have been billed, so the whole reservation is charged (AAP 0.5.6).
        await store.charge(reservation, reservation.micros);
      } catch (chargeError) {
        // The reservation then stays reserved: conservative, a held budget rather than a breach.
        logger.error({ event: 'llm_charge_failed', code: errorCode(chargeError) });
      }
      throw chargedFailure(error, reservation.micros);
    }
    const { chargedMicros, mismatch } = reconcile(countedInputTokens, request, result);
    await store.charge(reservation, chargedMicros);
    if (mismatch) {
      await onMismatch(adapter, countedInputTokens, result.usage, request);
    } else {
      const unused = bound - chargedMicros;
      if (unused > 0) {
        await store.release(reservation, unused);
      }
    }
    return { result, chargedMicros, countedInputTokens };
  };
  const runMeteredWithin = async (
    adapter: LlmAdapter,
    request: LlmRequest,
    options: MeteredWithinOptions,
  ): Promise<LlmTurnCharge> => {
    if (await suspended()) {
      throw new LlmSuspendedError();
    }
    assertMicros(options.remainingMicros, 'remainingMicros');
    /**
     * Nothing is reserved here: the call already holds its dialogue budget, and a turn only moves
     * part of it from reserved to spent (AAP 0.5.6).
     */
    const scope: LlmReservation = {
      cityId: options.reservation.cityId,
      localDate: options.reservation.localDate,
      micros: options.remainingMicros,
    };
    const startedMs = clock.nowMs();
    const countedInputTokens = await count(adapter, request, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    const bound = boundMicros(countedInputTokens, request.maxTokens, prices);
    if (bound > scope.micros) {
      // The turn is not sent: the relay speaks its closing line and the attempt needs review.
      throw new LlmBudgetRefusedError({
        boundMicros: bound,
        availableMicros: scope.micros,
        scope: 'reservation',
      });
    }
    let result: LlmResult;
    try {
      result = await adapter.complete(
        request,
        callOptions(elapsed(startedMs, options.timeoutMs), options.signal),
      );
    } catch (error) {
      try {
        await store.charge(scope, bound);
      } catch (chargeError) {
        logger.error({ event: 'llm_charge_failed', code: errorCode(chargeError) });
      }
      throw chargedFailure(error, bound);
    }
    const { chargedMicros, mismatch } = reconcile(countedInputTokens, request, result);
    await store.charge(scope, chargedMicros);
    if (mismatch) {
      await onMismatch(adapter, countedInputTokens, result.usage, request);
    }
    return {
      result,
      chargedMicros,
      countedInputTokens,
      remainingMicros: scope.micros - Math.min(chargedMicros, scope.micros),
    };
  };
  return {
    reserveLlm,
    settleLlm,
    releaseLlm,
    countBound,
    dialogueBudgetMicros,
    runMetered,
    runMeteredWithin,
  };
}

function representable(usage: LlmUsage): boolean {
  return (
    Number.isSafeInteger(usage.inputTokens) &&
    usage.inputTokens >= 0 &&
    Number.isSafeInteger(usage.outputTokens) &&
    usage.outputTokens >= 0
  );
}

function errorCode(error: unknown): string {
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'unknown';
}

function chargedFailure(error: unknown, micros: number): Error {
  if (error instanceof LlmTimeoutError || error instanceof LlmProviderError) {
    error.chargedMicros = micros;
    return error;
  }
  const wrapped = new LlmProviderError({ cause: error });
  wrapped.chargedMicros = micros;
  return wrapped;
}
