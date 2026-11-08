/**
 * The shared language-model spend cap (AAP 0.5.6).
 *
 * `api`'s voice relay and `workers`' menu extraction draw on one per-city counter, so every request
 * takes the same four steps: count the identical payload with `LlmAdapter.countInputTokens`, reserve
 * that worst case — the counted input tokens plus `maxTokens`, priced in micro-dollars and rounded
 * up — against `CAP_LLM_USD_PER_CITY_DAY` for the city's local day, send it, then charge what the
 * provider reported and release the remainder. A request whose count fails is never sent, and
 * neither is one that does not fit: `menu-ingest` defers its job to 00:05 local the next day, and a
 * voice turn that does not fit the call's remaining dialogue budget ends the call politely. An error
 * or timeout without reported usage charges the whole reservation, because the tokens may already
 * have been billed.
 *
 * A reported input count that differs from the count reserved for means the evidence that a
 * reservation bounds the spend no longer holds: the difference is charged in full,
 * `llm_count_mismatch` is logged with counts only, and use is suspended in every city until an
 * operator re-enables it ({@link SuspensionStore.clear}).
 *
 * Money arithmetic is integer throughout: a cost is one `BigInt` ceiling over the exact sum, exposed
 * as micro-dollars only once `Number.isSafeInteger` holds. Time comes only from the injected
 * `Clock`, so a test can move the local day. Nothing here reads `process.env`, and no log line
 * carries a prompt, a menu, a transcript, callee speech or model output (AAP 0.11.1, AAP 0.12.2).
 *
 * Stores are injected, so this package holds no database or Redis client: {@link createSqlSpendStore}
 * is the only SQL in it, as tagged templates over a caller's executor (AAP 0.11.2), and
 * {@link createRedisSuspensionStore} is the operator-visible flag. One call's remaining dialogue
 * budget lives in `call_attempt.llm_reserved_micros`, which the relay rebuilds into an
 * {@link LlmReservation} for {@link LlmSpend.runMeteredWithin}.
 *
 * Raw-SQL contract with `packages/db/prisma/schema.prisma` (model `CallBudgetDay`, table
 * `call_budget_day`, primary key `(city_id, local_date)`): `city_id` text, `local_date` date, `calls`
 * int default 0, `llm_spend_micros` bigint default 0, `llm_reserved_micros` bigint default 0. Those
 * names are load-bearing, and no further column may be added without a default, or the ensure-row
 * insert fails. `apps/workers/src/calls/caps.ts` reserves call slots on the same row.
 */

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

/** A price the meter accepts: a positive decimal of at most six places, no sign and no exponent. */
const USD_PER_MTOK_RE = /^(0|[1-9]\d*)(\.\d{1,6})?$/;

/**
 * The price scale, and the divisor of a cost: USD per million tokens equals micro-dollars per token,
 * so a price times this is the integer micro-cost of one counted token.
 */
const PRICE_SCALE = 1_000_000n;

/**
 * A price scaled by {@link PRICE_SCALE}, or `RangeError('invalid_llm_price')` for anything else.
 * `src/env/modes.ts` calls this at startup to validate both price variables (AAP 0.5.6), so a
 * malformed price fails the process rather than a request.
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

/** Parsed prices, so the hot path prices a request without repeating the parse (AAP 0.5.6). */
const parsedPrices = new Map<string, bigint>();

/** The scaled price of `value`, parsed once. Throws as {@link parseUsdPerMTok} does. */
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
 * The cost of a request in micro-dollars, rounded up (AAP 0.5.6): one ceiling over
 * `input × inputPrice + output × outputPrice`, computed exactly in `BigInt`. One token at `0.4`
 * costs one micro-dollar and a million tokens at `0.4` cost exactly 400,000.
 *
 * @throws RangeError when either count is not a non-negative safe integer, when a price is
 * malformed, or when the exact result exceeds `Number.MAX_SAFE_INTEGER`.
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
 * plus `maxTokens` at the output price, rounded up (AAP 0.5.6). It is an upper bound because the
 * actual output can only be smaller — `maxTokens` covers every generated token, reasoning tokens
 * included (AAP 0.2.3) — and the actual input equals the count, or the mismatch rule applies.
 */
export function boundMicros(
  countedInputTokens: number,
  maxTokens: number,
  prices: LlmPrices,
): number {
  return costMicros(countedInputTokens, maxTokens, prices);
}

/** A token figure the meter can price, or a `RangeError` naming the field. */
function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, received ${value}`);
  }
}

/** A micro-dollar amount the meter can expose as a `number`. */
function microsOf(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('llm_cost_out_of_range');
  }
  return Number(value);
}

/** A micro-dollar amount, validated before any store sees it or any SQL is issued. */
function assertMicros(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, received ${value}`);
  }
}

/**
 * One reservation as plain data (AAP 0.5.6). The API relay rebuilds one from
 * `CallAttempt.llmReservedMicros` and `localDateKey(cityTz, attempt.startedAt)` to spend the
 * dialogue budget a call already holds.
 */
