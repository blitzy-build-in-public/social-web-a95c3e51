/**
 * Integration tests for the fetch-to-stored-price pipeline of `apps/workers/src/jobs/menu-ingest.ts`
 * against the local fixture sites in `apps/workers/test/fixtures/sites/` (AAP 0.5.6, 0.11.2).
 *
 * The suite runs inside the integration project of `vitest.config.ts`, so it shares the real
 * PostgreSQL 16 with PostGIS 3.4 and the real Redis its `globalSetup` starts, builds the worker
 * context over them (`createTestApp`, `testWorkersEnv`, `createWorkerContext`) and reads what the job
 * stored through `testApp.services.db` with time from the shared test clock alone (AAP 0.11.2).
 * Nothing reaches the network: the four fixture pages, the `robots.txt` they publish, the menu PDF
 * and the FX table are served by one in-file HTTP server on loopback, and every host name resolves
 * through the injected `lookup`, which answers no other name (AAP 0.5.6).
 *
 * What it proves, in the order the cases run:
 *
 *   1. A priced page is read, extracted and gated into one `PriceRecord` batch: the eight items of
 *      `menu-html` — the no-break space and the split price span included — with the one item the
 *      page never printed dropped by the source gate, which is criterion 11's 100% guarantee
 *      (AAP 0.12.2). The linked PDF of `menu-pdf-link` yields its own ten items beside the page's
 *      two, and `activity-tickets` stores six tickets with their `perPerson` flag and admission type
 *      (AAP 0.5.6).
 *   2. Every way a place can fail to yield five priced items takes the phone fallback instead
 *      (AAP 0.5.6): a path `robots.txt` disallows, a blocklisted domain, a domain an operator
 *      prohibited, one nobody has reviewed, a place with no link, a login wall and a document that
 *      leaves too few items. Each row asserts a recorded zero rather than an assumed one — no request
 *      to the site, no resolver call, no language-model send — and the last row is the control that
 *      the same arrangement does fetch, extract and store when the domain is allowed.
 *   3. One site's requests are spaced at least a second apart, a spent language-model budget defers a
 *      place to 00:05 local the next day under a stable job id, and the city fan-out queues exactly
 *      the places whose online prices are missing or stale (AAP 0.5.6, 0.5.7).
 *
 * @see AAP 0.5.6 for the pipeline, its bounds, the fallback, the ticket fields and the cap, 0.5.7 for
 *   the capture precedence the fan-out reads, 0.11.2 for the integration layer and the fixtures,
 *   0.12.2 for the crawl-rule and source-gate constraints this suite is the check of, and 0.8.1 for
 *   this file's inventory row.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_TEST_NOW,
  createTestApp,
  testWorkersEnv,
  type TestApp,
} from '@tablemate/api/test-support/app';
import {
  makePlace,
  makePriceRecords,
  type PlaceFixture,
} from '@tablemate/api/test-support/factories';
import type { DbClient } from '@tablemate/db';
import {
  JOB,
  QUEUE,
  createFakeLlmAdapter,
  loadWorkersEnv,
  localDateKey,
  nextLocalDayAt,
  type FakeLlmAdapter,
  type LlmRequest,
} from '@tablemate/server-core';
import type { ExtractedMenuItem, ItemCategory, PlaceCategory, TicketType } from '@tablemate/shared';

import { process as runFxRefresh } from '../../src/jobs/fx-refresh.ts';
import {
  ingestPlace,
  normalizeItemName,
  process as runMenuIngest,
} from '../../src/jobs/menu-ingest.ts';
import { domainKey, findRepoRoot, loadBlocklist } from '../../src/menus/blocklist.ts';
import { registrableDomain } from '../../src/menus/crawl-policy.ts';
import type { LookupFn } from '../../src/menus/safe-fetch.ts';
import { closeWorkerContext, createWorkerContext, type WorkerContext } from '../../src/queues.ts';

/* The city, the instant and the queue vocabulary of one run (AAP 0.5.2, 0.5.6) */

/** The launch city every case works in: configured, so `seedCities` writes its zone and currency. */
const CITY = 'lisbon';

/** The city's own zone, which its local day and the 00:05 deferral are computed in (AAP 0.11.1). */
const CITY_TZ = 'Europe/Lisbon';

/**
 * The instant every case starts at: Lisbon midday on the harness's own day. Lisbon is on UTC+0 in
 * mid-November, so this literal is a Lisbon midday; `resetState` returns the clock here, and each
 * case states it so the dates the FX conversion reads line up visibly.
 */
const NOW = new Date(DEFAULT_TEST_NOW);

/** The two job names of the queue under test and the one of the FX queue (AAP 0.5.6). */
const INGEST = JOB[QUEUE.menuIngest].ingest;
const INGEST_CITY = JOB[QUEUE.menuIngest].ingestCity;
const FX_REFRESH = JOB[QUEUE.fxRefresh].refresh;

/** The one call-task kind this pipeline opens: a menu price read over the phone (AAP 0.5.6). */
const MENU_PRICES = 'menu_prices';

/** The three fixture host names besides the loopback literal, each a distinct registrable domain. */
const ALLOWED_HOST = 'menus.allowed-fixture.test';
const PROHIBITED_HOST = 'menus.prohibited-fixture.test';
const UNCERTAIN_HOST = 'menus.uncertain-fixture.test';

/**
 * Every host the crawler may reach inside this test's network (AAP 0.5.6). The exemption is what
 * keeps the address check out of the fixture rows' way: only the crawl policy, `robots.txt` and the
 * throttle may stop a fetch here.
 */
const PRIVATE_HOSTS: readonly string[] = [
  '127.0.0.1',
  ALLOWED_HOST,
  PROHIBITED_HOST,
  UNCERTAIN_HOST,
];

/* The fixture sites, their pages and the two recorded provider answers (AAP 0.5.6) */

const SITES_DIR = fileURLToPath(new URL('../fixtures/sites/', import.meta.url));
const FX_FIXTURE = fileURLToPath(new URL('../fixtures/fx/usd-latest.json', import.meta.url));
const PDF_FIXTURE = fileURLToPath(
  new URL('../../eval/fixtures/menus/en/en-02.pdf', import.meta.url),
);
const MENU_MANIFEST = fileURLToPath(
  new URL('../../eval/fixtures/menus/manifest.json', import.meta.url),
);

