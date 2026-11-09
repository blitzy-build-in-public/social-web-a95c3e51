/**
 * Request safety, resource bounds and the sandboxed browser for the menu crawl (AAP 0.5.6, 0.12.2).
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestClock } from '@tablemate/server-core';
import type { CrawlDecision } from '@tablemate/shared';

import { findRepoRoot, loadBlocklist } from '../../src/menus/blocklist.ts';
import { createBrowserProvider, renderPage } from '../../src/menus/fetch-page.ts';
import type { BrowserProvider, RenderResult } from '../../src/menus/fetch-page.ts';
import {
  crawlerUserAgent,
  createMemoryRobotsCache,
  createRobotsChecker,
} from '../../src/menus/robots.ts';
import {
  FETCH_LIMITS,
  SafeFetchError,
  createFetchBudget,
  createSafeFetch,
  isBlockedAddress,
} from '../../src/menus/safe-fetch.ts';
import type {
  FetchBudget,
  FetchKind,
  LookupFn,
  SafeFetch,
  SafeFetchDeps,
  SafeFetchReason,
} from '../../src/menus/safe-fetch.ts';

/** The frozen instant, the crawler's identity, the fixture sites and the loaded blocklist. */
const clock = createTestClock({ start: new Date('2026-11-10T10:00:00.000Z'), mode: 'frozen' });
const userAgent = crawlerUserAgent('https://example.test/contact');
const FIXTURES = fileURLToPath(new URL('../fixtures/sites/', import.meta.url));
const blocklist = loadBlocklist(findRepoRoot());

/** A blocklisted domain, read from configuration rather than written here (AAP 0.5.6). */
const BLOCKED_DOMAIN = [...blocklist.domains][0] ?? '';

/** The suffix the fake site-terms policy leaves unreviewed, so it is never fetched (AAP 0.5.6). */
const UNCERTAIN_SUFFIX = '.uncertain.fixture.test';

const PRIVATE_HOSTS = ['127.0.0.1', 'site.fixture.test', 'rebind.fixture.test'];

const SITE_FILES: Readonly<Record<string, string>> = {
  '/service-worker/': 'service-worker/index.html',
  '/service-worker/sw.js': 'service-worker/sw.js',
  '/menu-html/': 'menu-html/index.html',
  '/menu-pdf-link/': 'menu-pdf-link/index.html',
  '/login-wall/': 'login-wall/index.html',
  '/activity-tickets/': 'activity-tickets/index.html',
};

/** The body of `/small`: 1 KiB, identifiable as this server's so address pinning is observable. */
const SMALL_BODY = `server-a-small ${'s'.repeat(1000)}`;

const MIXED_FRAMES_BODY = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture mixed</title></head>',
  '<body><h1>Fixture mixed frames</h1>',
  '<iframe src="http://frames.uncertain.fixture.test/" title="Fixture frame"></iframe>',
  '<img src="http://img.uncertain.fixture.test/x.png" alt="">',
  '</body></html>',
].join('\n');

/** One request the local server received, which is the evidence that a connection was opened. */
type Hit = { readonly method: string; readonly path: string; readonly host: string };

type LogLine = Record<string, unknown>;

/** Every field a log line of this pipeline may carry — never a body, page text or a URL (AAP 0.11.1). */
const ALLOWED_LOG_KEYS = new Set([
  'event',
  'host',
  'kind',
  'status',
  'bytes',
  'durationMs',
  'reason',
  'outcome',
  'textChars',
  'pdfs',
  'images',
  'dropReason',
]);

const hitsA: Hit[] = [];
const hitsB: Hit[] = [];
const upgrades: string[] = [];

const lookups: string[] = [];
const throttleSlots: string[] = [];
let rebindAnswers = 0;
const logs: LogLine[] = [];
const allLogs: LogLine[] = [];

