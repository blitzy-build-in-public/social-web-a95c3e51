/** Integration tests for the weekly OpenStreetMap place and lodging refresh (`apps/workers/src/jobs/place-refresh.ts`) against the recorded Overpass answers in `test/fixtures/overpass/` (AAP 0.3.3, 0.5.6). */

import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_TEST_NOW,
  createTestApp,
  testWorkersEnv,
  type TestApp,
} from '@tablemate/api/test-support/app';
import { clockHelpers } from '@tablemate/api/test-support/clock';
import {
  makeActivityFacts,
  makeClaim,
  makeLodging,
  makeUser,
  makeVenue,
} from '@tablemate/api/test-support/factories';
import { readPoints, setPoint, type DbClient } from '@tablemate/db';
import {
  JOB,
  QUEUE,
  QueuePayloadError,
  createLogger,
  decryptField,
  encryptField,
  loadWorkersEnv,
  localDateKey,
  randomSecret,
  secretLookupHash,
} from '@tablemate/server-core';
import { DAY_MS, E164 } from '@tablemate/shared';
import type { LodgingKind } from '@tablemate/shared';

import { process as refreshPlaces } from '../../src/jobs/place-refresh.ts';
import { lodgingKindOf } from '../../src/places/lodging-upsert.ts';
import { closeWorkerContext, createWorkerContext, type WorkerContext } from '../../src/queues.ts';

/** The launch city the refresh is driven for: configured, so `seedCities` writes its `bbox` too. */
const CITY = 'lisbon';
/** A second city with no active partner venue and no lodging holding a console secret (AAP 0.5.6). */
const OTHER_CITY = 'cascais';
/** The job name this queue accepts, which is the only one the processor may be driven with. */
const JOB_NAME = JOB[QUEUE.placeRefresh].refresh;
/** Where the only active partner venue of the first run stands, in Lisbon (AAP 0.5.6). */
const VENUE_POINT = { lat: 38.711, lng: -9.142 } as const;
/** The number an operator enters on the lodging whose OSM phone the refresh answers twice with a different value (AAP 0.5.6). It is a reserved fictional number that appears in neither lodging fixture, which the second refresh asserts at run time so the two can never agree by accident. */
const OPERATOR_PHONE = '+14155550195';
const REFRESH_INTERVAL = { days: 7 } as const;
/** The place rows that already exist before the first refresh, each with deliberately stale fields, so the run proves the `update` half of the upsert as well as the `insert` half (AAP 0.5.6). The last one is owned by {@link OTHER_CITY}: a row the refresh must rewrite without ever writing its `cityId`. */
const STALE_PLACES = [
  { key: 'node/910001', cityId: CITY, name: 'Fixture Stale Tasca' },
  { key: 'node/910003', cityId: CITY, name: 'Fixture Stale Sem Telefone' },
  { key: 'node/910004', cityId: CITY, name: 'Fixture Stale Marisqueira' },
  { key: 'node/910006', cityId: CITY, name: 'Fixture Stale Pastelaria' },
  { key: 'node/910010', cityId: OTHER_CITY, name: 'Fixture Stale Bar' },
] as const;
/** The two places whose seeded price records make the price work skip them (AAP 0.5.7): the first has a fresh approved `online_menu` record, so no `menu-ingest` job is queued for it, and the second a fresh approved `phone_quote`, so it takes no `menu_prices` fallback. Every other place with a link is queued and every other place without one falls back. */
const PRICED_ONLINE_KEY = 'node/910001';
const PRICED_PHONE_KEY = 'node/910003';
interface FixtureElement {
  readonly type: string;
  readonly id: number;
  readonly lat?: number;
  readonly lon?: number;
  readonly center?: { readonly lat: number; readonly lon: number };
  readonly tags?: Readonly<Record<string, string>>;
}

interface PlacesCases {
  readonly skipped: readonly string[];
  readonly categories: Readonly<Record<string, readonly string[]>>;
  readonly formattedPhone: readonly string[];
  readonly dottedPhone: readonly string[];
  readonly multiPhone: readonly string[];
  readonly nonE164Phone: readonly string[];
  readonly noPhone: readonly string[];
  readonly fromCenter: readonly string[];
  readonly withMenuLink: readonly string[];
}

interface PlacesFixture {
  readonly _cases: PlacesCases;
  readonly elements: readonly FixtureElement[];
}

/** The `_cases` map of the recorded lodging answers, which the second run's answer extends. */
interface LodgingsCases {
  readonly kinds: Readonly<Record<string, readonly string[]>>;
  readonly noPhone: readonly string[];
  readonly contactPhone: readonly string[];
  readonly fromCenter: readonly string[];
  readonly removed?: string;
  readonly renamed?: string;
  readonly renamedTo?: string;
  readonly operatorPhone?: string;
  readonly osmPhoneChanged?: string;
  readonly osmPhoneTo?: string;
  readonly new?: string;
  readonly returned?: string;
  readonly unchanged?: readonly string[];
}

