/**
 * The seed (AAP 0.5.2, 0.6.2): the launch cities of `config/cities.json`, the fixture venues,
 * lodgings and priced places of each city from `config/fixtures/<cityId>.json`, the crawl-domain
 * decisions the menu pipeline reads, and the console secret of every fixture venue and lodging.
 *
 * {@link runSeed} is the whole of it, so a test, the compose `migrate` service and `pnpm db:seed`
 * all seed the same way; the command line at the foot of this file is the thin CLI over it. Fixtures
 * are permitted only in `test` and `demo` (AAP 0.5.2): {@link assertFixturesAllowed} runs before the
 * first write, the cities included, so an environment that forbids them refuses the run having
 * stored nothing, and the fixture guard that `createPrismaClient` installs stands behind it.
 *
 * The run is idempotent, so it repeats on every `docker compose up`: every fixture row's id comes
 * from {@link fixtureUuid}, which makes a rerun update the row it made rather than add another, and
 * the console secrets are issued through `./secrets-out.ts`, which keeps a row's existing secret
 * unless it can no longer be read back.
 *
 * No city, venue, lodging, place or price is written here: they are the `config/` files, so the
 * pilot changes them by editing JSON and reseeding (AAP 0.7.3).
 *
 * @see AAP 0.5.2 for the fixture sets, their counts and the local secret file, 0.5.6 for the
 *   crawl-domain decisions and the priority distances, 0.6.2 for the seed's environment, 0.8.1 for
 *   this file's place in the inventory, and 0.12.1 criterion 9 for what the seed must yield.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger, keyringFromEnv, loadSeedEnv, systemClock } from '@tablemate/server-core';
import type { Clock, FieldKeyring, Logger } from '@tablemate/server-core';
import { AppEnv } from '@tablemate/shared';
import type {
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

/** The name every seed log line carries (AAP 0.6.2). */
const SERVICE_NAME = 'seed';

/** The text {@link fixtureUuid} hashes, so a fixture id cannot be read as a random one. */
const ID_PREFIX = 'fixture';

/** The digest bytes a fixture id keeps: the 128 bits a UUID holds. */
const ID_BYTES = 16;

/** The command line {@link runSeed}'s CLI accepts (AAP 0.6.2). */
const USAGE = 'usage: pnpm db:seed [--fixtures | --no-fixtures]';

/**
 * One city's fixture writes run in a single interactive transaction, whose default 5-second timeout
 * is too short for a full city: it holds 10 venues, 10 lodgings, 30 places and 150 price records,
 * each with a `setPoint` beside it.
 */
const FIXTURE_TRANSACTION_TIMEOUT_MS = 60_000;
const FIXTURE_TRANSACTION_MAX_WAIT_MS = 10_000;

/** What `CrawlDomainPolicy.reason` says of a domain the seed allowed (AAP 0.5.6). */
const FIXTURE_HOST_REASON = 'fixture_host';

/** What `CrawlDomainPolicy.overriddenBy` says of a decision the seed took. */
const SEED_OVERRIDE = 'seed';

/**
 * A stable fixture id (AAP 0.5.2): the first 128 bits of `SHA-256("fixture:<kind>:<cityId>:<key>")`,
 * as a version 8 UUID with the RFC 9562 variant.
 *
 * Fixtures carry no OpenStreetMap id, so this is what the seed matches an existing row by: the same
 * input always yields the same id, which is what lets a rerun upsert by primary key. Version 8 is the
 * RFC 9562 "custom" version, and `AppEnv`'s sibling schema `Uuid` accepts any well-formed version, so
 * the id is a valid UUID to every reader. The kind is part of the hash, so one key cannot name two
 * tables' rows.
 *
 * @param kind The fixture table or artefact: `venue`, `lodging`, `place`, `price` or `batch`.
 * @param cityId The city slug the row belongs to.
 * @param key The fixture key within the city, and for a price its place key and item index.
 * @returns A lowercase `8-4-4-4-12` UUID, stable across runs and processes.
 */
