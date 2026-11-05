/**
 * Scoped environment validation for every Node process: one Zod schema per process, checked before the
 * process does anything else (AAP 0.6.2, 0.11.2).
 *
 * AAP 0.6.2 asks for "one Zod schema per process, composed from the groups below. Each process
 * validates only its own schema at start and fails fast, so a variable outside its scope is never
 * required, and a mode needs credentials only when it reaches a real provider." This module holds the
 * field builders, the loader that folds Zod issues and guard findings into one
 * {@link EnvValidationError}, the groups `./api.ts` and `./workers.ts` compose from, and the seed's own
 * schema because `packages/db/seed/seed.ts` is a third process.
 *
 * Invariants: a message or {@link EnvIssue} reason names a variable and what is wrong with it and never
 * echoes a value or a prefix of one, because these strings reach logs and container output
 * (AAP 0.12.2); an empty string counts as absent, because compose renders a variable it does not set as
 * `""`; and a decimal is scaled by string arithmetic, so no float multiplication decides a spend cap.
 * Nothing here reads the environment at module load, logs or asks for the time, and what a loader
 * returns is deep frozen, so no consumer can mutate a configuration its siblings read.
 */

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

/**
 * Raised when a process's environment does not validate (AAP 0.6.2, 0.11.2). {@link issues} is what the
 * process logs before exiting, and the message is the same list on one line: `Invalid <process>
 * environment: VAR (reason); VAR2 (reason)`. Neither carries a value or a prefix of one (AAP 0.12.2).
 */
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

/** The reason a required variable that is absent or empty reports. */
const REQUIRED_REASON = 'is required';

/** What an issue names when it belongs to no single variable. */
const UNKNOWN_VARIABLE = '(environment)';

/** Shortest secret {@link envSecret} accepts. */
const SECRET_MIN_LENGTH = 32;

/** What `FIELD_ENCRYPTION_KEY` must hold, in the words of the keyring that consumes it. */
const FIELD_KEY_REASON = 'must be standard base64 of exactly 32 bytes';

/** What `FIELD_ENCRYPTION_KEY_ID` must match, in the words of the keyring that consumes it. */
const FIELD_KEY_ID_REASON = 'must match FIELD_KEY_ID_PATTERN';

// The largest `CAP_LLM_USD_PER_CITY_DAY` accepted: a ceiling keeps the cap's micro-dollar scale, which
// `decimalToMicros` derives and every spend reservation of AAP 0.5.6 compares against, an exact safe
// integer, so a cap no deployment could want fails startup rather than silently rounding.
const MAX_CAP_USD = 1_000_000;

/** A whole number: no sign, no fraction, no exponent, no `0x`. */
const INTEGER_PATTERN = /^\d+$/;

/** A non-negative decimal with an optional fraction. */
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/** A lowercase host name or IPv4 literal, without a port (AAP 0.5.6). */
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** The one-line form of a refused environment: `Invalid <process> environment: VAR (reason); …`. */
function envErrorMessage(process: EnvProcess, issues: readonly EnvIssue[]): string {
  const detail = issues.map((issue) => `${issue.variable} (${issue.reason})`).join('; ');
  return detail === ''
    ? `Invalid ${process} environment`
    : `Invalid ${process} environment: ${detail}`;
}

/**
 * Treat an empty string as absent, and trim whatever is left: compose renders a variable it does not
 * set as `""`, and an absent value must behave like an unset one.
 */
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

