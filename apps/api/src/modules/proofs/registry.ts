/**
 * The circuit configuration the API reads from disk: the launch cities, the issuer key records, the
 * committed Poseidon registries and the proving-artefact manifest (AAP 0.5.5). It is the only API
 * module that touches them, and the only place `checkZkConfiguration` proves — at startup, before the
 * app listens — that the committed registries are what `config/issuers/*.json` and `config/cities.json`
 * rebuild to (AAP 0.5.1, 0.5.5).
 *
 * `zkConfig` answers the public `GET /v1/zk/config` (AAP 0.5.4): the key records and extraction
 * templates of the supported issuers, the display names of the issuers still awaiting samples, the
 * registry whose leaves the device builds its two Merkle paths from, the published nullifier salt and
 * the artefact URLs. Every field is copied off the parsed configuration by name, so a hand-edited file
 * cannot widen the response, and the built object is memoized per process because the configuration is
 * static between deploys.
 *
 * Read through `node:fs` rather than `import … with { type: 'json' }`: the files live outside
 * `apps/api` (the package's `rootDir: "."` rejects them), the issuer set is a directory listing, and the
 * runtime image reads the deployed copies its Dockerfile copies to `/app` beside `pnpm-workspace.yaml`.
 *
 * Nothing here reaches a proving key, the circuit WASM or a witness generator: the API image holds
 * `verification_key.json` and the manifest alone, and this module never calls proving code — it checks
 * that the configuration a submitted proof is verified against is the one that was published
 * (AAP 0.5.5 "No server proving"). No function here reads the clock, and every failure names a file or
 * a field and never a value.
 *
 * @see AAP 0.5.5 for the registries, the issuer records and the artefact manifest, 0.5.4 for
 *   `GET /v1/zk/config` and its `503`, 0.5.8 for the import screen that lists the unsupported issuers,
 *   and 0.11.1 for the TSDoc and logging conventions.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { buildRegistry } from '@tablemate/circuits';
import { ArtifactsManifest, CitiesFile, IssuerConfig, RegistryFile } from '@tablemate/shared';
import type {
  ArtifactLink,
  ArtifactRef,
  CityConfig,
  DkimKey,
  IssuerTemplate,
  TemplateField,
  ZkConfig,
} from '@tablemate/shared';
import type { ApiEnv, Logger } from '@tablemate/server-core';

import { AppError } from '../../plugins/errors.ts';

/* The files this module reads, each named once (AAP 0.5.5, 0.6.2). */

/** The workspace marker {@link findRepoRoot} walks up to: only the repository root holds it. */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/** The suffix a configuration file carries, and what the issuer listing filters on. */
const JSON_SUFFIX = '.json';

/** The repository-relative directory the circuit build writes into (AAP 0.4.2, 0.5.5). */
const BUILD_DIR = 'packages/circuits/build';

/**
 * The manifest `packages/circuits/scripts/setup.sh` writes beside the circuit build's files: the sizes
 * and SHA-256 digests a client checks its downloads against, published by `GET /v1/zk/config`.
 */
const MANIFEST_FILE = 'artifacts.manifest.json';

/** The key file the API mounts and a staging or production start requires beside the manifest. */
const VERIFICATION_KEY_FILE = 'verification_key.json';

/** The directory the committed registries live in, one file per environment (AAP 0.5.5). */
const REGISTRY_DIR = 'config/registry';

/** The issuer records' directory, one `<stem>.json` per issuer. */
const ISSUERS_DIR = 'config/issuers';

/** The launch-city configuration the circuit's city alias leaves are rebuilt from. */
const CITIES_FILE = 'config/cities.json';

/**
 * The file stem of the synthetic test issuer, `config/issuers/tablemate-test.json`. Its key signs the
 * DKIM-signed fixture emails, so it is added to the test registry and withheld from production by name
 * rather than by status — the rule `packages/circuits/scripts/build-registry.ts` applies, whose
 * `TEST_ISSUER_STEM` this constant must equal (AAP 0.5.5).
 */
