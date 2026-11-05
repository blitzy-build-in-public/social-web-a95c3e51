/**
 * The console API client: the two secret-authenticated reads the venue and lodging consoles make,
 * and the session storage that holds the operator-issued secret (AAP 0.5.1, 0.5.4, 0.8.1).
 *
 * Three invariants live here:
 *
 *   - The console holds no secret of its own (AAP 0.3.2). An operator types one in, it is kept in
 *     `sessionStorage` for the life of the tab, and it travels as the single header the route reads
 *     -- `X-Venue-Secret` or `X-Lodging-Secret` (AAP 0.5.4). It never reaches a URL, a query
 *     string, a cookie, `localStorage`, a log line or a rendered message.
 *   - Only the server derives a check-in code. `GET /v1/venue/check-in-code` answers the current
 *     `{ code, expiresAt }`, and the gap between the API's `Date` response header -- exposed
 *     cross-origin for this purpose (AAP 0.3.2) -- and the device clock is what the console's
 *     countdown is measured from, so device clock skew moves the countdown and never validation.
 *   - A failure is a {@link ConsoleApiError} carrying one `kind`, never a raw `Response`. Both
 *     routes answer the shared envelope `{ error: { code, message } }` (AAP 0.5.4), read with
 *     `ErrorEnvelope` rather than a shape redeclared here.
 *
 * Browser-only, like the rest of `apps/venue-console/src`: no Node built-in, no `Buffer`, no
 * `process`, and the only environment value read is `VITE_API_URL`, resolved at module load so a
 * misconfigured build fails loudly instead of requesting the page's own origin.
 */
import {
  ErrorEnvelope,
  LODGING_SECRET_HEADER,
  LodgingConsoleStats,
  VENUE_SECRET_HEADER,
  VenueCodeResponse,
} from '@tablemate/shared';
import type { ErrorCode } from '@tablemate/shared';

import { estimateOffsetMs, parseHttpDate } from './server-time.ts';

/** The status a rejected secret answers with (AAP 0.5.4). */
const UNAUTHORIZED_STATUS = 401;

/** The route answering one venue's current check-in code (AAP 0.5.4). */
const VENUE_CODE_PATH = '/venue/check-in-code';

/** The route answering one lodging's leaderboard standing (AAP 0.5.4). */
const LODGING_STATS_PATH = '/lodging-console/stats';

/** The message a build without `VITE_API_URL` fails with, at load (AAP 0.6.2). */
const MISSING_ORIGIN_MESSAGE = 'VITE_API_URL is not configured';

/** The trailing slashes a configured API origin is stripped of at load (AAP 0.6.2). */
const TRAILING_SLASHES = /\/+$/;

/** The message a request that never reached the API answers with. */
const NETWORK_MESSAGE = 'The API could not be reached.';

/** The message a cancellation falls back to where the platform's abort error is not an `Error`. */
const ABORT_MESSAGE = 'The request was cancelled.';

/** The message a rejected secret answers with. */
const UNAUTHORIZED_MESSAGE = 'The API rejected the secret.';

/**
 * The deadline every console request runs under, in milliseconds (AAP 0.11.1).
 *
 * AAP 0.11.1 bounds each external call the plan lists; the console's poll of the code route is the
 * same kind of call made from the browser, and without a deadline a request the API accepts and
 * never answers leaves the screen pending on an expired code, with no error and no recovery short
 * of a page reload.
 */
const REQUEST_DEADLINE_MS = 10_000;

/** The message a request that outlived that deadline answers with (AAP 0.11.1). */
const DEADLINE_MESSAGE = 'The API did not answer before the request deadline.';

/**
 * Resolves the API origin this console calls (AAP 0.6.2).
 *
 * `vite.config.ts` validates and normalizes `VITE_API_URL`; both are repeated here so this module's
 * contract does not depend on another file's, and a bundle built without it fails at load rather
 * than issuing a request against the page's own origin.
 *
 * The origin is returned trimmed and without a trailing slash, because {@link API_BASE} appends
 * `/v1` by concatenation: `http://host/` would otherwise build `http://host//v1/venue/check-in-code`
 * -- a path no route matches, which breaks every console request. A value that holds nothing but
 * slashes is as absent as a blank one and throws, rather than resolving to a path on the page's own
 * origin.
 *
 * @param value - `import.meta.env.VITE_API_URL`, untyped by `vite/client` and therefore narrowed.
 * @returns The origin as configured, trimmed and with trailing slashes removed.
 * @throws Error when it is absent, non-string, blank or nothing but slashes.
 */
