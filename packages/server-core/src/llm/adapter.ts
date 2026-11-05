/**
 * The provider-neutral language-model contract: the request, result and usage shapes, the error
 * vocabulary the spend meter throws and catches, and the factory that selects a provider from
 * validated configuration (AAP 0.3.1, AAP 0.5.1).
 *
 * Nothing here reads the environment — the parsed `llm` group of `src/env/modes.ts` arrives as
 * {@link LlmAdapterConfig} — and prices are not an adapter's business: they go to `createLlmSpend`.
 *
 * Every call follows the order AAP 0.5.6 fixes: count the identical payload with
 * {@link LlmAdapter.countInputTokens}, reserve that worst case against the city's cap, then send it
 * with {@link LlmAdapter.complete}. That is why the provider's own count is part of the interface.
 *
 * Error messages carry the code and numbers only — a prompt, a menu, a transcript, a callee's speech
 * or a model's output must reach neither a log nor a response (AAP 0.11.1, AAP 0.12.2) — so a
 * provider's own error travels in `cause`, never in `message`.
 */

import { createFakeLlmAdapter } from './fake.ts';
import { createOpenAiAdapter } from './openai.ts';
import type { FakeLlmOptions } from './fake.ts';
import type { OpenAiResponsesClient } from './openai.ts';

// `openai.ts` and `fake.ts` import this file's error classes and `assertLlmRequest`, so this cycle
// is safe only while nothing here reads an imported binding at module top level: both factories are
// called from `createLlmAdapter`'s body alone, and no constant below is built from an imported
// value.

/** One message of the conversation sent to the provider (AAP 0.5.6). */
export interface LlmMessage {
  /** `'assistant'` replays an earlier turn of the same exchange; nothing else is sent as one. */
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A strict structured-output schema: the schema object under the name the provider registers it as.
 * Callers build it from a shared Zod schema (`z.toJSONSchema`), so the shape the model must return
 * and the shape the caller validates stay one declaration. The adapter passes it through unchanged.
 */
export interface LlmJsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

/**
 * One request: the payload {@link LlmAdapter.countInputTokens} counts, then
 * {@link LlmAdapter.complete} sends (AAP 0.5.6).
 */
export interface LlmRequest {
  /** The system prompt. */
  system: string;
  /** The conversation so far, oldest first. */
  messages: readonly LlmMessage[];
  /** Present only where the caller parses the reply as data; omitted for free text. */
  jsonSchema?: LlmJsonSchema;
  /** The bound on generated tokens, reasoning tokens included (AAP 0.2.3). */
  maxTokens: number;
}

/**
 * The provider's own token figures for one request (AAP 0.5.6); `spend.ts` compares the input
 * count it reports with the bound that was reserved.
 */
export interface LlmUsage {
  /** Input tokens as the provider reported them. */
  inputTokens: number;
  /** Output tokens as reported, reasoning tokens included. */
  outputTokens: number;
}

/** What one completed request returned (AAP 0.5.6). */
export interface LlmResult {
  text: string;
  /** The parsed structured output, or `null` when none was asked for or the text did not parse. */
  json: unknown;
  /** The reported usage, or `null` when none was reported; `spend.ts` then charges in full. */
  usage: LlmUsage | null;
}

/**
 * The per-call bounds the caller owns: the voice relay gives a turn 3 s, shared by its count and its
 * classification, and menu extraction gives a request 60 s (AAP 0.11.1).
 */
export interface LlmCallOptions {
  /** The deadline for this call, counted by the provider itself rather than by a shared timer. */
  timeoutMs: number;
  /** Aborts the call: a relay connection that closed, or a job that was cancelled. */
  signal?: AbortSignal;
}

/** The providers {@link createLlmAdapter} can build (AAP 0.3.1). */
export type LlmProviderName = 'openai' | 'fake';

/**
 * One provider behind the interface its callers know (AAP 0.3.1, AAP 0.5.1). No file outside this
 * directory imports a provider SDK.
 */
export interface LlmAdapter {
  readonly provider: LlmProviderName;
  /** The provider's model identifier, the value `LLM_MODEL` selected. */
  readonly model: string;
  /**
   * The provider's authoritative input-token count for exactly the payload {@link LlmAdapter.complete}
   * would send, schema and message framing included (AAP 0.5.6). Nothing is sent by this call, and
   * the count a response later reports is compared with it.
   *
   * @throws LlmCountError on any failure or timeout. The request must then not be sent.
   */
  countInputTokens(request: LlmRequest, options: LlmCallOptions): Promise<number>;
  /**
   * Send one request and return its reply. Exactly one request is sent, with no automatic retry: a
   * retry reserves again against the city's cap, so the caller decides whether to make one.
   *
   * @throws LlmTimeoutError on timeout or abort, and LlmProviderError on any other failure.
   */
  complete(request: LlmRequest, options: LlmCallOptions): Promise<LlmResult>;
}

/** Which provider to build, as the parsed `llm` group of `src/env/modes.ts` supplies it. */
export type LlmAdapterConfig =
  { provider: 'fake' } | { provider: 'openai'; apiKey: string; model: string };

/**
 * What {@link createLlmAdapter} may be handed in place of a real dependency: a stub client for the
 * OpenAI provider, or scripted options for the fake one. Suites inject through here, so none reaches
 * a provider.
 */
export interface LlmAdapterDeps {
  openaiClient?: OpenAiResponsesClient;
  fake?: FakeLlmOptions;
}

/** The code every language-model failure carries (AAP 0.5.6). */
export type LlmErrorCode =
  | 'llm_count_failed'
  | 'llm_timeout'
  | 'llm_provider_error'
  | 'llm_budget_refused'
  | 'llm_suspended';

/**
 * The base of the language-model vocabulary, and the only place these codes are defined. Log `code`
 * — and `status` on {@link LlmProviderError} — and nothing from `message`, which carries the code
 * and numbers only (AAP 0.11.1).
 */
export class LlmError extends Error {
  readonly code: LlmErrorCode;