/** The four fixture pages, read once: each is served at its own `<name>/` path. */
const SITE_PAGES: ReadonlyMap<string, Buffer> = new Map<string, Buffer>([
  ['/menu-html/', readFileSync(join(SITES_DIR, 'menu-html', 'index.html'))],
  ['/menu-pdf-link/', readFileSync(join(SITES_DIR, 'menu-pdf-link', 'index.html'))],
  ['/activity-tickets/', readFileSync(join(SITES_DIR, 'activity-tickets', 'index.html'))],
  ['/login-wall/', readFileSync(join(SITES_DIR, 'login-wall', 'index.html'))],
]);

/** The menu document the `menu-pdf-link` page links to, and the file its bytes are read from. */
const PDF_PATH = '/menu-pdf-link/menu.pdf';
const EN_02_PDF = readFileSync(PDF_FIXTURE);

/**
 * The site's own `robots.txt`: the disallowed prefix is the one path that proves the check ran, and
 * `/private/menu/` answers the `menu-html` page so that only `robots.txt` can stop it (AAP 0.5.6).
 */
const ROBOTS_PATH = '/robots.txt';
const DISALLOWED_PREFIX = '/private/';
const ROBOTS_BODY = `User-agent: *\nDisallow: ${DISALLOWED_PREFIX}\n`;

/** The FX table the refresh job reads, and the one path it is served at (AAP 0.3.3). */
const FX_TABLE = readFileSync(FX_FIXTURE, 'utf8');
const FX_PATH = '/fx/usd-latest.json';

/** The one date a URL's path is matched on: a page is requested with its trailing slash. */
const SITE_PATH = /^\/[a-z0-9-]+\/$/;

/** The provider's recorded table, and the `@db.Date` day its rates belong to (AAP 0.5.6). */
interface FxFixture {
  readonly rates: Readonly<Record<string, number>>;
  readonly time_last_update_unix: number;
}

const FX_FIXTURE_JSON = JSON.parse(FX_TABLE) as FxFixture;
const FX_RATES = FX_FIXTURE_JSON.rates;

/** The day `fx-refresh` keys its rows by: the provider's own update day, at midnight UTC. */
const FX_DAY = new Date(
  `${new Date(FX_FIXTURE_JSON.time_last_update_unix * 1_000).toISOString().slice(0, 10)}T00:00:00.000Z`,
);

/** The labeled menu set, whose `en/en-02.pdf` entry is both the PDF fixture and its script (AAP 0.11.2). */
interface ManifestItem {
  readonly name: string;
  readonly normalizedName: string;
  readonly priceText: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly category: ItemCategory;
}

interface ManifestMenu {
  readonly file: string;
  readonly items: readonly ManifestItem[];
}

interface Manifest {
  readonly menus: readonly ManifestMenu[];
}

const MANIFEST = JSON.parse(readFileSync(MENU_MANIFEST, 'utf8')) as Manifest;

/** One menu of the labeled set, refused rather than read as `undefined`. */
function menuOf(file: string): ManifestMenu {
  const found = MANIFEST.menus.find((menu) => menu.file === file);

  if (found === undefined) {
    throw new Error(`the labeled set holds no menu "${file}"`);
  }

  return found;
}

const PDF_MENU = menuOf('en/en-02.pdf');

/** The first item's name, which is the text every chunk of that document's own text carries. */
function firstItemName(menu: ManifestMenu): string {
  const first = menu.items[0];

  if (first === undefined) {
    throw new Error(`the labeled menu "${menu.file}" holds no items`);
  }

  return first.name;
}

/**
 * The first domain of the committed blocklist, read from the file rather than written here: the
 * suite must never name a real site, and `config/crawl-blocklist.json` is what decides one (AAP 0.5.6).
 */
function firstBlockedDomain(): string {
  const [first] = [...loadBlocklist(findRepoRoot()).domains];

  if (first === undefined) {
    throw new Error('config/crawl-blocklist.json holds no domain');
  }

  return first;
}

const BLOCKED_DOMAIN = firstBlockedDomain();

/**
 * What one unit of a currency is worth in USD, from the recorded table, which is what a stored
 * `priceUsdCents` converts through: the provider quotes units per USD, so the rate is its reciprocal.
 */
function expectedCents(localAmountMinor: number, currency: string): number {
  const perUsd = FX_RATES[currency];

  if (perUsd === undefined) {
    throw new Error(`the recorded FX table quotes no ${currency}`);
  }

  // The pipeline's own conversion is a decimal one at this scale (`fx/open-er-api.ts`); every EUR
  // product below is exact in binary, so this float rounding and that decimal rounding agree.
  return Math.round(localAmountMinor / perUsd);
}

/* The scripted extraction answers, one per fixture document (AAP 0.5.6) */

/** One item a scripted answer holds, with the optional fields the ticket rule constrains. */
interface ScriptedItem {
  readonly name: string;
  readonly category: ItemCategory;
  /** The price as the source prints it, which the source gate then has to find in that text. */
  readonly priceText: string;
  readonly alcoholic?: boolean;
  /** Required on a `ticket` price and absent on every other category (AAP 0.5.6). */
  readonly perPerson?: boolean;
  readonly ticketType?: TicketType;
}

/** One scripted item in the contract's own shape, every nullable field written out. */
function scriptItem(item: ScriptedItem, currency = 'EUR'): ExtractedMenuItem {
  return {
    name: item.name,
    category: item.category,
    priceText: item.priceText,
    currency,
    alcoholic: item.alcoholic ?? null,
    perPerson: item.perPerson ?? null,
    ticketType: item.ticketType ?? null,
  };
}

/** The items of one scripted answer. */
function scripted(items: readonly ScriptedItem[], currency = 'EUR'): ExtractedMenuItem[] {
  return items.map((item) => scriptItem(item, currency));
}

/**
 * What the extractor answers for `menu-html`: its eight printed prices, and one dish the page never
 * printed, which the source gate must drop rather than store (AAP 0.5.6, 0.12.2).
 */