export const TEST_ISSUER_STEM = 'tablemate-test';

/**
 * Raised when the circuit configuration on disk is missing or no longer matches the committed
 * registries (AAP 0.5.5). `main.ts` lets it end the start, so a deployment whose configuration and
 * registries disagree never begins accepting proofs it would verify against the wrong root.
 *
 * Every message names the offending file, the field that differs or the rebuild command to run, and
 * never a configured value.
 */
export class ZkConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZkConfigurationError';
    // The class must stay `instanceof`-correct when this module and a copy of it are both loaded in one
    // process, which is also why the check in `main.ts` can rely on the name.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The directory this module loads from, in the tree whether it runs from source or from `dist`. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The repository root, once {@link findRepoRoot} has found it. */
let cachedRepoRoot: string | undefined;

/**
 * The repository root: the nearest ancestor of this module's directory that holds
 * `pnpm-workspace.yaml` (AAP 0.5.5).
 *
 * Walking up rather than counting directories is what makes one implementation serve both layouts a
 * clone has: `apps/api/src/modules/proofs` under `tsx` and `apps/api/dist/src/modules/proofs` in the
 * runtime image, whose Dockerfile copies `pnpm-workspace.yaml` and `config/{cities.json,issuers,registry}`
 * to `/app`. The result is cached, so the walk happens once per process.
 *
 * @returns The absolute path of the repository root.
 * @throws {ZkConfigurationError} When no ancestor holds the workspace marker.
 */
export function findRepoRoot(): string {
  let root = cachedRepoRoot;
  if (root === undefined) {
    for (let dir = MODULE_DIR; ; dir = path.dirname(dir)) {
      if (existsSync(path.join(dir, WORKSPACE_MARKER))) {
        root = dir;
        break;
      }
      if (path.dirname(dir) === dir) {
        throw new ZkConfigurationError(`repository root not found (${WORKSPACE_MARKER})`);
      }
    }
    cachedRepoRoot = root;
  }
  return root;
}

/**
 * An absolute path of a file under the repository root (AAP 0.5.5).
 *
 * @param segments - The path's segments below the root, for example `'config'`, `'cities.json'`.
 * @returns The joined absolute path.
 * @throws {ZkConfigurationError} When {@link findRepoRoot} cannot locate the root.
 */
export function repoPath(...segments: readonly string[]): string {
  return path.join(findRepoRoot(), ...segments);
}

/**
 * An absolute path of a file `pnpm circuits:build` writes under `packages/circuits/build`
 * (AAP 0.4.2, 0.5.5). `verifier.ts` reads `verification_key.json` through this, and a staging or
 * production start requires it.
 *
 * @param file - The file's name inside the build directory.
 * @returns The absolute path.
 * @throws {ZkConfigurationError} When {@link findRepoRoot} cannot locate the root.
 */
export function circuitsBuildPath(file: string): string {
  return path.join(findRepoRoot(), BUILD_DIR, file);
}

/* Reading the configuration (AAP 0.5.5). */

/** One issue of a schema rejection: its path and code, the two parts an error message may name. */
interface SchemaIssue {
  readonly path: readonly PropertyKey[];
  readonly code: string;
}

/**
 * The issues a Zod rejection carries — read structurally, so this module needs no import of the schema
 * library and a rejection of any of the five schemas below is summarized the same way.
 */
function schemaIssues(error: unknown): readonly SchemaIssue[] {
  if (typeof error !== 'object' || error === null || !('issues' in error)) {
    return [];
  }
  const { issues } = error as { issues?: unknown };
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues.flatMap((issue): SchemaIssue[] => {
    if (typeof issue !== 'object' || issue === null) {
      return [];
    }
    const { path: where, code } = issue as { path?: unknown; code?: unknown };
    return Array.isArray(where) && typeof code === 'string' ? [{ path: where, code }] : [];
  });
}

