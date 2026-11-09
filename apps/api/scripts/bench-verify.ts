/**
 * `bench-verify` — the server-side proof-verification benchmark (AAP 0.5.5, 0.8.1, 0.12.1 criterion 4).
 *
 * ```sh
 * pnpm --filter @tablemate/api bench:verify                                  # measure, record, report
 * pnpm --filter @tablemate/api bench:verify -- --prepare [--api-url <url>]    # prepare only
 * node --enable-source-maps apps/api/dist/scripts/bench-verify.js --measure <file> [--api-url <url>]
 * ```
 *
 * AAP 0.5.5 fixes what to measure: 1,000 `verifyItineraryProof` calls inside the `api` container and 30
 * route-level `POST /itinerary-proofs` calls with unique fixture proofs, reporting p50 and p95 against
 * p95 ≤ 500 ms, recorded in `docs/zk-performance.md` (AAP 0.12.1). AAP 0.12.3 is why a run that cannot
 * measure writes nothing there: no pass without a measurement.
 *
 * The default mode prepares, measures inside the `api` service and rewrites the document; it wants a
 * compose stack up as `APP_ENV=test ZK_ALLOW_TEST_ISSUER=true` and a built `dist/scripts`. `--prepare`
 * runs on the host or the image's `test-support` target and writes the git-ignored
 * `.local/bench/proofs.json`. `--measure` runs in the `api` runtime container and prints one
 * `BENCH_VERIFY_RESULT {…}` line on stdout, which the orchestration parses.
 *
 * Two invariants shape the code. Nothing here proves: the runtime image holds no proving key and
 * `apps/api/src/**` holds no proving call, so the proofs come from the `test-support` harness, imported
 * dynamically inside the prepare branch alone because the image ships no `dist/test`; and no line ever
 * carries a token, an email address, a private input or a proof byte, only counts, timings and codes
 * (AAP 0.11.1, 0.12.2). One booking yields one proof, so the 31 proofs alternate the two fixtures the
 * discarded DKIM key signed (AAP 0.4.2) with `{ fresh: true }`, and the route series spends and releases
 * one booking per call: proof 0 joins the direct series, proofs 1–30 are the 30 unique submissions.
 *
 * @see AAP 0.5.5 for the verification measured, 0.12.1 criterion 4 for the pass condition, 0.11.2 for
 *   the suite row and the container, 0.11.1 for the injected clock, 0.4.2 for the fixtures.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { z } from 'zod';

import {
  ErrorEnvelope,
  FieldElement,
  HOUR_MS,
  IsoDateTime,
  PUBLIC_SIGNAL_NAMES,
  ProofAccepted,
  ProofSubmission,
  ZkConfig,
} from '@tablemate/shared';
import {
  EnvValidationError,
  createLogger,
  emailLookupHash,
  encryptField,
  loadApiEnv,
  randomToken,
  sha256Hex,
  systemClock,
} from '@tablemate/server-core';

import { buildApp } from '../src/app.ts';
import { signAccessToken } from '../src/plugins/auth.ts';
import {
  TEST_ISSUER_STEM,
  findRepoRoot,
  readIssuerConfigs,
} from '../src/modules/proofs/registry.ts';
import { closeVerifier, verifyItineraryProof } from '../src/modules/proofs/verifier.ts';

import type { ApiEnv } from '@tablemate/server-core';
import type { DbClient } from '@tablemate/db';
import type { App, AppServices } from '../src/app.ts';
import type { IssuerConfigEntry } from '../src/modules/proofs/registry.ts';
import type { FixtureName } from '../test/support/proofs.ts';

const COMMAND = 'bench-verify';
const LOGGER_NAME = 'bench-verify';
const PREPARE_FLAG = '--prepare';
const MEASURE_FLAG = '--measure';
const API_URL_FLAG = '--api-url';
/** Ignored rather than refused: `pnpm run` forwards the `--` of `pnpm … bench:verify -- <flags>`. */
const OPTIONS_SEPARATOR = '--';
const USAGE_LINE =
  `usage: ${COMMAND} [${API_URL_FLAG} <url>]\n` +
  `       ${COMMAND} ${PREPARE_FLAG} [${API_URL_FLAG} <url>]\n` +
  `       ${COMMAND} ${MEASURE_FLAG} <file> [${API_URL_FLAG} <url>]\n`;

/** The host default is the compose stack's published `API_PORT`; the container default is itself. */
const DEFAULT_HOST_API_URL = 'http://localhost:3000';
const DEFAULT_CONTAINER_API_URL = 'http://127.0.0.1:3000';
const ZK_CONFIG_PATH = '/v1/zk/config';
const PROOF_PATH = '/v1/itinerary-proofs';
const PROOF_ACCEPTED_STATUS = 201;
/** The signal the route series reads to find the booking a proof spent (AAP 0.5.5). */
const NULLIFIER_SIGNAL = PUBLIC_SIGNAL_NAMES.indexOf('nullifier');

