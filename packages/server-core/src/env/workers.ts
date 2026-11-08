/**
 * Scoped environment validation for the `workers` process (AAP 0.6.2, 0.11.2).
 *
 * AAP 0.6.2 gives `workers` the row it shares with `api`, the row of its own, the two mode groups it
 * shares with `api`, and the test-only switches — and one variable set it must not read at all:
 * "`workers` reads no Stripe variable in any mode", because it holds no Stripe secret (AAP 0.3.2).
 * {@link WORKERS_ENV_SHAPE} therefore carries no `STRIPE_*` key, so a Stripe variable present in the
 * environment is dropped by the schema's default strip mode and can never reach this process's
 * configuration or the gateway code it would build.
 *
 * Two variables the request's scope tables place with `api` alone are read here as well, because
 * `workers` is what uses them: `API_PUBLIC_URL` is the base of the TwiML and status-callback URLs a
 * dispatched call carries, which must name the address Twilio called rather than an internal host
 * (AAP 0.3.2, 0.3.3), and `WEB_ORIGIN` is the base of the magic link `notify/email.ts` mails on web
 * (AAP 0.3.2, 0.3.4). `docker-compose.yml` passes both to the `workers` service, so the delivered
 * stack carries them; a deployment that provides neither still starts, because a variable outside
 * this process's own scope is never required of it. The run that needs one it does not have fails
 * its own work — `calls/dispatch-twilio.ts` refuses to dispatch, and the `notifications` job
 * refuses to deliver — while the rest of the process keeps running.
 *
 * The module reads no environment beyond {@link loadWorkersEnv}'s default argument, logs nothing, and
 * puts no value — a phone number above all — in an issue or an error (AAP 0.11.1, 0.12.2).
 */

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

/** Where place and lodging ingestion reaches Overpass when `OVERPASS_URL` is unset (AAP 0.3.3). */
const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/** Where the daily FX table is read when `FX_URL` is unset (AAP 0.3.3). */
const DEFAULT_FX_URL = 'https://open.er-api.com/v6/latest/USD';

/** Why an `EMAIL_FROM` that is not a mailbox is refused. */
const EMAIL_FROM_REASON = 'must be an address or a display name followed by <address>';

/** The product token the crawler identifies itself by, the first half of its user agent (AAP 0.5.6). */
const CRAWLER_PRODUCT_TOKEN = 'TablemateBot';

/** How long a meetup's financial records are kept after settlement: seven years (AAP 0.5.2). */
const DEFAULT_FINANCIAL_RETENTION_DAYS = '2557';

/**
 * Whether `value` is an email address, by the one schema addresses are validated with elsewhere in
 * the workspace (`packages/shared/src/schemas/auth.ts`).
 */
function isEmailAddress(value: string): boolean {
  return value !== '' && z.email().safeParse(value).success;
}

/**
 * Whether `value` is a mailbox header: a bare address, or a display name followed by the address in
 * angle brackets, as RFC 5322 §3.4 writes a `From`. A display name alone, an unbalanced bracket or a
 * mistyped address is refused rather than handed to Nodemailer, which would fail the first send with
 * an envelope error instead of failing startup.
 */
function isMailbox(value: string): boolean {
  const bracketed = /<([^<>]*)>\s*$/.exec(value);
  if (bracketed !== null) {
    return isEmailAddress((bracketed[1] ?? '').trim());
  }
  return !value.includes('<') && !value.includes('>') && isEmailAddress(value.trim());
}

/**
 * The `User-agent` every Tablemate fetch sends (AAP 0.5.6): `TablemateBot/1.0` followed by the
 * operator's contact URL, so a site owner reaches the operator instead of blocking the bot.
 * `crawlerUserAgent` in `apps/workers/src/menus/robots.ts` composes the identical string from the
 * same variable, and that is the form `robots.txt` matching reads; a change to the format has to
 * move both.
 */
function userAgentFor(contactUrl: string): string {
  return `${CRAWLER_PRODUCT_TOKEN}/1.0 (+${contactUrl})`;
}

