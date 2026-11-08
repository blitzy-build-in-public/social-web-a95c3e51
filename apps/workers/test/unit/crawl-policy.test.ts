/**
 * Site-terms decisions for the menu crawler (AAP 0.5.6, 0.12.2): a blocklisted domain is
 * `prohibited`, a domain no operator has judged yet is recorded `uncertain` *before* its first fetch
 * and is not fetched while it stays so, a recorded decision stands until an operator or the
 * blocklist changes it, and both `prohibited` and `uncertain` leave the place to the phone fallback
 * rather than to a guessed price.
 *
 * The evidence is behaviour: the decision `domainDecision` returns, the writes it did and did not
 * make, and — in the last row — a loopback fixture server that counts every request, so an
 * unreviewed host is proved never fetched rather than assumed to be. The review-site domain is read
 * from `config/crawl-blocklist.json` at runtime and never written here; every other host is a
 * reserved `.test` name or the loopback literal, and no database or Redis is touched.
 */

import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestClock } from '@tablemate/server-core';
import type { CrawlDecision } from '@tablemate/shared';

import { findRepoRoot, isBlocklisted, loadBlocklist } from '../../src/menus/blocklist.ts';
import {
  REASON_AWAITING_REVIEW,
  REASON_BLOCKLIST,
  domainDecision,
  domainKey,
  fallbackFor,
  registrableDomain,
  type CrawlPolicyRow,
  type CrawlPolicyStore,
} from '../../src/menus/crawl-policy.ts';
import { crawlerUserAgent, createMemoryRobotsCache } from '../../src/menus/robots.ts';
import {
  SafeFetchError,
  createFetchBudget,
  createSafeFetch,
  type LookupFn,
  type SafeFetch,
  type SafeFetchDeps,
} from '../../src/menus/safe-fetch.ts';

/** The frozen instant every row records, the configured blocklist and the fixture material. */
const clock = createTestClock({ start: new Date('2026-11-10T10:00:00.000Z'), mode: 'frozen' });
const now = clock.now();
const blocklist = loadBlocklist(findRepoRoot());
const BLOCKED = [...blocklist.domains][0] ?? '';
const FIXTURES = fileURLToPath(new URL('../fixtures/sites/', import.meta.url));
const USER_AGENT = crawlerUserAgent('https://example.test/contact');

/** The host whose terms no operator has reviewed: the end-to-end row's subject (AAP 0.5.6). */
const UNREVIEWED_HOST = 'tasca.unreviewed.fixture.test';

/** One decision row the fake store holds, and one write it was asked for (AAP 0.5.2). */
type Row = {
  decision: CrawlDecision;
  reason: string;
  checkedAt: Date;
  overriddenBy: string | null;
};
type Write = { op: 'upsertProhibited' | 'insertUncertain'; domain: string };
type Store = { store: CrawlPolicyStore; rows: Map<string, Row>; writes: Write[] };

/**
 * The `CrawlPolicyStore` of a suite that needs no database (AAP 0.5.6): `insertUncertain` behaves as
 * the `ON CONFLICT DO NOTHING` insert it stands for, so a domain that is already known is neither
 * overwritten nor counted as a write, and `upsertProhibited` clears `overriddenBy` as the SQL does.
 *
 * @param seed Rows to pre-record, as `[domain, decision, overriddenBy?]`.
 * @returns The store, its rows and the writes it was asked for.
 */
function createStore(seed: readonly (readonly [string, CrawlDecision, string?])[] = []): Store {
  const rows = new Map<string, Row>();
  const writes: Write[] = [];

  for (const [domain, decision, overriddenBy] of seed) {
    const reason = overriddenBy === undefined ? REASON_AWAITING_REVIEW : 'operator_review';
    rows.set(domain, { decision, reason, checkedAt: now, overriddenBy: overriddenBy ?? null });
  }

  const store: CrawlPolicyStore = {
    find: (domains) =>
      Promise.resolve(
        domains.flatMap((domain): CrawlPolicyRow[] => {
          const row = rows.get(domain);
          return row === undefined ? [] : [{ domain, decision: row.decision }];
        }),
      ),
    upsertProhibited: (domain, reason, at) => {
      writes.push({ op: 'upsertProhibited', domain });
      rows.set(domain, { decision: 'prohibited', reason, checkedAt: at, overriddenBy: null });
      return Promise.resolve();
    },
    insertUncertain: (domain, at) => {
      if (!rows.has(domain)) {
        writes.push({ op: 'insertUncertain', domain });
        rows.set(domain, {
          decision: 'uncertain',
          reason: REASON_AWAITING_REVIEW,
          checkedAt: at,
          overriddenBy: null,
        });
      }
      return Promise.resolve();
    },
  };

  return { store, rows, writes };
}

