/**
 * The pino logger every Node process in the workspace writes through (AAP 0.3.2, 0.11.1).
 *
 * AAP 0.3.2 makes redaction part of the security architecture: "pino redaction removes
 * authorization headers, secrets, booking fields, coordinates and email addresses". AAP 0.11.1
 * lists the logging points and requires "pino with a request id on every API log line". Both
 * come from the options built here, so no process has to remember a path list, and a name added
 * to {@link LOGGER_REDACT_PATHS} disappears from `api`, `workers` and the seed at once.
 *
 * Redaction removes object fields only — pino never rewrites the message string. A caller must
 * therefore keep personal data out of `msg` and pass it as a field the path list covers: an auth
 * event logs its outcome without the email address, and a proof result logs the public outputs
 * and no signals beyond that (AAP 0.11.1).
 *
 * Two vocabularies feed the list, because a protected value reaches a line under either of them: the
 * camelCase field names the workspace's own models and DTOs use, and the `UPPER_SNAKE_CASE` keys of
 * the environment schemas, which the built configuration keeps under the variables' own names. The
 * list reaches {@link REDACTION_WRAPPER_DEPTH} wrappers deep and no further, pino's wildcard matching
 * one level with no recursive form, so a caller holding a deeper structure logs the protected values
 * themselves rather than the whole wrapper.
 *
 * Nothing here reads `process.env`: the level and the mode arrive as parameters from the scoped
 * environment schemas under `src/env/`, and only `process.stdout.isTTY` is inspected, to decide
 * whether a human is watching the output.
 */

import { fileURLToPath } from 'node:url';

import { pino } from 'pino';
import type { DestinationStream, Logger, LoggerOptions } from 'pino';

import type { AppEnv } from '@tablemate/shared';

/**
 * The levels `LOG_LEVEL` may hold, in pino's severity order (AAP 0.6.2).
 *
 * `src/env/common.ts` validates `LOG_LEVEL` with `z.enum(LOG_LEVELS)` (default `info`), so a
 * misspelled level fails startup instead of silently falling back to pino's own default.
 */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** One of {@link LOG_LEVELS}: what {@link createLogger} accepts and what `LOG_LEVEL` parses to. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The censor written in place of a redacted value (AAP 0.3.2). A marked value rather than an
 * empty one, so a log reader can tell a withheld field from one that was never logged.
 */
export const LOGGER_REDACT_CENSOR = '[redacted]';

/**
 * Credential-carrying header names, under both parents a header object is logged at.
 * `sec-websocket-protocol` is the only channel a browser socket's bearer access token travels on: the
 * browser WebSocket API cannot set an `authorization` header on the handshake, so the client sends
 * the token in the subprotocol list and every later frame depends on it.
 */
const REDACTED_HEADER_NAMES = [
  'authorization',
  'cookie',
  'x-venue-secret',
  'x-lodging-secret',
  'x-twilio-signature',
  'stripe-signature',
  'x-test-control-token',
  'sec-websocket-protocol',
] as const;

/** The parents a header object appears under: Fastify's request log, and a bare `headers` field. */
const HEADER_PARENTS = ['req.headers', 'headers'] as const;

/**
 * Field names whose values are personal data, a credential or a position (AAP 0.3.2, 0.11.1): email
 * addresses, names and booking details, message bodies, coordinates, and the secrets the payment,
 * telephony, language-model and test-control integrations sign with. The rest of the list covers the
 * protected classes of the AAP 0.5.2 inventory: the tier-1 profile free text (`nickname`, `bio`), the
 * ciphertext families (`emailCiphertext`, `deliveryTokenCiphertext`, `secretCiphertext`,
 * `bookingNameCiphertext`, `bookingReferenceCiphertext`, `fullNameCiphertext`,
 * `externalContactCiphertext`), the lookup and token hashes (`emailLookupHash`, `secretLookupHash`,
 * `tokenHash`, `refreshTokenHash`), the Stripe identifiers (`stripeCustomerId`, `paymentIntentId`,
 * `currentPaymentIntentId`), the call transcript and its summary, the dispute and report free text
 * (`reason`), the pseudonymous re-identifiers (`actorHash`, `pairKey`) and the raw webhook bytes kept
 * on the request for signature verification (`rawBody`).
 *
 * The families beside those cover what the names above leave out: the stored profile photo and the
 * base64 the client sends and receives (`webp`, `photoBase64`), the hash a rotated refresh token is
 * compared against (`previousRefreshTokenHash`), the payment-setup credentials a setup response
 * carries (`setupIntentClientSecret`, `ephemeralKeySecret`), the built configuration's test-control
 * credential (`testControlToken`, the camelCase name beside its `TEST_CONTROL_TOKEN` environment
 * key) and the provider error text stored on a payment operation (`lastError`), whose provenance no
 * caller can vouch for.
 *
 * Two families are deliberately NOT covered. The circuit's public values — `nullifierSalt`,
 * `pubkeyHash`, `aliasHash` and `modulusBase64` — are public by construction, and AAP 0.11.1 lets
 * a proof verification result log its public outputs, so censoring them would hide the line that
 * logging point exists to write. A bare `code` stays free for the same reason: the venue's
 * six-digit check-in code is derived per request and never stored, while error codes and Prisma
 * codes are logged under that name, so no path can tell the two apart.
 *
 * An invariant for the call sites that log these shapes: several of the names above are ordinary
 * words a machine-readable value may legitimately want, and censoring such a value costs the line its
 * whole point. A code that has to be read back — a menu-pipeline drop reason, a call-dispatch
 * decision, a retry outcome — is therefore logged under a name this list does not cover
 * (`dropReason`, `blockedReason`, `decision`, `outcome`), never by widening the list to let one name
 * through. The message string is no substitute either: redaction rewrites object fields and never the
 * message.
 */
