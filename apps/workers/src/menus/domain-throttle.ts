/**
 * The per-domain request throttle (AAP 0.5.6).
 *
 * The menu pipeline may fetch a domain only once per second or less often, so `safe-fetch` takes the domain's slot before
 * every request it makes: the entry URL, each redirect hop, each followed menu link, each browser subrequest and that host's
 * `robots.txt` (AAP 0.3.3, 0.12.2). The slot is one Redis key holding a {@link THROTTLE_INTERVAL_MS} TTL, set with `NX`, so
 * the grant is atomic and shared across every `workers` process and the menu evaluation, and the winner's key expires on its
 * own — that expiry, not any local bookkeeping, is what spaces the requests. A caller that cannot take the slot waits out the
 * key's remaining lifetime and tries again, bounded by `maxWaitMs`, so contention delays a fetch rather than hanging it.
 *
 * The key is the *registrable domain* of the request's host — `registrableDomain(domainKey(host))` from
 * `./crawl-policy.ts` — which is what makes the limit a per-domain one rather than a per-host spelling one: `domainKey` gives
 * every spelling of one host one key (lower case, with a port, a trailing dot, IPv6 brackets and a leading `www.` normalised
 * away), and `registrableDomain` shortens that key to the site an operator decision is taken on, so a site and all its
 * subdomains share one slot — `a.example.com` and `b.example.com` cannot make one request each to `example.com` inside a
 * second.
 *
 * Time is never read from the wall clock: the elapsed wait is exactly the sum of the sleeps performed, and the sleep itself is
 * injectable, so a suite drives a minute of contention in microseconds of test time. A Redis outage fails the fetch closed —
 * `set` rejects, the error propagates out of {@link acquireDomainSlot}, and no request is sent without the slot, because an
 * unavailable lock cannot be assumed free. The injected `redis` is the two commands the throttle needs,
 * `Pick<Redis, 'set' | 'pttl'>`.
 */

import type { Redis } from 'ioredis';

/** The earliest a host may see two requests, in milliseconds (AAP 0.5.6). */
export const THROTTLE_INTERVAL_MS = 1000;
/** How long {@link acquireDomainSlot} keeps trying before it gives up. A crawl waits up to half a minute for a busy host; past that the fetch fails and the place falls back to the phone route, which is better than holding a browser and a job slot indefinitely. */
const DEFAULT_MAX_WAIT_MS = 30_000;
/** The floor on a single sleep. A key reporting a sub-50 ms remaining TTL, no expiry at all (`-1`) or that has just disappeared (`-2`) still costs one short wait instead of a tight retry loop against Redis. */
const MIN_WAIT_MS = 50;
/** The Redis key holding `domain`'s slot. Callers pass the registrable domain of the request's host — `registrableDomain(domainKey(host))` from `./crawl-policy.ts` — so a site and every subdomain of it contend for one lock, and every spelling of one host (a `www.` prefix, a port, letter case) reaches that same lock, because `domainKey` normalises each of those away. */
export function throttleKey(domain: string): string {
  return `throttle:${domain}`;
}

/** Thrown when a domain's slot could not be taken within `maxWaitMs` (AAP 0.5.6). `safe-fetch` lets it fail the fetch, so an over-subscribed domain drops out of the crawl instead of running unthrottled. The message names the domain, which is not personal data, and {@link domain} carries the same value so a caller can classify the refusal without parsing the message. */
export class ThrottleTimeoutError extends Error {
  /** The registrable domain whose slot was never taken. */
  readonly domain: string;
  /** @param domain - the registrable domain whose slot was never taken. */
  constructor(domain: string) {
    super(`throttle wait exceeded for ${domain}`);
    this.name = 'ThrottleTimeoutError';
    this.domain = domain;
  }
}

/** Wait `ms` with a timer. A timer is not a clock read: nothing here compares two instants, and the caller accounts for the wait from the value it asked for. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

/**
 * Take `domain`'s slot, waiting for the previous request to that domain to age out (AAP 0.5.6).
 *
 * Resolves as soon as a `set ... PX <THROTTLE_INTERVAL_MS> NX` creates the key, which is the whole
 * grant: the key's TTL is the throttle, so a second caller is served no earlier than one interval
 * after the first. Until then the caller sleeps for the key's remaining lifetime — at least
 * {@link MIN_WAIT_MS}, never past the remaining budget — and retries.
 *
 * timer-backed wait, which is how a suite runs contention without real time.
 * failure rejects with that failure instead, so the fetch fails closed rather than running
 * unthrottled.
 */
export async function acquireDomainSlot(
  redis: Pick<Redis, 'set' | 'pttl'>,
  domain: string,
  opts?: { maxWaitMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  const maxWaitMs = opts?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const sleep = opts?.sleep ?? defaultSleep;
  const key = throttleKey(domain);
  let waitedMs = 0;
  for (;;) {
    const acquired = await redis.set(key, '1', 'PX', THROTTLE_INTERVAL_MS, 'NX');
    if (acquired === 'OK') {
      return;
    }
    // The budget is checked before the round trip: a caller with nothing left to wait for must not sleep again, and must not read a TTL it will not use.
    if (waitedMs >= maxWaitMs) {
      throw new ThrottleTimeoutError(domain);
    }
    const remainingMs = await redis.pttl(key);
    const waitMs = Math.min(
      remainingMs > 0 ? Math.max(remainingMs, MIN_WAIT_MS) : MIN_WAIT_MS,
      maxWaitMs - waitedMs,
    );
    await sleep(waitMs);
    waitedMs += waitMs;
  }
}

/** Bind the throttle to one connection and one wait budget, producing the `throttle` dependency `createSafeFetch` takes (wired in `apps/workers/src/queues.ts`). The returned function is called with the registrable domain of the request being made — `registrableDomain(domainKey(host))`, the way `./safe-fetch.ts` derives it — so redirects, followed menu links and browser subrequests contend for the slot of the site they actually reach instead of taking one slot per host spelling (AAP 0.5.6). busy past the budget and with the Redis error when the lock cannot be reached at all. */
export function createDomainThrottle(
  redis: Pick<Redis, 'set' | 'pttl'>,
  opts?: { maxWaitMs?: number },
): (domain: string) => Promise<void> {
  const maxWaitMs = opts?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  return (domain: string) => acquireDomainSlot(redis, domain, { maxWaitMs });
}
