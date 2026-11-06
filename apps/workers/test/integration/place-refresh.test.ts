/**
 * Integration tests for `apps/workers/src/jobs/place-refresh.ts` (AAP 0.3.3, 0.5.2, 0.5.6, 0.5.7).
 *
 * The suite runs against a real PostgreSQL 16 with PostGIS 3.4 started from the shipped image and
 * migrated with `packages/db/prisma/migrations/20261104000000_init/migration.sql`, so what it proves
 * is the effect of the job's own statements — the geography columns, the fixture guard, the unique
 * `(osm_type, osm_id)` key and the partial statements of the lodging upsert — on the schema the run
 * delivers. Overpass is played by a local HTTP server that answers the recorded fixtures
 * (`test/fixtures/overpass/*.json`) and records every request, so the suite proves which queries were
 * built and which identifying user agent they carried without reaching the public instance, which the
 * validation host cannot reach at all. Time comes from `createTestClock`, so every freshness window and
 * the `osmMissingAt` instant are decided by one frozen instant.
 *
 * The cases, in order:
 *
 *   1. `process` refuses a job name the `place-refresh` queue does not accept and data that is not
 *      `{ cityId }`, and reports a city the database does not hold without calling Overpass.
 *   2. A first refresh inserts the city's places and lodgings from the two recorded answers, writes
 *      their locations, maps every OSM field, skips the two elements that cannot become places, and
 *      leaves a place owned by another city its own city.
 *   3. The price work follows the freshness rules: a place with a link and no fresh approved online
 *      price is queued once, a place whose only online record is unapproved is queued, and the phone
 *      fallback is opened for the places with no link and no usable price of any source — and for no
 *      other place.
 *   4. A second refresh, over the changed lodging answer, preserves an operator phone, `doNotCall`, a
 *      fixture flag, a console secret and a manually entered row; marks the lodging OSM stopped
 *      listing; clears the mark on the one that returned; and rewrites nothing of a place but what
 *      OSM reports.
 *   5. The same answers again write the same rows and queue no second job and no second call task.
 *   6. A city with no active partner venue and no lodging holding a console secret runs the lodgings
 *      query alone.
 *
 * @see AAP 0.5.6 for the ingestion rules and the job's own exceptions, 0.5.2 for the fixture policy
 *   and the models, 0.5.7 for the priority bands and the freshness windows, 0.11.2 for the integration
 *   layer running against real PostgreSQL, and 0.8.1 for the file under test.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaClient, readPoints, setPoint, type DbClient } from '@tablemate/db';
import {
  QUEUE,
  type QueueName,
  QueuePayloadError,
  createLogger,
  createTestClock,
  loadWorkersEnv,
} from '@tablemate/server-core';
import { DAY_MS } from '@tablemate/shared';

import { process } from '../../src/jobs/place-refresh.ts';

// Type-only, and narrowed below: the job's own `process` reads the environment, the clock, the logger,
// the guarded client and the producers, and no other member of a worker context, so the suite builds
// those five and nothing else. `queues.ts` is another lane's file, still unwritten, and a type-only
// import of it is erased on emit and at runtime.
import type { WorkerContext } from '../../src/queues.ts';

/**
 * The part of a worker context this job touches (AAP 0.5.6): the environment it validates at start,
 * the injected clock, the logger, the guarded database client and the queue producers it adds to.
 */
type PlaceRefreshContext = Pick<WorkerContext, 'env' | 'clock' | 'logger' | 'db' | 'queues'>;

/** The instant every relative date below is measured from, and the clock's starting point. */
const START = new Date('2026-11-04T12:00:00.000Z');

/** `START` moved back by `days`, so one instant describes every price age (AAP 0.5.7). */
const daysBefore = (days: number): Date => new Date(START.getTime() - days * DAY_MS);