interface LodgingsFixture {
  readonly _cases: LodgingsCases;
  readonly elements: readonly FixtureElement[];
}

/** One Overpass request the fixture server answered, which is half of what the suite asserts. */
interface ServedCall {
  readonly kind: 'places' | 'lodgings';
  readonly userAgent: string | undefined;
  readonly query: string;
}

type LodgingsAnswer = 'first' | 'refresh' | 'empty';
let testApp: TestApp;
let worker: WorkerContext;
/** The console secret issued to a lodging between the two refreshes (AAP 0.5.6), with the ciphertext and lookup hash its row is written with. The value is minted at run time, so no secret shape ever appears in this file. */
let lodgingSecret: string;
let removedClaimId: string;
let removedFactIds: readonly string[];
let removedLodgingId: string;
let server: Server | undefined;
/** Every request the fixture server answered, in order, which is what the query assertions read. */
const served: ServedCall[] = [];
/** Every log line the job wrote, captured instead of printed (AAP 0.11.1). */
const logs: Record<string, unknown>[] = [];
let lodgingsAnswer: LodgingsAnswer = 'first';
let stop: (() => Promise<void>) | undefined;
/** `START` moved back by `days`, so one instant describes the age of every seeded price (AAP 0.5.7). */
function daysBefore(days: number): Date {
  return new Date(Date.parse(DEFAULT_TEST_NOW) - days * DAY_MS);
}

function findRepoFile(relativePath: string): string {
  const from = dirname(fileURLToPath(import.meta.url));
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
    if (dirname(dir) === dir) {
      throw new Error(`no ancestor of ${from} holds ${relativePath}`);
    }
  }
}

const PLACES_FIXTURE = findRepoFile('apps/workers/test/fixtures/overpass/lisbon-places.json');
const LODGINGS_FIXTURE = findRepoFile('apps/workers/test/fixtures/overpass/lisbon-lodgings.json');
const LODGINGS_REFRESH_FIXTURE = findRepoFile(
  'apps/workers/test/fixtures/overpass/lisbon-lodgings-refresh.json',
);
/** The three recorded answers, parsed as this module is loaded rather than in `beforeAll`: a table given to `it.each` is built at collection time, before any hook runs, and every row of it has to come from the fixture it describes. Reading the files synchronously here is what lets one parse serve both the case tables and the fixture server (AAP 0.3.3, 0.5.6). */

const placesFixture = JSON.parse(readFileSync(PLACES_FIXTURE, 'utf8')) as PlacesFixture;
const lodgingsFixture = JSON.parse(readFileSync(LODGINGS_FIXTURE, 'utf8')) as LodgingsFixture;
const lodgingsRefreshFixture = JSON.parse(
  readFileSync(LODGINGS_REFRESH_FIXTURE, 'utf8'),
) as LodgingsFixture;
function elementByKey(elements: readonly FixtureElement[], key: string): FixtureElement {
  const [type, id] = key.split('/');
  const found = elements.find((element) => element.type === type && String(element.id) === id);
  if (found === undefined) {
    throw new Error(`the recorded answer holds no element "${key}"`);
  }

  return found;
}

function pointOf(element: FixtureElement): { lat: number; lng: number } | null {
  if (element.lat !== undefined && element.lon !== undefined) {
    return { lat: element.lat, lng: element.lon };
  }

  return element.center === undefined ? null : { lat: element.center.lat, lng: element.center.lon };
}

/** The phone the ingestion stores for an element's tags, by the rule `places/categorize.ts` documents (AAP 0.5.6): the first `;`-separated entry, the separators OSM writes removed, a leading `00` read as `+`, and the result kept only when it is E.164. Deriving the expectation from the fixture's own tag is what keeps this table and the fixture from drifting apart. */
function expectedPhone(tags: Readonly<Record<string, string>> | undefined): string | null {
  const first = (tags?.['phone'] ?? tags?.['contact:phone'])?.split(';')[0]?.trim() ?? '';
  if (first === '') {
    return null;
  }

  const digits = first.replace(/[\s\u00A0\-.()/]/g, '');
  const normalized = digits.startsWith('00') ? `+${digits.slice(2)}` : digits;
  return E164.safeParse(normalized).success ? normalized : null;
}

function casePairs(cases: Readonly<Record<string, readonly string[]>>): [string, string][] {
  return Object.entries(cases).flatMap(([name, keys]) =>
    keys.map((key): [string, string] => [key, name]),
  );
}

function mappedPlaceKeys(): string[] {
  const skipped = new Set(placesFixture._cases.skipped);
  return placesFixture.elements
    .map((element) => `${element.type}/${element.id}`)
    .filter((key) => !skipped.has(key));
}

function expectedMenuKeys(): string[] {
  return placesFixture._cases.withMenuLink.filter((key) => key !== PRICED_ONLINE_KEY);
}

function expectedFallbackKeys(): string[] {
  const linked = new Set(placesFixture._cases.withMenuLink);
  return mappedPlaceKeys().filter((key) => !linked.has(key) && key !== PRICED_PHONE_KEY);
}