const VERIFY_SAMPLES = 1_000;
const VERIFY_WARMUP = 1;
const ROUTE_SAMPLES = 30;
/** One proof per route submission plus the one the direct series shares with them, so 31 in all. */
const PROOF_COUNT = ROUTE_SAMPLES + 1;
const TARGET_P95_MS = 500;
const FIRST_FIXTURE: FixtureName = 'valid';
const SECOND_FIXTURE: FixtureName = 'valid-second';

/** Where the prepared proofs are written; `.local/` is git-ignored, and mode 0600 is what it holds. */
const PROOF_FILE = '.local/bench/proofs.json';
const PROOF_FILE_MODE = 0o600;
const CONTAINER_PROOF_FILE = '/tmp/bench-verify-proofs.json';
const MEASURE_ENTRY = 'apps/api/dist/scripts/bench-verify.js';
const DOCKER = 'docker';
const COMPOSE = 'compose';
const API_SERVICE = 'api';
const GIT = 'git';
const RESULT_PREFIX = 'BENCH_VERIFY_RESULT ';
/** The most output one child command may write, so a runaway container cannot exhaust this process. */
const COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
/** How long the app's shutdown may take before the process exits regardless (five seconds). */
const CLOSE_TIMEOUT_MS = 5_000;

/**
 * How long a drain may wait for the reader of stdout and stderr before the process is ended anyway
 * (one second). A consumer that never reads — a stopped `tee`, a detached log collector — must not
 * hold the run open once the measurement is taken.
 */
const EXIT_DRAIN_TIMEOUT_MS = 1_000;

/** Handles `bench_01`…`bench_30`: the prefix this script's own cleanup finds its accounts by. */
const HANDLE_PREFIX = 'bench_';
const HANDLE_DIGITS = 2;
const EMAIL_PREFIX = 'bench-';
const EMAIL_DOMAIN = 'bench.invalid';
const SESSION_TTL_MS = HOUR_MS;

const DOCS_FILE = 'docs/zk-performance.md';
const DOCS_TITLE = '# ZK performance';
const DOCS_SECTION = '## Server verification';
const BLOCK_BEGIN = '<!-- BEGIN bench-verify -->';
const BLOCK_END = '<!-- END bench-verify -->';
const MODE_LINE = 'APP_ENV=test, fixture proofs of the test issuer';
const TARGET_LINE = `p95 ≤ ${TARGET_P95_MS} ms`;

/**
 * The prepared proof file: the published salt the proofs were proved against, when they were produced,
 * and the submissions — `{ proof, publicSignals }` and nothing else (AAP 0.12.2).
 */
const BenchProofFile = z.object({
  nullifierSalt: FieldElement,
  generatedAt: IsoDateTime,
  proofs: z.array(ProofSubmission).length(PROOF_COUNT),
});
type BenchProofFile = z.infer<typeof BenchProofFile>;

/** The result the container reports on its single stdout line, parsed back by the orchestration. */
const BenchResult = z.object({
  appEnv: z.string(),
  node: z.string(),
  cpu: z.object({ model: z.string(), cores: z.number().int().positive() }),
  verify: z.object({
    warmup: z.number().int(),
    samples: z.number().int().positive(),
    p50Ms: z.number(),
    p95Ms: z.number(),
    maxMs: z.number(),
  }),
  route: z.object({
    samples: z.number().int().positive(),
    p50Ms: z.number(),
    p95Ms: z.number(),
    maxMs: z.number(),
  }),
});
type BenchResult = z.infer<typeof BenchResult>;

