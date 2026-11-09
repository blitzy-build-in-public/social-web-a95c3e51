/**
 * The HTTP proxy in front of `stripe-mock`: every Stripe request the API's gateway makes passes through it, the
 * mock validates the request, and every endpoint it models is answered statefully (AAP 0.3.3, 0.4.2, 0.6.2).
 */
import { randomBytes } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  CONTROL_PREFIX,
  CONTROL_ROUTES,
  PROXY_API_VERSION,
  ProxyControlError,
  createProxyState,
} from './state.ts';
import type { FaultRule, FormValue, StateResponse, StripeParams } from './state.ts';

/** The state one running proxy answers from; derived, so this file restates none of its types. */
type ProxyStateInstance = ReturnType<typeof createProxyState>;
/** A card fixture id, as the state's `createCustomer` and `attachCard` take one. */
type CardFixture = Parameters<ProxyStateInstance['createCustomer']>[0]['card'];
/** The selector the state's `paymentIntents` takes. */
type IntentFilter = NonNullable<Parameters<ProxyStateInstance['paymentIntents']>[0]>;
/** A card fixture id, as the state's controls take one. */
type CardId = Exclude<CardFixture, null>;
/** One control route's name, which is also the state control it drives (AAP 0.11.2). */
type ControlName = keyof typeof CONTROL_ROUTES;
/** The two containers a bracket path descends through: a list and a name-keyed object. */
type ParamContainer = FormValue[] | { [key: string]: FormValue };
/** A bracket token that names a list index, as `expand[0]` carries one. */
function isIndexToken(token: string): boolean {
  return /^\d+$/.test(token);
}

/** The most of a request body this proxy buffers; past it, the answer is `413` (AAP 0.11.1). */
const MAX_BODY_BYTES = 1024 * 1024;
/** How long `stripe-mock` has to answer before its failure is reported (AAP 0.11.1). */
const UPSTREAM_TIMEOUT_MS = 10_000;
/** The port the compose `stripe-proxy` service listens on unless `PORT` names another (AAP 0.6.2). */
const DEFAULT_PROXY_PORT = 12100;
/**
 * The headers forwarded to `stripe-mock`, and the whole of them: an allowlist rather than a filter. The idempotency
 * key, `host`, `connection`, `keep-alive`, `transfer-encoding` and the inbound `content-length` are dropped — the
 * first because the mock must see each retry as the request it is, the rest because the onward hop defines its own
 * (AAP 0.3.3).
 */
const FORWARDED_HEADERS = [
  'authorization',
  'stripe-version',
  'content-type',
  'user-agent',
  'x-stripe-client-user-agent',
] as const;
/** What an unreachable or failing upstream is reported as, so a broken mock fails a suite visibly. */
const UPSTREAM_UNAVAILABLE = 'stripe-mock upstream unavailable';
/** What an unexpected failure inside this proxy is reported as. */
const INTERNAL_ERROR = 'stripe-proxy internal error';
/** The idempotency answers, in the provider's own wording (AAP 0.3.2). */
const IDEMPOTENCY_MISMATCH =
  'Keys for idempotent requests can only be used with the same parameters they were first used with.';
const IDEMPOTENCY_IN_FLIGHT = 'A request with this idempotency key is still in progress.';
const IDEMPOTENCY_KEY_IN_USE = 'idempotency_key_in_use';
/**
 * The PaymentIntent statuses a control may query by: the lifecycle vocabulary of AAP 0.5.3, checked here at compile
 * time against the filter the state itself declares.
 */
const INTENT_STATUSES = [
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'requires_capture',
  'canceled',
  'succeeded',
] as const satisfies readonly IntentFilter['status'][];

// Form encoding (AAP 0.3.3)

/**
 * Parameters the pinned SDK sends legitimately but `stripe-mock` v0.206.0's bundled spec rejects. They are removed
 * from the **validation copy alone** — the copy forwarded to the mock — and never from the parameters the state
 * answers from, so a strip can never change what the proxy performs.
 */
