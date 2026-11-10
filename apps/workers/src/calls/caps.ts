/** The per-city call caps and the dialogue budget a call is dialed with (AAP 0.5.6): a slot lives on the `call_budget_day` row of a city and its local day, and {@link reserveCall} is its only writer, keeping the check inside the `UPDATE`'s own `WHERE` so PostgreSQL re-evaluates it under the row lock it took and exactly one of two dispatches racing for the last slot of a day claims it. The insert comes first because a local day with no traffic yet has no row for the update to find; {@link dialogueBudgetMicros} reserves a call's whole worst case before it dials, so the city cap cannot be crossed mid-call. */

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
interface BudgetRow {
  city_id: string;
}

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

/** Give back the call slot its caller reserved: only a definite rejection frees it, because a call whose create answer was lost may exist and the day's count must stay an upper bound on the calls placed; `GREATEST("calls" - 1, 0)` keeps a double release from pushing the count below zero. */
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

/** When a task over either cap may next be attempted: 09:00 in the business's city time on the next local day, so the task keeps its status and is eligible again the following morning rather than being dropped or left behind the cap all day. */
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

// Deliberate copy of the API's classification template in `apps/api/src/modules/voice-agent/understanding.ts`: the relay that classifies a callee's speech runs in `apps/api` while the dialogue budget is reserved here, and a worker never imports the API. Every edit to that template must be mirrored here — the label order and the JSON schema's key order included, because the provider hashes the schema into the request it counts and then sends. Drift loses no money: the relay counts every turn exactly and sends it only while its bound fits what is left of the reservation, so a diverged copy can only end a call early (`needs_review`), never let a turn past the city's `CAP_LLM_USD_PER_CITY_DAY`.

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
/** The bound on generated tokens for one classification: a label and four short values, and a fixed figure rather than a function of the utterance, which is what lets a call's whole dialogue budget be reserved before it is dialed. */
export const CLASSIFICATION_MAX_OUTPUT_TOKENS = 120;
export const CLASSIFICATION_WINDOW_MAX_BYTES = 2_000;
export const CLASSIFICATION_TURN_TIMEOUT_MS = 3_000;
export const EXPECTED_ANSWERS = [
  'dish_and_price',
  'drink_price',
  'confirmation',
  'stay_answer',
] as const;
export type ExpectedAnswer = (typeof EXPECTED_ANSWERS)[number];
/** The dense mixed-script sample {@link DIALOGUE_BUDGET_WINDOW} repeats — Thai, Indonesian, Portuguese with diacritics, digits, a currency sign and punctuation — so the counted bytes stand in for the most expensive of the five call languages rather than for English. */
const DIALOGUE_BUDGET_SAMPLE = 'ราคา 120 บาท? Rp45.000, €12,50 — ação ';
/** The longest prefix of `sample` repeated to at most `maxBytes` UTF-8 bytes, cut at a code-point boundary so a Thai cluster is never halved; deterministic, so two processes count the same figure. */
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
/** The request one classification turn is shaped like, built over the budget window and identical to the API's `buildClassificationRequest` — the same `Expected: ` and `Conversation: ` labels, the same `Latest: ` trailer, the same system prompt, schema and `maxTokens` — which is the equivalence {@link dialogueBudgetMicros} rests on. `Latest: ` is deliberately empty, since an utterance is unbounded and the relay's own per-turn check is what keeps the cap intact; the request is never sent. */
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
  readonly llm: LlmAdapter;
  readonly spend: Pick<LlmSpend, 'dialogueBudgetMicros'>;
  readonly prices: LlmPrices;
  readonly maxTurns: number;
  readonly timeoutMs?: number;
}

/** The micro-dollars a call's dialogue holds, computed before the call is dialed: `maxTurns` times the largest bound of one classification turn over a full conversation window, counted for every value of {@link EXPECTED_ANSWERS} so a call is dialed with whatever the most expensive question of its script could cost. A count that fails or times out propagates rather than falling back to an estimate — the fail-closed side of "a call whose budget cannot be reserved is not dialed". */
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