const PHONE_CASES: readonly string[] = [
  ...placesFixture._cases.formattedPhone,
  ...placesFixture._cases.dottedPhone,
  ...placesFixture._cases.multiPhone,
  ...placesFixture._cases.nonE164Phone,
  ...placesFixture._cases.noPhone,
];
/** Every place the answer gives a category for, paired with the category its `_cases` key names, so a fixture edit that changes the mapping fails here rather than passing unnoticed. */
const CATEGORY_CASES: [string, string][] = casePairs(placesFixture._cases.categories);
const LODGING_CASES: [string, string][] = casePairs(lodgingsFixture._cases.kinds);
const CENTRE_CASES: readonly string[] = [
  ...placesFixture._cases.fromCenter,
  ...lodgingsFixture._cases.fromCenter,
];
interface PlaceRow {
  readonly id: string;
  readonly cityId: string;
  readonly name: string;
  readonly category: string;
  readonly phone: string | null;
  readonly website: string | null;
  readonly menuUrl: string | null;
  readonly openingHours: string | null;
  readonly doNotCall: boolean;
  readonly isFixture: boolean;
  readonly nearestPartnerDistanceM: number | null;
}

interface LodgingRow {
  readonly id: string;
  readonly cityId: string;
  readonly name: string;
  readonly kind: string;
  readonly address: string | null;
  readonly phone: string | null;
  readonly phoneSource: string;
  readonly doNotCall: boolean;
  readonly isFixture: boolean;
  readonly osmMissingAt: Date | null;
  readonly secretLookupHash: string | null;
  readonly secretCiphertext: string | null;
  readonly secretIssuedAt: Date | null;
}

const PLACE_COLUMNS = {
  id: true,
  cityId: true,
  name: true,
  category: true,
  phone: true,
  website: true,
  menuUrl: true,
  openingHours: true,
  doNotCall: true,
  isFixture: true,
  nearestPartnerDistanceM: true,
} as const;
const LODGING_COLUMNS = {
  id: true,
  cityId: true,
  name: true,
  kind: true,
  address: true,
  phone: true,
  phoneSource: true,
  doNotCall: true,
  isFixture: true,
  osmMissingAt: true,
  secretLookupHash: true,
  secretCiphertext: true,
  secretIssuedAt: true,
} as const;
function db(): DbClient {
  return testApp.services.db;
}

function splitKey(key: string): { osmType: string; osmId: bigint } {
  const [osmType, osmId] = key.split('/');
  if (osmType === undefined || osmId === undefined) {
    throw new Error(`"${key}" is not an <osmType>/<osmId> key`);
  }

  return { osmType, osmId: BigInt(osmId) };
}

function lodgingKey(key: string): { osmType_osmId: { osmType: string; osmId: bigint } } {
  return { osmType_osmId: splitKey(key) };
}

async function place(key: string): Promise<PlaceRow> {
  return await db().place.findFirstOrThrow({
    where: splitKey(key),
    select: PLACE_COLUMNS,
  });
}

async function lodging(key: string): Promise<LodgingRow> {
  return await db().lodging.findFirstOrThrow({
    where: splitKey(key),
    select: LODGING_COLUMNS,
  });
}

type ManualLodgingRow = LodgingRow & {
  readonly osmType: string | null;
  readonly osmId: bigint | null;
  readonly createdAt: Date;
};
/** The manually entered lodging: the one row no refresh may select, because it has no OSM key. */
async function manualLodging(): Promise<ManualLodgingRow> {
  return await db().lodging.findFirstOrThrow({
    where: { osmType: null, osmId: null },
    select: { ...LODGING_COLUMNS, osmType: true, osmId: true, createdAt: true },
  });
}

async function coordinates(
  table: 'place' | 'lodging',
  id: string,
): Promise<{
  readonly lat: number | undefined;
  readonly lng: number | undefined;
}> {
  const points = await readPoints(db(), table, [id], 'test');
  const point = points.get(id);
  return { lat: point?.lat, lng: point?.lng };
}

async function menuIngestJobs(): Promise<{ id: string | undefined; data: unknown }[]> {
  const jobs = await worker.queues
    .get(QUEUE.menuIngest)
    .getJobs(['waiting', 'prioritized', 'delayed']);
  return jobs.map((job) => ({ id: job.id, data: job.data as unknown }));
}

async function menuTaskPlaceIds(): Promise<string[]> {
  const rows = await db().callTask.findMany({
    where: { kind: 'menu_prices' },
    select: { placeId: true },
  });
  return rows
    .map((row) => row.placeId)
    .filter((placeId): placeId is string => placeId !== null)
    .sort();
}

