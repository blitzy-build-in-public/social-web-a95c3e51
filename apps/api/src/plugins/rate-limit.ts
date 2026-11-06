/**
 * Rate limiting: the per-IP, per-user, webhook and magic-link allowances a limited route carries
 * (AAP 0.5.4, AAP 0.3.2, AAP 0.11.2).
 *
 * AAP 0.5.4 fixes the allowances. Every mutating route — POST, PUT, PATCH and DELETE, plus the two
 * state-writing reads that store a budget or a first view — is limited per user at
 * {@link RATE_LIMIT_USER_PER_MIN} requests a minute and per IP at `RATE_LIMIT_IP_PER_MIN` (default
 * 600). Webhook routes, which carry no user, get {@link RATE_LIMIT_WEBHOOK_IP_PER_MIN} a minute per
 * IP, because a provider's requests arrive from a handful of addresses. `POST /auth/magic-link` gets
 * {@link MAGIC_LINK_MAX_PER_EMAIL_PER_HOUR} an hour for one address, because it is the only route
 * that mails a link. Exceeding a limit answers `429 rate_limited` with `Retry-After`. The plugin
 * registers with `global: false`, so `GET /v1/health`, the console reads, every other read and the
 * test-control routes carry no counter at all.
 *
 * The counters live in Redis and an unusable store fails closed (AAP 0.3.2): a request that cannot be
 * counted does not run, so it answers `503 service_unavailable` rather than passing unthrottled.
 * `skipOnError` therefore stays `false`, and {@link createRateLimitStore} rejects within
 * {@link RATE_LIMIT_STORE_TIMEOUT_MS} even when the server holds the connection open and answers
 * nothing — a paused or stalled Redis, which the fail-fast `client`-role connection cannot detect by
 * itself. The store error is an {@link AppError} marked by {@link RATE_LIMIT_STORE_ERROR}, which the
 * errors plugin answers with the 503 envelope; `errors.ts` does not import {@link
 * isRateLimitStoreError}, so no module cycle exists between the two.
 *
 * Two counters can apply to one request (per-IP and per-user, or per-IP and per-email), and they are
 * driven through `app.createRateLimit` rather than `@fastify/rate-limit`'s throwing `app.rateLimit`
 * factory: the factory's handler marks the request as limited on the plugin's own per-request flag,
 * so a second such hook on one route returns without counting anything. The limiter
 * `createRateLimit` returns carries no flag, and {@link createLimit} writes the plugin's own
 * `x-ratelimit-*` and `Retry-After` headers around it, so every limited request carries the same
 * headers whichever counter caught it and a 429 answers with the same envelope.
 *
 * Where a hook runs is part of the contract (AAP 0.5.4): the per-IP counters are `onRequest` hooks,
 * so an unauthenticated or oversized request is refused before any body is parsed, and the per-user
 * and per-email counters are `preHandler` hooks — after the bearer guard has put the caller's
 * account on the request and after the route's schema has validated the body. Fastify runs a
 * context's own hooks before route-level hooks of the same type, so a module's group guard always
 * runs before the counter it precedes.
 *
 * @see AAP 0.5.4 for the allowances, the headers and the routes that carry them, 0.3.2 for the
 *   fail-closed store and the rate limiter's place in the request path, 0.5.1 for this plugin's
 *   registration in the composition root, and 0.11.2 for rate limits on every mutating route.
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
     * Marks one of the two reads that write (AAP 0.5.4): `GET /v1/meetups/:id`, whose recipient's
     * first read records `recipientViewedAt` and emits `proposal_viewed`, and
     * `GET /v1/meetups/:id/suggestions`, which stores a supplied budget and sets
     * `suggestionsFirstViewedAt`. Both count as mutating routes, so both spread
     * {@link mutatingLimits} and set this flag.
     */
    stateWritingRead?: boolean;
  }

  interface FastifyInstance {
    /**
     * The counters this module built, decorated on the root so every child context inherits them
     * (AAP 0.5.1). Read through the `mutatingLimits` / `ipOnlyLimits` / `webhookLimits` /
     * `magicLinkLimits` helpers rather than directly, so a route carries a fresh array per call.
     */
    rateLimitHooks: RateLimitHooks;
  }
}

/**
 * What {@link registerRateLimit} needs from the composition root: the `client`-role Redis connection
 * the counters live in, the two environment values that size them, and the redacting logger.
 *
 * Narrowed on purpose. `app.ts` declares the app's full services type; this module states the three
 * capabilities it uses, and the services object satisfies it structurally.
 */
