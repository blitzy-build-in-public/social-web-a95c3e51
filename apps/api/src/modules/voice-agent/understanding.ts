/**
 * The voice agent's utterance classifier: the one language-model call in `apps/api`, run only on
 * Twilio-initiated relay connections and metered against the dialogue budget the call already holds
 * (AAP 0.3.2, AAP 0.5.6).
 *
 * The agent speaks only fixed per-language templates (AAP 0.5.6), so the model's whole job is to
 * read the callee's latest utterance and answer with one label plus the values that were actually
 * said: `price`, `dish`, `yes`, `no`, `prefers_english`, `wants_human`, `stop`, `do_not_call` or
 * `unclear`. No turn is ever composed by the model, and a turn that does not fit the reservation is
 * never sent: the relay speaks its closing line instead and the attempt needs review.
 *
 * The template below is a cross-app contract rather than a private detail. `apps/workers`'
 * `call-dispatch` reserves a call's dialogue budget as `LLM_MAX_TURNS_PER_CALL` times the counted
 * bound of a turn built from this template with a 2,000-byte conversation window, and it cannot
 * import `apps/api`. Its copy of {@link CLASSIFICATION_SYSTEM_PROMPT},
 * {@link CLASSIFICATION_JSON_SCHEMA}, {@link CLASSIFICATION_MAX_OUTPUT_TOKENS} and the layout
 * {@link buildClassificationRequest} writes must therefore be byte-identical, the insertion order of
 * the schema's keys included. Drift between the two loses nothing: every turn is counted exactly and
 * a turn that does not fit is refused, so a mismatch can only end calls early, never overspend.
 *
 * This module is a leaf: `dialogue.ts` imports it, so it imports nothing from the voice agent, and
 * {@link ClassificationContext} states what a turn needs structurally rather than importing the
 * session that satisfies it.
 *
 * Nothing here logs, returns or throws anything of the callee's words: a failure is recorded as a
 * code, and the utterance, the window, the extracted values and the model's reply reach neither a
 * log line nor an answer (AAP 0.11.1, AAP 0.12.2).
 *
 * @see AAP 0.5.6 for the fixed templates, the label set, the 3-second turn timeout and the caps,
 *   AAP 0.3.2 for why this is the only model call in the request-serving process, and AAP 0.11.1 for
 *   what a log line may carry.
 */

import { z } from 'zod';

import { utf8ByteLength } from '@tablemate/shared';
import {
  LlmBudgetRefusedError,
  LlmCountError,
  LlmProviderError,
  LlmSuspendedError,
  LlmTimeoutError,
} from '@tablemate/server-core';

import type {
  LlmAdapter,
  LlmJsonSchema,
  LlmRequest,
  LlmReservation,
  LlmSpend,
  Logger,
} from '@tablemate/server-core';

/**
 * Every label {@link Classification.label} may hold, in the order the schema's `enum` lists them
 * (AAP 0.5.6). The array is the one runtime source of the set: the JSON schema sent to the provider
 * and the Zod mirror that reads its reply are both built from it, so a label added here reaches
 * both.
 */