  constructor(code: LlmErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

/** Why a count failed: the provider errored, the call timed out, or the answer was not a count. */
export type LlmCountFailureReason = 'provider' | 'timeout' | 'invalid_count';

/**
 * The provider's token count could not be established, so its request was not sent and nothing was
 * reserved for it (AAP 0.5.6: "When the count fails or times out, the request is not sent").
 */
export class LlmCountError extends LlmError {
  readonly reason: LlmCountFailureReason;

  constructor(reason: LlmCountFailureReason, options?: ErrorOptions) {
    super('llm_count_failed', `llm_count_failed reason=${reason}`, options);
    this.reason = reason;
  }
}

/** Whether a call elapsed its deadline or was aborted through the caller's signal. */
export type LlmTimeoutReason = 'timeout' | 'aborted';

/**
 * The request's deadline elapsed, or its caller aborted it. `chargedMicros` stays 0 until `spend.ts`
 * settles the attempt, which is how the voice relay learns what an errored turn consumed (AAP 0.5.6).
 */
export class LlmTimeoutError extends LlmError {
  readonly reason: LlmTimeoutReason;
  /** Set by `spend.ts` before it rethrows; an aborted turn's tokens may already be billed. */
  chargedMicros = 0;

  constructor(reason: LlmTimeoutReason, options?: ErrorOptions) {
    super('llm_timeout', `llm_timeout reason=${reason}`, options);
    this.reason = reason;
  }
}

/**
 * The provider failed for a reason other than a timeout. `status` is its HTTP status where the
 * failure arrived as a response, or `null` where it did not, and it is the field to log beside
 * `code` (AAP 0.11.1).
 */
export class LlmProviderError extends LlmError {
  readonly status: number | null;
  /** Set by `spend.ts` before it rethrows; a failed request's tokens may already be billed. */
  chargedMicros = 0;

  constructor(options?: { status?: number; cause?: unknown }) {
    const status = options?.status;
    super(
      'llm_provider_error',
      status === undefined ? 'llm_provider_error' : `llm_provider_error status=${status}`,
      options,
    );
    this.status = status ?? null;
  }
}

/**
 * The request's worst case does not fit the budget it was reserved against, so it was not sent.
 * `city_cap` is `CAP_LLM_USD_PER_CITY_DAY`; `reservation` is what is left of one call's dialogue
 * reservation, which ends the call politely instead of crossing the cap (AAP 0.5.6).
 */
export class LlmBudgetRefusedError extends LlmError {
  readonly scope: 'city_cap' | 'reservation';
  /** The counted cost the request would have incurred, in micro-dollars. */
  readonly boundMicros: number;
  /** What remained under the budget, or `null` where the caller did not supply it. */
  readonly availableMicros: number | null;

  constructor(input: {
    boundMicros: number;
    availableMicros?: number;
    scope: 'city_cap' | 'reservation';
  }) {
    const available = input.availableMicros;
    super(
      'llm_budget_refused',
      available === undefined
        ? `llm_budget_refused scope=${input.scope} bound=${input.boundMicros}`
        : `llm_budget_refused scope=${input.scope} bound=${input.boundMicros} available=${available}`,
    );
    this.scope = input.scope;
    this.boundMicros = input.boundMicros;
    this.availableMicros = available ?? null;
  }
}

/**
 * A reported count differed from the count that was reserved for, so language-model use is suspended
 * in every city until an operator re-enables it (AAP 0.5.6): the evidence that a reservation bounds
 * the spend no longer holds.
 */
export class LlmSuspendedError extends LlmError {
  constructor() {
    super('llm_suspended', 'llm_suspended');
  }
}

/**
 * Validate the request both providers require before they touch the wire (AAP 0.5.6). Each provider
 * calls this at the start of `countInputTokens` and `complete`, so a malformed request fails here as
 * a `RangeError` rather than as a provider error. The message names the offending field and nothing
 * of its value, because a request carries prompts, menus and transcripts.
 *
 * @throws RangeError when `maxTokens` is not a positive safe integer, when `system` is not a string,
 * or when a message's role is neither `'user'` nor `'assistant'` or its content is not a string.
 */
export function assertLlmRequest(request: LlmRequest): void {
  if (typeof request.system !== 'string') {
    throw new RangeError('request.system must be a string');
  }
  if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0) {
    throw new RangeError('request.maxTokens must be a positive safe integer');
  }
  for (const message of request.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new RangeError('request.messages[].role must be "user" or "assistant"');
    }
    if (typeof message.content !== 'string') {
      throw new RangeError('request.messages[].content must be a string');
    }
  }
}

/**
 * Build the adapter `config.provider` names, the one entry point its callers use (AAP 0.3.1). `deps`
 * exists for tests. An absent `openaiClient` is omitted from the options object rather than assigned
 * as `undefined`, which `exactOptionalPropertyTypes` refuses.
 *
 * @throws RangeError when the OpenAI provider is asked for a model outside `SUPPORTED_MODELS`.
 */
export function createLlmAdapter(config: LlmAdapterConfig, deps?: LlmAdapterDeps): LlmAdapter {
  switch (config.provider) {
    case 'fake':
      return createFakeLlmAdapter(deps?.fake ?? {});
    case 'openai': {
      const client = deps?.openaiClient;
      return client === undefined
        ? createOpenAiAdapter({ apiKey: config.apiKey, model: config.model })
        : createOpenAiAdapter({ apiKey: config.apiKey, model: config.model, client });
    }
    default: {
      const unreachable: never = config;
      throw new RangeError(`unknown llm provider: ${String(unreachable)}`);
    }
  }
}