const MENU_HTML_ITEMS = scripted([
  { name: 'Caldo verde', category: 'starter', priceText: '3,50 €' },
  { name: 'Bitoque', category: 'main', priceText: '12,50 €' },
  { name: 'Bacalhau à Brás', category: 'main', priceText: '14,50 €' },
  { name: 'Arroz de pato', category: 'main', priceText: '13,00 €' },
  { name: 'Arroz doce', category: 'dessert', priceText: '4,00 €' },
  { name: 'Água', category: 'drink', priceText: '1,50 €', alcoholic: false },
  { name: 'Café', category: 'drink', priceText: '0,90 €', alcoholic: false },
  { name: 'Imperial', category: 'drink', priceText: '2,50 €', alcoholic: true },
  { name: 'Polvo à lagareiro', category: 'main', priceText: '11,00 €' },
]);

/** What the extractor answers for the `menu-pdf-link` page: its two prices, and one it never printed. */
const PDF_LINK_PAGE_ITEMS = scripted([
  { name: 'Prego no pão', category: 'main', priceText: '6,50 €' },
  { name: 'Imperial', category: 'drink', priceText: '2,50 €', alcoholic: true },
  { name: 'Sardinhas assadas', category: 'main', priceText: '9,00 €' },
]);

/**
 * What the extractor answers for `activity-tickets`: its six admission prices with the two fields the
 * ticket rule requires, and one price the page never printed (AAP 0.5.6).
 */
const TICKET_ITEMS = scripted([
  {
    name: 'Adulto',
    category: 'ticket',
    priceText: '15,00 €',
    perPerson: true,
    ticketType: 'standard',
  },
  {
    name: 'Criança (6 a 12 anos)',
    category: 'ticket',
    priceText: '7,50 €',
    perPerson: true,
    ticketType: 'concession',
  },
  {
    name: 'Estudante',
    category: 'ticket',
    priceText: '10,00 €',
    perPerson: true,
    ticketType: 'concession',
  },
  {
    name: 'Sénior (65+)',
    category: 'ticket',
    priceText: '9,00 €',
    perPerson: true,
    ticketType: 'concession',
  },
  {
    name: 'Família (2 adultos e 2 crianças)',
    category: 'ticket',
    priceText: '40,00 €',
    perPerson: false,
    ticketType: 'group',
  },
  {
    name: 'Grupo (mínimo 10 pessoas)',
    category: 'ticket',
    priceText: '12,00 €',
    perPerson: true,
    ticketType: 'group',
  },
  {
    name: 'Bilhete escolar',
    category: 'ticket',
    priceText: '99,00 €',
    perPerson: true,
    ticketType: 'group',
  },
]);

/**
 * What the extractor answers for the PDF: every item the labeled set records for `en/en-02.pdf`,
 * rebuilt from that entry rather than restated, plus one price the document never printed.
 */
const PDF_ITEMS: readonly ExtractedMenuItem[] = [
  ...PDF_MENU.items.map((item) =>
    scriptItem(
      { name: item.name, category: item.category, priceText: item.priceText },
      item.currency,
    ),
  ),
  scriptItem({ name: 'Fish and chips', category: 'main', priceText: '€18.50' }),
];

/** One fixture document's script: the text that identifies it, and what the extractor answers for it. */
interface Script {
  readonly marker: string;
  readonly items: readonly ExtractedMenuItem[];
}

const SCRIPTS: readonly Script[] = [
  { marker: 'Fixture Tasca do Teste', items: MENU_HTML_ITEMS },
  { marker: 'Fixture Museu do Teste', items: TICKET_ITEMS },
  { marker: 'Fixture Cervejaria', items: PDF_LINK_PAGE_ITEMS },
  { marker: firstItemName(PDF_MENU), items: PDF_ITEMS },
];

/* The harness (AAP 0.11.2) */

/** One request the fixture server answered, which every "never fetched" claim is read from. */
interface Hit {
  /** The `Host` the request carried, keyed by `domainKey`: lower case and without its port. */
  readonly host: string;
  /** The path as it arrived, so a robots, page, PDF or asset fetch can be told apart. */
  readonly path: string;
  /** Arrival time from the wall clock: the throttle is not the injected clock's business. */
  readonly at: bigint;
}

let testApp: TestApp;
let ctx: WorkerContext;
let fakeLlm: FakeLlmAdapter;

/** The fixture server and the port it bound, whose own URL is composed from the two. */
let server: Server | undefined;
let sitePort = 0;

/** Every request the fixture server answered, in arrival order, and every name the resolver saw. */
const hits: Hit[] = [];
const lookups: string[] = [];

/** Whether the PDF route answers `404`, which is how the too-few-items row is arranged. */
let pdfMissing = false;

/** The loopback URL of one fixture page, and the same path under one of the fixture host names. */
function site(path: string): string {
  return `http://127.0.0.1:${sitePort}${path}`;
}

function siteOn(host: string, path: string): string {
  return `http://${host}:${sitePort}${path}`;
}

/** The guarded client every assertion reads the state the job wrote through (AAP 0.11.2). */
function db(): DbClient {
  return testApp.services.db;
}

/** The requests served for one host, matched on the key a crawl decision is taken on (AAP 0.5.6). */
function hitsOn(host: string): Hit[] {
  const key = domainKey(host);

  return hits.filter((hit) => hit.host === key);
}

/** The resolver calls for one host, which a policy or robots refusal never makes. */
function lookupsFor(host: string): string[] {
  return lookups.filter((hostname) => hostname === host);
}

/** Every hit's arrival time on one host, in the order it arrived. */
function arrivalTimesOn(host: string): bigint[] {
  return hitsOn(host).map((hit) => hit.at);
}

/** One place's records, in code-unit name order, so a comparison ignores the database's collation. */
function byName<T extends { readonly itemName: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => (left.itemName < right.itemName ? -1 : 1));
}

/** The columns of one stored price every assertion reads. */
const PRICE_COLUMNS = {
  itemName: true,
  itemCategory: true,
  priceText: true,
  localAmountMinor: true,
  priceUsdCents: true,
  currency: true,
  normalizedName: true,
  alcoholic: true,
  perPerson: true,
  ticketType: true,
  source: true,
  sourceUrl: true,
  capturedAt: true,
  fxDate: true,
  reviewStatus: true,
  isFixture: true,
  captureBatchId: true,
} as const;

