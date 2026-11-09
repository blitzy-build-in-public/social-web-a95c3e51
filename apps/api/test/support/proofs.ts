/**
 * Fixture proofs for `apps/api`'s suites: the harness in the client's role (AAP 0.8.1 "fixture
 * proofs", AAP 0.11.2, AAP 0.5.5).
 */

import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCircuitInputs, buildRegistry } from '@tablemate/circuits';
import {
  CitiesFile,
  IssuerConfig,
  PUBLIC_SIGNAL_NAMES,
  ProofSubmission,
  RegistryFile,
} from '@tablemate/shared';
import type { CircuitInputs, SupportedIssuer } from '@tablemate/circuits';
import type { PublicSignalName } from '@tablemate/shared';

/**
 * The fixed public nullifier salt the fixture proofs are taken with: a short decimal field element, so a proof
 * stays verifiable across runs and its cache stays warm. `apps/api/test/support/app.ts` passes it as the app's
 * `NULLIFIER_SALT`, and the verifier's salt check (AAP 0.5.5 step 2) then accepts a fixture proof.
 */
export const TEST_NULLIFIER_SALT = '20261104';

/** A committed fixture, by the stem of its file in `packages/circuits/fixtures/test-issuer/`. */
export type FixtureName = 'valid' | 'valid-second' | 'other-issuer' | 'tampered';

/**
 * How long one proving command may run: the snarkjs CLI reading a 1.6 GB proving key and a witness of this circuit
 * costs minutes on first use (AAP 0.11.2).
 */
export const PROOF_TIMEOUT_MS = 20 * 60 * 1000;

/** How {@link fixtureProof} proves. */
export interface FixtureProofOptions {
  /** The nullifier salt to prove against; the published `TEST_NULLIFIER_SALT` unless given. */
  readonly salt?: string;
  /**
   * Prove anew instead of reading and writing the cache, because a re-randomised proof is wanted and the result
   * must not be reused.
   */
  readonly fresh?: boolean;
}

/** The stay a fixture proof proves, read off its public signals (AAP 0.5.5). */
export interface FixtureStay {
  /** The circuit's integer city id, the `cityId` signal. */
  readonly circuitCityId: number;
  /** The arrival date as `YYYY-MM-DD`, decoded from the `arrivalDate` signal. */
  readonly arrivalDate: string;
  /** The departure date as `YYYY-MM-DD`, decoded from the `departureDate` signal. */
  readonly departureDate: string;
  /** The booking reference's nullifier, the `nullifier` signal, for `SpentNullifier` assertions. */
  readonly nullifier: string;
}

/**
 * The workspace marker {@link findRepoRoot} walks up to: only the repository root holds it.
 */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/** The committed fixture emails, by stem (AAP 0.8.1). */
const FIXTURE_DIR = 'packages/circuits/fixtures/test-issuer';

/** The build directory `pnpm circuits:build` writes into, git-ignored (AAP 0.4.2, 0.5.5). */
const BUILD_DIR = 'packages/circuits/build';

/** The git-ignored directory the cached fixture proofs live in. */
const CACHE_DIR = '.local/test-proofs';

/** The committed test registry, the root the test issuer's proofs prove membership of. */
const TEST_REGISTRY_FILE = 'config/registry/test.json';

/** The synthetic test issuer whose key signed the fixtures (AAP 0.5.5). */
const TEST_ISSUER_FILE = 'config/issuers/tablemate-test.json';

/** The launch-city configuration whose alias leaves the registries carry. */
const CITIES_FILE = 'config/cities.json';

const WASM_FILE = 'tablemate_itinerary.wasm';
const ZKEY_FILE = 'tablemate_itinerary.zkey';
const VERIFICATION_KEY_FILE = 'verification_key.json';
const WITNESS_FILE = 'witness.wtns';
const SNARKJS_PROOF_FILE = 'proof.json';
const SNARKJS_PUBLIC_FILE = 'public.json';
const PROVER_PROOF_FILE = 'prover-proof.json';
const PROVER_PUBLIC_FILE = 'prover-public.json';
const WORK_DIR_PREFIX = 'tablemate-fixture-proof-';