export const VALIDATION_STRIP_PARAMS: readonly {
  readonly method: string;
  readonly path: RegExp;
  readonly params: readonly string[];
  readonly reason: string;
}[] = [];

/**
 * Parse an `application/x-www-form-urlencoded` body — or a query string — into Stripe's bracket notation (AAP 0.3.3).
 */
export function parseStripeForm(text: string): StripeParams {
  const params: StripeParams = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const [name = '', ...path] = tokenizeKey(key);
    if (name !== '') putParam(params, name, path, value);
  }
  return params;
}

/**
 * Encode a parameter tree back into `application/x-www-form-urlencoded` form: the inverse of {@link parseStripeForm},
 * used only for the validation copy.
 */
export function encodeStripeForm(params: StripeParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) appendParam(search, key, value);
  return search.toString();
}

/** Put one leaf value at the bracket path `rest` inside `token`, creating the containers it needs. */
function putParam(
  container: ParamContainer,
  token: string,
  rest: readonly string[],
  value: string,
): void {
  // `expand[]` and `expand[0]` index a list; a named token indexes an object, and a token naming no
  // index in a list appends, so a malformed bracket can only add a position rather than lose a value.
  const index = isIndexToken(token) ? Number.parseInt(token, 10) : -1;
  const current: FormValue | undefined = Array.isArray(container)
    ? token === ''
      ? undefined
      : container[index < 0 ? container.length : index]
    : container[token];
  const fill = (entry: FormValue): void => {
    if (!Array.isArray(container)) container[token] = entry;
    else if (token === '' || index < 0) container.push(entry);
    else container[index] = entry;
  };
  const next = rest[0];
  if (next === undefined) {
    // A name that already holds a value appends to it: a list grows, a scalar becomes a pair, and a
    // container a later scalar collides with is replaced, as the later pair wins in a form.
    if (Array.isArray(current)) fill([...current, value]);
    else if (typeof current === 'string') fill([current, value]);
    else fill(value);
    return;
  }
  const child: ParamContainer =
    current !== undefined && current !== null && typeof current === 'object'
      ? current
      : next === '' || isIndexToken(next)
        ? []
        : {};
  fill(child);
  putParam(child, next, rest.slice(1), value);
}

/** A key split into its own name and the bracket path after it: `a[b][0]` becomes `['a','b','0']`. */
function tokenizeKey(key: string): readonly string[] {
  const open = key.indexOf('[');
  if (open < 0) return [key];
  const tokens = [key.slice(0, open)];
  for (const match of key.slice(open).matchAll(/\[([^\]]*)\]/g)) tokens.push(match[1] ?? '');
  return tokens;
}

/** Append one leaf of a parameter tree to an encoded form, in Stripe's bracket notation. */
function appendParam(search: URLSearchParams, key: string, value: FormValue): void {
  if (typeof value === 'string') {
    search.append(key, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => appendParam(search, `${key}[${index}]`, entry));
    return;
  }
  for (const [name, entry] of Object.entries(value)) appendParam(search, `${key}[${name}]`, entry);
}

// Answers and error envelopes (AAP 0.3.2, AAP 0.3.3)

/** The provider's error types this proxy answers with. */
type StripeErrorType =
  'card_error' | 'invalid_request_error' | 'idempotency_error' | 'api_error' | 'rate_limit_error';
/** The members of an error envelope beyond its type and its message. */
interface StripeErrorExtras {
  readonly code?: string;
  readonly decline_code?: string;
  readonly param?: string;
}
/** What the handler writes for one request: the status, the serialized body and the content type. */
interface ProxyAnswer {
  readonly status: number;
  readonly text: string;
  /** The upstream's own content type; `application/json` when the answer is this server's. */
  readonly contentType?: string;
  /** Set on a replayed answer, which carries `Idempotent-Replayed: true`. */
  readonly replay?: boolean;
}