export interface LlmReservation {
  /** The city whose local day the reservation was made against. */
  readonly cityId: string;
  /** The city-local `YYYY-MM-DD` it belongs to; a later day is a separate counter. */
  readonly localDate: string;
  /** The micro-dollars held reserved for this request. */
  readonly micros: number;
}

/**
 * The counter the cap is kept in (AAP 0.5.6). It is an interface because this package owns no
 * database client: `api` and `workers` inject {@link createSqlSpendStore} over their own connection,
 * and a suite injects a memory implementation of the same predicates.
 */
export interface SpendStore {
  /**
   * Add `micros` to the day's reserved total, but only while `spent + reserved + micros <= capMicros`
   * still holds.
   *
   * @returns `true` when the row was updated, `false` when the request does not fit the cap.
   */
  tryReserve(args: {
    cityId: string;
    localDate: string;
    micros: number;
    capMicros: number;
  }): Promise<boolean>;
  /**
   * Settle `chargedMicros`: add it to the day's spent total and remove `min(chargedMicros,
   * reservation.micros)` from the reserved total, so any remainder stays reserved. Reserved never
   * drops below zero.
   */
  charge(reservation: LlmReservation, chargedMicros: number): Promise<void>;
  /** Remove `micros` from the day's reserved total, never below zero. */
  release(reservation: LlmReservation, micros: number): Promise<void>;
}

/**
 * A tagged-template SQL executor: `(strings, ...values) => rows`. Every statement in this file goes
 * through it, so all SQL is parameterized and no database client is needed (AAP 0.11.2).
 *
 * @example
 * ```ts
 * const store = createSqlSpendStore(<T,>(strings: TemplateStringsArray, ...values: unknown[]) =>
 *   prisma.$queryRaw<T>(strings, ...values));
 * ```
 */
export type SpendSqlExecutor = <T = unknown>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

/** The one column a {@link SpendSqlExecutor} result is read for: whether a row was touched. */
interface BudgetRow {
  city_id: string;
}

/**
 * The Postgres-backed counter (AAP 0.5.6), over the `call_budget_day` row of the city and local day.
 *
 * The reserve statement carries its check in its own `WHERE`, which is what makes concurrent
 * reservations at the boundary safe: PostgreSQL re-evaluates the predicate under the row lock it
 * took to update, so of two requests racing for the last of the cap only one updates a row and the
 * other finds none and is refused. An ensure-row insert precedes it, because a day with no traffic
 * yet has no row for that update to find.
 *
 * @param sql - the caller's tagged-template executor, over its own pooled connection.
 * @returns a store whose counters are the database's, not this process's.
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
 * The global suspension flag (AAP 0.5.6: a mismatch suspends use in every city "until an operator
 * re-enables it"). The requirement names no store, so this interface draws the process boundary:
 * `api` and `workers` share the Redis key through {@link createRedisSuspensionStore}, and the
 * operator re-enable step is {@link SuspensionStore.clear}, documented in `docs/operations.md`.
 */
export interface SuspensionStore {
  /**
   * Whether use is currently suspended anywhere.
   *
   * A store that cannot read the flag rejects instead of answering. {@link createLlmSpend} is what
   * fails closed on that: it treats the unreadable flag as suspended and logs one
   * `llm_suspension_store_unavailable` line carrying a `code`, so an outage is never
   * indistinguishable from an operator suspension.
   */
  isSuspended(): Promise<boolean>;
  /** Suspend every city for `reason` as of `since`, counting the event for the dashboard. */
  suspend(reason: LlmSuspensionReason, since: Date): Promise<void>;
  /** The operator re-enable step. */
  clear(): Promise<void>;
  /** How many mismatches have been recorded, for `MetricsDto.calls.llmCountMismatches`. */
  mismatchCount(): Promise<number>;
}

/**
 * The commands {@link createRedisSuspensionStore} needs. A real ioredis `Redis` satisfies it —
 * `createRedisConnection(url, 'client')` from `../queues/connection.ts`, which fails fast rather
 * than queueing behind an outage — and a suite substitutes a small fake.
 */
export interface SuspensionRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  incr(key: string): Promise<number>;
  del(key: string): Promise<number>;
}

/** The suspension flag's key: set means suspended, absent means running. No TTL, it is a stop. */
export const LLM_SUSPENDED_KEY = 'llm:suspended';

/** The cumulative mismatch counter's key, read by the operator dashboard. */
export const LLM_COUNT_MISMATCHES_KEY = 'llm:count_mismatches';

/**
 * The Redis-backed suspension flag (AAP 0.5.6), shared by every process through one key.
 *
 * A read failure propagates: the store never converts an unreadable flag into an answer, so a Redis
 * outage cannot pass for an operator suspension. {@link createLlmSpend} is what fails closed on it —
 * it treats the unreadable flag as suspended, because sending a request whose reservation cannot be
 * checked may cross the city cap, while a request that is not sent only defers a job, and leaves one
 * `llm_suspension_store_unavailable` line naming the cause with a `code`. `suspend` writes the flag
 * before it counts the event, so a failure part-way through cannot lose the suspension.
 */
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

