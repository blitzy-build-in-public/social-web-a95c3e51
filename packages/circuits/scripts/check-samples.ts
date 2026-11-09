/**
 * The real-issuer sample check, `pnpm circuits:samples [issuer]` (AAP 0.5.5, AAP 0.12.3).
 *
 * The gate that decides whether an issuer may claim a production registry leaf: for every user-supplied confirmation
 * in the git-ignored `packages/circuits/samples/<issuer>/` it builds the witness, proves it with `groth16.fullProve`
 * and verifies the proof against the built artefacts, against a registry assembled in memory that includes the issuer
 * whatever its verification status. Only once every sample passes may the record carry
 * `"verificationStatus": "verified"`, and this script never edits it: promotion is an explicit operator act that
 * `pnpm circuits:registry` turns into a leaf.
 * Privacy: samples are real personal confirmation emails, so nothing about a sample's content reaches stdout, a log or
 * a document. A sample is named by its position and the first eight hex of its SHA-256, and a refusal prints a
 * `CircuitInputError` code — and, for a stay field, that field's own slot name — never a header, a value, an offset or
 * a parser's message.
 * A real email whose stay fields sit above the provable body window fails with `field_not_found`: the signal AAP 0.2.4
 * expects, not a defect here.
 */
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';

import { PUBLIC_SIGNAL_NAMES } from '@tablemate/shared';
import type { RegistryFile } from '@tablemate/shared';

import { buildCircuitInputs, buildEmailVerifierInputs } from '../src/inputs/build-inputs.ts';
import type { CircuitInputs } from '../src/inputs/build-inputs.ts';
import { CircuitInputError, fail } from '../src/inputs/eml-parse.ts';
import type { CircuitInputErrorCode } from '../src/inputs/eml-parse.ts';
import { locateField, parseDateValue } from '../src/inputs/template-locate.ts';
import { buildRegistry } from '../src/registry/merkle.ts';
import { TEMPLATE_FIELD_ORDER, templateParams } from '../src/registry/template-hash.ts';
import type { TemplateParams } from '../src/registry/template-hash.ts';
import { PKG_DIR, loadCities, loadIssuers } from './build-registry.ts';
import type { LoadedIssuer } from './build-registry.ts';

/** The samples' directory, repository-relative: git-ignored and user-supplied, so a message names a directory. */
const SAMPLES_DIR = 'packages/circuits/samples';

/** The command line, printed on stderr whenever the arguments do not match it. */
const USAGE = 'usage: pnpm circuits:samples [issuer]';

/**
 * The salt a booking reference is hashed with. Any field element works: this check proves to nobody, so the nullifier
 * it computes is discarded and never published.
 */
const SAMPLE_CHECK_SALT = '1';

/** The artefacts `pnpm circuits:build` writes into the git-ignored `build/`. */
const WASM = 'tablemate_itinerary.wasm';
const ZKEY = 'tablemate_itinerary.zkey';
const VKEY = 'verification_key.json';
const ARTEFACTS = [WASM, ZKEY, VKEY];

/** The heap below which a full proof is not expected to fit: snarkjs holds the proving key, the
 * witness and its prover buffers at once, so a smaller heap is warned about and never fatal. */
const LARGE_HEAP_BYTES = 8 * 1024 ** 3;
const LARGE_HEAP_OPTION = 'NODE_OPTIONS=--max-old-space-size=16384';

/** How many samples of one issuer are worth trusting: one confirmation proves very little. */
const RECOMMENDED_SAMPLES = 3;

/** A sample's label: this many hex characters of its digest, instead of its file name. */
const DIGEST_PREFIX = 8;

/** The four field slots of {@link TEMPLATE_FIELD_ORDER}, as literal indexes `locateField` accepts. */
const FIELD_INDEXES = [0, 1, 2, 3] as const;

/**
 * How long a drain may wait for the reader of stdout and stderr before the process is ended anyway (one second): a
 * consumer that never reads — a stopped `tee`, a detached log collector — must not hold the sample check open.
 */
const EXIT_DRAIN_TIMEOUT_MS = 1_000;

/**
 * The one part of snarkjs 0.7.6 this script uses, narrowed here because the package ships no declarations: `verify`
 * takes the parsed verification key object rather than the path to it.
 */
interface Snarkjs {
  readonly groth16: {
    fullProve(
      input: CircuitInputs,
      wasm: string,
      zkey: string,
    ): Promise<{ proof: unknown; publicSignals: string[] }>;
    verify(verificationKey: unknown, publicSignals: string[], proof: unknown): Promise<boolean>;
  };
}

/** One stage's outcome: the value it produced, or the code that refused the sample. */
type StageResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: CircuitInputErrorCode };

