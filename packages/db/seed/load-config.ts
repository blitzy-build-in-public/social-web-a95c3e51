/**
 * Configuration loader for the seed (AAP 0.5.2): it reads `config/cities.json` and one
 * `config/fixtures/<cityId>.json` per launch city, validates each against the schema that owns its
 * shape in `packages/shared/src/schemas/cities.ts`, and refuses a file that would seed anything
 * other than what the plan states. Cities and fixtures are configuration, so the pilot changes them
 * by editing the JSON and re-seeding, with no code change.
 *
 * Fixture keys are what `seed.ts` matches an existing row by, so a duplicate key would merge two
 * records, and a `phone_quote` price takes its `sourceUrl` from the place's own number
 * (`tel:<phone>`): both are checked here rather than left to the database. Nothing here opens a
 * database, reads the environment, consults a clock or writes a log line — `seed.ts` owns seeding.
 *
 * @see AAP 0.5.2 for the fixture sets and their counts, 0.8.1 for the seed files.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CitiesFile, CityFixturesFile } from '@tablemate/shared';
import type { CityConfig, PlaceFixture } from '@tablemate/shared';

/** The workspace marker identifying the repository root (AAP 0.6.1). */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/** The launch-city configuration, relative to the repository root (AAP 0.5.2). */
const CITIES_FILE = 'config/cities.json';

/** The fixture-file directory, relative to the repository root (AAP 0.5.2). */
const FIXTURES_DIR = 'config/fixtures';

// The city-slug shape, checked before a slug is joined into a path: the ids come from
// `config/cities.json`, whose schema already constrains them, but no `cityId` reaching this loader
// may escape the fixture directory.
const CITY_ID_PATTERN = /^[a-z]+(-[a-z]+)*$/;

/** The directory this module was loaded from: the walk's default starting point. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * A configuration file this loader refused, carrying the repository-relative path and every issue
 * found in it, so the seed reports all of a file's problems at once. The failures that reach here
 * are the file being missing, its JSON not parsing, a record failing its schema, and a cross-record
 * rule failing (AAP 0.5.2). No issue carries raw file text or whole records: each is one short line
 * naming a path and what is wrong with it.
 */
export class ConfigFileError extends Error {
  /** The repository-relative path of the offending file, with forward slashes. */
  readonly file: string;

  /** One short line per problem, in the order the loader found them. */
  readonly issues: readonly string[];

  constructor(file: string, issues: readonly string[]) {
    super(
      `Invalid configuration file ${file}:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'ConfigFileError';
    this.file = file;
    this.issues = issues;
  }
}

/** One schema issue as `path: message`; an issue at the file root is its message alone. */
function formatIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string[] {
  return issues.map((issue) => {
    const where = issue.path.map((segment) => String(segment)).join('.');
    return where === '' ? issue.message : `${where}: ${issue.message}`;
  });
}

/** The message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One line describing why a configuration file could not be read. */
function readFailureIssue(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    return 'file not found';
  }
  return `file could not be read: ${messageOf(error)}`;
}

/**
 * The repository root: the nearest ancestor of `from` holding `pnpm-workspace.yaml`.
 *
 * The default start is this module's directory — `packages/db/seed/` for the source path under tsx
 * and Vitest, `packages/db/dist/seed/` for the compiled one (AAP 0.8.1) — and the Docker
 * `test-support` image mirrors the repository at `/app`, whose root holds the same marker.
 *
 * @param from Directory to start the walk at; defaults to this module's directory.
 * @returns The absolute path of the repository root.
 * @throws Error when no ancestor holds the marker.
 */
export function findRepoRoot(from: string = MODULE_DIR): string {
  const start = path.resolve(from);

  for (let dir = start; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, WORKSPACE_MARKER))) {
      return dir;
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`repository root not found (no ${WORKSPACE_MARKER} above ${start})`);
    }
  }
}

/** Reads and parses one JSON file, mapping every failure to a {@link ConfigFileError}. */
async function readJson(repoRoot: string, relativePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path.join(repoRoot, relativePath), 'utf8');
  } catch (error) {
    throw new ConfigFileError(relativePath, [readFailureIssue(error)]);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConfigFileError(relativePath, [`invalid JSON: ${messageOf(error)}`]);
  }
}

/**
 * Loads the launch-city configuration (AAP 0.5.2): `config/cities.json`, whose schema already
 * enforces unique city ids, unique circuit city ids, the bounding-box ordering and the alias byte
 * limits.
 *
 * @param repoRoot Absolute path of the repository root, from {@link findRepoRoot}.
 * @returns The configured cities, in file order.
 * @throws ConfigFileError when the file is missing, does not parse or fails its schema.
 */
export async function loadCitiesConfig(repoRoot: string): Promise<CityConfig[]> {
  const raw = await readJson(repoRoot, CITIES_FILE);
  const parsed = CitiesFile.safeParse(raw);

  if (!parsed.success) {
    throw new ConfigFileError(CITIES_FILE, formatIssues(parsed.error.issues));
  }

  return parsed.data.cities;
}

/** Whether a place prices at least one item from a phone call, which needs its number. */
function quotesByPhone(place: PlaceFixture): boolean {
  return place.items.some((item) => item[3] === 'phone_quote');
}

/**
 * Every cross-record rule the fixture schemas cannot state (AAP 0.5.2): the file names its own city,
 * keys are unique within each list, and a phone-quoted price has a number to quote.
 */
function fixtureIssues(file: CityFixturesFile, cityId: string): string[] {
  const issues: string[] = [];

  if (file.cityId !== cityId) {
    issues.push(`cityId: expected "${cityId}", got "${file.cityId}"`);
  }

  const lists = [
    ['venues', file.venues],
    ['lodgings', file.lodgings],
    ['places', file.places],
  ] as const;

  for (const [list, rows] of lists) {
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.key)) {
        issues.push(`${list}[${row.key}]: duplicate key`);
      }
      seen.add(row.key);
    }
  }

  for (const place of file.places) {
    if (quotesByPhone(place) && place.phone === undefined) {
      issues.push(`places[${place.key}]: phone_quote item without phone`);
    }
  }

  return issues;
}

/**
 * Loads one city's fixture set (AAP 0.5.2): `config/fixtures/<cityId>.json`, whose schema enforces
 * the minimum counts, the "Fixture" name prefix, the fictional phone ranges, at least
 * `MIN_PRICED_ITEMS` priced items per place and the ticket rule.
 *
 * @param repoRoot Absolute path of the repository root, from {@link findRepoRoot}.
 * @param cityId The city slug, as `config/cities.json` spells it.
 * @returns The parsed fixture file, ready to seed.
 * @throws ConfigFileError when the slug is not a slug, the file is missing, does not parse, fails
 * its schema or breaks one of the cross-record rules.
 */
export async function loadCityFixtures(
  repoRoot: string,
  cityId: string,
): Promise<CityFixturesFile> {
  const relativePath = `${FIXTURES_DIR}/${cityId}.json`;
  if (!CITY_ID_PATTERN.test(cityId)) {
    throw new ConfigFileError(relativePath, [`invalid city id "${cityId}"`]);
  }

  const raw = await readJson(repoRoot, relativePath);
  const parsed = CityFixturesFile.safeParse(raw);

  if (!parsed.success) {
    throw new ConfigFileError(relativePath, formatIssues(parsed.error.issues));
  }

  const issues = fixtureIssues(parsed.data, cityId);
  if (issues.length > 0) {
    throw new ConfigFileError(relativePath, issues);
  }

  return parsed.data;
}