/**
 * A schema rejection rendered as its issue paths and codes: a place and a kind, never a value, because
 * these strings reach logs and container output (AAP 0.11.1, 0.12.2).
 */
function issuePaths(error: unknown): string {
  const issues = schemaIssues(error);
  if (issues.length === 0) {
    return '<unknown>';
  }
  return issues
    .map((issue) => {
      const where = issue.path.map((segment) => String(segment)).join('.');
      return where === '' ? `<root> (${issue.code})` : `${where} (${issue.code})`;
    })
    .join(', ');
}

/** Reads one configuration file as text, naming its repository-relative path when it cannot be read. */
function readTextAt(relativePath: string): string {
  try {
    return readFileSync(path.join(findRepoRoot(), relativePath), 'utf8');
  } catch {
    throw new ZkConfigurationError(`${relativePath}: cannot be read`);
  }
}

/**
 * Reads one configuration file as JSON, naming its repository-relative path when it cannot be read or
 * holds no valid JSON.
 */
function readJsonAt(relativePath: string): unknown {
  const text = readTextAt(relativePath);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ZkConfigurationError(`${relativePath}: not valid JSON`);
  }
}

/**
 * Parses one configuration file with its schema (AAP 0.5.5). A file that is absent, unreadable or not
 * valid JSON, or a value the schema rejects, reports that file's repository-relative path and the
 * failing issue paths — never the file's contents.
 */
function parseAt<T>(relativePath: string, schema: { parse(value: unknown): T }): T {
  const value = readJsonAt(relativePath);
  try {
    return schema.parse(value);
  } catch (error) {
    throw new ZkConfigurationError(
      `${relativePath}: does not match its schema at ${issuePaths(error)}`,
    );
  }
}

/** The launch-city configuration, once read. */
let cachedCities: CitiesFile | undefined;

/**
 * The launch-city configuration, `config/cities.json`, parsed once per process (AAP 0.5.5).
 *
 * Synchronous and cached because `app.ts` builds `services.timezoneFor(cityId)` from it while the app
 * is constructed, and every later reader — the circuit registry rebuild, the caller resolving a city
 * id, the import screen — must see one immutable configuration.
 *
 * @returns The parsed configuration, with its cities in file order.
 * @throws {ZkConfigurationError} When the file cannot be read, is not valid JSON, or fails
 *   {@link CitiesFile}.
 */
export function readCitiesConfig(): CitiesFile {
  const cached = cachedCities ?? parseAt(CITIES_FILE, CitiesFile);
  cachedCities = cached;
  return cached;
}

/** The city lookups, built once from {@link readCitiesConfig}. */
interface CityIndex {
  /** Cities by slug, the identifier every route's `:cityId` parameter takes. */
  readonly bySlug: ReadonlyMap<string, CityConfig>;
  /** Cities by `circuitCityId`, the integer a proof's `cityId` signal carries. */
  readonly byCircuitId: ReadonlyMap<number, CityConfig>;
}

/** The city lookups, once built. */
let cachedCityIndex: CityIndex | undefined;

/** The city lookups, built on first use from the parsed configuration. */
function cityIndex(): CityIndex {
  let index = cachedCityIndex;
  if (index === undefined) {
    const bySlug = new Map<string, CityConfig>();
    const byCircuitId = new Map<number, CityConfig>();
    for (const city of readCitiesConfig().cities) {
      bySlug.set(city.id, city);
      byCircuitId.set(city.circuitCityId, city);
    }
    index = { bySlug, byCircuitId };
    cachedCityIndex = index;
  }
  return index;
}

/**
 * The configured city a slug names (AAP 0.5.5). {@link CitiesFile} rejects a repeated slug, so the
 * lookup is a function of the configuration.
 *
 * @param slug - A city slug, for example `'lisbon'`.
 * @returns The city, or `undefined` when no configured city carries that slug.
 * @throws {ZkConfigurationError} When the configuration cannot be read.
 */
export function cityBySlug(slug: string): CityConfig | undefined {
  return cityIndex().bySlug.get(slug);
}

