/**
 * The scripted telephony simulator's Twilio REST client: the transport the twilio 6.2.0 SDK dispatches through when
 * `TELEPHONY_MODE=simulator`, so automated call traffic never leaves the host (AAP 0.5.6, AAP 0.11.2).
 */

import { Buffer } from 'node:buffer';

import { TWILIO_SIMULATOR } from '@tablemate/server-core';
import type {
  TwilioHttpClient,
  TwilioHttpRequest,
  TwilioHttpResponse,
} from '@tablemate/server-core';
import type { TwilioCallStatus } from '@tablemate/shared';

/** A Twilio error body, the shape the SDK reads into a `RestException` (AAP 0.3.3). */
interface SimError {
  code: number;
  message: string;
}

/**
 * The one REST path family the SDK builds for `Calls` (AAP 0.3.3): a create or a list on
 * `/2010-04-01/Accounts/{AccountSid}/Calls.json`, and a fetch on `.../Calls/{CallSid}.json`.
 */
const CALLS_PATH =
  /^\/2010-04-01\/Accounts\/(?<accountSid>[^/]+)\/Calls(?:\.json|\/(?<callSid>[^/]+)\.json)$/;

/** A number in E.164, the only shape the product dispatches (AAP 0.5.6). */
const E164 = /^\+[1-9]\d{1,14}$/;

/** Twilio's "resource not found" code, for an unknown call or a path this router does not serve. */
const NOT_FOUND_CODE = 20404;

/**
 * The error bodies this router answers with, in Twilio's own words. `more_info` and `status` are derived from the code
 * and the HTTP status, so a message carries a parameter name and nothing else.
 */
const AUTHENTICATION_ERROR: SimError = { code: 20003, message: 'Authenticate' };
const INVALID_TO_ERROR: SimError = { code: 21211, message: "Invalid 'To' Phone Number" };
const INVALID_FROM_ERROR: SimError = { code: 21212, message: "Invalid 'From' Phone Number" };
const INVALID_URL_ERROR: SimError = { code: 21205, message: 'Url is not a valid URL' };
const INVALID_STATUS_CALLBACK_ERROR: SimError = {
  code: 21609,
  message: 'Invalid StatusCallback url',
};

/**
 * One call-create request as the SDK sent it (AAP 0.5.6), the parameters the simulator plays the call from.
 */
export interface SimCallCreateParams {
  /** The number to call, in E.164. */
  to: string;
  /** The caller id. */
  from: string;
  /** The URL Twilio fetches the ConversationRelay TwiML from, exactly as sent. */
  twimlUrl: string;
  /** The URL Twilio posts call-status callbacks to, exactly as sent. */
  statusCallbackUrl: string;
  /**
   * The `CallAttempt` id the caller put in the query of either URL — the only evidence that adopts a `dispatch_unknown`
   * attempt (AAP 0.3.2).
   */
  attemptId: string | null;
  /** The status events the call subscribed to, always as an array. */
  statusCallbackEvent: string[];
  statusCallbackMethod: string | null;
  /** Twilio recording. The product always sends `false` (AAP 0.5.6); `null` when unset. */
  record: boolean | null;
  /** The hard bound on the call, `CAP_CALL_SECONDS` (AAP 0.5.6). */
  timeLimit: number | null;
  /** Machine detection, always requested by this product (AAP 0.5.6). */
  machineDetection: string | null;
}

/**
 * One call as the Calls resource reports it (AAP 0.5.6), in the field names twilio 6.2.0 reads. It carries no error field:
 * an unroutable number arrives on the status callback instead (AAP 0.3.3), and `start_time` is `null` until the call starts.
 */
export interface SimCallResource {
  sid: string;
  account_sid: string;
  to: string;
  from: string;
  status: TwilioCallStatus;
  direction: 'outbound-api';
  answered_by: string | null;
  /** The call's length in seconds as a string, or `null` while it has not ended. */
  duration: string | null;
  start_time: string | null;
  end_time: string | null;
  date_created: string;
  date_updated: string;
  api_version: '2010-04-01';
  uri: string;
}

/** Which calls a list request asked for, from its `To`, `From` and `StartTime>` parameters. */
export interface SimCallListFilter {
  to?: string;
  from?: string;
  /** Calls that started at or after this instant. */
  startTimeAfter?: Date;
}

/**
 * The call store {@link handleTwilioRequest} answers from; `simulator.ts` implements it (AAP 0.5.6). Declared here rather
 * than in `simulator.ts` because that module value-imports this one, so the reverse import would close an ESM cycle.
 */
