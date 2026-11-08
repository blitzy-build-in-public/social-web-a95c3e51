/**
 * The OpenAI provider behind {@link LlmAdapter} (AAP 0.3.1): the one place the `openai` SDK is
 * called, implementing the accepted request profile of AAP 0.5.6.
 *
 * The profile is what makes the per-city spend cap hard, so three things here are deliberate.
 * {@link buildResponsesInput} builds both payloads from one request in one key order: the count
 * endpoint receives that object exactly and `create` receives it plus only `max_output_tokens` and
 * `store`, the two generation-only keys the count endpoint does not accept, because `spend.ts` reads
 * any other difference between the counted and the sent payload as a count mismatch and suspends
 * every city. Retries are off on every call (`maxRetries: 0`), so one reservation covers exactly one
 * sent request. No `tools`, `tool_choice`, `reasoning`, `temperature`, `previous_response_id`,
 * `conversation` or streaming key is ever added.
 *
 * The count endpoint is free (AAP 0.2.3) and reserves nothing; `complete` is the only call that
 * spends, and neither runs for a request the provider would refuse ({@link OPENAI_MIN_OUTPUT_TOKENS}).
 *
 * This file reads no environment and no clock — the API key arrives as an argument, because
 * `src/env/modes.ts` imports {@link SUPPORTED_MODELS} from here (AAP 0.5.6) — and it logs nothing: a
 * prompt, a menu, a transcript or a reply must reach neither a log nor an error message (AAP 0.11.1,
 * AAP 0.12.2), so a provider's own failure travels in `cause`.
 *
 * The graph runs one way here: the shared vocabulary — the error classes and `assertLlmRequest` —
 * comes from `contract.ts`, which imports nothing, and `adapter.ts` imports this file's factory.
 * Nothing in this file imports `adapter.ts`, so no load order can meet an uninitialised binding.
 */