/**
 * The configured city a circuit `cityId` names (AAP 0.5.5): how a verified proof's `cityId` signal
 * becomes the slug its row is stored under.
 *
 * @param id - The circuit's integer city id, from the proof's public outputs.
 * @returns The city, or `undefined` when no configured city carries that id.
 * @throws {ZkConfigurationError} When the configuration cannot be read.
 */
export function cityByCircuitId(id: number): CityConfig | undefined {
  return cityIndex().byCircuitId.get(id);
}

/* The issuer records, the committed registries and the artefact manifest (AAP 0.5.5). */

/**
 * One issuer record read from `config/issuers/<stem>.json`.
 *
 * The stem is the file's base name without `.json` — `booking-com`, `airbnb`, `tablemate-test` — which
 * is how this module, `packages/circuits/scripts/check-samples.ts` and
 * `packages/circuits/scripts/fetch-dkim-key.ts` select an issuer, rather than by its `issuerId`.
 */
export interface IssuerConfigEntry {
  /** The record's file stem. */
  readonly stem: string;
  /** The parsed record exactly as its file carries it, with no verification-status rule applied. */
  readonly config: IssuerConfig;
}

/** The issuer records, once read. */
let cachedIssuers: readonly IssuerConfigEntry[] | undefined;

/** The names of the issuer records in `config/issuers`, sorted by file name. */
function issuerFileNames(): readonly string[] {
  try {
    return readdirSync(path.join(findRepoRoot(), ISSUERS_DIR))
      .filter((name) => name.endsWith(JSON_SUFFIX))
      .sort();
  } catch {
    throw new ZkConfigurationError(`${ISSUERS_DIR}: cannot be read`);
  }
}

/**
 * Every issuer record in `config/issuers/*.json`, sorted by file name and parsed once per process
 * (AAP 0.5.5).
 *
 * No verification-status rule is applied: a caller sees the configuration as written, so the registry
 * rebuild, the published configuration and `pnpm circuits:samples` all decide inclusion the same way
 * from the same records. Booking.com and Airbnb ship as `awaiting_samples` with no key and no template,
 * and the synthetic `tablemate-test` record is a record of this shape like any other.
 *
 * @returns The loaded records, ordered by file name.
 * @throws {ZkConfigurationError} When the directory cannot be listed, or a record cannot be read or
 *   fails {@link IssuerConfig}; the message names the record's repository-relative path.
 */
export function readIssuerConfigs(): readonly IssuerConfigEntry[] {
  let entries = cachedIssuers;
  if (entries === undefined) {
    entries = issuerFileNames().map((name) => ({
      stem: name.slice(0, -JSON_SUFFIX.length),
      config: parseAt(`${ISSUERS_DIR}/${name}`, IssuerConfig),
    }));
    cachedIssuers = entries;
  }
  return entries;
}

/** A registry file's name: `production`, or `test` when the test issuer is allowed (AAP 0.5.5). */
export type RegistryName = RegistryFile['name'];

/** The registries that have been read, one entry per name. */
const registryCache = new Map<RegistryName, RegistryFile>();

/**
 * One committed registry, `config/registry/<name>.json`, parsed once per process (AAP 0.5.5).
 *
 * This is the file the circuit proves membership against and the client reads its two Merkle paths
 * from, so it is read rather than rebuilt at request time: `checkZkConfiguration` is what keeps it equal
 * to a rebuild of the configuration, once, at startup.
 *
 * @param name - Which registry to read.
 * @returns The parsed registry.
 * @throws {ZkConfigurationError} When the file cannot be read, is not valid JSON, or fails
 *   {@link RegistryFile}.
 */
export function readRegistryFile(name: RegistryName): RegistryFile {
  const cached = registryCache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = parseAt(`${REGISTRY_DIR}/${name}${JSON_SUFFIX}`, RegistryFile);
  registryCache.set(name, parsed);
  return parsed;
}

