/**
 * The per-city call caps and the dialogue budget a call is dialed with (AAP 0.5.6).
 *
 * A call slot lives on the `call_budget_day` row of a city and its local day. {@link reserveCall} is
 * the only writer of the row's `calls` column and keeps its check in the `UPDATE`'s own `WHERE`:
 * PostgreSQL re-evaluates the predicate under the row lock it took, so of two dispatches racing for
 * the last slot of a day exactly one updates a row — with `CAP_CALLS_PER_CITY_DAY` of 40, the 41st
 * task of that day therefore keeps its status and moves `nextAttemptAt` to 09:00 local the next day
 * instead of dialing (criterion 17 of AAP 0.12.1).
 *
 * {@link dialogueBudgetMicros} reserves a call's whole worst case before it dials — one classification
 * turn over a full conversation window, the largest bound multiplied by `LLM_MAX_TURNS_PER_CALL` and
 * stored in `CallAttempt.llmReservedMicros` — and the relay sends a turn only while that turn's counted
 * bound fits what is left of the reservation, so the city cap cannot be crossed mid-call.
 *
 * Both statements are single parameterized tagged templates over the caller's `RawSqlClient`
 * (AAP 0.11.2), and the slot commits or rolls back with the claim transaction passed in (AAP 0.3.2).
 * Time and local dates arrive as arguments, never from a clock read here (AAP 0.11.1), and every
 * city-local conversion goes through `@tablemate/server-core`'s `time/city-time.ts`. Nothing in this
 * module logs, and no prompt, window or utterance reaches a log line (AAP 0.12.2).
 */

import { CALLING_HOURS_START, utf8ByteLength } from '@tablemate/shared';
import { boundMicros, nextLocalDayAt } from '@tablemate/server-core';

import type {
  LlmAdapter,
  LlmJsonSchema,
  LlmPrices,
  LlmRequest,
  LlmSpend,
} from '@tablemate/server-core';
import type { RawSqlClient } from '@tablemate/db';

/** A city-local date as `call_budget_day.local_date` stores it (AAP 0.5.6). */
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The one column {@link reserveCall}'s conditional update is read for: a row comes back only for the
 * statement that actually claimed a slot, which makes the reservation a decision rather than a check
 * followed by a write.
 */
interface BudgetRow {
  city_id: string;
}

/**
 * Reserve one call slot for `cityId` on its `localDate` and report whether it was claimed
 * (AAP 0.5.6). The insert comes first because a local day with no traffic yet has no row for the
 * update to find — `(city_id, local_date)` is that table's primary key and the only columns without a
 * default — and the update's predicate is the atomic guarantee described above. False leaves the
 * caller to move `nextAttemptAt` through {@link capDeferral}.
 */
export async function reserveCall(
  sql: RawSqlClient,
  cityId: string,
  localDate: string,
  cap: number,
): Promise<boolean> {
  assertLocalDate(localDate);
  assertCap(cap);
  await sql.$executeRaw`
    INSERT INTO "call_budget_day" ("city_id", "local_date")
    VALUES (${cityId}, CAST(${localDate} AS date))
    ON CONFLICT DO NOTHING`;
  const rows = await sql.$queryRaw<BudgetRow[]>`
    UPDATE "call_budget_day"
       SET "calls" = "calls" + 1
     WHERE "city_id" = ${cityId}
       AND "local_date" = CAST(${localDate} AS date)
       AND "calls" < ${cap}
    RETURNING "city_id"`;
  return rows.length === 1;
}

/**
 * Give back the call slot its caller reserved (AAP 0.5.6).
 *
 * Only a definite rejection frees the slot — a connection refused before anything was sent, or a
 * Twilio 4xx (AAP 0.5.3). An ambiguous dispatch keeps it consumed, because a call may exist that the
 * listing cannot prove, so the day's count stays an upper bound on the calls that were placed
 * (AAP 0.3.2). `GREATEST("calls" - 1, 0)` keeps a double release from pushing the count below zero.
 */
export async function releaseCall(
  sql: RawSqlClient,
  cityId: string,
  localDate: string,
): Promise<void> {
  assertLocalDate(localDate);
  await sql.$executeRaw`
    UPDATE "call_budget_day"
       SET "calls" = GREATEST("calls" - 1, 0)
     WHERE "city_id" = ${cityId}
       AND "local_date" = CAST(${localDate} AS date)`;
}

/**
 * When a task over either cap may next be attempted (AAP 0.5.6): 09:00 in the business's city time on
 * the next local day. The hour is the opening of the calling window, so a task refused by the call cap
 * or by the language-model cap keeps its status and is eligible again the following morning rather
 * than being dropped or left behind the cap all day.
 */
export function capDeferral(tz: string, now: Date): Date {
  return nextLocalDayAt(tz, now, CALLING_HOURS_START);
}

