/**
 * The three mode groups of the scoped environment schemas, with the guards that decide which
 * credentials each mode needs (AAP 0.6.2).
 *
 * `STRIPE_MODE`, `TELEPHONY_MODE` and `LLM_PROVIDER` name a deployment's posture, and AAP 0.6.2
 * requires that a mode "needs credentials only when it reaches a real provider": `mock`, `off` and
 * `fake` reach none, so `docker compose up` starts with no credential at all, while `test`, `live`,
 * `simulator`, `twilio` and `openai` demand exactly the variables they use. Each group is a raw Zod
 * shape `./api.ts` and `./workers.ts` spread into their schema, a guard over the normalized
 * environment, and a builder that turns the parsed values into the discriminant its consumer takes.
 *
 * Guards follow `EnvGuard` in `./common.ts`: they read the normalized raw view, so one still runs when
 * a field of another group failed; they return findings and never throw; and every reason is a fixed
 * string naming a variable, never a value, a prefix or a length of one (AAP 0.12.2). A builder runs
 * only once the shape and the guards accepted the environment.
 */

import { E164, type AppEnv } from '@tablemate/shared';

import { FAKE_LLM_PRICES } from '../llm/fake.ts';
import { SUPPORTED_MODELS, isSupportedModel, type SupportedModel } from '../llm/openai.ts';
import { parseUsdPerMTok, type LlmPrices } from '../llm/spend.ts';
import { TWILIO_SIMULATOR } from '../telephony/twilio-client.ts';
import {
  envEnum,
  envString,
  envUrl,
  type EnvIssue,
  type EnvLlmProvider,
  type EnvProcess,
  type EnvTelephonyMode,
  type NormalizedEnv,
} from './common.ts';

/** The processes that hold a mode reaching a provider (AAP 0.3.2). The seed reaches none. */
export type EnvProviderProcess = Exclude<EnvProcess, 'seed'>;

/** The one `APP_ENV` whose processes may hold real credentials (AAP 0.6.2). */
const PRODUCTION: AppEnv = 'production';

/** What an absent variable a mode's guard required reports, in the wording of `./common.ts`. */
const REQUIRED_REASON = 'is required';

/** The prefix every Stripe key must carry outside production (AAP 0.3.3). */
const TEST_KEY_PREFIX = 'sk_test_';

/** Why an `LLM_MODEL` outside {@link SUPPORTED_MODELS} is refused (AAP 0.5.6). */
const MODEL_REASON = `must be one of ${SUPPORTED_MODELS.join('|')}`;

/** Why a price {@link parseUsdPerMTok} rejects is refused (AAP 0.5.6). */
const PRICE_REASON = 'must be a positive decimal with at most 6 fraction digits';

/** Why a `CALL_ALLOWLIST` a non-production `workers` mode needs is refused (AAP 0.6.2). */
const ALLOWLIST_REASON =
  'must list at least one operator-owned E.164 number when TELEPHONY_MODE=twilio outside production';

/** Why a value that is not an E.164 number is refused, in the vocabulary of `packages/shared`. */
const E164_REASON = 'must be an E.164 number';

/** Whether `env` carries a value for `variable`: `./common.ts` already drops empty strings. */
function hasValue(env: NormalizedEnv, variable: string): boolean {
  return env[variable] !== undefined;
}

/**
 * Read a variable a mode's guard already required. {@link loadEnvironment} runs the guards before the
 * builder, so an absent value here means a builder was called without its guards: a programming error
 * rather than a start path, and one that must refuse rather than pass an empty credential on.
 */
function present(value: string | undefined, variable: string): string {
  if (value === undefined) {
    throw new RangeError(`${variable} ${REQUIRED_REASON}`);
  }
  return value;
}

/** Whether `value` is an E.164 number, the rule the shared schema states (AAP 0.6.2). */
function isE164Number(value: string): boolean {
  return E164.safeParse(value).success;
}