/** The header fields the `other-issuer` fixture carries its out-of-registry key in (AAP 0.8.1). */
const DKIM_FIELD = 'dkim-signature';
const ROGUE_KEY_FIELD = 'x-tablemate-fixture-key';

/** The one failure a missing build produces, naming the command that fixes it. */
const MISSING_ARTEFACTS =
  'circuit artefacts missing at packages/circuits/build — run pnpm circuits:build';

/**
 * The file name {@link resolveProverBinary} looks for on `PATH` (AAP 0.4.2). The binary that runs is the absolute
 * path that resolution returns, never this bare name.
 */
const PROVER_BINARY = 'prover';

/**
 * The variable that pins the native prover's absolute path (AAP 0.4.2, CWE-426): the harness runs a `prover` only
 * from the path it names, so a stray binary of that name earlier on `PATH` is never handed the proving key and the
 * witness.
 */
const PROVER_PATH_ENV = 'RAPIDSNARK_PROVER';

/** snarkjs' own CLI, inside the installed package, for the prover that needs no native build. */
const SNARKJS_CLI_FILE = 'cli.cjs';

/**
 * The heap the snarkjs CLI child process is given: the proving key of a multi-million-constraint circuit is
 * gigabytes, which a test worker's own heap cannot hold.
 */
const SNARKJS_CLI_HEAP_MB = 16384;

/** The most output one proving command may write, in bytes. */
const COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;

/** One day, for {@link instantDuringStay}. */
const DAY_MS = 86_400_000;

/** A canonical decimal field element, the shape `NULLIFIER_SALT` and a proof's signals share. */
const FIELD_ELEMENT = /^\d{1,78}$/;

/** A calendar date as the circuit's date parser emits it: `YYYYMMDD`, day precision. */
const CIRCUIT_DATE = /^\d{8}$/;

/** This module's directory, in the tree whether it runs from source or from `dist`. */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** The repository root, once {@link findRepoRoot} has found it. */
let cachedRepoRoot: string | undefined;

/**
 * The repository root: the nearest ancestor of this module's directory holding
 * `pnpm-workspace.yaml` (AAP 0.5.5).
 */
export function findRepoRoot(): string {
  if (cachedRepoRoot !== undefined) {
    return cachedRepoRoot;
  }
  let dir = MODULE_DIR;
  while (!existsSync(join(dir, WORKSPACE_MARKER))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`repository root not found (${WORKSPACE_MARKER})`);
    }
    dir = parent;
  }
  cachedRepoRoot = dir;
  return dir;
}

/**
 * Reads one committed fixture email (AAP 0.8.1), so a suite can assert that a stored row or a log
 * line never contains the fixture's text (AAP 0.12.2).
 */
export async function readFixtureEml(name: FixtureName): Promise<Uint8Array> {
  const relative = `${FIXTURE_DIR}/${name}.eml`;
  try {
    return new Uint8Array(await readFile(join(findRepoRoot(), relative)));
  } catch {
    throw new Error(`${relative}: cannot be read`);
  }
}

/** The configuration a fixture proof is built from. */
interface FixtureConfig {
  readonly issuer: IssuerConfig;
  readonly registry: RegistryFile;
  readonly cities: CitiesFile;
}

let cachedConfig: Promise<FixtureConfig> | undefined;

/** The fixture configuration, read once: the test issuer, the committed test registry, the cities. */
function fixtureConfig(): Promise<FixtureConfig> {
  const config = cachedConfig ?? readFixtureConfig();
  cachedConfig = config;
  return config;
}

/** Reads the three configuration files, each parsed by the shared schema that describes it. */
async function readFixtureConfig(): Promise<FixtureConfig> {
  const root = findRepoRoot();
  const [issuer, registry, cities] = await Promise.all([
    readJson(root, TEST_ISSUER_FILE, IssuerConfig),
    readJson(root, TEST_REGISTRY_FILE, RegistryFile),
    readJson(root, CITIES_FILE, CitiesFile),
  ]);
  return { issuer, registry, cities };
}

/**
 * Reads one configuration file and parses it with its schema (AAP 0.5.5).
 *
 */
async function readJson<T>(
  root: string,
  relative: string,
  schema: { parse(value: unknown): T },
): Promise<T> {
  let text: string;
  try {
    text = await readFile(join(root, relative), 'utf8');
  } catch {
    throw new Error(`${relative}: cannot be read`);
  }
  try {
    return schema.parse(JSON.parse(text) as unknown);
  } catch {
    throw new Error(`${relative}: does not match its schema`);
  }
}

