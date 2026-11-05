/**
 * The error envelope every failing route answers with, and the typed error the domain throws into
 * it (AAP 0.5.4, AAP 0.11.1).
 *
 * `registerErrorHandling` is called on the root Fastify instance, so its handler covers every
 * encapsulated module: a child instance inherits the root error handler unless it sets its own, and
 * no module does. The order of the checks inside that handler is load-bearing, and each step below
 * names what it must precede.
 *
 * Nothing about a failure leaves the process beyond the envelope's code, its message and, for an
 * unexpected error, the request id: no stack trace, no request body, no header, no token, no email
 * address, no coordinate, no message body (AAP 0.11.1). The original error reaches pino through its
 * `err` serializer, which is the only place it is recorded.
 */

import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

import {
  ERROR_STATUS,
  type ErrorCode,
  type ErrorEnvelope,
  type ErrorFrame,
} from '@tablemate/shared';

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

// Type-only, and taken from the module that builds the instance rather than from this file's
// dependency whitelist: it is the one declaration of the app's type in the plan, it is erased at
// compile time, and it reads nothing from `app.ts` at runtime.
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
 * Installs the error envelope on the instance `app.ts` builds (AAP 0.11.1). Both handlers are
 * synchronous: a returned promise would be awaited by Fastify, and nothing here waits for anything.
 */
export function registerErrorHandling(app: App): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    const failure = classifyFailure(error, request);

    if (ERROR_STATUS[failure.code] >= SERVER_FAULT_STATUS) {
      // Our own defect, logged with pino's `err` serializer so the cause is in the log and only
      // there. A response that failed its own schema is a defect with a name of its own, so an
      // operator can tell it from an unexpected throw.
      const message = isResponseSerializationError(error)
        ? 'response_serialization_failed'
        : 'request_failed';
      request.log.error({ err: error, code: failure.code }, message);
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