/**
 * What {@link createLlmSpend} needs (AAP 0.5.6). Stores and the clock are injected, so this file
 * keeps no client of its own. `timezoneFor` comes from city configuration and throws for an unknown
 * city, which propagates: a request for a city this deployment does not have has no budget to book
 * against.
 */
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
 * The spend meter its callers use (AAP 0.5.1, AAP 0.5.6): the relay and `call-dispatch` work through
 * reservations, while `menu-ingest` and the menu evaluation call {@link LlmSpend.runMetered}.
 */
export interface LlmSpend {
  /**
   * Reserve `micros` against `cityId`'s budget for its current local day.
   *
   * @returns the reservation, or `null` when use is suspended or the request does not fit
   * `capMicros`. A store failure throws, so a job retries rather than reading as a refusal.
   */
  reserveLlm(cityId: string, micros: number): Promise<LlmReservation | null>;
  /** Settle a reservation against reported usage, or charge it in full for `null` usage. */
  settleLlm(reservation: LlmReservation, usage: LlmUsage | null): Promise<number>;
  /** Release `micros` of unused reservation, defaulting to all of it: a dialogue budget at end. */
  releaseLlm(reservation: LlmReservation, micros?: number): Promise<void>;
  /**
   * The counted bound of a request without reserving or sending it; the count endpoint is free.
   *
   * The classification template is owned by the voice agent, and `apps/workers` cannot import
   * `apps/api`: the template whose bound `call-dispatch` needs must live where both processes can
   * reach it, which is not this file. It is placed in `apps/workers/src/calls/caps.ts`, whose
   * `buildClassificationRequest` builds it and whose `dialogueBudgetMicros` turns the largest
   * counted per-turn bound into a call's dialogue budget by multiplying it by
   * `LLM_MAX_TURNS_PER_CALL` (AAP 0.5.6). The relay's own copy of that template is in
   * `apps/api/src/modules/voice-agent/understanding.ts`.
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

/**
 * Build the spend meter over the injected stores (AAP 0.5.6).
 *
 * @param deps - the counter, the suspension flag, the clock, the cap, the prices, the city zone
 * lookup and the logger.
 * @returns an {@link LlmSpend} whose every request is counted before it is reserved and charged
 * against the reservation it held.
 * @throws RangeError when `capMicros` is not a positive safe integer or either price is malformed,
 * so a misconfigured process fails at startup rather than mid-request.
 */
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
   * request share one deadline (AAP 0.5.6), so a turn gets 3 s for both together.
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
   * and nothing is reserved for it (AAP 0.5.6), so every failure becomes an `LlmCountError`: the
   * vocabulary's own error passes through, anything else is wrapped with its cause, and a figure
   * that is not a count is an invalid count.
   *
   * The caller's deadline and its own `signal` carry over, so a relay connection that closed or a
   * cancelled job cancels the count too.
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
   * What to charge for a completed request, and whether the count profile held (AAP 0.5.6). No
   * reported usage charges the whole bound; a reported input count other than the reserved one, an
   * output past `maxTokens`, or a usage that cannot be priced as it stands each charge at least the
   * bound and count as a mismatch.
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
   * A suspension that cannot be written is logged, and the failed write leaves use running: only a
   * flag that is set stops traffic.
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
      // The request was counted once and is not sent. A refusal that turns out to be a suspension
      // reports the suspension, so the caller does not retry into a stopped meter.
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
    // Nothing is reserved here: the call already holds its dialogue budget, and a turn only moves
    // part of it from reserved to spent, so the city cap cannot be crossed mid-call.
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

/** Whether a reported usage can be priced as it stands: both figures non-negative safe integers. */
function representable(usage: LlmUsage): boolean {
  return (
    Number.isSafeInteger(usage.inputTokens) &&
    usage.inputTokens >= 0 &&
    Number.isSafeInteger(usage.outputTokens) &&
    usage.outputTokens >= 0
  );
}

/** A loggable code from a caught value — an `Error`'s `code`, or `'unknown'` (AAP 0.11.1). */
function errorCode(error: unknown): string {
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'unknown';
}

/**
 * The error to rethrow once a send has failed, carrying the micro-dollars that failure consumed
 * (AAP 0.5.6). The vocabulary's own timeout and provider errors keep their identity and gain
 * `chargedMicros`, which is how the relay learns what an errored turn cost; anything else becomes an
 * `LlmProviderError` with the original as its cause, never in its message.
 */
function chargedFailure(error: unknown, micros: number): Error {
  if (error instanceof LlmTimeoutError || error instanceof LlmProviderError) {
    error.chargedMicros = micros;
    return error;
  }
  const wrapped = new LlmProviderError({ cause: error });
  wrapped.chargedMicros = micros;
  return wrapped;
}