/** Whether a `CALL_ALLOWLIST` value holds at least one entry; entry format is `parseAllowlist`'s. */
function hasAllowlistEntry(csv: string | undefined): boolean {
  return csv !== undefined && csv.split(',').some((entry) => entry.trim() !== '');
}

/**
 * Whether {@link parseUsdPerMTok} accepts `value`. A `RangeError` is that function's own refusal of a
 * malformed price; anything else is a bug that must not be reported as an environment problem.
 */
function isUsablePrice(value: string): boolean {
  try {
    parseUsdPerMTok(value);
    return true;
  } catch (error) {
    if (error instanceof RangeError) {
      return false;
    }
    throw error;
  }
}

/** The `STRIPE_MODE` values the workspace supports, declared by `api` alone (AAP 0.6.2, 0.3.2). */
export const ENV_STRIPE_MODES = ['mock', 'test', 'live'] as const;

/** One of {@link ENV_STRIPE_MODES}; the discriminant of {@link EnvStripeConfig}. */
export type EnvStripeMode = (typeof ENV_STRIPE_MODES)[number];

/**
 * The fixed, non-secret values `mock` mode uses in place of keys (AAP 0.6.2: "the gateway uses fixed
 * non-secret placeholders and no real key"). Each is too short to match a credential shape the secret
 * scan looks for, so it may stand in tracked source, and `apps/api/test/support/stripe-proxy` signs
 * mock webhooks with `webhookSecret`.
 */
export const STRIPE_MOCK_PLACEHOLDERS = Object.freeze({
  secretKey: 'sk_test_mock',
  publishableKey: 'pk_test_mock',
  webhookSecret: 'whsec_mock',
} as const);

/**
 * The Stripe variables `api` declares (AAP 0.6.2). `STRIPE_MODE` has no default, so the guard of the
 * mode it names decides the rest: `STRIPE_API_BASE` is the stateful `stripe-proxy` that `mock` reaches,
 * and the three keys are what `test` and `live` require. `STRIPE_MOCK_UPSTREAM` is deliberately absent:
 * only the proxy itself reads it.
 */
export const STRIPE_ENV_SHAPE = {
  STRIPE_MODE: envEnum(ENV_STRIPE_MODES),
  STRIPE_API_BASE: envUrl({ protocols: ['http:', 'https:'], optional: true }),
  STRIPE_SECRET_KEY: envString({ optional: true }),
  STRIPE_PUBLISHABLE_KEY: envString({ optional: true }),
  STRIPE_WEBHOOK_SECRET: envString({ optional: true }),
} as const;

/** The parsed Stripe variables {@link buildStripe} reads (AAP 0.6.2). */
export interface StripeEnvValues {
  readonly STRIPE_MODE: EnvStripeMode;
  readonly STRIPE_API_BASE?: string | undefined;
  readonly STRIPE_SECRET_KEY?: string | undefined;
  readonly STRIPE_PUBLISHABLE_KEY?: string | undefined;
  readonly STRIPE_WEBHOOK_SECRET?: string | undefined;
}

/** The variables `test` and `live` modes require (AAP 0.6.2). */
const STRIPE_CREDENTIAL_VARIABLES = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
] as const;

/**
 * Report what the configured `STRIPE_MODE` requires and forbids (AAP 0.6.2, 0.3.3, 0.12.2).
 *
 * The key-prefix rule holds in every mode: a key that is not a test key is refused outside production
 * (AAP 0.3.3), and `test` mode accepts nothing else in production either, while `live` mode under
 * production is exactly where a live key belongs. `mock` requires only `STRIPE_API_BASE`, so the
 * credential-free default stack starts with no key at all. A `STRIPE_MODE` outside
 * {@link ENV_STRIPE_MODES} is the shape's own finding and is left alone here.
 *
 * @param env - the normalized environment, complete whether or not a field parse failed.
 */