async function rowSnapshot(): Promise<unknown> {
  const client = db();
  return {
    places: await client.place.findMany({
      orderBy: { osmId: 'asc' },
      select: { ...PLACE_COLUMNS, osmType: true, osmId: true, createdAt: true },
    }),
    lodgings: await client.lodging.findMany({
      orderBy: [{ osmType: 'asc' }, { osmId: 'asc' }],
      select: { ...LODGING_COLUMNS, osmType: true, osmId: true, createdAt: true },
    }),
  };
}

function expectedMenuJobId(placeId: string): string {
  return `menu-ingest-${placeId}-${localDateKey('Europe/Lisbon', testApp.clock.now())}`;
}

async function refresh(cityId: string): Promise<unknown> {
  return await refreshPlaces({ id: `test-${cityId}`, name: JOB_NAME, data: { cityId } }, worker);
}

/** Starts the server that plays Overpass (AAP 0.3.3). @returns The endpoint URL the workers environment is given. */
async function startFixtureServer(): Promise<string> {
  const created = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      const query = new URLSearchParams(body).get('data') ?? '';
      const lodgings = query.includes('hostel|hotel|guest_house');
      served.push({
        kind: lodgings ? 'lodgings' : 'places',
        userAgent: request.headers['user-agent'],
        query,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(lodgings ? lodgingsBody() : placesFixture));
    });
  });
  await new Promise<void>((resolve) => {
    created.listen(0, '127.0.0.1', resolve);
  });
  server = created;
  const address = created.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fixture server did not start on a port');
  }

  return `http://127.0.0.1:${address.port}/api/interpreter`;
}

function lodgingsBody(): unknown {
  if (lodgingsAnswer === 'first') {
    return lodgingsFixture;
  }

  return lodgingsAnswer === 'refresh'
    ? lodgingsRefreshFixture
    : { version: 0.6, generator: 'Overpass API (fixture)', elements: [] };
}

const MANUAL_LODGING_NAME = 'Fixture Manual Lodging';
const REMOVED_KEY = caseValue('removed', lodgingsRefreshFixture._cases.removed);
const RENAMED_KEY = caseValue('renamed', lodgingsRefreshFixture._cases.renamed);
const NEW_KEY = caseValue('new', lodgingsRefreshFixture._cases.new);
const RETURNED_KEY = caseValue('returned', lodgingsRefreshFixture._cases.returned);
const OPERATOR_PHONE_KEY = caseValue('operatorPhone', lodgingsRefreshFixture._cases.operatorPhone);
const OSM_PHONE_CHANGED_KEY = caseValue(
  'osmPhoneChanged',
  lodgingsRefreshFixture._cases.osmPhoneChanged,
);
const BATCH_ONLINE = 'cccccccc-0000-4000-8000-000000000001';
const BATCH_UNREVIEWED = 'cccccccc-0000-4000-8000-000000000002';
const BATCH_PHONE = 'cccccccc-0000-4000-8000-000000000003';
const BATCH_STALE = 'cccccccc-0000-4000-8000-000000000004';
/** A `_cases` value the assertions depend on, refused rather than read as `undefined`. */
function caseValue(name: string, value: string | undefined): string {
  if (value === undefined) {
    throw new Error(`the recorded answer names no "${name}" case`);
  }

  return value;
}

function nameOf(element: FixtureElement): string {
  const name = element.tags?.['name'];
  if (name === undefined) {
    throw new Error(`element ${element.type}/${element.id} carries no name`);
  }

  return name;
}

function lodgingKindFrom(element: FixtureElement): LodgingKind {
  const kind = lodgingKindOf(element.tags);
  if (kind === null) {
    throw new Error(`element ${element.type}/${element.id} is no lodging kind`);
  }

  return kind;
}