/** One JSON answer carrying `body`. */
function jsonAnswer(status: number, body: unknown): ProxyAnswer {
  return { status, text: JSON.stringify(body ?? null) };
}

/** One error envelope, spelled exactly as the provider spells one. */
function errorAnswer(
  status: number,
  type: StripeErrorType,
  message: string,
  extras: StripeErrorExtras = {},
): ProxyAnswer {
  return jsonAnswer(status, { error: { type, message, ...extras } });
}

/** The envelope this proxy refuses a control with: its own type, never one of Stripe's (AAP 0.11.2). */
function proxyErrorAnswer(status: number, message: string): ProxyAnswer {
  return jsonAnswer(status, { error: { type: 'proxy_error', message } });
}

/** The error a `fail` fault answers with, in the vocabulary the gateway classifies (AAP 0.3.2). */
function faultAnswer(status: number): ProxyAnswer {
  if (status >= 500) return errorAnswer(status, 'api_error', 'Simulated provider error.');
  if (status === 429) {
    return errorAnswer(429, 'rate_limit_error', 'Too many requests.', { code: 'rate_limit' });
  }
  if (status === 402) {
    return errorAnswer(402, 'card_error', 'Your card was declined.', {
      code: 'card_declined',
      decline_code: 'generic_decline',
    });
  }
  return errorAnswer(status, 'invalid_request_error', 'Simulated request error.');
}

// Reading and writing one request (AAP 0.3.3)

/** One request as this proxy reads it, before any step of the pipeline has acted on it. */
interface ProxyTarget {
  readonly method: string;
  /** The path alone: the state matches its own routes against a path with no query string. */
  readonly path: string;
  readonly search: string;
  readonly query: StripeParams;
  readonly body: string;
  readonly form: StripeParams;
  readonly headers: Record<string, string>;
  readonly idempotencyKey: string | undefined;
  readonly stripeVersion: string;
}

/** What one running proxy serves from: the upstream, its state and the timers it owns. */
interface ProxyRuntime {
  readonly upstream: URL;
  readonly state: ProxyStateInstance;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
}

/** What `stripe-mock` answered with, once it could be asked at all. */
interface UpstreamAnswer {
  readonly status: number;
  readonly text: string;
  readonly contentType: string;
}

/** The refusal {@link readBody} raises for a body over {@link MAX_BODY_BYTES}. */
class PayloadTooLargeError extends Error {}

/** A control body this proxy refuses: answered `400`, so a suite sees a failed control. */
class ControlInputError extends Error {}

/** Read one request: its method, path, query and headers, and its form body. */
function readTarget(request: IncomingMessage, body: string): ProxyTarget {
  const url = new URL(request.url ?? '/', 'http://stripe-proxy.invalid');
  return {
    method: (request.method ?? 'POST').toUpperCase(),
    path: url.pathname,
    search: url.search,
    query: parseStripeForm(url.search),
    body,
    form: parseStripeForm(body),
    headers: forwardedHeaders(request),
    idempotencyKey: headerOf(request, 'idempotency-key'),
    stripeVersion: headerOf(request, 'stripe-version') ?? PROXY_API_VERSION,
  };
}

/** The headers `stripe-mock` is sent: the allowlist alone. */
function forwardedHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = headerOf(request, name);
    if (value !== undefined) headers[name] = value;
  }
  return headers;
}

/** The first value of a request header; Node lower-cases every header name. */
function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value[0] : undefined;
}

/**
 * Read a request body, refusing one larger than {@link MAX_BODY_BYTES}. Past the bound nothing further is buffered,
 * and the body is still drained to its end: a client that is still uploading when the server answers would otherwise
 * see its socket reset instead of the refusal (AAP 0.11.1).
 */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  await new Promise<void>((resolve, reject) => {
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        oversized = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (oversized) reject(new PayloadTooLargeError());
      else resolve();
    });
    request.on('error', (error: Error) => {
      reject(error);
    });
  });
  return Buffer.concat(chunks).toString('utf8');
}

