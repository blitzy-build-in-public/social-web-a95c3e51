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

/** The processes that hold a mode reaching a provider (AAP 0.3.2). */
export type EnvProviderProcess = Exclude<EnvProcess, 'seed'>;

const PRODUCTION: AppEnv = 'production';

const REQUIRED_REASON = 'is required';

const TEST_KEY_PREFIX = 'sk_test_';

const MODEL_REASON = `must be one of ${SUPPORTED_MODELS.join('|')}`;

const PRICE_REASON = 'must be a positive decimal with at most 6 fraction digits';

const ALLOWLIST_REASON =
  'must list at least one operator-owned E.164 number when TELEPHONY_MODE=twilio outside production';

const E164_REASON = 'must be an E.164 number';

function hasValue(env: NormalizedEnv, variable: string): boolean {
  return env[variable] !== undefined;
}

function present(value: string | undefined, variable: string): string {
  if (value === undefined) {
    throw new RangeError(`${variable} ${REQUIRED_REASON}`);
  }
  return value;
}

function isE164Number(value: string): boolean {
  return E164.safeParse(value).success;
}

function hasAllowlistEntry(csv: string | undefined): boolean {
  return csv !== undefined && csv.split(',').some((entry) => entry.trim() !== '');
}

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
 * The fixed, non-secret values `mock` mode uses in place of keys (AAP 0.6.2: "the gateway uses
 * fixed non-secret placeholders and no real key").
 */
export const STRIPE_MOCK_PLACEHOLDERS = Object.freeze({
  secretKey: 'sk_test_mock',
  publishableKey: 'pk_test_mock',
  webhookSecret: 'whsec_mock',
} as const);

/** The Stripe variables `api` declares (AAP 0.6.2). */
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

const STRIPE_CREDENTIAL_VARIABLES = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
] as const;

/** Report what the configured `STRIPE_MODE` requires and forbids (AAP 0.6.2, 0.3.3, 0.12.2). */
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
  } else if (secretKey !== undefined && env.APP_ENV === PRODUCTION && mode === 'live') {
    issues.push({
      variable: 'STRIPE_SECRET_KEY',
      reason: 'must be a live key when STRIPE_MODE=live',
    });
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
 * for `mock`, the three real-mode values for `test` and `live`, whose environment {@link
 * stripeIssues} has already accepted.
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

/** Build the Stripe configuration `values.STRIPE_MODE` names (AAP 0.6.2). */
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

const API_TELEPHONY_ENV_SHAPE = {
  TWILIO_ACCOUNT_SID: envString({ optional: true }),
  TWILIO_AUTH_TOKEN: envString({ optional: true }),
} as const;

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

/** The telephony variables one process declares (AAP 0.6.2). */
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

/**
 * The parsed telephony variables {@link buildTelephony} reads, whichever set the process declared.
 */
export interface TelephonyEnvValues {
  readonly TELEPHONY_MODE: EnvTelephonyMode;
  readonly TWILIO_ACCOUNT_SID?: string | undefined;
  readonly TWILIO_AUTH_TOKEN?: string | undefined;
  readonly TWILIO_FROM_NUMBER?: string | undefined;
  readonly VOICE_SIM_URL?: string | undefined;
}

const TWILIO_CREDENTIAL_VARIABLES = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] as const;

/** Report what the configured `TELEPHONY_MODE` requires of `process` (AAP 0.6.2, 0.11.2). */
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

/** What a process's telephony client is configured with (AAP 0.6.2). */
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

/** Build the telephony configuration `values.TELEPHONY_MODE` names for `process` (AAP 0.6.2). */
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

const LLM_VARIABLES = [
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_PRICE_INPUT_USD_PER_MTOK',
  'LLM_PRICE_OUTPUT_USD_PER_MTOK',
] as const;

const LLM_PRICE_VARIABLES = [
  'LLM_PRICE_INPUT_USD_PER_MTOK',
  'LLM_PRICE_OUTPUT_USD_PER_MTOK',
] as const;

/** Report what the configured `LLM_PROVIDER` requires (AAP 0.5.6, 0.6.2). */
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

/** What the language-model adapter and the spend meter are configured with (AAP 0.5.6, 0.6.2). */
export type EnvLlmConfig =
  | { readonly provider: 'fake'; readonly prices: LlmPrices }
  | {
      readonly provider: 'openai';
      readonly apiKey: string;
      readonly model: SupportedModel;
      readonly prices: LlmPrices;
    };

/** Build the language-model configuration `values.LLM_PROVIDER` names (AAP 0.5.6, 0.6.2). */
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