/** One measured series: its sample count and the three percentiles the record reports. */
interface SeriesStats {
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

/** The direct series as the result line carries it: the same statistics plus its warm-up count. */
interface ResultVerify extends SeriesStats {
  readonly warmup: number;
}

/** One bench account: the session its access token is signed for. */
interface BenchUser {
  readonly id: string;
  readonly sessionId: string;
  readonly accessToken: string;
}

/** What the command line asked for. */
interface Invocation {
  readonly mode: 'orchestrate' | 'prepare' | 'measure';
  readonly apiUrl: string | null;
  readonly proofFile: string | null;
}

/** What one child command answered. */
interface CommandResult {
  readonly failed: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** A refusal this file decided: the step it happened in, and a reason that carries no value. */
class BenchFailure extends Error {
  constructor(
    readonly step: string,
    readonly reason: string,
  ) {
    super(`${step}: ${reason}`);
    this.name = 'BenchFailure';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * End the process with `code` once every byte already written to stdout and stderr has reached its
 * consumer.
 *
 * A write to a pipe is completed by the event loop, so `process.exit()` discards whatever is still
 * queued — and under `| tee` or a CI log collector that is the last, machine-readable line this
 * script exists to print. An empty write queued behind the real ones calls back once they have been
 * flushed, and {@link EXIT_DRAIN_TIMEOUT_MS} bounds a consumer that never drains. A consumer that has
 * stopped reading closes the pipe instead (`| head`), which ends the drain the same way: the status
 * this script decided is what stands in either case.
 *
 * @param code - the status the explicit exit this replaces carried.
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

exitAfterFlush(await run(process.argv.slice(2)));

/**
 * Run the mode the arguments selected and answer this process's exit code.
 *
 * `0` covers a recorded measurement and one that missed its target alike, because a miss is a result
 * recorded as `fail` (AAP 0.12.1). Only a refusal answers `1`, with one `<step>: <reason>` line.
 */
async function run(argv: readonly string[]): Promise<number> {
  const invocation = parseArguments(argv);
  if (invocation === null) {
    process.stderr.write(USAGE_LINE);
    return 1;
  }

  try {
    if (invocation.mode === 'prepare') {
      const outPath = await prepare(invocation);
      process.stdout.write(
        `${COMMAND}: prepared ${PROOF_COUNT} fixture proofs -> ${displayPath(outPath)}\n`,
      );
      return 0;
    }

    if (invocation.mode === 'measure') {
      const result = await measure(invocation);
      process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
      return 0;
    }

    return await orchestrate(invocation);
  } catch (error) {
    return error instanceof BenchFailure
      ? refuse(error.step, error.reason)
      : refuse('run', failureToken(error));
  }
}

/**
 * Read the argument list: the three flags, each taking the value that follows it, and `--` skipped.
 *
 * `--prepare` and `--measure` are mutually exclusive — the two halves of one sequence, where the second
 * needs the file the first writes. A repeated flag keeps its last value.
 *
 * @returns what to run, or `null` for a usage error.
 */
function parseArguments(argv: readonly string[]): Invocation | null {
  let prepare = false;
  let proofFile: string | null = null;
  let apiUrl: string | null = null;

  for (let position = 0; position < argv.length; position += 1) {
    const argument = argv[position];
    if (argument === OPTIONS_SEPARATOR) continue;
    if (argument === PREPARE_FLAG) {
      prepare = true;
      continue;
    }
    if (argument !== MEASURE_FLAG && argument !== API_URL_FLAG) return null;

    const value = argv[position + 1];
    if (value === undefined || value === '') return null;
    position += 1;
    if (argument === MEASURE_FLAG) proofFile = value;
    else apiUrl = value;
  }

  if (prepare && proofFile !== null) return null;
  if (prepare) return { mode: 'prepare', apiUrl, proofFile: null };
  if (proofFile !== null) return { mode: 'measure', apiUrl, proofFile };
  return { mode: 'orchestrate', apiUrl, proofFile: null };
}

/**
 * Prove the fixture bookings and write the file the measuring half reads (AAP 0.5.5).
 *
 * The nullifier salt comes from the running API's own `GET /v1/zk/config`, never from an environment
 * this process reads, so the proofs a stack verifies are built against exactly the salt and registry it
 * publishes and a file prepared for another stack is refused at measurement rather than quietly proving
 * something else. The test issuer must be published — which the API does only as `APP_ENV=test` with
 * `ZK_ALLOW_TEST_ISSUER=true` — because the fixtures' registry root is accepted only then.
 *
 * @returns the absolute path of the file written.
 * @throws {BenchFailure} `prepare` when the API is unreachable, withholds the test issuer, the issuer
 *   configuration cannot be read, or the artefacts are missing (the harness names `pnpm circuits:build`).
 */
async function prepare(invocation: Invocation): Promise<string> {
  const apiUrl = apiUrlFor(invocation, DEFAULT_HOST_API_URL);
  const config = await fetchZkConfig(apiUrl);
  const testIssuer = testIssuerId();

  if (!config.issuers.some((issuer) => issuer.issuerId === testIssuer)) {
    throw new BenchFailure(
      'prepare',
      'the api service is not running with APP_ENV=test and ZK_ALLOW_TEST_ISSUER=true',
    );
  }

  // Loaded inside this branch alone: these proofs come from the test harness, and the runtime image
  // ships no `dist/test`, so a static import here would be one the container could not resolve.
  const { fixtureProof, releaseProverCurve } = await import('../test/support/proofs.ts');

  try {
    const proofs: ProofSubmission[] = [];
    for (let index = 0; index < PROOF_COUNT; index += 1) {
      const name = index % 2 === 0 ? FIRST_FIXTURE : SECOND_FIXTURE;
      proofs.push(await fixtureProof(name, { salt: config.nullifierSalt, fresh: true }));
      progress(`proof ${index + 1}/${PROOF_COUNT}`);
    }

    const outPath = path.join(findRepoRoot(), PROOF_FILE);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(
      outPath,
      JSON.stringify({
        nullifierSalt: config.nullifierSalt,
        generatedAt: systemClock.now().toISOString(),
        proofs,
      }),
      { mode: PROOF_FILE_MODE },
    );
    return outPath;
  } catch (error) {
    throw new BenchFailure(
      'prepare',
      error instanceof Error ? error.message : 'the fixture proofs could not be produced',
    );
  } finally {
    // This process proves and then exits, so it releases the curve it built rather than leaving its
    // worker threads to hold the process open.
    await releaseProverCurve();
  }
}

/** The public ZK configuration the running API publishes, parsed (AAP 0.5.4). */
async function fetchZkConfig(apiUrl: string): Promise<ZkConfig> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${ZK_CONFIG_PATH}`, {
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new BenchFailure('prepare', `the api service is not reachable at ${apiUrl}`);
  }

  if (response.status !== 200) {
    throw new BenchFailure('prepare', `GET ${ZK_CONFIG_PATH} answered ${response.status}`);
  }

  const parsed = ZkConfig.safeParse(await readJson(response));
  if (!parsed.success) {
    throw new BenchFailure('prepare', `GET ${ZK_CONFIG_PATH} is not the published configuration`);
  }
  return parsed.data;
}

/** The synthetic test issuer's id, read from its own record rather than written down here. */
function testIssuerId(): number {
  let entry: IssuerConfigEntry | undefined;
  try {
    entry = readIssuerConfigs().find((candidate) => candidate.stem === TEST_ISSUER_STEM);
  } catch (error) {
    throw new BenchFailure(
      'prepare',
      error instanceof Error ? error.message : 'the issuer configuration cannot be read',
    );
  }

  if (entry === undefined) {
    throw new BenchFailure('prepare', `config/issuers/${TEST_ISSUER_STEM}.json is missing`);
  }
  return entry.config.issuerId;
}

/**
 * Measure both series inside the `api` runtime container and answer the result line's payload.
 *
 * This half refuses anything but a test stack, for the two reasons AAP 0.12.2 fixes: the fixture proofs
 * name the test registry root, which `verifyItineraryProof` accepts only under `APP_ENV=test` and
 * `ZK_ALLOW_TEST_ISSUER=true`, and the route series deletes `spent_nullifier` rows, acceptable only
 * where the data is disposable.
 *
 * The app is built and never started as a server — `startBackground` is deliberately not called, so this
 * process holds no worker, sweeper, poller or socket of its own and the API already listening in this
 * container keeps serving the route series underneath — and the logger is given stderr, which leaves
 * stdout for the one result line.
 *
 * @throws {BenchFailure} `measure` for every refusal, each naming its step.
 */
async function measure(invocation: Invocation): Promise<BenchResult> {
  const env = requireTestEnvironment();

  if (invocation.proofFile === null) {
    throw new BenchFailure('measure', 'no prepared proof file was given');
  }
  const file = await readBenchProofFile(invocation.proofFile, env.NULLIFIER_SALT);

  const logger = createLogger({
    name: LOGGER_NAME,
    level: 'warn',
    appEnv: env.APP_ENV,
    destination: process.stderr,
  });
  const app = buildApp({ env, logger });

  try {
    await app.ready();
    const verify = await measureVerify(app.services, file.proofs);
    const route = await measureRoute(app.services, env, invocation, file.proofs);
    return resultFor(env, verify, route);
  } finally {
    await closeBounded(app);
    // `app.close()` closes the queues, the connections and Prisma; the BN254 curve this process built is
    // released here, because its worker threads would otherwise outlive the result line.
    await closeVerifier();
  }
}

/** The `api` configuration of this process, refused unless it is a test stack (AAP 0.6.2, 0.12.2). */
function requireTestEnvironment(): ApiEnv {
  let env: ApiEnv;
  try {
    env = loadApiEnv();
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error;
    throw new BenchFailure('measure', error.message);
  }

  if (env.APP_ENV !== 'test' || !env.testOnly.zkAllowTestIssuer) {
    throw new BenchFailure(
      'measure',
      'APP_ENV=test and ZK_ALLOW_TEST_ISSUER=true are required to measure with fixture proofs',
    );
  }
  return env;
}

/**
 * Read and validate the prepared proof file, and check it belongs to this stack.
 *
 * The file's salt is compared with this process's published `NULLIFIER_SALT`: the verifier would reject
 * proofs from another stack anyway, but as a series of failures rather than as one clear message.
 */
async function readBenchProofFile(file: string, salt: string): Promise<BenchProofFile> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new BenchFailure('measure', `the prepared proof file cannot be read at ${file}`);
  }

  const result = BenchProofFile.safeParse(parseJson(text));
  if (!result.success) {
    throw new BenchFailure(
      'measure',
      `the prepared proof file is not ${PROOF_COUNT} proofs of the contract's shape`,
    );
  }