export const UTTERANCE_LABELS = [
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

/** One label of {@link UTTERANCE_LABELS}. */
export type UtteranceLabel = (typeof UTTERANCE_LABELS)[number];

/**
 * The system prompt of every classification turn (AAP 0.5.6).
 *
 * Fixed and English whichever language the call opened in: the callee may answer in any of the five
 * languages, so the model, not the caller, is the thing that reads the words, and the prompt says
 * plainly that it only classifies and never writes the assistant's side of the call. The label set,
 * the readback values the dialogue needs and the two prohibitions that matter — never invent a
 * value, never treat a bare acknowledgement as a dish or a price — are all stated here rather than
 * left to the schema, which can constrain a shape but not a meaning.
 */
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

/**
 * The strict structured output every classification turn asks for (AAP 0.5.6).
 *
 * A literal object rather than a schema generated at runtime, so the copy `apps/workers` keeps
 * beside `call-dispatch`'s budget reservation can be byte-identical: the provider registers it by
 * name and hashes it into the request, and both key order and `enum` order are part of those bytes.
 * Every key is required and nothing else is admitted, which is what strict mode demands and what
 * keeps a reply from carrying a value this module does not read.
 */
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
 * The bound on generated tokens for one classification (AAP 0.5.6): a label and four short values,
 * and a fixed number rather than a function of the utterance, because `call-dispatch` reserves a
 * call's dialogue budget from it before dialing.
 */
export const CLASSIFICATION_MAX_OUTPUT_TOKENS = 120;

/**
 * The most UTF-8 bytes of conversation the window may carry (AAP 0.5.6). It is the figure
 * `call-dispatch` builds a call's dialogue budget from, so a turn whose window stays inside it fits
 * the reservation that was made for it.
 */
export const CLASSIFICATION_WINDOW_MAX_BYTES = 2_000;

/**
 * The deadline of one classification turn, shared by its count and its send (AAP 0.5.6). A callee
 * waits through it, so a provider that is slow rather than wrong ends the call politely instead of
 * holding the line.
 */
export const CLASSIFICATION_TURN_TIMEOUT_MS = 3_000;

/**
 * What the dialogue is waiting for from the callee, which is the one thing the classification prompt
 * cannot infer from the utterance alone: "twelve fifty" is a price of a main course, a coffee or a
 * readback confirmation depending on the question that preceded it (AAP 0.5.6).
 *
 * `stay_answer` is the yes/no about the guest's stay, so its expected answer is already two-valued
 * and the classification has no price to read.
 */
export type ExpectedAnswer = 'dish_and_price' | 'drink_price' | 'confirmation' | 'stay_answer';

/**
 * What one classification returned: the callee's utterance as data, with every value the person did
 * not say left null (AAP 0.5.6). A label is always present — an unusable reply reads as `unclear`
 * rather than as a failure — so a caller can switch on it without also handling a missing reply.
 */
export interface Classification {
  /** Exactly one of the label set; `unclear` whenever the reply could not be used. */
  readonly label: UtteranceLabel;
  /** The dish or drink the callee named, or null. */
  readonly dish: string | null;
  /** Set only when the named item is one of the two the price script asks about. */
  readonly drink: 'coffee' | 'beer' | null;
  /** The price in major units of its own currency, or null; never converted (AAP 0.11.1). */
  readonly priceAmount: number | null;
  /** The price exactly as the callee said it, or null. */
  readonly priceText: string | null;
}

/** One classification and what the turn cost (AAP 0.5.6). */
export interface ClassificationResult {
  /** The utterance as data; `label: 'unclear'` when the reply could not be used. */
  readonly classification: Classification;
  /** The micro-dollars the turn consumed, already settled by `spend.ts` against its reservation. */
  readonly chargedMicros: number;
}

/**
 * What {@link classifyUtterance} needs from its caller: the API's services, narrowed to the three it
 * reads. The app's services object satisfies this structurally, and a suite can stand a fake adapter,
 * a memory spend meter and a capturing logger in for the real ones, as
 * `apps/api/test/unit/voice-dialogue.test.ts` does.
 */
export interface ClassificationServices {
  /** The configured provider; the prompt and the schema below are the only request it sees here. */
  readonly llm: LlmAdapter;
  /** The meter that counts the identical payload, fits it to the reservation, then sends it. */
  readonly spend: LlmSpend;
  /** Records a failed turn as a code and nothing else (AAP 0.11.1). */
  readonly logger: Logger;
}

/**
 * The state one turn is classified against (AAP 0.5.6), which `DialogueSession` satisfies
 * structurally — this module never imports it, because it imports this one.
 */
export interface ClassificationContext {
  /** The dialogue budget the call holds, rebuilt from `CallAttempt.llmReservedMicros`. */
  readonly reservation: LlmReservation;
  /** What is left of it, which a turn whose bound does not fit is refused against. */
  readonly remainingMicros: number;
  /** The utterances so far, oldest first; only the most recent 2,000 bytes are sent. */
  readonly window: readonly string[];
  /**
   * Aborts the count and the classification, for a relay connection that closed mid-turn. Optional,
   * and spread into the meter's options rather than assigned as `undefined`, which
   * `exactOptionalPropertyTypes` refuses.
   */
  readonly signal?: AbortSignal;
}

/**
 * How a failed turn ended, and what it consumed of the call's dialogue budget (AAP 0.5.6): the two
 * endings the dialogue gives a failed turn. A `budget` refusal means the turn did not fit and was
 * never sent, so the call closes politely with whatever the attempt has; a `model` failure means the
 * provider failed, and the turn may already have been billed.
 */
export interface ClassificationFailure {
  /** `'budget'` for a turn that did not fit the reservation; `'model'` for every other failure. */
  readonly kind: 'budget' | 'model';
  /** The micro-dollars the failure consumed, which the session subtracts from what is left. */
  readonly chargedMicros: number;
}

/**
 * The Zod mirror of {@link CLASSIFICATION_JSON_SCHEMA}, the one reader of a reply (AAP 0.5.6).
 *
 * Strict on purpose, so a reply carrying a key the schema does not admit is unusable rather than
 * silently half-read; `@tablemate/shared` defines no classification schema, so this is a local
 * declaration rather than a redeclaration of one.
 */
const ClassificationSchema = z.strictObject({
  label: z.enum(UTTERANCE_LABELS),
  dish: z.string().nullable(),
  drink: z.enum(['coffee', 'beer']).nullable(),
  priceAmount: z.number().nullable(),
  priceText: z.string().nullable(),
});

/** The one classification an unusable reply produces: no label read, no values. */
const UNCLEAR: Classification = Object.freeze({
  label: 'unclear',
  dish: null,
  drink: null,
  priceAmount: null,
  priceText: null,
});

/**
 * The request one classification turn sends (AAP 0.5.6).
 *
 * Pure and deterministic: the same window, expected answer and utterance serialize to the same
 * bytes, which is what lets the count and the send agree and what `call-dispatch`'s own copy of this
 * layout has to match. The window keeps its most recent lines while they fit
 * {@link CLASSIFICATION_WINDOW_MAX_BYTES}, counting the newline between them; older lines are
 * dropped whole, and a single line too long to keep is truncated from its start, so the latest words
 * survive. The utterance itself travels whole: it is one sentence of a live call, and a turn that
 * outgrows the reservation is refused rather than sent.
 *
 * @param window - The dialogue so far, oldest first.
 * @param expected - What the assistant just asked for, which is what makes a bare number a price.
 * @param latest - The callee's latest utterance, as ConversationRelay transcribed it.
 * @returns The request to count, then send; `maxTokens` and the schema are the exported constants.
 */
export function buildClassificationRequest(
  window: readonly string[],
  expected: ExpectedAnswer,
  latest: string,
): LlmRequest {
  const lines = [
    'Expected: ' + expected,
    'Conversation:',
    ...trimWindow(window, CLASSIFICATION_WINDOW_MAX_BYTES),
    'Latest: ' + latest,
  ];
  return {
    system: CLASSIFICATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: lines.join('\n') }],
    jsonSchema: CLASSIFICATION_JSON_SCHEMA,
    maxTokens: CLASSIFICATION_MAX_OUTPUT_TOKENS,
  };
}

