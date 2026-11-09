/**
 * The error envelope every failing route answers with, and the typed error the domain throws into it
 * (AAP 0.5.4, 0.11.1).
 *
 * `registerErrorHandling` is called on the root Fastify instance, so its handler covers every encapsulated
 * module: a child instance inherits the root error handler unless it sets its own, and no module does. The order
 * of the checks inside that handler is load-bearing, and each step below names what it must precede.
 *
 * Nothing about a failure leaves the process beyond the envelope's code, its message and, for an unexpected
 * error, the request id: no stack trace, no request body, no header, no token, no email address, no coordinate,
 * no message body (AAP 0.11.1). The one place a failure is recorded is the 5xx log line, and what reaches pino
 * there is the narrowed record {@link loggedFailure} builds — a name, the error's own short code and a message
 * passed through the shared `sanitizeLogMessage`, never the thrown object, whose message and stack pino writes as
 * strings that key-based redaction cannot rewrite (AAP 0.3.2).
 */
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

import { sanitizeLogMessage } from '@tablemate/server-core';
import {
  ERROR_STATUS,
  type ErrorCode,
  type ErrorEnvelope,
  type ErrorFrame,
} from '@tablemate/shared';

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

// Type-only, so nothing of `app.ts` is read at run time and no import cycle reaches the root.
import type { App } from '../app.ts';

/**
 * What a route may tell the error handler about its own failures (AAP 0.5.4).
 *
 * A route whose contract fixes an error code names it here, so the handler answers with that code
 * without knowing the route: `POST /itinerary-proofs` sets `validationErrorCode: 'proof_malformed'`
 * for a submission that does not match `ProofSubmission`, `POST /auth/magic-link` sets
 * `invalid_email`, and `PUT /me/profile` sets `bodyTooLargeCode: 'photo_too_large'` for a body past
 * its 8 MB limit. A route that names neither answers `invalid_field` (400).
 */
declare module 'fastify' {
  interface FastifyContextConfig {
    /** 400 code for a request-schema failure on this route (default `invalid_field`). */
    validationErrorCode?: ErrorCode;
    /** Code for `FST_ERR_CTP_BODY_TOO_LARGE` on this route (default `invalid_field`). */
    bodyTooLargeCode?: ErrorCode;
  }
}

/** The status at and above which a rejection is a defect on our side rather than the caller's. */
const SERVER_FAULT_STATUS = 500;

/** The code a route-schema failure and an oversized body answer with unless the route names its own. */
const DEFAULT_REQUEST_ERROR: ErrorCode = 'invalid_field';

/**
 * The prefix of Fastify's body-parsing and content-type failures: an unparseable or empty JSON body,
 * an invalid content length, an unsupported media type. `FST_ERR_CTP_BODY_TOO_LARGE` starts with it
 * too, which is why the size rule is tried before this one.
 */
const CONTENT_TYPE_ERROR_PREFIX = 'FST_ERR_CTP_';

/** Fastify's client failures that its content-type codes do not cover: a non-Zod schema failure and a malformed URL. */
const OTHER_CLIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'FST_ERR_VALIDATION',
  'FST_ERR_BAD_URL',
]);

/**
 * The longest an error's `name` may be and still be logged; an error name is a short token.
 */
const MAX_ERROR_NAME_LENGTH = 64;

/** How many entries of an error's cause chain a log line carries. */
const MAX_CAUSE_ENTRIES = 3;

/**
 * The shape an error's own `code` must have to be logged under that key: a short token such as
 * `P2002` or `FST_ERR_CTP_INVALID_MEDIA_TYPE`. A value-shape check rather than a vocabulary check,
 * so a third-party string that is not a code — a message, a query fragment, a token — can never ride
 * out under `code`.
 */
const LOGGABLE_ERROR_CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** One failure, resolved to the code and the message the envelope carries. */
interface Failure {
  readonly code: ErrorCode;
  readonly message: string;
}

/**
 * The default message for an error code: its underscores read as spaces, first letter capitalized,
 * full stop appended — `token_invalid` becomes `Token invalid.`. Derived rather than tabulated, so a
 * code added to the shared vocabulary has a message the day it is added, and a caller with something
 * more specific to say passes its own. It never carries user data.
 */