/** The one decision a row asks for, on a store the row owns (AAP 0.5.6). */
const decide = (target: Store, host: string): Promise<CrawlDecision> =>
  domainDecision(target.store, host, clock.now(), blocklist);

describe('host keys', () => {
  it.each([
    ['WWW.Example.TEST', 'example.test'],
    ['menu.example.test.', 'menu.example.test'],
    ['menu.example.test:8443', 'menu.example.test'],
    ['127.0.0.1', '127.0.0.1'],
    ['[::1]:8080', '::1'],
    ['localhost', 'localhost'],
  ] as const)('domainKey(%s) -> %s', (host, key) => {
    expect(domainKey(host)).toBe(key);
  });

  it.each([
    ['a.b.co.uk', 'b.co.uk'],
    ['x.com.br', 'x.com.br'],
    ['menu.restaurante.com.mx', 'restaurante.com.mx'],
    ['shop.co.th', 'shop.co.th'],
    ['warung.co.id', 'warung.co.id'],
    ['tasca.com.pt', 'tasca.com.pt'],
    ['www.tasca.lisbon.fixture.test', 'fixture.test'],
    ['fixture.test', 'fixture.test'],
    ['127.0.0.1', '127.0.0.1'],
  ] as const)('registrableDomain(%s) -> %s', (host, domain) => {
    expect(registrableDomain(host)).toBe(domain);
  });

  it.each([
    [BLOCKED, true],
    [`menu.${BLOCKED}`, true],
    // An entry is a suffix match on label boundaries, never a substring one.
    [`not${BLOCKED}`, false],
    ['tasca.lisbon.fixture.test', false],
  ] as const)('isBlocklisted(%s) -> %s', (host, blocked) => {
    expect(isBlocklisted(host, blocklist)).toBe(blocked);
  });
});

describe('what a decision leaves the pipeline to do', () => {
  it.each([
    ['allowed', 'fetch'],
    ['prohibited', 'phone_fallback'],
    ['uncertain', 'phone_fallback'],
  ] as const)('fallbackFor(%s) -> %s', (decision, outcome) => {
    expect(fallbackFor(decision)).toBe(outcome);
  });
});

describe('domainDecision', () => {
  it('refuses a blocklisted domain at its registrable domain, recording the reason', async () => {
    const target = createStore();

    await expect(decide(target, `menu.${BLOCKED}`)).resolves.toBe('prohibited');
    expect(target.writes).toEqual([{ op: 'upsertProhibited', domain: registrableDomain(BLOCKED) }]);
    expect(target.rows.get(registrableDomain(BLOCKED))).toEqual({
      decision: 'prohibited',
      reason: REASON_BLOCKLIST,
      checkedAt: now,
      overriddenBy: null,
    });
  });

  it('lets the blocklist outrank an operator decision the crawler never rechecks', async () => {
    const target = createStore([[registrableDomain(BLOCKED), 'allowed', 'operator-1']]);

    await expect(decide(target, `menu.${BLOCKED}`)).resolves.toBe('prohibited');
    expect(target.writes).toEqual([{ op: 'upsertProhibited', domain: registrableDomain(BLOCKED) }]);
    expect(target.rows.get(registrableDomain(BLOCKED))?.overriddenBy).toBeNull();
  });

  it('records an unreviewed domain uncertain once, before its first fetch', async () => {
    const target = createStore();

    await expect(decide(target, 'tasca.unknown.fixture.test')).resolves.toBe('uncertain');
    expect(target.writes).toEqual([{ op: 'insertUncertain', domain: 'fixture.test' }]);
    expect(target.rows.get('fixture.test')).toEqual({
      decision: 'uncertain',
      reason: REASON_AWAITING_REVIEW,
      checkedAt: now,
      overriddenBy: null,
    });

    // The second attempt reads the row it recorded rather than inserting another one.
    await expect(decide(target, 'tasca.unknown.fixture.test')).resolves.toBe('uncertain');
    expect(target.writes).toHaveLength(1);
    expect(target.rows.size).toBe(1);
  });

  it("honours a decision for an exact host before the domain's, and rechecks neither", async () => {
    const target = createStore([
      ['lisbon.fixture.test', 'allowed', 'operator-1'],
      ['fixture.test', 'uncertain'],
      ['127.0.0.1', 'allowed', 'seed'],
    ]);

    await expect(decide(target, 'tasca.lisbon.fixture.test')).resolves.toBe('allowed');
    await expect(decide(target, 'other.fixture.test')).resolves.toBe('uncertain');
    await expect(decide(target, '127.0.0.1')).resolves.toBe('allowed');
    expect(target.writes).toEqual([]);
  });

  it('refuses a host that is itself a public suffix, recording no row for it', async () => {
    const target = createStore();

    // A row keyed on `com.ar` would stand for every site beneath it, with none of their terms read.
    await expect(decide(target, 'com.ar')).resolves.toBe('prohibited');
    expect(target.writes).toEqual([]);
    expect(target.rows.size).toBe(0);
  });
});