export function stripeIssues(env: NormalizedEnv): EnvIssue[] {
  const issues: EnvIssue[] = [];
  const mode = env.STRIPE_MODE;
  const secretKey = env.STRIPE_SECRET_KEY;
  if (secretKey !== undefined && !secretKey.startsWith(TEST_KEY_PREFIX)) {
    if (env.APP_ENV !== PRODUCTION) {
      issues.push({
        variable: 'STRIPE_SECRET_KEY',
        reason: `must start with ${TEST_KEY_PREFIX} outside production`,
      });
    } else if (mode === 'test') {
      issues.push({
        variable: 'STRIPE_SECRET_KEY',
        reason: `must start with ${TEST_KEY_PREFIX} when STRIPE_MODE=test`,
      });
    }
  }
  if (mode === 'mock') {
    if (!hasValue(env, 'STRIPE_API_BASE')) {
      issues.push({ variable: 'STRIPE_API_BASE', reason: 'is required when STRIPE_MODE=mock' });
    }
    return issues;
  }
  if (mode === 'test' || mode === 'live') {
    if (mode === 'live' && env.APP_ENV !== PRODUCTION) {
      issues.push({
        variable: 'STRIPE_MODE',
        reason: 'live is accepted only when APP_ENV=production',
      });
    }
    for (const variable of STRIPE_CREDENTIAL_VARIABLES) {
      if (!hasValue(env, variable)) {
        issues.push({ variable, reason: REQUIRED_REASON });
      }
    }
  }
  return issues;
}

/**
 * What the API's payment gateway is configured with (AAP 0.6.2): the proxy URL and the placeholders
 * for `mock`, the three real-mode values for `test` and `live`, whose environment has already been
 * decided to be a production one when the mode is `live`.
 */
export type EnvStripeConfig =
  | {
      readonly mode: 'mock';
      readonly apiBase: string;
      readonly secretKey: string;
      readonly publishableKey: string;
      readonly webhookSecret: string;
    }
  | {
      readonly mode: 'test' | 'live';
      readonly secretKey: string;
      readonly publishableKey: string;
      readonly webhookSecret: string;
    };

/**
 * Build the Stripe configuration `values.STRIPE_MODE` names (AAP 0.6.2). Called by `./api.ts` once
 * {@link stripeIssues} accepted the environment, so `mock` substitutes
 * {@link STRIPE_MOCK_PLACEHOLDERS} rather than reading keys that must not exist.
 */
export function buildStripe(values: StripeEnvValues): EnvStripeConfig {
  if (values.STRIPE_MODE === 'mock') {
    return {
      mode: 'mock',
      apiBase: present(values.STRIPE_API_BASE, 'STRIPE_API_BASE'),
      secretKey: STRIPE_MOCK_PLACEHOLDERS.secretKey,
      publishableKey: STRIPE_MOCK_PLACEHOLDERS.publishableKey,
      webhookSecret: STRIPE_MOCK_PLACEHOLDERS.webhookSecret,
    };
  }
  return {
    mode: values.STRIPE_MODE,
    secretKey: present(values.STRIPE_SECRET_KEY, 'STRIPE_SECRET_KEY'),
    publishableKey: present(values.STRIPE_PUBLISHABLE_KEY, 'STRIPE_PUBLISHABLE_KEY'),
    webhookSecret: present(values.STRIPE_WEBHOOK_SECRET, 'STRIPE_WEBHOOK_SECRET'),
  };
}

/** The API's telephony variables: it validates signatures and dials nothing, so it needs no number. */
const API_TELEPHONY_ENV_SHAPE = {
  TWILIO_ACCOUNT_SID: envString({ optional: true }),
  TWILIO_AUTH_TOKEN: envString({ optional: true }),
} as const;

/** The workers' telephony variables: the caller id it dials from and the simulator it may reach. */
const WORKERS_TELEPHONY_ENV_SHAPE = {
  TWILIO_ACCOUNT_SID: envString({ optional: true }),
  TWILIO_AUTH_TOKEN: envString({ optional: true }),
  TWILIO_FROM_NUMBER: envString({
    optional: true,
    check: { test: isE164Number, reason: E164_REASON },
  }),
  VOICE_SIM_URL: envUrl({ protocols: ['http:', 'https:'], optional: true }),
} as const;