/**
 * Proves one committed fixture in the client's role and answers the submission the API's
 * `POST /itinerary-proofs` accepts (AAP 0.5.5, AAP 0.11.2).
 */
export async function fixtureProof(
  name: FixtureName,
  options: FixtureProofOptions = {},
): Promise<ProofSubmission> {
  const salt = canonicalSalt(options.salt ?? TEST_NULLIFIER_SALT);
  const fresh = options.fresh === true;
  const root = findRepoRoot();
  const artefacts = artefactPaths(root);
  const eml = await readFixtureEml(name);
  const { issuer, registry } = await fixtureProver(name, eml);
  const cacheFile = cacheFilePath(root, {
    eml,
    verificationKey: await readFile(artefacts.verificationKey),
    salt,
    registryRoot: registry.root,
  });
  if (!fresh) {
    const cached = await readCachedProof(cacheFile);
    if (cached !== undefined) {
      return cached;
    }
  }
  const { inputs } = buildCircuitInputs(eml, [issuer], registry, { nullifierSalt: salt });
  const submission = await proveFixture(inputs, artefacts, salt);
  if (!fresh) {
    await writeCachedProof(cacheFile, submission);
  }
  return submission;
}

/**
 * The issuer and registry one fixture is proved against: the committed test registry, or — for `other-issuer` — the
 * test issuer's identity carrying the key that signed that fixture, in a registry rebuilt around it.
 */
async function fixtureProver(
  name: FixtureName,
  eml: Uint8Array,
): Promise<{ issuer: SupportedIssuer; registry: RegistryFile }> {
  const config = await fixtureConfig();
  if (name !== 'other-issuer') {
    return { issuer: config.issuer, registry: config.registry };
  }
  const issuer = rogueIssuer(eml, config.issuer);
  const { registry } = buildRegistry({
    name: 'test',
    issuers: [issuer],
    cities: config.cities.cities,
  });
  return { issuer, registry };
}

/**
 * The `other-issuer` fixture's signer as an issuer record: the test issuer's id and template, with
 * the key the fixture was signed under instead of the registered one (AAP 0.5.5).
 */
function rogueIssuer(eml: Uint8Array, config: IssuerConfig): IssuerConfig {
  const message = Buffer.from(eml).toString('latin1');
  const signature = headerValue(message, DKIM_FIELD);
  const modulusBase64 = headerValue(message, ROGUE_KEY_FIELD);
  if (signature === undefined || modulusBase64 === undefined) {
    throw new Error(`other-issuer.eml: no ${DKIM_FIELD} or ${ROGUE_KEY_FIELD} header`);
  }
  try {
    return IssuerConfig.parse({
      issuerId: config.issuerId,
      displayName: `${config.displayName} (out-of-registry key)`,
      verificationStatus: 'verified',
      keys: [
        {
          domain: dkimTag(signature, 'd'),
          selector: dkimTag(signature, 's'),
          modulusBase64,
        },
      ],
      template: config.template,
    });
  } catch {
    // A schema rejection here is a malformed fixture header, not a caller's mistake: reporting it as
    // such keeps a raw Zod error out of the failure, which is what a suite sees.
    throw new Error(`other-issuer.eml: the ${ROGUE_KEY_FIELD} header is not a base64 DKIM key`);
  }
}

/**
 * The value of a message's first header field with this name, its folded continuation lines joined
 * (AAP 0.5.5).
 */
function headerValue(message: string, name: string): string | undefined {
  const lines = message.split(/\r?\n/);
  const prefix = `${name.toLowerCase()}:`;
  for (const [index, line] of lines.entries()) {
    if (line === '') {
      return undefined;
    }
    if (!line.toLowerCase().startsWith(prefix)) {
      continue;
    }
    // The value starts after the colon's optional whitespace; a fold continues it with WSP, which
    // is dropped here so a base64 value reassembles exactly.
    const parts = [line.slice(prefix.length).trim()];
    for (const continuation of lines.slice(index + 1)) {
      if (!/^[ \t]/.test(continuation)) {
        break;
      }
      parts.push(continuation.trim());
    }
    return parts.join('');
  }
  return undefined;
}