/** Every price record of one place, read through the guarded client (AAP 0.11.2). */
async function priceRecords(placeId: string) {
  return await db().priceRecord.findMany({
    where: { placeId },
    orderBy: { itemName: 'asc' },
    select: PRICE_COLUMNS,
  });
}

/** Every `menu_prices` task of one place, whatever its status (AAP 0.5.6). */
async function menuTasks(placeId: string) {
  return await db().callTask.findMany({
    where: { placeId, kind: MENU_PRICES },
    orderBy: { id: 'asc' },
    select: { status: true, blockedReason: true, priority: true, nextAttemptAt: true },
  });
}

/** The `menu-ingest` jobs the queue holds in every state a job waits in (AAP 0.3.2, 0.5.6). */
async function menuIngestJobs() {
  return await ctx.queues.get(QUEUE.menuIngest).getJobs(['waiting', 'prioritized', 'delayed']);
}

/** The gaps between consecutive arrivals, in milliseconds, which the throttle's rule is read from. */
function gapsMs(times: readonly bigint[]): number[] {
  const gaps: number[] = [];

  for (let index = 1; index < times.length; index += 1) {
    const previous = times[index - 1];
    const current = times[index];

    if (previous !== undefined && current !== undefined) {
      gaps.push(Number(current - previous) / 1_000_000);
    }
  }

  return gaps;
}

/**
 * One place the pipeline reads: a Lisbon place made through the harness factory with its fixture flag
 * cleared, because the ingestion copies the place's own flag onto every record it stores (AAP 0.5.2)
 * and the places of this suite stand for real ones.
 */
async function makeIngestPlace(options: {
  readonly category: PlaceCategory;
  readonly website?: string;
  readonly menuUrl?: string;
}): Promise<PlaceFixture> {
  const place = await makePlace(testApp, {
    cityId: CITY,
    category: options.category,
    ...(options.website === undefined ? {} : { website: options.website }),
    ...(options.menuUrl === undefined ? {} : { menuUrl: options.menuUrl }),
  });

  await db().place.update({ where: { id: place.id }, data: { isFixture: false } });

  return place;
}

/**
 * The site-terms rows every case starts from (AAP 0.5.6): the loopback fixture host and the allowed
 * fixture name are approved, and the prohibited name stands for a domain an operator refused. A
 * decision is read for the request host's chain, so the exact-host row of the allowed name is
 * honoured for it; the prohibited row is keyed at the registrable domain its subdomain resolves to.
 * The uncertain row is deliberately absent: the policy records it, and the case asserts it did.
 */
async function recordPolicies(): Promise<void> {
  const checkedAt = ctx.clock.now();
  const rows = [
    { domain: '127.0.0.1', decision: 'allowed', reason: 'operator' },
    { domain: ALLOWED_HOST, decision: 'allowed', reason: 'operator' },
    { domain: registrableDomain(PROHIBITED_HOST), decision: 'prohibited', reason: 'operator' },
  ] as const;

  for (const row of rows) {
    await db().crawlDomainPolicy.create({ data: { ...row, checkedAt } });
  }
}