/** The API's telephony variable set, as {@link telephonyEnvShape} returns it for `'api'`. */
export type ApiTelephonyEnvShape = typeof API_TELEPHONY_ENV_SHAPE;

/** The workers' telephony variable set, as {@link telephonyEnvShape} returns it for `'workers'`. */
export type WorkersTelephonyEnvShape = typeof WORKERS_TELEPHONY_ENV_SHAPE;

/**
 * The telephony variables one process declares (AAP 0.6.2). The API neither declares nor requires
 * `VOICE_SIM_URL` or `TWILIO_FROM_NUMBER`: it runs simulator mode only to validate signatures, and the
 * number a call dials from belongs to the process that dials. The overloads give each process its own
 * set, so a schema composed for the API cannot require the workers' variables.
 */
export function telephonyEnvShape(process: 'api'): ApiTelephonyEnvShape;
export function telephonyEnvShape(process: 'workers'): WorkersTelephonyEnvShape;
export function telephonyEnvShape(
  process: EnvProviderProcess,
): ApiTelephonyEnvShape | WorkersTelephonyEnvShape;
export function telephonyEnvShape(
  process: EnvProviderProcess,
): ApiTelephonyEnvShape | WorkersTelephonyEnvShape {
  return process === 'api' ? API_TELEPHONY_ENV_SHAPE : WORKERS_TELEPHONY_ENV_SHAPE;
}

/** The parsed telephony variables {@link buildTelephony} reads, whichever set the process declared. */
export interface TelephonyEnvValues {
  readonly TELEPHONY_MODE: EnvTelephonyMode;
  readonly TWILIO_ACCOUNT_SID?: string | undefined;
  readonly TWILIO_AUTH_TOKEN?: string | undefined;
  readonly TWILIO_FROM_NUMBER?: string | undefined;
  readonly VOICE_SIM_URL?: string | undefined;
}

/** The Twilio credentials both processes need in `twilio` mode (AAP 0.6.2). */
const TWILIO_CREDENTIAL_VARIABLES = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] as const;

/**
 * Report what the configured `TELEPHONY_MODE` requires of `process` (AAP 0.6.2, 0.11.2).
 *
 * `off` needs nothing and is the `demo` default: `call-dispatch` is not scheduled and every task stays
 * `queued`. `simulator` needs the scripted simulator's URL, which only `workers` dials; both processes
 * take that mode's credentials from {@link TWILIO_SIMULATOR}, so no variable carries them. `twilio`
 * needs both credentials everywhere and, for `workers`, the caller id and — outside production — at
 * least one allowlisted number, which is what keeps an automated call on a host an operator owns
 * (AAP 0.6.2, 0.12.2). Production calls stay blocked until `CALLS_PRODUCTION_APPROVED=true`, which
 * `../telephony/allowlist.ts` enforces per call rather than at startup. A `TELEPHONY_MODE` outside
 * `ENV_TELEPHONY_MODES` is the common shape's finding and is left alone here.
 *
 * @param env - the normalized environment, complete whether or not a field parse failed.
 * @param process - the process being configured, which decides the caller-id and allowlist rules.
 */
export function telephonyIssues(env: NormalizedEnv, process: EnvProviderProcess): EnvIssue[] {
  const mode = env.TELEPHONY_MODE;
  if (mode === 'simulator') {
    return process === 'workers' && !hasValue(env, 'VOICE_SIM_URL')
      ? [{ variable: 'VOICE_SIM_URL', reason: 'is required when TELEPHONY_MODE=simulator' }]
      : [];
  }
  if (mode !== 'twilio') {
    return [];
  }
  const issues: EnvIssue[] = [];
  for (const variable of TWILIO_CREDENTIAL_VARIABLES) {
    if (!hasValue(env, variable)) {
      issues.push({ variable, reason: REQUIRED_REASON });
    }
  }
  if (process === 'workers') {
    if (!hasValue(env, 'TWILIO_FROM_NUMBER')) {
      issues.push({ variable: 'TWILIO_FROM_NUMBER', reason: REQUIRED_REASON });
    }
    if (env.APP_ENV !== PRODUCTION && !hasAllowlistEntry(env.CALL_ALLOWLIST)) {
      issues.push({ variable: 'CALL_ALLOWLIST', reason: ALLOWLIST_REASON });
    }
  }
  return issues;
}