export interface RateLimitServices {
  /**
   * The API's Redis connections, of which only the `client`-role connection from
   * `createRedisConnection` is read: it fails a command as soon as Redis cannot serve it
   * (`enableOfflineQueue: false`, one retry) instead of queueing it behind an outage.
   *
   * Optional in the type on purpose. A process that did not wire one cannot count a request, and
   * {@link createRateLimitStore} then fails every limited route closed with `503
   * service_unavailable` rather than leaving it unthrottled — loud, and safe (AAP 0.3.2).
   */
  readonly redis: { readonly client?: Redis };
  /** The API's validated configuration, of which the two values that size the counters are read. */
  readonly env: Pick<ApiEnv, 'RATE_LIMIT_IP_PER_MIN' | 'EMAIL_LOOKUP_PEPPER'>;
  /** The process logger; a store failure is recorded through it as an event and never a key. */
  readonly logger: Logger;
}

/**
 * A counter's handler: an async Fastify hook, counted before the route it guards.
 *
 * Declared as a bare two-argument function rather than as Fastify's own hook-handler type, because
 * that type carries a `this` of the whole instance — including its logger type parameter, which the
 * app declares for itself. A handler typed that way is refused by a route on the app's own instance
 * type; this one is accepted by any instance (AAP 0.5.1).
 */
export type RateLimitHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * The four counters {@link registerRateLimit} builds once, after `@fastify/rate-limit` has loaded
 * (AAP 0.5.4). Each handler is shared by every route that spreads it; the exported helpers hand out
 * fresh arrays over these functions.
 */
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

/**
 * The hooks one route spreads into its options. Both phases are always present — an array is empty
 * when that phase carries no counter — so a caller can read or extend either without an
 * optional-value check.
 */
export interface RateLimitRouteOptions {
  readonly onRequest: RateLimitHook[];
  readonly preHandler: RateLimitHook[];
}

/**
 * What the helpers below need from the instance they are handed: the limiter factory and the counter
 * decorator `@fastify/rate-limit` adds, plus the hooks this module decorated.
 *
 * Structural on purpose. `FastifyInstance`'s own type is not assignable to itself across a different
 * `Logger` type parameter — its route methods take `RouteOptions` typed with that parameter, so the
 * app's type and the library's default type are incompatible — and the app's instance type is
 * `app.ts`'s to declare. Any instance that carries the three members below therefore works: the app's
 * own type, a plain `FastifyInstance`, and an encapsulated child context, which inherits the
 * decorators from the root (AAP 0.5.1).
 */
export interface RateLimitHost {
  hasDecorator(name: string | symbol): boolean;
  createRateLimit: FastifyInstance['createRateLimit'];
  readonly rateLimitHooks: RateLimitHooks;
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
 * Prefix of every counter key. A key is `rl:<scope>:<id>`, with the scope naming what is being
 * counted — `ip`, `user`, `webhook` or `magic`. The store adds no prefix of its own and the plugin's
 * `groupId` is never set, so a key held here is the whole key in Redis.
 */
const KEY_PREFIX = 'rl:';

/** The `x-ratelimit-limit` response header: the allowance the counter enforces. */
const LIMIT_HEADER = 'x-ratelimit-limit';

/** The `x-ratelimit-remaining` response header: requests left in the current window. */
const REMAINING_HEADER = 'x-ratelimit-remaining';

/** The `x-ratelimit-reset` response header: seconds until the window ends. */
const RESET_HEADER = 'x-ratelimit-reset';

/** The `Retry-After` response header, set on the 429 alone (AAP 0.5.4). */
const RETRY_AFTER_HEADER = 'retry-after';

/** Milliseconds in a second, for turning a millisecond TTL into a `Retry-After` value. */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * How long a counter may take before the request is refused with `503 service_unavailable`.
 *
 * A paused Redis keeps the TCP connection open and simply answers nothing, so the connection's own
 * 5-second command timeout would leave a mutating request hanging well past the write budget. This
 * bound is what answers within about a second, and it is why the store calls back with a failure
 * instead of waiting for the server (AAP 0.3.2).
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

/**
 * Marks the {@link AppError} the store calls back with, so `isRateLimitStoreError` can recognize it
 * without `errors.ts` importing this module — which would close a cycle, since this module imports
 * `AppError` from it. The property is non-enumerable, so the error still serializes as an error.
 */
const RATE_LIMIT_STORE_ERROR: unique symbol = Symbol('tablemate.rate_limit_store_error');

/**
 * One counter increment, as a script: add one to the window's counter, start the window on the first
 * request that reaches a fresh key, and report the count with the window's remaining milliseconds.
 *
 * One round trip and no race: two API instances incrementing the same key cannot both see a count of
 * one, and neither can start the window twice. The `ttl < 0` branch covers the one state the first
 * branch misses — a key that survived while its expiry did not (a flushed or restored Redis), which
 * would otherwise pin the counter forever.
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
 * Why a counter could not answer, named so the log line tells the cases apart: a paused or stalled
 * server (`RateLimitStoreTimeout`), a process with no connection wired
 * (`RateLimitStoreNotConfigured`), a reply that is not a count (`RateLimitStoreReplyInvalid`), or a
 * command Redis refused or failed (`RateLimitStoreError`, whose own cause is reported beside it).
 *
 * A named failure rather than a message string, because the log line carries the name: a line saying
 * every failure was an `Error` would leave an operator unable to tell a stall from a refused command.
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
 * The store every counter is read and written through: one Redis key per counter, incremented
 * atomically by {@link COUNT_SCRIPT}, failing closed on anything else (AAP 0.3.2).
 *
 * The constructor ignores the options the plugin passes: the window and the allowance arrive per
 * call in `timeWindow`/`max`, and the full key arrives from the hook's `keyGenerator`. `child` for
 * the same reason returns the same store rather than one keyed by a route — the plugin calls it with
 * merged options that carry no route for a hook created by `createRateLimit`, and a per-route prefix
 * would only prepend text a key already holds.
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

/**
 * Whether a failure is this store's refusal rather than a route's own error: the marker
 * {@link storeFailure} attaches. The errors plugin does not need it — it answers the thrown
 * {@link AppError} on its own — but a log line, a test or a caller that wants to tell "could not
 * count this request" from every other 503 may use it.
 */
export function isRateLimitStoreError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const marked = error as { readonly [RATE_LIMIT_STORE_ERROR]?: boolean };
  return marked[RATE_LIMIT_STORE_ERROR] === true;
}