/** One answer of the fixture server: its status, its content type and its body. */
function send(response: ServerResponse, status: number, type: string, body: Buffer | string): void {
  response.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

/**
 * Start the server that plays every fixture site and the FX provider (AAP 0.5.6).
 *
 * It answers the four pages at their own trailing-slash paths, the `menu-html` page under the prefix
 * `robots.txt` disallows, the menu PDF (or a `404` when a row asks for one), `robots.txt` itself and
 * the recorded FX table. Every request and its arrival time are recorded, which is what the suite's
 * "never fetched" and throttle assertions read; an unknown path is a `404`, so a fetch this suite
 * did not plan is visible as a hit rather than as a silent success.
 *
 * @returns the loopback base of the site server, without a trailing slash.
 * @throws Error when the server bound no TCP address.
 */
async function startSiteServer(): Promise<number> {
  const created = createServer((request, response) => {
    const path = request.url ?? '/';
    hits.push({
      host: domainKey(request.headers.host ?? ''),
      path,
      at: process.hrtime.bigint(),
    });

    if (path === ROBOTS_PATH) {
      send(response, 200, 'text/plain; charset=utf-8', ROBOTS_BODY);
      return;
    }
    if (path === FX_PATH) {
      send(response, 200, 'application/json', FX_TABLE);
      return;
    }
    if (path === PDF_PATH) {
      if (pdfMissing) {
        send(response, 404, 'text/plain; charset=utf-8', 'not found');
        return;
      }
      send(response, 200, 'application/pdf', EN_02_PDF);
      return;
    }
    if (path.startsWith(DISALLOWED_PREFIX)) {
      // The same page under a disallowed path, so only `robots.txt` can stop this fetch.
      send(response, 200, 'text/html; charset=utf-8', SITE_PAGES.get('/menu-html/') ?? '');
      return;
    }
    const page = SITE_PAGES.get(SITE_PATH.test(path) ? path : '');
    if (page !== undefined) {
      send(response, 200, 'text/html; charset=utf-8', page);
      return;
    }
    send(response, 404, 'text/plain; charset=utf-8', 'not found');
  });

  await new Promise<void>((resolve) => {
    created.listen(0, '127.0.0.1', resolve);
  });

  server = created;
  const address = created.address();

  if (address === null || typeof address === 'string') {
    throw new Error('the fixture site server did not bind a port');
  }

  return address.port;
}

/**
 * The recording resolver (AAP 0.5.6): the three fixture host names answer the loopback address, so a
 * request to them reaches the site server, and no other name resolves at all — a hostname this suite
 * did not plan to reach means a row left the crawl policy behind, and `safe-fetch` reads the
 * rejection as `dns_failed` rather than reaching anything.
 */
const RESOLVABLE_HOSTS: ReadonlySet<string> = new Set([
  ALLOWED_HOST,
  PROHIBITED_HOST,
  UNCERTAIN_HOST,
]);

const lookup: LookupFn = (host) => {
  lookups.push(host);

  if (!RESOLVABLE_HOSTS.has(host)) {
    return Promise.reject(new Error(`unexpected lookup for ${host}`));
  }

  return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
};

/** Every message of one request, joined: what the scripted answer reads for its fixture's marker. */
function requestText(request: LlmRequest): string {
  return request.messages.map((message) => message.content).join('\n');
}

/**
 * The extractor's scripted answers: whichever fixture document's marker occurs in the request's own
 * text decides what it answers, so one adapter serves four documents without a per-place switch.
 */
function respond(request: LlmRequest): unknown {
  const text = requestText(request);

  return {
    items: SCRIPTS.filter((script) => text.includes(script.marker)).flatMap((script) =>
      script.items.map((item) => ({ ...item })),
    ),
  };
}

beforeAll(async () => {
  // The renderer is Chromium: without it every priced page would fall back to a phone call, so a
  // missing browser is a failure of this suite rather than a case that may be skipped.
  const executable = chromium.executablePath();
  if (!existsSync(executable)) {
    throw new Error(
      'Chromium missing. Run: pnpm --filter @tablemate/workers exec playwright install chromium',
    );
  }

  sitePort = await startSiteServer();
  testApp = await createTestApp();
  fakeLlm = createFakeLlmAdapter({ respond });

  // The context the jobs are called with: the harness's own clock — one clock for the suite, which is
  // what makes the capture instant assertable (AAP 0.11.1) — its Redis for the producers and the
  // throttle, the injected adapter, and a resolver that answers only the fixture names.
  ctx = await createWorkerContext(
    loadWorkersEnv(
      testWorkersEnv({
        FX_URL: site(FX_PATH),
        CRAWL_ALLOW_PRIVATE_HOSTS: PRIVATE_HOSTS.join(','),
      }),
    ),
    { clock: testApp.clock, llm: fakeLlm, lookup },
  );
}, 300_000);

afterAll(async () => {
  await closeWorkerContext(ctx);
  await testApp.close();

  const running = server;
  if (running !== undefined) {
    running.closeAllConnections();
    await new Promise<void>((resolve) => {
      running.close(() => resolve());
    });
  }
});

beforeEach(async () => {
  await testApp.resetState();
  await testApp.seedCities();
  testApp.time.at(NOW);
  await recordPolicies();
  // The rates every stored price converts through, written by the job that writes them in production
  // rather than inserted by hand, so the conversion the cases assert is the pipeline's own (AAP 0.5.6).
  await runFxRefresh({ name: FX_REFRESH, data: {} }, ctx);
  // Cleared after the refresh, so a case's own reads start from an empty record of what was fetched.
  hits.length = 0;
  lookups.length = 0;
  fakeLlm.calls.counted.length = 0;
  fakeLlm.calls.sent.length = 0;
  pdfMissing = false;
});

/* One priced page, and one stored item of it (AAP 0.5.6, 0.5.7) */

/** What one row of the `menu-html` table asserts about the record stored for it. */
interface StoredItemCase {
  readonly itemName: string;
  readonly itemCategory: ItemCategory;
  readonly priceText: string;
  readonly localAmountMinor: number;
  readonly priceUsdCents: number;
  readonly normalizedName: string;
  readonly alcoholic: boolean | null;
}

/**
 * The eight items `menu-html` prints, and what each becomes. The no-break space of `Bitoque` and the
 * newline inside the price of `Bacalhau à Brás` are in the source on purpose: the gate compares
 * whitespace-normalized strings, so both survive as the one normalized price below (AAP 0.5.6).
 */
const MENU_HTML_CASES: readonly StoredItemCase[] = [
  {
    itemName: 'Caldo verde',
    itemCategory: 'starter',
    priceText: '3,50 €',
    localAmountMinor: 350,
    priceUsdCents: 438,
    normalizedName: 'caldo verde',
    alcoholic: null,
  },
  {
    itemName: 'Bitoque',
    itemCategory: 'main',
    priceText: '12,50 €',
    localAmountMinor: 1_250,
    priceUsdCents: 1_563,
    normalizedName: 'bitoque',
    alcoholic: null,
  },
  {
    itemName: 'Bacalhau à Brás',
    itemCategory: 'main',
    priceText: '14,50 €',
    localAmountMinor: 1_450,
    priceUsdCents: 1_813,
    normalizedName: 'bacalhau à brás',
    alcoholic: null,
  },
  {
    itemName: 'Arroz de pato',
    itemCategory: 'main',
    priceText: '13,00 €',
    localAmountMinor: 1_300,
    priceUsdCents: 1_625,
    normalizedName: 'arroz de pato',
    alcoholic: null,
  },
  {
    itemName: 'Arroz doce',
    itemCategory: 'dessert',
    priceText: '4,00 €',
    localAmountMinor: 400,
    priceUsdCents: 500,
    normalizedName: 'arroz doce',
    alcoholic: null,
  },
  {
    itemName: 'Água',
    itemCategory: 'drink',
    priceText: '1,50 €',
    localAmountMinor: 150,
    priceUsdCents: 188,
    normalizedName: 'água',
    alcoholic: false,
  },
  {
    itemName: 'Café',
    itemCategory: 'drink',
    priceText: '0,90 €',
    localAmountMinor: 90,
    priceUsdCents: 113,
    normalizedName: 'café',
    alcoholic: false,
  },
  {
    itemName: 'Imperial',
    itemCategory: 'drink',
    priceText: '2,50 €',
    localAmountMinor: 250,
    priceUsdCents: 313,
    normalizedName: 'imperial',
    alcoholic: true,
  },
];

/** What one row of the ticket table asserts: the two fields the ticket rule constrains included. */
interface TicketCase {
  readonly itemName: string;
  readonly priceText: string;
  readonly localAmountMinor: number;
  readonly normalizedName: string;
  readonly perPerson: boolean;
  readonly ticketType: TicketType;
}

/** The six admission prices of `activity-tickets`, with the flag and the type each carries. */
const TICKET_CASES: readonly TicketCase[] = [
  {
    itemName: 'Adulto',
    priceText: '15,00 €',
    localAmountMinor: 1_500,
    normalizedName: 'adulto',
    perPerson: true,
    ticketType: 'standard',
  },
  {
    itemName: 'Criança (6 a 12 anos)',
    priceText: '7,50 €',
    localAmountMinor: 750,
    normalizedName: 'criança (6 a 12 anos)',
    perPerson: true,
    ticketType: 'concession',
  },
  {
    itemName: 'Estudante',
    priceText: '10,00 €',
    localAmountMinor: 1_000,
    normalizedName: 'estudante',
    perPerson: true,
    ticketType: 'concession',
  },
  {
    itemName: 'Sénior (65+)',
    priceText: '9,00 €',
    localAmountMinor: 900,
    normalizedName: 'sénior (65+)',
    perPerson: true,
    ticketType: 'concession',
  },
  {
    itemName: 'Família (2 adultos e 2 crianças)',
    priceText: '40,00 €',
    localAmountMinor: 4_000,
    normalizedName: 'família (2 adultos e 2 crianças)',
    perPerson: false,
    ticketType: 'group',
  },
  {
    itemName: 'Grupo (mínimo 10 pessoas)',
    priceText: '12,00 €',
    localAmountMinor: 1_200,
    normalizedName: 'grupo (mínimo 10 pessoas)',
    perPerson: true,
    ticketType: 'group',
  },
];

/* The phone fallback, one row per way a place yields too few prices (AAP 0.5.6) */

/** What one fallback row's own assertions read besides the place it built. */
interface CaseState {
  readonly place: PlaceFixture;
  /** The language-model sends recorded before the run, which a refused wall must not change. */
  readonly sentBefore: number;
  /** The counts recorded before the run, which a wall must not change either. */
  readonly countedBefore: number;
}

/** One arrangement that must take the fallback instead of storing a menu. */
interface FallbackCase {
  /** How the row reads in the test's own title. */
  readonly name: string;
  /** How many records the run stores before falling back: `0` on every path but an item shortfall. */
  readonly pricedItems: number;
  /** Whether the run opens a phone-price task: false only for the control row. */
  readonly queuedCall: boolean;
  /** The place the row reads, arranged so its own path is the one under test. */
  readonly build: () => Promise<PlaceFixture>;
  /** The row's own assertions, which are where its recorded zeros are read. */
  readonly check: (state: CaseState) => Promise<void> | void;
}

/** One stored site-terms decision, or `null` when the domain has no row (AAP 0.5.6). */
async function policyRow(domain: string) {
  return await db().crawlDomainPolicy.findUnique({
    where: { domain },
    select: { decision: true, reason: true },
  });
}

const FALLBACK_CASES: readonly FallbackCase[] = [
  {
    name: 'a path robots.txt disallows',
    pricedItems: 0,
    queuedCall: true,
    build: () =>
      makeIngestPlace({ category: 'restaurant', website: site(`${DISALLOWED_PREFIX}menu/`) }),
    check: () => {
      // The page stands at that path and answers anything asked of it, so the only thing that can
      // have kept the request away is the disallowed path itself (AAP 0.5.6).
      expect(hits.filter((hit) => hit.path.startsWith(DISALLOWED_PREFIX))).toEqual([]);
      expect(hits.map((hit) => hit.path)).toContain(ROBOTS_PATH);
    },
  },
  {
    name: 'a blocklisted domain',
    pricedItems: 0,
    queuedCall: true,
    build: () =>
      makeIngestPlace({ category: 'restaurant', website: `http://${BLOCKED_DOMAIN}/menu` }),
    check: async () => {
      expect(hits).toEqual([]);
      expect(lookupsFor(BLOCKED_DOMAIN)).toEqual([]);
      expect(await policyRow(BLOCKED_DOMAIN)).toEqual({
        decision: 'prohibited',
        reason: 'blocklist',
      });
    },
  },
  {
    name: 'a domain an operator prohibited',
    pricedItems: 0,
    queuedCall: true,
    build: () =>
      makeIngestPlace({ category: 'restaurant', website: siteOn(PROHIBITED_HOST, '/menu-html/') }),
    check: () => {
      expect(hits).toEqual([]);
      expect(lookupsFor(PROHIBITED_HOST)).toEqual([]);
    },
  },
  {
    name: 'a domain nobody has reviewed',
    pricedItems: 0,
    queuedCall: true,
    build: () =>
      makeIngestPlace({ category: 'restaurant', website: siteOn(UNCERTAIN_HOST, '/menu-html/') }),
    check: async () => {
      expect(hits).toEqual([]);
      expect(lookupsFor(UNCERTAIN_HOST)).toEqual([]);
      // The policy records the domain for review before it answers, so the operator queue holds it
      // from the first attempt and no fetch can race past the decision (AAP 0.5.6).
      expect(await policyRow(registrableDomain(UNCERTAIN_HOST))).toEqual({
        decision: 'uncertain',
        reason: 'awaiting_review',
      });
    },
  },
  {
    name: 'a place with no link at all',
    pricedItems: 0,
    queuedCall: true,
    build: () => makeIngestPlace({ category: 'bar' }),
    check: (state) => {
      expect(hits).toEqual([]);
      expect(lookups).toEqual([]);
      expect(fakeLlm.calls.sent).toHaveLength(state.sentBefore);
    },
  },
  {
    name: 'a login wall',
    pricedItems: 0,
    queuedCall: true,
    build: () => makeIngestPlace({ category: 'restaurant', website: site('/login-wall/') }),
    check: (state) => {
      expect(hitsOn('127.0.0.1').map((hit) => hit.path)).toContain('/login-wall/');
      // The page was read and refused as a wall, so the extraction never ran on its text.
      expect(fakeLlm.calls.counted).toHaveLength(state.countedBefore);
      expect(fakeLlm.calls.sent).toHaveLength(state.sentBefore);
    },
  },
  {
    name: 'a document that yields fewer than five items',
    // The page's own two items are stored and still short of the five a place needs (AAP 0.5.6).
    pricedItems: 2,
    queuedCall: true,
    build: async () => {
      pdfMissing = true;

      return await makeIngestPlace({ category: 'restaurant', website: site('/menu-pdf-link/') });
    },
    check: async (state) => {
      expect(hitsOn('127.0.0.1').filter((hit) => hit.path === PDF_PATH)).toHaveLength(1);
      expect(byName(await priceRecords(state.place.id)).map((row) => row.itemName)).toEqual([
        'Imperial',
        'Prego no pão',
      ]);
    },
  },
  {
    name: 'an allowed fixture domain, which is the control',
    pricedItems: MENU_HTML_CASES.length,
    queuedCall: false,
    build: () =>
      makeIngestPlace({ category: 'restaurant', website: siteOn(ALLOWED_HOST, '/menu-html/') }),
    check: async (state) => {
      // Every arrangement above is this page under a domain the policy refuses or a path the file
      // disallows: this row proves the allowed name is fetched, so their zeros are evidence.
      expect(hitsOn(ALLOWED_HOST).length).toBeGreaterThan(0);
      expect(lookupsFor(ALLOWED_HOST).length).toBeGreaterThan(0);
      expect(await priceRecords(state.place.id)).toHaveLength(MENU_HTML_CASES.length);
    },
  },
];

/*
 * The cases share one seeded city and one instant, and every case resets the state it reads, so the
 * order below carries no meaning: each one builds the places its own path needs (AAP 0.11.2).
 */
describe('menu-ingest', () => {
  it('stores the eight prices of the page as one batch and drops the item it never printed', async () => {
    const place = await makeIngestPlace({ category: 'restaurant', website: site('/menu-html/') });

    await expect(ingestPlace(ctx, place.id)).resolves.toEqual({
      pricedItems: MENU_HTML_CASES.length,
      queuedCall: false,
    });

    const stored = await priceRecords(place.id);
    expect(stored).toHaveLength(MENU_HTML_CASES.length);
    expect(new Set(stored.map((row) => row.captureBatchId)).size).toBe(1);
    expect(byName(stored).map((row) => row.itemName)).toEqual(
      byName(MENU_HTML_CASES).map((row) => row.itemName),
    );
    // The invented item: the page never printed this price, so storing it would be the invention
    // the source gate exists to refuse (AAP 0.5.6, 0.12.2).
    expect(stored.filter((row) => row.priceText === '11,00 €')).toEqual([]);
    expect(await menuTasks(place.id)).toEqual([]);
  });

  it.each(MENU_HTML_CASES)('menu-html: stores $itemName at $priceText', async (row) => {
    const place = await makeIngestPlace({ category: 'restaurant', website: site('/menu-html/') });

    await ingestPlace(ctx, place.id);

    const stored = (await priceRecords(place.id)).filter(
      (record) => record.itemName === row.itemName,
    );

    expect(stored).toMatchObject([
      {
        itemName: row.itemName,
        itemCategory: row.itemCategory,
        priceText: row.priceText,
        localAmountMinor: row.localAmountMinor,
        priceUsdCents: row.priceUsdCents,
        currency: 'EUR',
        normalizedName: row.normalizedName,
        alcoholic: row.alcoholic,
        perPerson: null,
        ticketType: null,
        source: 'online_menu',
        sourceUrl: site('/menu-html/'),
        capturedAt: NOW,
        fxDate: FX_DAY,
        reviewStatus: 'approved',
        isFixture: false,
      },
    ]);
    // Two captures of one dish are matched on this name, so it is one derivation of the name.
    expect(row.normalizedName).toBe(normalizeItemName(row.itemName));
  });

  it('stores the page items and every item of the menu PDF it links to', async () => {
    const place = await makeIngestPlace({
      category: 'restaurant',
      website: site('/menu-pdf-link/'),
    });

    await expect(ingestPlace(ctx, place.id)).resolves.toEqual({
      pricedItems: PDF_MENU.items.length + 2,
      queuedCall: false,
    });

    // The PDF was read once, through the page's own menu link, and answered as a document.
    expect(hitsOn('127.0.0.1').filter((hit) => hit.path === PDF_PATH)).toHaveLength(1);

    const stored = await priceRecords(place.id);
    expect(stored).toHaveLength(PDF_MENU.items.length + 2);
    expect(new Set(stored.map((row) => row.captureBatchId)).size).toBe(1);
    expect(stored.filter((row) => row.priceText === '€18.50')).toEqual([]);

    // Every item of the labeled set is stored exactly as the document prints it, at the recorded
    // rate of the capture day, and cites the PDF as its source (AAP 0.5.6, 0.5.7).
    expect(byName(stored.filter((row) => row.sourceUrl === site(PDF_PATH)))).toMatchObject(
      byName(
        PDF_MENU.items.map((item) => ({
          itemName: item.name,
          itemCategory: item.category,
          priceText: item.priceText,
          localAmountMinor: item.amountMinor,
          priceUsdCents: expectedCents(item.amountMinor, item.currency),
          currency: item.currency,
          normalizedName: item.normalizedName,
          alcoholic: null,
          perPerson: null,
          ticketType: null,
          source: 'online_menu',
          capturedAt: NOW,
          fxDate: FX_DAY,
          reviewStatus: 'approved',
          isFixture: false,
        })),
      ),
    );
    // The two items of the page itself cite the page, which is where they were printed.
    expect(
      stored.filter((row) => row.sourceUrl === site('/menu-pdf-link/')).map((row) => row.itemName),
    ).toEqual(['Imperial', 'Prego no pão']);
    expect(await menuTasks(place.id)).toEqual([]);
  });

  it('stores the six tickets of the activity page with their per-person flag and type', async () => {
    const place = await makeIngestPlace({
      category: 'activity',
      website: site('/activity-tickets/'),
    });

    await expect(ingestPlace(ctx, place.id)).resolves.toEqual({
      pricedItems: TICKET_CASES.length,
      queuedCall: false,
    });

    const stored = await priceRecords(place.id);
    expect(byName(stored)).toMatchObject(
      byName(
        TICKET_CASES.map((row) => ({
          itemName: row.itemName,
          itemCategory: 'ticket',
          priceText: row.priceText,
          localAmountMinor: row.localAmountMinor,
          priceUsdCents: expectedCents(row.localAmountMinor, 'EUR'),
          currency: 'EUR',
          normalizedName: row.normalizedName,
          alcoholic: null,
          perPerson: row.perPerson,
          ticketType: row.ticketType,
          source: 'online_menu',
          sourceUrl: site('/activity-tickets/'),
          capturedAt: NOW,
          fxDate: FX_DAY,
          reviewStatus: 'approved',
          isFixture: false,
        })),
      ),
    );
    // The invented ticket is dropped like every other price the page never printed.
    expect(stored.filter((row) => row.priceText === '99,00 €')).toEqual([]);
    expect(await menuTasks(place.id)).toEqual([]);
  });

  it.each(FALLBACK_CASES)('takes the phone fallback for $name', async (row) => {
    const place = await row.build();
    const state: CaseState = {
      place,
      sentBefore: fakeLlm.calls.sent.length,
      countedBefore: fakeLlm.calls.counted.length,
    };

    await expect(ingestPlace(ctx, place.id)).resolves.toEqual({
      pricedItems: row.pricedItems,
      queuedCall: row.queuedCall,
    });

    expect(await priceRecords(place.id)).toHaveLength(row.pricedItems);
    // One `menu_prices` task per place, and only where the run fell back; its priority is the same
    // call-and-menu number the ingestion job carries (AAP 0.5.6, 0.5.7).
    expect((await menuTasks(place.id)).map((task) => task.status)).toEqual(
      row.queuedCall ? ['queued'] : [],
    );

    await row.check(state);

    if (row.queuedCall) {
      // A second attempt opens no second task: the fallback is keyed on the place's outstanding
      // call, so the retry leaves exactly the one task it found (AAP 0.5.6).
      await ingestPlace(ctx, place.id);
      expect(await menuTasks(place.id)).toHaveLength(1);
    }
  });

  it('spaces every request to one site at least a second apart', async () => {
    const first = await makeIngestPlace({ category: 'restaurant', website: site('/menu-html/') });
    const second = await makeIngestPlace({
      category: 'activity',
      website: site('/activity-tickets/'),
    });

    // Two places of one site at once: the per-domain slot orders them, not the browser nor the job.
    await Promise.all([ingestPlace(ctx, first.id), ingestPlace(ctx, second.id)]);

    const times = arrivalTimesOn('127.0.0.1');
    expect(times.length).toBeGreaterThan(2);

    // The slot is taken before the request is sent — `SET throttle:<domain> 1 NX PX 1000` — so an
    // arrival lands about a second after the previous one; only the event loop's own jitter is
    // left, which the 950 ms bound tolerates. With no throttle the gap is milliseconds, so this is
    // the assertion that fails when the slot is dropped (AAP 0.5.6).
    for (const gap of gapsMs(times)) {
      expect(gap).toBeGreaterThanOrEqual(950);
    }
  });

  it('defers a place to 00:05 local the next day when its city has spent its budget', async () => {
    const place = await makeIngestPlace({ category: 'restaurant', website: site('/menu-html/') });
    const localDay = localDateKey(CITY_TZ, NOW);

    // The local day's cap, committed as the reservations of earlier runs leave it: every further
    // request of that day is refused before it is sent (AAP 0.5.6).
    await db().callBudgetDay.create({
      data: {
        cityId: CITY,
        // The `@db.Date` column takes the day as midnight UTC, so no zone moves the calendar day.
        localDate: new Date(`${localDay}T00:00:00.000Z`),
        llmSpendMicros: BigInt(ctx.env.capLlmMicrosPerCityDay),
      },
    });

    await expect(ingestPlace(ctx, place.id)).resolves.toEqual({
      pricedItems: 0,
      queuedCall: false,
      deferred: true,
    });

    // Counted once and never sent, so nothing was spent and nothing was written: no record, no
    // fallback task, and no second attempt against a limit that cannot move (AAP 0.5.6).
    expect(fakeLlm.calls.counted.length).toBeGreaterThan(0);
    expect(fakeLlm.calls.sent).toEqual([]);
    expect(await priceRecords(place.id)).toEqual([]);
    expect(await menuTasks(place.id)).toEqual([]);

    const deferUntil = nextLocalDayAt(CITY_TZ, NOW, '00:05');
    const job = await ctx.queues
      .get(QUEUE.menuIngest)
      .getJob(`menu-ingest-${place.id}-${localDateKey(CITY_TZ, deferUntil)}`);

    expect(job?.name).toBe(INGEST);
    expect(job?.data as unknown).toEqual({ placeId: place.id });
    // BullMQ's own `timestamp` is wall time, so only the delay the job was added with is comparable.
    expect(job?.opts.delay).toBe(deferUntil.getTime() - ctx.clock.nowMs());
  });

  it('queues one ingest job per place whose online prices are missing or stale', async () => {
    const stale = await makeIngestPlace({ category: 'restaurant', website: site('/menu-html/') });
    const priced = await makeIngestPlace({ category: 'cafe', website: site('/menu-html/') });
    const unlinked = await makeIngestPlace({ category: 'bar' });

    // A fresh approved online capture is what leaves the second place out of the fan-out, and a
    // place with no link at all is never queued for one (AAP 0.5.6, 0.5.7).
    await makePriceRecords(testApp, priced, [
      { name: 'Prato do dia', itemCategory: 'main', usdCents: 1_200, source: 'online_menu' },
    ]);

    await expect(
      runMenuIngest({ name: INGEST_CITY, data: { cityId: CITY } }, ctx),
    ).resolves.toEqual({ enqueued: 1 });

    const jobs = await menuIngestJobs();
    expect(
      jobs.map((job) => ({
        name: job.name,
        data: job.data as unknown,
        priority: job.opts.priority,
        id: job.id,
      })),
    ).toEqual([
      {
        name: INGEST,
        data: { placeId: stale.id },
        // The last band, with no partner venue and no locked meetup near the place: the rule of
        // AAP 0.5.7 gives `1 + 2 × 4 + 1`, and every job this queue adds carries it.
        priority: 10,
        id: `menu-ingest-${stale.id}-${localDateKey(CITY_TZ, NOW)}`,
      },
    ]);
    expect(
      jobs.filter((job) => (job.data as { placeId?: string }).placeId === unlinked.id),
    ).toEqual([]);
  });
}, 120_000);