/**
 * One tag of a `DKIM-Signature` value, by name: how the fixture's `d=` and `s=` are read without
 * pulling in the client generator's own parser, which is not part of that package's public surface.
 */
function dkimTag(value: string, name: string): string {
  for (const tag of value.split(';')) {
    const separator = tag.indexOf('=');
    if (separator < 0 || tag.slice(0, separator).trim().toLowerCase() !== name) {
      continue;
    }
    const found = tag.slice(separator + 1).trim();
    if (found !== '') {
      return found;
    }
  }
  throw new Error(`fixture DKIM signature: no ${name} tag`);
}

/** The three artefacts one fixture proof reads, at the absolute paths they hold in the build. */
interface ArtefactPaths {
  readonly wasm: string;
  readonly zkey: string;
  readonly verificationKey: string;
}

/**
 * The circuit artefacts, or the failure that says how to produce them (AAP 0.4.2, AAP 0.5.5).
 *
 */
function artefactPaths(root: string): ArtefactPaths {
  const paths = {
    wasm: join(root, BUILD_DIR, WASM_FILE),
    zkey: join(root, BUILD_DIR, ZKEY_FILE),
    verificationKey: join(root, BUILD_DIR, VERIFICATION_KEY_FILE),
  };
  for (const file of Object.values(paths)) {
    if (!existsSync(file)) {
      throw new Error(MISSING_ARTEFACTS);
    }
  }
  return paths;
}

/** What a cached proof is keyed by: the fixture, the setup, the salt and the registry. */
interface CacheKeyParts {
  readonly eml: Uint8Array;
  readonly verificationKey: Uint8Array;
  readonly salt: string;
  readonly registryRoot: string;
}

/**
 * The cache file one proof belongs in (AAP 0.11.2): the SHA-256 of the email bytes, the verification key, the salt
 * and the registry root, so a changed fixture, a re-run setup, a different salt or a rebuilt registry proves again
 * rather than reusing a stale proof. The proving key is deliberately not hashed — it is gigabytes, and the
 * verification key identifies the setup it belongs to.
 */
function cacheFilePath(root: string, parts: CacheKeyParts): string {
  const digest = createHash('sha256')
    .update(parts.eml)
    .update(parts.verificationKey)
    .update(parts.salt, 'utf8')
    .update(parts.registryRoot, 'utf8')
    .digest('hex');
  return join(root, CACHE_DIR, `${digest}.json`);
}

/**
 * The cached proof at `file`, or `undefined` when there is none (AAP 0.11.2). A cache file that cannot be read, or
 * holds something other than a `ProofSubmission`, is treated as absent: it is git-ignored scratch state that a
 * schema change can invalidate, and proving again is always correct.
 */
async function readCachedProof(file: string): Promise<ProofSubmission | undefined> {
  try {
    return ProofSubmission.parse(JSON.parse(await readFile(file, 'utf8')) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * Writes a proof to the cache atomically (AAP 0.11.2): a temporary file beside it and a rename, so a run killed
 * mid-write leaves no half-written proof for the next one to trust.
 */
async function writeCachedProof(file: string, submission: ProofSubmission): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(submission));
    await rename(temporary, file);
  } catch {
    await rm(temporary, { force: true });
    throw new Error(`fixture proof cache: cannot be written at ${CACHE_DIR}`);
  }
}

/**
 * snarkjs 0.7.6's two calls, narrowed here because the package ships no declarations (AAP 0.5.5): `wtns.calculate`
 * builds the witness from the wasm witness generator, and `groth16.prove` proves it with a proving key. Neither is
 * a proving entrypoint the API package may hold; this file is the only one in `apps/api` that calls them
 * (AAP 0.12.2).
 */
interface Snarkjs {
  readonly wtns: {
    calculate(input: object, wasmFile: string, witnessFile: string): Promise<void>;
  };
  readonly groth16: {
    prove(zkeyFile: string, witnessFile: string): Promise<ProverOutput>;
  };
}

/** What a prover returned, before it is validated: the proof and the signals, both unread. */
interface ProverOutput {
  readonly proof: unknown;
  readonly publicSignals: unknown;
}

