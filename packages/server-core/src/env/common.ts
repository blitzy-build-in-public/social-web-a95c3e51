import { z } from 'zod';

import { AppEnv } from '@tablemate/shared';

import { FIELD_KEY_ID_PATTERN, isValidFieldKey } from '../crypto/field-encryption.ts';
import { LOG_LEVELS, type LogLevel } from '../logger.ts';
/** The raw environment a process sees: `process.env`, or any record a test supplies. */
export type RawEnv = Readonly<Record<string, string | undefined>>;
/** A raw environment after {@link normalizeRawEnv}: only the variables that carry a value. */
export type NormalizedEnv = Readonly<Record<string, string>>;
/** The process whose environment is validated, which is what {@link EnvValidationError} names. */
export type EnvProcess = 'api' | 'workers' | 'seed';
/** One reason a process refused to start. */
export interface EnvIssue {
  /** The variable's name, or `(environment)` for a finding that belongs to no single variable. */
  readonly variable: string;
  /** What is wrong with it. A fixed string: it never quotes the value. */
  readonly reason: string;
}
/** Raised when a process's environment does not validate; {@link issues} is what the process logs before exiting, and the message names the process. */
export class EnvValidationError extends Error {
  /** The process whose environment was refused: `api`, `workers` or `seed`. */
  readonly process: EnvProcess;
  /** Every finding of one start attempt, frozen, in the order the loader collected them. */
  readonly issues: readonly EnvIssue[];
  constructor(process: EnvProcess, issues: readonly EnvIssue[]) {
    super(envErrorMessage(process, issues));
    this.name = 'EnvValidationError';
    this.process = process;
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}
const REQUIRED_REASON = 'is required';
const UNKNOWN_VARIABLE = '(environment)';
const SECRET_MIN_LENGTH = 32;
const FIELD_KEY_REASON = 'must be standard base64 of exactly 32 bytes';
const FIELD_KEY_ID_REASON = 'must match FIELD_KEY_ID_PATTERN';
/** The largest `CAP_LLM_USD_PER_CITY_DAY` accepted: a ceiling keeps the cap's micro-dollar scale, which `decimalToMicros` derives and every spend reservation multiplies. */
const MAX_CAP_USD = 1_000_000;
const INTEGER_PATTERN = /^\d+$/;
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
function envErrorMessage(process: EnvProcess, issues: readonly EnvIssue[]): string {
  const detail = issues.map((issue) => `${issue.variable} (${issue.reason})`).join('; ');
  return detail === ''
    ? `Invalid ${process} environment`
    : `Invalid ${process} environment: ${detail}`;
}
/** Treat an empty string as absent, and trim whatever is left: compose renders a variable it does not set as `""`. */
export function emptyToUndefined(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
/** {@link emptyToUndefined} over every entry, dropping the ones that end up absent. */
export function normalizeRawEnv(raw: RawEnv): NormalizedEnv {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const normalized = emptyToUndefined(value);
    if (typeof normalized === 'string') {
      env[name] = normalized;
    }
  }
  return Object.freeze(env);
}
/** The deployment mode the environment names, or `null` when it names none of the four. */
export function appEnvOrNull(raw: RawEnv = process.env): AppEnv | null {
  const parsed = AppEnv.safeParse(normalizeRawEnv(raw).APP_ENV);
  return parsed.success ? parsed.data : null;
}
/** The options every builder accepts, beyond the ones of its variable type (AAP 0.6.2). */
export interface EnvFieldOptions {
  /** The raw value to use when the variable is absent or empty, applied before parsing, so a default is validated exactly like a supplied value. */
  readonly default?: string;
  /** Declare the variable optional: absent means the parsed value is `undefined`. */
  readonly optional?: true;
}
/** The optional marker on its own; a builder given it returns `T | undefined`. */
export interface EnvOptionalField {
  /** Declare the variable optional: absent means the parsed value is `undefined`. */
  readonly optional: true;
}
/** A rule a value must satisfy, with the reason reported when it does not. */
export interface EnvCheck {
  /** The rule: `true` for an accepted value. */
  readonly test: (value: string) => boolean;
  /** The reason reported when {@link EnvCheck.test} refuses the value. A fixed string, never a value. */
  readonly reason: string;
}
function envField<T>(
  schema: z.ZodType<T, string>,
  options: EnvFieldOptions | undefined,
): z.ZodType<T | undefined> {
  const fallback = options?.default;
  if (fallback !== undefined) {
    return z.preprocess((value) => emptyToUndefined(value) ?? fallback, schema);
  }
  if (options?.optional === true) {
    return z.preprocess(emptyToUndefined, schema.optional());
  }
  return z.preprocess(emptyToUndefined, z.string({ error: REQUIRED_REASON }).pipe(schema));
}
/** Options for {@link envString} beyond {@link EnvFieldOptions}. */
export interface EnvStringOptions {
  /** Longest accepted value, when the variable has a documented limit. */
  readonly max?: number;
  /** A rule the value must satisfy, such as the key-id pattern or the field-key encoding. */
  readonly check?: EnvCheck;
}
/** A non-empty string variable: `max` reports the limit and `check` its own fixed reason. */
export function envString(
  options: EnvStringOptions & EnvOptionalField,
): z.ZodType<string | undefined>;
export function envString(options?: EnvStringOptions & EnvFieldOptions): z.ZodType<string>;
export function envString(
  options?: EnvStringOptions & EnvFieldOptions,
): z.ZodType<string> | z.ZodType<string | undefined> {
  const base = z.string({ error: REQUIRED_REASON });
  const { max, check } = options ?? {};
  const bounded =
    max === undefined ? base : base.max(max, { error: `must be at most ${max} characters` });
  const checked =
    check === undefined ? bounded : bounded.refine(check.test, { error: check.reason });
  return envField(checked, options);
}
/** A secret variable: at least {@link SECRET_MIN_LENGTH} characters, never logged by this module. */
export function envSecret(options: EnvOptionalField): z.ZodType<string | undefined>;
export function envSecret(options?: EnvFieldOptions): z.ZodType<string>;
export function envSecret(
  options?: EnvFieldOptions,
): z.ZodType<string> | z.ZodType<string | undefined> {
  const schema = z
    .string({ error: REQUIRED_REASON })
    .min(SECRET_MIN_LENGTH, { error: `must be at least ${SECRET_MIN_LENGTH} characters` });
  return envField(schema, options);
}
/** Options for {@link envInt} beyond {@link EnvFieldOptions}. */
export interface EnvIntOptions {
  /** Smallest accepted value, inclusive. */
  readonly min: number;
  /** Largest accepted value, inclusive; `Number.MAX_SAFE_INTEGER` when absent. */
  readonly max?: number;
}
/** A whole-number variable: digits only, so `1.5`, `1e3`, `+1` and `0x10` are refused rather than quietly coerced. */
export function envInt(options: EnvIntOptions & EnvOptionalField): z.ZodType<number | undefined>;
export function envInt(options: EnvIntOptions & EnvFieldOptions): z.ZodType<number>;
export function envInt(
  options: EnvIntOptions & EnvFieldOptions,
): z.ZodType<number> | z.ZodType<number | undefined> {
  const ceiling = options.max ?? Number.MAX_SAFE_INTEGER;
  const schema = z
    .string({ error: REQUIRED_REASON })
    .regex(INTEGER_PATTERN, { error: 'must be a whole number' })
    .transform((text) => Number(text))
    .refine((value) => Number.isSafeInteger(value), {
      error: `must be at most ${Number.MAX_SAFE_INTEGER}`,
    })
    .refine((value) => value >= options.min, { error: `must be at least ${options.min}` })
    .refine((value) => value <= ceiling, { error: `must be at most ${ceiling}` });
  return envField(schema, options);
}
/** A decimal's parsed form: the number for a bounds check, the exact text for its scale. */
export interface EnvDecimalValue {
  /** The value as a number, for comparison against a bound. */
  readonly value: number;
  /** The value as it was written, so a caller derives an integer scale by string arithmetic. */
  readonly text: string;
}
/** Options for {@link envDecimal} beyond {@link EnvFieldOptions}. */
export interface EnvDecimalOptions {
  /** Smallest accepted value, inclusive. */
  readonly min: number;
  /** Largest accepted value, inclusive; `Number.MAX_SAFE_INTEGER` when absent. */
  readonly max?: number;
  /** How many fraction digits the value may carry: the scale of {@link EnvDecimalValue.text}. */
  readonly maxFractionDigits: number;
}
/** A non-negative decimal variable, refused beyond `maxFractionDigits` fraction digits. */
export function envDecimal(
  options: EnvDecimalOptions & EnvOptionalField,
): z.ZodType<EnvDecimalValue | undefined>;
export function envDecimal(
  options: EnvDecimalOptions & EnvFieldOptions,
): z.ZodType<EnvDecimalValue>;
export function envDecimal(
  options: EnvDecimalOptions & EnvFieldOptions,
): z.ZodType<EnvDecimalValue> | z.ZodType<EnvDecimalValue | undefined> {
  const ceiling = options.max ?? Number.MAX_SAFE_INTEGER;
  const schema = z
    .string({ error: REQUIRED_REASON })
    .regex(DECIMAL_PATTERN, { error: 'must be a decimal number' })
    .refine((text) => fractionDigits(text) <= options.maxFractionDigits, {
      error: `must have at most ${options.maxFractionDigits} decimal places`,
    })
    .refine((text) => Number(text) >= options.min, { error: `must be at least ${options.min}` })
    .refine((text) => Number(text) <= ceiling, { error: `must be at most ${ceiling}` })
    .transform((text) => ({ value: Number(text), text }));
  return envField(schema, options);
}
function fractionDigits(text: string): number {
  const separator = text.indexOf('.');
  return separator < 0 ? 0 : text.length - separator - 1;
}
/** A boolean variable spelled exactly `true` or `false`; anything else is refused, not guessed. */
export function envBoolean(options: EnvOptionalField): z.ZodType<boolean | undefined>;
export function envBoolean(options?: EnvFieldOptions): z.ZodType<boolean>;
export function envBoolean(
  options?: EnvFieldOptions,
): z.ZodType<boolean> | z.ZodType<boolean | undefined> {
  const schema = z
    .string({ error: REQUIRED_REASON })
    .refine((text) => text === 'true' || text === 'false', { error: 'must be true or false' })
    .transform((text) => text === 'true');
  return envField(schema, options);
}
/** Options for {@link envUrl} beyond {@link EnvFieldOptions}. */
export interface EnvUrlOptions {
  /** The schemes the variable may use, written with the colon: `['postgres:', 'postgresql:']`. */
  readonly protocols: readonly string[];
}
/** A URL variable restricted to the schemes the connection it configures can use, so an `http://` value copied where a `postgresql://` one belongs fails. */
export function envUrl(options: EnvUrlOptions & EnvOptionalField): z.ZodType<string | undefined>;
export function envUrl(options: EnvUrlOptions & EnvFieldOptions): z.ZodType<string>;
export function envUrl(
  options: EnvUrlOptions & EnvFieldOptions,
): z.ZodType<string> | z.ZodType<string | undefined> {
  const schemes = options.protocols.map((protocol) => protocol.replace(/:$/, '').toLowerCase());
  const schema = z.url({ error: 'must be a URL' }).refine(
    (value) => {
      const parsed = parseUrl(value);
      return parsed !== undefined && schemes.includes(parsed.protocol.replace(/:$/, ''));
    },
    { error: `must use the ${schemes.map((scheme) => `${scheme}:`).join(' or ')} URL scheme` },
  );
  return envField(schema, options);
}
function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
/** An origin variable: an `http` or `https` URL with a host and nothing else, normalized to `new URL(value).origin`. */
export function envOrigin(options: EnvOptionalField): z.ZodType<string | undefined>;
export function envOrigin(options?: EnvFieldOptions): z.ZodType<string>;
export function envOrigin(
  options?: EnvFieldOptions,
): z.ZodType<string> | z.ZodType<string | undefined> {
  const schema = z
    .url({ error: 'must be a URL' })
    .refine(isOrigin, {
      error: 'must be an http or https origin with no path, query, fragment or credentials',
    })
    .transform((value) => new URL(value).origin);
  return envField(schema, options);
}
function isOrigin(value: string): boolean {
  const url = parseUrl(value);
  return (
    url !== undefined &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    url.pathname === '/'
  );
}
/** A variable restricted to a fixed set of values (AAP 0.6.2). */
export function envEnum<const V extends string>(
  values: readonly V[],
  options: EnvOptionalField,
): z.ZodType<V | undefined>;
export function envEnum<const V extends string>(
  values: readonly V[],
  options?: EnvFieldOptions,
): z.ZodType<V>;
export function envEnum<const V extends string>(
  values: readonly V[],
  options?: EnvFieldOptions,
): z.ZodType<V> | z.ZodType<V | undefined> {
  const schema = z.enum(values, { error: `must be one of ${values.join('|')}` });
  return envField(schema, options);
}
/** Options for {@link envCsv} beyond {@link EnvFieldOptions}. */
export interface EnvCsvOptions {
  /** The rule each entry must satisfy. */
  readonly item: (entry: string) => boolean;
  /** The reason reported when an entry fails {@link EnvCsvOptions.item}. A fixed string, never a value. */
  readonly reason: string;
}
/** A comma-separated variable: entries trimmed, empty ones dropped, each surviving one checked. */
export function envCsv(
  options: EnvCsvOptions & EnvOptionalField,
): z.ZodType<readonly string[] | undefined>;
export function envCsv(options: EnvCsvOptions & EnvFieldOptions): z.ZodType<readonly string[]>;
export function envCsv(
  options: EnvCsvOptions & EnvFieldOptions,
): z.ZodType<readonly string[]> | z.ZodType<readonly string[] | undefined> {
  const schema = z
    .string({ error: REQUIRED_REASON })
    .transform((text) =>
      text
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    .refine((entries) => entries.every(options.item), { error: options.reason })
    .transform((entries) => Object.freeze(entries));
  return envField(schema, options);
}
/** A rule a process declares about its environment as a whole, beyond what a field can state: that a variable is refused in a mode, or that a mode needs another one set. */
export type EnvGuard = (env: NormalizedEnv) => readonly EnvIssue[];
/** Validate one process's environment and build its configuration (AAP 0.6.2, 0.11.2). */
export function loadEnvironment<S extends z.ZodRawShape, T>(
  process: EnvProcess,
  shape: S,
  raw: RawEnv,
  guards: readonly EnvGuard[],
  build: (values: z.output<z.ZodObject<S>>, env: NormalizedEnv) => T,
): Readonly<T> {
  const env = normalizeRawEnv(raw);
  const parsed = z.object(shape).safeParse(env);
  const issues: EnvIssue[] = parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({
        variable: String(issue.path[0] ?? UNKNOWN_VARIABLE),
        reason: issue.message,
      }));
  for (const guard of guards) {
    issues.push(...guard(env));
  }
  const findings = dedupeIssues(issues);
  // Both cases refuse the start with the same list; the parse test is kept in the condition only to narrow `parsed` for the build below, since `!parsed.success` already implies at least one finding.
  if (!parsed.success || findings.length > 0) {
    throw new EnvValidationError(process, findings);
  }
  return deepFreeze(build(parsed.data, env));
}
function dedupeIssues(issues: readonly EnvIssue[]): EnvIssue[] {
  const seen = new Set<string>();
  const unique: EnvIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.variable}\u0000${issue.reason}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({ variable: issue.variable, reason: issue.reason });
  }
  return unique;
}
function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
/** The `TELEPHONY_MODE` values the workspace supports (AAP 0.6.2). */
export const ENV_TELEPHONY_MODES = ['off', 'simulator', 'twilio'] as const;
/** One of {@link ENV_TELEPHONY_MODES}; `./modes.ts` turns it into the telephony discriminant. */
export type EnvTelephonyMode = (typeof ENV_TELEPHONY_MODES)[number];
/** The `LLM_PROVIDER` values the workspace supports (AAP 0.5.6, 0.6.2). */
export const ENV_LLM_PROVIDERS = ['fake', 'openai'] as const;
/** One of {@link ENV_LLM_PROVIDERS}; `./modes.ts` turns it into the language-model discriminant. */
export type EnvLlmProvider = (typeof ENV_LLM_PROVIDERS)[number];
/** The variables `api` and `workers` both read: the database and cache endpoints, the field-encryption key and its id, the language-model provider and prices, and the call caps. */
export const COMMON_ENV_SHAPE = {
  APP_ENV: envEnum(AppEnv.options),
  DATABASE_URL: envUrl({ protocols: ['postgres:', 'postgresql:'] }),
  REDIS_URL: envUrl({ protocols: ['redis:', 'rediss:'] }),
  FIELD_ENCRYPTION_KEY: envString({ check: { test: isValidFieldKey, reason: FIELD_KEY_REASON } }),
  FIELD_ENCRYPTION_KEY_ID: envString({
    check: { test: (value) => FIELD_KEY_ID_PATTERN.test(value), reason: FIELD_KEY_ID_REASON },
  }),
  ANALYTICS_SALT: envSecret(),
  LOG_LEVEL: envEnum(LOG_LEVELS, { default: 'info' }),
  CAP_CALLS_PER_CITY_DAY: envInt({ min: 0, default: '40' }),
  CAP_CALL_SECONDS: envInt({ min: 1, default: '300' }),
  CAP_LLM_USD_PER_CITY_DAY: envDecimal({
    min: 0,
    max: MAX_CAP_USD,
    maxFractionDigits: 6,
    default: '25',
  }),
  LLM_MAX_TURNS_PER_CALL: envInt({ min: 1, default: '60' }),
  TELEPHONY_MODE: envEnum(ENV_TELEPHONY_MODES),
  LLM_PROVIDER: envEnum(ENV_LLM_PROVIDERS),
} as const;
/** The parsed values of {@link COMMON_ENV_SHAPE}, before the derived fields are added. */
export type CommonEnvValues = z.output<z.ZodObject<typeof COMMON_ENV_SHAPE>>;
/** The configuration `api` and `workers` share (AAP 0.6.2). */
export interface CommonEnv {
  readonly APP_ENV: AppEnv;
  readonly DATABASE_URL: string;
  readonly REDIS_URL: string;
  readonly FIELD_ENCRYPTION_KEY: string;
  readonly FIELD_ENCRYPTION_KEY_ID: string;
  readonly ANALYTICS_SALT: string;
  readonly LOG_LEVEL: LogLevel;
  readonly CAP_CALLS_PER_CITY_DAY: number;
  readonly CAP_CALL_SECONDS: number;
  readonly CAP_LLM_USD_PER_CITY_DAY: number;
  /** The cap in micro-dollars, the unit the spend reservation of AAP 0.5.6 counts in. */
  readonly capLlmMicrosPerCityDay: number;
  readonly LLM_MAX_TURNS_PER_CALL: number;
  /** The test-only variables, all off outside `test` (AAP 0.5.1, 0.6.2). */
  readonly testOnly: EnvTestOnlyConfig;
}
/** Build the configuration `api` and `workers` share, from the process's parsed values and its normalized environment. */
export function buildCommonEnv(
  values: CommonEnvValues & EnvTestOnlyValues,
  env: NormalizedEnv,
): CommonEnv {
  return {
    APP_ENV: values.APP_ENV,
    DATABASE_URL: values.DATABASE_URL,
    REDIS_URL: values.REDIS_URL,
    FIELD_ENCRYPTION_KEY: values.FIELD_ENCRYPTION_KEY,
    FIELD_ENCRYPTION_KEY_ID: values.FIELD_ENCRYPTION_KEY_ID,
    ANALYTICS_SALT: values.ANALYTICS_SALT,
    LOG_LEVEL: values.LOG_LEVEL,
    CAP_CALLS_PER_CITY_DAY: values.CAP_CALLS_PER_CITY_DAY,
    CAP_CALL_SECONDS: values.CAP_CALL_SECONDS,
    CAP_LLM_USD_PER_CITY_DAY: values.CAP_LLM_USD_PER_CITY_DAY.value,
    capLlmMicrosPerCityDay: decimalToMicros(values.CAP_LLM_USD_PER_CITY_DAY.text),
    LLM_MAX_TURNS_PER_CALL: values.LLM_MAX_TURNS_PER_CALL,
    testOnly: buildTestOnly(values, env.APP_ENV),
  };
}
// Micro-dollars from a decimal that matched `DECIMAL_PATTERN`, by string arithmetic: `'25'` is 25,000,000 and `'0.000001'` is 1. Multiplying the float would round a cap by a micro-dollar, and the spend reservation compares against exactly this number.
function decimalToMicros(text: string): number {
  const [whole = '0', fraction = ''] = text.split('.');
  const padded = `${fraction}000000`.slice(0, 6);
  return Number(whole) * 1_000_000 + Number(padded);
}
/** The variables only a test environment may set: the test issuer's registry root, the token that mounts the test-control routes, and the call allowlist override. */
export const TEST_ONLY_VARIABLES = [
  'ZK_ALLOW_TEST_ISSUER',
  'TEST_CONTROL_TOKEN',
  'CRAWL_ALLOW_PRIVATE_HOSTS',
] as const;
/** One of {@link TEST_ONLY_VARIABLES}. */
export type TestOnlyVariable = (typeof TEST_ONLY_VARIABLES)[number];
/** The test-only group both processes compose into their schema (AAP 0.5.1, 0.5.6). */
export const TEST_ONLY_ENV_SHAPE = {
  ZK_ALLOW_TEST_ISSUER: envBoolean({ default: 'false' }),
  TEST_CONTROL_TOKEN: envString({ optional: true }),
  CRAWL_ALLOW_PRIVATE_HOSTS: envCsv({
    item: (entry) => HOST_PATTERN.test(entry),
    reason: 'must be a comma-separated list of lowercase host names or IPv4 literals',
    optional: true,
  }),
} as const;
/** The parsed values of {@link TEST_ONLY_ENV_SHAPE}. */
export type EnvTestOnlyValues = z.output<z.ZodObject<typeof TEST_ONLY_ENV_SHAPE>>;
/** The test-only switches, resolved (AAP 0.6.2). */
export interface EnvTestOnlyConfig {
  readonly zkAllowTestIssuer: boolean;
  readonly testControlToken: string | null;
  readonly crawlAllowPrivateHosts: readonly string[];
}
/** Report a test-only variable that is set outside `test`: one issue per present variable, whatever its value. */
export function testOnlyIssues(env: NormalizedEnv): EnvIssue[] {
  if (env.APP_ENV === 'test') {
    return [];
  }
  return TEST_ONLY_VARIABLES.filter((name) => env[name] !== undefined).map((name) => ({
    variable: name,
    reason: 'accepted only when APP_ENV=test',
  }));
}
/** Build the resolved test-only configuration, from the parsed values and the normalized `APP_ENV`. */
export function buildTestOnly(
  values: EnvTestOnlyValues,
  appEnv: string | undefined,
): EnvTestOnlyConfig {
  if (appEnv !== 'test') {
    return { zkAllowTestIssuer: false, testControlToken: null, crawlAllowPrivateHosts: [] };
  }
  return {
    zkAllowTestIssuer: values.ZK_ALLOW_TEST_ISSUER,
    testControlToken: values.TEST_CONTROL_TOKEN ?? null,
    crawlAllowPrivateHosts: values.CRAWL_ALLOW_PRIVATE_HOSTS ?? [],
  };
}
/** The seed's own environment: the deployment mode, the database it seeds, and the field encryption key it writes console secrets with. */
export type SeedEnv = Readonly<{
  APP_ENV: AppEnv;
  DATABASE_URL: string;
  FIELD_ENCRYPTION_KEY: string;
  FIELD_ENCRYPTION_KEY_ID: string;
}>;
const SEED_ENV_SHAPE = {
  APP_ENV: COMMON_ENV_SHAPE.APP_ENV,
  DATABASE_URL: COMMON_ENV_SHAPE.DATABASE_URL,
  FIELD_ENCRYPTION_KEY: COMMON_ENV_SHAPE.FIELD_ENCRYPTION_KEY,
  FIELD_ENCRYPTION_KEY_ID: COMMON_ENV_SHAPE.FIELD_ENCRYPTION_KEY_ID,
} as const;
/** Validate and load the seed's environment (AAP 0.6.2). */
export function loadSeedEnv(raw: RawEnv = process.env): SeedEnv {
  return loadEnvironment('seed', SEED_ENV_SHAPE, raw, [], (values) => ({
    APP_ENV: values.APP_ENV,
    DATABASE_URL: values.DATABASE_URL,
    FIELD_ENCRYPTION_KEY: values.FIELD_ENCRYPTION_KEY,
    FIELD_ENCRYPTION_KEY_ID: values.FIELD_ENCRYPTION_KEY_ID,
  }));
}
