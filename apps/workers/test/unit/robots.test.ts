/**
 * The robots.txt rule's unit suite (AAP 0.5.6, 0.12.2): the crawler's identity, the paths a served
 * file allows and disallows, the RFC 9309 answers for a file that is unavailable, unreachable or
 * unusable, and the 24-hour cache that keeps a fetched body from being fetched again.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createTestClock, type TestClock } from '@tablemate/server-core';

import {
  ROBOTS_CACHE_TTL_MS,
  ROBOTS_PRODUCT_TOKEN,
  crawlerUserAgent,
  createRobotsChecker,
  type RobotsCache,
  type RobotsChecker,
  type RobotsFetch,
} from '../../src/menus/robots.ts';

const CONTACT_URL = 'https://example.test/contact';
const USER_AGENT = crawlerUserAgent(CONTACT_URL);
const ORIGIN = 'http://menu.fixture.test';

type RobotsAnswer = { status: number; body: string };

const DISALLOW_PRIVATE = 'User-agent: *\nDisallow: /private\n';
const DISALLOW_EVERYTHING = 'User-agent: *\nDisallow: /\n';
const ALLOW_EVERYTHING = 'User-agent: *\nAllow: /\n';

const answers = new Map<string, RobotsAnswer | null>();
const fetches = new Map<string, number>();

const fetchRobotsTxt: RobotsFetch = (origin) => {
  fetches.set(origin, (fetches.get(origin) ?? 0) + 1);
  return Promise.resolve(answers.get(origin) ?? null);
};

/**
 * The cache contract timed by the injected clock: a value lives until the TTL it was stored with
 * runs out. The production store gets that lifetime from Redis' `PX`, so a deadline here is the same
 * rule the checker is written against.
 */
function createTimedCache(clock: TestClock): RobotsCache {
  const entries = new Map<string, { value: string; expiresAtMs: number }>();
  return {
    get: (origin) => {
      const entry = entries.get(origin);
      if (entry === undefined || entry.expiresAtMs <= clock.nowMs()) {
        entries.delete(origin);
        return Promise.resolve(null);
      }
      return Promise.resolve(entry.value);
    },
    set: (origin, value, ttlMs) => {
      entries.set(origin, { value, expiresAtMs: clock.nowMs() + ttlMs });
      return Promise.resolve();
    },
  };
}

let clock: TestClock;
let checker: RobotsChecker;

function allows(origin: string, path: string): Promise<boolean> {
  return checker.isAllowed(new URL(path, origin));
}

beforeEach(() => {
  clock = createTestClock({ start: new Date('2026-11-10T10:00:00.000Z'), mode: 'frozen' });
  answers.clear();
  fetches.clear();
  checker = createRobotsChecker({
    fetchRobotsTxt,
    cache: createTimedCache(clock),
    userAgent: USER_AGENT,
  });
});

describe('crawler identity', () => {
  it('sends the product token with the operator contact URL', () => {
    expect(crawlerUserAgent(CONTACT_URL)).toBe('TablemateBot/1.0 (+https://example.test/contact)');
    expect(ROBOTS_PRODUCT_TOKEN).toBe('TablemateBot');
  });
});

describe('a served robots.txt', () => {
  it.each([
    ['/private', false],
    ['/private/menu', false],
    ['/menu', true],
    // `Disallow` is a path prefix, not a substring: this path is not under `/private`.
    ['/public/private-notes', true],
  ] as const)('`Disallow: /private` on %s -> allowed: %s', async (path, allowed) => {
    answers.set(ORIGIN, { status: 200, body: DISALLOW_PRIVATE });
    await expect(allows(ORIGIN, path)).resolves.toBe(allowed);
    expect(fetches.get(ORIGIN)).toBe(1);
  });

  it.each([
    ['/menu', true],
    ['/menu/starters', true],
    ['/admin', false],
    // A group for this crawler replaces `*` entirely, so a path it never names is allowed.
    ['/other', true],
  ] as const)('the TablemateBot group over `*` on %s -> allowed: %s', async (path, allowed) => {
    answers.set(ORIGIN, {
      status: 200,
      body: 'User-agent: *\nDisallow: /\n\nUser-agent: TablemateBot\nAllow: /menu\nDisallow: /admin\n',
    });
    await expect(allows(ORIGIN, path)).resolves.toBe(allowed);
  });
});

describe('robots.txt that cannot be used', () => {
  /**
   * RFC 9309 §2.3.1. Each row serves a body whose directives say the opposite of the verdict, so the
   * row fails the moment the status stops deciding and the body is parsed instead. The second ask is
   * the other half of the rule: the verdict is cached like a body, so a host that cannot answer is not
   * asked again on every request.
   */
  it.each([
    ['a 404 whose body disallows everything', { status: 404, body: DISALLOW_EVERYTHING }, true],
    ['a 410 whose body disallows everything', { status: 410, body: DISALLOW_EVERYTHING }, true],
    ['a 500 whose body allows everything', { status: 500, body: ALLOW_EVERYTHING }, false],
    ['a 503 whose body allows everything', { status: 503, body: ALLOW_EVERYTHING }, false],
    ['a 302 that is not followed', { status: 302, body: ALLOW_EVERYTHING }, false],
    ['no answer at all', null, false],
  ] as const)('%s -> allowed: %s', async (_label, answer, allowed) => {
    answers.set(ORIGIN, answer);
    await expect(allows(ORIGIN, '/menu')).resolves.toBe(allowed);
    await expect(allows(ORIGIN, '/menu')).resolves.toBe(allowed);
    expect(fetches.get(ORIGIN)).toBe(1);
  });

  it('treats a fetch that throws as unreachable', async () => {
    const refused = createRobotsChecker({
      fetchRobotsTxt: () => Promise.reject(new Error('request safety refused the host')),
      cache: createTimedCache(clock),
      userAgent: USER_AGENT,
    });
    await expect(refused.isAllowed(new URL('/menu', ORIGIN))).resolves.toBe(false);
  });
});

describe('the robots.txt cache', () => {
  it('reuses a fetched body until the TTL runs out, then fetches again', async () => {
    answers.set(ORIGIN, { status: 200, body: DISALLOW_PRIVATE });
    await expect(allows(ORIGIN, '/private/menu')).resolves.toBe(false);
    expect(fetches.get(ORIGIN)).toBe(1);
    // 23 h 59 m on, the cached body still governs and the site is not asked again.
    clock.advance(ROBOTS_CACHE_TTL_MS - 60_000);
    await expect(allows(ORIGIN, '/menu')).resolves.toBe(true);
    expect(fetches.get(ORIGIN)).toBe(1);
    // Two minutes later the TTL has passed, so the site is asked again and the new body takes over.
    answers.set(ORIGIN, { status: 200, body: DISALLOW_EVERYTHING });
    clock.advance(2 * 60_000);
    await expect(allows(ORIGIN, '/menu')).resolves.toBe(false);
    expect(fetches.get(ORIGIN)).toBe(2);
  });

  it('caches each origin separately', async () => {
    const first = 'http://a.fixture.test';
    const second = 'http://b.fixture.test';
    answers.set(first, { status: 200, body: DISALLOW_PRIVATE });
    answers.set(second, { status: 200, body: DISALLOW_EVERYTHING });
    await expect(allows(first, '/menu')).resolves.toBe(true);
    await expect(allows(second, '/menu')).resolves.toBe(false);
    clock.advance(ROBOTS_CACHE_TTL_MS - 1);
    await expect(allows(second, '/menu/onwards')).resolves.toBe(false);
    expect(fetches.get(first)).toBe(1);
    expect(fetches.get(second)).toBe(1);
  });
});
