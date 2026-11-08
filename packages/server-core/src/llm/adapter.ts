/**
 * The facade over the provider-neutral language-model contract: {@link createLlmAdapter} builds the
 * adapter `config.provider` names, the one entry point its callers use (AAP 0.3.1, AAP 0.5.1). The
 * request, result and usage shapes and the error vocabulary the spend meter throws and catches live
 * in `contract.ts` and are re-exported here, so every caller keeps one import path and each class
 * keeps one definition.
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
import type { LlmAdapter } from './contract.ts';
import type { FakeLlmOptions } from './fake.ts';
import type { OpenAiResponsesClient } from './openai.ts';

// One direction only: this file imports the two provider factories, each provider and the spend
// meter import the shared vocabulary from `contract.ts`, and `contract.ts` imports nothing. No other
// module in this directory imports a provider, so the graph is acyclic and no load order can find an
// uninitialised binding. The contract's names are re-exported, never redeclared, so a caller keeps
// one import path and each error class keeps one identity, which is what `instanceof` needs.
export * from './contract.ts';

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
