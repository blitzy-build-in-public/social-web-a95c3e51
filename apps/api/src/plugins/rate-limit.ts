/**
 * Rate limiting: the per-IP, per-user, webhook and magic-link allowances a limited route carries.
 * AAP 0.5.4 fixes the allowances: every mutating route — POST, PUT, PATCH and DELETE, plus the reads that write — is
 * limited per user at {@link RATE_LIMIT_USER_PER_MIN} requests a minute and per IP at `RATE_LIMIT_IP_PER_MIN`; webhook routes,
 * which carry no user, get {@link RATE_LIMIT_WEBHOOK_IP_PER_MIN} a minute per IP; and `POST /auth/magic-link` gets
 * {@link MAGIC_LINK_MAX_PER_EMAIL_PER_HOUR} an hour for one address. Exceeding a limit answers `429 rate_limited` with
 * `Retry-After`. The plugin registers with `global: false`, so `GET /v1/health`, the console reads, every other read and the
 * test-control routes carry no counter at all.
 * The counters live in Redis and an unusable store fails closed: a request that cannot be counted does not run, so it answers
 * `503 service_unavailable` rather than passing unthrottled. `skipOnError` therefore stays `false`, and
 * {@link createRateLimitStore} rejects within {@link RATE_LIMIT_STORE_TIMEOUT_MS} even when the server holds the connection
 * open and answers nothing — a paused or stalled Redis, which the fail-fast `client`-role connection cannot detect by itself.
 * The store error is an {@link AppError} marked by {@link RATE_LIMIT_STORE_ERROR}, which the errors plugin answers with the 503
 * envelope.
 * Two counters can apply to one request (per-IP and per-user, or per-IP and per-email), and they are driven through
 * `app.createRateLimit` rather than `@fastify/rate-limit`'s throwing `app.rateLimit` factory: the factory's handler marks the
 * request as limited on the plugin's own per-request flag, so a second such hook on one route returns without counting
 * anything. Where a hook runs is part of the contract: the per-IP counters are `onRequest` hooks, so an unauthenticated or
 * oversized request is refused before any body is parsed, and the per-user and per-email counters are `preHandler` hooks, after
 * the bearer guard has put the caller's account on the request and after the route's schema has validated the body.
 * Where a route group carries a guard it registers that guard through {@link guardRouteGroup}, which puts the group's per-IP
 * counter ahead of it on the group's own context. The order is the invariant: Fastify builds a route's hook chain as the
 * enclosing context's hooks followed by the route's own, so a counter left on the route alone runs after the guard and a
 * request the guard refuses reaches no counter at all — it would cost a token verification and nothing else. The group's
 * counter charges the group's mutating routes alone, and a counter charges one request once however many of its hooks that
 * request reaches, which is what lets each route keep its own copy of the per-IP hook without halving the allowance.
 */
import rateLimit from '@fastify/rate-limit';

import { AppError } from './errors.ts';

import { emailLookupHash } from '@tablemate/server-core';
import type { ApiEnv, Logger } from '@tablemate/server-core';
import {
  HOUR_MS,
  MAGIC_LINK_MAX_PER_EMAIL_PER_HOUR,
  MINUTE_MS,
  RATE_LIMIT_USER_PER_MIN,
  RATE_LIMIT_WEBHOOK_IP_PER_MIN,
} from '@tablemate/shared';

import type { Redis } from 'ioredis';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifyTypeProvider,
  FastifyTypeProviderDefault,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
  RawServerDefault,
} from 'fastify';
import type {
  FastifyRateLimitStore,
  FastifyRateLimitStoreCtor,
  errorResponseBuilderContext,
} from '@fastify/rate-limit';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Marks a read that writes: `GET /v1/meetups/:id`, whose recipient's first read records `recipientViewedAt` and
     * emits `proposal_viewed`; `GET /v1/meetups/:id/suggestions`, which stores a supplied budget and sets
     * `suggestionsFirstViewedAt`; and the operator's audited `GET /admin/lodging-claims/:id/booking-details`, which
     * writes an `OperatorAccessLog` row. All three count as mutating routes, so all three spread {@link mutatingLimits}
     * and set this flag.
     */
    stateWritingRead?: boolean;
  }
  interface FastifyInstance {
    /** The counters this module built, decorated on the root so every child context inherits them. Read through the `mutatingLimits` / `ipOnlyLimits` / `webhookLimits` / `magicLinkLimits` helpers rather than directly, so a route carries a fresh array per call. */
    rateLimitHooks: RateLimitHooks;
  }
}