export interface SimCallTarget {
  /** Accept a call and start playing it. The SID it returns is the one an attempt adopts. */
  startCall(params: SimCallCreateParams): Promise<{ sid: string; status: 'queued' }>;
  /** The call with this SID, or `null` when it is unknown. */
  fetchCall(sid: string): SimCallResource | null;
  /** The calls matching a filter, newest first. */
  listCalls(filter: SimCallListFilter): SimCallResource[];
  /**
   * Whether the vendor refuses calls: the target's global switch, a scenario whose `vendor` is `down`, or a
   * `vendor-down` default.
   */
  isVendorDown(to?: string): boolean;
}

/**
 * The connection-refused error a vendor-down simulator answers a dispatch with (AAP 0.12.1 criterion 17). `ECONNREFUSED` is
 * what server-core's `classifyCallError` reads as a *definite* failure — the request provably never reached the provider — so
 * the caller releases the cap slot, leaves `attempts` untouched and requeues the task with backoff, where an *ambiguous*
 * failure would leave the attempt `dispatch_unknown` and never redial (AAP 0.3.2, AAP 0.5.3).
 */
export function vendorDownError(): Error {
  return Object.assign(new Error('connect ECONNREFUSED (voice simulator: vendor down)'), {
    code: 'ECONNREFUSED',
    errno: -111,
    syscall: 'connect',
  });
}

/**
 * Answer one Twilio REST request from `target` (AAP 0.5.6). Both the injected transport of
 * {@link createSimulatorHttpClient} and the simulator's HTTP server call this, so a request the SDK sends directly and one
 * it forwards to `VOICE_SIM_URL` are routed identically.
 */
export async function handleTwilioRequest(
  target: SimCallTarget,
  request: TwilioHttpRequest,
): Promise<TwilioHttpResponse> {
  const url = new URL(request.uri);
  const route = matchCallsRoute(request.method.toLowerCase(), url.pathname);
  const form = parseTwilioForm(request.data);
  const to = route?.kind === 'create' ? readText(form, 'To') : null;
  if (target.isVendorDown(to ?? undefined)) {
    throw vendorDownError();
  }
  if (!isSimulatorAuthenticated(request)) {
    return errorResponse(401, AUTHENTICATION_ERROR);
  }
  if (route === null) {
    return notFoundResponse(url.pathname);
  }
  if (route.kind === 'create') {
    const parsed = readCallParams(form);
    if ('error' in parsed) {
      return errorResponse(400, parsed.error);
    }
    const created = await target.startCall(parsed.params);
    return jsonResponse(
      201,
      callResource(created.sid, created.status, route.accountSid, parsed.params),
    );
  }
  if (route.kind === 'fetch') {
    const call = target.fetchCall(route.callSid);
    return call === null ? notFoundResponse(url.pathname) : jsonResponse(200, call);
  }
  return jsonResponse(200, callsPage(target, readQuery(url, request.params)));
}

/**
 * Read a Twilio form body into its fields (AAP 0.5.6): an `application/x-www-form-urlencoded` string, a `URLSearchParams`, or
 * the object the SDK hands an injected transport. Absent and empty values are dropped.
 */
export function parseTwilioForm(data: unknown): Record<string, string | string[]> {
  const form: Record<string, string | string[]> = {};
  for (const [key, raw] of formEntries(data)) {
    for (const value of formValues(raw)) {
      addFormValue(form, key, value);
    }
  }
  return form;
}

/**
 * The transport a simulator client is injected with (AAP 0.5.6, AAP 0.11.2): every REST request the SDK builds is answered
 * from `target`, with no network I/O.
 */
export function createSimulatorHttpClient(target: SimCallTarget): TwilioHttpClient {
  return { request: (request) => handleTwilioRequest(target, request) };
}

/** What one request addressed: a call's create, fetch or list form. */
type CallsRoute =
  | { kind: 'create'; accountSid: string }
  | { kind: 'fetch'; accountSid: string; callSid: string }
  | { kind: 'list'; accountSid: string };

/**
 * Match a request to the one `Calls` form it may address, or `null` for anything else — another resource, a method the product
 * never sends such as an update, or another account — which the caller answers with `404`.
 */
function matchCallsRoute(method: string, pathname: string): CallsRoute | null {
  const matched = CALLS_PATH.exec(pathname);
  const accountSid = matched?.groups?.accountSid;
  if (accountSid === undefined || accountSid !== TWILIO_SIMULATOR.accountSid) {
    return null;
  }
  const callSid = matched?.groups?.callSid;
  if (callSid !== undefined) {
    return method === 'get' ? { kind: 'fetch', accountSid, callSid } : null;
  }
  if (method === 'post') {
    return { kind: 'create', accountSid };
  }
  return method === 'get' ? { kind: 'list', accountSid } : null;
}

