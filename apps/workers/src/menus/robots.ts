/**
 * robots.txt compliance for the menu crawler (AAP 0.5.6).
 *
 * Every request the menu pipeline makes — the entry URL, each redirect target, each followed menu link, and each request the
 * Playwright context issues — is checked here first, so a path a site disallows is never requested.
 *
 * The module owns no network access of its own: the robots.txt body arrives through the injected {@link RobotsFetch}, which
 * `./safe-fetch.ts` implements with the full request-safety chain, so the checker cannot be used to reach a host that chain
 * refuses. It reads no clock either, because the 24-hour lifetime is delegated to Redis' `PX` on the store, which keeps the
 * cache correct across processes and API replicas without a sweeper. Robots bodies are never logged.
 */

import { createRequire } from 'node:module';

import type { Redis } from 'ioredis';

/** Load robots-parser 3.0.1, which is CommonJS (`module.exports = robotsParser`) with typings that declare a default export. Under `NodeNext` resolution TypeScript models that module for a default import as the namespace rather than as a callable, so the constructor is taken through `createRequire`, the one shape that both typechecks and resolves at runtime under Node ESM, Vitest and tsx. The `Robot` instance it returns carries the `isAllowed` this module calls. */
const robotsParser = createRequire(import.meta.url)(
  'robots-parser',
) as typeof import('robots-parser').default;
/** The product token the crawler identifies itself by, without its version: the form a robots.txt `User-agent` line names and the form robots-parser matches after stripping the version. */
export const ROBOTS_PRODUCT_TOKEN = 'TablemateBot';
/** The `User-agent` string every Tablemate fetch sends (AAP 0.5.6): `TablemateBot/1.0` followed by the operator's contact URL, so a site owner can reach the operator instead of blocking the bot. `apps/workers/src/places/overpass.ts` sends the same string to Overpass. */
export function crawlerUserAgent(contactUrl: string): string {
  return `${ROBOTS_PRODUCT_TOKEN}/1.0 (+${contactUrl})`;
}

/** How long a fetched robots.txt is reused: 24 hours (AAP 0.5.6). */
export const ROBOTS_CACHE_TTL_MS = 86_400_000;
/** How much of a robots.txt body is parsed. RFC 9309 caps parsing at 500 KiB; a longer file is truncated rather than skipped, so the directives in its first bytes still apply (AAP 0.5.6). */
const ROBOTS_MAX_BODY_BYTES = 500 * 1024;
/** Cached value meaning "every path is allowed", stored when the site's robots.txt is unavailable (a 4xx answer, RFC 9309 §2.3.1.3). It starts with a NUL, so it can never be a body a site served. */
export const ROBOTS_ALLOW_ALL = '\u0000ALLOW_ALL';
/** Cached value meaning "no path is allowed", stored when the site's robots.txt cannot be reached at all (RFC 9309 §2.3.1.4) or its answer is unusable (a 5xx or an unfollowed redirect). Also a NUL prefix, so it can never collide with a real body. */
export const ROBOTS_DISALLOW_ALL = '\u0000DISALLOW_ALL';
/** Where a fetched robots.txt is kept between checks, keyed by origin. */
export interface RobotsCache {
  get(origin: string): Promise<string | null>;
  set(origin: string, value: string, ttlMs: number): Promise<void>;
}

/** The shared robots.txt cache: one Redis key per origin, expiring on its own after {@link ROBOTS_CACHE_TTL_MS} (AAP 0.5.6). Sharing it means a redirect target, a followed menu link and a browser subrequest for a host that was already checked cost no second fetch. the only place a connection is built. */
export function createRedisRobotsCache(redis: Pick<Redis, 'get' | 'set'>): RobotsCache {
  const keyFor = (origin: string): string => `robots:${origin}`;
  return {
    get: (origin) => redis.get(keyFor(origin)),
    set: async (origin, value, ttlMs) => {
      // Redis' own expiry carries the TTL, so nothing here has to read the clock or prune entries.
      await redis.set(keyFor(origin), value, 'PX', ttlMs);
    },
  };
}