/** The artefact manifest, once a read has succeeded. */
let cachedManifest: ArtifactsManifest | undefined;

/**
 * The artefact manifest `pnpm circuits:build` writes, or `null` when it is absent (AAP 0.5.5).
 *
 * `packages/circuits/build/` is generated and git-ignored, and the `api` container mounts the manifest
 * and `verification_key.json` into it, so an absent file is a normal state outside a full local build
 * rather than a defect. Only a successful read is cached, so a container that mounts the artefacts after
 * the process started picks them up on the next call.
 *
 * @returns The parsed manifest, or `null` when no manifest file exists.
 * @throws {ZkConfigurationError} When the file exists but is not valid JSON or fails
 *   {@link ArtifactsManifest}.
 */
export function readArtifactsManifest(): ArtifactsManifest | null {
  const relativePath = `${BUILD_DIR}/${MANIFEST_FILE}`;
  if (!existsSync(repoPath(BUILD_DIR, MANIFEST_FILE))) {
    return null;
  }
  const cached = cachedManifest;
  if (cached !== undefined) {
    return cached;
  }
  const parsed = parseAt(relativePath, ArtifactsManifest);
  cachedManifest = parsed;
  return parsed;
}

/* The active registries (AAP 0.5.5). */

/**
 * What the configuration readers here need of the app's environment, so `verifier.ts`, a test and
 * `apps/api/scripts/bench-verify.ts` can pass a narrow one: the mode and its test-only switches, the
 * published nullifier salt and the artefact base URL (AAP 0.5.5, 0.6.2).
 *
 * The mode is read as the loaded `AppEnv` rather than compared against `process.env`, because the
 * resolved `testOnly` switches are already off outside `test` (AAP 0.6.2) and the two must not be able
 * to disagree.
 */
export type ZkEnv = Pick<ApiEnv, 'APP_ENV' | 'testOnly' | 'NULLIFIER_SALT' | 'ARTIFACTS_BASE_URL'>;

/**
 * Whether the synthetic test issuer's registry root and key are accepted, which the API does only in
 * `APP_ENV=test` with `ZK_ALLOW_TEST_ISSUER=true` (AAP 0.5.5, 0.6.2).
 *
 * Both halves are required: the mode makes the switch meaningful, and the switch makes the mode
 * deliberate. The loaded configuration resolves every test-only variable to its off value outside
 * `test`, so this can never be true in a demo, staging or production process.
 *
 * @param env - The process's configuration.
 * @returns Whether the test registry is active.
 */
export function testIssuerAllowed(env: ZkEnv): boolean {
  return env.APP_ENV === 'test' && env.testOnly.zkAllowTestIssuer;
}

/**
 * The registries whose roots a submitted proof may name, production first (AAP 0.5.5).
 *
 * The production root is always one of them; the test root joins it only under
 * {@link testIssuerAllowed}. `verifier.ts` takes the registry whose root matches the proof's
 * `registryRoot` signal from this list and reads that proof's city and issuer ids out of it, so the
 * root and the entries are always from one registry and can never be mixed.
 *
 * @param env - The process's configuration.
 * @returns One registry, or both in test mode.
 * @throws {ZkConfigurationError} When a registry cannot be read.
 */
export function activeRegistries(env: ZkEnv): readonly RegistryFile[] {
  return testIssuerAllowed(env)
    ? [readRegistryFile('production'), readRegistryFile('test')]
    : [readRegistryFile('production')];
}

/**
 * The roots {@link activeRegistries} carries, in the same order (AAP 0.5.5).
 *
 * A caller that only needs to know whether a root is published takes these; `verifier.ts` compares them
 * as field elements, so a signal carrying leading zeros still matches, which is why these are the
 * strings as stored and not a parsed number.
 *
 * @param env - The process's configuration.
 * @returns The active roots, production first.
 * @throws {ZkConfigurationError} When a registry cannot be read.
 */
export function activeRegistryRoots(env: ZkEnv): readonly string[] {
  return activeRegistries(env).map((registry) => registry.root);
}