/** snarkjs 0.7.6, loaded because it is CommonJS with no declarations of its own. */
function loadSnarkjs(): Snarkjs {
  return createRequire(import.meta.url)('snarkjs') as Snarkjs;
}

/**
 * Proves one witness: the witness in a fresh temporary directory, then the native prover when
 * {@link resolveProverBinary} finds one and snarkjs otherwise (AAP 0.2.4, AAP 0.5.5).
 */
async function proveFixture(
  inputs: CircuitInputs,
  artefacts: ArtefactPaths,
  salt: string,
): Promise<ProofSubmission> {
  const workDir = await mkdtemp(join(tmpdir(), WORK_DIR_PREFIX));
  try {
    const witness = join(workDir, WITNESS_FILE);
    const snarkjs = loadSnarkjs();
    await snarkjs.wtns.calculate(inputs, artefacts.wasm, witness);
    const output =
      (await proverOutput(artefacts, witness, workDir)) ??
      (await snarkjsOutput(artefacts, witness, workDir, snarkjs));
    return submissionFrom(output, salt);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** The prover paths already reported, so one path is announced once per process, not once per proof. */
const reportedProverPaths = new Set<string>();

/**
 * Whether a path is an executable regular file: how a prover is recognised before it runs.
 *
 * A path that cannot be inspected — absent, unreadable, a directory, a dangling symlink — is not one.
 */
function isExecutableProver(file: string): boolean {
  try {
    const stats = statSync(file);
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Every executable `prover` on `PATH`, in search order and each as an absolute path (CWE-426).
 *
 * An empty entry is skipped: POSIX reads it as the working directory, which is the relative search
 * this resolution exists to keep the proving key and the witness out of. A relative entry is resolved
 * against the working directory, exactly as a shell would, so the path returned is the file that
 * would have run either way.
 */
function proverPathCandidates(): readonly string[] {
  const candidates = new Set<string>();
  for (const entry of (process.env['PATH'] ?? '').split(delimiter)) {
    if (entry === '') {
      continue;
    }
    const candidate = resolve(entry, PROVER_BINARY);
    if (isExecutableProver(candidate)) {
      candidates.add(candidate);
    }
  }
  return [...candidates];
}

/** Announces the prover a proof is about to be handed to, once per distinct path per process. */
function reportProver(file: string, source: string): void {
  if (reportedProverPaths.has(file)) {
    return;
  }
  reportedProverPaths.add(file);
  console.warn(`fixture proof: proving with ${file} (${source})`);
}

/**
 * The native prover to run, as an absolute path, or `undefined` when none is installed
 * (AAP 0.4.2, CWE-426).
 */
export function resolveProverBinary(): string | undefined {
  const pinned = process.env[PROVER_PATH_ENV];
  if (pinned !== undefined && pinned !== '') {
    if (!isAbsolute(pinned) || !isExecutableProver(pinned)) {
      throw new Error(
        `${PROVER_PATH_ENV}: ${pinned} is not an absolute path to an executable file`,
      );
    }
    reportProver(pinned, `pinned by ${PROVER_PATH_ENV}`);
    return pinned;
  }
  const [first, ...others] = proverPathCandidates();
  if (first === undefined) {
    return undefined;
  }
  reportProver(
    first,
    others.length === 0 ? 'from PATH' : `from PATH, ahead of ${others.join(', ')}`,
  );
  return first;
}

/**
 * The proof the native prover produces, or `undefined` when none is installed (AAP 0.2.4, AAP 0.4.2).
 *
 * Absence is settled by {@link resolveProverBinary} before any command runs, so a command that reports
 * a missing executable here covers only a prover that disappeared between that resolution and this
 * call. Any other failure is real and is reported, because a prover that ran and failed is not the
 * same as one that was never there.
 */
async function proverOutput(
  artefacts: ArtefactPaths,
  witness: string,
  workDir: string,
): Promise<ProverOutput | undefined> {
  const prover = resolveProverBinary();
  if (prover === undefined) {
    return undefined;
  }
  const proofFile = join(workDir, PROVER_PROOF_FILE);
  const publicFile = join(workDir, PROVER_PUBLIC_FILE);
  const result = await runCommand(prover, [artefacts.zkey, witness, proofFile, publicFile]);
  if (result.missing) {
    return undefined;
  }
  if (!result.ok) {
    throw new Error(`${prover} failed (${result.code}) on ${ZKEY_FILE}${result.note}`);
  }
  return {
    proof: await readJsonFile(proofFile),
    publicSignals: await readJsonFile(publicFile),
  };
}

/**
 * The proof snarkjs produces (AAP 0.5.5): its CLI in a child process with a heap large enough for a
 * gigabyte-scale proving key, and its library in this process only when that CLI cannot be resolved.
 */
async function snarkjsOutput(
  artefacts: ArtefactPaths,
  witness: string,
  workDir: string,
  snarkjs: Snarkjs,
): Promise<ProverOutput> {
  const cli = snarkjsCli();
  if (cli === undefined) {
    return snarkjs.groth16.prove(artefacts.zkey, witness);
  }
  const proofFile = join(workDir, SNARKJS_PROOF_FILE);
  const publicFile = join(workDir, SNARKJS_PUBLIC_FILE);
  const result = await runCommand(process.execPath, [
    `--max-old-space-size=${String(SNARKJS_CLI_HEAP_MB)}`,
    cli,
    'groth16',
    'prove',
    artefacts.zkey,
    witness,
    proofFile,
    publicFile,
  ]);
  if (!result.ok) {
    throw new Error(`snarkjs groth16 prove failed (${result.code}) on ${ZKEY_FILE}${result.note}`);
  }
  return {
    proof: await readJsonFile(proofFile),
    publicSignals: await readJsonFile(publicFile),
  };
}

/** snarkjs' CLI path inside the installed package, or `undefined` when it cannot be resolved. */
function snarkjsCli(): string | undefined {
  try {
    const cli = join(dirname(createRequire(import.meta.url).resolve('snarkjs')), SNARKJS_CLI_FILE);
    return existsSync(cli) ? cli : undefined;
  } catch {
    return undefined;
  }
}

/** What one proving command did: whether it ran, whether it was missing, and how it ended. */
interface CommandResult {
  readonly ok: boolean;
  readonly missing: boolean;
  readonly code: string;
  /** A note for the failure message: the output's size, never its content. */
  readonly note: string;
}

/**
 * Runs one proving command and reports what happened (AAP 0.11.1).
 *
 * The command's output is deliberately not reported: a witness generator can echo the signal values
 * it was given, which are private inputs, so a failure carries the step, the file and the exit status
 * and nothing else (AAP 0.12.2). `ENOENT` is reported as missing rather than failing, which now covers
 * only a prover that disappeared between {@link resolveProverBinary}'s resolution and this call: an
 * uninstalled native prover is settled before any command runs, so a missing executable is not the
 * evidence of absence it once was.
 */
function runCommand(file: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: PROOF_TIMEOUT_MS, maxBuffer: COMMAND_OUTPUT_BYTES, encoding: 'utf8' },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, missing: false, code: '0', note: '' });
          return;
        }
        const code = String(error.code ?? 'unknown');
        resolve({
          ok: false,
          missing: error.code === 'ENOENT',
          code,
          note: `; ${String(stderr.length)} bytes of output withheld`,
        });
      },
    );
  });
}