function defaultFailureMessage(code: ErrorCode): string {
  const words = code.replaceAll('_', ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

/**
 * The message an unexpected failure answers with: the request id, so the one log line that holds the
 * cause can be found from the answer, and nothing else (AAP 0.11.1).
 */
function internalFailureMessage(requestId: string): string {
  return `Internal error (request ${requestId}).`;
}

/**
 * A failure whose meaning the code names: the shared error code, and the message that reaches the
 * envelope.
 *
 * The constructor takes the code and an optional message rather than the `(code, httpStatus,
 * message)` signature AAP 0.11.1 writes out, because the shared `ERROR_STATUS` gives each code
 * exactly one status (AAP 0.5.4). Deriving the status from the code here means a route can never
 * answer a code with a status the contract does not give it, and {@link AppError.httpStatus} still
 * exposes the number.
 *
 * The message is answered to the client as written: the short sentence the envelope should hold for
 * that code, never a value the caller supplied. `options.cause` attaches the underlying failure for
 * the log alone; the envelope does not carry it.
 */
export class AppError extends Error {
  /** The shared error code, answered as `error.code`. */
  readonly code: ErrorCode;
  /** The status the code is answered with, from the shared `ERROR_STATUS`. */
  readonly httpStatus: number;
  constructor(code: ErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? defaultFailureMessage(code), options);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = ERROR_STATUS[code];
    // The class must stay `instanceof`-correct when this module and a copy of it are both loaded in
    // one process (a test double, an ESM/CJS duplicate), which is also why `isAppError` duck-types.
    Object.setPrototypeOf(this, new.target.prototype);
  }
  /**
   * The same number as {@link AppError.httpStatus}, under the name Fastify and `@fastify/rate-limit`
   * read: a thrown error's `statusCode` decides the answer when nothing else does.
   */
  get statusCode(): number {
    return this.httpStatus;
  }
}

/** The throwable for an error code: `throw appError('venue_not_partner')`. */
export function appError(code: ErrorCode, message?: string): AppError {
  return new AppError(code, message);
}

/**
 * Whether a thrown value is an {@link AppError}. A second copy of this class fails `instanceof`, so
 * a value that names itself `AppError` and carries a code from the shared vocabulary is accepted
 * too: the code and the message are the only things the handler reads off it.
 */
export function isAppError(error: unknown): error is AppError {
  if (error instanceof AppError) return true;
  if (readField(error, 'name') !== 'AppError') return false;
  const code = readField(error, 'code');
  return typeof code === 'string' && Object.hasOwn(ERROR_STATUS, code);
}

/**
 * A refusal for the chat socket, carrying one error code and message like the REST envelope, plus the
 * meetup the refusal concerns when the caller knows it (AAP 0.5.4). `chat-ws.ts` sends it for
 * `messaging_locked` and `blocked` on access, `invalid_field` on a frame the shared schema rejects,
 * `rate_limited` on a write over the per-user limit, and `token_invalid` on a write attempted after
 * account deletion.
 */
export function errorFrame(code: ErrorCode, message?: string, meetupId?: string): ErrorFrame {
  // The optional field is spread in rather than passed as `undefined`, so a frame that concerns no
  // known meetup omits the key instead of carrying an empty one.
  return {
    type: 'error',
    code,
    message: message ?? defaultFailureMessage(code),
    ...(meetupId === undefined ? {} : { meetupId }),
  };
}

/**
 * What a log line may carry about one failure: the fields {@link loggedFailure} copies off a thrown
 * value, and nothing else.
 */
interface LoggedFailure {
  /** The error's name, or `Error` when the value carries no usable one. */
  readonly name: string;
  /** The error's own `code`, when its value has the shape of a code rather than of text. */
  readonly code?: string;
  /** The error's message, after {@link sanitizeLogMessage}. */
  readonly message?: string;
  /** The first {@link MAX_CAUSE_ENTRIES} entries of the error's cause chain, each of this shape. */
  readonly causes?: LoggedFailure[];
}

/**
 * The record the error handler logs for a failure, in place of the thrown object (AAP 0.3.2,
 * 0.11.1).
 *
 * pino's `err` serializer writes a message and a stack as strings and copies an error's enumerable
 * keys, and pino's redaction is key-based: it rewrites the value at a path and never text inside one.
 * A raw error therefore reaches the log verbatim, which is how a provider error quoting a token, a
 * Prisma error naming a parameter or a URL carrying a secret gets written. This record carries the
 * name, the error's own short `code` and a sanitized message, plus the head of its cause chain, and
 * nothing else of the value: no stack, no `meta`, no other enumerable key, no `clientVersion`.
 */
function loggedFailure(error: unknown): LoggedFailure {
  return narrowFailure(error, MAX_CAUSE_ENTRIES);
}

/**
 * Reduces one thrown value to a loggable record, then does the same for at most `remaining` entries
 * of its cause chain — the singular `cause` an `Error` sets, which is where a provider's own failure
 * and its text sit.
 */
function narrowFailure(error: unknown, remaining: number): LoggedFailure {
  const cause = remaining > 0 ? readField(error, 'cause') : undefined;
  const code = loggedCode(error);
  const message = loggedMessage(error);
  return {
    name: loggedName(error),
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
    // The key is plural on purpose: pino folds a singular `cause` into the serialized message, which
    // would emit the causes' text as one string again, past the sanitizing above.
    ...(isLoggableCause(cause) ? { causes: [narrowFailure(cause, remaining - 1)] } : {}),
  };
}

/** An error's `name` when it is the short token an error name is, `Error` otherwise. */
function loggedName(error: unknown): string {
  const name = readField(error, 'name');
  return typeof name === 'string' && name.length > 0 && name.length <= MAX_ERROR_NAME_LENGTH
    ? name
    : 'Error';
}

/** The error's own `code`, when its value has the shape of a code rather than of text. */
function loggedCode(error: unknown): string | undefined {
  const code = readField(error, 'code');
  return typeof code === 'string' && LOGGABLE_ERROR_CODE_RE.test(code) ? code : undefined;
}

/** The error's message, sanitized, when the value carries a non-empty one. */
function loggedMessage(error: unknown): string | undefined {
  const message = readField(error, 'message');
  return typeof message === 'string' && message.length > 0
    ? sanitizeLogMessage(message)
    : undefined;
}

/** Whether a value is one a cause chain can be walked through, rather than a primitive. */
function isLoggableCause(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/**
 * Installs the error envelope on the instance `app.ts` builds (AAP 0.11.1). Both handlers are
 * synchronous: a returned promise would be awaited by Fastify, and nothing here waits for anything.
 */
export function registerErrorHandling(app: App): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    const failure = classifyFailure(error, request);
    if (ERROR_STATUS[failure.code] >= SERVER_FAULT_STATUS) {
      // Our own defect, logged with its cause and only there. A response that failed its own schema
      // is a defect with a name of its own, so an operator can tell it from an unexpected throw.
      const message = isResponseSerializationError(error)
        ? 'response_serialization_failed'
        : 'request_failed';
      // The narrowed record stands in for `{ err: error }`: pino's serializer writes a message and a
      // stack as strings and redaction never rewrites a string, so the raw object would put a
      // provider error quoting a token, a Prisma error naming a parameter or a URL carrying a secret
      // in the log verbatim (AAP 0.3.2, 0.11.1).
      request.log.error({ err: loggedFailure(error), code: failure.code }, message);
    } else {
      // The caller's mistake: the code and the status are enough to act on, and the original error is
      // deliberately not logged — it can hold the submitted body at this level.
      request.log.info({ code: failure.code }, 'request_rejected');
    }
    sendEnvelope(reply, failure.code, failure.message);
  });
  // A route that does not exist answers the same envelope a route's own 404 does, so a client parses
  // one shape for every failure (AAP 0.5.4).
  app.setNotFoundHandler((_request, reply) => {
    sendEnvelope(reply, 'not_found', 'Route not found.');
  });
}

