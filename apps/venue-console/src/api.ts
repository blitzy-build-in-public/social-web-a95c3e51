/**
 * The console API client: the two secret-authenticated reads the venue and lodging consoles make, and the session storage
 * holding the operator-issued secret (AAP 0.5.1, 0.5.4, 0.8.1).
 *
 * Three invariants live here: the console holds no secret of its own (AAP 0.3.2), so both routes read a single header,
 * `X-Venue-Secret` or `X-Lodging-Secret`, and never a URL, query string, cookie, `localStorage`, log line or rendered
 * message; only the server derives a check-in code, so the gap between the API's `Date` header — exposed cross-origin for
 * this countdown (AAP 0.3.2) — and the device clock moves a clock and never a validation; and a failure is a
 * {@link ConsoleApiError} carrying one `kind`, never a raw `Response`.
 *
 * Browser-only: no Node built-in, no `Buffer`, no `process`, and the only environment value read is `VITE_API_URL`,
 * resolved at module load so a misconfigured build fails loudly instead of requesting the page's own origin.
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

/** The status a rejected secret answers with, and the two routes both consoles read (AAP 0.5.4). */
const UNAUTHORIZED_STATUS = 401;
const VENUE_CODE_PATH = '/venue/check-in-code';
const LODGING_STATS_PATH = '/lodging-console/stats';

/** The message a build without `VITE_API_URL` fails with, at load (AAP 0.6.2). */
const MISSING_ORIGIN_MESSAGE = 'VITE_API_URL is not configured';

/** The trailing slashes a configured API origin is stripped of at load (AAP 0.6.2). */
const TRAILING_SLASHES = /\/+$/;

/** The messages an unreachable API, a cancellation and a rejected secret report (AAP 0.5.4). */
const NETWORK_MESSAGE = 'The API could not be reached.';
const ABORT_MESSAGE = 'The request was cancelled.';
const UNAUTHORIZED_MESSAGE = 'The API rejected the secret.';

/**
 * The deadline every console request runs under, in milliseconds (AAP 0.11.1): without one, a request
 * the API accepts and never answers leaves the screen pending on an expired code, with no error and no
 * recovery short of a page reload.
 */
const REQUEST_DEADLINE_MS = 10_000;

/** The message a request that outlived that deadline reports (AAP 0.11.1). */
const DEADLINE_MESSAGE = 'The API did not answer before the request deadline.';

/**
 * Resolves the API origin this console calls (AAP 0.6.2), repeating the validation `vite.config.ts` does so this module's
 * contract does not depend on another file's. The origin comes back trimmed and without a trailing slash, because
 * {@link API_BASE} appends `/v1` by concatenation: `http://host/` would otherwise build a path no route matches. A value
 * that holds nothing but slashes is as absent as a blank one and throws, rather than resolving to a path on the page's own
 * origin.
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
 * The `sessionStorage` key each console's secret lives under (AAP 0.3.2): namespaced, so a venue secret
 * and a lodging secret can share one tab, and `sessionStorage` rather than `localStorage` keeps a
 * secret alive for no longer than the tab that holds it.
 */
const SECRET_KEYS: Record<ConsoleKind, string> = {
  venue: 'tablemate.console.venueSecret',
  lodging: 'tablemate.console.lodgingSecret',
};

/**
 * The secret currently held for one console, or `null` when there is none (AAP 0.5.4).
 *
 * An empty stored value reads as `null`, so a blanked entry is indistinguishable from an absent one; storage that is
 * unavailable — private browsing, a blocked cookie policy, a sandboxed frame — reads as `null` too, and the console then
 * works for the current page only, which is why neither this nor {@link saveSecret} throws.
 */
