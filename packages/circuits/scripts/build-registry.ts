/**
 * The registry builder, `pnpm circuits:registry` (AAP 0.5.5, AAP 0.8.1): builds the depth-8 Poseidon
 * registry from `config/issuers/*.json` and `config/cities.json` through
 * `../src/registry/merkle.ts`, and writes the committed `config/registry/{production,test}.json`
 * that the circuit proves membership against and the client reads its leaves from.
 *
 * Production takes the `verified` issuers and never `tablemate-test`, whatever status that record
 * declares; test adds that record, which the DKIM-signed fixture emails are proved against. An
 * `awaiting_samples` or `unverified` record records no leaf, so Booking.com and Airbnb stay out of
 * both files until their samples pass `pnpm circuits:samples`.
 *
 * Both files are deterministic — no timestamp, and no ordering the configuration does not fix — so a
 * rerun is byte-identical, which `--check` and `test/registry.test.ts` rest on and which makes adding
 * an issuer or a city alias an edit to `config/` plus this rebuild, with no circuit change.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CitiesFile, IssuerConfig, RegistryFile } from '@tablemate/shared';

import { buildRegistry } from '../src/registry/merkle.ts';

/** The directory this file sits in: `scripts/` from the source, `dist/scripts/` from the build. */
const FILE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The directory that holds that one: `packages/circuits` from the source, `dist/` from the build. */
const PARENT_DIR = path.dirname(FILE_DIR);

/**
 * The `packages/circuits` directory, the base of every path inside this package. Accounting for a
 * `dist` segment matters because the compiled entry is what `apps/api` reaches through
 * `@tablemate/circuits`, and a hop that counted from `scripts/` would land on `dist/` there.
 */
export const PKG_DIR = path.basename(PARENT_DIR) === 'dist' ? path.dirname(PARENT_DIR) : PARENT_DIR;

/** The repository root, which holds `config/` and is the base of every path in a report. */
export const REPO_ROOT = path.join(PKG_DIR, '..', '..');

/**
 * The file stem of the synthetic test issuer, `config/issuers/tablemate-test.json`: added to the test
 * registry and withheld from production by name, not by status.
 */
export const TEST_ISSUER_STEM = 'tablemate-test';

/** The directory the issuer records are read from. */
const ISSUERS_DIR = path.join(REPO_ROOT, 'config', 'issuers');

/** The launch-city configuration both registries take their alias leaves from. */
const CITIES_FILE = path.join(REPO_ROOT, 'config', 'cities.json');

/** The registries' directory, repository-relative as the report and `--check` name it. */
const REGISTRY_DIR = 'config/registry';

/** The issuers' directory, repository-relative as an error message names it. */
const ISSUERS_DIR_RELATIVE = 'config/issuers';

/** One issuer record read from `config/issuers/<stem>.json`. */
export interface LoadedIssuer {
  /**
   * The file's base name without `.json`, for example `booking-com`: the key `check-samples.ts` and
   * `fetch-dkim-key.ts` select an issuer by, rather than its `issuerId`.
   */
  stem: string;
  /** The record's path relative to the repository root, the only path an error message names. */
  path: string;
  /** The parsed record exactly as its file carries it, with no status rule applied. */
  config: IssuerConfig;
}

/**
 * Reads every issuer record in `config/issuers/*.json`, sorted by file name, and parses each with
 * {@link IssuerConfig}. No verification-status rule is applied, so a caller sees the configuration as
 * written.
 *
 * @returns The loaded records, ordered by file name.
 * @throws {Error} When a file cannot be read or parsed as JSON, when a record fails its schema, or
 *   when two files carry the same `issuerId`. The message names the repository-relative path and the
 *   failing issue paths, both files for a repeated id, and never a field's value.
 */
export async function loadIssuers(): Promise<LoadedIssuer[]> {
  const names = (await readdir(ISSUERS_DIR)).filter((name) => name.endsWith('.json')).sort();
  const loaded: LoadedIssuer[] = [];
  const seen = new Map<number, string>();

  for (const name of names) {
    const relativePath = `${ISSUERS_DIR_RELATIVE}/${name}`;
    const parsed = IssuerConfig.safeParse(
      await readJson(path.join(ISSUERS_DIR, name), relativePath),
    );

    if (!parsed.success) {
      throw new Error(
        `${relativePath}: invalid issuer config at ${issuePaths(parsed.error.issues)}`,
      );
    }

    const previous = seen.get(parsed.data.issuerId);
    if (previous !== undefined) {
      throw new Error(
        `duplicate issuerId ${parsed.data.issuerId} in ${previous} and ${relativePath}`,
      );
    }
    seen.set(parsed.data.issuerId, relativePath);

    loaded.push({ stem: name.slice(0, -'.json'.length), path: relativePath, config: parsed.data });
  }

  return loaded;
}

/**
 * Reads and parses the launch-city configuration, which contributes one leaf per city alias to both
 * registries (AAP 0.5.5).
 *
 * @returns The configured cities.
 * @throws {Error} When `config/cities.json` cannot be read or parsed as JSON, or fails its schema;
 *   the message names the repository-relative path and the failing issue paths.
 */
export async function loadCities(): Promise<CitiesFile> {
  const relativePath = 'config/cities.json';
  const parsed = CitiesFile.safeParse(await readJson(CITIES_FILE, relativePath));

  if (!parsed.success) {
    throw new Error(`${relativePath}: invalid city config at ${issuePaths(parsed.error.issues)}`);
  }

  return parsed.data;
}