/**
 * Writes the envelope and nothing else.
 *
 * The body is serialized here rather than handed over as an object: a route that declares a response
 * schema would otherwise have that schema applied to its error body — and would answer 500 for what
 * the handler has already decided is a 4xx. The headers already on the reply are kept, which is what
 * carries `Retry-After` and `x-ratelimit-*` set by `@fastify/rate-limit` before it threw:
 * `status` and `type` write their own header and reset nothing else.
 */
function sendEnvelope(reply: FastifyReply, code: ErrorCode, message: string): void {
  const envelope: ErrorEnvelope = { error: { code, message } };
  reply.type('application/json').status(ERROR_STATUS[code]).send(JSON.stringify(envelope));
}

/**
 * Resolves a thrown value to the code and the message the envelope carries, in the one order the
 * cases must be tried in.
 *
 * The tests overlap — a `FST_ERR_CTP_BODY_TOO_LARGE` also starts with the body-parse prefix, a route
 * that failed its schema also carries a 4xx status, and the response-serialization test matches any
 * error with a `method` field — so each step is tried before the step that would otherwise swallow
 * it.
 */
function classifyFailure(error: unknown, request: FastifyRequest): Failure {
  // 1. A failure the code names, including everything the auth and age guards raise, the rate
  //    limiter's own `rate_limited`, its store's `service_unavailable`, and the raw-body parser's
  //    `invalid_field`. First, so an `AppError`'s code and message always win over any shape it
  //    happens to share.
  if (isAppError(error)) return { code: error.code, message: error.message };
  // 2. A request that failed its route's schema, before the general 4xx rule below, because such a
  //    failure carries status 400 and the route's own code must still win.
  if (hasZodFastifySchemaValidationErrors(error)) {
    return {
      code: request.routeOptions.config.validationErrorCode ?? DEFAULT_REQUEST_ERROR,
      message: schemaFailureMessage(error),
    };
  }
  const code = fastifyErrorCode(error);
  const status = fastifyStatus(error);
  // 3. A body past the route's limit, before the body-parse rule that its code also matches.
  //    `PUT /me/profile` answers `photo_too_large` here (AAP 0.5.4).
  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return {
      code: request.routeOptions.config.bodyTooLargeCode ?? DEFAULT_REQUEST_ERROR,
      message: 'Request body too large.',
    };
  }
  // 4. Every other client mistake: a body the parser refused or a media type it does not handle, a
  //    non-Zod schema failure, a malformed URL, a `SyntaxError` from a body parser, or an error a
  //    plugin already marked 4xx. The two codes whose meaning the status alone gets wrong are read
  //    first.
  if (isClientFailure(error, code, status)) {
    if (status === 429) return { code: 'rate_limited', message: 'Too many requests.' };
    if (status === 404) return { code: 'not_found', message: 'Route not found.' };
    return { code: DEFAULT_REQUEST_ERROR, message: 'Invalid request.' };
  }
  // 5. Nothing above fits: a defect on our side. The caller learns the request id and nothing else.
  return { code: 'internal_error', message: internalFailureMessage(request.id) };
}