export function readSecret(kind: ConsoleKind): string | null {
  try {
    const value = window.sessionStorage.getItem(SECRET_KEYS[kind]);
    return value === null || value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

/** Holds a secret for the life of the tab (AAP 0.3.2, 0.5.4): unavailability costs the next reload
 * alone, because the secret stays in the component that typed it. */
export function saveSecret(kind: ConsoleKind, secret: string): void {
  try {
    window.sessionStorage.setItem(SECRET_KEYS[kind], secret);
  } catch {
    // See `readSecret`: unavailability costs the next reload alone, never correctness.
  }
}

/**
 * Drops the secret of one console (AAP 0.5.4). A route answering `401` calls this, so a secret the
 * server has rejected -- a rotated or revoked one -- is not resubmitted by the next poll.
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
  status?: number;
  code?: ErrorCode;
}

/**
 * The error every request in this module raises (AAP 0.5.4). `kind` is what a screen branches on: `unauthorized` means the
 * server rejected the secret and `clearSecret` has already dropped it, `http` is any other refusal, `network` is a request
 * that never reached the API or one that outlived its deadline unanswered, and `invalid_response` is an answer this client
 * cannot read. `message` names the path and the status, never the secret, and no screen renders it.
 */
export class ConsoleApiError extends Error {
  readonly kind: ConsoleErrorKind;
  readonly status?: number;
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
 * One GET against the API, authenticated by a console secret (AAP 0.5.4) and bounded by {@link REQUEST_DEADLINE_MS},
 * composed with the caller's `signal` so either one can end it (AAP 0.11.1); the deadline signal's own state is what
 * classifies an expired request, so a browser that rejects a timed-out `fetch` with an `AbortError`-named error is never
 * read as the caller's cancellation.
 *
 * It is a plain CORS `GET` with `credentials: 'omit'` and `cache: 'no-store'`: the console sends a secret and reads a live
 * code or a live score, so nothing about it may be cached or attributed to cookies.
 *
 * A redirect is refused (`redirect: 'error'`) rather than followed: the request carries a console secret, and the Fetch
 * standard strips only `Authorization` on a cross-origin redirect, so a redirect issued by the API origin would hand
 * `X-Venue-Secret` or `X-Lodging-Secret` to whatever origin it named. It stays a hard failure on purpose and must not be
 * softened to a followed or manually handled redirect while this request carries a secret.
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
 * The venue's current check-in code and the offset between the server clock and this device (AAP 0.5.4, 0.5.7). The code is
 * the server's, never derived in the console: the console renders it and asks again at `expiresAt`. `offsetMs` is
 * re-estimated from this response's `Date` header and is `null` when that header was missing or unparsable, so the caller
 * keeps the offset it already had rather than trusting the device clock.
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
 * One lodging's leaderboard standing and its 90-day trend (AAP 0.5.4), validated against the shared
 * shape. An `unauthorized` rejection has already dropped the stored secret.
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

/** The body of a received response as text (AAP 0.5.4). Reading it can fail on a connection that drops
 * mid-body, which is a network failure like any other; a cancellation or an expired deadline keeps its
 * own classification (see {@link failureFor}). */
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
 * The error a rejected `fetch` or body read becomes (AAP 0.5.4). A cancellation is not a failure: the
 * abort is returned as it arrived, so the caller's own abort handling is the only thing that reacts to
 * it. A `DOMException` satisfies `Error` at runtime although the DOM lib does not declare it, so the
 * rethrow narrows rather than rebuilds, and the fallback covers only a platform that rejects with
 * something else. An expired deadline is a network failure with a message of its own, so a screen can
 * tell a stalled API from an unreachable one (AAP 0.11.1).
 */
function failureFor(error: unknown, signal: AbortSignal | undefined, deadline: AbortSignal): Error {
  if (isAbort(error, signal, deadline)) {
    return error instanceof Error ? error : new Error(ABORT_MESSAGE);
  }
  return new ConsoleApiError('network', deadline.aborted ? DEADLINE_MESSAGE : NETWORK_MESSAGE);
}

/**
 * Whether a rejection is the caller's own cancellation rather than a failed or timed-out request.
 * The deadline signal's own `aborted` state is what separates the two, because a browser rejects a
 * deadline abort with the same `AbortError` name it uses for a caller's abort; the caller's signal is
 * consulted first, so a request the caller abandoned as the deadline expired stays its cancellation.
 */
function isAbort(error: unknown, signal: AbortSignal | undefined, deadline: AbortSignal): boolean {
  return signal?.aborted === true || (!deadline.aborted && thrownName(error) === 'AbortError');
}

/** The `name` a thrown value carries, or `''` when it carries none. */
function thrownName(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return '';
  }
  const name: unknown = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

/** The error code of a body that is the shared envelope, or `null` for anything else: an empty body,
 * text that is not JSON, a value the envelope rejects (AAP 0.5.4). It never throws, because a failing
 * response is classified by its status even when its body is unreadable. */
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

/** The parsed body of a successful response (AAP 0.5.4). A body that is not JSON -- an nginx error
 * page, a truncated response -- becomes `invalid_response` rather than reaching a route's schema; the
 * path is named in the error only. */
function parseJsonBody(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConsoleApiError('invalid_response', `${path} answered a body that is not JSON`);
  }
}