/**
 * What a process's telephony client is configured with (AAP 0.6.2). The `simulator` and `twilio`
 * variants are what `createTelephonyClient` in `../telephony/twilio-client.ts` takes: the simulator's
 * credentials and caller id come from {@link TWILIO_SIMULATOR}, and `simulatorUrl` and the `twilio`
 * caller id are present only for the process that uses them.
 */
export type EnvTelephonyConfig =
  | { readonly mode: 'off' }
  | {
      readonly mode: 'simulator';
      readonly accountSid: string;
      readonly authToken: string;
      readonly fromNumber: string;
      readonly simulatorUrl?: string;
    }
  | {
      readonly mode: 'twilio';
      readonly accountSid: string;
      readonly authToken: string;
      readonly fromNumber?: string;
    };

/**
 * Build the telephony configuration `values.TELEPHONY_MODE` names for `process` (AAP 0.6.2). Called by
 * `./api.ts` and `./workers.ts` once {@link telephonyIssues} accepted the environment; `off` carries
 * nothing, because reaching no provider must need no configuration at all.
 */
export function buildTelephony(
  values: TelephonyEnvValues,
  process: EnvProviderProcess,
): EnvTelephonyConfig {
  if (values.TELEPHONY_MODE === 'off') {
    return { mode: 'off' };
  }
  if (values.TELEPHONY_MODE === 'simulator') {
    const simulator = {
      mode: 'simulator',
      accountSid: TWILIO_SIMULATOR.accountSid,
      authToken: TWILIO_SIMULATOR.authToken,
      fromNumber: TWILIO_SIMULATOR.fromNumber,
    } as const;
    return process === 'workers'
      ? { ...simulator, simulatorUrl: present(values.VOICE_SIM_URL, 'VOICE_SIM_URL') }
      : simulator;
  }
  const accountSid = present(values.TWILIO_ACCOUNT_SID, 'TWILIO_ACCOUNT_SID');
  const authToken = present(values.TWILIO_AUTH_TOKEN, 'TWILIO_AUTH_TOKEN');
  return process === 'workers'
    ? {
        mode: 'twilio',
        accountSid,
        authToken,
        fromNumber: present(values.TWILIO_FROM_NUMBER, 'TWILIO_FROM_NUMBER'),
      }
    : { mode: 'twilio', accountSid, authToken };
}

/**
 * The language-model variables both processes declare (AAP 0.6.2), every one optional here: the
 * `fake` provider needs none, and a real provider needs all four, as {@link llmIssues} states.
 */
export const LLM_ENV_SHAPE = {
  LLM_API_KEY: envString({ optional: true }),
  LLM_MODEL: envString({ optional: true }),
  LLM_PRICE_INPUT_USD_PER_MTOK: envString({ optional: true }),
  LLM_PRICE_OUTPUT_USD_PER_MTOK: envString({ optional: true }),
} as const;

/** The parsed language-model variables {@link buildLlm} reads (AAP 0.6.2). */
export interface LlmEnvValues {
  readonly LLM_PROVIDER: EnvLlmProvider;
  readonly LLM_API_KEY?: string | undefined;
  readonly LLM_MODEL?: string | undefined;
  readonly LLM_PRICE_INPUT_USD_PER_MTOK?: string | undefined;
  readonly LLM_PRICE_OUTPUT_USD_PER_MTOK?: string | undefined;
}

/** The variables a real provider requires (AAP 0.6.2, 0.5.6). */
const LLM_VARIABLES = [
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_PRICE_INPUT_USD_PER_MTOK',
  'LLM_PRICE_OUTPUT_USD_PER_MTOK',
] as const;