import OpenAI, { APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import type { InputTokenCountParams } from 'openai/resources/responses/index.js';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses.js';
import { assertLlmRequest, LlmCountError, LlmProviderError, LlmTimeoutError } from './contract.ts';
import type {
  LlmAdapter,
  LlmCallOptions,
  LlmError,
  LlmRequest,
  LlmResult,
  LlmUsage,
} from './contract.ts';

/**
 * The models `LLM_MODEL` may name (AAP 0.5.6): each used text-only, billed purely per input and
 * output token, supporting `text.format` `json_schema` structured outputs and the
 * `POST /v1/responses/input_tokens` count this profile rests on — checked against OpenAI's model and
 * pricing pages on 2026-11-04. Cached input is cheaper than uncached input on every one of them, so
 * pricing every input token at the full input rate, which is what `spend.ts` does, stays an upper
 * bound on the cost.
 *
 * Realtime, audio, search, computer-use and deep-research models are absent on purpose: their
 * billing includes per-call or per-tool charges that a per-token bound cannot cover.
 *
 * `src/env/modes.ts` refuses to start for any other `LLM_MODEL`, and the list is documented in
 * `docs/menu-extraction.md`. A future provider must offer an equally authoritative count or be
 * refused the same way.
 */
export const SUPPORTED_MODELS = ['gpt-4.1-mini', 'gpt-4.1', 'gpt-5-mini'] as const;

/** A model `LLM_MODEL` may name (AAP 0.5.6). */
export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

/** Whether `model` is one of {@link SUPPORTED_MODELS}, narrowable to {@link SupportedModel}. */
export function isSupportedModel(model: string): model is SupportedModel {
  return (SUPPORTED_MODELS as readonly string[]).includes(model);
}

/**
 * The provider's documented minimum for `max_output_tokens` on `POST /v1/responses` ("integer below
 * minimum value. Expected a value >= 16", confirmed 2026-11-04): below it the request is refused, so
 * both calls here refuse it first and nothing is counted that `complete` could not send.
 */
export const OPENAI_MIN_OUTPUT_TOKENS = 16;

/**
 * The client's own deadline for any call that does not pass one, standing at the ceiling AAP 0.11.1
 * sets for the language model ("language model 3 s in calls and 60 s in extraction"). Every call
 * this file makes passes `LlmCallOptions.timeoutMs`, which overrides it, so it bounds exactly the
 * call that forgot one; without it the SDK's own default of ten minutes applies (verified in the
 * installed `openai` 7.50.0).
 */
export const OPENAI_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * What every call to the client carries: the caller's deadline, its abort signal and the retry
 * bound.
 */
export interface OpenAiCallOptions {
  timeout?: number;
  signal?: AbortSignal;
  maxRetries?: number;
}

/**
 * The parts of a response this file reads (AAP 0.5.6): `output_text` is absent only on a client that
 * reports no text at all. `status` and `incomplete_details` belong to the shape a stub returns and
 * are not read here — an incomplete reply arrives as empty text, which parses to no `json`.
 */
export interface OpenAiResponseSummary {
  output_text?: string | null;
  usage?: { input_tokens: number; output_tokens: number } | null;
  status?: string | null;
  incomplete_details?: unknown;
}

/**
 * The minimal structural shape of the SDK client this file calls, so a suite can inject a stub that
 * touches no network (`packages/server-core/test/unit/spend.test.ts`). The parameter types are the
 * SDK's own, so a real `OpenAI` instance is assignable — {@link OpenAiClientIsAssignable} holds the
 * compiler to that.
 */
export interface OpenAiResponsesClient {
  readonly responses: {
    create(
      body: ResponseCreateParamsNonStreaming,
      options?: OpenAiCallOptions,
    ): Promise<OpenAiResponseSummary>;
    readonly inputTokens: {
      count(
        body: InputTokenCountParams,
        options?: OpenAiCallOptions,
      ): Promise<{ input_tokens: number }>;
    };
  };
}

/** A compile-time assertion, used in the non-emitting form below. */
type AssertAssignable<Actual extends Expected, Expected> = Actual;

/** The assertion itself: it stops compiling the moment the SDK client no longer fits the shape above. */
export type OpenAiClientIsAssignable = AssertAssignable<OpenAI, OpenAiResponsesClient>;

/**
 * The one payload both calls are built from (AAP 0.5.6), in the fixed key order `model`,
 * `instructions`, `input`, `text`.
 */
export interface OpenAiResponsesPayload {
  model: string;
  instructions: string;
  input: { role: 'user' | 'assistant'; content: string }[];
  text?: {
    format: { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict: true };
  };
}

/**
 * Build the payload the provider counts and then sends (AAP 0.5.6): the count endpoint receives this
 * object unchanged and `create` receives it plus `max_output_tokens` and `store`, so the two payloads
 * differ in nothing else. SDK 7.50.0's `InputTokenCountParams` accepts `model`, `instructions`,
 * `input` and `text` and rejects those two generation-only keys, which is why the count gets the full
 * payload.
 *
 * `text` is omitted rather than set to `undefined` when no schema was asked for, because an explicit
 * `undefined` would change the object the count sees.
 *
 * @param request The request, already validated by the caller.
 * @param model The model id the payload names, which is the adapter's own.
 */
export function buildResponsesInput(request: LlmRequest, model: string): OpenAiResponsesPayload {
  const input = request.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const jsonSchema = request.jsonSchema;
  if (jsonSchema === undefined) {
    return { model, instructions: request.system, input };
  }
  return {
    model,
    instructions: request.system,
    input,
    text: {
      format: {
        type: 'json_schema',
        name: jsonSchema.name,
        schema: jsonSchema.schema,
        strict: true,
      },
    },
  };
}

/** What {@link createOpenAiAdapter} is given; `client` exists so a suite can inject a stub (AAP 0.11.2). */
export interface OpenAiAdapterOptions {
  apiKey: string;
  model: string;
  client?: OpenAiResponsesClient;
}

/**
 * Build the OpenAI adapter for `options.model` under the request profile (AAP 0.3.1, AAP 0.5.6).
 *
 * The client is built with `maxRetries: 0` and every call repeats it, so each reservation made from
 * {@link LlmAdapter.countInputTokens} covers exactly one sent request. It also carries
 * {@link OPENAI_DEFAULT_TIMEOUT_MS} as its own bounded deadline, so a call that omitted its per-call
 * option could not inherit the SDK's ten-minute default.
 *
 * @param options The API key, the model and an optional client, which suites inject.
 * @throws RangeError when `options.model` is outside {@link SUPPORTED_MODELS}. The message names the
 * model and never the key.
 */
export function createOpenAiAdapter(options: OpenAiAdapterOptions): LlmAdapter {
  const { model } = options;
  if (!isSupportedModel(model)) {
    throw new RangeError(`unsupported_llm_model: ${model}`);
  }
  const client: OpenAiResponsesClient =
    options.client ??
    new OpenAI({
      apiKey: options.apiKey,
      maxRetries: 0,
      timeout: OPENAI_DEFAULT_TIMEOUT_MS,
    });

  /**
   * The provider's own count for the payload `complete` would send (AAP 0.5.6); nothing is sent and
   * nothing is reserved by this call.
   *
   * @throws RangeError when `request.maxTokens` is below the provider's minimum; LlmCountError when
   * the count fails, times out or is not a count — an answer that is not a non-negative safe integer
   * `input_tokens` is `invalid_count` — in which case the request must not be sent.
   */
  async function countInputTokens(request: LlmRequest, call: LlmCallOptions): Promise<number> {
    assertLlmRequest(request);
    assertSendableOutputBound(request.maxTokens);
    const countRequest = buildResponsesInput(request, model);
    let counted: unknown;
    try {
      counted = await client.responses.inputTokens.count(countRequest, callOptions(call));
    } catch (error) {
      throw new LlmCountError(isTimeoutOrAbort(error) ? 'timeout' : 'provider', { cause: error });
    }
    const tokens = (counted as { input_tokens?: unknown } | null | undefined)?.input_tokens;
    if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) {
      throw new LlmCountError('invalid_count');
    }
    return tokens;
  }

  /**
   * Send the request once and return its reply (AAP 0.5.6); with `store: false` and no tools, no
   * response state outlives the call.
   *
   * @throws RangeError as above; LlmTimeoutError when the deadline elapses or the caller aborts, and
   * LlmProviderError on any other failure, a reply that carried no response body included. An
   * unreadable usage is not such a failure: it is reported as `null`, so the whole reservation is
   * charged. Tokens may have been consumed in either case.
   */
  async function complete(request: LlmRequest, call: LlmCallOptions): Promise<LlmResult> {
    assertLlmRequest(request);
    assertSendableOutputBound(request.maxTokens);
    const body: ResponseCreateParamsNonStreaming = {
      ...buildResponsesInput(request, model),
      max_output_tokens: request.maxTokens,
      store: false,
    };
    let sent: unknown;
    try {
      sent = await client.responses.create(body, callOptions(call));
    } catch (error) {
      throw providerError(error);
    }
    if (typeof sent !== 'object' || sent === null) {
      throw new LlmProviderError({ cause: new Error('llm_response_missing') });
    }
    const reply = sent as OpenAiResponseSummary;
    const text = typeof reply.output_text === 'string' ? reply.output_text : '';
    const usage = readUsage(reply.usage);
    return {
      text,
      json: request.jsonSchema === undefined ? null : parseJson(text),
      usage,
    };
  }

  return { provider: 'openai', model, countInputTokens, complete };
}