  if (result.data.nullifierSalt !== salt) {
    throw new BenchFailure('measure', 'the proofs were prepared against a different stack');
  }
  return result.data;
}

/**
 * The direct series: one unmeasured warm-up call, then `VERIFY_SAMPLES` timed ones (AAP 0.5.5).
 *
 * The warm-up is what the recorded figure stands on: the first call builds the process-wide BN254 curve
 * and reads the mounted verification key, costs an order of magnitude more than the pairing check that
 * follows, and would otherwise land in the first sample. The measured calls cycle all 31 proofs, so both
 * bookings are exercised throughout.
 */
async function measureVerify(
  services: AppServices,
  proofs: readonly ProofSubmission[],
): Promise<ResultVerify> {
  for (let index = 0; index < VERIFY_WARMUP; index += 1) {
    await timedVerify(services, proofs, index);
  }

  const durations: number[] = [];
  for (let index = 0; index < VERIFY_SAMPLES; index += 1) {
    durations.push(await timedVerify(services, proofs, index));
  }

  return { warmup: VERIFY_WARMUP, ...stats(durations) };
}

/** One verification, timed. The rejection's code is the whole message: never a signal or a proof byte. */
async function timedVerify(
  services: AppServices,
  proofs: readonly ProofSubmission[],
  index: number,
): Promise<number> {
  const submission = proofs[index % proofs.length];
  if (submission === undefined) {
    throw new BenchFailure('verify', 'no prepared proof at that position');
  }

  const started = performance.now();
  try {
    await verifyItineraryProof(services, submission);
  } catch (error) {
    // The verifier's own codes are the diagnosis: `proof_invalid`, `issuer_not_allowlisted`, or
    // `service_unavailable` when the verification key is not mounted (AAP 0.5.5).
    throw new BenchFailure('verify', failureToken(error));
  }
  return performance.now() - started;
}

/**
 * The route series: `ROUTE_SAMPLES` submissions of unique fixture proofs over HTTP (AAP 0.5.5).
 *
 * Each call spends one booking and releases it again, which is what makes the submissions unique while
 * only two fixture bookings exist: the `itinerary_proof` and `spent_nullifier` rows the call wrote are
 * deleted afterwards, so the next call meets an unspent booking. The accounts and their rows are removed
 * before the series starts and again at its end, so an interrupted run leaves nothing behind that the
 * next one cannot reuse.
 *
 * The accounts are created here rather than through `POST /auth/*`: the series measures verification,
 * and a magic link over SMTP would put the mailer in the measurement's path. Each carries a recorded 18+
 * confirmation and terms version, so `requireTraveler` admits it (AAP 0.5.4). Both rate limits are
 * clear: one call per account, and 30 calls from one address (AAP 0.5.4).
 *
 * @throws {BenchFailure} `measure` when a booking was already spent by another account, else `route`.
 */
async function measureRoute(
  services: AppServices,
  env: ApiEnv,
  invocation: Invocation,
  proofs: readonly ProofSubmission[],
): Promise<SeriesStats> {
  const db = services.db;
  const apiUrl = apiUrlFor(invocation, DEFAULT_CONTAINER_API_URL);
  const now = services.clock.now();

  await purgeBenchRows(db);
  const users = await createBenchUsers(services, env, now);
  const benchUserIds = new Set(users.map((user) => user.id));

  try {
    const durations: number[] = [];
    for (let index = 0; index < ROUTE_SAMPLES; index += 1) {
      // Proofs 1…30: proof 0 belongs to the direct series, and every proof here must be unique because
      // the route spends the booking it proves.
      const submission = proofs[index + 1];
      const user = users[index];
      if (submission === undefined || user === undefined) {
        throw new BenchFailure('route', 'the prepared proofs or the bench accounts are incomplete');
      }

      const nullifier = submission.publicSignals[NULLIFIER_SIGNAL];
      if (nullifier === undefined) {
        throw new BenchFailure('route', 'a prepared proof carries no nullifier signal');
      }

      await releaseSpentFixture(db, nullifier, benchUserIds);
      durations.push(await submitProof(apiUrl, user.accessToken, submission));
      await deleteFixtureRows(db, nullifier);
    }
    return stats(durations);
  } finally {
    await purgeBenchRows(db);
  }
}

/** Create the accounts and sessions the route series acts as (AAP 0.5.2). */
async function createBenchUsers(
  services: AppServices,
  env: ApiEnv,
  now: Date,
): Promise<readonly BenchUser[]> {
  const users: BenchUser[] = [];

  for (let index = 1; index <= ROUTE_SAMPLES; index += 1) {
    const email = benchEmail(index);
    const user = await services.db.user.create({
      data: {
        emailCiphertext: encryptField(services.keyring, email),
        emailLookupHash: emailLookupHash(env.EMAIL_LOOKUP_PEPPER, email),
        handle: benchHandle(index),
        avatarSeed: randomBytes(16).toString('hex'),
        role: 'traveler',
        ageConfirmedAt: now,
        termsVersion: env.TERMS_VERSION,
      },
      select: { id: true },
    });

    const session = await services.db.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: sha256Hex(randomToken()),
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      },
      select: { id: true },
    });

    users.push({
      id: user.id,
      sessionId: session.id,
      accessToken: await signAccessToken(services, {
        sub: user.id,
        role: 'traveler',
        sid: session.id,
      }),
    });
  }
  return users;
}