// The rows this suite seeds are named, and the names are the assertions' vocabulary. The ids are plain
// uuids rather than generated ones, so a failing assertion names the row it meant.
const CITY = 'lisbon';
const OTHER_CITY = 'cascais';
const VENUE = 'aaaaaaaa-0000-4000-8000-000000000001';
const PARTNER_LODGING = 'aaaaaaaa-0000-4000-8000-000000000002';
const MANUAL_LODGING = 'aaaaaaaa-0000-4000-8000-000000000003';
const RETURNING_LODGING = 'aaaaaaaa-0000-4000-8000-000000000004';
const PLACE_NODE_910001 = 'bbbbbbbb-0000-4000-8000-000000000001';
const PLACE_NODE_910003 = 'bbbbbbbb-0000-4000-8000-000000000002';
const PLACE_NODE_910004 = 'bbbbbbbb-0000-4000-8000-000000000003';
const PLACE_NODE_910006 = 'bbbbbbbb-0000-4000-8000-000000000004';
const PLACE_NODE_910010 = 'bbbbbbbb-0000-4000-8000-000000000005';
const BATCH_ONLINE = 'cccccccc-0000-4000-8000-000000000001';
const BATCH_UNREVIEWED = 'cccccccc-0000-4000-8000-000000000002';
const BATCH_PHONE = 'cccccccc-0000-4000-8000-000000000003';
const BATCH_STALE = 'cccccccc-0000-4000-8000-000000000004';

/** Where the venue stands, in Lisbon's bbox: the centre the places query runs around (AAP 0.5.6). */
const VENUE_POINT = { lat: 38.711, lng: -9.14 };

/** The two elements of the places fixture that cannot become a place: no name, and a bank (AAP 0.5.6). */
const SKIPPED_OSM_IDS = [910014, 910015];

/**
 * The places the price work must reach, by their fixture id: the four with a website or a menu link
 * minus the one whose approved online record is fresh, and the ten without a link minus the one whose
 * approved phone quote is fresh.
 */
const MENU_PLACES = [910002, 910004, 910011];
const FALLBACK_PLACES = [910005, 910006, 910007, 910008, 910009, 910010, 910012, 910013, 920001];

/** One Overpass request the fixture server answered (AAP 0.3.3, 0.5.6). */
interface ServedCall {
  readonly kind: 'places' | 'lodgings';
  readonly userAgent: string | undefined;
  readonly query: string;
}

/** The lodging answer the fixture server gives for the run in progress. */
type LodgingsAnswer = 'first' | 'refresh' | 'empty';

/** One `ingest` job the fake producer accepted, as `enqueueMenuIngest` added it (AAP 0.5.6, 0.5.7). */
interface RecordedJob {
  readonly placeId: string;
  readonly jobId: string;
  readonly priority: number;
}

/**
 * The `menu-ingest` producer the context carries (AAP 0.5.6), standing in for BullMQ.
 *
 * It reproduces the one property this job's idempotency rests on: a custom job id that is still
 * retained suppresses a second `add`, so a second refresh over the same answer queues nothing. It
 * records what it accepted, which is what the assertions read.
 */
class FakeMenuQueue {
  /** Every job this producer accepted, in order. */
  readonly accepted: RecordedJob[] = [];

  /** The ids BullMQ would still hold: waiting, delayed or retained. */
  private readonly retained = new Set<string>();

  /**
   * Accepts the jobs whose id is new.
   *
   * @param jobs - The jobs `enqueueMenuIngest` built, each with its `jobId` and `priority`.
   * @returns The jobs accepted, which is what `addBulk` reports as added.
   */
  addBulk(
    jobs: readonly {
      readonly data: { readonly placeId: string };
      readonly opts?: { readonly jobId?: string; readonly priority?: number };
    }[],
  ): Promise<unknown[]> {
    const added: unknown[] = [];

    for (const job of jobs) {
      const jobId = job.opts?.jobId ?? '';

      if (this.retained.has(jobId)) {
        continue;
      }

      this.retained.add(jobId);
      this.accepted.push({
        placeId: job.data.placeId,
        jobId,
        priority: job.opts?.priority ?? 0,
      });
      added.push(job);
    }

    return Promise.resolve(added);
  }
}

/**
 * The producer registry a `WorkerContext` reaches its queues through (AAP 0.5.6, 0.8.1).
 *
 * It extends `Map`, so the fake producer registers exactly as `queues.ts` registers a real one — one
 * entry per queue name — and it narrows `get`, which is what makes it a `WorkerContext['queues']` at
 * all: `Map.get` is declared `Queue | undefined`, so a plain map answers `undefined` for every name
 * and is not assignable to the `{ get(name: QueueName): Queue }` a worker context provides. A name
 * that was never registered throws rather than answering `undefined`, which is the rule the jobs
 * themselves follow: `menu-ingest.ts` treats a missing producer as a configuration fault, because a
 * worker that quietly found no queue would send every place of a city to a paid phone call.
 */