/** A process-local cache that ignores the TTL it is handed. It is deliberately not the production store: it exists for `apps/workers/eval/menus-eval.ts` and tests, which need repeated checks within one process to hit a store that needs no Redis. */
export function createMemoryRobotsCache(): RobotsCache {
  const bodies = new Map<string, string>();
  return {
    get: (origin) => Promise.resolve(bodies.get(origin) ?? null),
    set: (origin, value) => {
      bodies.set(origin, value);
      return Promise.resolve();
    },
  };
}

/** Fetch one origin's robots.txt. `<origin>/robots.txt`. request safety, unreachable or timed out. A caller must treat `null` as "nothing may be crawled", never as "no robots.txt". */
export type RobotsFetch = (origin: string) => Promise<{ status: number; body: string } | null>;
/** What {@link RobotsFetch} resolves to: the answer, or `null` when no answer came back. */
type RobotsFetchResult = Awaited<ReturnType<RobotsFetch>>;
/** The one question the crawler asks about a URL (AAP 0.5.6). */
export interface RobotsChecker {
  isAllowed(url: URL): Promise<boolean>;
}

/** Build the checker the menu pipeline calls before every request (AAP 0.5.6). The rules follow RFC 9309: a cached body is reused for 24 hours; an unreachable robots.txt disallows everything (§2.3.1.4), an unavailable one allows everything (§2.3.1.3), and a served one is evaluated for this crawler's group, falling back to `*`. Crawl-delay is not read, because the per-domain throttle in `./domain-throttle.ts` already holds every domain to one request per second. */
export function createRobotsChecker(deps: {
  fetchRobotsTxt: RobotsFetch;
  cache: RobotsCache;
  userAgent: string;
}): RobotsChecker {
  return {
    async isAllowed(url: URL): Promise<boolean> {
      const origin = url.origin;
      const cached = await deps.cache.get(origin);
      const body = cached ?? (await fetchAndStore(origin, deps));
      if (body === ROBOTS_ALLOW_ALL) {
        return true;
      }
      if (body === ROBOTS_DISALLOW_ALL) {
        return false;
      }
      // The parsed file is anchored at the origin that served it, so `isAllowed` answers `undefined` for a URL off that origin; such a URL is outside what the file permits and is refused rather than crawled unchecked.
      return (
        robotsParser(`${origin}/robots.txt`, body).isAllowed(url.href, deps.userAgent) ?? false
      );
    },
  };
}

/** Fetch one origin's robots.txt and cache what it means for this crawler. */
async function fetchAndStore(
  origin: string,
  deps: { fetchRobotsTxt: RobotsFetch; cache: RobotsCache },
): Promise<string> {
  let response: RobotsFetchResult;
  try {
    response = await deps.fetchRobotsTxt(origin);
  } catch {
    // A throw is the same as an unreachable server: nothing was read, so nothing may be crawled.
    response = null;
  }
  const stored = storedBodyFor(response);
  await deps.cache.set(origin, stored, ROBOTS_CACHE_TTL_MS);
  return stored;
}

/** Decide what a fetch result means (RFC 9309 §2.3.1). */
function storedBodyFor(response: RobotsFetchResult): string {
  if (response === null) {
    return ROBOTS_DISALLOW_ALL;
  }
  if (response.status >= 200 && response.status < 300) {
    return response.body.slice(0, ROBOTS_MAX_BODY_BYTES);
  }
  if (response.status >= 400 && response.status < 500) {
    // The site is reachable and says there is no robots.txt: crawling is not restricted.
    return ROBOTS_ALLOW_ALL;
  }
  // A 5xx, an unfollowed 3xx or any other status is no usable answer: crawl nothing for this host.
  return ROBOTS_DISALLOW_ALL;
}
