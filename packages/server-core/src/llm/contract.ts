/**
 * The language-model contract shared by this directory: the request, result and usage shapes, the
 * error vocabulary the spend meter throws and catches, and the guard every provider runs before it
 * touches the wire (AAP 0.3.1, AAP 0.5.1).
 */

/** One message of the conversation sent to the provider (AAP 0.5.6). */
export interface LlmMessage {
  /** `'assistant'` replays an earlier turn of the same exchange; nothing else is sent as one. */
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A strict structured-output schema: the schema object under the name the provider registers it as.
 */
export interface LlmJsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

/**
 * One request: the payload {@link LlmAdapter.countInputTokens} counts, then {@link
 * LlmAdapter.complete} sends (AAP 0.5.6).
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
 * The provider's own token figures for one request (AAP 0.5.6); `spend.ts` compares the input count
 * it reports with the bound that was reserved.
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
 * The per-call bounds the caller owns: the voice relay gives a turn 3 s, shared by its count and
 * its classification, and menu extraction gives a request 60 s (AAP 0.11.1).
 */
export interface LlmCallOptions {
  /** The deadline for this call, counted by the provider itself rather than by a shared timer. */
  timeoutMs: number;
  /** Aborts the call: a relay connection that closed, or a job that was cancelled. */
  signal?: AbortSignal;
}

/** The providers {@link createLlmAdapter} can build (AAP 0.3.1). */
export type LlmProviderName = 'openai' | 'fake';

/** One provider behind the interface its callers know (AAP 0.3.1, AAP 0.5.1). */
export interface LlmAdapter {
  readonly provider: LlmProviderName;
  /** The provider's model identifier, the value `LLM_MODEL` selected. */
  readonly model: string;
  /**
   * The provider's authoritative input-token count for exactly the payload {@link
   * LlmAdapter.complete} would send, schema and message framing included; nothing is sent by this
   * call, and the count a response later reports is compared with it (AAP 0.5.6). @throws
   * LlmCountError on any failure or timeout, after which the request must not be sent.
   */
  countInputTokens(request: LlmRequest, options: LlmCallOptions): Promise<number>;
  /**
   * Send one request and return its reply. Exactly one request is sent, with no automatic retry,
   * because a retry reserves again against the city's cap and the caller decides whether to make
   * one. @throws LlmTimeoutError on timeout or abort, and LlmProviderError on any other failure.
   */
  complete(request: LlmRequest, options: LlmCallOptions): Promise<LlmResult>;
}

/** The code every language-model failure carries (AAP 0.5.6). */
export type LlmErrorCode =
  | 'llm_count_failed'
  | 'llm_timeout'
  | 'llm_provider_error'
  | 'llm_budget_refused'
  | 'llm_suspended';

/** The base of the language-model vocabulary, and the only place these codes are defined. */
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

/** The request's deadline elapsed, or its caller aborted it. */
export class LlmTimeoutError extends LlmError {
  readonly reason: LlmTimeoutReason;
  /** Set by `spend.ts` before it rethrows; an aborted turn's tokens may already be billed. */
  chargedMicros = 0;
  constructor(reason: LlmTimeoutReason, options?: ErrorOptions) {
    super('llm_timeout', `llm_timeout reason=${reason}`, options);
    this.reason = reason;
  }
}

/** The provider failed for a reason other than a timeout. */
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

/** The request's worst case does not fit the budget it was reserved against, so it was not sent. */
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
 * A reported count differed from the count that was reserved for, so language-model use is
 * suspended in every city until an operator re-enables it (AAP 0.5.6): the evidence that a
 * reservation bounds the spend no longer holds.
 */
export class LlmSuspendedError extends LlmError {
  constructor() {
    super('llm_suspended', 'llm_suspended');
  }
}

/** Validate the request both providers require before they touch the wire (AAP 0.5.6). */
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