/**
 * Read a create request into {@link SimCallCreateParams}, or the error to answer with. The four parameters the product always
 * sends are required: an E.164 number and caller id, and absolute URLs for the TwiML fetch and the status callbacks.
 */
function readCallParams(
  form: Record<string, string | string[]>,
): { params: SimCallCreateParams } | { error: SimError } {
  const to = readText(form, 'To');
  if (to === null || !E164.test(to)) {
    return { error: INVALID_TO_ERROR };
  }
  const from = readText(form, 'From');
  if (from === null || !E164.test(from)) {
    return { error: INVALID_FROM_ERROR };
  }
  const twimlUrl = readText(form, 'Url');
  if (!isHttpUrl(twimlUrl)) {
    return { error: INVALID_URL_ERROR };
  }
  const statusCallbackUrl = readText(form, 'StatusCallback');
  if (!isHttpUrl(statusCallbackUrl)) {
    return { error: INVALID_STATUS_CALLBACK_ERROR };
  }
  return {
    params: {
      to,
      from,
      twimlUrl,
      statusCallbackUrl,
      attemptId: readAttemptId(twimlUrl, statusCallbackUrl),
      statusCallbackEvent: readList(form, 'StatusCallbackEvent'),
      statusCallbackMethod: readText(form, 'StatusCallbackMethod'),
      record: readFlag(form, 'Record'),
      timeLimit: readInteger(form, 'TimeLimit'),
      machineDetection: readText(form, 'MachineDetection'),
    },
  };
}

/**
 * A create response, as the SDK builds its call instance from it (AAP 0.5.6): the fields the product reads, `status` as
 * {@link SimCallTarget.startCall} reported it rather than a value fixed here, and no field the SDK would read as an error.
 */
function callResource(
  sid: string,
  status: TwilioCallStatus,
  accountSid: string,
  params: SimCallCreateParams,
): SimCallResource {
  const now = toRfc2822(new Date());
  return {
    sid,
    account_sid: accountSid,
    to: params.to,
    from: params.from,
    status,
    direction: 'outbound-api',
    answered_by: null,
    duration: null,
    start_time: null,
    end_time: null,
    date_created: now,
    date_updated: now,
    api_version: '2010-04-01',
    uri: `/2010-04-01/Accounts/${accountSid}/Calls/${sid}.json`,
  };
}

/**
 * One page of calls, as the SDK's `CallPage` reads it: the records under `calls`, the metadata keys it ignores, and a null
 * `next_page_uri`, which stops it paging on to a next page this simulator would answer with the same records again.
 */
function callsPage(
  target: SimCallTarget,
  query: Record<string, string | string[]>,
): Record<string, unknown> {
  const calls = target.listCalls(listFilter(query));
  const uri = `/2010-04-01/Accounts/${TWILIO_SIMULATOR.accountSid}/Calls.json?Page=0&PageSize=${calls.length}`;
  return {
    calls,
    first_page_uri: uri,
    next_page_uri: null,
    previous_page_uri: null,
    page: 0,
    page_size: calls.length,
    start: 0,
    end: calls.length === 0 ? 0 : calls.length - 1,
    uri,
  };
}

/** The `To`, `From` and `StartTime>` a list request filtered on, absent ones omitted. */
function listFilter(query: Record<string, string | string[]>): SimCallListFilter {
  const filter: SimCallListFilter = {};
  const to = readText(query, 'To');
  if (to !== null) {
    filter.to = to;
  }
  const from = readText(query, 'From');
  if (from !== null) {
    filter.from = from;
  }
  const startTimeAfter = parseDate(readText(query, 'StartTime>'));
  if (startTimeAfter !== null) {
    filter.startTimeAfter = startTimeAfter;
  }
  return filter;
}

/** The request's query parameters: those in the URI, then the SDK's own `params` over them. */
function readQuery(url: URL, params: object | undefined): Record<string, string | string[]> {
  const query = parseTwilioForm(url.search);
  for (const [key, value] of Object.entries(parseTwilioForm(params))) {
    for (const item of Array.isArray(value) ? value : [value]) {
      addFormValue(query, key, item);
    }
  }
  return query;
}

