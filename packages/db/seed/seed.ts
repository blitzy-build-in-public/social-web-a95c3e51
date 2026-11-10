import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appEnvOrNull,
  createLogger,
  keyringFromEnv,
  loadSeedEnv,
  sanitizeLogMessage,
  systemClock,
} from '@tablemate/server-core';
import type { Clock, FieldKeyring, Logger } from '@tablemate/server-core';
import type {
  AppEnv,
  CityConfig,
  CityFixturesFile,
  FixturePriceItem,
  PlaceFixture,
  PriceSource,
} from '@tablemate/shared';

import {
  assertFixturesAllowed,
  createPrismaClient,
  fixturesAllowed,
  Prisma,
  refreshNearestPartnerDistances,
  setPoint,
} from '../src/index.ts';
import type { DbClient, DbTx } from '../src/index.ts';
import { findRepoRoot, loadCitiesConfig, loadCityFixtures } from './load-config.ts';
import {
  FIXTURE_SECRETS_RELATIVE_PATH,
  issueFixtureSecrets,
  readFixtureSecrets,
  writeFixtureSecrets,
} from './secrets-out.ts';
import type { FixtureSecretTarget, FixtureSecretsFile } from './secrets-out.ts';
const SERVICE_NAME = 'seed';
const FAILURE_LINE_APP_ENV: AppEnv = 'demo';
const ID_PREFIX = 'fixture';
const ID_BYTES = 16;
const USAGE = 'usage: pnpm db:seed [--fixtures | --no-fixtures]';
const FIXTURE_TRANSACTION_TIMEOUT_MS = 60_000;
const FIXTURE_TRANSACTION_MAX_WAIT_MS = 10_000;
const FIXTURE_HOST_REASON = 'fixture_host';
const SEED_OVERRIDE = 'seed';
/** A stable fixture id: the first 128 bits of `SHA-256("fixture:<kind>:<cityId>:<key>")`, as a version 8 UUID with the RFC 9562 variant. */
export function fixtureUuid(kind: string, cityId: string, key: string): string {
  const digest = createHash('sha256')
    .update(`${ID_PREFIX}:${kind}:${cityId}:${key}`, 'utf8')
    .digest();
  const bytes = Buffer.from(digest.subarray(0, ID_BYTES));
  // RFC 9562 §4.2 sets the version into the top nibble of byte 6, §4.1 the variant into the top two bits of byte 8. `readUInt8`/`writeUInt8` rather than indexing, so the byte offsets are checked.
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x80, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
/** What {@link runSeed} needs. */
export interface SeedOptions {
  /** The guarded client from `createPrismaClient`, which is the only way to build one. The call site owns its lifecycle and calls `$connect` and `$disconnect`. */
  db: DbClient;
  /** The process's `APP_ENV`. It must be the value the client was built with: it decides whether the fixtures are permitted here and is the predicate `refreshNearestPartnerDistances` guards with. */
  appEnv: AppEnv;
  /** The keyring the console secrets are encrypted under, from `keyringFromEnv`. */
  keyring: FieldKeyring;
  /** The run's time source for `capturedAt`, `fxDate`, `secretIssuedAt` and the secret file's `generatedAt`; defaults to `systemClock`, and tests pass a `TestClock` so records carry a fixed instant. */
  clock?: Clock;
  /** Whether to load `config/fixtures/<cityId>.json`. Defaults to `fixturesAllowed(appEnv)`; passing `true` outside `test` and `demo` is refused before anything is written. */
  fixtures?: boolean;
  /** The repository root the configuration is read from; defaults to `findRepoRoot()`. */
  repoRoot?: string;
  /** Where the fixture console secrets are written, defaulting to `<repoRoot>/.local/fixture-secrets.json`, which the root `.gitignore` excludes; `null` writes no file. */
  secretsOutPath?: string | null;
  /** Hosts to record as allowed besides the ones the fixture places' own URLs name — a worker test's local menu server, for instance. Each entry is a URL or a bare `host[:port]`. */
  allowedFixtureHosts?: readonly string[];
  /** Where the one completion line is written; omitted, the seed logs nothing. */
  logger?: Pick<Logger, 'info' | 'warn'>;
}
/** What {@link runSeed} loaded, for the CLI's log line and for what a test asserts. */
export interface SeedSummary {
  /** Cities written, and so the length of `config/cities.json`. */
  cities: number;
  /** Fixture venues written across every city, zero when fixtures were not loaded. */
  venues: number;
  /** Fixture lodgings written across every city. */
  lodgings: number;
  /** Fixture places written across every city. */
  places: number;
  /** Fixture price records written across every city. */
  priceRecords: number;
  /** Crawl-domain rows the seed recorded as allowed. */
  crawlDomains: number;
  /** Every fixture console secret of this run, keyed by row, or `null` when fixtures were not loaded. A test opens each console with these; the file on disk holds the same values. */
  secrets: FixtureSecretsFile | null;
  /** The file {@link SeedSummary.secrets} was written to, or `null` when none was written. */
  secretsFile: string | null;
}
type CityFixtureCounts = {
  /** The rows written, for the run's totals. */
  readonly venues: number;
  readonly lodgings: number;
  readonly places: number;
  readonly priceRecords: number;
  /** The crawl-domain keys the city's place URLs name (AAP 0.5.6). */
  readonly hosts: readonly string[];
  /** The venue and lodging rows whose console secret the run issues next (AAP 0.5.2). */
  readonly venueTargets: readonly FixtureSecretTarget[];
  readonly lodgingTargets: readonly FixtureSecretTarget[];
};
/** Seeds the cities and, when the environment permits it, each city's fixtures, crawl-domain decisions and console secrets (AAP 0.5.2, 0.6.2). */
export async function runSeed(options: SeedOptions): Promise<SeedSummary> {
  const clock = options.clock ?? systemClock;
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const fixtures = options.fixtures ?? fixturesAllowed(options.appEnv);
  if (fixtures) {
    assertFixturesAllowed(options.appEnv);
  }
  const cities = await loadCitiesConfig(repoRoot);
  await seedCities(options.db, cities);
  const files = new Map<string, CityFixturesFile>();
  if (fixtures) {
    for (const city of cities) {
      files.set(city.id, await loadCityFixtures(repoRoot, city.id));
    }
  }
  let venues = 0;
  let lodgings = 0;
  let places = 0;
  let priceRecords = 0;
  const hosts = new Set<string>();
  const venueTargets: FixtureSecretTarget[] = [];
  const lodgingTargets: FixtureSecretTarget[] = [];
  for (const city of cities) {
    const file = files.get(city.id);
    if (file === undefined) {
      continue;
    }
    // One capture instant per city, so a city's records share a `capturedAt` and a `fxDate` and the freshness windows of AAP 0.5.7 are measured from a time inside this run.
    const capturedAt = clock.now();
    const counts = await options.db.$transaction(
      (tx) => seedCityFixtures(tx, city.id, file, capturedAt, options.appEnv),
      { timeout: FIXTURE_TRANSACTION_TIMEOUT_MS, maxWait: FIXTURE_TRANSACTION_MAX_WAIT_MS },
    );
    venues += counts.venues;
    lodgings += counts.lodgings;
    places += counts.places;
    priceRecords += counts.priceRecords;
    for (const host of counts.hosts) {
      hosts.add(host);
    }
    venueTargets.push(...counts.venueTargets);
    lodgingTargets.push(...counts.lodgingTargets);
  }
  for (const host of options.allowedFixtureHosts ?? []) {
    hosts.add(hostKeyOf(host));
  }
  const crawlDomains = fixtures
    ? await recordCrawlPolicies(options.db, [...hosts], clock.now())
    : 0;
  let secrets: FixtureSecretsFile | null = null;
  let secretsFile: string | null = null;
  if (fixtures) {
    const file =
      options.secretsOutPath === undefined
        ? path.join(repoRoot, FIXTURE_SECRETS_RELATIVE_PATH)
        : options.secretsOutPath;
    const previous = file === null ? null : await readFixtureSecrets(file);
    const issued = await options.db.$transaction((tx) =>
      issueFixtureSecrets(tx, {
        keyring: options.keyring,
        clock,
        venues: venueTargets,
        lodgings: lodgingTargets,
        previous,
      }),
    );
    secrets = {
      appEnv: options.appEnv,
      generatedAt: clock.now().toISOString(),
      venues: issued.venues,
      lodgings: issued.lodgings,
    };
    if (file !== null) {
      await writeFixtureSecrets(file, secrets);
      secretsFile = file;
    }
  }
  // Counts and the file's path only: the secrets themselves never reach a log (AAP 0.12.2).
  options.logger?.info(
    { cities: cities.length, venues, lodgings, places, priceRecords, crawlDomains, secretsFile },
    'seed complete',
  );
  return {
    cities: cities.length,
    venues,
    lodgings,
    places,
    priceRecords,
    crawlDomains,
    secrets,
    secretsFile,
  };
}
async function seedCities(db: DbClient, cities: readonly CityConfig[]): Promise<void> {
  for (const city of cities) {
    const fields = {
      circuitCityId: city.circuitCityId,
      name: city.name,
      countryCode: city.countryCode,
      timezone: city.timezone,
      callLanguage: city.callLanguage,
      currency: city.currency,
      bbox: city.bbox,
    };
    await db.$transaction(async (tx) => {
      await tx.city.upsert({
        where: { id: city.id },
        create: { id: city.id, ...fields },
        update: fields,
      });
      await setPoint(tx, 'city', city.id, city.centroid);
    });
  }
}
async function seedCityFixtures(
  tx: DbTx,
  cityId: string,
  file: CityFixturesFile,
  capturedAt: Date,
  appEnv: AppEnv,
): Promise<CityFixtureCounts> {
  const hosts = new Set<string>();
  const venueTargets: FixtureSecretTarget[] = [];
  const lodgingTargets: FixtureSecretTarget[] = [];
  const venueRows = file.venues.map((venue) => ({
    id: fixtureUuid('venue', cityId, venue.key),
    venue,
  }));
  await writeFixtureRows(
    tx,
    venueRows.map(
      ({ id, venue }) =>
        Prisma.sql`(${id}::uuid, ${cityId}, ${venue.name}, ${venue.address}, true, true, ${capturedAt}::timestamptz, ${capturedAt}::timestamptz)`,
    ),
    (tuples) => Prisma.sql`
      INSERT INTO "venue"
        ("id", "city_id", "name", "address", "is_active_partner", "is_fixture", "created_at",
         "updated_at")
      VALUES ${tuples}
      ON CONFLICT ("id") DO UPDATE
         SET "name" = EXCLUDED."name", "address" = EXCLUDED."address",
             "updated_at" = EXCLUDED."updated_at"
    `,
  );
  for (const { id, venue } of venueRows) {
    await setPoint(tx, 'venue', id, { lat: venue.lat, lng: venue.lng });
    venueTargets.push({ id, cityId, name: venue.name });
  }
  const lodgingRows = file.lodgings.map((lodging) => ({
    id: fixtureUuid('lodging', cityId, lodging.key),
    lodging,
  }));
  await writeFixtureRows(
    tx,
    lodgingRows.map(
      ({ id, lodging }) =>
        Prisma.sql`(${id}::uuid, ${cityId}, ${lodging.name}, ${lodging.kind}::"lodging_kind", ${lodging.address}, ${lodging.phone}, 'operator'::"phone_source", true, ${capturedAt}::timestamptz, ${capturedAt}::timestamptz)`,
    ),
    (tuples) => Prisma.sql`
      INSERT INTO "lodging"
        ("id", "city_id", "name", "kind", "address", "phone", "phone_source", "is_fixture",
         "created_at", "updated_at")
      VALUES ${tuples}
      ON CONFLICT ("id") DO UPDATE
         SET "name" = EXCLUDED."name", "kind" = EXCLUDED."kind", "address" = EXCLUDED."address",
             "phone" = EXCLUDED."phone", "phone_source" = EXCLUDED."phone_source",
             "updated_at" = EXCLUDED."updated_at"
    `,
  );
  for (const { id, lodging } of lodgingRows) {
    await setPoint(tx, 'lodging', id, { lat: lodging.lat, lng: lodging.lng });
    lodgingTargets.push({ id, cityId, name: lodging.name });
  }
  const placeRows = file.places.map((place) => ({
    id: fixtureUuid('place', cityId, place.key),
    place,
  }));
  await writeFixtureRows(
    tx,
    placeRows.map(
      ({ id, place }) =>
        Prisma.sql`(${id}::uuid, ${cityId}, ${place.name}, ${place.category}::"place_category", ${place.website ?? null}, ${place.menuUrl ?? null}, ${place.phone ?? null}, ${place.openingHours}, true, ${capturedAt}::timestamptz, ${capturedAt}::timestamptz)`,
    ),
    (tuples) => Prisma.sql`
      INSERT INTO "place"
        ("id", "city_id", "name", "category", "website", "menu_url", "phone", "opening_hours",
         "is_fixture", "created_at", "updated_at")
      VALUES ${tuples}
      ON CONFLICT ("id") DO UPDATE
         SET "name" = EXCLUDED."name", "category" = EXCLUDED."category",
             "website" = EXCLUDED."website", "menu_url" = EXCLUDED."menu_url",
             "phone" = EXCLUDED."phone", "opening_hours" = EXCLUDED."opening_hours",
             "updated_at" = EXCLUDED."updated_at"
    `,
  );
  const priceTuples: Prisma.Sql[] = [];
  let priceRecords = 0;
  for (const { id: placeId, place } of placeRows) {
    await setPoint(tx, 'place', placeId, { lat: place.lat, lng: place.lng });
    for (const url of [place.website, place.menuUrl]) {
      if (url !== undefined) {
        hosts.add(hostKeyOf(url));
      }
    }
    const pricedIds: string[] = [];
    for (const [index, item] of place.items.entries()) {
      const row = priceRecordRow(placeId, { cityId, place, index, item, capturedAt });
      pricedIds.push(row.id);
      priceTuples.push(row.tuple);
    }
    // Items removed from a fixture file go, unlike the places above: a price record is configuration, and a stale one would enter an estimate the file no longer asks for (AAP 0.5.7).
    await tx.priceRecord.deleteMany({
      where: { placeId, isFixture: true, id: { notIn: pricedIds } },
    });
    priceRecords += pricedIds.length;
  }
  await writeFixtureRows(
    tx,
    priceTuples,
    (tuples) => Prisma.sql`
      INSERT INTO "price_record"
        ("id", "place_id", "capture_batch_id", "item_name", "normalized_name", "item_category",
         "alcoholic", "per_person", "ticket_type", "price_text", "local_amount_minor", "currency",
         "price_usd_cents", "source", "source_url", "captured_at", "fx_date", "confidence",
         "review_status", "is_fixture")
      VALUES ${tuples}
      ON CONFLICT ("id") DO UPDATE
         SET "capture_batch_id" = EXCLUDED."capture_batch_id", "item_name" = EXCLUDED."item_name",
             "normalized_name" = EXCLUDED."normalized_name",
             "item_category" = EXCLUDED."item_category", "alcoholic" = EXCLUDED."alcoholic",
             "per_person" = EXCLUDED."per_person", "ticket_type" = EXCLUDED."ticket_type",
             "price_text" = EXCLUDED."price_text",
             "local_amount_minor" = EXCLUDED."local_amount_minor",
             "currency" = EXCLUDED."currency", "price_usd_cents" = EXCLUDED."price_usd_cents",
             "source" = EXCLUDED."source", "source_url" = EXCLUDED."source_url",
             "captured_at" = EXCLUDED."captured_at", "fx_date" = EXCLUDED."fx_date",
             "confidence" = EXCLUDED."confidence", "review_status" = EXCLUDED."review_status"
    `,
  );
  await refreshNearestPartnerDistances(tx, cityId, appEnv);
  return {
    venues: file.venues.length,
    lodgings: file.lodgings.length,
    places: file.places.length,
    priceRecords,
    hosts: [...hosts],
    venueTargets,
    lodgingTargets,
  };
}
async function writeFixtureRows(
  tx: DbTx,
  rows: readonly Prisma.Sql[],
  statement: (tuples: Prisma.Sql) => Prisma.Sql,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await tx.$executeRaw(statement(Prisma.join(rows, ', ')));
}
function priceRecordRow(
  placeId: string,
  args: {
    readonly cityId: string;
    readonly place: PlaceFixture;
    readonly index: number;
    readonly item: FixturePriceItem;
    readonly capturedAt: Date;
  },
): { readonly id: string; readonly tuple: Prisma.Sql } {
  const { cityId, place, index, item, capturedAt } = args;
  const [itemName, itemCategory, priceUsdCents, source, options] = item;
  const id = fixtureUuid('price', cityId, `${place.key}:${index}`);
  const fields = {
    captureBatchId: fixtureUuid('batch', cityId, `${place.key}:${source}`),
    itemName,
    normalizedName: normalizeItemName(itemName),
    itemCategory,
    alcoholic: options?.alcoholic ?? null,
    perPerson: options?.perPerson ?? null,
    ticketType: options?.ticketType ?? null,
    priceText: priceTextOf(priceUsdCents),
    localAmountMinor: priceUsdCents,
    currency: 'USD',
    priceUsdCents,
    source,
    sourceUrl: sourceUrlOf(source, place, cityId),
    capturedAt,
    // The UTC day of the capture instant, whatever the connection's TimeZone setting is: `fxDate` is midnight UTC, and reading it back through UTC alone keeps the FX date off a neighbouring day.
    fxDate: utcDateOf(capturedAt),
    confidence: null,
    reviewStatus: 'approved',
  } as const;
  const tuple = Prisma.sql`(
    ${id}::uuid, ${placeId}::uuid, ${fields.captureBatchId}::uuid, ${fields.itemName},
    ${fields.normalizedName}, ${fields.itemCategory}::"item_category", ${fields.alcoholic},
    ${fields.perPerson}, ${fields.ticketType}::"ticket_type", ${fields.priceText},
    ${fields.localAmountMinor}, ${fields.currency}::char(3), ${fields.priceUsdCents},
    ${fields.source}::"price_source", ${fields.sourceUrl}, ${fields.capturedAt}::timestamptz,
    (${fields.fxDate}::timestamptz AT TIME ZONE 'UTC')::date,
    ${fields.confidence}::"confidence", ${fields.reviewStatus}::"review_status", true
  )`;
  return { id, tuple };
}
async function recordCrawlPolicies(
  db: DbClient,
  hosts: readonly string[],
  at: Date,
): Promise<number> {
  if (hosts.length === 0) {
    return 0;
  }
  const decisions = hosts.map((domain): CrawlPolicyRow => ({
    domain,
    decision: 'allowed',
    reason: FIXTURE_HOST_REASON,
    overriddenBy: SEED_OVERRIDE,
    checkedAt: at,
  }));
  await db.crawlDomainPolicy.createMany({ data: decisions, skipDuplicates: true });
  await db.crawlDomainPolicy.updateMany({
    where: {
      domain: { in: [...hosts] },
      OR: [{ overriddenBy: null }, { overriddenBy: SEED_OVERRIDE }],
    },
    data: {
      decision: 'allowed',
      reason: FIXTURE_HOST_REASON,
      overriddenBy: SEED_OVERRIDE,
      checkedAt: at,
    },
  });
  return hosts.length;
}
type CrawlPolicyRow = {
  readonly domain: string;
  readonly decision: 'allowed';
  readonly reason: string;
  readonly overriddenBy: string;
  readonly checkedAt: Date;
};
function hostKeyOf(value: string): string {
  const trimmed = value.trim();
  const host = trimmed.includes('://') ? new URL(trimmed).hostname : trimmed.replace(/:\d+$/, '');
  const key = host.toLowerCase().replace(/\.$/, '');
  return key.startsWith('www.') && key.slice('www.'.length).includes('.')
    ? key.slice('www.'.length)
    : key;
}
function sourceUrlOf(source: PriceSource, place: PlaceFixture, cityId: string): string {
  if (source === 'phone_quote' && place.phone !== undefined) {
    return `tel:${place.phone}`;
  }
  if (source === 'operator_entry') {
    return 'operator:seed';
  }
  return place.menuUrl ?? place.website ?? `https://fixtures.invalid/${cityId}/${place.key}`;
}
function priceTextOf(usdCents: number): string {
  const cents = usdCents % 100;
  return `$${Math.floor(usdCents / 100)}.${String(cents).padStart(2, '0')}`;
}
function normalizeItemName(itemName: string): string {
  return itemName.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}
function utcDateOf(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
async function runSeedCli(argv: readonly string[]): Promise<void> {
  let fixtures: boolean | undefined;
  for (const arg of argv) {
    if (arg === '--fixtures') {
      fixtures = true;
    } else if (arg === '--no-fixtures') {
      fixtures = false;
    } else {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
  }
  const env = loadSeedEnv();
  const logger = createLogger({ name: SERVICE_NAME, level: 'info', appEnv: env.APP_ENV });
  const db = createPrismaClient({ databaseUrl: env.DATABASE_URL, appEnv: env.APP_ENV });
  try {
    await runSeed({
      db,
      appEnv: env.APP_ENV,
      keyring: keyringFromEnv(env),
      logger,
      ...(fixtures === undefined ? {} : { fixtures }),
    });
  } finally {
    // No `process.exit` before this: the pool closes, and the process ends once it has.
    await db.$disconnect();
  }
}
function reportSeedFailure(error: unknown): void {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  /** `appEnvOrNull` reads `APP_ENV` through the env module's own normalization and schema rather than as a raw value, and it never throws: this line runs before `loadSeedEnv` has validated anything. */
  const logger = createLogger({
    name: SERVICE_NAME,
    level: 'info',
    appEnv: appEnvOrNull() ?? FAILURE_LINE_APP_ENV,
  });
  logger.error({ err: { name, message: sanitizeLogMessage(message) } }, 'seed failed');
  process.exitCode = 1;
}
function isSeedEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    // An entry path that cannot be resolved is not this module; the CLI has nothing to do.
    return false;
  }
}

if (isSeedEntryPoint()) {
  void runSeedCli(process.argv.slice(2)).catch((error: unknown) => {
    reportSeedFailure(error);
  });
}
// The secret file's locator and reader, re-exported with the seed, so a consumer of `@tablemate/db/seed` — a demo script, a system test — opens a console without a second import path (AAP 0.5.2).
export { FIXTURE_SECRETS_RELATIVE_PATH, readFixtureSecrets };
export type { FixtureSecretsFile };