/* The published ZK configuration, `GET /v1/zk/config` (AAP 0.5.4, 0.5.5). */

/**
 * What {@link zkConfig} needs of the app's services: the environment it publishes from and the logger a
 * missing manifest is recorded in.
 *
 * Declared narrow and locally, the way `modules/admin/price-jobs.ts` and `modules/lodgings/leaderboard.ts`
 * declare theirs: the composition root states the app's own services type, and the app's services object
 * satisfies this shape structurally, so a caller passes what it already has and a test can stand a
 * one-line logger in for one.
 */
export interface ZkConfigServices {
  /** The process's configuration: the mode, the test-only switches, the salt and the artefact base. */
  readonly env: ZkEnv;
  /** Where the absent-manifest warning is recorded. */
  readonly logger: Pick<Logger, 'warn'>;
}

/** The built configuration, one entry per {@link testIssuerAllowed} answer. */
const zkConfigCache = new Map<boolean, ZkConfig>();

/**
 * The body of public `GET /v1/zk/config`: everything the device needs to build circuit inputs and prove
 * locally, with no DNS lookup and no server-side proving (AAP 0.5.4, 0.5.5).
 *
 * `issuers` carries the `verified` issuers' key records and templates — the test issuer included only
 * under {@link testIssuerAllowed} — and `unsupportedIssuers` the display names of those still awaiting
 * samples, which the import screen lists as "This booking site isn't supported yet." (AAP 0.5.8).
 * `registry` is the one whose leaves the two Merkle paths are read from, chosen exactly as
 * {@link activeRegistries} chooses the accepted ones, so a client given the test registry also proves
 * against a root the verifier accepts.
 *
 * A missing manifest is a `503 service_unavailable` after one `warn` line, because the client cannot
 * download or check an artefact without it; `main.ts` requires the manifest outright in staging and
 * production, so this answer is reachable only where a build has not run.
 *
 * @param services - The environment and the logger.
 * @returns The published configuration, the same object for every call in one mode.
 * @throws {AppError} `service_unavailable` when the artefact manifest is absent.
 * @throws {ZkConfigurationError} When a configuration file it publishes cannot be read.
 */
export function zkConfig(services: ZkConfigServices): ZkConfig {
  const allowTestIssuer = testIssuerAllowed(services.env);
  // The manifest is checked before the memoized object is served, so a build directory that is not
  // mounted — or mounted later — is answered as the contract says on every call rather than once.
  const manifest = readArtifactsManifest();
  if (manifest === null) {
    services.logger.warn(
      { event: 'zk_artifacts_missing', file: MANIFEST_FILE },
      'zk_artifacts_missing',
    );
    throw new AppError('service_unavailable');
  }

  const cached = zkConfigCache.get(allowTestIssuer);
  if (cached !== undefined) {
    return cached;
  }

  const entries = readIssuerConfigs();
  const issuers: ZkConfig['issuers'] = [];
  for (const entry of entries) {
    const record = publishedIssuer(entry, allowTestIssuer);
    if (record !== null) {
      issuers.push(record);
    }
  }
  issuers.sort((left, right) => left.issuerId - right.issuerId);

  const unsupportedIssuers = entries
    .filter((entry) => entry.config.verificationStatus !== 'verified')
    .sort((left, right) => left.config.issuerId - right.config.issuerId)
    .map((entry) => entry.config.displayName);

  const base = artifactsBase(services.env.ARTIFACTS_BASE_URL);
  const config: ZkConfig = {
    issuers,
    unsupportedIssuers,
    registry: readRegistryFile(allowTestIssuer ? 'test' : 'production'),
    nullifierSalt: services.env.NULLIFIER_SALT,
    artifacts: {
      wasm: artifactLink(manifest.files.wasm, base),
      zkey: artifactLink(manifest.files.zkey, base),
    },
    manifestUrl: new URL(MANIFEST_FILE, base).toString(),
  };

  zkConfigCache.set(allowTestIssuer, config);
  return config;
}