/** A JSON file a prover wrote, read as the unknown value the schema validates. */
async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    throw new Error(`${basename(file)}: the prover wrote no readable JSON`);
  }
}

/**
 * The submission one prover output is (AAP 0.5.5): the three proof components under the protocol and
 * curve the contract names — extra keys a prover adds are dropped — and the public signals as decimal
 * strings, then the salt assertion the circuit's own inputs must satisfy.
 */
function submissionFrom(output: ProverOutput, salt: string): ProofSubmission {
  const submission = ProofSubmission.parse({
    proof: proofObject(output.proof),
    publicSignals: signalStrings(output.publicSignals),
  });
  const index = PUBLIC_SIGNAL_NAMES.indexOf('nullifierSalt');
  if (submission.publicSignals[index] !== salt) {
    throw new Error('fixture proof: the nullifierSalt signal is not the salt it was proved with');
  }
  return submission;
}

/** A prover's proof as the contract's four components, with anything else it returned dropped. */
function proofObject(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('fixture proof: the prover returned no proof');
  }
  const { pi_a, pi_b, pi_c } = raw as { pi_a?: unknown; pi_b?: unknown; pi_c?: unknown };
  return { pi_a, pi_b, pi_c, protocol: 'groth16', curve: 'bn128' };
}

/** A prover's public signals as the decimal strings they must be to be worth verifying. */
function signalStrings(raw: unknown): readonly string[] {
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string')) {
    throw new Error('fixture proof: the prover returned no public signals');
  }
  return raw as string[];
}