/**
 * Whether a failure that is not an `AppError` is the caller's mistake rather than ours.
 *
 * A `SyntaxError` is only treated as one when it carries status 400, so a `SyntaxError` raised by our
 * own code stays a 500. The 4xx check ends below {@link SERVER_FAULT_STATUS}, so a plugin's 500 is
 * never reported as a rejection.
 */
function isClientFailure(
  error: unknown,
  code: string | undefined,
  status: number | undefined,
): boolean {
  if (
    code !== undefined &&
    (code.startsWith(CONTENT_TYPE_ERROR_PREFIX) || OTHER_CLIENT_ERROR_CODES.has(code))
  ) {
    return true;
  }
  if (error instanceof SyntaxError && status === 400) return true;
  return status !== undefined && status >= 400 && status < SERVER_FAULT_STATUS;
}

/**
 * Names where the request failed validation and the first issue's path, both of which hold keys of
 * our own schema: `Invalid body at /startsAt (invalid_type).`
 *
 * The submitted value is never read, and neither is the issue's own message or its `params` — a
 * `params` object can hold the keys a caller sent. Fastify's `instancePath` for a failure at the
 * root of the payload is `/`.
 */
function schemaFailureMessage(error: {
  readonly validation: readonly { readonly keyword: string; readonly instancePath: string }[];
  readonly validationContext?: string;
}): string {
  const location = error.validationContext ?? 'request';
  const issue = error.validation[0];
  if (issue === undefined) return `Invalid ${location}.`;
  const where =
    issue.instancePath === '' || issue.instancePath === '/' ? '' : ` at ${issue.instancePath}`;
  return `Invalid ${location}${where} (${issue.keyword}).`;
}

/**
 * Reads one field off a thrown value without assuming its class: an error handler is called with
 * whatever a handler or a plugin threw, so Fastify's own failures are recognized by the fields they
 * set rather than by the class they were built from.
 */
function readField(error: unknown, key: string): unknown {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

/** The `code` Fastify's error type carries, when the thrown value sets one. */
function fastifyErrorCode(error: unknown): FastifyError['code'] | undefined {
  const code = readField(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

/** The `statusCode` Fastify's error type carries, when the thrown value sets one. */
function fastifyStatus(error: unknown): FastifyError['statusCode'] {
  const status = readField(error, 'statusCode');
  return typeof status === 'number' ? status : undefined;
}