/**
 * Report a `CALL_ALLOWLIST` {@link parseAllowlist} refuses (AAP 0.6.2). The thrown message names the
 * offending entry's 1-based position among the non-empty entries and never the number itself, which
 * is what makes it safe to report and to log (AAP 0.11.1, 0.12.2); anything else is a bug and is
 * rethrown rather than reported as an environment problem.
 */
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

/**
 * The variables only the `workers` process reads (AAP 0.6.2, the `workers` scope row). Everything a
 * mode requires beyond this is stated by the group that mode belongs to in `./modes.ts`, so this
 * shape holds the endpoints, the delivery settings and the call-and-retention configuration alone.
 *
 * `API_PUBLIC_URL` and `WEB_ORIGIN` are the two entries the `api` scope owns and this process reads
 * as well; both are optional, so a deployment that provides neither still starts and only the work
 * that needs one fails.
 */
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
 * process shares with `api`, and {@link WORKERS_ONLY_ENV_SHAPE} (AAP 0.6.2). Composed rather than
 * restated, so a variable that moves between the processes moves in one place. A variable outside
 * this set — `api`'s `JWT_SECRET` or `PORT`, or any payment key of any mode — is simply not part of
 * it, and the schema's strip mode means the process never sees it.
 */
export const WORKERS_ENV_SHAPE = {
  ...COMMON_ENV_SHAPE,
  ...TEST_ONLY_ENV_SHAPE,
  ...telephonyEnvShape('workers'),
  ...LLM_ENV_SHAPE,
  ...WORKERS_ONLY_ENV_SHAPE,
} as const;

/** The workers-only variables {@link buildWorkersEnv} reads, as {@link WORKERS_ONLY_ENV_SHAPE} parses them. */
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

/** Everything {@link buildWorkersEnv} reads: the common, test-only, mode and workers-only groups. */
type WorkersEnvValues = CommonEnvValues &
  EnvTestOnlyValues &
  TelephonyEnvValues &
  LlmEnvValues &
  WorkersOnlyEnvValues;

/**
 * The configuration the `workers` process runs with (AAP 0.3.2, 0.6.2). Scalar values keep their
 * variable names, so a job reads `env.SMTP_URL` as the environment spells it and nothing has to
 * translate between the two; the derived fields are what a consumer would otherwise compose itself.
 *
 * The object is deep frozen by {@link loadWorkersEnv}, and every collection in it is typed read-only.
 */
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

/**
 * Build the `workers` configuration from its parsed values and normalized environment (AAP 0.6.2).
 * Called once the shape and every guard accepted the environment, so {@link parseAllowlist} and the
 * mode builders can no longer refuse anything: a value a guard required is present here.
 */
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

/**
 * Validate and load the `workers` process's environment (AAP 0.6.2, 0.11.2).
 *
 * Runs before any queue processor or scheduler is registered, and refuses the start with every
 * finding of that attempt at once rather than the first, so an operator fixes one list. Four rules
 * beyond the fields are checked: a test-only variable outside `APP_ENV=test`, a `CALL_ALLOWLIST`
 * {@link parseAllowlist} refuses, what the configured `TELEPHONY_MODE` requires — `VOICE_SIM_URL` for
 * `simulator`, both Twilio credentials and, for this process, the caller id and a non-empty allowlist
 * outside production for `twilio` — and what `LLM_PROVIDER=openai` requires, the model among them.
 *
 * `TELEPHONY_MODE=off` with `LLM_PROVIDER=fake` reaches no provider and needs no credential, which is
 * what lets the `demo` stack and the automated suite start without one. A no-Stripe-variable
 * environment is likewise complete in every mode: this process holds no Stripe key by construction
 * (AAP 0.3.2). Production calls stay blocked until `CALLS_PRODUCTION_APPROVED=true`, which
 * `../telephony/allowlist.ts` enforces per call rather than at startup (AAP 0.7.3).
 *
 * @param raw - the raw environment; `process.env` unless a test supplies a record.
 * @returns the frozen configuration, whose allowlist is a fresh read-only set.
 * @throws EnvValidationError listing every issue of the attempt, when anything at all was refused.
 */
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
