import { FieldElement } from '@tablemate/shared';

import {
  COMMON_ENV_SHAPE,
  TEST_ONLY_ENV_SHAPE,
  buildCommonEnv,
  envDecimal,
  envInt,
  envOrigin,
  envSecret,
  envString,
  envUrl,
  loadEnvironment,
  testOnlyIssues,
  type CommonEnv,
  type RawEnv,
} from './common.ts';
import {
  LLM_ENV_SHAPE,
  STRIPE_ENV_SHAPE,
  buildLlm,
  buildStripe,
  buildTelephony,
  llmIssues,
  stripeIssues,
  telephonyEnvShape,
  telephonyIssues,
  type EnvLlmConfig,
  type EnvStripeConfig,
  type EnvTelephonyConfig,
} from './modes.ts';

const FIELD_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function isFieldElement(value: string): boolean {
  return FieldElement.safeParse(value).success && BigInt(value) < FIELD_ORDER;
}

const API_ONLY_ENV_SHAPE = {
  API_PORT: envInt({ min: 1, max: 65_535, default: '3000' }),
  API_PUBLIC_URL: envUrl({ protocols: ['http:', 'https:'] }),
  WEB_ORIGIN: envOrigin(),
  VENUE_CONSOLE_ORIGIN: envOrigin(),
  JWT_SECRET: envSecret(),
  EMAIL_LOOKUP_PEPPER: envSecret(),
  EXPERIMENT_SALT: envSecret(),
  EXPERIMENT_SOCIAL_SHARE: envDecimal({ min: 0, max: 1, maxFractionDigits: 4, default: '0.5' }),
  NULLIFIER_SALT: envString({
    check: {
      test: isFieldElement,
      reason: 'must be a decimal field element below the BN254 scalar field order',
    },
  }),
  ARTIFACTS_BASE_URL: envUrl({ protocols: ['http:', 'https:'] }),
  RATE_LIMIT_IP_PER_MIN: envInt({ min: 1, default: '600' }),
  TERMS_VERSION: envString({ max: 64 }),
  VOICE_RELAY_MAX_SESSIONS: envInt({ min: 1, default: '10' }),
  CHAT_MAX_SOCKETS_PER_USER: envInt({ min: 1, default: '5' }),
  PILOT_LOCK_RATE_THRESHOLD: envDecimal({ min: 0, max: 1, maxFractionDigits: 4, default: '0.5' }),
  PILOT_COMPLETION_THRESHOLD: envDecimal({ min: 0, max: 1, maxFractionDigits: 4, default: '0.7' }),
} as const;

/**
 * The API's schema (AAP 0.6.2): the variables `api` and `workers` share, the test-only switches,
 * the three mode groups and the variables only `api` reads.
 */
export const API_ENV_SHAPE = {
  ...COMMON_ENV_SHAPE,
  ...TEST_ONLY_ENV_SHAPE,
  ...STRIPE_ENV_SHAPE,
  ...telephonyEnvShape('api'),
  ...LLM_ENV_SHAPE,
  ...API_ONLY_ENV_SHAPE,
} as const;

/** The API's configuration (AAP 0.6.2). */
export type ApiEnv = CommonEnv & {
  readonly API_PORT: number;
  readonly API_PUBLIC_URL: string;
  readonly WEB_ORIGIN: string;
  readonly VENUE_CONSOLE_ORIGIN: string;
  readonly JWT_SECRET: string;
  readonly EMAIL_LOOKUP_PEPPER: string;
  readonly EXPERIMENT_SALT: string;
  readonly EXPERIMENT_SOCIAL_SHARE: number;
  /** The same share in integer basis points: the 0–10000 scale the assignment of AAP 0.5.7 hashes to. */
  readonly experimentSocialShareBasisPoints: number;
  readonly NULLIFIER_SALT: string;
  readonly ARTIFACTS_BASE_URL: string;
  readonly RATE_LIMIT_IP_PER_MIN: number;
  readonly TERMS_VERSION: string;
  readonly VOICE_RELAY_MAX_SESSIONS: number;
  /**
   * How many live chat sockets one account may hold on one API instance (AAP 0.3.2, 0.5.4): the
   * socket that would exceed it is refused before it is attached, and the allowance is released as
   * a socket closes.
   */
  readonly CHAT_MAX_SOCKETS_PER_USER: number;
  readonly PILOT_LOCK_RATE_THRESHOLD: number;
  readonly PILOT_COMPLETION_THRESHOLD: number;
  readonly stripe: EnvStripeConfig;
  readonly telephony: EnvTelephonyConfig;
  readonly llm: EnvLlmConfig;
};

function basisPoints(text: string): number {
  const [whole = '0', fraction = ''] = text.split('.');
  return Number(whole) * 10_000 + Number(`${fraction}0000`.slice(0, 4));
}

/** Validate and load the API's environment (AAP 0.6.2, 0.11.2). */
export function loadApiEnv(raw: RawEnv = process.env): ApiEnv {
  return loadEnvironment(
    'api',
    API_ENV_SHAPE,
    raw,
    [testOnlyIssues, stripeIssues, (env) => telephonyIssues(env, 'api'), llmIssues],
    (values, env) => ({
      ...buildCommonEnv(values, env),
      API_PORT: values.API_PORT,
      API_PUBLIC_URL: values.API_PUBLIC_URL,
      WEB_ORIGIN: values.WEB_ORIGIN,
      VENUE_CONSOLE_ORIGIN: values.VENUE_CONSOLE_ORIGIN,
      JWT_SECRET: values.JWT_SECRET,
      EMAIL_LOOKUP_PEPPER: values.EMAIL_LOOKUP_PEPPER,
      EXPERIMENT_SALT: values.EXPERIMENT_SALT,
      EXPERIMENT_SOCIAL_SHARE: values.EXPERIMENT_SOCIAL_SHARE.value,
      experimentSocialShareBasisPoints: basisPoints(values.EXPERIMENT_SOCIAL_SHARE.text),
      NULLIFIER_SALT: values.NULLIFIER_SALT,
      ARTIFACTS_BASE_URL: values.ARTIFACTS_BASE_URL,
      RATE_LIMIT_IP_PER_MIN: values.RATE_LIMIT_IP_PER_MIN,
      TERMS_VERSION: values.TERMS_VERSION,
      VOICE_RELAY_MAX_SESSIONS: values.VOICE_RELAY_MAX_SESSIONS,
      CHAT_MAX_SOCKETS_PER_USER: values.CHAT_MAX_SOCKETS_PER_USER,
      PILOT_LOCK_RATE_THRESHOLD: values.PILOT_LOCK_RATE_THRESHOLD.value,
      PILOT_COMPLETION_THRESHOLD: values.PILOT_COMPLETION_THRESHOLD.value,
      stripe: buildStripe(values),
      telephony: buildTelephony(values, 'api'),
      llm: buildLlm(values),
    }),
  );
}