/** Everything one issuer's samples are checked against, built once per issuer. */
interface SampleJob {
  /** The loaded `config/issuers/<stem>.json` record, whose repository-relative path an error names. */
  readonly record: LoadedIssuer;
  /** The issuer's template parameters, which `templateParams` validated at selection time. */
  readonly params: TemplateParams;
  /** An ad-hoc `test` registry that includes the issuer; used in memory, never written. */
  readonly registry: RegistryFile;
  /** The directory the issuer's samples sit in. */
  readonly directory: string;
  /** Those samples' file names, sorted: the order they are checked and numbered in. */
  readonly samples: readonly string[];
}

/** Runs the check over every selected issuer: 0 only when every sample of every issuer passed. */
async function checkSamples(stem: string | undefined): Promise<number> {
  const jobs = await selectJobs(stem);
  await requireArtefacts();
  warnOnSmallHeap();
  let passed = 0;
  let failed = 0;
  for (const job of jobs) {
    const tally = await checkIssuer(job);
    passed += tally.passed;
    failed += tally.failed;
    process.stdout.write(`${job.record.stem}: ${tally.passed} passed, ${tally.failed} failed\n`);
  }
  if (failed > 0) {
    process.stdout.write(`${failed} of ${passed + failed} sample(s) failed\n`);
    return 1;
  }
  for (const job of jobs) {
    process.stdout.write(
      `All samples pass. Set "verificationStatus": "verified" in config/issuers/${job.record.stem}.json, ` +
        'run pnpm circuits:registry, and commit both. Update the issuer status in docs/zk-proofs.md.\n',
    );
    if (job.samples.length < RECOMMENDED_SAMPLES) {
      process.stdout.write(
        `Only ${job.samples.length} sample(s) of ${job.record.stem}: at least ` +
          `${RECOMMENDED_SAMPLES} are recommended before promoting an issuer.\n`,
      );
    }
  }
  return 0;
}

/**
 * Selects the work: the named issuer, or every `samples/` subdirectory that holds an `.eml` file. A selected stem must
 * match a `config/issuers/<stem>.json` record carrying a template and a key with a modulus, and it must hold a sample,
 * because an issuer whose samples never arrived has nothing to check (AAP 0.12.3). Every refusal names a configuration
 * path or a samples directory, never a file.
 */
async function selectJobs(stem: string | undefined): Promise<SampleJob[]> {
  const stems = stem === undefined ? await sampleStems() : [stem];
  if (stems.length === 0) {
    throw new Error(`no .eml samples in ${SAMPLES_DIR}/ (git-ignored, user-supplied)`);
  }
  const [issuers, cities] = await Promise.all([loadIssuers(), loadCities()]);
  const jobs: SampleJob[] = [];
  for (const name of stems) {
    const record = issuers.find((issuer) => issuer.stem === name);
    if (record === undefined) {
      throw new Error(
        `unknown issuer ${name}; known issuers: ${issuers.map((issuer) => issuer.stem).join(', ')}`,
      );
    }
    const template = record.config.template;
    if (template === null) {
      throw new Error(
        `${record.path}: records no template; author it from the samples (anchors, terminators, ` +
          `charsets, date format) and then run fetch-dkim-key -- ${name} --write`,
      );
    }
    // A key still holding the empty modulus placeholder records no leaf either, so it is no more usable than a
    // missing key and would fail inside the registry build.
    if (!record.config.keys.some((key) => key.modulusBase64.trim() !== '')) {
      throw new Error(
        `${record.path}: records no DKIM key with a modulus; run fetch-dkim-key -- ${name} --write`,
      );
    }
    const directory = path.join(PKG_DIR, 'samples', name);
    const samples = await sampleFiles(directory);
    if (samples.length === 0) {
      throw new Error(`no .eml samples in ${SAMPLES_DIR}/${name}/ (git-ignored, user-supplied)`);
    }
    jobs.push({
      record,
      params: templateParams(template),
      registry: buildRegistry({ name: 'test', issuers: [record.config], cities: cities.cities })
        .registry,
      directory,
      samples,
    });
  }
  return jobs;
}

/** Runs every sample of one issuer, in name order, and counts the outcomes. */
async function checkIssuer(job: SampleJob): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;
  for (const [index, name] of job.samples.entries()) {
    if (await checkSample(job, index + 1, name)) {
      passed += 1;
    } else {
      failed += 1;
    }
  }
  return { passed, failed };
}

/**
 * Runs one sample: its label, then one line per stage. Every field is checked before anything is proved, so a sample
 * the circuit could not accept never costs a proving run (AAP 0.5.5).
 */