/** Every URL a fetch was asked for, with the reason when it was refused (the render rows). */
type Attempt = {
  readonly url: string;
  readonly kind: FetchKind;
  readonly reason: SafeFetchReason | null;
};
const attempts: Attempt[] = [];

const ZERO_CHUNK = Buffer.alloc(64 * 1024);

const REDIRECTS: Readonly<Record<string, string>> = {
  '/to-private': 'http://10.0.0.1/',
  '/to-blocked': `https://${BLOCKED_DOMAIN}/reviews`,
};

/**
 * Answer one request of the fixture server (AAP 0.5.6): the dynamic routes the bounds, redirect and
 * policy rows need, then the committed fixture sites.
 * @param target Where the hit is recorded.
 * @param req The request received.
 * @param res The response to answer.
 */
async function handle(target: Hit[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://fixture.invalid').pathname;
  target.push({ method: req.method ?? '', path, host: req.headers.host ?? '' });

  if (path === '/robots.txt') {
    // Allow-all, so every refusal in this suite belongs to the check under test and not to this file.
    send(res, 200, 'text/plain', 'User-agent: *\nAllow: /\n');
    return;
  }

  const location = REDIRECTS[path];
  if (location !== undefined) {
    send(res, 302, 'text/plain', '', { location });
    return;
  }

  const chain = /^\/redirect\/(\d+)$/.exec(path);
  if (chain !== null) {
    const remaining = Number(chain[1]);
    if (remaining === 0) send(res, 200, 'text/html', '<html><body>arrived</body></html>');
    else send(res, 302, 'text/plain', '', { location: `/redirect/${remaining - 1}` });
    return;
  }

  const status = /^\/status\/(\d+)$/.exec(path);
  if (status !== null) {
    send(res, Number(status[1]), 'text/plain', 'refused');
    return;
  }
  if (path === '/small') {
    send(res, 200, 'text/html', SMALL_BODY);
    return;
  }
  if (path === '/mixed-frames/') {
    send(res, 200, 'text/html', MIXED_FRAMES_BODY);
    return;
  }

  const big = /^\/big\/(html|image|pdf)\/(\d+)$/.exec(path);
  if (big !== null) {
    // The declared length is what `safeFetch` refuses before reading a byte; the stream is what it
    // refuses while reading, once the kind's own limit is passed.
    const type =
      big[1] === 'pdf' ? 'application/pdf' : big[1] === 'image' ? 'image/png' : 'text/html';
    const size = Number(big[2]);
    res.writeHead(200, { 'content-type': type, 'content-length': String(size) });
    writeZeros(res, size);
    return;
  }

  const file = SITE_FILES[path];
  if (file === undefined) {
    send(res, 404, 'text/plain', 'not found');
    return;
  }
  send(
    res,
    200,
    file.endsWith('.js') ? 'text/javascript' : 'text/html',
    await readFile(join(FIXTURES, file)),
  );
}

/**
 * Write `bytes` zeros and end the response.
 * @param res The response to write to.
 * @param bytes How many zero bytes to send.
 */
function writeZeros(res: ServerResponse, bytes: number): void {
  let written = 0;

  const next = (): void => {
    while (written < bytes) {
      const size = Math.min(ZERO_CHUNK.length, bytes - written);
      written += size;
      if (!res.write(ZERO_CHUNK.subarray(0, size))) {
        res.once('drain', next);
        return;
      }
    }
    res.end();
  };

  next();
}

/**
 * Answer one response completely (AAP 0.5.6).
 * @param res The response to answer.
 * @param status The status to send.
 * @param type Its `Content-Type`.
 * @param body The body, a string or the bytes read from a fixture file.
 * @param headers Any further headers, such as the `Location` of a redirect.
 */
function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': type,
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

/**
 * Build one fixture server: it records every request and every WebSocket upgrade attempt, and answers
 * from {@link handle}.
 * @param target Where its hits are recorded.
 * @param label The server's name, used when an upgrade is recorded.
 * @returns The server, not yet listening.
 */
function fixtureServer(target: Hit[], label: string): Server {
  const server = createServer((req, res) => {
    // A refused address never reads a body and the declared-length row drops the response as soon as
    // it sees the header, so both halves are closed early; an unhandled socket error would crash.
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    void handle(target, req, res).catch(() => res.destroy());
  });
  server.on('error', () => undefined);
  server.on('upgrade', (req, socket) => {
    upgrades.push(`${label} ${req.url ?? ''}`);
    socket.destroy();
  });

  return server;
}

/**
 * Start a server, resolving with the port it was given.
 * @param server The server to start.
 * @param host The address to bind, so server B can sit on the second loopback address.
 * @param port The port, `0` for any free one.
 * @returns The bound port.
 */
function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      server.removeListener('error', reject);
      if (address === null || typeof address === 'string')
        reject(new Error(`no address for ${host}`));
      else resolve(address.port);
    });
  });
}