function resolveApiOrigin(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(MISSING_ORIGIN_MESSAGE);
  }
  const origin = value.trim().replace(TRAILING_SLASHES, '');
  if (origin.length === 0) {
    throw new Error(MISSING_ORIGIN_MESSAGE);
  }
  return origin;
}

/** `VITE_API_URL` read once at load, so every request of a page calls the same origin. */
const apiOrigin: unknown = import.meta.env.VITE_API_URL;

/** The versioned base both console routes hang off (AAP 0.5.4). */
export const API_BASE = `${resolveApiOrigin(apiOrigin)}/v1`;

/** Which console a secret belongs to (AAP 0.5.4). */
export type ConsoleKind = 'venue' | 'lodging';

/**
 * The `sessionStorage` key each console's secret lives under (AAP 0.3.2).
 *
 * The keys are namespaced, so a venue secret and a lodging secret can be held in one tab without
 * either overwriting the other; `sessionStorage` rather than `localStorage` is what keeps a secret
 * alive for no longer than the tab that holds it.
 */
const SECRET_KEYS: Record<ConsoleKind, string> = {
  venue: 'tablemate.console.venueSecret',
  lodging: 'tablemate.console.lodgingSecret',
};

/**
 * The secret currently held for one console, or `null` when there is none (AAP 0.5.4).
 *
 * An empty stored value reads as `null`, so a blanked entry is indistinguishable from an absent one
 * and the caller asks the operator for a secret either way. Storage that is unavailable -- private
 * browsing, a blocked cookie policy, a sandboxed frame -- reads as `null` too, and the console then
 * works for the current page only.
 *
 * @param kind - The console whose secret to read.
 * @returns The stored secret, or `null` when none is usable.
 */