/**
 * What {@link registerRateLimit} needs from the composition root: the `client`-role Redis connection the counters live in, the
 * two environment values that size them, and the redacting logger. Narrowed on purpose: the app's services object satisfies it
 * structurally.
 */
export interface RateLimitServices {
  /**
   * The API's Redis connections, of which only the `client`-role connection from `createRedisConnection` is read: it fails a
   * command as soon as Redis cannot serve it (`enableOfflineQueue: false`, one retry) instead of queueing it behind an outage.
   * Optional in the type on purpose: a process that did not wire one cannot count a request, and {@link createRateLimitStore}
   * then fails every limited route closed with `503 service_unavailable` rather than leaving it unthrottled.
   */
  readonly redis: { readonly client?: Redis };
  /** The API's validated configuration, of which the two values that size the counters are read. */
  readonly env: Pick<ApiEnv, 'RATE_LIMIT_IP_PER_MIN' | 'EMAIL_LOOKUP_PEPPER'>;
  /** The process logger; a store failure is recorded through it as an event and never a key. */
  readonly logger: Logger;
}

/**
 * A counter's handler: an async Fastify hook, counted before the route it guards. Declared as a bare two-argument function
 * rather than as Fastify's own hook-handler type, because that type carries a `this` of the whole instance — including its
 * logger type parameter, which the app declares for itself — so a handler typed that way is refused by a route on the app's own
 * instance type.
 */
export type RateLimitHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The four counters {@link registerRateLimit} builds once, after `@fastify/rate-limit` has loaded. Each handler is shared by every route that spreads it; the exported helpers hand out fresh arrays over these functions. */
export interface RateLimitHooks {
  /** Per-IP allowance for every mutating route: `RATE_LIMIT_IP_PER_MIN` a minute. */
  readonly perIp: RateLimitHook;
  /** Per-user allowance for every mutating route: {@link RATE_LIMIT_USER_PER_MIN} a minute. */
  readonly perUser: RateLimitHook;
  /** Per-IP allowance for the webhook routes: {@link RATE_LIMIT_WEBHOOK_IP_PER_MIN} a minute. */
  readonly perWebhookIp: RateLimitHook;
  /** Per-email allowance for `POST /auth/magic-link` (AAP 0.5.4). */
  readonly perEmail: RateLimitHook;
}

/** The hooks one route spreads into its options. Both phases are always present — an array is empty when that phase carries no counter — so a caller can read or extend either without an optional-value check. */
export interface RateLimitRouteOptions {
  readonly onRequest: RateLimitHook[];
  readonly preHandler: RateLimitHook[];
}

/**
 * What the helpers below need from the instance they are handed: the limiter factory and the counter decorator
 * `@fastify/rate-limit` adds, plus the hooks this module decorated.
 * Structural on purpose: `FastifyInstance`'s own type is not assignable to itself across a different `Logger` type parameter,
 * and the app's instance type is `app.ts`'s to declare. Any instance carrying the three members below therefore works: the
 * app's own type, a plain `FastifyInstance`, and an encapsulated child context that inherits the decorators from the root.
 */
export interface RateLimitHost {
  hasDecorator(name: string | symbol): boolean;
  createRateLimit: FastifyInstance['createRateLimit'];
  readonly rateLimitHooks: RateLimitHooks;
}

/**
 * The context a guarded route group registers itself on: what {@link guardRouteGroup} adds the group's counter and its
 * guard to. Structural like {@link RateLimitHost} and for the same reason — a call site hands it the app's own instance,
 * or a `withTypeProvider` child of it — so the one `addHook` overload this module calls is the one declared here.
 */
export interface RateLimitRouteGroup extends RateLimitHost {
  addHook(name: 'onRequest', hook: RateLimitHook): unknown;
}

/** The limiter factory `createRateLimit` is, as the plugin declares it on every instance. */
export type RateLimitFactory = RateLimitHost['createRateLimit'];

/** The limiter one `createRateLimit` call returns: counting a request is calling it. */
export type RateLimitLimiter = ReturnType<RateLimitFactory>;

/** What one limiter call answers: the count, the allowance, the window, or the allow-list pass. */
export type LimitState = Awaited<ReturnType<RateLimitLimiter>>;