/** A local date the two SQL statements above can cast, or a `RangeError` naming the value. */
function assertLocalDate(localDate: string): void {
  if (!LOCAL_DATE_PATTERN.test(localDate)) {
    throw new RangeError(`Expected a city-local date as YYYY-MM-DD, received "${localDate}"`);
  }
}

/** A call cap the conditional update can compare against, or a `RangeError` naming the value. */
function assertCap(cap: number): void {
  if (!Number.isSafeInteger(cap) || cap < 0) {
    throw new RangeError(`Expected a non-negative integer call cap, received ${cap}`);
  }
}

// The classification template below is a deliberate copy of
// `apps/api/src/modules/voice-agent/understanding.ts`: the relay that classifies a callee's speech
// runs in `apps/api` while the call's dialogue budget is reserved here, and a worker never imports the
// API (AAP 0.3.2). Every edit to that template must be mirrored here — the label order and the JSON
// schema's key order included, because the provider hashes the schema into the request it counts and
// then sends.
//
// Drift between the two copies loses no money: the relay counts every turn exactly and sends it only
// while its bound fits what is left of the attempt's reservation, so a budget computed from a copy
// that diverged can only end a call early (`needs_review`), never let a turn past the city's
// `CAP_LLM_USD_PER_CITY_DAY` (AAP 0.5.6, fail closed).

const UTTERANCE_LABELS = [
  'price',
  'dish',
  'yes',
  'no',
  'prefers_english',
  'wants_human',
  'stop',
  'do_not_call',
  'unclear',
] as const;

export const CLASSIFICATION_SYSTEM_PROMPT = `You classify one utterance from a phone call between an automated assistant and a person who may speak English, Portuguese, Spanish, Thai or Indonesian.
The assistant asks a venue for menu prices, or asks whether a named guest is staying there. You never write the assistant's side of the call: read the person's latest utterance and return one label.
Labels, exactly one per answer:
- "price": the person gave a price. Put the price as they said it in priceText, the same amount in major units as a number in priceAmount, and the item they named, if any, in dish.
- "dish": the person named a dish, a coffee or a beer without giving a price. Put the name in dish, and set drink to "coffee" or "beer" when the item is one of those, otherwise null.
- "yes": the person agreed, confirmed or answered affirmatively.
- "no": the person refused, disagreed or answered negatively.
- "prefers_english": the person asked to continue in English, or answered in English while the call is in another language.
- "wants_human": the person asked to speak to a person.
- "stop": the person asked to end the call.
- "do_not_call": the person asked never to be called again.
- "unclear": anything else — an answer you cannot interpret, a silence, or speech that is not about the question.
Rules:
- The conversation above the latest utterance is context only. Classify the latest utterance alone.
- Give priceAmount and priceText for a price, dish for a named item, drink for a named coffee or beer, and null for every value the person did not say.
- Never invent, guess, round or convert a value. A word the person did not say has a null value, and priceText is the price exactly as they said it.
- An acknowledgement that names neither an item nor a price is "yes" or "no", never "dish" or "price".
- The latest utterance may be in any of the five languages; a plain "sí", "sim", "ใช่" or "iya" is still a "yes".`;

export const CLASSIFICATION_JSON_SCHEMA: LlmJsonSchema = {
  name: 'utterance_classification',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['label', 'dish', 'drink', 'priceAmount', 'priceText'],
    properties: {
      label: { type: 'string', enum: [...UTTERANCE_LABELS] },
      dish: { type: ['string', 'null'] },
      drink: { type: ['string', 'null'], enum: ['coffee', 'beer', null] },
      priceAmount: { type: ['number', 'null'] },
      priceText: { type: ['string', 'null'] },
    },
  },
};

/**
 * The bound on generated tokens for one classification (AAP 0.5.6): a label and four short values, and
 * a fixed figure rather than a function of the utterance, which is what lets a call's whole dialogue
 * budget be reserved before it is dialed.
 */
export const CLASSIFICATION_MAX_OUTPUT_TOKENS = 120;

export const CLASSIFICATION_WINDOW_MAX_BYTES = 2_000;

export const CLASSIFICATION_TURN_TIMEOUT_MS = 3_000;

export const EXPECTED_ANSWERS = [
  'dish_and_price',
  'drink_price',
  'confirmation',
  'stay_answer',
] as const;

/**
 * What the dialogue is waiting for from the callee (AAP 0.5.6), the one thing the classification
 * prompt cannot infer from an utterance alone: "twelve fifty" is the price of a main course, a coffee
 * or a readback confirmation depending on the question that preceded it.
 */
export type ExpectedAnswer = (typeof EXPECTED_ANSWERS)[number];