/** The options every builder accepts, beyond the ones of its variable type (AAP 0.6.2). */
export interface EnvFieldOptions {
  /**
   * The raw value to use when the variable is absent or empty. Applied before parsing, so a default is
   * validated exactly like a supplied value and a parsed variable keeps one shape.
   */
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

/**
 * The presence rule every builder shares: empty means absent, then the default, then the schema. A
 * required value passes a gate that reports an absent or empty one as `is required`, whatever message
 * the schema's own invalid-type issue would have carried — `z.url()` and `z.enum()`, for instance,
 * describe a missing value as an invalid value or an invalid option.
 */
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

/** A non-empty string variable (AAP 0.6.2): `max` reports the limit, `check` its own fixed reason. */
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

/**
 * A whole-number variable: digits only, so `1.5`, `1e3`, `+1` and `0x10` are refused rather than
 * quietly coerced, and never above `Number.MAX_SAFE_INTEGER` (AAP 0.6.2).
 */
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

/**
 * A non-negative decimal variable, refused beyond `maxFractionDigits` fraction digits (AAP 0.6.2). The
 * text comes back with the number so a caller scales it exactly, as {@link buildCommonEnv} does, instead
 * of multiplying a float.
 */
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

/** The fraction digits of a value that matched {@link DECIMAL_PATTERN}. */
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

/**
 * A URL variable restricted to the schemes the connection it configures can use, so an `http://` value
 * copied where a `postgresql://` one belongs fails startup instead of at first use.
 */
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

/**
 * The URL `value` names, or `undefined` when it does not parse. A schema's checks all run, so a
 * refinement still sees a value the format check already refused and must not throw on it.
 */
function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * An origin variable: an `http` or `https` URL with a host and nothing else, normalized to
 * `new URL(value).origin`. The CORS allowlist and the links the API builds need exactly an origin, so a
 * path, a query, a fragment or embedded credentials are refused (AAP 0.3.2, 0.6.2).
 */
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

/** Whether `value` is an `http` or `https` origin: a scheme, a host, and nothing else. */
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

/**
 * A variable restricted to a fixed set of values (AAP 0.6.2). The reason lists the vocabulary, so a
 * misspelled mode fails startup with the values it may hold and never echoes what was supplied.
 */
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

/**
 * A rule a process declares about its environment as a whole, beyond what a field can state: that a
 * variable is refused in a mode, or that a mode needs one. `./api.ts`, `./workers.ts` and `./modes.ts`
 * supply these (AAP 0.6.2).
 */
export type EnvGuard = (env: NormalizedEnv) => readonly EnvIssue[];

/**
 * Validate one process's environment and build its configuration (AAP 0.6.2, 0.11.2).
 *
 * The environment is normalized, then parsed by `z.object(shape)`, whose default strip mode ignores
 * every variable outside the process's scope — which is what keeps a variable belonging to another
 * process optional here. Every guard then runs over the normalized environment even when a field
 * already failed, and its findings are appended to the Zod issues in collection order with repeated
 * (variable, reason) pairs dropped: an operator must see every problem of a start attempt at once, and
 * Zod abandons object-level refinements once a child issue aborts, so a guard riding inside the shape
 * would report nothing in exactly the case that matters.
 *
 * @param process - the process being configured, named by any {@link EnvValidationError}.
 * @param shape - the raw shape of the process's schema.
 * @param raw - the raw environment, typically `process.env`.
 * @param guards - the process's cross-variable rules, run whatever the fields did.
 * @param build - turns the parsed values and the normalized environment into the process's config.
 * @throws EnvValidationError listing every issue, when anything at all was refused.
 */
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
  if (!parsed.success) {
    throw new EnvValidationError(process, findings);
  }
  if (findings.length > 0) {
    throw new EnvValidationError(process, findings);
  }
  return deepFreeze(build(parsed.data, env));
}

/** Drop repeated (variable, reason) pairs, keeping the first of each in collection order. */
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

/** Recursively freeze a configuration, so nothing a process reads can change underneath it. */
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

/**
 * The variables `api` and `workers` both read (AAP 0.6.2, first scope row): the database and cache
 * endpoints, the field-encryption key and its id, the analytics salt, the log level, the call and
 * language-model caps, and the two mode selectors `./modes.ts` expands into the credentials and
 * endpoints a mode needs. `LOG_LEVEL` and the caps carry defaults; `TELEPHONY_MODE` and `LLM_PROVIDER`
 * do not, because compose supplies `off` and `fake` explicitly and a process must never silently reach
 * a real provider. `APP_ENV` is the vocabulary of {@link AppEnv}, read from `AppEnv.options` so the mode
 * list has one definition in `packages/shared`, and validated here rather than by the shared schema so
 * a missing mode reports `is required` like every other required variable.
 */
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

/**
 * The configuration `api` and `workers` share (AAP 0.6.2). Scalar values keep their variable names, so
 * `keyringFromEnv` in `../crypto/field-encryption.ts` and the queue connection take this object as it
 * stands; the two modes are not repeated because `./modes.ts` reads their parsed values instead.
 */
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

