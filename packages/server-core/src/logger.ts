import { fileURLToPath } from 'node:url';

import { pino } from 'pino';
import type { DestinationStream, Logger, LoggerOptions } from 'pino';

import type { AppEnv } from '@tablemate/shared';
/** The levels `LOG_LEVEL` may hold, in pino's severity order. */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
/** One of {@link LOG_LEVELS}: what {@link createLogger} accepts and what `LOG_LEVEL` parses to. */
export type LogLevel = (typeof LOG_LEVELS)[number];
/** The censor written in place of a redacted value. */
export const LOGGER_REDACT_CENSOR = '[redacted]';
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
const HEADER_PARENTS = ['req.headers', 'headers'] as const;
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
const REDACTION_WRAPPER_DEPTH = 4;
const REDACTION_DEPTH_PREFIXES: readonly string[] = Array.from(
  { length: REDACTION_WRAPPER_DEPTH + 1 },
  (_unused, depth) => '*.'.repeat(depth),
);
function redactPaths(): string[] {
  const headers = HEADER_PARENTS.flatMap((parent) =>
    REDACTED_HEADER_NAMES.map((name) => headerPath(parent, name)),
  );
  // The two vocabularies the workspace logs protected values under: the camelCase field names its own objects use, and the `UPPER_SNAKE_CASE` keys the built configuration keeps.
  const names = [...REDACTED_FIELD_NAMES, ...REDACTED_ENV_KEY_NAMES];
  const fields = REDACTION_DEPTH_PREFIXES.flatMap((prefix) =>
    names.map((name) => `${prefix}${name}`),
  );
  // The response cookie is the one header a response object carries as a credential.
  return [...headers, 'res.headers["set-cookie"]', ...fields];
}
function headerPath(parent: string, name: string): string {
  return IDENTIFIER.test(name) ? `${parent}.${name}` : `${parent}["${name}"]`;
}
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Every path pino censors at any level, frozen so a caller cannot widen or narrow redaction for the processes that share it. */
export const LOGGER_REDACT_PATHS: readonly string[] = Object.freeze(redactPaths());
const LOG_TRUNCATION_MARKER = '…[truncated]';
const MAX_LOG_MESSAGE_LENGTH = 500;
const EMAIL_ADDRESS_RE =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;
/** The backstop for text of unknown provenance: the credentials, keys and email addresses an error message can quote, removed before the message is logged (AAP 0.3.2, 0.11.1). */
export function sanitizeLogMessage(text: string): string {
  const sanitized = text
    // 1. Connection-string credentials: the userinfo of any `scheme://` URL.
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, `$1${LOGGER_REDACT_CENSOR}@`)
    // 2. PEM private-key blocks.
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      LOGGER_REDACT_CENSOR,
    )
    // 3. Stripe secret and restricted keys, and webhook signing secrets.
    .replace(/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}\b/g, LOGGER_REDACT_CENSOR)
    .replace(/\bwhsec_[A-Za-z0-9]{8,}\b/g, LOGGER_REDACT_CENSOR)
    // 4. Bearer credentials and the JWS triples our own access tokens are.
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${LOGGER_REDACT_CENSOR}`)
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, LOGGER_REDACT_CENSOR)
    // 5. OpenAI-style keys, Twilio API-key SIDs and bare 32-hex tokens (a 64-hex digest stays
    //    readable: it is a digest, not a credential).
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, LOGGER_REDACT_CENSOR)
    .replace(/\bSK[0-9a-fA-F]{32}\b/g, LOGGER_REDACT_CENSOR)
    .replace(/(?<![0-9a-fA-F])[0-9a-fA-F]{32}(?![0-9a-fA-F])/g, LOGGER_REDACT_CENSOR)
    // 6. Email addresses last: an error message can quote one whole.
    .replace(EMAIL_ADDRESS_RE, LOGGER_REDACT_CENSOR);
  return sanitized.length > MAX_LOG_MESSAGE_LENGTH
    ? `${sanitized.slice(0, MAX_LOG_MESSAGE_LENGTH)}${LOG_TRUNCATION_MARKER}`
    : sanitized;
}
/** A pino logger, re-exported so a consumer can type one without depending on pino directly (AAP 0.8.1). */
export type { Logger } from 'pino';
/** What {@link createLogger} needs to build a logger (AAP 0.3.2, 0.11.1). */
export interface CreateLoggerOptions {
  /** The service name, written as the `service` binding on every line: `api`, `workers`, `seed`. */
  name: string;
  /** The level to log at, from the validated `LOG_LEVEL`. */
  level: LogLevel;
  /** The deployment mode; `production` never loads the pretty transport. */
  appEnv: AppEnv;
  /** A destination to write JSON lines to instead of stdout. Tests supply a capturing stream and read the lines back; supplying one also suppresses the pretty transport. */
  destination?: DestinationStream;
}
/** Build the process logger: JSON on stdout, redacted, stamped with the service name and an ISO time (AAP 0.3.2, 0.11.1). */
export function createLogger(options: CreateLoggerOptions): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level,
    // `base` replaces pino's pid/hostname bindings. pino folds its own `name` option into a supplied `base`, so passing both would print the service name twice.
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
function prettyTransportTarget(appEnv: AppEnv, hasDestination: boolean): string | undefined {
  if (appEnv === 'production' || hasDestination || process.stdout.isTTY !== true) {
    return undefined;
  }
  try {
    // A test runner may omit `import.meta.resolve` or install a shim with no resolver (tsx does the latter); both mean JSON output rather than a crash.
    if (typeof import.meta.resolve !== 'function') {
      return undefined;
    }
    return fileURLToPath(import.meta.resolve('pino-pretty'));
  } catch {
    return undefined;
  }
}
/** Bind a BullMQ job id to `logger`, so every line a worker processor writes names the job it belongs to (AAP 0.5.6). */
export function withJobId(logger: Logger, jobId: string): Logger {
  return logger.child({ jobId });
}