async function checkSample(job: SampleJob, number: number, name: string): Promise<boolean> {
  const bytes = await readFile(path.join(job.directory, name));
  process.stdout.write(`sample #${number} (${digestPrefix(bytes)})\n`);
  const inputs = stage('inputs', () => buildEmailVerifierInputs(bytes, [job.record.config]));
  if (!inputs.ok) return false;
  if (!checkFields(inputs.value.decodedEmailBodyIn, job.params)) return false;
  const built = stage('registry', () =>
    buildCircuitInputs(bytes, [job.record.config], job.registry, {
      nullifierSalt: SAMPLE_CHECK_SALT,
    }),
  );
  if (!built.ok) {
    if (built.code === 'city_not_supported') {
      process.stdout.write(
        '    hint: the city alias is not in config/cities.json; add it and run pnpm circuits:registry\n',
      );
    }
    return false;
  }
  const started = performance.now();
  const verified = await proveInputs(built.value.inputs, job.record.config.issuerId);
  process.stdout.write(`  proving: ${secondsSince(started)}s\n`);
  return verified;
}

/**
 * Locates the four stay fields and parses both dates, printing one line per field and checking all four so a sample
 * reports them together.
 *
 * The circuit reads the fields from the decoded body window alone: an anchor the window carries twice is
 * `field_ambiguous`, one it never carries is `field_not_found`. Both dates are read with the template's one layout, so
 * a value the circuit could not parse is refused here rather than inside witness generation.
 */
function checkFields(decoded: Uint8Array, params: TemplateParams): boolean {
  let complete = true;
  for (const index of FIELD_INDEXES) {
    const field = TEMPLATE_FIELD_ORDER[index];
    const located = stage(field, () => {
      const location = locateField(decoded, params, index);
      if (field === 'arrival' || field === 'departure') {
        if (parseDateValue(location.value, location.valueLength, params.dateFormat) === null) {
          fail('field_invalid', field);
        }
      }
      return location;
    });
    if (!located.ok) complete = false;
  }
  return complete;
}

/**
 * Proves the witness and verifies the proof against the built artefacts.
 *
 * The public signals are checked before the proof is verified: the circuit's output list fixes their number and their
 * order, so a proof carrying other signals is not this proof whatever the verifier would say about it.
 */
async function proveInputs(inputs: CircuitInputs, issuerId: number): Promise<boolean> {
  const prover = createRequire(import.meta.url)('snarkjs') as Snarkjs;
  let proved: { proof: unknown; publicSignals: string[] };
  try {
    proved = await prover.groth16.fullProve(inputs, artefact(WASM), artefact(ZKEY));
  } catch (error) {
    // A circom assertion names a template and a line and carries no email data: this line only records that
    // producing the proof failed.
    process.stdout.write(`  witness: FAIL ${errorName(error)}\n`);
    return false;
  }
  process.stdout.write('  witness: PASS\n');
  const signals = proved.publicSignals;
  if (
    signals.length !== PUBLIC_SIGNAL_NAMES.length ||
    signals[PUBLIC_SIGNAL_NAMES.indexOf('issuerId')] !== String(issuerId)
  ) {
    process.stdout.write('  proof: FAIL public_signals\n');
    return false;
  }
  process.stdout.write('  proof: PASS\n');
  // Parsed before the verifier is called, so a corrupted artefact reports itself rather than a failed proof.
  const verificationKey = await readVerificationKey();
  try {
    const verified = await prover.groth16.verify(verificationKey, signals, proved.proof);
    process.stdout.write(`  verify: ${verified ? 'PASS' : 'FAIL'}\n`);
    return verified;
  } catch (error) {
    process.stdout.write(`  verify: FAIL ${errorName(error)}\n`);
    return false;
  }
}

/**
 * Runs one synchronous stage and prints its line: `  <name>: PASS`, or `  <name>: FAIL <code>` when the input generator
 * refused the sample. Anything else `run` raises is a defect and propagates.
 */
function stage<T>(name: string, run: () => T): StageResult<T> {
  try {
    const value = run();
    process.stdout.write(`  ${name}: PASS\n`);
    return { ok: true, value };
  } catch (error) {
    if (!(error instanceof CircuitInputError)) throw error;
    process.stdout.write(`  ${name}: FAIL ${error.code}\n`);
    return { ok: false, code: error.code };
  }
}

/** Requires the artefacts `pnpm circuits:build` writes, naming every one that is missing. */
async function requireArtefacts(): Promise<void> {
  const missing: string[] = [];
  for (const name of ARTEFACTS) {
    if (!(await exists(artefact(name)))) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(`missing build/${missing.join(', build/')}; run pnpm circuits:build first`);
  }
}