export function fixtureUuid(kind: string, cityId: string, key: string): string {
  const digest = createHash('sha256')
    .update(`${ID_PREFIX}:${kind}:${cityId}:${key}`, 'utf8')
    .digest();
  const bytes = Buffer.from(digest.subarray(0, ID_BYTES));

  // RFC 9562 §4.2 sets the version into the top nibble of byte 6, §4.1 the variant into the top two
  // bits of byte 8. `readUInt8`/`writeUInt8` rather than indexing, so the byte offsets are checked.
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

/**
 * What {@link runSeed} needs (AAP 0.5.2, 0.6.2).
 */
export interface SeedOptions {
  /**
   * The guarded client from `createPrismaClient`, which is the only way to build one. The call site
   * owns its lifecycle and calls `$connect` and `$disconnect`.
   */
  db: DbClient;
  /**
   * The process's `APP_ENV`. It must be the value the client was built with: it decides whether the
   * fixtures are permitted here, it is the predicate `refreshNearestPartnerDistances` guards with,
   * and it is what a {@link SeedSummary} and the local secret file record.
   */
  appEnv: AppEnv;
  /** The keyring the console secrets are encrypted under, from `keyringFromEnv`. */
  keyring: FieldKeyring;
  /**
   * The run's time source for `capturedAt`, `fxDate`, `secretIssuedAt` and the secret file's
   * `generatedAt`; defaults to `systemClock`. Tests pass a `TestClock` so records are stamped with
   * the instant the freshness windows are then measured from (AAP 0.11.1).
   */
  clock?: Clock;
  /**
   * Whether to load `config/fixtures/<cityId>.json`. Defaults to `fixturesAllowed(appEnv)`; passing
   * `true` outside `test` and `demo` is refused before anything is written (AAP 0.5.2).
   */
  fixtures?: boolean;
  /** The repository root the configuration is read from; defaults to `findRepoRoot()`. */
  repoRoot?: string;
  /**
   * Where the fixture console secrets are written. Defaults to
   * `<repoRoot>/.local/fixture-secrets.json`, which the root `.gitignore` excludes; `null` writes no
   * file, which is what a test wants when it reads the secrets off the {@link SeedSummary} alone.
   */
  secretsOutPath?: string | null;
  /**
   * Hosts to record as allowed besides the ones the fixture places' own URLs name — a worker test's
   * local menu server, for instance. Each entry is a URL or a bare `host[:port]` (AAP 0.5.6).
   */
  allowedFixtureHosts?: readonly string[];
  /** Where the one completion line is written; omitted, the seed logs nothing. */
  logger?: Pick<Logger, 'info' | 'warn'>;
}

/**
 * What {@link runSeed} loaded, for the CLI's log line and for what a test asserts (AAP 0.5.2,
 * 0.12.1 criterion 9).
 */
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
  /**
   * Every fixture console secret of this run, keyed by row, or `null` when fixtures were not
   * loaded. A test opens each console with these; the file on disk holds the same values.
   */
  secrets: FixtureSecretsFile | null;
  /** The file {@link SeedSummary.secrets} was written to, or `null` when none was written. */
  secretsFile: string | null;
}

/** What one city's fixture transaction loaded (AAP 0.5.2). */
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

/**
 * Seeds the cities and, when the environment permits it, each city's fixtures, crawl-domain
 * decisions and console secrets (AAP 0.5.2, 0.6.2).
 *
 * The order is load-bearing in three places: the fixture gate runs before any write at all, so a
 * refused environment leaves the database untouched; every fixture file is read and validated
 * before the first fixture row is written, so a malformed file cannot leave one city loaded and the
 * next missing; and the secrets are issued after the rows they belong to exist, in one transaction,
 * reading the previous local file so a console a demo is using is never rotated out from under it.
 *
 * @param options The client, the mode, the keyring and the overrides of {@link SeedOptions}.
 * @returns What was loaded, and the secrets for the caller to keep (see {@link SeedSummary}).
 * @throws FixturesNotAllowedError when `fixtures` is true and `appEnv` forbids fixtures. Nothing is
 *   written, the cities included.
 * @throws ConfigFileError when a `config/` file is missing, does not parse or fails its schema. The
 *   cities are already stored at that point, and no fixture row is.
 * @throws Error when a fixture URL cannot be parsed into a host, or the database refuses a write.
 */
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
    // One capture instant per city, so a city's records share a `capturedAt` and a `fxDate` and the
    // freshness windows of AAP 0.5.7 are measured from a time inside this run.
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