/** A fresh request id, the shape the provider uses for correlation. */
function requestId(): string {
  return `req_${randomBytes(12).toString('hex')}`;
}

/**
 * Write one answer, with the headers every Stripe-path answer carries (AAP 0.3.3): a fresh `request-id`, the
 * request's own `stripe-version` or the pinned default, the `idempotency-key` echoed back, and
 * `Idempotent-Replayed` on an answer that came from a stored claim.
 */
function writeAnswer(target: ProxyTarget, response: ServerResponse, answer: ProxyAnswer): void {
  if (response.writableEnded || response.destroyed) return;
  const headers: Record<string, string> = {
    'request-id': requestId(),
    'stripe-version': target.stripeVersion,
  };
  if (answer.status !== 204) headers['content-type'] = answer.contentType ?? 'application/json';
  if (target.idempotencyKey !== undefined) headers['idempotency-key'] = target.idempotencyKey;
  if (answer.replay === true) headers['Idempotent-Replayed'] = 'true';
  response.writeHead(answer.status, headers);
  response.end(answer.status === 204 ? undefined : answer.text);
}

/**
 * Write one answer around a held `drop` or `delay` (AAP 0.3.2).
 *
 * A `drop` destroys the socket without writing anything, *after* the state has already changed: the SDK sees a
 * connection error while the effect stands, which is the ambiguous hold create the sweeper replays under its
 * original key. A `delay` writes the same answer once `ms` have passed, which the gateway's own timeout turns into
 * the same ambiguity. A client that disconnected first is never written to.
 */
function deliver(
  runtime: ProxyRuntime,
  target: ProxyTarget,
  request: IncomingMessage,
  response: ServerResponse,
  answer: ProxyAnswer,
  fault: FaultRule | null,
): void {
  if (fault !== null && fault.kind === 'drop') {
    request.socket.destroy();
    return;
  }
  if (fault !== null && fault.kind === 'delay') {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      runtime.timers.delete(timer);
      writeAnswer(target, response, answer);
    }, fault.ms ?? 0);
    runtime.timers.add(timer);
    return;
  }
  writeAnswer(target, response, answer);
}

// The Stripe pipeline (AAP 0.3.2, AAP 0.3.3)

/** Answer one `/v1/*` request, in the one order the recovery rules require (AAP 0.3.2). */
async function serveStripe(
  runtime: ProxyRuntime,
  target: ProxyTarget,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const params: StripeParams = { ...target.query, ...target.form };
  const headerKey = target.idempotencyKey;
  // A key is honoured on a `POST` alone, the only method the provider fingerprints, so a read or a
  // delete that carries one is left to run as it is (AAP 0.3.2).
  const claimKey: string | null =
    headerKey !== undefined && target.method === 'POST' ? headerKey : null;
  if (headerKey !== undefined) {
    const begin = runtime.state.idempotencyBegin(headerKey, target.method, target.path, params);
    if (begin.kind === 'replay') {
      writeAnswer(target, response, {
        status: begin.response.status,
        text: JSON.stringify(begin.response.body ?? null),
        replay: true,
      });
      return;
    }
    if (begin.kind === 'mismatch') {
      writeAnswer(target, response, errorAnswer(400, 'idempotency_error', IDEMPOTENCY_MISMATCH));
      return;
    }
    if (begin.kind === 'in_flight') {
      writeAnswer(
        target,
        response,
        errorAnswer(409, 'idempotency_error', IDEMPOTENCY_IN_FLIGHT, {
          code: IDEMPOTENCY_KEY_IN_USE,
        }),
      );
      return;
    }
  }
  // Free a claim whose request was never performed, so a retry performs it rather than replaying a
  // refusal the provider never made (AAP 0.3.2).
  const abortClaim = (): void => {
    if (claimKey !== null) runtime.state.idempotencyAbort(claimKey);
  };
  const fault = runtime.state.takeFault(target.method, target.path);
  if (fault !== null && fault.kind === 'fail') {
    abortClaim();
    writeAnswer(target, response, faultAnswer(fault.status ?? 500));
    return;
  }
  const validated = await forwardToUpstream({
    upstream: runtime.upstream,
    target,
    body: validationBody(target, params),
    timers: runtime.timers,
  });
  if (validated === null || validated.status >= 500) {
    abortClaim();
    writeAnswer(target, response, errorAnswer(500, 'api_error', UPSTREAM_UNAVAILABLE));
    return;
  }
  const upstream: ProxyAnswer = {
    status: validated.status,
    text: validated.text,
    contentType: validated.contentType,
  };
  // A refusal from the mock models a request the provider never executed: nothing is stored here.
  const modelled =
    validated.status < 400
      ? runtime.state.handleStripe({ method: target.method, path: target.path, params })
      : null;
  if (modelled === null) {
    abortClaim();
    deliver(runtime, target, request, response, upstream, fault);
    return;
  }
  // Stored before it is written, so a dropped or delayed answer is already replayable.
  if (claimKey !== null) runtime.state.idempotencyComplete(claimKey, modelled);
  deliver(runtime, target, request, response, stateAnswer(modelled), fault);
}