/**
 * One issuer as the configuration publishes it, or `null` when it records no leaf at all (AAP 0.5.5):
 * a record that is not `verified`, one with no template, one whose keys all state no modulus, and the
 * test issuer outside the test environment.
 *
 * Publishing an issuer the registry holds no leaf for would invite a proof that can never verify
 * against the published root, so the selection mirrors the registry builder's own rule — an issuer
 * contributes a leaf only when it carries a template and at least one usable key.
 */
function publishedIssuer(
  entry: IssuerConfigEntry,
  allowTestIssuer: boolean,
): ZkConfig['issuers'][number] | null {
  const { config, stem } = entry;
  if (config.verificationStatus !== 'verified' || config.template === null) {
    return null;
  }
  if (stem === TEST_ISSUER_STEM && !allowTestIssuer) {
    return null;
  }
  const keys = usableKeys(config);
  if (keys.length === 0) {
    return null;
  }
  return {
    issuerId: config.issuerId,
    displayName: config.displayName,
    keys: keys.map(copyKey),
    template: copyTemplate(config.template),
  };
}

/**
 * One artefact as the published configuration advertises it: where to fetch it, its size and its
 * SHA-256, so the client hashes what it downloaded without a second round trip (AAP 0.5.5).
 */
function artifactLink(file: ArtifactRef, base: string): ArtifactLink {
  return { url: new URL(file.name, base).toString(), size: file.size, sha256: file.sha256 };
}

/** `ARTIFACTS_BASE_URL` with exactly one trailing slash, so a file name resolves under it. */
function artifactsBase(raw: string): string {
  return raw.endsWith('/') ? raw : `${raw}/`;
}

/** One DKIM key record, copied field by field so no unparsed key can ride into a response. */
function copyKey(key: DkimKey): DkimKey {
  return { domain: key.domain, selector: key.selector, modulusBase64: key.modulusBase64 };
}

/** One extraction template field, copied field by field. */
function copyField(field: TemplateField): TemplateField {
  return { anchor: field.anchor, terminator: field.terminator, charset: field.charset };
}

/**
 * One extraction template, copied field by field: the four anchors, terminators and charsets and the
 * date format the circuit's template hash commits to (AAP 0.5.5).
 */
function copyTemplate(template: IssuerTemplate): IssuerTemplate {
  const { city, arrival, departure, reference } = template.fields;
  return {
    fields: {
      city: copyField(city),
      arrival: copyField(arrival),
      departure: copyField(departure),
      reference: copyField(reference),
    },
    dateFormat: template.dateFormat,
  };
}

/** The issuer's key records that name a key: the ones the registry builder takes leaves from. */
function usableKeys(config: IssuerConfig): DkimKey[] {
  return config.keys.filter((key) => key.modulusBase64.trim() !== '');
}

/* The startup check (AAP 0.5.5). */

/** The registry keys the startup check compares, in the order the committed files carry them. */
const REGISTRY_KEYS = ['root', 'leaves', 'issuers', 'cities'] as const;

/**
 * Checks the circuit configuration before the app listens: that the committed registries are what
 * `config/issuers/*.json` and `config/cities.json` rebuild to, and that a staging or production start
 * has the artefacts it verifies with (AAP 0.5.5).
 *
 * Synchronous on purpose, so `main.ts` cannot leave a rejected promise unhandled between validating its
 * environment and calling `listen`. The rebuild is the check that matters: a registry hand-edited, or a
 * configuration changed without `pnpm circuits:registry`, would let a proof prove membership of a tree
 * the client was never given, and the failure would surface as an unexplained `422 proof_invalid` per
 * traveler rather than as a start that refused. `buildRegistry` hashes at most 256 Poseidon leaves and
 * runs once, at startup.
 *
 * The production rebuild takes the `verified` issuers and never the test issuer, whatever status that
 * record declares, and the test rebuild adds it — exactly the selection
 * `packages/circuits/scripts/build-registry.ts` makes, down to dropping a key entry that carries no
 * modulus. The test rebuild runs only where the test root is accepted, since only then is
 * `config/registry/test.json` published.
 *
 * In `staging` and `production` the verification key and the manifest must exist and parse, because a
 * production proof submission has no way to verify without them; in `test` and `demo` their absence is
 * allowed, and proof submission plus `GET /v1/zk/config` answer `503` instead.
 *
 * @param env - The process's configuration.
 * @throws {ZkConfigurationError} Naming the registry and the key that differs, the missing record, or
 *   the missing build file.
 */