export function readSecret(kind: ConsoleKind): string | null {
  try {
    const value = window.sessionStorage.getItem(SECRET_KEYS[kind]);
    return value === null || value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

/**
 * Holds a secret for the life of the tab (AAP 0.3.2, 0.5.4).
 *
 * Storage being unavailable is not an error the operator sees: the secret stays in the component
 * that typed it and every request of this page still carries it, so only the next reload loses it.
 *
 * @param kind - The console the secret belongs to.
 * @param secret - The operator-issued secret, exactly as typed.
 */
export function saveSecret(kind: ConsoleKind, secret: string): void {
  try {
    window.sessionStorage.setItem(SECRET_KEYS[kind], secret);
  } catch {
    // See `readSecret`: unavailability costs the next reload alone, never correctness.
  }
}

/**
 * Drops the secret of one console (AAP 0.5.4).
 *
 * A route answering `401` calls this, so a secret the server has rejected -- a rotated or revoked
 * one -- is not resubmitted by the next poll of the same page.
 *
 * @param kind - The console whose secret to discard.
 */
export function clearSecret(kind: ConsoleKind): void {
  try {
    window.sessionStorage.removeItem(SECRET_KEYS[kind]);
  } catch {
    // See `readSecret`: nothing is left behind to undo when storage is unavailable.
  }
}

/** How a console request failed (AAP 0.5.4). */
export type ConsoleErrorKind = 'unauthorized' | 'http' | 'network' | 'invalid_response';

/** The failure details {@link ConsoleApiError} carries when the server supplied them. */
export interface ConsoleApiErrorDetails {
  /** The HTTP status of the answer, when one arrived. */
  status?: number;
  /** The code of the shared error envelope, when the answer carried a parsable one. */
  code?: ErrorCode;
}

/**
 * The error every request in this module raises (AAP 0.5.4).
 *
 * `kind` is what a screen branches on: `unauthorized` means the server rejected the secret and
 * `clearSecret` has already dropped it, `http` is any other refusal, `network` is a request that
 * never reached the API or one that outlived its deadline unanswered, and `invalid_response` is an
 * answer this client cannot read. `message` is written for a developer reading a console log -- it
 * names the path and the status, and never the secret or any part of one -- and no screen renders
 * it.
 */
export class ConsoleApiError extends Error {
  /** Which failure this is. */
  readonly kind: ConsoleErrorKind;

  /** The HTTP status of the answer, when one arrived. */
  readonly status?: number;

  /** The envelope's code, when the answer carried a parsable envelope. */
  readonly code?: ErrorCode;

  constructor(kind: ConsoleErrorKind, message: string, details?: ConsoleApiErrorDetails) {
    super(message);
    this.name = 'ConsoleApiError';
    this.kind = kind;
    // Assigned only when known: `exactOptionalPropertyTypes` keeps absent and `undefined` distinct.
    if (details?.status !== undefined) {
      this.status = details.status;
    }
    if (details?.code !== undefined) {
      this.code = details.code;
    }
    Object.setPrototypeOf(this, ConsoleApiError.prototype);
  }
}

/**
 * One GET against the API, authenticated by a console secret (AAP 0.5.4).
 *
 * The request is a plain CORS `GET` with `credentials: 'omit'` and `cache: 'no-store'`: the console
 * sends a secret and reads a live code or a live score, so nothing about it may be cached or
 * attributed to cookies, and the API's CORS configuration is what admits the two secret headers
 * (AAP 0.3.2). `sentAtMs` and `receivedAtMs` bracket the round trip for {@link estimateOffsetMs}.
 *
 * Every request is bounded by {@link REQUEST_DEADLINE_MS}, composed with the caller's `signal` so
 * either one can end it (AAP 0.11.1). A caller that unmounts still cancels exactly as it did, and a
 * request that outlives its deadline fails as a `ConsoleApiError` of kind `network` with a message
 * of its own -- the deadline signal's state is what classifies it, so a browser that rejects a
 * timed-out `fetch` with an `AbortError`-named error is never read as the caller's cancellation.
 *
 * A redirect is refused (`redirect: 'error'`) rather than followed: the request carries a console
 * secret, and the Fetch standard strips only `Authorization` on a cross-origin redirect, so a
 * redirect issued by the API origin would hand `X-Venue-Secret` or `X-Lodging-Secret` to whatever
 * origin it named. The refusal is a failed request like any other and reaches the caller as a
 * `ConsoleApiError` of kind `network`; it stays a hard failure on purpose and must not be softened
 * to a followed or manually handled redirect while this request carries a secret.
 *
 * @param kind - The console the secret belongs to, which selects the header name.
 * @param path - The route path below {@link API_BASE}.
 * @param secret - The operator-issued secret; never placed in the URL or in an error message.
 * @param signal - Optional cancellation, e.g. from a component unmounting; composed with the
 * request deadline so either ends the request.
 * @returns The response and its parsed body.
 * @throws ConsoleApiError for every failure, a request that outlived its deadline included; a
 * cancellation is rethrown as it arrived.
 */
async function request(
  kind: ConsoleKind,
  path: string,
  secret: string,
  signal?: AbortSignal,
): Promise<{ body: unknown; response: Response; sentAtMs: number; receivedAtMs: number }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    [kind === 'venue' ? VENUE_SECRET_HEADER : LODGING_SECRET_HEADER]: secret,
  };

  // One deadline per request (AAP 0.11.1), composed with the caller's own signal: whichever aborts
  // first ends the request, and the two stay distinguishable in the catch below.
  const deadline = AbortSignal.timeout(REQUEST_DEADLINE_MS);
  const composedSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);

  const sentAtMs = Date.now();
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      // Refused rather than followed, so the console secret never travels to a redirect target.
      redirect: 'error',
      headers,
      signal: composedSignal,
    });
  } catch (error) {
    throw failureFor(error, signal, deadline);
  }
  const receivedAtMs = Date.now();

  const text = await readBody(response, signal, deadline);

  if (!response.ok) {
    const code = envelopeCode(text);
    if (response.status === UNAUTHORIZED_STATUS) {
      clearSecret(kind);
      throw new ConsoleApiError('unauthorized', UNAUTHORIZED_MESSAGE, {
        status: UNAUTHORIZED_STATUS,
        ...(code === null ? {} : { code }),
      });
    }
    throw new ConsoleApiError('http', `${path} answered ${String(response.status)}`, {
      status: response.status,
      ...(code === null ? {} : { code }),
    });
  }

  return { body: parseJsonBody(text, path), response, sentAtMs, receivedAtMs };
}

/**
 * The venue's current check-in code and the offset between the server clock and this device
 * (AAP 0.5.4, 0.5.7).
 *
 * The code is the server's, never derived in the console: the console renders it and asks again at
 * `expiresAt`. `offsetMs` is re-estimated from this response's `Date` header and is `null` when that
 * header was missing or unparsable, so the caller keeps the offset it already had rather than
 * trusting the device clock.
 *
 * @param secret - The venue's operator-issued secret, sent as `X-Venue-Secret`.
 * @param signal - Optional cancellation.
 * @returns The code and the freshly estimated offset, or `null` for the offset.
 * @throws ConsoleApiError, with kind `unauthorized` when the secret was rejected -- in which case
 * the stored secret has already been dropped.
 */