/** A counter result past the allow-list check: the count, the allowance and the window. */
export type ExceededState = Exclude<LimitState, { isAllowed: true }>;

/** The decorator the hooks are published under, so a missing registration is reported by name. */
const RATE_LIMIT_HOOKS = 'rateLimitHooks';

/**
 * Prefix of every counter key: `rl:<scope>:<id>`, with `ip`, `user`, `webhook` or `magic` as the scope. The store adds no
 * prefix of its own and the plugin's `groupId` is never set, so a key held here is the whole key in Redis.
 */
const KEY_PREFIX = 'rl:';

const LIMIT_HEADER = 'x-ratelimit-limit';

const REMAINING_HEADER = 'x-ratelimit-remaining';

const RESET_HEADER = 'x-ratelimit-reset';

/** The `Retry-After` response header, set on the 429 alone (AAP 0.5.4). */
const RETRY_AFTER_HEADER = 'retry-after';

const MILLISECONDS_PER_SECOND = 1000;

/**
 * How long a counter may take before the request is refused with `503 service_unavailable`. A paused Redis keeps the TCP
 * connection open and answers nothing, so the connection's own 5-second command timeout would leave a mutating request hanging
 * well past the write budget; this bound is what answers within about a second.
 */
const RATE_LIMIT_STORE_TIMEOUT_MS = 1000;

/** The envelope message for a counter that could not be read (AAP 0.5.4). */
const RATE_LIMIT_STORE_UNAVAILABLE_MESSAGE = 'Rate limiting is temporarily unavailable.';

/** {@link RateLimitStoreFault} names, one per way a counter can fail. */
const FAULT_TIMEOUT = 'RateLimitStoreTimeout';
const FAULT_NOT_CONFIGURED = 'RateLimitStoreNotConfigured';
const FAULT_REPLY_INVALID = 'RateLimitStoreReplyInvalid';
const FAULT_STORE_ERROR = 'RateLimitStoreError';

/** The log event written once per store failure; the key itself is never logged. */
const RATE_LIMIT_STORE_ERROR_EVENT = 'rate_limit_store_error';

/** Marks the {@link AppError} the store calls back with, so `isRateLimitStoreError` can recognize it without `errors.ts` importing this module — which would close a cycle. The property is non-enumerable, so the error still serializes as an error. */
const RATE_LIMIT_STORE_ERROR: unique symbol = Symbol('tablemate.rate_limit_store_error');

/**
 * One counter increment, as a script: add one to the window's counter, start the window on the first request that reaches a
 * fresh key, and report the count with the window's remaining milliseconds.
 * One round trip and no race: two API instances incrementing the same key cannot both see a count of one, and neither can start
 * the window twice. The `ttl < 0` branch covers the one state the first branch misses — a key that survived while its expiry did
 * not (a flushed or restored Redis), which would otherwise pin the counter forever.
 */