const REDACTED_FIELD_NAMES = [
  'email',
  'fullName',
  'externalContact',
  'bookingName',
  'bookingReference',
  'body',
  'lat',
  'lng',
  'latitude',
  'longitude',
  'coords',
  'secret',
  'secretKey',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'authToken',
  'webhookSecret',
  'clientSecret',
  'setupIntentClientSecret',
  'ephemeralKeySecret',
  'testControlToken',
  'password',
  'nickname',
  'bio',
  'photoBase64',
  'webp',
  'emailCiphertext',
  'deliveryTokenCiphertext',
  'secretCiphertext',
  'bookingNameCiphertext',
  'bookingReferenceCiphertext',
  'fullNameCiphertext',
  'externalContactCiphertext',
  'emailLookupHash',
  'secretLookupHash',
  'tokenHash',
  'refreshTokenHash',
  'previousRefreshTokenHash',
  'stripeCustomerId',
  'paymentIntentId',
  'currentPaymentIntentId',
  'transcript',
  'summary',
  'lastError',
  'reason',
  'actorHash',
  'pairKey',
  'rawBody',
] as const;

/**
 * Credential-bearing environment keys, redacted beside the field names because the built
 * configuration carries them under the variables' own names. AAP 0.11.1 makes environment variables
 * `UPPER_SNAKE_CASE`, and AAP 0.6.2 has each process validate only its own scope, so the object
 * `loadEnvironment` returns holds `DATABASE_URL` and `REDIS_URL` (connection strings carrying a
 * password), `FIELD_ENCRYPTION_KEY` and its id, the salts and pepper every lookup hash is keyed
 * with, the signing secrets, and the payment, telephony, language-model, mail, push and test-control
 * credentials. One startup line logging that configuration would otherwise print all of them, which
 * is what AAP 0.3.2 ("Logs") and 0.12.2 (secrets only from environment variables) forbid.
 */
const REDACTED_ENV_KEY_NAMES = [
  'DATABASE_URL',
  'REDIS_URL',
  'FIELD_ENCRYPTION_KEY',
  'FIELD_ENCRYPTION_KEY_ID',
  'ANALYTICS_SALT',
  'NULLIFIER_SALT',
  'EXPERIMENT_SALT',
  'JWT_SECRET',
  'EMAIL_LOOKUP_PEPPER',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_ACCOUNT_SID',
  'LLM_API_KEY',
  'TEST_CONTROL_TOKEN',
  'SMTP_URL',
  'EXPO_ACCESS_TOKEN',
] as const;

/**
 * How many wrappers above a protected name the list still reaches. A pino wildcard matches exactly
 * one level and pino has no recursive wildcard, which is why a bound exists at all. Four wrappers
 * cover the shapes the workspace logs: a model row or a DTO, Fastify's `req.body`, a job payload's
 * `data`, a nested `payload.user`, and the built configuration's `testOnly` group. A protected value
 * nested deeper than this is NOT covered, so a caller logging a deeper structure passes the protected
 * values themselves rather than the whole wrapper.
 */
const REDACTION_WRAPPER_DEPTH = 4;

/**
 * The prefixes a protected name gets a path under, one per depth the list reaches: the bare name at
 * depth 0, then one `*.` segment per wrapper up to {@link REDACTION_WRAPPER_DEPTH}. Derived from the
 * bound, so the paths and the number cannot drift apart.
 */
const REDACTION_DEPTH_PREFIXES: readonly string[] = Array.from(
  { length: REDACTION_WRAPPER_DEPTH + 1 },
  (_unused, depth) => '*.'.repeat(depth),
);