export async function fetchVenueCode(
  secret: string,
  signal?: AbortSignal,
): Promise<{ data: VenueCodeResponse; offsetMs: number | null }> {
  const { body, response, sentAtMs, receivedAtMs } = await request(
    'venue',
    VENUE_CODE_PATH,
    secret,
    signal,
  );

  const parsed = VenueCodeResponse.safeParse(body);
  if (!parsed.success) {
    throw new ConsoleApiError(
      'invalid_response',
      `${VENUE_CODE_PATH} answered a body that is not the code shape`,
    );
  }

  const serverDateMs = parseHttpDate(response.headers.get('Date'));
  return {
    data: parsed.data,
    offsetMs:
      serverDateMs === null ? null : estimateOffsetMs({ serverDateMs, sentAtMs, receivedAtMs }),
  };
}

/**
 * One lodging's leaderboard standing and its 90-day trend (AAP 0.5.4).
 *
 * @param secret - The lodging's operator-issued secret, sent as `X-Lodging-Secret`.
 * @param signal - Optional cancellation.
 * @returns The stats body, validated against the shared shape.
 * @throws ConsoleApiError, with kind `unauthorized` when the secret was rejected -- in which case
 * the stored secret has already been dropped.
 */
export async function fetchLodgingStats(
  secret: string,
  signal?: AbortSignal,
): Promise<LodgingConsoleStats> {
  const { body } = await request('lodging', LODGING_STATS_PATH, secret, signal);

  const parsed = LodgingConsoleStats.safeParse(body);
  if (!parsed.success) {
    throw new ConsoleApiError(
      'invalid_response',
      `${LODGING_STATS_PATH} answered a body that is not the stats shape`,
    );
  }
  return parsed.data;
}

/**
 * The body of a received response as text (AAP 0.5.4). Reading it can fail on a connection that
 * drops mid-body, which is a network failure like any other; a read the caller aborted is its own
 * cancellation, and one cut short by the request deadline is the deadline's failure.
 */
async function readBody(
  response: Response,
  signal: AbortSignal | undefined,
  deadline: AbortSignal,
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw failureFor(error, signal, deadline);
  }
}

/**
 * The error a rejected `fetch` or body read becomes (AAP 0.5.4).
 *
 * A cancellation is not a failure: the abort is returned as it arrived, so the caller's own abort
 * handling -- `signal.aborted` or an `AbortError` name -- is the only thing that reacts to it. A
 * `DOMException` satisfies `Error` at runtime although the DOM lib does not declare it, so the
 * rethrow narrows rather than rebuilds, and the fallback covers only a platform that rejects with
 * something else.
 *
 * An expired deadline is a failure: the API took the request and never answered it, which is a
 * network failure, and it carries a message of its own so a screen can tell a stalled API from an
 * unreachable one (AAP 0.11.1).
 */
function failureFor(error: unknown, signal: AbortSignal | undefined, deadline: AbortSignal): Error {
  if (isAbort(error, signal, deadline)) {
    return error instanceof Error ? error : new Error(ABORT_MESSAGE);
  }
  return new ConsoleApiError('network', deadline.aborted ? DEADLINE_MESSAGE : NETWORK_MESSAGE);
}

/**
 * Whether a rejection is the caller's own cancellation rather than a failed or timed-out request.
 *
 * The deadline signal's own `aborted` state is what separates the two, because a browser rejects a
 * deadline abort with the same `AbortError` name it uses for a caller's abort: the name alone would
 * report a stalled request as the caller's cancellation. The caller's signal is consulted first, so
 * a request the caller abandoned as the deadline expired stays its cancellation.
 */
function isAbort(error: unknown, signal: AbortSignal | undefined, deadline: AbortSignal): boolean {
  return signal?.aborted === true || (!deadline.aborted && thrownName(error) === 'AbortError');
}

/** The `name` a thrown value carries, or `''` when it carries none (a string, a number, a null). */
function thrownName(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return '';
  }
  const name: unknown = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

/**
 * The error code of a body that is the shared envelope, or `null` for anything else: an empty body,
 * text that is not JSON, or a value the envelope rejects (AAP 0.5.4). It never throws, because a
 * failing response is classified by its status even when its body is unreadable.
 */
function envelopeCode(text: string): ErrorCode | null {
  if (text.length === 0) {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const envelope = ErrorEnvelope.safeParse(body);
  return envelope.success ? envelope.data.error.code : null;
}

/**
 * The parsed body of a successful response (AAP 0.5.4). A body that is not JSON -- an nginx error
 * page, a truncated response -- is an answer this client does not understand, and becomes
 * `invalid_response` rather than reaching a route's schema.
 *
 * @param text - The body as text.
 * @param path - The route it came from, named in the error only.
 * @returns The body, untyped until a route schema validates it.
 * @throws ConsoleApiError('invalid_response') when the text is not JSON.
 */
function parseJsonBody(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConsoleApiError('invalid_response', `${path} answered a body that is not JSON`);
  }
}