/** Warns, and never aborts, when node's heap is below what a full proof of this circuit needs. */
function warnOnSmallHeap(): void {
  const limit = getHeapStatistics().heap_size_limit;
  if (limit < LARGE_HEAP_BYTES) {
    process.stderr.write(
      `warning: node's heap limit is ${Math.round(limit / 1024 ** 2)} MB and proving this circuit ` +
        `needs more; run with ${LARGE_HEAP_OPTION}\n`,
    );
  }
}

/** The `samples/` subdirectories that hold at least one `.eml` file, sorted by name. */
async function sampleStems(): Promise<string[]> {
  const root = path.join(PKG_DIR, 'samples');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const stems: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if ((await sampleFiles(path.join(root, entry.name))).length > 0) stems.push(entry.name);
  }
  return stems.sort();
}

/** The `.eml` file names in one directory, sorted; empty for a directory that does not exist, which is the ordinary
 * state of a checkout awaiting the user's confirmation emails (AAP 0.12.3). */
async function sampleFiles(directory: string): Promise<string[]> {
  const names = await readdir(directory).catch(() => []);
  return names.filter((name) => name.toLowerCase().endsWith('.eml')).sort();
}

/** The parsed `build/verification_key.json`, as `groth16.verify` needs the object and not the path. */
async function readVerificationKey(): Promise<unknown> {
  const text = await readFile(artefact(VKEY), 'utf8').catch(() => {
    throw new Error(`build/${VKEY} cannot be read; run pnpm circuits:build first`);
  });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`build/${VKEY} is not valid JSON; run pnpm circuits:build first`);
  }
}

/** The absolute path of one artefact in the git-ignored `packages/circuits/build/`. */
function artefact(name: string): string {
  return path.join(PKG_DIR, 'build', name);
}

/** Whether a path exists, for a directory whose absence is the ordinary state of a checkout. */
async function exists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/** A sample's label: the first {@link DIGEST_PREFIX} hex of its SHA-256, never its file name. */
function digestPrefix(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, DIGEST_PREFIX);
}

/** A span since `started` in seconds, one decimal: diagnostic only, as AAP 0.5.5 records proving. */
function secondsSince(started: number): string {
  return ((performance.now() - started) / 1000).toFixed(1);
}

/** A caught error's class name: the only thing printed about a failure inside proving. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A caught value's message, for the one line a failure prints. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the command line: at most one positional issuer stem, with the bare `--` a package script separates its
 * arguments with ignored.
 */
function parseArgs(argv: readonly string[]): string | undefined {
  const args = argv.filter((argument) => argument !== '--');
  const positional = args.filter((argument) => !argument.startsWith('-'));
  const options = args.filter((argument) => argument.startsWith('-'));
  const [stem, ...extra] = positional;
  if (options.length > 0 || extra.length > 0) {
    process.stderr.write(`${USAGE}\n`);
    throw new Error(`unexpected argument ${[...options, ...extra].join(' ')}`);
  }
  return stem;
}

/**
 * Ends the process with `code` once every byte already written to stdout and stderr has reached its consumer.
 *
 * A write to a pipe is completed by the event loop, so `process.exit()` discards whatever is still queued — under
 * `| tee` or a CI log collector that is the last, machine-readable line this script exists to print. An empty write
 * queued behind the real ones calls back once they have flushed, and {@link EXIT_DRAIN_TIMEOUT_MS} bounds a consumer
 * that never drains.
 */
function exitAfterFlush(code: number): void {
  process.exitCode = code;

  const draining = new Set<NodeJS.WriteStream>();
  if (process.stdout.writableLength > 0) draining.add(process.stdout);
  if (process.stderr.writableLength > 0) draining.add(process.stderr);

  if (draining.size === 0) {
    // Nothing is queued: every byte reached its consumer as it was written (a terminal, a file).
    process.exit(code);
    return;
  }

  const bound = setTimeout(() => process.exit(code), EXIT_DRAIN_TIMEOUT_MS);
  bound.unref();

  const finish = (stream: NodeJS.WriteStream): void => {
    draining.delete(stream);
    if (draining.size === 0) {
      clearTimeout(bound);
      process.exit(code);
    }
  };

  for (const stream of [...draining]) {
    stream.once('error', () => {
      finish(stream);
    });
    stream.write('', () => {
      finish(stream);
    });
  }
}

/**
 * Runs the command line. Every failure is reported as `check-samples: <message>` with exit code 1, and no failure
 * prints a stack trace or a byte of a sample.
 */
async function main(): Promise<void> {
  let code = 1;
  try {
    code = await checkSamples(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`check-samples: ${reasonOf(error)}\n`);
  }
  // snarkjs and ffjavascript keep worker threads alive, so node is ended explicitly: setting process.exitCode alone
  // would leave the process hanging, and draining first keeps the last line from being discarded when stdout is a pipe.
  exitAfterFlush(code);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main();
}