/**
 * The most recent window lines that fit `maxBytes` UTF-8 bytes, separators included, oldest first.
 *
 * Lines are dropped whole so a turn never reads half of an earlier exchange, except for the newest
 * line: there is nothing newer to fall back on, so its tail is kept.
 */
function trimWindow(window: readonly string[], maxBytes: number): readonly string[] {
  const kept: string[] = [];
  let used = 0;

  for (let index = window.length - 1; index >= 0; index -= 1) {
    const line = window[index] ?? '';
    // The newline this line adds to the block; the first line kept needs none.
    const cost = utf8ByteLength(line) + (kept.length === 0 ? 0 : 1);
    if (used + cost > maxBytes) {
      if (kept.length === 0) {
        const tail = tailWithinBytes(line, maxBytes);
        if (tail !== '') {
          kept.push(tail);
        }
      }
      break;
    }
    kept.push(line);
    used += cost;
  }

  return kept.reverse();
}

/** The trailing code points of `line` that fit `maxBytes` UTF-8 bytes, or `''` when none do. */
function tailWithinBytes(line: string, maxBytes: number): string {
  // Spread over a string yields whole code points, so a Thai cluster or an emoji is never cut in
  // half into a lone surrogate.
  const codePoints = [...line];
  let kept = codePoints.length;
  let used = 0;

  while (kept > 0) {
    const width = utf8ByteLength(codePoints[kept - 1] ?? '');
    if (used + width > maxBytes) {
      break;
    }
    used += width;
    kept -= 1;
  }

  return codePoints.slice(kept).join('');
}

/**
 * Classify one utterance inside the call's dialogue budget (AAP 0.5.6).
 *
 * One turn is one counted, reserved and charged request: the meter counts the identical payload,
 * refuses it when its bound does not fit what is left of the reservation, sends it otherwise, and
 * charges against the city's local day. Failures are rethrown unchanged — the vocabulary's own error
 * classes keep their identity and, on a failed send, the `chargedMicros` the meter recorded — so
 * `dialogue.ts` reads a failure with `instanceof` where it needs a specific one, and reads the
 * ending it owes the callee with {@link describeClassificationFailure}. A reply that cannot be used
 * is not a failure: it is `unclear`, with every value null, because the turn was sent and charged
 * either way.
 *
 * @param services - The app's services: the adapter, the meter and the logger.
 * @param context - The window and the reservation the turn draws on.
 * @param text - The callee's latest utterance, as the relay transcribed it.
 * @param expected - What the assistant just asked for.
 * @returns The classification, with every value the callee did not say left null.
 * @throws LlmBudgetRefusedError when the turn does not fit the remaining dialogue budget, and
 *   `LlmCountError`, `LlmSuspendedError`, `LlmTimeoutError` or `LlmProviderError` when the model
 *   could not answer. Each is logged here as a code and nothing more.
 */
