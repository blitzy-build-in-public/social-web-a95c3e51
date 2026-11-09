import twilio from 'twilio';
import { TwilioCallStatus } from '@tablemate/shared';
/** The public simulator credentials, used by both processes in `simulator` mode and by the scripted simulator that signs the callbacks it posts and the socket it opens (AAP 0.6.2, AAP 0.11.2). */
export const TWILIO_SIMULATOR = {
  accountSid: 'AC00000000000000000000000000000000',
  authToken: 'tablemate-voice-simulator-token',
  fromNumber: '+16175550100',
} as const;
/** The deadline for one Twilio REST request, matching the Stripe bound of AAP 0.11.1: a dispatch unanswered in ten seconds is reconciled rather than waited on (AAP 0.3.2). */
export const TWILIO_REST_TIMEOUT_MS = 10_000;
/** The progress events every outbound call subscribes to (AAP 0.3.2, AAP 0.3.3). */
export const CALL_STATUS_CALLBACK_EVENTS = [
  'initiated',
  'ringing',
  'answered',
  'completed',
] as const;
const MISSING_SIMULATOR_URL =
  'this telephony client has no call transport: simulator mode needs the simulatorUrl option';
const TWILIO_API_ORIGIN = 'https://api.twilio.com';
const TWILIO_REST_URI_PREFIX = `${TWILIO_API_ORIGIN}/`;
type SdkClient = ReturnType<typeof twilio>;
type SdkRequestClient = InstanceType<typeof twilio.RequestClient>;
type CallApi = SdkClient['calls'];
/** The two transport selections `TELEPHONY_MODE` can name (AAP 0.6.2). */
export type TelephonyClientMode = 'simulator' | 'twilio';
/** The HTTP methods the SDK sends, mirroring its own `HttpMethod` vocabulary. */
export type TwilioHttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
/** One REST request as the SDK issues it: the structural contract of its request client, narrow enough for a plain object to implement and wide enough that {@link TwilioHttpClient} needs no more than the fields the SDK actually passes. */
export interface TwilioHttpRequest {
  method: TwilioHttpMethod;
  /** The absolute request URI, including its query string. */
  uri: string;
  /** The account SID the SDK authenticates as. */
  username?: string;
  /** The auth token the SDK authenticates with. */
  password?: string;
  headers?: Record<string, string>;
  /** Query-string parameters. */
  params?: object;
  /** Form fields, for a `post`. */
  data?: object;
  timeout?: number;
}
/** The reply to one {@link TwilioHttpRequest}, as the SDK reads it. */
export interface TwilioHttpResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, unknown>;
}
/** A REST transport this client can be handed instead of the SDK's own (AAP 0.11.2): the scripted telephony simulator implements it, so the automated suite drives dispatch, webhooks and reconciliation without a network. */
export interface TwilioHttpClient {
  request(request: TwilioHttpRequest): Promise<TwilioHttpResponse>;
}
/** What one outbound call asks for. */
export interface CreateCallParams {
  /** The number to call, in E.164, already checked against the allowlist (AAP 0.5.6). */
  to: string;
  /** The caller id. Outside production the simulator's number (AAP 0.6.2). */
  from: string;
  /** The URL Twilio fetches the ConversationRelay TwiML from. */
  twimlUrl: string;
  /** The URL Twilio posts call-status callbacks to. */
  statusCallbackUrl: string;
  /** The hard bound on the call, `CAP_CALL_SECONDS` (AAP 0.5.6). */
  timeLimitSeconds: number;
}
/** What a dispatched call returns: the SID the attempt adopts (AAP 0.3.2). */
export interface CreatedCall {
  callSid: string;
}
/** One call as the REST API reports it, the evidence `apps/workers/src/calls/reconcile.ts` uses for the `no_final_status` path (AAP 0.5.3). */
export interface FetchedCall {
  status: TwilioCallStatus;
  /** Never set by {@link TelephonyClient.fetchCall}: the Twilio Call resource carries no error code. It arrives on the status callback instead (`TwilioStatusCallback.ErrorCode`, AAP 0.3.3), which is where an unroutable number is recognized (AAP 0.5.3). */
  errorCode?: number;
  /** Twilio's machine-detection verdict, when it reported one. */
  answeredBy?: string;
  /** The call's length in seconds, when Twilio reported one. */
  durationSec?: number;
}
/** Which calls to list, newest API page first (AAP 0.3.2). */
export interface ListCallsParams {
  to: string;
  from: string;
  /** Supplied by the caller from the injected clock, never read here (AAP 0.11.1). */
  startTimeAfter: Date;
}
/** One call the REST API reports for a number pair. */
export interface CallCandidate {
  callSid: string;
  status: TwilioCallStatus;
  /** The instant the call started, as ISO 8601, or `null` for a call that has not started. */
  startTime: string | null;
}
/** How a failed dispatch is read (AAP 0.3.2, AAP 0.5.3). */
export type CallErrorClass = 'definite' | 'ambiguous';
/** How to build a client. */
export interface TelephonyClientOptions {
  mode: TelephonyClientMode;
  accountSid: string;
  authToken: string;
  /** The simulator's base URL, `VOICE_SIM_URL`. Required to make calls in simulator mode. */
  simulatorUrl?: string;
  /** A transport to use instead of the SDK's own, for the automated suite (AAP 0.11.2). */
  httpClient?: TwilioHttpClient;
}
/** The Twilio surface the rest of the workspace sees (AAP 0.5.1). */
export interface TelephonyClient {
  readonly mode: TelephonyClientMode;
  /** Place one outbound call. The caller persists its `CallAttempt` as `dispatching` first and puts that attempt's id in both URLs, so a callback or TwiML fetch carrying the id is the only evidence that adopts an ambiguous dispatch (AAP 0.3.2). Recording is off and is not a parameter (AAP 0.5.6, AAP 0.12.2). */
  createCall(params: CreateCallParams): Promise<CreatedCall>;
  /** Read one call by SID, for reconciliation of a call that reported no final status (AAP 0.5.3). */
  fetchCall(callSid: string): Promise<FetchedCall>;
  /** List at most 20 recent calls for a number pair, for operator display only: a candidate is never adopted and never releases a reservation (AAP 0.3.2). */
  listCalls(params: ListCallsParams): Promise<CallCandidate[]>;
  /** Check `X-Twilio-Signature` over the URL Twilio called and every field it posted (AAP 0.3.3): the caller rebuilds `url` from `API_PUBLIC_URL` plus the original path and query and passes every form field parsed by `@fastify/formbody`, because the signature covers all of them. */
  validateSignature(signature: string, url: string, params: Record<string, string>): boolean;
  /** {@link classifyCallError}, on the client, so dispatch needs no second import. */
  classifyCallError(error: unknown): CallErrorClass;
}
/** Build the client `options.mode` names, the one entry point its callers use (AAP 0.5.1). */
export function createTelephonyClient(options: TelephonyClientOptions): TelephonyClient {
  const callApi = resolveCallApi(options);
  const calls = (): CallApi => {
    if (callApi === null) {
      throw new Error(MISSING_SIMULATOR_URL);
    }
    return callApi;
  };
  return {
    mode: options.mode,
    async createCall(params: CreateCallParams): Promise<CreatedCall> {
      const call = await calls().create({
        to: params.to,
        from: params.from,
        url: params.twimlUrl,
        method: 'POST',
        statusCallback: params.statusCallbackUrl,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: [...CALL_STATUS_CALLBACK_EVENTS],
        timeLimit: params.timeLimitSeconds,
        record: false,
        machineDetection: 'Enable',
      });
      return { callSid: readCallSid(call.sid) };
    },
    async fetchCall(callSid: string): Promise<FetchedCall> {
      const call = await calls()(callSid).fetch();
      const fetched: FetchedCall = { status: parseCallStatus(call.status) };
      if (typeof call.answeredBy === 'string' && call.answeredBy !== '') {
        fetched.answeredBy = call.answeredBy;
      }
      if (typeof call.duration === 'string' && call.duration !== '') {
        const seconds = Number(call.duration);
        if (Number.isFinite(seconds)) {
          fetched.durationSec = Math.trunc(seconds);
        }
      }
      return fetched;
    },
    async listCalls(params: ListCallsParams): Promise<CallCandidate[]> {
      const page = await calls().list({
        to: params.to,
        from: params.from,
        startTimeAfter: params.startTimeAfter,
        limit: 20,
      });
      return page.map((call) => ({
        callSid: readCallSid(call.sid),
        status: parseCallStatus(call.status),
        startTime: toIsoStartTime(call.startTime),
      }));
    },
    validateSignature(signature: string, url: string, params: Record<string, string>): boolean {
      if (signature === '') {
        return false;
      }
      try {
        return twilio.validateRequest(options.authToken, signature, url, params);
      } catch {
        // Only an unparseable `url` can throw here (the SDK falls back to `new URL(url)`), and a URL Twilio never called cannot carry its signature. Answering "invalid" keeps an unauthenticated webhook at `400 bad_signature` instead of failing the route with a server error (AAP 0.3.3).
        return false;
      }
    },
    classifyCallError,
  };
}
function resolveCallApi(options: TelephonyClientOptions): CallApi | null {
  const httpClient = options.httpClient;
  if (httpClient !== undefined) {
    return buildClient(options, httpClient).calls;
  }
  if (options.mode === 'twilio') {
    return buildClient(options, undefined).calls;
  }
  const simulatorUrl = options.simulatorUrl;
  if (simulatorUrl === undefined || simulatorUrl === '') {
    return null;
  }
  return buildClient(options, forwardToSimulator(simulatorUrl)).calls;
}
function buildClient(
  options: TelephonyClientOptions,
  httpClient: TwilioHttpClient | undefined,
): SdkClient {
  const clientOptions: twilio.ClientOpts = {
    autoRetry: false,
    env: {},
    timeout: TWILIO_REST_TIMEOUT_MS,
  };
  if (httpClient !== undefined) {
    // The SDK types `httpClient` as its own request-client class. `TwilioHttpRequest` and `TwilioHttpResponse` are the structural contract of what it calls on it, so a plain object — the scripted simulator's transport, above all — satisfies it at runtime.
    clientOptions.httpClient = httpClient as unknown as SdkRequestClient;
  }
  return twilio(options.accountSid, options.authToken, clientOptions);
}
function forwardToSimulator(simulatorUrl: string): TwilioHttpClient {
  const baseUrl = simulatorUrl.replace(/\/+$/, '');
  const inner = new twilio.RequestClient({ timeout: TWILIO_REST_TIMEOUT_MS, autoRetry: false });
  return {
    async request(request: TwilioHttpRequest): Promise<TwilioHttpResponse> {
      // The SDK re-reads a request it is handed unchanged (headers, body, parameters, timeout), so forwarding its own options object with the URI rewritten keeps the call it makes identical.
      const response = await inner.request({
        ...request,
        uri: toSimulatorUri(request.uri, baseUrl),
      });
      return {
        statusCode: response.statusCode,
        body: response.body,
        // The SDK declares `Response.headers` as `any`; `TwilioHttpResponse` narrows it.
        headers: response.headers as Record<string, unknown>,
      };
    },
  };
}
function toSimulatorUri(uri: string, baseUrl: string): string {
  if (!uri.startsWith(TWILIO_REST_URI_PREFIX)) {
    throw new Error('the simulator transport refuses a request URI outside the Twilio REST origin');
  }
  return `${baseUrl}${uri.slice(TWILIO_API_ORIGIN.length)}`;
}
function parseCallStatus(status: unknown): TwilioCallStatus {
  const parsed = TwilioCallStatus.safeParse(status);
  if (!parsed.success) {
    throw new Error('twilio reported a call status outside the documented set');
  }
  return parsed.data;
}
function toIsoStartTime(startTime: unknown): string | null {
  if (!(startTime instanceof Date) || Number.isNaN(startTime.getTime())) {
    return null;
  }
  return startTime.toISOString();
}
function readCallSid(sid: unknown): string {
  if (typeof sid !== 'string' || sid === '') {
    throw new Error('twilio answered without a call sid');
  }
  return sid;
}
const DEFINITE_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
]);
/** Decide whether a failed dispatch created a call (AAP 0.3.2, AAP 0.5.3). */
export function classifyCallError(error: unknown): CallErrorClass {
  const status = readStatus(error);
  if (status !== null) {
    return status >= 400 && status < 500 ? 'definite' : 'ambiguous';
  }
  const code = readCode(error);
  if (code !== null && DEFINITE_NETWORK_CODES.has(code)) {
    return 'definite';
  }
  return 'ambiguous';
}
function readProperty(value: unknown, key: 'status' | 'code' | 'cause'): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}
function readStatus(error: unknown): number | null {
  for (const candidate of [error, readProperty(error, 'cause')]) {
    const status = readProperty(candidate, 'status');
    if (typeof status === 'number' && Number.isInteger(status)) {
      return status;
    }
  }
  return null;
}
function readCode(error: unknown): string | null {
  for (const candidate of [error, readProperty(error, 'cause')]) {
    const code = readProperty(candidate, 'code');
    if (typeof code === 'string' && code !== '') {
      return code;
    }
  }
  return null;
}