/** Writes the state the refresh answers are compared against (AAP 0.5.2, 0.5.6): the two cities, the one active partner venue, a manually entered lodging, a lodging OSM dropped and the places and price records that decide both the `update` half of the place upsert and the price work. */
async function seed(): Promise<void> {
  const client = db();
  // The launch cities, from `config/cities.json`: `lisbon` also brings the `bbox` the lodgings query is built from (AAP 0.5.6).
  await testApp.seedCities();
  // A city no venue serves and no lodging of which holds a console secret: it proves that a row another city owns keeps its city, and the run that reaches the lodgings query alone (AAP 0.5.6).
  await client.city.create({
    data: {
      id: OTHER_CITY,
      circuitCityId: 99,
      name: 'Cascais',
      countryCode: 'PT',
      timezone: 'Europe/Lisbon',
      callLanguage: 'pt-PT',
      currency: 'EUR',
      bbox: { south: 38.6, west: -9.3, north: 38.62, east: -9.28 },
    },
  });
  await makeVenue(testApp, {
    cityId: CITY,
    lat: VENUE_POINT.lat,
    lng: VENUE_POINT.lng,
    isActivePartner: true,
  });
  // A manually entered lodging: it carries no OSM key, so no refresh may select it (AAP 0.5.6).
  const manual = await makeLodging(testApp, {
    cityId: CITY,
    lat: 38.713,
    lng: -9.139,
    kind: 'hotel',
    doNotCall: true,
  });
  await client.lodging.update({
    where: { id: manual.id },
    data: { name: MANUAL_LODGING_NAME },
  });
  // A row OSM dropped three days ago, which the second answer lists again: the run has to clear the mark and keep the id every claim and activity fact references (AAP 0.5.6).
  const returning = elementByKey(lodgingsRefreshFixture.elements, RETURNED_KEY);
  const returningPoint = pointOf(returning);
  const returningRow = await client.lodging.create({
    data: {
      cityId: CITY,
      osmType: returning.type,
      osmId: BigInt(returning.id),
      name: nameOf(returning),
      kind: lodgingKindFrom(returning),
      phone: expectedPhone(returning.tags),
      phoneSource: 'osm',
      osmMissingAt: daysBefore(3),
    },
    select: { id: true },
  });
  if (returningPoint !== null) {
    await setPoint(db(), 'lodging', returningRow.id, returningPoint);
  }

  for (const stale of STALE_PLACES) {
    const row = await client.place.create({
      data: {
        ...splitKey(stale.key),
        cityId: stale.cityId,
        name: stale.name,
        category: 'bar',
        openingHours: 'Mo-Su 08:00-22:00',
      },
      select: { id: true },
    });
    await setPoint(db(), 'place', row.id, { lat: 38.7005, lng: -9.1505 });
  }

  await seedPrice({
    key: PRICED_ONLINE_KEY,
    batch: BATCH_ONLINE,
    source: 'online_menu',
    reviewStatus: 'approved',
    days: 5,
  });
  // Fresh, but an operator has not approved it: not a price `suggestions` may serve (AAP 0.5.7).
  await seedPrice({
    key: 'node/910004',
    batch: BATCH_UNREVIEWED,
    source: 'online_menu',
    reviewStatus: 'needs_review',
    days: 2,
  });
  await seedPrice({
    key: PRICED_PHONE_KEY,
    batch: BATCH_PHONE,
    source: 'phone_quote',
    reviewStatus: 'approved',
    days: 5,
  });
  // A phone quote past its 60-day window: stale, so the phone fallback is still warranted (AAP 0.5.7).
  await seedPrice({
    key: 'node/910006',
    batch: BATCH_STALE,
    source: 'phone_quote',
    reviewStatus: 'approved',
    days: 70,
  });
}

/** One place's approved or unapproved price record, aged by `days` from the frozen instant. */
async function seedPrice(input: {
  readonly key: string;
  readonly batch: string;
  readonly source: 'online_menu' | 'phone_quote';
  readonly reviewStatus: 'approved' | 'needs_review';
  readonly days: number;
}): Promise<void> {
  const row = await place(input.key);
  const main = input.days % 2 === 1;
  await db().priceRecord.create({
    data: {
      placeId: row.id,
      captureBatchId: input.batch,
      itemName: main ? 'Prato do dia' : 'Café',
      normalizedName: main ? 'prato do dia' : 'cafe',
      itemCategory: main ? 'main' : 'drink',
      priceText: main ? '12,50 €' : '1,20 €',
      localAmountMinor: main ? 1250 : 120,
      currency: 'EUR',
      priceUsdCents: main ? 1350 : 130,
      source: input.source,
      sourceUrl:
        input.source === 'online_menu'
          ? 'https://tasca.lisbon.fixture.test/menu'
          : 'tel:+14155550050',
      capturedAt: daysBefore(input.days),
      fxDate: daysBefore(input.days),
      reviewStatus: input.reviewStatus,
    },
  });
}