/** A salt as the circuit's own field element: decimal, and canonical, so one salt caches once. */
function canonicalSalt(salt: string): string {
  if (!FIELD_ELEMENT.test(salt)) {
    throw new RangeError('fixtureProof: the nullifier salt is not a decimal field element');
  }
  return BigInt(salt).toString();
}

/**
 * The same submission with one public signal replaced (AAP 0.12.1 criterion 3).
 *
 * Groth16 then fails, which is the API's `422 proof_invalid`: the suite's evidence that a tampered
 * claim about a booking is refused even though the proof's shape is still valid.
 */
export function alterSignal(
  submission: ProofSubmission,
  index: number,
  value?: string,
): ProofSubmission {
  const current = submission.publicSignals[index];
  if (current === undefined) {
    throw new RangeError(`alterSignal: no public signal at index ${index}`);
  }
  const altered = [...submission.publicSignals];
  altered[index] = value ?? (BigInt(current) + 1n).toString();
  return ProofSubmission.parse({ proof: submission.proof, publicSignals: altered });
}

/**
 * The stay a fixture proof proves, decoded from its public signals (AAP 0.5.5).
 *
 */
export function fixtureStay(submission: ProofSubmission): FixtureStay {
  const signals = staySignals(submission);
  const circuitCityId = Number(signals.cityId);
  if (!Number.isSafeInteger(circuitCityId) || circuitCityId < 1) {
    throw new Error('fixtureStay: the cityId signal is not a circuit city id');
  }
  return {
    circuitCityId,
    arrivalDate: isoDate(signals.arrivalDate),
    departureDate: isoDate(signals.departureDate),
    nullifier: signals.nullifier,
  };
}

/**
 * An instant inside the stay a fixture proof proves: the day after its arrival, at noon UTC
 * (AAP 0.11.2).
 */
export function instantDuringStay(submission: ProofSubmission): Date {
  const { arrivalDate } = fixtureStay(submission);
  const noon = Date.parse(`${arrivalDate}T12:00:00.000Z`);
  if (Number.isNaN(noon)) {
    throw new Error('instantDuringStay: the arrival date is not an ISO date');
  }
  return new Date(noon + DAY_MS);
}

/**
 * Releases the process-wide BN254 curve instance ffjavascript builds, for a script that proves without
 * ever building an app (AAP 0.5.5).
 */
export async function releaseProverCurve(): Promise<void> {
  const scope = globalThis as { curve_bn128?: { terminate(): Promise<void> } };
  const curve = scope.curve_bn128;
  delete scope.curve_bn128;
  if (curve === undefined) {
    return;
  }
  try {
    await curve.terminate();
  } catch {
    // Already terminated, or its threads are gone: nothing left to release.
  }
}

/** The four signals {@link fixtureStay} reads. */
interface StaySignals {
  readonly cityId: string;
  readonly arrivalDate: string;
  readonly departureDate: string;
  readonly nullifier: string;
}

/** Reads those signals by name, so no index is written down twice (AAP 0.5.5). */
function staySignals(submission: ProofSubmission): StaySignals {
  const at = (name: PublicSignalName): string => {
    const value = submission.publicSignals[PUBLIC_SIGNAL_NAMES.indexOf(name)];
    if (value === undefined) {
      throw new Error(`fixture proof: the ${name} public signal is missing`);
    }
    return value;
  };
  return {
    cityId: at('cityId'),
    arrivalDate: at('arrivalDate'),
    departureDate: at('departureDate'),
    nullifier: at('nullifier'),
  };
}

/** A `YYYYMMDD` signal as the `YYYY-MM-DD` date the API stores and answers with. */
function isoDate(value: string): string {
  if (!CIRCUIT_DATE.test(value)) {
    throw new Error('fixture proof: a date signal is not a circuit date');
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}