/**
 * Registers the limiter and builds the four counters (AAP 0.5.1, 0.5.4).
 *
 * Called by `app.ts` after `registerAuth` and before the WebSocket, OpenAPI and route plugins, and
 * synchronous like its siblings: the plugin is queued, and the hooks are built in an `after` callback
 * because `createRateLimit` exists only once the plugin has loaded. The counters are decorated on the
 * instance the caller passed — the root app — so a child context inherits them, which is what lets a
 * module that declares routes inside its own plugin spread the helpers.
 *
 * @param app - The app the limiter is registered on and the counters are decorated on.
 * @param services - The Redis connection, the two sizing values and the logger (see
 *   {@link RateLimitServices}).
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
    // Only the routes that ask for a counter get one: the reads, `/v1/health` and the test-control
    // routes must stay unlimited (AAP 0.5.4).
    global: false,
    // A store failure must refuse the request, never let it through uncounted (AAP 0.3.2).
    skipOnError: false,
    store: createRateLimitStore(services),
    // Used by any hook the plugin creates for itself, from a route's own `config.rateLimit`, so such
    // a route answers the same 429 envelope and message this module's own hooks do (AAP 0.5.4).
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
 * The hooks a mutating traveler or operator route spreads into its options (AAP 0.5.4): every POST,
 * PUT, PATCH and DELETE, plus the two state-writing reads, which also set
 * `config.stateWritingRead`.
 *
 * The per-IP counter runs `onRequest`, so an unauthenticated caller is refused before its body is
 * parsed; the per-user counter runs in `preHandler`, after the group's bearer guard has put the
 * caller's account on the request. One counter per caller, shared by every mutating route: the
 * allowance AAP 0.5.4 sets is a budget for a user's writes in a minute, not a per-route one.
 *
 * @param app - The instance whose decorated hooks are read.
 * @returns Fresh `onRequest` and `preHandler` arrays over the shared counters.
 */
export function mutatingLimits(app: RateLimitHost): RateLimitRouteOptions {
  const { perIp, perUser } = hooksOf(app);
  return { onRequest: [perIp], preHandler: [perUser] };
}

/**
 * The hooks for a public mutating route that carries no user (AAP 0.5.4): `POST /auth/verify` and
 * `POST /auth/refresh`, which are limited per IP alone.
 *
 * @param app - The instance whose decorated hooks are read.
 */
export function ipOnlyLimits(app: RateLimitHost): RateLimitRouteOptions {
  return { onRequest: [hooksOf(app).perIp], preHandler: [] };
}

/**
 * The hooks for the webhook routes (AAP 0.5.4): `POST /v1/webhooks/stripe`, the voice status and
 * TwiML callbacks, and the ConversationRelay upgrade.
 *
 * These requests carry no bearer token — a provider signs them — so the counter is per IP, at the
 * higher {@link RATE_LIMIT_WEBHOOK_IP_PER_MIN} allowance, because one provider's traffic arrives
 * from a handful of addresses. The hook is an `onRequest` hook, so an over-limit upgrade is refused
 * as plain HTTP before the connection is hijacked.
 *
 * @param app - The instance whose decorated hooks are read.
 */