class FakeQueueRegistry extends Map<QueueName, Queue> {
  /**
   * The producer registered under `name`.
   *
   * @param name - The queue name a job asks for.
   * @returns The producer registered for that queue.
   * @throws Error naming the queue when no producer is registered for it.
   */
  override get(name: QueueName): Queue {
    const queue = super.get(name);

    if (queue === undefined) {
      throw new Error(`no producer registered for the queue "${name}"`);
    }

    return queue;
  }
}

/**
 * The environment the `workers` process validates at start (AAP 0.6.2). Every value is a placeholder
 * that matches no credential shape, and the telephony and language-model modes reach no provider.
 */
function environment(databaseUrl: string, overpassUrl: string): Record<string, string> {
  return {
    APP_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: 'redis://127.0.0.1:6379/0',
    FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    FIELD_ENCRYPTION_KEY_ID: 'k1',
    ANALYTICS_SALT: 'test-analytics-salt-0123456789abcdef',
    TELEPHONY_MODE: 'off',
    LLM_PROVIDER: 'fake',
    SMTP_URL: 'smtp://127.0.0.1:1025',
    EMAIL_FROM: 'Tablemate <no-reply@tablemate.test>',
    CRAWLER_CONTACT_URL: 'https://tablemate.test/crawler',
    API_PUBLIC_URL: 'http://127.0.0.1:21440',
    WEB_ORIGIN: 'http://127.0.0.1:21441',
    OVERPASS_URL: overpassUrl,
  };
}

let container: Awaited<ReturnType<PostgreSqlContainer['start']>> | undefined;
let server: Server | undefined;
let db: DbClient;
let clock: ReturnType<typeof createTestClock>;
let ctx: PlaceRefreshContext;
let menuQueue: FakeMenuQueue;
let stop: (() => Promise<void>) | undefined;
const logs: Record<string, unknown>[] = [];
const served: ServedCall[] = [];
let lodgingsAnswer: LodgingsAnswer = 'first';
let placesFixture: unknown;
let lodgingsFixture: unknown;
let lodgingsRefreshFixture: unknown;

/** The migration and the fixtures, found by walking up so the compiled copy of this file reads them. */
const MIGRATION = findRepoFile('packages/db/prisma/migrations/20261104000000_init/migration.sql');
const PLACES_FIXTURE = findRepoFile('apps/workers/test/fixtures/overpass/lisbon-places.json');
const LODGINGS_FIXTURE = findRepoFile('apps/workers/test/fixtures/overpass/lisbon-lodgings.json');
const LODGINGS_REFRESH_FIXTURE = findRepoFile(
  'apps/workers/test/fixtures/overpass/lisbon-lodgings-refresh.json',
);

/**
 * The nearest ancestor of this module's directory that holds `relativePath`, so the source and the
 * compiled copy of this file read the same file.
 *
 * @param relativePath - The repository-relative path to find.
 * @returns The absolute path.
 * @throws Error naming the directory the search started from when no ancestor holds it.
 */
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

/** The recorded answer a request is served from, decided by the query the caller built. */
function answerFor(query: string): { kind: ServedCall['kind']; body: unknown } {
  if (!query.includes('hostel|hotel|guest_house')) {
    return { kind: 'places', body: placesFixture };
  }

  if (lodgingsAnswer === 'first') {
    return { kind: 'lodgings', body: lodgingsFixture };
  }

  return {
    kind: 'lodgings',
    body: lodgingsAnswer === 'refresh' ? lodgingsRefreshFixture : empty(),
  };
}

/** An Overpass answer with no elements: a listing that survived nothing (AAP 0.5.6). */
function empty(): unknown {
  return { version: 0.6, generator: 'Overpass API (fixture)', elements: [] };
}

/**
 * Starts the server that plays Overpass (AAP 0.3.3).
 *
 * It answers the form-encoded `data` field the client posts, records the query and the user agent,
 * and returns the fixture the current mode selects.
 *
 * @returns The base URL the workers environment is given.
 */