/**
 * The dense mixed-script sample {@link DIALOGUE_BUDGET_WINDOW} repeats (AAP 0.5.6): Thai, Indonesian,
 * Portuguese with diacritics, digits, a currency sign and punctuation, so the counted bytes stand in
 * for the most expensive of the five call languages rather than for English.
 */
const DIALOGUE_BUDGET_SAMPLE = 'ราคา 120 บาท? Rp45.000, €12,50 — ação ';

/**
 * The longest prefix of `sample` repeated to at most `maxBytes` UTF-8 bytes, cut at a code-point
 * boundary so a Thai cluster is never halved; deterministic, so two processes count the same figure.
 */
function windowOfBytes(sample: string, maxBytes: number): string {
  const sampleBytes = utf8ByteLength(sample);
  if (sampleBytes === 0) {
    throw new RangeError('Expected a non-empty dialogue budget sample');
  }
  const codePoints = [...sample.repeat(Math.ceil(maxBytes / sampleBytes) + 1)];
  let kept = 0;
  let used = 0;
  while (kept < codePoints.length) {
    const width = utf8ByteLength(codePoints[kept] ?? '');
    if (used + width > maxBytes) {
      break;
    }
    used += width;
    kept += 1;
  }
  return codePoints.slice(0, kept).join('');
}

export const DIALOGUE_BUDGET_WINDOW: string = windowOfBytes(
  DIALOGUE_BUDGET_SAMPLE,
  CLASSIFICATION_WINDOW_MAX_BYTES,
);

/**
 * The request one classification turn is shaped like (AAP 0.5.6), built over the budget window: the
 * API's own layout, which is the equivalence {@link dialogueBudgetMicros} rests on — the same
 * `Expected: ` and `Conversation: ` labels, the same `Latest: ` trailer, the same system prompt,
 * schema and `maxTokens` as the API's `buildClassificationRequest`.
 *
 * `Latest: ` is deliberately left empty: an utterance is unbounded, so the window's dense bytes stand
 * in for it, and the relay's own per-turn check is what keeps the cap intact when a callee speaks
 * longer than the budget assumed. The request is never sent; only a turn the relay builds is.
 */
export function buildClassificationRequest(window: string, expected: ExpectedAnswer): LlmRequest {
  const content = ['Expected: ' + expected, 'Conversation:', window, 'Latest: '].join('\n');
  return {
    system: CLASSIFICATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
    jsonSchema: CLASSIFICATION_JSON_SCHEMA,
    maxTokens: CLASSIFICATION_MAX_OUTPUT_TOKENS,
  };
}

export interface DialogueBudgetInput {
  /** The configured provider; the budget can only be counted where a count can be made. */
  readonly llm: LlmAdapter;
  /** The meter's turn arithmetic, narrowed to the one operation the budget needs. */
  readonly spend: Pick<LlmSpend, 'dialogueBudgetMicros'>;
  /** `LLM_PRICE_INPUT_USD_PER_MTOK` and `LLM_PRICE_OUTPUT_USD_PER_MTOK` as the environment holds them. */
  readonly prices: LlmPrices;
  /** `LLM_MAX_TURNS_PER_CALL`, 60 in the plan (AAP 0.5.6). */
  readonly maxTurns: number;
  /** The deadline of each count; defaults to {@link CLASSIFICATION_TURN_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * The micro-dollars a call's dialogue holds, computed before the call is dialed (AAP 0.5.6):
 * `maxTurns` times the largest bound of one classification turn over a full conversation window.
 *
 * Every value of {@link EXPECTED_ANSWERS} is counted — four counts, run together because the count
 * endpoint is free and sends nothing (AAP 0.2.3) — and the largest bound fits any of them, so a call is
 * dialed with whatever the most expensive question of its script could cost. The multiplication stays
 * in `@tablemate/server-core`'s meter, which asserts both figures are non-negative safe integers.
 *
 * A count that fails or times out propagates (`LlmCountError`, `LlmTimeoutError`) rather than falling
 * back to an estimate: the caller dials nothing, the fail-closed side of "a call whose budget cannot
 * be reserved is not dialed" (AAP 0.5.6).
 */
export async function dialogueBudgetMicros(input: DialogueBudgetInput): Promise<number> {
  const timeoutMs = input.timeoutMs ?? CLASSIFICATION_TURN_TIMEOUT_MS;
  const turnBounds = await Promise.all(
    EXPECTED_ANSWERS.map(async (expected) => {
      const request = buildClassificationRequest(DIALOGUE_BUDGET_WINDOW, expected);
      const countedInputTokens = await input.llm.countInputTokens(request, { timeoutMs });
      return boundMicros(countedInputTokens, request.maxTokens, input.prices);
    }),
  );
  return input.spend.dialogueBudgetMicros(Math.max(...turnBounds), input.maxTurns);
}