export function webhookLimits(app: RateLimitHost): RateLimitRouteOptions {
  return { onRequest: [hooksOf(app).perWebhookIp], preHandler: [] };
}

/**
 * The hooks for `POST /auth/magic-link` (AAP 0.5.4): per IP, and per address at
 * {@link MAGIC_LINK_MAX_PER_EMAIL_PER_HOUR} an hour.
 *
 * The address counter runs in `preHandler`, after the route's `MagicLinkRequest` schema has validated
 * the body, and is keyed by {@link emailLookupHash} of the address, so the Redis key holds a keyed
 * digest and never an address. The route still answers `202` for every address it accepts, so the
 * limit is the only thing that varies with the address's request history.
 *
 * @param app - The instance whose decorated hooks are read.
 */
export function magicLinkLimits(app: RateLimitHost): RateLimitRouteOptions {
  const { perIp, perEmail } = hooksOf(app);
  return { onRequest: [perIp], preHandler: [perEmail] };
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
 * Turns one plan into the hook a route carries: count the request, and refuse it once the count is
 * over the allowance (AAP 0.5.4).
 *
 * The plugin's limiter leaves no per-request mark, so one request can be counted by two of these
 * hooks; see the file header. Every counted request carries the window's rate-limit headers, and a
 * count over the allowance throws {@link AppError} — `rate_limited`, whose status the shared
 * vocabulary fixes at 429 — which the errors plugin answers as the envelope with the headers already
 * on the reply, so the caller always learns when to come back.
 */
function createLimit(app: RateLimitHost, plan: LimitPlan): RateLimitHook {
  const limiter = app.createRateLimit({
    max: plan.max,
    timeWindow: plan.timeWindowMs,
    keyGenerator: plan.key,
  });

  return async (request, reply) => {
    const state = await limiter(request);
    if (state.isAllowed) return;

    setRateLimitHeaders(reply, state);
    if (!state.isExceeded) return;

    throw new AppError('rate_limited', rateLimitedMessage(retryAfterText(state.ttlInSeconds)));
  };
}

/**
 * Writes the headers a limited request carries: the allowance, what is left of it and the seconds
 * until the window resets, plus `Retry-After` on the refusal — the same four the plugin sets for a
 * hook it created itself (AAP 0.5.4).
 *
 * Every value comes from the reply the counter returned rather than from the plan, so a caller that
 * is refused sees the window that actually caught it.
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

/**
 * A window's remaining time in words, for the refusal's message: `45 seconds`, `1 minute`, `2 hours`.
 *
 * The value is the counter's own remaining window, rounded up, so the sentence never promises an
 * earlier retry than the counter allows. Fractional seconds never reach here — the caller converts
 * the millisecond TTL first.
 */
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
 * The key of a caller's counter: `rl:user:<userId>`.
 *
 * A request with no account on it is counted under `rl:user:ip:<ip>` rather than under the per-IP
 * counter's own `rl:ip:<ip>`: one request charging the same counter twice would silently halve the IP
 * allowance it carries.
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
 * The key of an address's magic-link counter: `rl:magic:<hash>`.
 *
 * A route that spread this hook without a validated body has no address to count, so the caller's
 * address is counted instead, under `rl:magic:ip:<ip>`: a misconfigured route stays limited rather
 * than unlimited, and the per-IP counter beside it keeps its own allowance.
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
 * The account id the auth guard set on the request (AAP 0.3.3, 0.5.4), or `null` when the request
 * carries none.
 *
 * Read structurally rather than through a request augmentation of this module's own: `plugins/auth.ts`
 * declares the field, and a second declaration of it here would have to match that one exactly. Both
 * spellings a guard may expose are accepted — `userId`, the field name this module's callers use, and
 * `sub`, the access token's own claim — so the counter keys on the caller whoever wrote the guard.
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
 * The counters registered on `app`, or a thrown error naming the missing registration.
 *
 * The decoration happens inside the limiter plugin's `after` callback, so a route declared before
 * `registerRateLimit` ran has no counters to spread. That is a programming error in the composition
 * root, and it fails here with a sentence rather than as an undefined hook at request time.
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
 * The failure a counter reports when Redis could not answer: the `503 service_unavailable` the errors
 * plugin answers with, marked for {@link isRateLimitStoreError} and logged once (AAP 0.3.2).
 *
 * The key is deliberately absent from the line: it can carry an address, an account id or an email
 * digest. What is recorded is the event and the failure's name, enough to tell a timeout from a
 * refused command while an operator watches the API answer 503.
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

/**
 * The counter the script reported, or `null` for a reply that is not one.
 *
 * The reply is narrowed rather than asserted: it arrives as `unknown` from the client, and a Redis
 * that answered something else must fail the request closed rather than let a `NaN` counter through.
 */
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
