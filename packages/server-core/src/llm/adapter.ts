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
 * OpenAI provider, or scripted options for the fake one.
 */
export interface LlmAdapterDeps {
  openaiClient?: OpenAiResponsesClient;
  fake?: FakeLlmOptions;
}

/** Build the adapter `config.provider` names, the one entry point its callers use (AAP 0.3.1). */
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