/** The loopback fixture server, the requests it received and the port it took. */
let server: Server | null = null;
let port = 0;
let hits = 0;

/** The resolver's calls and the log lines the modules under test wrote (AAP 0.11.1). */
const lookups: string[] = [];
const logs: Record<string, unknown>[] = [];

/** The recording resolver: the fixture host answers on the loopback literal. */
const lookup: LookupFn = (host) => {
  lookups.push(host);
  return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
};

/** The logger `createSafeFetch` takes: it keeps every line and writes nothing. */
const logger = {
  debug: (line: Record<string, unknown>) => {
    logs.push(line);
  },
  warn: (line: Record<string, unknown>) => {
    logs.push(line);
  },
} as unknown as SafeFetchDeps['logger'];

/**
 * The real request-safety chain over a fresh store (AAP 0.5.6): the fixture host is exempt from the
 * private-address check as `CRAWL_ALLOW_PRIVATE_HOSTS` exempts it in `APP_ENV=test`, and the
 * per-domain slot is an immediate no-op, because one request a second per domain is not this row's
 * subject.
 */
function buildFetch(target: Store): SafeFetch {
  return createSafeFetch({
    lookup,
    allowPrivateHosts: [UNREVIEWED_HOST],
    appEnv: 'test',
    blocklist,
    policy: (host) => domainDecision(target.store, host, clock.now(), blocklist),
    robotsCache: createMemoryRobotsCache(),
    throttle: () => Promise.resolve(),
    userAgent: USER_AGENT,
    logger,
    clock,
  });
}

/** The refusal of one fetch, or `null` when it was permitted and must have been refused. */
async function refusalOf(fetch: SafeFetch, url: string): Promise<SafeFetchError | null> {
  try {
    await fetch(url, { kind: 'html', budget: createFetchBudget() });
    return null;
  } catch (error) {
    return error instanceof SafeFetchError ? error : null;
  }
}

/** Start the fixture server on any free loopback port. */
function listen(fixture: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    fixture.once('error', reject);
    fixture.listen(0, '127.0.0.1', () => {
      const address = fixture.address();
      if (address === null || typeof address === 'string') reject(new Error('no bound port'));
      else resolve(address.port);
    });
  });
}

/** Stop the fixture server, closing the sockets it still holds so the suite ends promptly. */
async function stop(fixture: Server | null): Promise<void> {
  if (fixture === null) return;
  fixture.closeAllConnections();
  await new Promise<void>((resolve) => {
    fixture.close(() => resolve());
  });
}

beforeAll(async () => {
  const html = await readFile(join(FIXTURES, 'menu-html/index.html'));
  server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(html.length) });
    res.end(html);
  });
  server.on('error', () => undefined);
  port = await listen(server);
});

afterAll(async () => {
  await stop(server);
});

describe('an unreviewed host is never fetched', () => {
  it('refuses the request before any connection, and records the domain for review', async () => {
    const target = createStore();
    const fetch = buildFetch(target);
    const url = `http://${UNREVIEWED_HOST}:${port}/menu-html/`;

    const refusal = await refusalOf(fetch, url);
    expect(refusal?.reason).toBe('policy_uncertain');
    expect(refusal?.host).toBe(UNREVIEWED_HOST);

    // Not one request reached the fixture server — not even for its robots.txt — and the host was
    // never resolved, because the decision precedes both (AAP 0.5.6).
    expect(hits).toBe(0);
    expect(lookups).toEqual([]);
    expect(logs).toEqual([
      {
        event: 'menu_fetch_refused',
        host: UNREVIEWED_HOST,
        kind: 'html',
        dropReason: 'policy_uncertain',
      },
    ]);

    // The domain is on the operator's review queue from the first attempt (AAP 0.5.4).
    expect(target.rows.get('fixture.test')?.decision).toBe('uncertain');
    expect(target.writes).toEqual([{ op: 'insertUncertain', domain: 'fixture.test' }]);
  });
});
