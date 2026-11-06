/**
 * Scoped environment validation for the API process (AAP 0.6.2, 0.8.1, 0.11.2).
 *
 * The API is the only process that holds Stripe credentials (AAP 0.3.2), so this is the only schema
 * that declares `./modes.ts`'s Stripe group; the telephony group it takes is the one without a caller
 * id, because the API validates signatures and dials nothing. Composition is by spreading the groups'
 * raw shapes, never by extending a refined schema, so every rule — format, bound, cross-variable
 * guard — stays in `./common.ts` or `./modes.ts` and this module only binds them to the process that
 * reads them. Nothing here reads the environment at module load, logs, or puts a value in a message.
 */

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

/** The BN254 scalar field order, which every `NULLIFIER_SALT` must stay below (AAP 0.5.5). */
const FIELD_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Whether `value` can serve as the published nullifier salt: a decimal field element below
 * {@link FIELD_ORDER}. A larger value is reduced modulo the order in-circuit, so it could never equal
 * the salt proof verification compares a proof's signal against, and no proof could ever pass.
 */
function isFieldElement(value: string): boolean {
  return FieldElement.safeParse(value).success && BigInt(value) < FIELD_ORDER;
}

/** The variables only `api` reads (AAP 0.6.2, the `api`-only scope row). */
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
  PILOT_LOCK_RATE_THRESHOLD: envDecimal({ min: 0, max: 1, maxFractionDigits: 4, default: '0.5' }),
  PILOT_COMPLETION_THRESHOLD: envDecimal({ min: 0, max: 1, maxFractionDigits: 4, default: '0.7' }),
} as const;

/**
 * The API's schema (AAP 0.6.2): the variables `api` and `workers` share, the test-only switches, the
 * three mode groups and the variables only `api` reads. A variable outside this scope — `SMTP_URL`,
 * for instance — is dropped by `z.object`'s default strip mode, so one process's schema never
 * requires another process's variable (AAP 0.11.2).
 */
export const API_ENV_SHAPE = {
  ...COMMON_ENV_SHAPE,
  ...TEST_ONLY_ENV_SHAPE,
  ...STRIPE_ENV_SHAPE,
  ...telephonyEnvShape('api'),
  ...LLM_ENV_SHAPE,
  ...API_ONLY_ENV_SHAPE,
} as const;

/**
 * The API's configuration (AAP 0.6.2). Scalar values keep their variable names — the CORS allowlist
 * takes its two origins as they stand, for instance — and the three mode variables are not repeated
 * here because each group's own discriminant carries them.
 */
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
  readonly PILOT_LOCK_RATE_THRESHOLD: number;
  readonly PILOT_COMPLETION_THRESHOLD: number;
  readonly stripe: EnvStripeConfig;
  readonly telephony: EnvTelephonyConfig;
  readonly llm: EnvLlmConfig;
};

/**
 * The accepted share in integer basis points, by string arithmetic: `'0.5'` is 5000 and `'1.0'` is
 * 10000. `envDecimal` has already bounded the value to 0–1 with at most four fraction digits, and the
 * experiment assignment of AAP 0.5.7 compares a hash modulo 10000 against this number, so no float
 * multiplication may decide it.
 */
function basisPoints(text: string): number {
  const [whole = '0', fraction = ''] = text.split('.');
  return Number(whole) * 10_000 + Number(`${fraction}0000`.slice(0, 4));
}

/**
 * Validate and load the API's environment (AAP 0.6.2, 0.11.2).
 *
 * Called once at startup, before the app listens, and nowhere else: a refused variable, a mode
 * missing the credential it reaches for, or a test-only variable outside `APP_ENV=test` fails the
 * start with one `EnvValidationError` naming every finding, so the API never runs half configured and
 * never starts in production with test control enabled (AAP 0.5.1). The credential-free modes need no
 * credential at all — `STRIPE_MODE=mock` takes fixed non-secret placeholders, `TELEPHONY_MODE=off`
 * and `simulator` take the simulator's, and `LLM_PROVIDER=fake` takes none — which is what starts the
 * default compose stack. The configuration returned is deeply frozen.
 *
 * @param raw - the raw environment; `process.env` unless a test supplies a record.
 * @throws EnvValidationError listing every issue, when any variable, mode or guard was refused.
 */
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
      PILOT_LOCK_RATE_THRESHOLD: values.PILOT_LOCK_RATE_THRESHOLD.value,
      PILOT_COMPLETION_THRESHOLD: values.PILOT_COMPLETION_THRESHOLD.value,
      stripe: buildStripe(values),
      telephony: buildTelephony(values, 'api'),
      llm: buildLlm(values),
    }),
  );
}