/** A state's own answer as a {@link ProxyAnswer}. */
function stateAnswer(response: StateResponse): ProxyAnswer {
  return jsonAnswer(response.status, response.body);
}

/**
 * The body `stripe-mock` validates: the request's own, minus the parameters it wrongly refuses. Only when
 * {@link VALIDATION_STRIP_PARAMS} names one of them is the body re-encoded at all, and the parameters the state
 * answers from are never touched; a query string is forwarded as the client sent it.
 */
function validationBody(target: ProxyTarget, params: StripeParams): string {
  const entry = VALIDATION_STRIP_PARAMS.find(
    (rule) => rule.method === target.method && rule.path.test(target.path),
  );
  if (entry === undefined) return target.body;
  const stripped: StripeParams = {};
  for (const [name, value] of Object.entries(params)) {
    if (!entry.params.includes(name)) stripped[name] = value;
  }
  return encodeStripeForm(stripped);
}

/** What one upstream forward needs: where to reach it, the request, its body and the proxy's timers. */
interface ForwardOptions {
  readonly upstream: URL;
  readonly target: ProxyTarget;
  readonly body: string;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
}

/**
 * Validate one request by sending it to `stripe-mock` and reading its answer (AAP 0.3.3).
 */
function forwardToUpstream(options: ForwardOptions): Promise<UpstreamAnswer | null> {
  const { upstream, target, body, timers } = options;
  return new Promise<UpstreamAnswer | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (answer: UpstreamAnswer | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(timer);
      }
      resolve(answer);
    };
    try {
      const outgoing = httpRequest(
        {
          hostname: upstream.hostname,
          port: upstream.port,
          method: target.method,
          path: `${upstream.pathname.replace(/\/+$/, '')}${target.path}${target.search}`,
          headers: { ...target.headers, 'content-length': String(Buffer.byteLength(body)) },
        },
        (answer) => {
          const chunks: Buffer[] = [];
          answer.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          answer.on('end', () => {
            settle({
              status: answer.statusCode ?? 502,
              text: Buffer.concat(chunks).toString('utf8'),
              contentType: firstHeader(answer.headers['content-type']) ?? 'application/json',
            });
          });
          answer.on('error', () => {
            settle(null);
          });
        },
      );
      timer = setTimeout(() => {
        outgoing.destroy();
        settle(null);
      }, UPSTREAM_TIMEOUT_MS);
      timers.add(timer);
      outgoing.on('error', () => {
        settle(null);
      });
      outgoing.end(body);
    } catch {
      settle(null);
    }
  });
}

/** The first value of a header an upstream answer carried. */
function firstHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value[0] : undefined;
}