beforeAll(async () => {
  const overpassUrl = await startFixtureServer();
  testApp = await createTestApp();
  await testApp.resetState();
  await seed();
  // The context the processor is called with: the harness's clock — one clock for the suite, which is what lets a window be crossed in a tick (AAP 0.11.1) — its Redis for the producers, and a logger that keeps every line in memory so the redaction rule can be asserted (AAP 0.11.1).
  worker = await createWorkerContext(
    loadWorkersEnv(testWorkersEnv({ OVERPASS_URL: overpassUrl })),
    {
      clock: testApp.clock,
      logger: createLogger({
        name: 'place-refresh-test',
        level: 'info',
        appEnv: 'test',
        destination: {
          write: (line: string) => {
            logs.push(JSON.parse(line) as Record<string, unknown>);
          },
        },
      }),
    },
  );
  lodgingSecret = randomSecret();
  stop = async () => {
    await closeWorkerContext(worker);
    await testApp.close();
    if (server !== undefined) {
      const running = server;
      await new Promise<void>((resolve) => running.close(() => resolve()));
    }
  };
}, 300_000);
afterAll(async () => {
  // A `beforeAll` that failed before reaching the teardown must report its own error, not a second one.
  if (stop !== undefined) {
    await stop();
  }
});
/** The cases run in order over one seeded city and one shared instant: each one leaves the database where the next expects it (the two refreshes of AAP 0.5.6 are one flow), so this file is not a collection of independent fixtures and must not be reordered. */
describe('place-refresh', () => {
  it('refuses a job name its queue does not accept, and data that is not a city', async () => {
    await expect(
      refreshPlaces({ name: 'weekly', data: { cityId: CITY } }, worker),
    ).rejects.toBeInstanceOf(QueuePayloadError);
    await expect(
      refreshPlaces({ name: JOB_NAME, data: { city: CITY } }, worker),
    ).rejects.toBeInstanceOf(QueuePayloadError);
  });

  it('reports a city the database does not hold without calling Overpass', async () => {
    const before = served.length;
    await expect(refresh('nowhere')).resolves.toEqual({ skipped: 'unknown_city' });
    expect(served).toHaveLength(before);
  });

  it('answers the first refresh with the two queries and the counts of the recorded answers', async () => {
    const before = served.length;
    const result = await refresh(CITY);
    const calls = served.slice(before);
    // The places query runs around the city's one centre and the lodgings query inside its bbox, one after the other, each identifying the crawler (AAP 0.3.3, 0.5.6).
    expect(calls.map((call) => call.kind)).toEqual(['places', 'lodgings']);
    expect(calls.map((call) => call.userAgent)).toEqual([
      worker.env.crawlerUserAgent,
      worker.env.crawlerUserAgent,
    ]);
    expect(calls.every((call) => call.userAgent?.startsWith('TablemateBot/1.0'))).toBe(true);
    expect(calls[0]?.query).toContain(
      `around:2000,${VENUE_POINT.lat.toFixed(6)},${VENUE_POINT.lng.toFixed(6)}`,
    );
    expect(calls[1]?.query).toContain('(38.690000,-9.230000,38.780000,-9.100000)');
    expect(result).toEqual({
      event: 'place_refresh',
      cityId: CITY,
      places: {
        inserted: mappedPlaceKeys().length - STALE_PLACES.length,
        updated: STALE_PLACES.length,
        skipped: placesFixture._cases.skipped.length,
      },
      lodgings: {
        inserted: lodgingsFixture.elements.length,
        updated: 0,
        unchanged: 0,
        missing: 0,
        returned: 0,
        skipped: 0,
      },
      menuJobs: expectedMenuKeys().length,
      callTasks: expectedFallbackKeys().length,
    });
  });

  it.each(placesFixture._cases.skipped)('writes no place row for %s', async (key) => {
    expect(await db().place.count({ where: splitKey(key) })).toBe(0);
  });

  it.each(CATEGORY_CASES)('stores %s as a %s', async (key, category) => {
    expect((await place(key)).category).toBe(category);
  });

  it.each(PHONE_CASES)('stores the phone of %s as its tag gives it', async (key) => {
    const element = elementByKey(placesFixture.elements, key);
    expect((await place(key)).phone).toBe(expectedPhone(element.tags));
  });

  it('normalizes the recorded phone forms exactly as AAP 0.5.6 documents', async () => {
    expect((await place('node/910001')).phone).toBe('+14155550161');
    expect((await place('node/910004')).phone).toBeNull();
    expect((await place('node/910005')).phone).toBe('+14155550164');
    expect((await place('node/910006')).phone).toBe('+14155550165');
  });

  it.each(CENTRE_CASES)('locates %s at its center', async (key) => {
    const isPlace = mappedPlaceKeys().includes(key);
    const element = elementByKey(isPlace ? placesFixture.elements : lodgingsFixture.elements, key);
    const expected = pointOf(element);
    expect(expected).not.toBeNull();
    if (expected === null) {
      return;
    }
    const row = isPlace ? await place(key) : await lodging(key);
    const stored = await coordinates(isPlace ? 'place' : 'lodging', row.id);
    expect(stored.lat).toBeCloseTo(expected.lat, 6);
    expect(stored.lng).toBeCloseTo(expected.lng, 6);
  });

  it('rewrites every place from what OSM reports, and nothing of another city’s row', async () => {
    expect(await place('node/910001')).toMatchObject({
      cityId: CITY,
      name: 'Fixture Tasca do Teste',
      category: 'restaurant',
      website: 'https://tasca.lisbon.fixture.test/',
      menuUrl: null,
      openingHours: 'Mo-Su 12:00-23:00',
      doNotCall: false,
      isFixture: false,
    });
    expect((await place('node/910002')).menuUrl).toBe(
      'https://cervejaria.lisbon.fixture.test/menu',
    );
    expect((await place('node/910004')).website).toBe('https://marisqueira.lisbon.fixture.test/');
    // An `opening_hours` the library cannot read is stored as NULL rather than as text (AAP 0.5.6).
    expect((await place('node/910007')).openingHours).toBeNull();
    for (const key of mappedPlaceKeys()) {
      const row = await place(key);
      if (row.cityId !== CITY) {
        continue;
      }
      expect(row.nearestPartnerDistanceM).toBeGreaterThan(0);
      expect(row.nearestPartnerDistanceM).toBeLessThanOrEqual(2_000);
    }
    const foreign = await place('node/910010');
    expect(foreign.cityId).toBe(OTHER_CITY);
    expect(foreign.nearestPartnerDistanceM).toBeNull();
  });

  it.each(LODGING_CASES)('writes %s as a %s from the first answer', async (key, kind) => {
    const element = elementByKey(lodgingsFixture.elements, key);
    expect(await lodging(key)).toMatchObject({
      cityId: CITY,
      name: nameOf(element),
      kind,
      phone: expectedPhone(element.tags),
      phoneSource: 'osm',
      isFixture: false,
      osmMissingAt: null,
    });
  });

  it('leaves the manually entered lodging outside every refresh', async () => {
    expect(await manualLodging()).toMatchObject({
      name: MANUAL_LODGING_NAME,
      kind: 'hotel',
      phoneSource: 'operator',
      doNotCall: true,
      isFixture: true,
      osmMissingAt: null,
      secretLookupHash: null,
      secretCiphertext: null,
    });
  });

  it('queues exactly the price work the freshness rules allow', async () => {
    const jobs = await menuIngestJobs();
    const menuPlaceIds = await Promise.all(
      expectedMenuKeys().map(async (key) => (await place(key)).id),
    );
    expect(jobs.map((job) => job.id).sort()).toEqual(menuPlaceIds.map(expectedMenuJobId).sort());
    expect(jobs.map((job) => (job.data as { placeId?: string }).placeId).sort()).toEqual(
      menuPlaceIds.sort(),
    );
    const fallbackPlaceIds = await Promise.all(
      expectedFallbackKeys().map(async (key) => (await place(key)).id),
    );
    expect(await menuTaskPlaceIds()).toEqual(fallbackPlaceIds.sort());
    expect(await db().callTask.count({ where: { kind: 'menu_prices', status: 'queued' } })).toBe(
      fallbackPlaceIds.length,
    );
    expect(jobs.map((job) => job.id)).not.toContain(
      expectedMenuJobId((await place(PRICED_ONLINE_KEY)).id),
    );
    expect(await menuTaskPlaceIds()).not.toContain((await place(PRICED_PHONE_KEY)).id);
  });

  it('logs the counts of the run and nothing they are made of', () => {
    const lines = logs.filter((line) => line['event'] === 'place_refresh');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ cityId: CITY, menuJobs: expectedMenuKeys().length });
    expect(JSON.stringify(lines[0])).not.toContain('Fixture');
    expect(JSON.stringify(lines[0])).not.toContain('1415555');
  });

  it('preserves operator state, marks what OSM dropped, and keeps its dependents attached', async () => {
    await db().lodging.update({
      where: lodgingKey(OPERATOR_PHONE_KEY),
      data: { phone: OPERATOR_PHONE, phoneSource: 'operator' },
    });
    await db().lodging.update({ where: lodgingKey('node/930001'), data: { doNotCall: true } });
    await db().lodging.update({ where: lodgingKey('relation/950001'), data: { isFixture: true } });
    await db().lodging.update({
      where: lodgingKey('way/940001'),
      data: {
        secretLookupHash: secretLookupHash(lodgingSecret),
        secretCiphertext: encryptField(testApp.services.keyring, lodgingSecret),
        secretIssuedAt: testApp.clock.now(),
      },
    });
    // The number an operator entered appears in none of the recorded answers, so the OSM phone of that same row cannot be mistaken for it (AAP 0.5.6).
    for (const path of [PLACES_FIXTURE, LODGINGS_FIXTURE, LODGINGS_REFRESH_FIXTURE]) {
      expect(readFileSync(path, 'utf8')).not.toContain(OPERATOR_PHONE);
    }
    // The lodging the second answer stops listing carries a claim and an activity fact that reference its id: hiding it from the directory must not detach either of them (AAP 0.5.6, 0.5.7).
    const removed = await lodging(REMOVED_KEY);
    removedLodgingId = removed.id;
    const claimant = await makeUser(testApp, { card: 'none' });
    const counterpart = await makeUser(testApp, { card: 'none' });
    removedClaimId = (await makeClaim(testApp, claimant, removed, { bookingName: 'Fixture Guest' }))
      .id;
    removedFactIds = await makeActivityFacts(testApp, removed, [
      { pair: [claimant, counterpart], completedAt: testApp.clock.now() },
    ]);
    const manualBefore = await manualLodging();
    const operatedBefore = await lodging(OPERATOR_PHONE_KEY);
    const secretBefore = await lodging('way/940001');
    clockHelpers(testApp.clock).advance(REFRESH_INTERVAL);
    lodgingsAnswer = 'refresh';
    const result = await refresh(CITY);
    expect(result).toMatchObject({
      event: 'place_refresh',
      cityId: CITY,
      places: {
        inserted: 0,
        updated: mappedPlaceKeys().length,
        skipped: placesFixture._cases.skipped.length,
      },
      lodgings: { inserted: 1, updated: 3, unchanged: 5, missing: 1, returned: 1, skipped: 0 },
      menuJobs: expectedMenuKeys().length,
      callTasks: 0,
    });
    expect(operatedBefore.phone).toBe(OPERATOR_PHONE);
    expect(await lodging(OPERATOR_PHONE_KEY)).toMatchObject({
      phone: OPERATOR_PHONE,
      phoneSource: 'operator',
    });
    expect((await lodging(OSM_PHONE_CHANGED_KEY)).phone).toBe(
      caseValue('osmPhoneTo', lodgingsRefreshFixture._cases.osmPhoneTo),
    );
    expect((await lodging(RENAMED_KEY)).name).toBe(
      caseValue('renamedTo', lodgingsRefreshFixture._cases.renamedTo),
    );
    expect((await lodging('node/930001')).doNotCall).toBe(true);
    expect((await lodging('relation/950001')).isFixture).toBe(true);
    const secretAfter = await lodging('way/940001');
    expect({
      hash: secretAfter.secretLookupHash,
      ciphertext: secretAfter.secretCiphertext,
      issuedAt: secretAfter.secretIssuedAt,
    }).toEqual({
      hash: secretBefore.secretLookupHash,
      ciphertext: secretBefore.secretCiphertext,
      issuedAt: secretBefore.secretIssuedAt,
    });
    expect(secretBefore.secretLookupHash).toBe(secretLookupHash(lodgingSecret));
    expect(decryptField(testApp.services.keyring, secretBefore.secretCiphertext ?? '')).toBe(
      lodgingSecret,
    );
    expect(await manualLodging()).toEqual(manualBefore);
    // The dropped lodging keeps its row — and therefore the id its claim and its activity fact reference — with the instant this run marked it; the one that came back loses its mark, and the new element was inserted as an OSM row (AAP 0.5.6).
    const dropped = await lodging(REMOVED_KEY);
    expect(dropped.osmMissingAt?.getTime()).toBe(testApp.clock.now().getTime());
    expect(
      (
        await db().lodgingClaim.findUniqueOrThrow({
          where: { id: removedClaimId },
          select: { lodgingId: true },
        })
      ).lodgingId,
    ).toBe(removedLodgingId);
    expect(await db().lodgingActivityFact.count({ where: { lodgingId: removedLodgingId } })).toBe(
      removedFactIds.length,
    );
    expect((await lodging(RETURNED_KEY)).osmMissingAt).toBeNull();
    expect(await lodging(NEW_KEY)).toMatchObject({
      name: nameOf(elementByKey(lodgingsRefreshFixture.elements, NEW_KEY)),
      phoneSource: 'osm',
      isFixture: false,
      osmMissingAt: null,
    });
    const secondRun = served.slice(-2);
    expect(secondRun.map((call) => call.kind)).toEqual(['places', 'lodgings']);
    expect(secondRun[0]?.query).toContain('around:2000,38.712000,-9.140800');
  });

  it('writes the same rows and queues nothing on a further run at the same instant', async () => {
    const before = await rowSnapshot();
    const jobsBefore = await menuIngestJobs();
    const tasksBefore = await menuTaskPlaceIds();
    const result = await refresh(CITY);
    expect(result).toMatchObject({
      places: {
        inserted: 0,
        updated: mappedPlaceKeys().length,
        skipped: placesFixture._cases.skipped.length,
      },
      lodgings: {
        inserted: 0,
        updated: 0,
        unchanged: lodgingsRefreshFixture.elements.length,
        missing: 0,
        returned: 0,
        skipped: 0,
      },
      menuJobs: expectedMenuKeys().length,
      callTasks: 0,
    });
    // The custom id `<queue>-<placeId>-<localDate>` bounds a place to one ingestion per city-local day, so two runs' worth of jobs stand in the queue and the third added none of them again; an open fallback task is left alone the same way (AAP 0.3.2, 0.5.6).
    expect(await menuIngestJobs()).toEqual(jobsBefore);
    expect(jobsBefore).toHaveLength(expectedMenuKeys().length * 2);
    expect(await menuTaskPlaceIds()).toEqual(tasksBefore);
    expect(await rowSnapshot()).toEqual(before);
  });

  it('runs the lodgings query alone for a city no venue serves', async () => {
    lodgingsAnswer = 'empty';
    const before = served.length;
    const result = await refresh(OTHER_CITY);
    expect(served.slice(before).map((call) => call.kind)).toEqual(['lodgings']);
    expect(result).toEqual({
      event: 'place_refresh',
      cityId: OTHER_CITY,
      places: { inserted: 0, updated: 0, skipped: 0 },
      lodgings: { inserted: 0, updated: 0, unchanged: 0, missing: 0, returned: 0, skipped: 0 },
      menuJobs: 0,
      callTasks: 0,
    });
    // An empty answer is a data-source fault, not mass closure: the city's place is left as it stands (AAP 0.5.2).
    expect((await place('node/910010')).name).toBe('Fixture Bar Sem Site');
  });
});
