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

/** Credential-carrying header names, under both parents a header object is logged at. */
const REDACTED_HEADER_NAMES = [
  'authorization',
  'cookie',
  'x-venue-secret',
  'x-lodging-secret',
  'x-twilio-signature',
  'stripe-signature',
  'x-test-control-token',
] as const;

/** The parents a header object appears under: Fastify's request log, and a bare `headers` field. */
const HEADER_PARENTS = ['req.headers', 'headers'] as const;

/**
 * Field names whose values are personal data, a credential or a position (AAP 0.3.2, 0.11.1):
 * email addresses, names and booking details, message bodies, coordinates, and the secrets the
 * payment, telephony, language-model and test-control integrations sign with.
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
  'password',
] as const;

/**
 * The depths a sensitive field is redacted at. A pino wildcard matches exactly one level, so
 * each name needs its own path at depth 0 and one under a single and a double wildcard — enough
 * for the shapes the workspace logs, such as Fastify's `req.body` or a job payload's `data`.
 */
const FIELD_DEPTH_PREFIXES = ['', '*.', '*.*.'] as const;

/** The paths {@link LOGGER_REDACT_PATHS} is built from, in the order pino receives them. */
function redactPaths(): string[] {
  const headers = HEADER_PARENTS.flatMap((parent) =>
    REDACTED_HEADER_NAMES.map((name) => headerPath(parent, name)),
  );
  const fields = FIELD_DEPTH_PREFIXES.flatMap((prefix) =>
    REDACTED_FIELD_NAMES.map((name) => `${prefix}${name}`),
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