// The control routes (AAP 0.11.2)

/** One entry of {@link CONTROL_ROUTES} compiled, so this server routes by the test client's table. */
interface ControlMatcher {
  readonly name: ControlName;
  readonly method: string;
  readonly pattern: RegExp;
}

/**
 * {@link CONTROL_ROUTES} compiled once: routing by the same table the test-side `proxyControl` builds its requests
 * from means a path renamed on one side cannot leave the other pointing at nothing.
 */
const CONTROL_MATCHERS: readonly ControlMatcher[] = Object.entries(CONTROL_ROUTES).map(
  ([name, route]) => ({
    name: name as ControlName,
    method: route.method,
    pattern: new RegExp(`^${route.path.split('/').map(controlSegment).join('/')}$`),
  }),
);

/** One path segment of a control route: `:id` captures a segment, anything else stays literal. */
function controlSegment(segment: string): string {
  return segment.startsWith(':') ? '([^/]+)' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Answer one `/__proxy/*` control, mapping a refusal onto this proxy's own envelope. */
function serveControl(runtime: ProxyRuntime, target: ProxyTarget, response: ServerResponse): void {
  const matcher = CONTROL_MATCHERS.find(
    (entry) => entry.method === target.method && entry.pattern.test(target.path),
  );
  if (matcher === undefined) {
    writeAnswer(target, response, proxyErrorAnswer(404, 'No such proxy control.'));
    return;
  }
  const id = matcher.pattern.exec(target.path)?.[1];
  try {
    const answer = controlAnswer(runtime, matcher.name, id, target);
    writeAnswer(
      target,
      response,
      answer === undefined ? { status: 204, text: '' } : jsonAnswer(200, answer),
    );
  } catch (error) {
    if (error instanceof ProxyControlError) {
      writeAnswer(target, response, proxyErrorAnswer(error.status, error.message));
    } else if (error instanceof ControlInputError) {
      writeAnswer(target, response, proxyErrorAnswer(400, error.message));
    } else {
      throw error;
    }
  }
}

/** Drive one control: its JSON answer, or `undefined` for the controls that answer `204`. */
function controlAnswer(
  runtime: ProxyRuntime,
  name: ControlName,
  id: string | undefined,
  target: ProxyTarget,
): unknown {
  const state = runtime.state;
  const body = jsonObject(target.body);
  switch (name) {
    case 'health':
      return { status: 'ok' };
    case 'reset':
      state.reset();
      return undefined;
    case 'setNow':
      return { nowMs: state.setNow(readInstant(body['nowMs'])) };
    case 'createCustomer':
      return state.createCustomer({ card: readCard(body['card']) });
    case 'attachCard':
      return state.attachCard(requireId(id), requireCard(body['card']), {
        makeDefault: body['makeDefault'] !== false,
      });
    case 'complete3ds':
      return state.complete3ds(requireId(id));
    case 'failAuthentication':
      return state.failAuthentication(requireId(id));
    case 'abandonAuthentication':
      return state.abandonAuthentication(requireId(id));
    case 'expireHold':
      return state.expireHold(requireId(id));
    case 'addFault':
      state.addFault(readFaultRule(body));
      return undefined;
    case 'events': {
      const since = readString(target.query['since']);
      return { data: state.events(since === undefined ? {} : { since }) };
    }
    case 'paymentIntents':
      return { data: state.paymentIntents(readIntentFilter(body)) };
  }
}

/** A control request's body as a JSON object; an empty body is `{}` and anything else is refused. */
function jsonObject(text: string): Record<string, unknown> {
  if (text.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ControlInputError('a control body must be valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ControlInputError('a control body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

/** A string field of a control body, or `undefined` when it is absent or of another type. */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The instant a `setNow` control pins: milliseconds, or `null` to hand the clock back. */
function readInstant(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new ControlInputError('nowMs must be a number of milliseconds or null');
}

/** The card fixture a control names, or `null` for a customer with no card. */
function readCard(value: unknown): CardId | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value as CardId;
  throw new ControlInputError('card must be a card fixture id or null');
}

/** The card fixture a control requires, refusing an absent one. */
function requireCard(value: unknown): CardId {
  const card = readCard(value);
  if (card === null) throw new ControlInputError('card is a required card fixture id');
  return card;
}

/** The `:id` segment a control route matched, which its own path template always supplies. */
function requireId(id: string | undefined): string {
  if (id === undefined || id === '') {
    throw new ControlInputError('this control requires an id in its path');
  }
  return id;
}

/** One fault rule, validated before the state holds it: the first request it matches consumes it. */
function readFaultRule(body: Record<string, unknown>): FaultRule {
  const kind = body['kind'];
  const method = body['method'];
  const path = body['path'];
  if (kind !== 'drop' && kind !== 'delay' && kind !== 'fail') {
    throw new ControlInputError('kind must be drop, delay or fail');
  }
  if (typeof method !== 'string' || typeof path !== 'string') {
    throw new ControlInputError('method and path are required strings');
  }
  if (kind === 'delay') {
    const ms = body['ms'];
    if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0) {
      throw new ControlInputError('ms must be an integer of at least 0 for a delay');
    }
    return { kind, method, path, ms };
  }
  if (kind === 'fail') {
    const status = body['status'];
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) {
      throw new ControlInputError('status must be an integer from 400 to 599 for a fail');
    }
    return { kind, method, path, status };
  }
  return { kind, method, path };
}

/** The selector a `paymentIntents` control queries with: every member it gives must match. */
function readIntentFilter(body: Record<string, unknown>): IntentFilter {
  const filter: {
    customer?: string;
    status?: (typeof INTENT_STATUSES)[number];
    metadata?: Record<string, string>;
  } = {};
  const customer = readString(body['customer']);
  if (customer !== undefined) filter.customer = customer;
  const status = readString(body['status']);
  if (status !== undefined) {
    const known = INTENT_STATUSES.find((candidate) => candidate === status);
    if (known === undefined) throw new ControlInputError('status must be a PaymentIntent status');
    filter.status = known;
  }
  const metadata = body['metadata'];
  if (metadata !== undefined && typeof metadata === 'object' && metadata !== null) {
    const pairs: Record<string, string> = {};
    for (const [name, value] of Object.entries(metadata)) {
      if (typeof value !== 'string') throw new ControlInputError('metadata must hold strings');
      pairs[name] = value;
    }
    filter.metadata = pairs;
  }
  return filter;
}

// The proxy itself (AAP 0.3.3, AAP 0.6.2)

/** Answer one request: read it, then route it to the controls, to Stripe or to nothing. */
async function handleRequest(
  runtime: ProxyRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(request);
  } catch (error) {
    if (!(error instanceof PayloadTooLargeError)) throw error;
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(413, { 'content-type': 'application/json', 'request-id': requestId() });
    response.end(
      JSON.stringify({
        error: { type: 'invalid_request_error', message: 'Request body is too large.' },
      }),
    );
    return;
  }
  const target = readTarget(request, body);
  if (target.path === CONTROL_PREFIX || target.path.startsWith(`${CONTROL_PREFIX}/`)) {
    serveControl(runtime, target, response);
    return;
  }
  if (!target.path.startsWith('/v1/')) {
    writeAnswer(target, response, errorAnswer(404, 'invalid_request_error', 'Unrecognized URL.'));
    return;
  }
  await serveStripe(runtime, target, request, response);
}

