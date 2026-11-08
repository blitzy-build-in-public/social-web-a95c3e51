/**
 * The deterministic language-model provider `LLM_PROVIDER=fake` selects: no network, no credential
 * and no environment read, so the default compose stack and every automated suite run with no
 * provider configured (AAP 0.3.1, AAP 0.3.3, AAP 0.6.2).
 *
 * It answers the same count-then-send contract as the real provider — a count for exactly the payload
 * a send would carry, and usage that `spend.ts` reconciles against the reservation — so the per-city
 * cap is exercised in tests and in `demo` rather than bypassed (AAP 0.5.6). Counting UTF-8 bytes
 * rather than characters makes Thai, Indonesian, emoji and base64-like content count high, the way a
 * real tokenizer counts them.
 *
 * The graph runs one way here: the shared vocabulary — the error classes and `assertLlmRequest` —
 * comes from `contract.ts`, which imports nothing, and `adapter.ts` imports this file's factory.
 * Nothing in this file imports `adapter.ts`, so no load order can meet an uninitialised binding.
 */

import { utf8ByteLength } from '@tablemate/shared';

import type { LlmAdapter, LlmCallOptions, LlmRequest, LlmResult } from './contract.ts';
import { LlmCountError, LlmProviderError, LlmTimeoutError, assertLlmRequest } from './contract.ts';

/**
 * The scripted behaviour of one fake adapter, read at call time so a suite can build the scenarios
 * it needs — `prices-high`, `yes`, `no` and the cap cases — without a mutation API (AAP 0.5.6).
 */
export interface FakeLlmOptions {
  /**
   * The structured output to return. The default returns `{}`, which callers treat as unusable: menu
   * extraction yields no items and falls back to a call, and the voice classifier reads `unclear`.
   */
  respond?: (request: LlmRequest) => unknown;
  /** Makes {@link LlmAdapter.countInputTokens} throw `LlmCountError`, so the request is never sent. */
  failCount?: boolean;
  /** Makes {@link LlmAdapter.complete} throw `LlmProviderError` after recording the send. */
  failComplete?: boolean;
  /** Added to the reported input tokens, so a suite can trigger the `llm_count_mismatch` path. */
  reportedInputDelta?: number;
  /** The output tokens to report. Default 1. */
  outputTokens?: number;
  /** How long `complete` takes, used to exercise `LlmTimeoutError` against the caller's timeout. */
  delayMs?: number;
  /** Default true; `false` returns `usage: null`, which makes `spend.ts` charge the reservation. */
  reportUsage?: boolean;
}

/**
 * The fake adapter plus the record of what it was asked to do: `counted` holds the serialized input
 * part of every count attempted, `sent` that of every send attempted. A suite asserts the two are
 * byte-identical for one request, and that a refused request appears in `counted` and never in
 * `sent` (AAP 0.5.6).
 */
export interface FakeLlmAdapter extends LlmAdapter {
  readonly calls: { readonly counted: string[]; readonly sent: string[] };
}

/**
 * The provider-neutral input part of one request — the system prompt, the messages and the output
 * schema, in a fixed key order — which is what a count and a send must agree on byte for byte
 * (AAP 0.5.6).
 */
export function serializeFakeInputPart(request: LlmRequest): string {
  return JSON.stringify({
    system: request.system,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
    jsonSchema: request.jsonSchema ?? null,
  });
}

/**
 * The fake provider's prices in USD per million tokens, matching the `llm` group `src/env/modes.ts`
 * parses in fake mode. They are non-secret decimal strings, positive and at most six decimals, which
 * is what `parseUsdPerMTok` requires, so the per-city cap keeps metering in tests and in `demo`
 * (AAP 0.5.6).
 */
export const FAKE_LLM_PRICES = Object.freeze({
  inputUsdPerMTok: '0.40',
  outputUsdPerMTok: '1.60',
} as const);

/** The reply of an unscripted request: usable JSON, no items, no classification. */
function defaultRespond(): unknown {
  return {};
}

/** JSON text for a scripted value; a value JSON cannot carry becomes empty text. */
function serializedText(value: unknown): string {
  const text: unknown = JSON.stringify(value);
  return typeof text === 'string' ? text : '';
}

/** Parsed structured output, or `null` where the scripted text was not JSON. */
function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The fake tokenizer: four UTF-8 bytes per token, rounded up, over the input part alone. */
function countTokens(part: string): number {
  return Math.ceil(utf8ByteLength(part) / 4);
}

/** Sleep for `ms`, rejecting with `LlmTimeoutError` if the caller aborts meanwhile. */
function waitForDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LlmTimeoutError('aborted'));
    };
    // An abort that arrived before the listener was registered would otherwise go unnoticed.
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Build the provider `LLM_PROVIDER=fake` names (AAP 0.3.1, AAP 0.5.6). It is deterministic: the same
 * request always produces the same count, the same reply and the same reported usage, so a suite can
 * assert an exact spend figure.
 */
export function createFakeLlmAdapter(options: FakeLlmOptions = {}): FakeLlmAdapter {
  const counted: string[] = [];
  const sent: string[] = [];

  return {
    provider: 'fake',
    model: 'fake',
    calls: { counted, sent },

    async countInputTokens(request: LlmRequest, call: LlmCallOptions): Promise<number> {
      assertLlmRequest(request);
      const part = serializeFakeInputPart(request);
      counted.push(part);
      if (options.failCount === true) {
        throw new LlmCountError('provider');
      }
      if (call.signal?.aborted === true) {
        throw new LlmCountError('timeout');
      }
      // The fake counts locally while a real provider makes a round trip, so one microtask of
      // yielding keeps the answer asynchronous for callers, as the interface's promise says.
      await Promise.resolve();
      return countTokens(part);
    },

    async complete(request: LlmRequest, call: LlmCallOptions): Promise<LlmResult> {
      assertLlmRequest(request);
      const part = serializeFakeInputPart(request);
      // Recorded before anything can fail: a sent request's tokens may already be billed.
      sent.push(part);
      // Checked before the scripted delay rather than only inside it: an abort must settle the call
      // whatever `delayMs` is, and answer one aborted signal exactly as `countInputTokens` does.
      if (call.signal?.aborted === true) {
        throw new LlmTimeoutError('aborted');
      }

      const delayMs = options.delayMs ?? 0;
      if (delayMs > 0) {
        await waitForDelay(Math.min(delayMs, call.timeoutMs), call.signal);
        if (delayMs >= call.timeoutMs) {
          throw new LlmTimeoutError('timeout');
        }
      }
      if (options.failComplete === true) {
        throw new LlmProviderError();
      }

      const value = (options.respond ?? defaultRespond)(request);
      const text = typeof value === 'string' ? value : serializedText(value);
      const json =
        request.jsonSchema === undefined
          ? null
          : typeof value === 'string'
            ? parseJsonOrNull(value)
            : value;

      return {
        text,
        json,
        usage:
          options.reportUsage === false
            ? null
            : {
                // The count's own formula, so a reported count with no delta equals the count.
                inputTokens: countTokens(part) + (options.reportedInputDelta ?? 0),
                outputTokens: Math.min(options.outputTokens ?? 1, request.maxTokens),
              },
      };
    },
  };
}
