import { z } from 'zod';

import { parseAllowlist } from '../telephony/allowlist.ts';
import {
  COMMON_ENV_SHAPE,
  TEST_ONLY_ENV_SHAPE,
  buildCommonEnv,
  envBoolean,
  envInt,
  envOrigin,
  envString,
  envUrl,
  loadEnvironment,
  testOnlyIssues,
  type CommonEnv,
  type CommonEnvValues,
  type EnvGuard,
  type EnvIssue,
  type EnvTestOnlyValues,
  type NormalizedEnv,
  type RawEnv,
} from './common.ts';
import {
  LLM_ENV_SHAPE,
  buildLlm,
  buildTelephony,
  llmIssues,
  telephonyEnvShape,
  telephonyIssues,
  type EnvLlmConfig,
  type EnvTelephonyConfig,
  type LlmEnvValues,
  type TelephonyEnvValues,
} from './modes.ts';

const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

const DEFAULT_FX_URL = 'https://open.er-api.com/v6/latest/USD';

const EMAIL_FROM_REASON = 'must be an address or a display name followed by <address>';

const CRAWLER_PRODUCT_TOKEN = 'TablemateBot';

const DEFAULT_FINANCIAL_RETENTION_DAYS = '2557';

function isEmailAddress(value: string): boolean {
  return value !== '' && z.email().safeParse(value).success;
}

function isMailbox(value: string): boolean {
  const bracketed = /<([^<>]*)>\s*$/.exec(value);
  if (bracketed !== null) {
    return isEmailAddress((bracketed[1] ?? '').trim());
  }
  return !value.includes('<') && !value.includes('>') && isEmailAddress(value.trim());
}

function userAgentFor(contactUrl: string): string {
  return `${CRAWLER_PRODUCT_TOKEN}/1.0 (+${contactUrl})`;
}

function allowlistIssues(env: NormalizedEnv): EnvIssue[] {
  try {
    parseAllowlist(env.CALL_ALLOWLIST);
    return [];
  } catch (error) {
    if (error instanceof RangeError) {
      return [{ variable: 'CALL_ALLOWLIST', reason: error.message }];
    }
    throw error;
  }
}

const WORKERS_ONLY_ENV_SHAPE = {
  SMTP_URL: envUrl({ protocols: ['smtp:', 'smtps:'] }),
  EMAIL_FROM: envString({ check: { test: isMailbox, reason: EMAIL_FROM_REASON } }),
  EXPO_ACCESS_TOKEN: envString({ optional: true }),
  OVERPASS_URL: envUrl({ protocols: ['http:', 'https:'], default: DEFAULT_OVERPASS_URL }),
  FX_URL: envUrl({ protocols: ['http:', 'https:'], default: DEFAULT_FX_URL }),
  CRAWLER_CONTACT_URL: envUrl({ protocols: ['http:', 'https:'] }),
  CALL_ALLOWLIST: envString({ optional: true }),
  CALLS_PRODUCTION_APPROVED: envBoolean({ default: 'false' }),
  FINANCIAL_RETENTION_DAYS: envInt({
    min: 1,
    default: DEFAULT_FINANCIAL_RETENTION_DAYS,
  }),
  API_PUBLIC_URL: envUrl({ protocols: ['http:', 'https:'], optional: true }),
  WEB_ORIGIN: envOrigin({ optional: true }),
} as const;

/**
 * The whole `workers` schema: the common row, the test-only switches, the two mode groups this
 * process shares with `api`, and {@link WORKERS_ONLY_ENV_SHAPE} (AAP 0.6.2).
 */
export const WORKERS_ENV_SHAPE = {
  ...COMMON_ENV_SHAPE,
  ...TEST_ONLY_ENV_SHAPE,
  ...telephonyEnvShape('workers'),
  ...LLM_ENV_SHAPE,
  ...WORKERS_ONLY_ENV_SHAPE,
} as const;

interface WorkersOnlyEnvValues {
  readonly SMTP_URL: string;
  readonly EMAIL_FROM: string;
  readonly EXPO_ACCESS_TOKEN?: string | undefined;
  readonly OVERPASS_URL: string;
  readonly FX_URL: string;
  readonly CRAWLER_CONTACT_URL: string;
  readonly CALL_ALLOWLIST?: string | undefined;
  readonly CALLS_PRODUCTION_APPROVED: boolean;
  readonly FINANCIAL_RETENTION_DAYS: number;
  readonly API_PUBLIC_URL: string | undefined;
  readonly WEB_ORIGIN: string | undefined;
}