async function startFixtureServer(): Promise<string> {
  const created = createServer((request, response) => {
    let body = '';

    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });

    request.on('end', () => {
      const query = new URLSearchParams(body).get('data') ?? '';
      const { kind, body: answer } = answerFor(query);

      served.push({ kind, userAgent: request.headers['user-agent'], query });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer));
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

/** The id of a place by its OSM key, so an assertion names the element it means. */
async function placeIdFor(osmType: string, osmId: number): Promise<string> {
  const row = await db.place.findFirst({
    where: { osmType, osmId: BigInt(osmId) },
    select: { id: true },
  });

  if (row === null) {
    throw new Error(`no place row for ${osmType}/${osmId}`);
  }

  return row.id;
}

/** The ids of the `menu_prices` tasks currently open, for the fallback assertions. */
async function openMenuTaskPlaceIds(): Promise<string[]> {
  const rows = await db.$queryRaw<{ placeId: string }[]>`
    SELECT "place_id"::text AS "placeId" FROM "call_task" WHERE "kind" = 'menu_prices'
  `;

  return rows.map((row) => row.placeId);
}

/** The place row a fixture element is stored as, for the field-level assertions. */
async function placeRow(osmId: number): Promise<{
  id: string;
  cityId: string;
  name: string;
  category: string;
  phone: string | null;
  website: string | null;
  menuUrl: string | null;
  openingHours: string | null;
  doNotCall: boolean;
  isFixture: boolean;
  nearestPartnerDistanceM: number | null;
}> {
  return await db.place.findFirstOrThrow({
    where: { osmId: BigInt(osmId) },
    select: {
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
    },
  });
}

/** The lodging row a fixture element is stored as. */
async function lodgingRow(osmId: number): Promise<{
  id: string;
  name: string;
  kind: string;
  address: string | null;
  phone: string | null;
  phoneSource: string;
  doNotCall: boolean;
  isFixture: boolean;
  osmMissingAt: Date | null;
  secretLookupHash: string | null;
  secretCiphertext: string | null;
  secretIssuedAt: Date | null;
}> {
  return await db.lodging.findFirstOrThrow({
    where: { osmId: BigInt(osmId) },
    select: {
      id: true,
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
    },
  });
}

/** Runs one `refresh` job for `cityId` (AAP 0.5.6). */
async function refresh(cityId: string): Promise<unknown> {
  return await process({ name: 'refresh', data: { cityId } }, ctx as WorkerContext);
}

/**
 * Seeds the two cities, the centres, the rows the assertions are about and the price records that
 * decide the price work (AAP 0.5.2, 0.5.6, 0.5.7).
 *
 * The five place rows created here have deliberately stale fields: the refresh is meant to write the
 * OSM values over them, and the one owned by {@link OTHER_CITY} is the row that proves `cityId` is
 * never written back.
 */
async function seed(): Promise<void> {
  await db.city.create({
    data: {
      id: CITY,
      circuitCityId: 1,
      name: 'Lisbon',
      countryCode: 'PT',
      timezone: 'Europe/Lisbon',
      callLanguage: 'pt-PT',
      currency: 'EUR',
      bbox: { south: 38.69, west: -9.23, north: 38.78, east: -9.1 },
    },
  });
  await db.city.create({
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

  await db.venue.create({
    data: {
      id: VENUE,
      cityId: CITY,
      name: 'Fixture Venue Baixa',
      address: 'Rua da Fixture 1',
      isActivePartner: true,
      isFixture: true,
    },
  });
  await setPoint(db, 'venue', VENUE, VENUE_POINT);

  await db.lodging.create({
    data: {
      id: PARTNER_LODGING,
      cityId: CITY,
      name: 'Fixture Partner Lodging',
      kind: 'hostel',
      phone: '+14155550010',
      phoneSource: 'operator',
      isFixture: true,
      secretLookupHash: 'partner-secret-lookup',
      secretCiphertext: 'partner-secret-ciphertext',
      secretIssuedAt: START,
    },
  });
  await setPoint(db, 'lodging', PARTNER_LODGING, { lat: 38.712, lng: -9.138 });

  // A manually entered lodging: no OSM key, so no refresh may touch it (AAP 0.5.6).
  await db.lodging.create({
    data: {
      id: MANUAL_LODGING,
      cityId: CITY,
      name: 'Fixture Manual Lodge',
      kind: 'hotel',
      phone: '+14155550020',
      phoneSource: 'operator',
      doNotCall: true,
      isFixture: true,
      secretLookupHash: 'manual-secret-lookup',
      secretCiphertext: 'manual-secret-ciphertext',
      secretIssuedAt: START,
    },
  });
  await setPoint(db, 'lodging', MANUAL_LODGING, { lat: 38.713, lng: -9.139 });

  // A row OSM dropped earlier, which the refresh answer of the second run lists again (AAP 0.5.6).
  await db.lodging.create({
    data: {
      id: RETURNING_LODGING,
      cityId: CITY,
      osmType: 'node',
      osmId: 930007n,
      name: 'Fixture Guest House Regresso',
      kind: 'guesthouse',
      osmMissingAt: daysBefore(3),
    },
  });
  await setPoint(db, 'lodging', RETURNING_LODGING, { lat: 38.7087, lng: -9.1483 });

  const stalePlaces = [
    { id: PLACE_NODE_910001, osmId: 910001n, cityId: CITY, name: 'Fixture Stale Tasca' },
    { id: PLACE_NODE_910003, osmId: 910003n, cityId: CITY, name: 'Fixture Stale Sem Telefone' },
    { id: PLACE_NODE_910004, osmId: 910004n, cityId: CITY, name: 'Fixture Stale Marisqueira' },
    { id: PLACE_NODE_910006, osmId: 910006n, cityId: CITY, name: 'Fixture Stale Pastelaria' },
    { id: PLACE_NODE_910010, osmId: 910010n, cityId: OTHER_CITY, name: 'Fixture Stale Bar' },
  ];

  for (const place of stalePlaces) {
    await db.place.create({
      data: {
        id: place.id,
        osmType: 'node',
        osmId: place.osmId,
        cityId: place.cityId,
        name: place.name,
        category: 'bar',
        openingHours: 'Mo-Su 08:00-22:00',
      },
    });
    await setPoint(db, 'place', place.id, { lat: 38.7005, lng: -9.1505 });
  }

  const price = (input: {
    placeId: string;
    captureBatchId: string;
    source: 'online_menu' | 'phone_quote';
    reviewStatus: 'approved' | 'needs_review';
    days: number;
    itemCategory: 'main' | 'drink';
  }) => ({
    placeId: input.placeId,
    captureBatchId: input.captureBatchId,
    itemName: input.itemCategory === 'main' ? 'Prato do dia' : 'Café',
    normalizedName: input.itemCategory === 'main' ? 'prato do dia' : 'cafe',
    itemCategory: input.itemCategory,
    priceText: input.itemCategory === 'main' ? '12,50 €' : '1,20 €',
    localAmountMinor: input.itemCategory === 'main' ? 1250 : 120,
    currency: 'EUR',
    priceUsdCents: input.itemCategory === 'main' ? 1350 : 130,
    source: input.source,
    sourceUrl:
      input.source === 'online_menu'
        ? 'https://tasca.lisbon.fixture.test/menu'
        : 'tel:+14155550050',
    capturedAt: daysBefore(input.days),
    fxDate: daysBefore(input.days),
    reviewStatus: input.reviewStatus,
  });

  await db.priceRecord.create({
    data: price({
      placeId: PLACE_NODE_910001,
      captureBatchId: BATCH_ONLINE,
      source: 'online_menu',
      reviewStatus: 'approved',
      days: 5,
      itemCategory: 'main',
    }),
  });
  // Fresh, but an operator has not approved it: it is not a price `suggestions` may serve (AAP 0.5.7).
  await db.priceRecord.create({
    data: price({
      placeId: PLACE_NODE_910004,
      captureBatchId: BATCH_UNREVIEWED,
      source: 'online_menu',
      reviewStatus: 'needs_review',
      days: 2,
      itemCategory: 'main',
    }),
  });
  await db.priceRecord.create({
    data: price({
      placeId: PLACE_NODE_910003,
      captureBatchId: BATCH_PHONE,
      source: 'phone_quote',
      reviewStatus: 'approved',
      days: 5,
      itemCategory: 'drink',
    }),
  });
  // A phone quote past its 60-day window: stale, so the fallback is still warranted (AAP 0.5.7).
  await db.priceRecord.create({
    data: price({
      placeId: PLACE_NODE_910006,
      captureBatchId: BATCH_STALE,
      source: 'phone_quote',
      reviewStatus: 'approved',
      days: 70,
      itemCategory: 'drink',
    }),
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  const migration = await readFile(MIGRATION, 'utf8');
  const applied = await container.exec([
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'test',
    '-d',
    'test',
    '-c',
    migration,
  ]);

  if (applied.exitCode !== 0) {
    throw new Error(`the init migration failed: ${applied.stderr}`);
  }

  placesFixture = JSON.parse(await readFile(PLACES_FIXTURE, 'utf8')) as unknown;
  lodgingsFixture = JSON.parse(await readFile(LODGINGS_FIXTURE, 'utf8')) as unknown;
  lodgingsRefreshFixture = JSON.parse(await readFile(LODGINGS_REFRESH_FIXTURE, 'utf8')) as unknown;

  const databaseUrl = container.getConnectionUri();
  const overpassUrl = await startFixtureServer();

  db = createPrismaClient({ databaseUrl, appEnv: 'test' });
  clock = createTestClock({ start: START });
  menuQueue = new FakeMenuQueue();
  ctx = {
    env: loadWorkersEnv(environment(databaseUrl, overpassUrl)),
    clock,
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
    db,
    // The producer this job uses, standing in for BullMQ: the fake is not a `Queue` — the job under
    // test reads nothing of it but `addBulk` — so its entry is cast once into the registry's value
    // type. The remaining members of `WorkerContext` belong to the queue module another file owns, and
    // a job that does not read one is not given one.
    queues: new FakeQueueRegistry([[QUEUE.menuIngest, menuQueue as unknown as Queue]]),
  };

  await seed();

  stop = async () => {
    await db.$disconnect();

    if (server !== undefined) {
      const running = server;
      await new Promise<void>((resolve) => running.close(() => resolve()));
    }

    await container?.stop();
  };
}, 300_000);

afterAll(async () => {
  // A `beforeAll` that failed before assigning `stop` must report its own error, not a second one.
  if (stop) {
    await stop();
  }
});

describe('place-refresh', () => {
  it('refuses a job name this queue does not accept, and data that is not a city', async () => {
    await expect(
      process({ name: 'weekly', data: { cityId: CITY } }, ctx as WorkerContext),
    ).rejects.toBeInstanceOf(QueuePayloadError);
    await expect(
      process({ name: 'refresh', data: { city: CITY } }, ctx as WorkerContext),
    ).rejects.toBeInstanceOf(QueuePayloadError);
  });

  it('reports a city the database does not hold without calling Overpass', async () => {
    const before = served.length;
    const result = await refresh('nowhere');

    expect(result).toEqual({ skipped: 'unknown_city' });
    expect(served.length).toBe(before);
    expect(logs.map((line) => line['event'])).toContain('place_refresh_skipped');
  });

  it('ingests the city’s places and lodgings from the two recorded answers', async () => {
    const before = served.length;
    const result = await refresh(CITY);

    // The two queries run one after the other, and each identifies the crawler (AAP 0.3.3, 0.5.6).
    expect(served.slice(before).map((call) => call.kind)).toEqual(['places', 'lodgings']);
    expect(
      served
        .slice(before)
        .every((call) => call.userAgent === 'TablemateBot/1.0 (+https://tablemate.test/crawler)'),
    ).toBe(true);
    // The places query carries the venue and the secret-holding lodging as `around:2000` centres, and
    // the manual lodging contributes none; the lodgings query carries the city's bbox.
    const [placesCall, lodgingsCall] = served.slice(before);
    expect(placesCall?.query).toContain('around:2000,38.711000,-9.140000');
    expect(placesCall?.query).toContain('around:2000,38.712000,-9.138000');
    expect(lodgingsCall?.query).toContain('(38.690000,-9.230000,38.780000,-9.100000)');

    // Nine places had no row, five did (four of this city's and the one the other city owns), and the
    // two elements that cannot become a place are counted as skipped rather than failing the run.
    expect(result).toEqual({
      event: 'place_refresh',
      cityId: CITY,
      places: { inserted: 9, updated: 5, skipped: 2 },
      lodgings: { inserted: 8, updated: 0, unchanged: 0, missing: 0, returned: 0, skipped: 0 },
      menuJobs: 3,
      callTasks: 9,
    });

    for (const osmId of SKIPPED_OSM_IDS) {
      expect(await db.place.count({ where: { osmId: BigInt(osmId) } })).toBe(0);
    }

    // Every field of the element is mapped: the OSM name and category replace the stale ones, the
    // formatted phone becomes E.164, the tag URL is stored as it stands, and the raw hours survive.
    const tasca = await placeRow(910001);
    expect(tasca).toMatchObject({
      cityId: CITY,
      name: 'Fixture Tasca do Teste',
      category: 'restaurant',
      phone: '+14155550161',
      website: 'https://tasca.lisbon.fixture.test/',
      menuUrl: null,
      openingHours: 'Mo-Su 12:00-23:00',
      doNotCall: false,
      isFixture: false,
    });
    const tascaPoints = await readPoints(db, 'place', [tasca.id], 'test');
    expect(tascaPoints.get(tasca.id)?.lat).toBeCloseTo(38.7112, 6);
    expect(tascaPoints.get(tasca.id)?.lng).toBeCloseTo(-9.1405, 6);
    // Within the 250 m band of the only partner venue (AAP 0.5.7).
    expect(tasca.nearestPartnerDistanceM).toBeGreaterThan(0);
    expect(tasca.nearestPartnerDistanceM).toBeLessThanOrEqual(250);

    // A menu link is read from `website:menu`, a phone that is not E.164 is dropped, an unreadable
    // `opening_hours` is stored as NULL, and a way's location comes from its `center`.
    expect((await placeRow(910002)).menuUrl).toBe('https://cervejaria.lisbon.fixture.test/menu');
    expect((await placeRow(910003)).phone).toBeNull();
    expect((await placeRow(910005)).phone).toBe('+14155550164');
    expect((await placeRow(910007)).openingHours).toBeNull();
    const patio = await placeRow(920001);
    expect((await readPoints(db, 'place', [patio.id], 'test')).get(patio.id)?.lat).toBeCloseTo(
      38.7127,
      6,
    );

    // The row another city owns keeps its city, and its priority band is that city's business.
    const foreign = await placeRow(910010);
    expect(foreign.cityId).toBe(OTHER_CITY);
    expect(foreign.nearestPartnerDistanceM).toBeNull();

    // The lodgings answer fills the directory: kinds, addresses and the OSM phone.
    const baixa = await lodgingRow(930001);
    expect({
      name: baixa.name,
      kind: baixa.kind,
      address: baixa.address,
      phone: baixa.phone,
      phoneSource: baixa.phoneSource,
      isFixture: baixa.isFixture,
    }).toEqual({
      name: 'Fixture Hostel Baixa',
      kind: 'hostel',
      address: 'Rua da Fixture 40, 0000-002 Lisboa',
      phone: '+14155550180',
      phoneSource: 'osm',
      isFixture: false,
    });
    expect((await lodgingRow(930004)).kind).toBe('guesthouse');
    expect((await lodgingRow(940001)).phone).toBe('+14155550184');
    expect((await lodgingRow(950001)).kind).toBe('hotel');
    // A row OSM had dropped stays marked: this answer does not list it either.
    expect((await lodgingRow(930007)).osmMissingAt).toEqual(daysBefore(3));

    // The manually entered lodging is invisible to the refresh: no OSM key, so nothing selects it.
    const manual = await db.lodging.findUniqueOrThrow({ where: { id: MANUAL_LODGING } });
    expect({
      name: manual.name,
      phone: manual.phone,
      doNotCall: manual.doNotCall,
      secretLookupHash: manual.secretLookupHash,
      osmId: manual.osmId,
    }).toEqual({
      name: 'Fixture Manual Lodge',
      phone: '+14155550020',
      doNotCall: true,
      secretLookupHash: 'manual-secret-lookup',
      osmId: null,
    });

    // The price work: one ingestion job per place with a link and no fresh approved online price,
    // and one phone task per place with neither link nor usable price of any source (AAP 0.5.6).
    const menuPlaceIds = await Promise.all(MENU_PLACES.map((osmId) => placeIdFor('node', osmId)));
    const fallbackPlaceIds = await Promise.all(
      FALLBACK_PLACES.map((osmId) => placeIdFor(osmId === 920001 ? 'way' : 'node', osmId)),
    );
    expect(menuQueue.accepted.map((job) => job.placeId).sort()).toEqual(menuPlaceIds.sort());
    expect(menuQueue.accepted.every((job) => job.jobId.startsWith('menu-ingest-'))).toBe(true);
    expect((await openMenuTaskPlaceIds()).sort()).toEqual(fallbackPlaceIds.sort());
    // The suppression is the freshness rule and nothing else: the one place with an approved online
    // record inside 30 days and the one with an approved phone quote inside 60 days are absent.
    expect(menuQueue.accepted.map((job) => job.placeId)).not.toContain(
      await placeIdFor('node', 910001),
    );
    expect(await openMenuTaskPlaceIds()).not.toContain(await placeIdFor('node', 910003));

    // The log line carries the counts and nothing else: no fixture name, no phone, no address.
    const lines = logs.filter((line) => line['event'] === 'place_refresh');
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines[0])).not.toContain('Fixture');
    expect(JSON.stringify(lines[0])).not.toContain('1415555');
  });

  it('preserves operator and fixture state, marks what OSM dropped, and writes no second job', async () => {
    // Operator-owned state, written between the two runs: a phone an operator entered, a do-not-call
    // flag, a fixture flag and a console secret (AAP 0.5.6).
    await db.lodging.update({
      where: { osmType_osmId: { osmType: 'node', osmId: 930003n } },
      data: {
        phone: '+14155550099',
        phoneSource: 'operator',
        doNotCall: true,
        secretLookupHash: 'rossio-secret-lookup',
        secretCiphertext: 'rossio-secret-ciphertext',
        secretIssuedAt: START,
      },
    });
    await db.lodging.update({
      where: { osmType_osmId: { osmType: 'node', osmId: 930001n } },
      data: { isFixture: true, doNotCall: true },
    });
    await db.place.update({
      where: { osmType_osmId: { osmType: 'node', osmId: 910002n } },
      data: { name: 'Fixture Renamed Locally', doNotCall: true, isFixture: true },
    });

    const tasksBefore = (await openMenuTaskPlaceIds()).length;
    const jobsBefore = menuQueue.accepted.length;
    lodgingsAnswer = 'refresh';
    const result = await refresh(CITY);

    expect(result).toMatchObject({
      event: 'place_refresh',
      cityId: CITY,
      // Every place already has its row, so the write is an update; the two unplaceable elements stay
      // skipped. The lodging answer changed one row, moved one phone, listed a new one, listed a
      // dropped one again and stopped listing another.
      places: { inserted: 0, updated: 14, skipped: 2 },
      lodgings: { inserted: 1, updated: 3, unchanged: 5, missing: 1, returned: 1, skipped: 0 },
      menuJobs: 0,
      callTasks: 0,
    });

    // The operator's phone survived the OSM edit, and so did the flag and the secret.
    const rossio = await lodgingRow(930003);
    expect({
      phone: rossio.phone,
      phoneSource: rossio.phoneSource,
      doNotCall: rossio.doNotCall,
      secretLookupHash: rossio.secretLookupHash,
      secretCiphertext: rossio.secretCiphertext,
      secretIssuedAt: rossio.secretIssuedAt,
    }).toEqual({
      phone: '+14155550099',
      phoneSource: 'operator',
      doNotCall: true,
      secretLookupHash: 'rossio-secret-lookup',
      secretCiphertext: 'rossio-secret-ciphertext',
      secretIssuedAt: START,
    });
    // An OSM-owned phone follows OSM, and the rename is written.
    expect((await lodgingRow(930004)).phone).toBe('+14155550191');
    expect((await lodgingRow(930002)).name).toBe('Fixture Hostel Chiado Novo');
    // The fixture flags of an OSM-keyed row are operator state too, and the refresh keeps them.
    const baixa = await lodgingRow(930001);
    expect({ isFixture: baixa.isFixture, doNotCall: baixa.doNotCall }).toEqual({
      isFixture: true,
      doNotCall: true,
    });

    // The dropped lodging keeps its row — and therefore its id, its claims and its activity facts —
    // and the one that came back loses its mark.
    const dropped = await lodgingRow(930005);
    expect(dropped.id).toBeTruthy();
    expect(dropped.osmMissingAt).not.toBeNull();
    expect((await lodgingRow(930007)).osmMissingAt).toBeNull();
    expect((await lodgingRow(930006)).name).toBe('Fixture Hostel Novo');

    // A place is rewritten from OSM alone: the name comes back, the operator's flags stay.
    expect(await placeRow(910002)).toMatchObject({
      cityId: CITY,
      name: 'Fixture Cervejaria',
      category: 'restaurant',
      phone: '+14155550163',
      website: null,
      menuUrl: 'https://cervejaria.lisbon.fixture.test/menu',
      openingHours: 'Mo-Su 12:00-23:00',
      doNotCall: true,
      isFixture: true,
    });

    // The same answer queues no second ingestion job, and every fallback task was already open.
    expect(menuQueue.accepted).toHaveLength(jobsBefore);
    expect(await openMenuTaskPlaceIds()).toHaveLength(tasksBefore);
  });

  it('runs the lodgings query alone for a city with no partner venue or lodging', async () => {
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
    // Nothing was written for the city's own place, which the empty answer does not list.
    expect((await placeRow(910010)).cityId).toBe(OTHER_CITY);
  });
});