const COUNT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`;

/** One counter reply: the count so far and the remaining window in milliseconds. */
interface Counted {
  readonly current: number;
  readonly ttl: number;
}

/**
 * Why a counter could not answer, named so the log line tells the cases apart: a paused or stalled server
 * (`RateLimitStoreTimeout`), a process with no connection wired (`RateLimitStoreNotConfigured`), a reply that is not a count
 * (`RateLimitStoreReplyInvalid`), or a command Redis refused or failed (`RateLimitStoreError`).
 */
class RateLimitStoreFault extends Error {
  constructor(name: string, cause?: unknown) {
    super(name, cause === undefined ? undefined : { cause });
    this.name = name;
  }
}

/** The callback `@fastify/rate-limit` passes to a store's `incr`. */
type RateLimitCallback = (
  error: Error | null,
  result?: { readonly current: number; readonly ttl: number },
) => void;

/**
 * The store every counter is read and written through: one Redis key per counter, incremented atomically by
 * {@link COUNT_SCRIPT}, failing closed on anything else.
 * The constructor ignores the options the plugin passes: the window and the allowance arrive per call in `timeWindow`/`max`, and
 * the full key arrives from the hook's `keyGenerator`. `child` returns the same store rather than one keyed by a route — the
 * plugin calls it with merged options that carry no route for a hook created by `createRateLimit`, and a per-route prefix would
 * only prepend text a key already holds.
 */
export function createRateLimitStore(services: RateLimitServices): FastifyRateLimitStoreCtor {
  return class RedisCounterStore implements FastifyRateLimitStore {
    incr(key: string, callback: RateLimitCallback, timeWindowMs: number): void {
      // At most one answer per call, whichever of the timeout and the reply arrives first: the
      // plugin's own promise rejects on the failure and never settles twice either way.
      const settle = once(callback);
      const client = services.redis.client;
      if (client === undefined) {
        settle(storeFailure(services, new RateLimitStoreFault(FAULT_NOT_CONFIGURED)));
        return;
      }
      const timer = setTimeout(() => {
        settle(storeFailure(services, new RateLimitStoreFault(FAULT_TIMEOUT)));
      }, RATE_LIMIT_STORE_TIMEOUT_MS);
      void client.eval(COUNT_SCRIPT, 1, key, String(timeWindowMs)).then(
        (reply: unknown) => {
          clearTimeout(timer);
          const counted = readCounter(reply);
          if (counted === null) {
            settle(storeFailure(services, new RateLimitStoreFault(FAULT_REPLY_INVALID)));
            return;
          }
          settle(null, counted);
        },
        (error: unknown) => {
          clearTimeout(timer);
          settle(storeFailure(services, new RateLimitStoreFault(FAULT_STORE_ERROR, error)));
        },
      );
    }
    child(_routeOptions: unknown): FastifyRateLimitStore {
      return this;
    }
  };
}

/** Whether a failure is this store's refusal rather than a route's own error: the marker {@link storeFailure} attaches. The errors plugin does not need it, but a log line, a test or a caller that wants to tell a request that could not be counted from every other 503 may use it. */
export function isRateLimitStoreError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const marked = error as { readonly [RATE_LIMIT_STORE_ERROR]?: boolean };
  return marked[RATE_LIMIT_STORE_ERROR] === true;
}

/**
 * Registers the limiter and builds the four counters.
 * Called by `app.ts` after `registerAuth` and before the WebSocket, OpenAPI and route plugins, and synchronous like its
 * siblings: the plugin is queued, and the hooks are built in an `after` callback because `createRateLimit` exists only once the
 * plugin has loaded. The counters are decorated on the instance the caller passed — the root app — so a child context inherits
 * them, which is what lets a module that declares routes inside its own plugin spread the helpers.
 */
export function registerRateLimit<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequest extends RawRequestDefaultExpression<RawServer> =
    RawRequestDefaultExpression<RawServer>,
  RawReply extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Log extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(
  app: FastifyInstance<RawServer, RawRequest, RawReply, Log, TypeProvider>,
  services: RateLimitServices,
): void {
  app.register(rateLimit, {
    // Only the routes that ask for a counter get one: the reads, `/v1/health` and the test-control routes must stay unlimited.
    global: false,
    // A store failure must refuse the request, never let it through uncounted (AAP 0.3.2).
    skipOnError: false,
    store: createRateLimitStore(services),
    // Used by any hook the plugin creates for itself, from a route's own `config.rateLimit`, so such a route answers the same 429 envelope and message this module's own hooks do.
    errorResponseBuilder: (_request: FastifyRequest, context: errorResponseBuilderContext) =>
      new AppError(
        'rate_limited',
        rateLimitedMessage(retryAfterText(context.ttl / MILLISECONDS_PER_SECOND)),
      ),
  });
  app.after(() => {
    app.decorate(RATE_LIMIT_HOOKS, buildHooks(app, services));
  });
}

/**
 * The hooks a mutating traveler or operator route spreads into its options: every POST, PUT, PATCH and DELETE, plus the reads
 * that write, which also set `config.stateWritingRead`.
 * The per-IP counter runs `onRequest`, so an unauthenticated caller is refused before its body is parsed; the per-user counter
 * runs in `preHandler`, after the bearer guard has put the account on the request and the body is validated.
 */
export function mutatingLimits(app: RateLimitHost): RateLimitRouteOptions {
  const { perIp, perUser } = hooksOf(app);
  return { onRequest: [perIp], preHandler: [perUser] };
}

/** The hooks for a public mutating route that carries no user: `POST /auth/verify` and `POST /auth/refresh`, which are limited per IP alone. */
export function ipOnlyLimits(app: RateLimitHost): RateLimitRouteOptions {
  return { onRequest: [hooksOf(app).perIp], preHandler: [] };
}

/**
 * The hooks for the webhook routes: `POST /v1/webhooks/stripe`, the voice status and TwiML callbacks, and the
 * ConversationRelay upgrade. These requests carry no bearer token — a provider signs them — so the counter is per IP, at the
 * higher {@link RATE_LIMIT_WEBHOOK_IP_PER_MIN} allowance, because one provider's traffic arrives from a handful of addresses.
 */
export function webhookLimits(app: RateLimitHost): RateLimitRouteOptions {
  return { onRequest: [hooksOf(app).perWebhookIp], preHandler: [] };
}

/**
 * The hooks for `POST /auth/magic-link`: per IP, and per address at {@link MAGIC_LINK_MAX_PER_EMAIL_PER_HOUR} an hour. The
 * address counter runs in `preHandler`, after the route's `MagicLinkRequest` schema has validated the body, and is keyed by
 * {@link emailLookupHash} of the address, so the Redis key holds a keyed digest and never an address.
 */
export function magicLinkLimits(app: RateLimitHost): RateLimitRouteOptions {
  const { perIp, perEmail } = hooksOf(app);
  return { onRequest: [perIp], preHandler: [perEmail] };
}

/**
 * Registers a route group's guard with the group's per-IP counter ahead of it, on the group's own context, in that order —
 * see the file header for why the counter cannot be left to the routes alone.
 *
 * The guard is the one the group carried before this call, `requireBearer`, `requireTraveler` or `requireOperator`, and the
 * counter is {@link RateLimitHooks.perIp}, wrapped so the group's reads that do not write stay uncounted. A group that
 * carries no guard registers no counter here: its limited routes keep spreading their own.
 */
export function guardRouteGroup(group: RateLimitRouteGroup, guard: RateLimitHook): void {
  group.addHook('onRequest', groupPerIp(group));
  group.addHook('onRequest', guard);
}

/**
 * The per-IP counter a route group registers on itself: the shared {@link RateLimitHooks.perIp} hook, wrapped so that the
 * group's routes which are not mutating make no Redis round trip at all. A group carries every route of its module, and
 * only its mutating routes consume the allowance (AAP 0.5.4).
 */
function groupPerIp(group: RateLimitHost): RateLimitHook {
  const perIp = hooksOf(group).perIp;
  return async (request, reply) => {
    if (!countsAsMutatingRoute(request)) return;
    await perIp(request, reply);
  };
}

/**
 * Whether the route a request matched is one a group's per-IP counter charges: every method but `GET`, `HEAD` and
 * `OPTIONS`, plus the reads that write, which mark themselves in their route config because their method cannot say so
 * (AAP 0.5.4). A group carries its plain reads too, and those must stay uncounted down to the absent rate-limit headers.
 * `HEAD` is read exactly as `GET`, because Fastify derives a `HEAD` route from every `GET` and runs that route's handler
 * with the body dropped (`lib/route.js`, `head-route.js`): a `HEAD` to a read that writes performs that read's write, so
 * leaving it out would hand the write a second, unbounded way in from the same address. Every value read here is
 * guarded: a matched route always carries a `config`, and a request that reached a group hook always matched one, but
 * the predicate must not depend on either.
 */
function countsAsMutatingRoute(request: FastifyRequest): boolean {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    return request.routeOptions.config?.stateWritingRead === true;
  }
  return method !== 'OPTIONS';
}

/** One counter: what it allows, over what window, and which key it counts under. */
interface LimitPlan {
  readonly max: number;
  readonly timeWindowMs: number;
  readonly key: (request: FastifyRequest) => string;
}

/** The four plans, one per counter: the allowances and windows AAP 0.5.4 sets. */
function buildHooks(app: RateLimitHost, services: RateLimitServices): RateLimitHooks {
  return {
    perIp: createLimit(app, {
      max: services.env.RATE_LIMIT_IP_PER_MIN,
      timeWindowMs: MINUTE_MS,
      key: (request) => ipKey(request.ip),
    }),
    perUser: createLimit(app, {
      max: RATE_LIMIT_USER_PER_MIN,
      timeWindowMs: MINUTE_MS,
      key: userKey,
    }),
    perWebhookIp: createLimit(app, {
      max: RATE_LIMIT_WEBHOOK_IP_PER_MIN,
      timeWindowMs: MINUTE_MS,
      key: (request) => webhookKey(request.ip),
    }),
    perEmail: createLimit(app, {
      max: MAGIC_LINK_MAX_PER_EMAIL_PER_HOUR,
      timeWindowMs: HOUR_MS,
      key: (request) => magicLinkKey(request, services.env.EMAIL_LOOKUP_PEPPER),
    }),
  };
}

/**
 * Turns one plan into the hook a route carries: count the request, and refuse it once the count is over the allowance. A
 * counter charges a request once, however many times its hook reaches that request ({@link countedCounters}): a guarded
 * group registers the per-IP hook ahead of its guard while the route keeps its own copy of it, and a second charge would
 * halve the allowance the request is entitled to. Every counted request carries the window's rate-limit headers, and a
 * count over the allowance throws `429 rate_limited`.
 */
function createLimit(app: RateLimitHost, plan: LimitPlan): RateLimitHook {
  const limiter = app.createRateLimit({
    max: plan.max,
    timeWindow: plan.timeWindowMs,
    keyGenerator: plan.key,
  });
  const counter: RateLimitHook = async (request, reply) => {
    // The mark is made before the limiter is called, not after it: the second hook to reach an admitted request must
    // cost no round trip, and a request this hook refused is already answered and never reaches a second one.
    const counted = countedCounters(request);
    if (counted.has(counter)) return;
    counted.add(counter);
    const state = await limiter(request);
    if (state.isAllowed) return;
    setRateLimitHeaders(reply, state);
    if (!state.isExceeded) return;
    throw new AppError('rate_limited', rateLimitedMessage(retryAfterText(state.ttlInSeconds)));
  };
  return counter;
}

/**
 * The counter hooks that have already charged one request. Each hook is a single function shared by every route that
 * spreads it, so the hook identity is what tells "counted already" from "not counted yet" for that counter alone. The set
 * is held as a symbol-keyed, non-enumerable own property of the request: no other module can name it, nothing serializes
 * it, and it lives exactly as long as the request it belongs to.
 */
const COUNTED_COUNTERS: unique symbol = Symbol('tablemate.rate_limit_counted_counters');

/** The counters this request has already been charged by, created by the first counter to reach it. */
function countedCounters(request: FastifyRequest): Set<RateLimitHook> {
  const marked = request as { readonly [COUNTED_COUNTERS]?: Set<RateLimitHook> };
  const counted = marked[COUNTED_COUNTERS];
  if (counted !== undefined) return counted;
  const created = new Set<RateLimitHook>();
  Object.defineProperty(request, COUNTED_COUNTERS, { value: created, enumerable: false });
  return created;
}

/**
 * Writes the headers a limited request carries: the allowance, what is left of it and the seconds until the window resets,
 * plus `Retry-After` on the refusal. Every value comes from the reply the counter returned rather than from the plan, so a
 * caller that is refused sees the window it is actually in.
 */
function setRateLimitHeaders(reply: FastifyReply, state: ExceededState): void {
  reply.header(LIMIT_HEADER, state.max);
  reply.header(REMAINING_HEADER, state.remaining);
  reply.header(RESET_HEADER, state.ttlInSeconds);
  if (state.isExceeded) reply.header(RETRY_AFTER_HEADER, state.ttlInSeconds);
}

/** The envelope message for a refusal, naming when the caller may try again (AAP 0.5.4). */
function rateLimitedMessage(after: string): string {
  return `Too many requests; retry after ${after}.`;
}

/** A window's remaining time in words, for the refusal's message: `45 seconds`, `1 minute`, `2 hours`. The value is the counter's own remaining window, rounded up, so the sentence never promises an earlier retry than the counter allows. */
function retryAfterText(seconds: number): string {
  const whole = Math.max(1, Math.ceil(seconds));
  if (whole < 60) return `${whole} ${whole === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.ceil(whole / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** The key of an address's counter: `rl:ip:<ip>`. */
function ipKey(ip: string): string {
  return `${KEY_PREFIX}ip:${ip}`;
}

/**
 * The key of a caller's counter: `rl:user:<userId>`. A request with no account on it is counted under
 * `rl:user:ip:<ip>` rather than under the per-IP counter's own `rl:ip:<ip>`: one request charging the same counter
 * twice would silently halve the IP allowance it carries.
 */
function userKey(request: FastifyRequest): string {
  const userId = authenticatedUserId(request);
  return userId === null ? `${KEY_PREFIX}user:ip:${request.ip}` : `${KEY_PREFIX}user:${userId}`;
}

/** The key of a webhook caller's counter: `rl:webhook:<ip>`. */
function webhookKey(ip: string): string {
  return `${KEY_PREFIX}webhook:${ip}`;
}

/**
 * The key of an address's magic-link counter: `rl:magic:<hash>`. A route that spread this hook without a validated
 * body has no address to count, so the caller's address is counted instead, under `rl:magic:ip:<ip>`: a misconfigured
 * route stays limited rather than unlimited.
 */
function magicLinkKey(request: FastifyRequest, pepper: string): string {
  const email = readEmail(request.body);
  return email === null ? `${KEY_PREFIX}magic:ip:${request.ip}` : magicLinkKeyFor(email, pepper);
}

/** The magic-link key of a validated address: the keyed digest, never the address (AAP 0.5.4). */
function magicLinkKeyFor(email: string, pepper: string): string {
  return `${KEY_PREFIX}magic:${emailLookupHash(pepper, email)}`;
}

/**
 * The account id the auth guard set on the request, or `null` when the request carries none. Read structurally
 * rather than through a request augmentation of this module's own: `plugins/auth.ts` declares the field, and a second
 * declaration here would have to match it exactly.
 */
function authenticatedUserId(request: FastifyRequest): string | null {
  const auth = (request as { auth?: unknown }).auth;
  if (typeof auth !== 'object' || auth === null) return null;
  const identity = auth as Record<string, unknown>;
  return nonEmptyString(identity.userId) ?? nonEmptyString(identity.sub);
}

/** The `email` of a validated request body, or `null` when the body carries no usable one. */
function readEmail(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  return nonEmptyString((body as Record<string, unknown>).email);
}

/** A non-empty string as itself, anything else as `null`. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The counters registered on `app`, or a thrown error naming the missing registration. The decoration happens inside
 * the limiter plugin's `after` callback, so a route declared before `registerRateLimit` ran has no counters to
 * spread — a programming error in the composition root, which fails here with a sentence rather than as an undefined
 * hook at request time.
 */
function hooksOf(app: RateLimitHost): RateLimitHooks {
  if (!app.hasDecorator(RATE_LIMIT_HOOKS)) {
    throw new Error(
      'Rate-limit hooks are unavailable: registerRateLimit must run before a route spreads mutatingLimits, ipOnlyLimits, webhookLimits or magicLinkLimits.',
    );
  }
  return app.rateLimitHooks;
}

/**
 * The failure a counter reports when Redis could not answer: the `503 service_unavailable` the errors plugin answers
 * with, marked for {@link isRateLimitStoreError} and logged once. The key is deliberately absent from the line: it
 * can carry an address, an account id or an email digest.
 */
function storeFailure(services: RateLimitServices, fault: RateLimitStoreFault): AppError {
  const underlying = fault.cause;
  services.logger.warn(
    {
      event: RATE_LIMIT_STORE_ERROR_EVENT,
      err: {
        name: fault.name,
        ...(underlying === undefined ? {} : { cause: errorName(underlying) }),
      },
    },
    RATE_LIMIT_STORE_ERROR_EVENT,
  );
  const failure = new AppError('service_unavailable', RATE_LIMIT_STORE_UNAVAILABLE_MESSAGE, {
    cause: fault,
  });
  Object.defineProperty(failure, RATE_LIMIT_STORE_ERROR, { value: true });
  return failure;
}

/** An error's own name, or `Error` for a value that is not one. */
function errorName(value: unknown): string {
  return value instanceof Error ? value.name : 'Error';
}

/** The counter the script reported, or `null` for a reply that is not one. The reply is narrowed rather than asserted: it arrives as `unknown`, and a Redis that answered something else must fail the request closed rather than let a `NaN` counter through. */
function readCounter(reply: unknown): Counted | null {
  if (!Array.isArray(reply)) return null;
  const values = reply as unknown[];
  const current = values[0];
  const ttl = values[1];
  if (typeof current !== 'number' || typeof ttl !== 'number') return null;
  return { current, ttl: Math.max(0, ttl) };
}

/** A callback that answers at most once, whichever of the timeout and the reply arrives first. */
function once(callback: RateLimitCallback): RateLimitCallback {
  let settled = false;
  return (error, result) => {
    if (settled) return;
    settled = true;
    callback(error, result);
  };
}