/** The paths {@link LOGGER_REDACT_PATHS} is built from, in the order pino receives them. */
function redactPaths(): string[] {
  const headers = HEADER_PARENTS.flatMap((parent) =>
    REDACTED_HEADER_NAMES.map((name) => headerPath(parent, name)),
  );
  // The two vocabularies the workspace logs protected values under: the camelCase field names its
  // own objects use, and the `UPPER_SNAKE_CASE` keys the built configuration keeps.
  const names = [...REDACTED_FIELD_NAMES, ...REDACTED_ENV_KEY_NAMES];
  const fields = REDACTION_DEPTH_PREFIXES.flatMap((prefix) =>
    names.map((name) => `${prefix}${name}`),
  );
  // The response cookie is the one header a response object carries as a credential.
  return [...headers, 'res.headers["set-cookie"]', ...fields];
}

/**
 * A header path under `parent`: a dotted segment for a name that is a JavaScript identifier, and
 * bracket notation for a hyphenated one (`x-venue-secret`), which is the spelling AAP 0.11.1
 * names and the one that stays valid for a key holding a dot or any other character.
 */
function headerPath(parent: string, name: string): string {
  return IDENTIFIER.test(name) ? `${parent}.${name}` : `${parent}["${name}"]`;
}

/** A JavaScript identifier: what pino accepts as the dotted form of a path segment. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Every path pino censors at any level, frozen so a caller cannot widen or narrow redaction for
 * the processes that share it (AAP 0.3.2, 0.11.1). Exported so `apps/api/src/app.ts` can hand
 * the same list to Fastify if it ever configures Fastify's own logger instead of the instance
 * {@link createLogger} returns.
 */
export const LOGGER_REDACT_PATHS: readonly string[] = Object.freeze(redactPaths());

/**
 * A pino logger, re-exported so a consumer can type one without depending on pino directly
 * (AAP 0.8.1). Exported from this module alone, so the workspace has a single `Logger` name.
 */
export type { Logger } from 'pino';

/** What {@link createLogger} needs to build a logger (AAP 0.3.2, 0.11.1). */
export interface CreateLoggerOptions {
  /** The service name, written as the `service` binding on every line: `api`, `workers`, `seed`. */
  name: string;
  /** The level to log at, from the validated `LOG_LEVEL`. */
  level: LogLevel;
  /** The deployment mode; `production` never loads the pretty transport. */
  appEnv: AppEnv;
  /**
   * A destination to write JSON lines to instead of stdout. Tests supply a capturing stream and
   * read the lines back; supplying one also suppresses the pretty transport.
   */
  destination?: DestinationStream;
}

/**
 * Build the process logger: JSON on stdout, redacted, stamped with the service name and an ISO
 * time (AAP 0.3.2, 0.11.1).
 *
 * @param options - the service name, the validated level, the deployment mode, and an optional
 * capturing destination.
 * @returns a `Logger` whose every line carries `service`, an ISO `time`, and the censored form
 * of any field {@link LOGGER_REDACT_PATHS} covers.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level,
    // `base` replaces pino's pid/hostname bindings. pino folds its own `name` option into a
    // supplied `base`, so passing both would print the service name twice.
    base: { service: options.name },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...LOGGER_REDACT_PATHS], censor: LOGGER_REDACT_CENSOR },
    // Serializers stay at pino's defaults, which is what keeps the standard `err` serializer
    // that turns an Error into name, message and stack.
  };

  const transport = prettyTransportTarget(options.appEnv, options.destination !== undefined);
  if (transport !== undefined) {
    loggerOptions.transport = {
      target: transport,
      options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    };
  }

  return options.destination === undefined
    ? pino(loggerOptions)
    : pino(loggerOptions, options.destination);
}

/**
 * The `pino-pretty` entry point to load, or `undefined` to write plain JSON to stdout.
 *
 * Pretty output is for a human at a local terminal, so all four must hold: the mode is not
 * `production`, no destination was supplied, stdout is a TTY, and `pino-pretty` resolves.
 * `pino-pretty` is a devDependency and the runtime images install production dependencies only,
 * so the resolve sits in `try/catch`: a module that is not there means JSON, never a crash.
 */
function prettyTransportTarget(appEnv: AppEnv, hasDestination: boolean): string | undefined {
  if (appEnv === 'production' || hasDestination || process.stdout.isTTY !== true) {
    return undefined;
  }
  try {
    // A test runner may omit `import.meta.resolve` or install a shim with no resolver (tsx does
    // the latter); both mean JSON output rather than a crash.
    if (typeof import.meta.resolve !== 'function') {
      return undefined;
    }
    return fileURLToPath(import.meta.resolve('pino-pretty'));
  } catch {
    return undefined;
  }
}

/**
 * Bind a request id to `logger`, under the `reqId` binding Fastify writes its own request lines
 * with (AAP 0.11.1). Work that outlives the request — the outbox dispatch after a commit, a
 * settlement run — keeps the id this way.
 */
export function withRequestId(logger: Logger, requestId: string): Logger {
  return logger.child({ reqId: requestId });
}

/**
 * Bind a BullMQ job id to `logger`, so every line a worker processor writes names the job it
 * belongs to (AAP 0.5.6).
 */
export function withJobId(logger: Logger, jobId: string): Logger {
  return logger.child({ jobId });
}