/**
 * Writes the configured cities, each in one transaction with its centroid (AAP 0.5.2).
 *
 * `aliases` is deliberately absent: it is the circuit registry's input and the prover's business, and
 * no database reader needs it (AAP 0.5.5). The centroid is a `geography` column Prisma cannot write,
 * so `setPoint` writes it beside the row.
 *
 * @param db The guarded client.
 * @param cities The cities `config/cities.json` holds, in file order.
 * @throws Error when the database refuses the write, or a centroid is not a valid WGS 84 pair.
 */
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

/**
 * Loads one city's fixture set in a single transaction (AAP 0.5.2): the partner venues, the
 * lodgings, the priced places with their price records, and then the priority distances.
 *
 * Every id is {@link fixtureUuid}, so a rerun updates the row it made. The update half of each
 * upsert carries only the fields the fixture file owns: `doNotCall`, the console-secret columns, a
 * place's `nearestPartnerDistanceM`, a venue's `placeId` and its `isActivePartner` flag are managed
 * by an operator or by the place refresh, and a fixture must never take them back (AAP 0.5.6). A
 * row dropped from a fixture file is left in place, because a meetup, a claim or a call task may
 * reference it.
 *
 * A lodging is seeded with no `osmType` and no `osmId` and with `phoneSource = operator`, which is
 * what keeps `apps/workers/src/places/lodging-upsert.ts` from ever selecting it (AAP 0.5.6).
 *
 * @param tx The city's interactive transaction.
 * @param cityId The city slug.
 * @param file The city's fixture file, already validated by `loadCityFixtures`.
 * @param capturedAt The instant every price record of this city is stamped with.
 * @param appEnv The process's `APP_ENV`, which the distance statement's fixture predicate takes.
 * @returns The counts, the crawl hosts and the rows whose console secret is issued next.
 * @throws Error when the database refuses a write, or a coordinate is not a valid WGS 84 pair.
 */
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

  for (const venue of file.venues) {
    const id = fixtureUuid('venue', cityId, venue.key);
    await tx.venue.upsert({
      where: { id },
      create: {
        id,
        cityId,
        name: venue.name,
        address: venue.address,
        isActivePartner: true,
        isFixture: true,
      },
      update: { name: venue.name, address: venue.address },
    });
    await setPoint(tx, 'venue', id, { lat: venue.lat, lng: venue.lng });
    venueTargets.push({ id, cityId, name: venue.name });
  }

  for (const lodging of file.lodgings) {
    const id = fixtureUuid('lodging', cityId, lodging.key);
    const fields = {
      name: lodging.name,
      kind: lodging.kind,
      address: lodging.address,
      phone: lodging.phone,
      phoneSource: 'operator' as const,
    };
    await tx.lodging.upsert({
      where: { id },
      create: { id, cityId, ...fields, isFixture: true },
      update: fields,
    });
    await setPoint(tx, 'lodging', id, { lat: lodging.lat, lng: lodging.lng });
    lodgingTargets.push({ id, cityId, name: lodging.name });
  }

  let priceRecords = 0;

  for (const place of file.places) {
    const placeId = fixtureUuid('place', cityId, place.key);
    const fields = {
      name: place.name,
      category: place.category,
      website: place.website ?? null,
      menuUrl: place.menuUrl ?? null,
      phone: place.phone ?? null,
      openingHours: place.openingHours,
    };
    await tx.place.upsert({
      where: { id: placeId },
      create: { id: placeId, cityId, ...fields, isFixture: true },
      update: fields,
    });
    await setPoint(tx, 'place', placeId, { lat: place.lat, lng: place.lng });

    for (const url of [place.website, place.menuUrl]) {
      if (url !== undefined) {
        hosts.add(hostKeyOf(url));
      }
    }

    const pricedIds: string[] = [];
    for (const [index, item] of place.items.entries()) {
      pricedIds.push(
        await seedPriceRecord(tx, placeId, { cityId, place, index, item, capturedAt }),
      );
    }

    // Items removed from a fixture file go, unlike the places above: a price record is
    // configuration, and a stale one would enter an estimate the file no longer asks for (AAP 0.5.7).
    await tx.priceRecord.deleteMany({
      where: { placeId, isFixture: true, id: { notIn: pricedIds } },
    });
    priceRecords += pricedIds.length;
  }

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