/** Whether a request authenticated as the simulator account, the only account that is answered. */
function isSimulatorAuthenticated(request: TwilioHttpRequest): boolean {
  const direct =
    request.username !== undefined && request.password !== undefined
      ? `${request.username}:${request.password}`
      : decodeBasicHeader(readHeader(request.headers, 'authorization'));
  if (direct === null) {
    return false;
  }
  const separator = direct.indexOf(':');
  return (
    separator >= 0 &&
    direct.slice(0, separator) === TWILIO_SIMULATOR.accountSid &&
    direct.slice(separator + 1) === TWILIO_SIMULATOR.authToken
  );
}

/**
 * The `username:password` an `Authorization: Basic …` header carries, or `null` when it is absent or not basic credentials.
 * The SDK sets the header itself on a request it forwards rather than passes to an injected transport.
 */
function decodeBasicHeader(header: string | undefined): string | null {
  if (header === undefined || !/^basic /i.test(header)) {
    return null;
  }
  return Buffer.from(header.slice('basic '.length), 'base64').toString('utf8');
}

/** One header by name, matched case-insensitively because header case is not preserved. */
function readHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

/** A Twilio error answer: the error body plus the code's documentation URL. */
function errorResponse(statusCode: number, error: SimError): TwilioHttpResponse {
  return jsonResponse(statusCode, {
    code: error.code,
    message: error.message,
    more_info: `https://www.twilio.com/docs/errors/${error.code}`,
    status: statusCode,
  });
}

/** Twilio's answer for an unknown call or an unserved path, naming the resource it looked for. */
function notFoundResponse(pathname: string): TwilioHttpResponse {
  return errorResponse(404, {
    code: NOT_FOUND_CODE,
    message: `The requested resource ${pathname} was not found`,
  });
}

/**
 * A JSON answer whose body is a string. The SDK parses a string body and passes an object one through unchanged, and a string
 * is what an HTTP transport hands it on the forwarded path too.
 */
function jsonResponse(statusCode: number, body: unknown): TwilioHttpResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** The fields one raw form value stands for: a scalar, or the array a repeated key built. */
function formEntries(data: unknown): ReadonlyArray<readonly [string, unknown]> {
  if (data instanceof URLSearchParams) {
    return [...data];
  }
  if (typeof data === 'string') {
    return [...new URLSearchParams(data)];
  }
  if (typeof data === 'object' && data !== null) {
    return Object.entries(data as Record<string, unknown>);
  }
  return [];
}

/** The string fields one raw form value stands for, in the order the form held them. */
function formValues(raw: unknown): string[] {
  const values: string[] = [];
  for (const value of Array.isArray(raw) ? (raw as unknown[]) : [raw]) {
    if (typeof value === 'string') {
      values.push(value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      values.push(String(value));
    }
  }
  return values;
}

/** Add one form field, collecting a repeated key into an array as the SDK encodes one. */
function addFormValue(form: Record<string, string | string[]>, key: string, value: string): void {
  const existing = form[key];
  if (existing === undefined) {
    form[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    form[key] = [existing, value];
  }
}

/** One form field as a single value, or `null` when it is absent or was sent empty. */
function readText(form: Record<string, string | string[]>, key: string): string | null {
  const value = form[key];
  if (value === undefined) {
    return null;
  }
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === '' ? null : first;
}

/** One form field as every value it carried, always an array. */
function readList(form: Record<string, string | string[]>, key: string): string[] {
  const value = form[key];
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/** One form field as a boolean: the SDK sends `Record` as the string `'true'` or `'false'`. */
function readFlag(form: Record<string, string | string[]>, key: string): boolean | null {
  const value = readText(form, key);
  if (value === 'true') {
    return true;
  }
  return value === 'false' ? false : null;
}

/** One form field as an integer, or `null` when it is absent or not numeric. */
function readInteger(form: Record<string, string | string[]>, key: string): number | null {
  const value = readText(form, key);
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/** A `CallAttempt` id from the first URL whose query carries one, or `null` when none does. */
function readAttemptId(...urls: string[]): string | null {
  for (const url of urls) {
    const attemptId = new URL(url).searchParams.get('attemptId');
    if (attemptId !== null && attemptId !== '') {
      return attemptId;
    }
  }
  return null;
}

/** A date the SDK sent as ISO 8601, or `null` when it is absent or unparseable. */
function parseDate(value: string | null): Date | null {
  if (value === null) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Whether a value is an absolute `http` or `https` URL, the only scheme Twilio fetches from. */
function isHttpUrl(value: string | null): value is string {
  if (value === null) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A date in the RFC 2822 form the SDK parses (`ddd, DD MMM YYYY HH:mm:ss [+0000]`). An unparseable one would reach the SDK
 * as a string rather than a `Date`.
 */
function toRfc2822(date: Date): string {
  return date.toUTCString().replace(/GMT$/, '+0000');
}