/**
 * Stop a server, closing the sockets it still holds so the suite ends promptly.
 * @param server The server to stop, when one was started.
 */
async function stop(server: Server | null): Promise<void> {
  if (server === null) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/** Server A answers every permitted request; server B sits on the address a rebind would reach. */
let portA = 0;
let serverA: Server | null = null;
let serverB: Server | null = null;
let hasSecondLoopback = false;

/**
 * The recording resolver (AAP 0.5.6): every hostname is a `.test` name answered locally, so nothing
 * leaves the host, and the rebinding host answers a different address on its second call so a
 * connection that resolved twice would be observable.
 */
const lookup: LookupFn = (host) => {
  lookups.push(host);
  const answers = (address: string): { address: string; family: 4 | 6 }[] => [
    { address, family: 4 },
  ];

  switch (host) {
    case 'site.fixture.test':
    case '127.0.0.1':
      return Promise.resolve(answers('127.0.0.1'));
    case 'public.fixture.test':
      return Promise.resolve(answers('93.184.216.34'));
    case 'mixed.fixture.test':
      // One public answer and one private one: every answer is judged, so the host is refused.
      return Promise.resolve([...answers('93.184.216.34'), ...answers('10.0.0.1')]);
    case 'private-name.fixture.test':
      return Promise.resolve(answers('10.0.0.1'));
    case '127.0.0.1.nip.test':
      // A name that is not the exempt literal, so the exemption is not what permits a request.
      return Promise.resolve(answers('127.0.0.1'));
    case 'rebind.fixture.test': {
      rebindAnswers += 1;
      return Promise.resolve(answers(rebindAnswers === 1 ? '127.0.0.1' : '127.0.0.2'));
    }
    default:
      // A hostname this suite never planned to resolve means a row reached a host it did not intend
      // to; the module turns the rejection into `dns_failed`.
      return Promise.reject(new Error(`unexpected lookup for ${host}`));
  }
};

/**
 * The suite's site-terms decision (AAP 0.5.6): every host was approved by an operator except the ones
 * on the unreviewed suffix, which must be refused before anything is fetched or resolved.
 */
const policy = (host: string): Promise<CrawlDecision> =>
  Promise.resolve(host.endsWith(UNCERTAIN_SUFFIX) ? 'uncertain' : 'allowed');

const throttle = (domain: string): Promise<void> => {
  throttleSlots.push(domain);
  return Promise.resolve();
};

const record = (line: LogLine): void => {
  logs.push(line);
  allLogs.push(line);
};

const logger = {
  debug: record,
  info: record,
  warn: record,
} as unknown as SafeFetchDeps['logger'] & Parameters<typeof renderPage>[1]['logger'];

const robotsCache = createMemoryRobotsCache();

const safeFetch: SafeFetch = createSafeFetch({
  lookup,
  allowPrivateHosts: PRIVATE_HOSTS,
  appEnv: 'test',
  blocklist,
  policy,
  robotsCache,
  throttle,
  userAgent,
  logger,
  clock,
});

/**
 * `safeFetch` with every call and its refusal recorded: a browser subrequest that is refused leaves
 * no other trace, because the same fetch refused it before any socket existed.
 */
const recordingFetch: SafeFetch = async (url, opts) => {
  try {
    const answer = await safeFetch(url, opts);
    attempts.push({ url, kind: opts.kind, reason: null });
    return answer;
  } catch (error) {
    attempts.push({
      url,
      kind: opts.kind,
      reason: error instanceof SafeFetchError ? error.reason : null,
    });
    throw error;
  }
};

let browser: BrowserProvider | null = null;

/**
 * Fetch `url` and answer with the reason it was refused, failing when it was permitted instead.
 * @param url The URL to fetch.
 * @param kind The kind of document, `html` when omitted.
 * @param budget The place's budget, a fresh one when omitted.
 * @returns The refusal's reason.
 */
async function reasonFor(
  url: string,
  kind: FetchKind = 'html',
  budget: FetchBudget = createFetchBudget(),
): Promise<SafeFetchReason> {
  try {
    await safeFetch(url, { kind, budget });
  } catch (error) {
    if (error instanceof SafeFetchError) return error.reason;
    throw error;
  }

  throw new Error(`${url} was permitted, and the row expects a refusal`);
}

/** One URL of a route on server A, reached by name rather than by its loopback literal. */
const onSite = (path: string): string => `http://site.fixture.test:${portA}${path}`;

const render = (url: string): Promise<RenderResult> =>
  renderPage(url, {
    browser: sharedBrowser(),
    safeFetch: recordingFetch,
    budget: createFetchBudget(),
    userAgent,
    logger,
  });

/** The shared browser, which the suite's own `beforeAll` has started a provider for. */
function sharedBrowser(): BrowserProvider {
  if (browser === null) throw new Error('the browser provider was never created');
  return browser;
}

/**
 * The reasons the recorded fetches were refused for, optionally only those whose URL contains
 * `filter`; a permitted request has no reason and is left out.
 * @param filter A substring every counted URL must carry.
 * @returns The reasons, in the order the fetches were made.
 */
function refusalReasons(filter?: string): SafeFetchReason[] {
  return attempts
    .filter((attempt) => filter === undefined || attempt.url.includes(filter))
    .flatMap((attempt) => (attempt.reason === null ? [] : [attempt.reason]));
}

beforeAll(async () => {
  // A host without the browser is an environment failure rather than a pass: the render rows are the
  // only evidence for the sandboxed browser, and they cannot be skipped quietly.
  if (!existsSync(chromium.executablePath())) {
    throw new Error('Run: pnpm --filter @tablemate/workers exec playwright install chromium');
  }

  serverA = fixtureServer(hitsA, 'A');
  portA = await listen(serverA, '127.0.0.1', 0);

  // The second loopback address exists on Linux. Where it does not, the rebinding row still proves the
  // single resolution, and the assertion about server B is skipped rather than faked.
  serverB = fixtureServer(hitsB, 'B');
  try {
    await listen(serverB, '127.0.0.2', portA);
    hasSecondLoopback = true;
  } catch {
    hasSecondLoopback = false;
  }

  // The rebinding row measures one hop, so the origin's robots.txt is served from the cache: a network
  // fetch would be a hop of its own and would take the first answer the resolver gives.
  const warm = createRobotsChecker({
    cache: robotsCache,
    userAgent,
    fetchRobotsTxt: () => Promise.resolve({ status: 200, body: 'User-agent: *\nAllow: /\n' }),
  });
  await warm.isAllowed(new URL(`http://rebind.fixture.test:${portA}/small`));

  browser = createBrowserProvider();
});

afterAll(async () => {
  await browser?.close();
  await stop(serverB);
  await stop(serverA);
});

beforeEach(() => {
  hitsA.length = 0;
  hitsB.length = 0;
  upgrades.length = 0;
  lookups.length = 0;
  logs.length = 0;
  attempts.length = 0;
  throttleSlots.length = 0;
  rebindAnswers = 0;
});

/** Every address class the crawler may never connect to (AAP 0.5.6). */
const BLOCKED_ADDRESSES = [
  '127.0.0.1',
  '10.0.0.1',
  '172.16.0.1',
  '192.168.1.1',
  '169.254.169.254', // the cloud metadata address
  '100.64.0.1',
  '224.0.0.1',
  '0.0.0.0',
  '255.255.255.255',
  '::1',
  'fc00::1',
  'fe80::1',
  '::ffff:10.0.0.1', // an IPv4 address carried inside an IPv6 literal
  '::',
] as const;

const PUBLIC_ADDRESSES = [
  '93.184.216.34',
  '8.8.8.8',
  '2606:4700::1111',
  '172.32.0.1',
  '100.128.0.1',
] as const;

/** Values that are not addresses at all, which fail closed rather than open (AAP 0.5.6). */
const NON_ADDRESSES = ['', 'not-an-address', '999.1.1.1', 'fe80::1%eth0'] as const;

const HOSTILE_HOSTS = [
  'uncertain.fixture.test',
  '169.254.169.254',
  '10.255.0.1',
  '10.0.0.1',
] as const;

/** The refusals that happen before a socket exists, the only kind a hostile URL may earn. */
const PRE_CONNECTION_REFUSALS: ReadonlySet<SafeFetchReason> = new Set([
  'blocked_address',
  'policy_uncertain',
  'policy_prohibited',
  'blocklisted',
  'scheme',
  'port',
]);

const isHostile = (url: string): boolean => HOSTILE_HOSTS.some((host) => url.includes(host));

/** A URL and the reason the chain refuses it before any connection is made (AAP 0.5.6). */
type Refusal = readonly [url: string, reason: SafeFetchReason];

/** Hosts that resolve to an address no request may reach, and the reason each earns. */
const ADDRESS_REFUSALS: readonly Refusal[] = [
  ['http://private-name.fixture.test/', 'blocked_address'],
  ['http://127.0.0.1.nip.test/', 'blocked_address'],
  ['http://mixed.fixture.test/', 'blocked_address'],
];

/** Schemes the crawler never follows. */
const SCHEME_URLS = [
  'ftp://site.fixture.test/',
  'file:///etc/passwd',
  'data:text/html,hi',
  'javascript:alert(1)',
] as const;

describe('isBlockedAddress', () => {
  it.each(BLOCKED_ADDRESSES)('refuses %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(PUBLIC_ADDRESSES)('permits %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it.each(NON_ADDRESSES)('fails closed on %s', (value) => {
    expect(isBlockedAddress(value)).toBe(true);
  });
});

describe('safeFetch addresses', () => {
  it.each(ADDRESS_REFUSALS)('refuses %s with %s', async (url, reason) => {
    await expect(reasonFor(url)).resolves.toBe(reason);
    expect(lookups).toHaveLength(1);
    expect(hitsA).toEqual([]);
    expect(hitsB).toEqual([]);
    expect(throttleSlots).toEqual([]);
  });

  it('resolves a host once and connects to the address that passed the check', async () => {
    const answer = await safeFetch(`http://rebind.fixture.test:${portA}/small`, {
      kind: 'html',
      budget: createFetchBudget(),
    });
    expect(answer.status).toBe(200);
    expect(answer.body.toString('utf8')).toBe(SMALL_BODY);
    // One resolution for the hop, so a second answer is never consulted at connect time.
    expect(lookups.filter((host) => host === 'rebind.fixture.test')).toHaveLength(1);
    expect(hitsA.filter((hit) => hit.path === '/small')).toHaveLength(1);
    expect((await lookup('rebind.fixture.test'))[0]?.address).toBe('127.0.0.2');
    if (hasSecondLoopback) expect(hitsB).toEqual([]);
  });
});

describe('safeFetch hops', () => {
  it('refuses a redirect chain past the limit', async () => {
    await expect(reasonFor(onSite(`/redirect/${FETCH_LIMITS.maxRedirects + 1}`))).resolves.toBe(
      'redirect_limit',
    );
  });

  it('follows a redirect chain at the limit', async () => {
    const answer = await safeFetch(onSite(`/redirect/${FETCH_LIMITS.maxRedirects}`), {
      kind: 'html',
      budget: createFetchBudget(),
    });
    expect(answer.status).toBe(200);
    expect(answer.body.toString('utf8')).toContain('arrived');
  });

  it('re-validates a redirect target rather than trusting the page that sent it', async () => {
    await expect(reasonFor(onSite('/to-private'))).resolves.toBe('blocked_address');
  });

  it('refuses a redirect to a blocklisted domain before it is resolved', async () => {
    expect(BLOCKED_DOMAIN).not.toBe('');
    await expect(reasonFor(onSite('/to-blocked'))).resolves.toBe('blocklisted');
    expect(
      lookups.filter((host) => host === BLOCKED_DOMAIN || host.endsWith(`.${BLOCKED_DOMAIN}`)),
    ).toEqual([]);
  });

  it.each(SCHEME_URLS)('refuses %s without touching the network', async (url) => {
    await expect(reasonFor(url)).resolves.toBe('scheme');
    expect(lookups).toEqual([]);
    expect(hitsA).toEqual([]);
    expect(throttleSlots).toEqual([]);
  });

  it('refuses a port that is neither 80 nor 443 on a host that is not exempt', async () => {
    await expect(reasonFor('http://public.fixture.test:8080/')).resolves.toBe('port');
    expect(lookups).toEqual([]);
  });

  it.each([401, 403])('refuses a %i answer as a login wall', async (status) => {
    await expect(reasonFor(onSite(`/status/${status}`))).resolves.toBe('auth_required');
  });
});

describe('safeFetch bounds', () => {
  it('refuses an HTML body over the limit before it is read', async () => {
    await expect(reasonFor(onSite(`/big/html/${FETCH_LIMITS.html + 1}`), 'html')).resolves.toBe(
      'too_large',
    );
  });

  it('refuses an image body over the limit before it is read', async () => {
    await expect(reasonFor(onSite(`/big/image/${FETCH_LIMITS.image + 1}`), 'image')).resolves.toBe(
      'too_large',
    );
  });

  it('accepts a PDF at the limit and refuses one byte more', async () => {
    const answer = await safeFetch(onSite(`/big/pdf/${FETCH_LIMITS.pdf}`), {
      kind: 'pdf',
      budget: createFetchBudget(),
    });
    expect(answer.body.length).toBe(FETCH_LIMITS.pdf);
    await expect(reasonFor(onSite(`/big/pdf/${FETCH_LIMITS.pdf + 1}`), 'pdf')).resolves.toBe(
      'too_large',
    );
  });

  it('stops a place at its request allowance', async () => {
    const budget = createFetchBudget();
    for (let index = 0; index < FETCH_LIMITS.placeRequests; index += 1) {
      const answer = await safeFetch(onSite('/small'), { kind: 'html', budget });
      expect(answer.status).toBe(200);
    }
    await expect(reasonFor(onSite('/small'), 'html', budget)).resolves.toBe('budget_exhausted');
    expect(budget.requests).toBe(FETCH_LIMITS.placeRequests);
    expect(hitsA.filter((hit) => hit.path === '/small')).toHaveLength(FETCH_LIMITS.placeRequests);
  });

  it('stops a place at its byte allowance, on the body that would cross it', async () => {
    const budget = createFetchBudget();
    const size = Math.floor(FETCH_LIMITS.placeBytes / 3);
    for (let index = 0; index < 3; index += 1) {
      const answer = await safeFetch(onSite(`/big/pdf/${size}`), { kind: 'pdf', budget });
      expect(answer.body.length).toBe(size);
    }
    expect(budget.bytes).toBe(FETCH_LIMITS.placeBytes);
    await expect(reasonFor(onSite(`/big/pdf/${size}`), 'pdf', budget)).resolves.toBe(
      'budget_exhausted',
    );
    expect(budget.bytes).toBe(FETCH_LIMITS.placeBytes);
  });
});

describe('renderPage', () => {
  it('reads a page whose script, frame, image and socket all reach nothing', async () => {
    const result = await render(`http://127.0.0.1:${portA}/service-worker/`);
    if (result.kind !== 'ok') throw new Error(`expected a rendered page, got ${result.kind}`);
    expect(result.text).toContain('Galão');
    expect(result.text).toContain('1,60 €');
    const requested = hitsA.map((hit) => hit.path);
    expect(requested).not.toContain('/service-worker/sw.js');
    expect(
      requested.filter((path) => path !== '/service-worker/' && path !== '/robots.txt'),
    ).toEqual([]);
    expect(lookups.filter((host) => host.endsWith(UNCERTAIN_SUFFIX))).toEqual([]);
    expect(refusalReasons()).toContain('policy_uncertain');
    const metadata = attempts.filter((attempt) => attempt.url.startsWith('http://169.254.169.254'));
    expect(metadata.length).toBeGreaterThan(0);
    expect(metadata.every((attempt) => attempt.reason === 'blocked_address')).toBe(true);
    expect(
      attempts
        .filter((attempt) => isHostile(attempt.url))
        .map((attempt) => attempt.reason)
        .filter((reason) => reason === null || !PRE_CONNECTION_REFUSALS.has(reason)),
    ).toEqual([]);
    expect(upgrades).toEqual([]);
    expect(hitsB).toEqual([]);
  }, 30_000);

  it('refuses the unreviewed frame and image of an allowed page', async () => {
    const result = await render(onSite('/mixed-frames/'));
    if (result.kind !== 'ok') throw new Error(`expected a rendered page, got ${result.kind}`);
    expect(result.text).toContain('Fixture mixed frames');
    const reasons = refusalReasons(UNCERTAIN_SUFFIX);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((reason) => reason === 'policy_uncertain')).toBe(true);
    expect(lookups.filter((host) => host.endsWith(UNCERTAIN_SUFFIX))).toEqual([]);
  }, 30_000);

  it('reports a login wall instead of reading the page behind it', async () => {
    const result = await render(onSite('/login-wall/'));
    expect(result.kind).toBe('login_wall');
  }, 30_000);

  it('reads an allowed page and reports the menu documents it links to', async () => {
    const page = await render(onSite('/menu-html/'));
    if (page.kind !== 'ok') throw new Error(`expected a rendered page, got ${page.kind}`);
    expect(page.text).toContain('Bitoque');
    const linked = await render(onSite('/menu-pdf-link/'));
    if (linked.kind !== 'ok') throw new Error(`expected a rendered page, got ${linked.kind}`);
    expect(linked.menuLinks.pdfs).toEqual([onSite('/menu-pdf-link/menu.pdf')]);
    expect(linked.menuLinks.images).toEqual([]);
  }, 30_000);
});

describe('logging', () => {
  it('carries no page text, and no key beyond reasons, hosts, kinds and counts', () => {
    expect(allLogs.length).toBeGreaterThan(0);
    const serialized = allLogs.map((line) => JSON.stringify(line)).join('\n');
    for (const pageText of ['Bitoque', 'Galão', '1,60 €', '12,50', '<html', '<!doctype']) {
      expect(serialized).not.toContain(pageText);
    }
    const unknownKeys = allLogs.flatMap((line) =>
      Object.keys(line).filter((key) => !ALLOWED_LOG_KEYS.has(key)),
    );
    expect(unknownKeys).toEqual([]);
  });
});