/**
 * Stores one fixture price item and returns its id (AAP 0.5.2, 0.5.7).
 *
 * The record is written the way the estimate and the source gate read it: `priceText` in the `$12.50`
 * form, the amount in USD cents, `reviewStatus = approved` so it is never held for review, and a
 * `captureBatchId` shared by the items of one source for one place, which is the batch the estimate
 * groups by. `itemName.normalize` is the same NFKC, lower-case, single-spaced form the extractor
 * writes (AAP 0.5.6), so a fixture item and an extracted one group together.
 *
 * @param tx The city's interactive transaction.
 * @param placeId The id of the place the record belongs to.
 * @param args The run's city, the place, the item's index in the place and the capture instant.
 * @returns The record's id.
 * @throws Error when the database refuses the write.
 */
async function seedPriceRecord(
  tx: DbTx,
  placeId: string,
  args: {
    readonly cityId: string;
    readonly place: PlaceFixture;
    readonly index: number;
    readonly item: FixturePriceItem;
    readonly capturedAt: Date;
  },
): Promise<string> {
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
    fxDate: utcDateOf(capturedAt),
    confidence: null,
    reviewStatus: 'approved',
  } as const;

  await tx.priceRecord.upsert({
    where: { id },
    create: { id, placeId, ...fields, isFixture: true },
    update: fields,
  });

  return id;
}

/**
 * Records every fixture host as an allowed crawl domain (AAP 0.5.6).
 *
 * The workers decide crawling on a host and look up its label-wise suffixes, so an exact-host row
 * wins for the fixture host. A domain the workers had already recorded as `uncertain` becomes
 * allowed here; a domain an operator decided with their own id in `overriddenBy` is left alone, so a
 * review is never undone by a reseed. Nothing else about the host is validated: a fixture URL host
 * may legitimately be `localhost` (AAP 0.5.6).
 *
 * @param db The guarded client.
 * @param hosts The normalized host keys, without duplicates.
 * @param at The instant the decision is recorded as checked.
 * @returns The number of hosts the run recorded, which is what the summary reports.
 * @throws Error when the database refuses the write.
 */
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

/** The one shape the seed writes to `crawl_domain_policy`, so its decision keeps the enum's type. */
type CrawlPolicyRow = {
  readonly domain: string;
  readonly decision: 'allowed';
  readonly reason: string;
  readonly overriddenBy: string;
  readonly checkedAt: Date;
};

/**
 * The crawl-domain key of a fixture host (AAP 0.5.6): a URL's host, or the entry itself when it is
 * already a bare host, lower case, without a trailing dot or a port, and without a leading `www.`
 * that still leaves a registrable name.
 *
 * The worker's own key normalizer cannot be imported here — it lives in `apps/workers` — so this is
 * the seed's half of the same convention, and it is applied to both the hosts a fixture URL names
 * and the extra hosts a caller supplies.
 *
 * @param value A URL, or a bare `host` / `host:port`.
 * @returns The key a crawl-domain row is held under.
 * @throws TypeError when a value with a scheme is not a well-formed URL.
 */
function hostKeyOf(value: string): string {
  const trimmed = value.trim();
  const host = trimmed.includes('://') ? new URL(trimmed).hostname : trimmed.replace(/:\d+$/, '');
  const key = host.toLowerCase().replace(/\.$/, '');

  return key.startsWith('www.') && key.slice('www.'.length).includes('.')
    ? key.slice('www.'.length)
    : key;
}

/**
 * The `sourceUrl` of one fixture price record (AAP 0.5.2): where a reader can check the price.
 *
 * A phone quote cites the number it was quoted on, an operator entry cites the operator, and an
 * online menu cites the place's menu link, then its site, then a placeholder under the reserved
 * `.invalid` TLD — the last only for a place that has neither, which a fixture file may carry
 * because `menuUrl` and `website` are independent and optional. `load-config.ts` already refuses a
 * phone-quoted item on a place with no number.
 *
 * @param source The record's source.
 * @param place The place the record belongs to.
 * @param cityId The city slug, for the placeholder.
 * @returns The record's `sourceUrl`.
 */