type WorkersEnvValues = CommonEnvValues &
  EnvTestOnlyValues &
  TelephonyEnvValues &
  LlmEnvValues &
  WorkersOnlyEnvValues;

/** The configuration the `workers` process runs with (AAP 0.3.2, 0.6.2). */
export type WorkersEnv = CommonEnv & {
  /** The SMTP endpoint `notify/email.ts` delivers through. May carry credentials: never logged. */
  readonly SMTP_URL: string;
  /** The `From` header of every message: a bare address, or `Name <address>`. */
  readonly EMAIL_FROM: string;
  /** `EXPO_ACCESS_TOKEN`; `null` when unset, which leaves push switched off (AAP 0.3.4). */
  readonly EXPO_ACCESS_TOKEN: string | null;
  /** The Overpass endpoint place and lodging ingestion queries. */
  readonly OVERPASS_URL: string;
  /** The daily FX table `fx/open-er-api.ts` reads. */
  readonly FX_URL: string;
  /** The operator's contact URL, the second half of the crawler's user agent (AAP 0.5.6). */
  readonly CRAWLER_CONTACT_URL: string;
  /** The user agent every Tablemate fetch sends: `TablemateBot/1.0 (+<CRAWLER_CONTACT_URL>)`. */
  readonly crawlerUserAgent: string;
  /** The operator-owned numbers a call may reach outside production (AAP 0.3.3). */
  readonly CALL_ALLOWLIST: ReadonlySet<string>;
  /** Whether the operator has approved calls in production (AAP 0.7.3). */
  readonly CALLS_PRODUCTION_APPROVED: boolean;
  /** Days a meetup's financial records are kept after settlement (AAP 0.5.2). */
  readonly FINANCIAL_RETENTION_DAYS: number;
  /**
   * The public base URL of Twilio's TwiML fetch and status callbacks (AAP 0.3.3); `null` when the
   * deployment does not provide it, which fails a call dispatch rather than this process's start.
   */
  readonly API_PUBLIC_URL: string | null;
  /**
   * The web client's origin, the base of a magic link's URL (AAP 0.3.2); `null` when the deployment
   * does not provide it, which fails the magic-link delivery rather than this process's start.
   */
  readonly WEB_ORIGIN: string | null;
  /** The telephony posture `TELEPHONY_MODE` names; `off` carries nothing and dials nothing. */
  readonly telephony: EnvTelephonyConfig;
  /** The language-model posture `LLM_PROVIDER` names; `fake` needs no credential (AAP 0.5.6). */
  readonly llm: EnvLlmConfig;
};

function buildWorkersEnv(values: WorkersEnvValues, env: NormalizedEnv): WorkersEnv {
  return {
    ...buildCommonEnv(values, env),
    SMTP_URL: values.SMTP_URL,
    EMAIL_FROM: values.EMAIL_FROM,
    EXPO_ACCESS_TOKEN: values.EXPO_ACCESS_TOKEN ?? null,
    OVERPASS_URL: values.OVERPASS_URL,
    FX_URL: values.FX_URL,
    CRAWLER_CONTACT_URL: values.CRAWLER_CONTACT_URL,
    crawlerUserAgent: userAgentFor(values.CRAWLER_CONTACT_URL),
    CALL_ALLOWLIST: parseAllowlist(values.CALL_ALLOWLIST),
    CALLS_PRODUCTION_APPROVED: values.CALLS_PRODUCTION_APPROVED,
    FINANCIAL_RETENTION_DAYS: values.FINANCIAL_RETENTION_DAYS,
    API_PUBLIC_URL: values.API_PUBLIC_URL ?? null,
    WEB_ORIGIN: values.WEB_ORIGIN ?? null,
    telephony: buildTelephony(values, 'workers'),
    llm: buildLlm(values),
  };
}

/** Validate and load the `workers` process's environment (AAP 0.6.2, 0.11.2). */
export function loadWorkersEnv(raw: RawEnv = process.env): WorkersEnv {
  const telephonyGuard: EnvGuard = (env) => telephonyIssues(env, 'workers');
  return loadEnvironment(
    'workers',
    WORKERS_ENV_SHAPE,
    raw,
    [testOnlyIssues, allowlistIssues, telephonyGuard, llmIssues],
    buildWorkersEnv,
  );
}