/**
 * Build the configuration `api` and `workers` share (AAP 0.6.2), from the process's parsed values and
 * its normalized environment. `values` carries both groups of the process's schema, and the test-only
 * gate reads `env.APP_ENV` — the value {@link testOnlyIssues} judges — so the guard and the built
 * configuration can never disagree.
 */
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

// Micro-dollars from a decimal that matched `DECIMAL_PATTERN`, by string arithmetic: `'25'` is
// 25,000,000 and `'0.000001'` is 1. Multiplying the float would round a cap by a micro-dollar, and the
// spend reservation of AAP 0.5.6 compares against exactly this number.
function decimalToMicros(text: string): number {
  const [whole = '0', fraction = ''] = text.split('.');
  const padded = `${fraction}000000`.slice(0, 6);
  return Number(whole) * 1_000_000 + Number(padded);
}

/**
 * The variables only a test environment may set (AAP 0.6.2, the `APP_ENV=test` scope row): whether the
 * test issuer's registry root is accepted, the token guarding the `/test/*` routes, and the host names
 * the crawler may reach inside the test network (AAP 0.5.1, 0.5.6).
 */
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

/**
 * The test-only switches, resolved (AAP 0.6.2). Everything is off outside `test` — `false`, no token, no
 * host — so a configuration that reached production by mistake still cannot accept the test issuer,
 * expose the test-control routes or let the crawler into a private network.
 */
export interface EnvTestOnlyConfig {
  readonly zkAllowTestIssuer: boolean;
  readonly testControlToken: string | null;
  readonly crawlAllowPrivateHosts: readonly string[];
}

/**
 * Report a test-only variable that is set outside `test` (AAP 0.5.1, 0.6.2): one issue per present
 * variable, whatever its value, so an operator sees every variable to remove rather than the first. An
 * absent or invalid `APP_ENV` counts as outside `test`, which is what makes the API refuse to start in
 * production with test control enabled.
 */
export function testOnlyIssues(env: NormalizedEnv): EnvIssue[] {
  if (env.APP_ENV === 'test') {
    return [];
  }
  return TEST_ONLY_VARIABLES.filter((name) => env[name] !== undefined).map((name) => ({
    variable: name,
    reason: 'accepted only when APP_ENV=test',
  }));
}

/**
 * Build the resolved test-only configuration (AAP 0.6.2), from the parsed values and the normalized
 * `APP_ENV` — the value {@link testOnlyIssues} judges, so the guard and the configuration agree. Outside
 * `test` every switch is off however the variables were set, which is why this never throws where the
 * guard would already have refused the environment.
 */
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

/**
 * The seed's own environment (AAP 0.6.2): the deployment mode, the database it seeds, and the field
 * encryption key it writes console secrets and encrypted profile fields with.
 */
export type SeedEnv = Readonly<{
  APP_ENV: AppEnv;
  DATABASE_URL: string;
  FIELD_ENCRYPTION_KEY: string;
  FIELD_ENCRYPTION_KEY_ID: string;
}>;

/** The seed's schema: the four common variables `packages/db/seed/seed.ts` reads, under common rules. */
const SEED_ENV_SHAPE = {
  APP_ENV: COMMON_ENV_SHAPE.APP_ENV,
  DATABASE_URL: COMMON_ENV_SHAPE.DATABASE_URL,
  FIELD_ENCRYPTION_KEY: COMMON_ENV_SHAPE.FIELD_ENCRYPTION_KEY,
  FIELD_ENCRYPTION_KEY_ID: COMMON_ENV_SHAPE.FIELD_ENCRYPTION_KEY_ID,
} as const;

/**
 * Validate and load the seed's environment (AAP 0.6.2). It has no guards: its schema is the whole rule,
 * because the seed reaches no provider and holds no mode of its own.
 *
 * @param raw - the raw environment; `process.env` unless a test supplies a record.
 * @throws EnvValidationError listing every issue, when any of the four variables is unusable.
 */
export function loadSeedEnv(raw: RawEnv = process.env): SeedEnv {
  return loadEnvironment('seed', SEED_ENV_SHAPE, raw, [], (values) => ({
    APP_ENV: values.APP_ENV,
    DATABASE_URL: values.DATABASE_URL,
    FIELD_ENCRYPTION_KEY: values.FIELD_ENCRYPTION_KEY,
    FIELD_ENCRYPTION_KEY_ID: values.FIELD_ENCRYPTION_KEY_ID,
  }));
}