/** The two variables that must parse as USD per million tokens (AAP 0.5.6). */
const LLM_PRICE_VARIABLES = [
  'LLM_PRICE_INPUT_USD_PER_MTOK',
  'LLM_PRICE_OUTPUT_USD_PER_MTOK',
] as const;

/**
 * Report what the configured `LLM_PROVIDER` requires (AAP 0.5.6, 0.6.2).
 *
 * `fake` needs nothing, which is what lets the automated suite and the `demo` stack run without a key.
 * `openai` needs the key, the model and both prices, and the model must be one of
 * {@link SUPPORTED_MODELS}: AAP 0.5.6 rests the per-city spend cap on that model profile's
 * authoritative input-token count and its per-token billing, so any other value "makes the process
 * refuse to start", and the reason names only the supported list and never the value supplied. Both
 * prices go through {@link parseUsdPerMTok}, the function the spend meter parses them with, so a price
 * that could not be charged fails startup rather than a request.
 *
 * @param env - the normalized environment, complete whether or not a field parse failed.
 */
export function llmIssues(env: NormalizedEnv): EnvIssue[] {
  if (env.LLM_PROVIDER !== 'openai') {
    return [];
  }
  const issues: EnvIssue[] = [];
  for (const variable of LLM_VARIABLES) {
    if (!hasValue(env, variable)) {
      issues.push({ variable, reason: REQUIRED_REASON });
    }
  }
  const model = env.LLM_MODEL;
  if (model !== undefined && !isSupportedModel(model)) {
    issues.push({ variable: 'LLM_MODEL', reason: MODEL_REASON });
  }
  for (const variable of LLM_PRICE_VARIABLES) {
    const value = env[variable];
    if (value !== undefined && !isUsablePrice(value)) {
      issues.push({ variable, reason: PRICE_REASON });
    }
  }
  return issues;
}

/**
 * What the language-model adapter and the spend meter are configured with (AAP 0.5.6, 0.6.2). The
 * `fake` variant carries {@link FAKE_LLM_PRICES} so the per-city cap keeps metering in tests and in
 * `demo`; the `openai` variant carries the validated price strings exactly as the environment holds
 * them, which is what `createLlmSpend` parses. Both are assignable to `createLlmAdapter`'s
 * configuration in `../llm/adapter.ts`, which reads `provider`, `apiKey` and `model`.
 */
export type EnvLlmConfig =
  | { readonly provider: 'fake'; readonly prices: LlmPrices }
  | {
      readonly provider: 'openai';
      readonly apiKey: string;
      readonly model: SupportedModel;
      readonly prices: LlmPrices;
    };

/**
 * Build the language-model configuration `values.LLM_PROVIDER` names (AAP 0.5.6, 0.6.2). Called by
 * `./api.ts` and `./workers.ts` once {@link llmIssues} accepted the environment.
 *
 * @throws RangeError when a value a guard required is absent or the model is unsupported, which can
 *   only happen if this is called without {@link llmIssues}.
 */
export function buildLlm(values: LlmEnvValues): EnvLlmConfig {
  if (values.LLM_PROVIDER === 'fake') {
    return { provider: 'fake', prices: FAKE_LLM_PRICES };
  }
  const model = present(values.LLM_MODEL, 'LLM_MODEL');
  if (!isSupportedModel(model)) {
    throw new RangeError(`LLM_MODEL ${MODEL_REASON}`);
  }
  return {
    provider: 'openai',
    apiKey: present(values.LLM_API_KEY, 'LLM_API_KEY'),
    model,
    prices: {
      inputUsdPerMTok: present(values.LLM_PRICE_INPUT_USD_PER_MTOK, 'LLM_PRICE_INPUT_USD_PER_MTOK'),
      outputUsdPerMTok: present(
        values.LLM_PRICE_OUTPUT_USD_PER_MTOK,
        'LLM_PRICE_OUTPUT_USD_PER_MTOK',
      ),
    },
  };
}
