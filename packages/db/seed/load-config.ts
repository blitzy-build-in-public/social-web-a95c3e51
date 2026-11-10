import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CitiesFile, CityFixturesFile } from '@tablemate/shared';
import type { CityConfig, PlaceFixture } from '@tablemate/shared';
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';
const CITIES_FILE = 'config/cities.json';
const FIXTURES_DIR = 'config/fixtures';
// The city-slug shape, checked before a slug is joined into a path: the ids come from `config/cities.json`, whose schema already constrains them, but no `cityId` reaching this loader may escape the fixture directory.
const CITY_ID_PATTERN = /^[a-z]+(-[a-z]+)*$/;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
/** A configuration file this loader refused, carrying the repository-relative path and every issue found in it, so the seed reports all of a file's problems at once. */
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
function formatIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string[] {
  return issues.map((issue) => {
    const where = issue.path.map((segment) => String(segment)).join('.');
    return where === '' ? issue.message : `${where}: ${issue.message}`;
  });
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function readFailureIssue(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    return 'file not found';
  }
  return `file could not be read: ${messageOf(error)}`;
}
/** The repository root: the nearest ancestor of `from` holding `pnpm-workspace.yaml`. */
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
/** Loads the launch-city configuration (AAP 0.5.2): `config/cities.json`, whose schema already enforces unique city ids, unique circuit city ids, the bounding-box ordering and the alias byte bound. Every issue is reported, not just the first. */
export async function loadCitiesConfig(repoRoot: string): Promise<CityConfig[]> {
  const raw = await readJson(repoRoot, CITIES_FILE);
  const parsed = CitiesFile.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigFileError(CITIES_FILE, formatIssues(parsed.error.issues));
  }
  return parsed.data.cities;
}
function quotesByPhone(place: PlaceFixture): boolean {
  return place.items.some((item) => item[3] === 'phone_quote');
}
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
/** Loads one city's fixture set (AAP 0.5.2): `config/fixtures/<cityId>.json`, whose schema enforces the minimum counts, the "Fixture" name prefix, the fictional phone ranges and at least `MIN_PRICED_ITEMS` priced items per place. */
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
