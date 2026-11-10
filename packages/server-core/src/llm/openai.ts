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
/** The models `LLM_MODEL` may name: each used text-only, billed per input and output token, supporting `text.format` `json_schema` structured outputs and the `POST /v1/responses/input_tokens` count this profile rests on. */
export const SUPPORTED_MODELS = ['gpt-4.1-mini', 'gpt-4.1', 'gpt-5-mini'] as const;
/** A model `LLM_MODEL` may name (AAP 0.5.6). */
export type SupportedModel = (typeof SUPPORTED_MODELS)[number];
/** Whether `model` is one of {@link SUPPORTED_MODELS}, narrowable to {@link SupportedModel}. */
export function isSupportedModel(model: string): model is SupportedModel {
  return (SUPPORTED_MODELS as readonly string[]).includes(model);
}
/** The provider's documented minimum for `max_output_tokens` on `POST /v1/responses`. */
export const OPENAI_MIN_OUTPUT_TOKENS = 16;
/** The client's own deadline for any call that does not pass one, standing at the ceiling for the language model: 3 s in calls and 60 s in extraction. */
export const OPENAI_DEFAULT_TIMEOUT_MS = 60_000;
/** What every call to the client carries: the caller's deadline, its abort signal and the retry bound. */
export interface OpenAiCallOptions {
  timeout?: number;
  signal?: AbortSignal;
  maxRetries?: number;
}
/** The parts of a response this file reads: `output_text` is absent only on a client that reports no text at all. */
export interface OpenAiResponseSummary {
  output_text?: string | null;
  usage?: { input_tokens: number; output_tokens: number } | null;
  status?: string | null;
  incomplete_details?: unknown;
}
/** The minimal structural shape of the SDK client this file calls, so a suite can inject a stub that touches no network. */
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
type AssertAssignable<Actual extends Expected, Expected> = Actual;
/** The assertion itself: it stops compiling the moment the SDK client no longer fits the shape above. */
export type OpenAiClientIsAssignable = AssertAssignable<OpenAI, OpenAiResponsesClient>;
/** The one payload both calls are built from (AAP 0.5.6), in the fixed key order `model`, `instructions`, `input`, `text`. */
export interface OpenAiResponsesPayload {
  model: string;
  instructions: string;
  input: { role: 'user' | 'assistant'; content: string }[];
  text?: {
    format: { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict: true };
  };
}
/** Build the payload the provider counts and then sends (AAP 0.5.6): the count endpoint receives this object unchanged and `create` receives it plus `max_output_tokens` and `store`, so the two payloads differ in nothing else. */
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
/** Build the OpenAI adapter for `options.model` under the request profile (AAP 0.3.1, AAP 0.5.6). */
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
  /** The provider's own count for the payload `complete` would send (AAP 0.5.6); nothing is sent and nothing is reserved by this call. @throws RangeError when `request.maxTokens` is below the provider's minimum, and LlmCountError when the count fails, times out or is not a count, in which case the request must not be sent. */
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
  /** Send the request once and return its reply (AAP 0.5.6); with `store: false` and no tools, no response state outlives the call. @throws LlmTimeoutError when the deadline elapses or the caller aborts, and LlmProviderError on any other failure. An unreadable usage is not such a failure: it is reported as `null`, so the whole reservation is charged, because tokens may have been consumed either way. */
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
function callOptions(call: LlmCallOptions): OpenAiCallOptions {
  return call.signal === undefined
    ? { timeout: call.timeoutMs, maxRetries: 0 }
    : { timeout: call.timeoutMs, signal: call.signal, maxRetries: 0 };
}
function assertSendableOutputBound(maxTokens: number): void {
  if (maxTokens < OPENAI_MIN_OUTPUT_TOKENS) {
    throw new RangeError(`request.maxTokens must be at least ${OPENAI_MIN_OUTPUT_TOKENS}`);
  }
}
function isTimeoutOrAbort(error: unknown): boolean {
  if (error instanceof APIConnectionTimeoutError || error instanceof APIUserAbortError) {
    return true;
  }
  return error instanceof Error && error.name === 'AbortError';
}
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
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