/**
 * The options one call carries: the caller's deadline, its abort signal where it has one, and
 * `maxRetries: 0` for the profile's one-reservation-one-request rule (AAP 0.5.6). The signal key is
 * omitted rather than set to `undefined`, which `exactOptionalPropertyTypes` refuses.
 */
function callOptions(call: LlmCallOptions): OpenAiCallOptions {
  return call.signal === undefined
    ? { timeout: call.timeoutMs, maxRetries: 0 }
    : { timeout: call.timeoutMs, signal: call.signal, maxRetries: 0 };
}

/**
 * Refuse a `maxTokens` the provider's own minimum would reject, so nothing is counted that the
 * `complete` call could not send (AAP 0.5.6). `assertLlmRequest` already required a safe integer.
 */
function assertSendableOutputBound(maxTokens: number): void {
  if (maxTokens < OPENAI_MIN_OUTPUT_TOKENS) {
    throw new RangeError(`request.maxTokens must be at least ${OPENAI_MIN_OUTPUT_TOKENS}`);
  }
}

/**
 * Whether a failure was the deadline elapsing or the caller's signal aborting it; `spend.ts` charges
 * the full reservation for both.
 */
function isTimeoutOrAbort(error: unknown): boolean {
  if (error instanceof APIConnectionTimeoutError || error instanceof APIUserAbortError) {
    return true;
  }
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Classify a failed `complete` (AAP 0.5.6): the deadline or the caller's abort, the provider's own
 * HTTP status, or anything else. Tokens may have been consumed in every case, which is why `spend.ts`
 * charges the full reservation.
 */
function providerError(error: unknown): LlmError {
  if (isTimeoutOrAbort(error)) {
    const aborted =
      error instanceof APIUserAbortError || (error instanceof Error && error.name === 'AbortError');
    return new LlmTimeoutError(aborted ? 'aborted' : 'timeout', { cause: error });
  }
  if (error instanceof APIError && typeof error.status === 'number') {
    return new LlmProviderError({ status: error.status, cause: error });
  }
  return new LlmProviderError({ cause: error });
}

/**
 * The reported usage as the contract's shape, or `null` when the provider reported none or reported
 * something that is not two numbers: an unreadable usage is no reported usage, so `spend.ts` charges
 * the whole reservation (AAP 0.5.6) instead of pricing a figure it cannot trust.
 *
 * Only the shape is checked. A number that is fractional or negative flows through as it stands,
 * because that is a reported figure `spend.ts` must see to classify it.
 */
function readUsage(usage: unknown): LlmUsage | null {
  if (typeof usage !== 'object' || usage === null) {
    return null;
  }
  const { input_tokens: inputTokens, output_tokens: outputTokens } = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
    return null;
  }
  return { inputTokens, outputTokens };
}

/**
 * The reply as data, or `null` when it did not parse: an empty or truncated reply, which is what a
 * response that hit its output cap looks like, is exactly this case (AAP 0.5.6). `spend.ts` charges
 * the request in full either way.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