function sourceUrlOf(source: PriceSource, place: PlaceFixture, cityId: string): string {
  if (source === 'phone_quote' && place.phone !== undefined) {
    return `tel:${place.phone}`;
  }
  if (source === 'operator_entry') {
    return 'operator:seed';
  }
  return place.menuUrl ?? place.website ?? `https://fixtures.invalid/${cityId}/${place.key}`;
}

/**
 * A cent amount as the price text a source gate compares against (AAP 0.5.6): `$12.50`.
 *
 * Integer arithmetic only, so no float rounding can move a fixture price off the amount it was
 * written with.
 *
 * @param usdCents The amount in USD cents.
 * @returns The amount as `$<whole>.<cents>`.
 */
function priceTextOf(usdCents: number): string {
  const cents = usdCents % 100;
  return `$${Math.floor(usdCents / 100)}.${String(cents).padStart(2, '0')}`;
}

/**
 * The name the estimate groups duplicate items by (AAP 0.5.7): NFKC, lower case, single-spaced.
 *
 * @param itemName The item's name as the fixture file writes it.
 * @returns The normalized name.
 */
function normalizeItemName(itemName: string): string {
  return itemName.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The UTC calendar date of an instant, as a `@db.Date` value holds it (AAP 0.5.2): midnight UTC of
 * that day, so no city's offset can move the FX date off the day the capture happened.
 *
 * @param at The instant to take the date of.
 * @returns Midnight UTC of `at`'s UTC day.
 */
function utcDateOf(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * The seed's command line (AAP 0.6.2): the `seed` script of `packages/db/package.json`, which the
 * compose `migrate` service runs as `pnpm db:deploy && pnpm db:seed` and a developer runs as
 * `pnpm db:seed`. With no flag the run takes the environment's answer for whether fixtures belong
 * here — `test` and `demo` yes, `staging` and `production` no — and `--fixtures` asks for them
 * anyway, which those two environments still refuse.
 *
 * @param argv The arguments after the script name.
 * @returns Nothing, once the seed has run and the pool has closed.
 * @throws EnvValidationError when one of the four variables is absent or unusable. Its message names
 *   the variables and never a value (AAP 0.12.2).
 * @throws FixturesNotAllowedError when fixtures are asked for outside `test` and `demo`.
 */
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

/**
 * Reports a failed CLI run: one line naming the error, and exit code 1 (AAP 0.6.2).
 *
 * The logger is built here rather than shared with {@link runSeedCli}, because the failure may be
 * the environment itself, which is read before that function has one. Only the error's name and
 * message are logged — never its stack, and never a value, which is what keeps a configuration
 * failure from printing a secret (AAP 0.12.2).
 *
 * @param error The unknown the rejection holds.
 */
function reportSeedFailure(error: unknown): void {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  const logger = createLogger({ name: SERVICE_NAME, level: 'info', appEnv: logAppEnv() });

  logger.error({ err: { name, message } }, 'seed failed');
  process.exitCode = 1;
}

/**
 * The mode the failure line is formatted for, before the environment has been validated: the raw
 * `APP_ENV` when it is a mode this workspace knows, and `demo` otherwise. It only decides whether
 * the line is pretty-printed, so an unusable value cannot mislead anyone about what ran.
 */
function logAppEnv(): AppEnv {
  return AppEnv.safeParse(process.env['APP_ENV']).data ?? 'demo';
}

/**
 * Whether this module is the process's entry point, so that importing `@tablemate/db/seed` from a
 * test or a tool runs no CLI (AAP 0.6.2).
 *
 * Both paths are resolved through `realpathSync`, because a package manager or a container may reach
 * this module through a symlink whose text differs from `import.meta.url`.
 *
 * @returns True only for a direct run of this file.
 */
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

// The secret file's locator and reader, re-exported with the seed, so a consumer of
// `@tablemate/db/seed` — a demo script, a system test — opens a console without a second import path
// (AAP 0.5.2).
export { FIXTURE_SECRETS_RELATIVE_PATH, readFixtureSecrets };
export type { FixtureSecretsFile };