export async function classifyUtterance(
  services: ClassificationServices,
  context: ClassificationContext,
  text: string,
  expected: ExpectedAnswer,
): Promise<ClassificationResult> {
  const request = buildClassificationRequest(context.window, expected, text);

  try {
    const charge = await services.spend.runMeteredWithin(services.llm, request, {
      reservation: context.reservation,
      remainingMicros: context.remainingMicros,
      timeoutMs: CLASSIFICATION_TURN_TIMEOUT_MS,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    return {
      classification: readClassification(charge.result.json),
      chargedMicros: charge.chargedMicros,
    };
  } catch (error) {
    // A code and nothing else: the utterance, the window, the extracted values and the reply are
    // absent from this line, as they are from every other (AAP 0.11.1, AAP 0.12.2).
    services.logger.warn(
      { event: 'voice_classification_failed', reason: failureCode(error) },
      'voice_classification_failed',
    );
    throw error;
  }
}

/**
 * How the dialogue reads a failure {@link classifyUtterance} threw: the ending it owes the callee,
 * and what the failed turn consumed of the dialogue budget (AAP 0.5.6).
 *
 * `remainingMicros` is the budget the failed turn was metered against. It is the answer for a
 * failure the meter's vocabulary does not name and for one whose charge it could not report: the
 * session then treats the call's dialogue budget as spent and closes politely, which is the
 * fail-closed side of the one thing this function must never do — leave a turn's cost out of the
 * account and let a call keep spending past what it reserved.
 *
 * @param error - Whatever {@link classifyUtterance} threw, unchanged.
 * @param remainingMicros - What was left of the reservation when the turn was attempted.
 * @returns The failure's kind and the micro-dollars it consumed.
 */
export function describeClassificationFailure(
  error: unknown,
  remainingMicros: number,
): ClassificationFailure {
  const budget = Number.isSafeInteger(remainingMicros) && remainingMicros > 0 ? remainingMicros : 0;

  if (error instanceof LlmBudgetRefusedError) {
    // Counted and refused before it was sent, so the turn consumed nothing.
    return { kind: 'budget', chargedMicros: 0 };
  }
  if (error instanceof LlmTimeoutError || error instanceof LlmProviderError) {
    // A failed send may already have been billed: `spend.ts` charges the whole bound and records it
    // on the error, which is the figure to subtract. Without a usable one, the rest is the bound.
    const charged = error.chargedMicros;
    const reported = Number.isSafeInteger(charged) && charged >= 0 ? charged : budget;
    return { kind: 'model', chargedMicros: reported };
  }
  if (error instanceof LlmCountError || error instanceof LlmSuspendedError) {
    // The count failed, or the meter is suspended: nothing was sent and nothing was charged.
    return { kind: 'model', chargedMicros: 0 };
  }
  // Not a failure the vocabulary names. Fail closed rather than guess.
  return { kind: 'model', chargedMicros: budget };
}

/**
 * One reply as a {@link Classification}. A reply that does not match {@link ClassificationSchema},
 * or that is missing altogether, reads as `unclear` with every value null: the turn was counted,
 * sent and charged by then, so an unusable answer is a value of this domain rather than an error. A
 * price that is not a finite number above zero is not a price and becomes null, and blank text
 * becomes null, so a caller never has to tell an absent value from an empty one.
 */
function readClassification(json: unknown): Classification {
  const parsed = ClassificationSchema.safeParse(json);
  if (!parsed.success) {
    return UNCLEAR;
  }

  const { label, dish, drink, priceAmount, priceText } = parsed.data;
  return {
    label,
    dish: textOrNull(dish),
    drink,
    priceAmount:
      priceAmount !== null && Number.isFinite(priceAmount) && priceAmount > 0 ? priceAmount : null,
    priceText: textOrNull(priceText),
  };
}

/** Text with its surrounding space removed, read as absent when nothing is left. */
function textOrNull(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The code a failure is logged under: an `LlmError`'s own code, or `'unknown'` (AAP 0.11.1). */
function failureCode(error: unknown): string {
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'unknown';
}