/**
 * Submit one proof to the listening API and time it (AAP 0.5.4).
 *
 * The span runs from the request being sent until the whole body has been read, so the figure is what a
 * client experiences for the route end to end — rate limiting, authentication, verification and storage
 * included. The token travels only in the header and is never printed or logged.
 */
async function submitProof(
  apiUrl: string,
  accessToken: string,
  submission: ProofSubmission,
): Promise<number> {
  const started = performance.now();

  try {
    const response = await fetch(`${apiUrl}${PROOF_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(submission),
    });
    const text = await response.text();
    const elapsed = performance.now() - started;

    if (response.status !== PROOF_ACCEPTED_STATUS) {
      throw new BenchFailure(
        'route',
        `POST ${PROOF_PATH} answered ${response.status}${errorCodeOf(text)}`,
      );
    }
    if (!ProofAccepted.safeParse(parseJson(text)).success) {
      throw new BenchFailure('route', `POST ${PROOF_PATH} answered an unexpected body`);
    }
    return elapsed;
  } catch (error) {
    if (error instanceof BenchFailure) throw error;
    throw new BenchFailure('route', `POST ${PROOF_PATH} did not answer`);
  }
}

/**
 * Give a fixture booking back, or refuse to touch a row this script did not write.
 *
 * A booking's nullifier is spent once for the whole deployment, including by accounts this script knows
 * nothing about — a suite that submitted the same fixture, or a `bench_` account from a run that died
 * before its cleanup. Only the latter is reclaimed, and only with its `itinerary_proof` row: deleting
 * another account's rows to make room for a benchmark would corrupt real data (AAP 0.12.2).
 *
 * @throws {BenchFailure} `measure` when the booking was registered by anything but a bench account.
 */
async function releaseSpentFixture(
  db: DbClient,
  nullifier: string,
  benchUserIds: ReadonlySet<string>,
): Promise<void> {
  const spent = await db.spentNullifier.findUnique({
    where: { nullifier },
    select: { nullifier: true },
  });
  if (spent === null) return;

  const proof = await db.itineraryProof.findUnique({
    where: { nullifier },
    select: { userId: true },
  });

  if (proof === null || !benchUserIds.has(proof.userId)) {
    throw new BenchFailure(
      'measure',
      'fixture booking already registered by a non-bench account; reset the test stack and rerun',
    );
  }
  await deleteFixtureRows(db, nullifier);
}

/** The two rows one submission writes, deleted together so the booking is unspent again. */
async function deleteFixtureRows(db: DbClient, nullifier: string): Promise<void> {
  await db.itineraryProof.deleteMany({ where: { nullifier } });
  await db.spentNullifier.deleteMany({ where: { nullifier } });
}

/**
 * Remove every row this script could have written for a `bench_` account (AAP 0.5.2).
 *
 * The deletion runs in foreign-key order — the `spent_nullifier` rows of the accounts' proofs, the proof
 * rows, the sessions, then the accounts — and touches nothing else, because a user row is found only by
 * the handle prefix these accounts alone carry. `itinerary_proof` and `session` are the only two
 * relations a bench account can hold: `POST /itinerary-proofs` is the only route it calls, and that
 * route's transaction writes those two tables and nothing more.
 */
async function purgeBenchRows(db: DbClient): Promise<void> {
  const users = await db.user.findMany({
    where: { handle: { startsWith: HANDLE_PREFIX } },
    select: { id: true },
  });
  const userIds = users.map((row) => row.id);
  if (userIds.length === 0) return;

  const proofs = await db.itineraryProof.findMany({
    where: { userId: { in: userIds } },
    select: { nullifier: true },
  });
  const nullifiers = proofs.map((row) => row.nullifier);

  if (nullifiers.length > 0) {
    await db.spentNullifier.deleteMany({ where: { nullifier: { in: nullifiers } } });
  }
  await db.itineraryProof.deleteMany({ where: { userId: { in: userIds } } });
  await db.session.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

/** The handle of bench account `index`: `bench_01`…`bench_30`, the cleanup's own key. */
function benchHandle(index: number): string {
  return `${HANDLE_PREFIX}${String(index).padStart(HANDLE_DIGITS, '0')}`;
}

/** The address of bench account `index`, fictional and unique per account. */
function benchEmail(index: number): string {
  return `${EMAIL_PREFIX}${String(index).padStart(HANDLE_DIGITS, '0')}@${EMAIL_DOMAIN}`;
}

/**
 * Prepare, measure inside the `api` service and record the result (AAP 0.5.5, 0.12.1).
 *
 * The measurement happens in the container the plan names — "the `api` container for verification"
 * (AAP 0.11.2) — so the figure covers the image a deployment runs rather than the host's Node. The
 * document is written only after a result line has been parsed: a container that cannot measure leaves
 * `docs/zk-performance.md` untouched, which is AAP 0.12.3's rule that no pass is recorded without one.
 *
 * @returns `0` once the block is written, whether the measured p95 passed or missed; `1` for a step that
 *   could not be completed.
 */
async function orchestrate(invocation: Invocation): Promise<number> {
  const outPath = await prepare(invocation);

  // The proofs travel through the container command's stdin rather than with `docker compose cp`: a
  // copy is written root-owned with the source's mode, and the measuring process runs as the image's
  // `node` user, which could not read the 0600 file this process wrote. `dd` writes stdin to the path
  // and prints nothing, so the transfer stays off stdout.
  const proofs = await readFile(outPath);
  const copied = await compose(
    ['exec', '-T', API_SERVICE, 'dd', `of=${CONTAINER_PROOF_FILE}`, 'status=none'],
    proofs,
  );
  if (copied.stderr !== '') process.stderr.write(copied.stderr);
  if (copied.failed) {
    return refuse('orchestrate', 'the prepared proofs could not be handed to the api container');
  }

  const measured = await compose([
    'exec',
    '-T',
    API_SERVICE,
    'node',
    '--enable-source-maps',
    MEASURE_ENTRY,
    MEASURE_FLAG,
    CONTAINER_PROOF_FILE,
  ]);
  if (measured.stderr !== '') process.stderr.write(measured.stderr);
  if (measured.failed) {
    return refuse('orchestrate', 'the api container exited without a measured result');
  }

  const result = parseResult(measured.stdout);
  if (result === null) {
    return refuse('orchestrate', 'the api container reported no result line');
  }

  const pass = result.verify.p95Ms <= TARGET_P95_MS && result.route.p95Ms <= TARGET_P95_MS;
  const written = await writeDocsBlock(blockFor(result, pass, await gitCommit()));

  process.stdout.write(
    `${COMMAND}: verify p95 ${result.verify.p95Ms} ms, route p95 ${result.route.p95Ms} ms -> ` +
      `${pass ? 'pass' : 'fail'} (${displayPath(written)})\n`,
  );
  return 0;
}

/**
 * Replace this file's block in `docs/zk-performance.md`, creating the document when it is absent.
 *
 * The block is what sits between the two markers, so a rerun replaces exactly what it wrote and leaves
 * every other result in the document — the device benchmarks, which own their own block — as it was.
 *
 * @returns the absolute path of the document.
 */
async function writeDocsBlock(block: string): Promise<string> {
  const file = path.join(findRepoRoot(), DOCS_FILE);

  let existing: string | null;
  try {
    existing = await readFile(file, 'utf8');
  } catch {
    existing = null;
  }

  await writeFile(file, withBlock(existing, block));
  return file;
}

/** The document with this file's block replaced, appended after a section, or created outright. */
function withBlock(existing: string | null, block: string): string {
  // A blank line after the opening marker and none before the closing one: the form Prettier keeps for
  // an HTML comment followed by prose, so a `prettier --check` of the record stays clean.
  const fenced = `${BLOCK_BEGIN}\n\n${block}\n${BLOCK_END}\n`;

  if (existing === null) {
    return `${DOCS_TITLE}\n\n${DOCS_SECTION}\n\n${fenced}`;
  }

  const start = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END);
  if (start >= 0 && end > start) {
    // The newlines behind the closing marker go with it, and exactly one blank line separates the block
    // from whatever follows, so a rerun leaves the document byte-identical around the block it owns.
    const rest = existing.slice(end + BLOCK_END.length).replace(/^\n+/, '');
    return `${existing.slice(0, start)}${fenced}${rest === '' ? '' : `\n${rest}`}`;
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${DOCS_SECTION}\n\n${fenced}`;
}

/** The block's content: what was run, where, and what it measured against the target (AAP 0.12.1). */
function blockFor(result: BenchResult, pass: boolean, commit: string): string {
  const host = `${result.cpu.model} × ${result.cpu.cores} · ${gibibytes(totalmem())} GiB`;
  return [
    `Run: ${systemClock.now().toISOString()} · commit ${commit}`,
    `Host: ${host} · container Node ${result.node}`,
    `Mode: ${MODE_LINE}`,
    '',
    ...benchTable(result),
    '',
    `Criterion 4 (server verification): ${pass ? 'pass' : 'fail'}`,
  ].join('\n');
}

/**
 * The two result rows as one table, padded the way Prettier writes a Markdown table.
 *
 * The block lands in a tracked document that `pnpm lint` formats, so the generator emits the canonical
 * form itself: a hand-written table would be rewritten by the next `prettier --write`, and the record
 * would drift from the formatter on every check.
 */
function benchTable(result: BenchResult): readonly string[] {
  const header = ['Series', 'Samples', 'p50 (ms)', 'p95 (ms)', 'Max (ms)', 'Target', 'Result'];
  const rows = [
    rowFor(
      '`verifyItineraryProof` (api container)',
      `${thousands(result.verify.samples)} (${result.verify.warmup} warm-up)`,
      result.verify,
    ),
    rowFor(
      '`POST /v1/itinerary-proofs` (route level)',
      thousands(result.route.samples),
      result.route,
    ),
  ];
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(' | ')} |`;

  return [line(header), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)];
}

/** One table row's cells: the series, its samples, the three percentiles, the target and the verdict. */
function rowFor(series: string, samples: string, stats: SeriesStats): readonly string[] {
  // Two decimals throughout, so the columns read as one figure rather than as `13` beside `17.37`.
  const cell = (value: number): string => value.toFixed(2);
  const verdict = stats.p95Ms <= TARGET_P95_MS ? 'pass' : 'fail';
  return [
    series,
    samples,
    cell(stats.p50Ms),
    cell(stats.p95Ms),
    cell(stats.maxMs),
    TARGET_LINE,
    verdict,
  ];
}

/** The commit the run is recorded against, or `unknown` when git cannot answer. */
async function gitCommit(): Promise<string> {
  const result = await runCommand(GIT, ['rev-parse', '--short', 'HEAD']);
  const sha = result.stdout.trim();
  return result.failed || sha === '' ? 'unknown' : sha;
}

/**
 * Run one child command from the repository root, with no shell.
 *
 * `execFile` rather than a shell, so nothing in an argument can be interpreted as one, and the compose
 * project is whatever the caller's environment selects — the same `docker compose` an operator runs by
 * hand, which is what makes this script measure the stack they started. `input`, when given, is written
 * to the child's stdin and the stream closed behind it; every child that reads no stdin is unaffected.
 */
function runCommand(
  file: string,
  args: readonly string[],
  input?: Uint8Array,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      { cwd: findRepoRoot(), maxBuffer: COMMAND_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        resolve({ failed: error !== null, stdout, stderr });
      },
    );
    child.stdin?.end(input);
  });
}

/** `docker compose` with a subcommand and its arguments, and optionally stdin for the container. */
function compose(args: readonly string[], input?: Uint8Array): Promise<CommandResult> {
  return runCommand(DOCKER, [COMPOSE, ...args], input);
}

/** The last result line the container printed, parsed, or `null` when it printed none. */
function parseResult(stdout: string): BenchResult | null {
  const line = stdout
    .split('\n')
    .filter((candidate) => candidate.startsWith(RESULT_PREFIX))
    .pop();
  if (line === undefined) return null;

  const parsed = BenchResult.safeParse(parseJson(line.slice(RESULT_PREFIX.length)));
  return parsed.success ? parsed.data : null;
}

/** The result line's payload: where it was measured and what it measured (AAP 0.5.5). */
function resultFor(env: ApiEnv, verify: ResultVerify, route: SeriesStats): BenchResult {
  const cores = cpus();
  return {
    appEnv: env.APP_ENV,
    node: process.version,
    cpu: { model: cores[0]?.model ?? 'unknown', cores: cores.length },
    verify: {
      warmup: verify.warmup,
      samples: verify.samples,
      p50Ms: verify.p50Ms,
      p95Ms: verify.p95Ms,
      maxMs: verify.maxMs,
    },
    route: { samples: route.samples, p50Ms: route.p50Ms, p95Ms: route.p95Ms, maxMs: route.maxMs },
  };
}

/**
 * A series' statistics, by nearest rank — `sorted[ceil(q × n) − 1]` (AAP 0.5.5) — with milliseconds
 * rounded to a hundredth, so the recorded figures are comparable between runs.
 */
function stats(durations: readonly number[]): SeriesStats {
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
  };
}

/** One percentile of an ascending series, by nearest rank. */
function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(Math.max(Math.ceil(quantile * sorted.length) - 1, 0), sorted.length - 1);
  return round(sorted[rank] ?? 0);
}

/** A duration in milliseconds, rounded to a hundredth. */
function round(milliseconds: number): number {
  return Math.round(milliseconds * 100) / 100;
}

/** A byte count as whole GiB, for the record's host line. */
function gibibytes(bytes: number): number {
  return Math.round(bytes / 1024 ** 3);
}

/** A count with its thousands separator, so `1000` reads as the plan writes it. */
function thousands(value: number): string {
  return value.toLocaleString('en-US');
}

/** The API address to reach: the flag when given, else this mode's default, without a trailing slash. */
function apiUrlFor(invocation: Invocation, fallback: string): string {
  return (invocation.apiUrl ?? fallback).replace(/\/+$/, '');
}

/** A response body as JSON, or `null` when it is not JSON at all. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/** Text as JSON, or `null` when it is not JSON at all. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * The envelope's error code in parentheses, for a refusal message — a code, never a message body or a
 * value the API answered (AAP 0.11.1). Empty when the body is not the contract's envelope.
 */
function errorCodeOf(text: string): string {
  const parsed = ErrorEnvelope.safeParse(parseJson(text));
  return parsed.success ? ` (${parsed.data.error.code})` : '';
}

/**
 * Close the app, but not forever: a dependency that will not let go must not hold the result back
 * (AAP 0.3.2). The timer is unref'd, so it cannot itself keep the process alive.
 */
async function closeBounded(app: App): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
    timer.unref();
  });

  try {
    await Promise.race([app.close(), deadline]);
  } catch {
    // The measurement is taken and the result line is about to be written: a shutdown that fails or
    // times out is reported by nothing here, because the process exits either way.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One refusal line on stderr, and the exit code that goes with it. */
function refuse(step: string, reason: string): number {
  process.stderr.write(`${COMMAND}: ${step}: ${reason}\n`);
  return 1;
}

/** One progress line on stderr, which keeps the measuring half's stdout to its result line. */
function progress(message: string): void {
  process.stderr.write(`${COMMAND}: ${message}\n`);
}

/**
 * A short, value-free token for a failure: the code the error carries — an `AppError`'s contract code, a
 * Prisma error's `P2002` — else its class name (AAP 0.11.1, 0.12.2).
 */
function failureToken(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown_error';
  if ('code' in error) {
    const code: unknown = error.code;
    if (typeof code === 'string' && code !== '') return code;
  }
  return error.name;
}

/** A path as this file's lines name it: repository-relative when it is inside the tree. */
function displayPath(target: string): string {
  const relative = path.relative(findRepoRoot(), target);
  return relative === '' || relative.startsWith('..') ? target : relative;
}