/** What {@link startStripeProxy} needs. */
export interface StripeProxyOptions {
  /** The port to bind; `0` picks a free one, which a `globalSetup` wants. */
  readonly port: number;
  /** The `stripe-mock` origin, e.g. `http://127.0.0.1:12111`: plain HTTP only. */
  readonly upstream: string;
  /** The interface to bind; the loopback by default, `0.0.0.0` inside the compose network. */
  readonly host?: string;
}

/** A running proxy: where to reach it, and how to stop it. */
export interface StripeProxy {
  /** The address to give the API as `STRIPE_API_BASE`. */
  readonly url: string;
  /** Stop listening and clear every tracked timer; safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Start the stateful proxy in front of `stripe-mock` (AAP 0.3.3, AAP 0.6.2). One proxy owns one state, so two starts
 * in one process cannot see each other's customers, intents or events: a `globalSetup` starts it on an ephemeral
 * port and hands the URL to every worker, and the compose `stripe-proxy` service is the same server bound to
 * `0.0.0.0`.
 */
export async function startStripeProxy(options: StripeProxyOptions): Promise<StripeProxy> {
  const upstream = upstreamUrl(options.upstream);
  const host = options.host ?? '127.0.0.1';
  const runtime: ProxyRuntime = { upstream, state: createProxyState(), timers: new Set() };
  const server = createServer((request, response) => {
    void handleRequest(runtime, request, response).catch((error: unknown) => {
      // Message only: a request's headers, body and parameters are never logged (AAP 0.11.1).
      const reason = error instanceof Error ? error.message : 'unknown failure';
      process.stderr.write(`stripe-proxy: ${reason}\n`);
      if (response.destroyed) return;
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json', 'request-id': requestId() });
      }
      if (response.writableEnded) return;
      response.end(JSON.stringify({ error: { type: 'api_error', message: INTERNAL_ERROR } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      resolve();
    });
  });
  const bound = server.address();
  const port = typeof bound === 'object' && bound !== null ? bound.port : options.port;
  const reachable = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  let stopped = false;
  return {
    url: `http://${reachable}:${port}`,
    async close(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const timer of runtime.timers) clearTimeout(timer);
      runtime.timers.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/** The upstream address, which must be an absolute plain-HTTP URL: the port `stripe-mock` serves. */
function upstreamUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('stripe-proxy requires an absolute upstream URL');
  }
  if (url.protocol !== 'http:') throw new Error('stripe-proxy requires an http:// upstream URL');
  return url;
}

// The standalone service (AAP 0.6.2)

/**
 * Run the proxy from the environment (`pnpm --filter @tablemate/api stripe-proxy`): the compose `stripe-proxy`
 * service is this binary on the api `test-support` image, and it is the only process that reads
 * `STRIPE_MOCK_UPSTREAM` (AAP 0.6.2). Both variables are validated before anything listens: a failure names the
 * variable and exits 1 without echoing a value, because an upstream URL can carry a host.
 */
async function runStripeProxyCli(): Promise<void> {
  const port = readCliPort(process.env['PORT']);
  const upstream = requireCliVariable('STRIPE_MOCK_UPSTREAM');
  const proxy = await startStripeProxy({ port, upstream, host: '0.0.0.0' }).catch(
    (error: unknown) =>
      exitWith(error instanceof Error ? error.message : 'the proxy could not start'),
  );
  const stop = (): void => {
    void proxy.close().then(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdout.write(`stripe-proxy listening on ${port}\n`);
}

/** Write the reason to stderr and exit 1, naming the variable and never its value. */
function exitWith(message: string): never {
  process.stderr.write(`stripe-proxy: ${message}\n`);
  process.exit(1);
}

/** One required environment variable, or an exit naming it. */
function requireCliVariable(name: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? exitWith(`${name} is required`) : value;
}

/** The port to bind: `PORT`, then {@link DEFAULT_PROXY_PORT}. */
function readCliPort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PROXY_PORT;
  const port = Number(value);
  if (!Number.isInteger(port)) return exitWith('PORT must be an integer');
  if (port < 1 || port > 65_535) return exitWith('PORT must be a port number');
  return port;
}

// The entry point `apps/api/package.json`'s `stripe-proxy` script runs. Importing this module has no
// side effect, so a `globalSetup` can start the proxy itself.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runStripeProxyCli();
}