/**
 * Builds both registries from the committed configuration (AAP 0.5.5).
 *
 * @returns The two registries, each validated by {@link RegistryFile} and neither written anywhere.
 * @throws {Error} When the configuration cannot be loaded, when the `tablemate-test` record is
 *   missing, or when a repeated issuer id, key, city id or alias makes the tree ambiguous — the
 *   builder's own `RangeError` then propagates.
 */
export async function buildRegistries(): Promise<{ production: RegistryFile; test: RegistryFile }> {
  const [issuers, cities] = await Promise.all([loadIssuers(), loadCities()]);

  const testRecord = issuers.find((issuer) => issuer.stem === TEST_ISSUER_STEM);
  if (testRecord === undefined) {
    throw new Error(`config/issuers/${TEST_ISSUER_STEM}.json: the test issuer record is missing`);
  }

  // Only a `verified` record records a production leaf, and the test issuer never records one there.
  const productionIssuers = issuers
    .filter((issuer) => issuer.stem !== TEST_ISSUER_STEM)
    .filter((issuer) => issuer.config.verificationStatus === 'verified')
    .map((issuer) => withUsableKeys(issuer.config));

  const build = (name: RegistryFile['name'], records: readonly IssuerConfig[]): RegistryFile =>
    RegistryFile.parse(buildRegistry({ name, issuers: records, cities: cities.cities }).registry);

  return {
    production: build('production', productionIssuers),
    test: build('test', [...productionIssuers, withUsableKeys(testRecord.config)]),
  };
}

/**
 * Rebuilds both registries and writes the files whose contents differ, or under `check` reports them
 * without touching anything (AAP 0.5.5).
 *
 * A missing file counts as changed, an unchanged file is left alone so its modification time stays
 * put, and `changed` lists the stale files repository-relative. `make-test-fixtures.ts` calls this
 * after rotating the test key and compares the returned `test.root` with its in-memory registry.
 *
 * @param options - `check` reports the stale files instead of writing them.
 * @returns The built registries and the repository-relative paths of the files that differ.
 * @throws {Error} Whatever {@link buildRegistries} throws.
 */
export async function writeRegistries(
  options: { check?: boolean } = {},
): Promise<{ production: RegistryFile; test: RegistryFile; changed: string[] }> {
  const { production, test } = await buildRegistries();
  const changed: string[] = [];

  for (const registry of [production, test]) {
    const relativePath = registryPath(registry.name);
    const absolutePath = path.join(REPO_ROOT, relativePath);
    const contents = `${JSON.stringify(registry, null, 2)}\n`;

    if (await holds(absolutePath, contents)) {
      continue;
    }

    changed.push(relativePath);
    if (options.check !== true) {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, 'utf8');
    }
  }

  return { production, test, changed };
}

/** The repository-relative path of one registry file, the key the report and `--check` name. */
function registryPath(name: RegistryFile['name']): string {
  return `${REGISTRY_DIR}/${name}.json`;
}

/**
 * The record with the key entries that carry no modulus dropped. An entry with an empty
 * `modulusBase64` states no key and so records no leaf — the rule the builder already applies to an
 * issuer carrying none. The synthetic test issuer carries that placeholder until
 * `make-test-fixtures.ts` writes the modulus generated for its fixtures; no other record has one.
 */
function withUsableKeys(config: IssuerConfig): IssuerConfig {
  return { ...config, keys: config.keys.filter((key) => key.modulusBase64.trim() !== '') };
}

/** Reads one configuration file, naming its repository-relative path rather than a host path. */
async function readJson(absolutePath: string, relativePath: string): Promise<unknown> {
  const text = await readFile(absolutePath, 'utf8').catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${relativePath}: cannot be read (${reason})`);
  });

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${relativePath}: not valid JSON`);
  }
}

/** Renders a parse failure as the issue paths and codes, which name a place but never a value. */
function issuePaths(issues: readonly { path: readonly PropertyKey[]; code: string }[]): string {
  return issues
    .map((issue) => {
      const where = issue.path.map((segment) => String(segment)).join('.');
      return where === '' ? `<root> (${issue.code})` : `${where} (${issue.code})`;
    })
    .join(', ');
}

/** Whether the file on disk already holds exactly `contents`; a missing file never does. */
async function holds(absolutePath: string, contents: string): Promise<boolean> {
  try {
    return (await readFile(absolutePath, 'utf8')) === contents;
  } catch {
    return false;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main();
}

/**
 * Runs the command line. `--check` prints the stale registries and exits 1 without writing; the
 * default mode writes them and prints one line per registry. Every failure is reported as
 * `build-registry: <message>` with exit code 1, and nothing prints a stack trace or a file's
 * contents.
 */
async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2).filter((argument) => argument !== '--');
    const check = args.includes('--check');
    const unknown = args.filter((argument) => argument !== '--check');

    if (unknown.length > 0) {
      process.stderr.write('usage: pnpm circuits:registry [--check]\n');
      throw new Error(`unknown argument ${unknown.join(' ')}`);
    }

    const { production, test, changed } = await writeRegistries({ check });

    if (check) {
      if (changed.length === 0) {
        process.stdout.write('registry up to date\n');
        return;
      }

      for (const file of changed) {
        process.stdout.write(
          `${file} does not match its configuration; run pnpm circuits:registry\n`,
        );
      }
      process.exitCode = 1;
      return;
    }

    for (const registry of [production, test]) {
      const state = changed.includes(registryPath(registry.name)) ? 'written' : 'unchanged';
      process.stdout.write(
        `${registry.name}: root ${registry.root}, ${registry.leaves.length} leaves ` +
          `(${registry.issuers.length} issuer, ${registry.cities.length} city), ${state}\n`,
      );
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`build-registry: ${reason}\n`);
    process.exitCode = 1;
  }
}