export function checkZkConfiguration(env: ZkEnv): void {
  const cities = readCitiesConfig().cities;
  const entries = readIssuerConfigs();

  const productionIssuers = entries
    .filter((entry) => entry.stem !== TEST_ISSUER_STEM)
    .filter((entry) => entry.config.verificationStatus === 'verified')
    .map((entry) => withUsableKeys(entry.config));

  compareWithCommitted('production', productionIssuers, cities);

  if (testIssuerAllowed(env)) {
    const testRecord = entries.find((entry) => entry.stem === TEST_ISSUER_STEM);
    if (testRecord === undefined) {
      throw new ZkConfigurationError(
        `${ISSUERS_DIR}/${TEST_ISSUER_STEM}${JSON_SUFFIX}: the test issuer record is missing`,
      );
    }
    compareWithCommitted('test', [...productionIssuers, withUsableKeys(testRecord.config)], cities);
  }

  if (env.APP_ENV === 'staging' || env.APP_ENV === 'production') {
    requireBuildFile(VERIFICATION_KEY_FILE);
    if (readArtifactsManifest() === null) {
      throw new ZkConfigurationError(`${BUILD_DIR}/${MANIFEST_FILE}: missing`);
    }
  }
}

/**
 * Rebuilds one registry from the configuration and compares it with the committed file, key by key
 * (AAP 0.5.5).
 *
 * A deep comparison rather than a root-only one: a rebuilt registry that reached the same root with
 * different leaves would mean the client reads a leaf index the committed tree does not hold, which a
 * root check would pass.
 */
function compareWithCommitted(
  name: RegistryName,
  issuers: readonly IssuerConfig[],
  cities: readonly CityConfig[],
): void {
  let built: RegistryFile;
  try {
    built = buildRegistry({ name, issuers, cities }).registry;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown failure';
    // The builder's own messages name the ambiguous id or count and never a value, so they are carried
    // into the message rather than replaced: an operator needs to know which record is ambiguous.
    throw new ZkConfigurationError(`registry ${name}: cannot be rebuilt (${reason})`);
  }

  const committed = readRegistryFile(name);
  for (const key of REGISTRY_KEYS) {
    if (!isDeepStrictEqual(built[key], committed[key])) {
      throw new ZkConfigurationError(
        `registry ${name}: "${key}" differs from a rebuild of ${ISSUERS_DIR} and ${CITIES_FILE} — ` +
          `run pnpm circuits:registry`,
      );
    }
  }
}

/**
 * The record with the key entries that carry no modulus dropped — the rule
 * `packages/circuits/scripts/build-registry.ts` applies through its own helper. An entry with an empty
 * `modulusBase64` states no key and so records no leaf; a rebuild that kept it would produce a
 * different registry from the committed one and report a mismatch that is not there.
 */
function withUsableKeys(config: IssuerConfig): IssuerConfig {
  return {
    issuerId: config.issuerId,
    displayName: config.displayName,
    verificationStatus: config.verificationStatus,
    keys: usableKeys(config),
    template: config.template,
  };
}

/** Requires a build file to exist and hold valid JSON, naming it when either fails (AAP 0.5.5). */
function requireBuildFile(file: string): void {
  if (!existsSync(circuitsBuildPath(file))) {
    throw new ZkConfigurationError(`${BUILD_DIR}/${file}: missing`);
  }
  readJsonAt(`${BUILD_DIR}/${file}`);
}
