/**
 * `perf-seed`: the data the 50 requests-per-second k6 load test reads (AAP 0.12.2, 0.11.2, 0.8.1).
 *
 * ```sh
 * pnpm --filter @tablemate/api perf:seed [-- --api-url <url>] [--out <path>]
 * ```
 *
 * It seeds 1,000 traveler accounts with a valid test-issuer proof each, 200 meetups over distinct
 * pairs (60 `proposed`, 80 `locked`, 60 `completed`), 20 messages per locked or completed pair and
 * one access token per account, then writes the file the k6 profile reads:
 *
 * ```json
 * { "apiUrl": string, "generatedAt": ISO, "tokenExpiresAt": ISO,
 *   "users":    [{ "id", "accessToken", "cityId" }],
 *   "meetups":  [{ "id", "initiatorId", "recipientId", "venueId", "startsAt", "status" }],
 *   "venues":   [{ "id", "cityId", "lat", "lng" }],
 *   "lodgings": [{ "id", "cityId" }],
 *   "codes"?:   [{ "venueId", "venueSecret" }] }
 * ```
 *
 * The default output is the git-ignored `.local/perf/seed.json`, which the compose stack mounts at
 * `/results`. It carries bearer tokens, so it is written mode 0600, and nothing here ever prints a
 * token, a secret or an address.
 *
 * **Run it against the environment the API runs in, and immediately before the run.** The tokens are
 * signed with the API's `JWT_SECRET` and live 15 minutes (AAP 0.3.3), the rows live in its
 * `DATABASE_URL`, the addresses are encrypted with its `FIELD_ENCRYPTION_KEY`, the consents carry its
 * `TERMS_VERSION`, and in `STRIPE_MODE=mock` the holds of the locked meetups are placed at the
 * `STRIPE_API_BASE` proxy the API itself talks to. Root `pnpm perf` is what supplies that
 * environment.
 *
 * Four properties of the run:
 *
 *  - `APP_ENV` must be `test` or `demo` (AAP 0.5.2 admits fixtures nowhere else), which also excludes
 *    `STRIPE_MODE=live`, since a live key is accepted only in production.
 *  - A rerun first deletes everything a previous run or a previous load test left behind, in
 *    foreign-key order, and touches nothing else: the accounts by their `perf_` handle prefix or
 *    their deterministic `perf-NNNN@perf.invalid` address, the proof rows by their deterministic
 *    nullifiers. Seeding is therefore idempotent, a repeated run leaving the same counts.
 *  - In `STRIPE_MODE=test` no provider object is created at all — a load test must not litter a real
 *    test mode with 1,000 customers — so a propose from a seeded account answers `402 hold_failed`
 *    instead of placing a hold. In `mock` every account gets a customer with a saved card on the
 *    proxy, so a propose reaches a real hold.
 *  - The API's sweeper settles the 80 locked meetups 55 minutes after this script runs, so restoring
 *    them is a rerun of this script rather than of k6.
 *
 * The one load-generator IP needs the raised `RATE_LIMIT_IP_PER_MIN` root `pnpm perf` sets; the
 * per-user limit (60/min) is unchanged, because 1,000 accounts share it.
 *
 * @see AAP 0.12.2 for the measurement this data feeds (the read and write mix, the `Server-Timing`
 *   subtraction, the rate-limit note), 0.11.2 for the load-test row and the suite topology, 0.5.2 for
 *   the fixture rules and the reserved fictional numbers, 0.5.3 for the meetup, deposit and timer
 *   lifecycles the fixture shapes mirror, 0.5.7 for the check-in window and the suggestion
 *   eligibility, 0.11.1 for the injected clock and the logging conventions, 0.8.1 for this file.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Prisma, readPoints } from '@tablemate/db';
import { FIXTURE_SECRETS_RELATIVE_PATH, readFixtureSecrets } from '@tablemate/db/seed';
import {
  EnvValidationError,
  actorHash,
  addLocalDays,
  createLogger,
  emailLookupHash,
  loadApiEnv,
  localDateKey,
  sha256Hex,
} from '@tablemate/server-core';
import {
  ACCESS_TOKEN_TTL_MINUTES,
  CHECK_IN_CLOSES_AFTER_MINUTES,
  DAY_MS,
  DEPOSIT_LEVELS_CENTS,
  HOUR_MS,
  MINUTE_MS,
} from '@tablemate/shared';

import { buildApp, type App, type AppServices } from '../src/app.ts';
import { signAccessToken } from '../src/plugins/auth.ts';
import {
  TEST_ISSUER_STEM,
  findRepoRoot,
  readCitiesConfig,
  readIssuerConfigs,
  readRegistryFile,
} from '../src/modules/proofs/registry.ts';
import { proofValidity } from '../src/modules/proofs/validity.ts';

import type { DbClient } from '@tablemate/db';
import type { ApiEnv } from '@tablemate/server-core';
import type { CityConfig, DepositCents, MeetupStatus } from '@tablemate/shared';
import type { FactoryContext } from '../test/support/factories.ts';

/*
 * Constants
 */

/** The command's name, on the usage line and on every line this file writes itself. */
const COMMAND = 'perf-seed';

/** The logger's service name: a warning names this script, not the API whose container it borrows. */
const LOGGER_NAME = 'perf-seed';

/** The 1,000 accounts: handles `perf_0001`…`perf_1000`, and the prefix a later run finds them by. */
const PERF_HANDLE_PREFIX = 'perf_';
const PERF_HANDLE_DIGITS = 4;
const PERF_USER_COUNT = 1_000;

/**
 * The addresses every seeded account is created under: deterministic, so a run that died before its
 * handles were written is still found by its own lookup hashes.
 */
const PERF_EMAIL_PREFIX = 'perf-';
const PERF_EMAIL_DOMAIN = 'perf.invalid';

/** The seed of a proof's deterministic nullifier, so a rerun can delete the rows it wrote. */
const PERF_NULLIFIER_PREFIX = 'tablemate-perf-nullifier-';

/**
 * The bits of a nullifier that are a valid circuit field element: 248, the width snarkjs reduces a
 * hash to. A whole 256-bit SHA-256 digest exceeds the BN254 order about five times in six.
 */
const FIELD_ELEMENT_BITS = 248n;

/** The stay the proof rows prove: yesterday until a fortnight out, so it is valid all run. */
const PERF_STAY_ARRIVAL_DAYS = -1;
const PERF_STAY_DEPARTURE_DAYS = 14;

/** The meetups of one city: 40 over distinct pairs, so 60 / 80 / 60 across the five cities. */
const PERF_PROPOSED_PER_CITY = 12;
const PERF_LOCKED_PER_CITY = 16;
const PERF_COMPLETED_PER_CITY = 12;

/** The locked meetups start ten minutes out, so the check-in window covers the whole run (0.5.7). */
const PERF_LOCKED_START_MINUTES = 10;

/** A completed meetup settled an hour ago, inside suggestions' 24-hour eligibility (AAP 0.7.3). */
const PERF_COMPLETED_SETTLED_MINUTES = 60;

/** The messages of one locked or completed pair, spread over the two hours before the seed. */
const PERF_MESSAGES_PER_PAIR = 20;
const PERF_MESSAGE_PREFIX = 'perf message ';

/** How many builders are in flight at once: enough to hide the round trips, under the token life. */
const SEED_CONCURRENCY = 20;

/** One progress line on stderr every this many accounts. */
const PROGRESS_STEP = 250;

/** Where the k6 profile reads its data, relative to the repository root (AAP 0.12.2). */
const OUTPUT_FILE = '.local/perf/seed.json';

/** Mode of the seed file: it carries bearer tokens, so its owner alone reads and writes it. */
const FILE_MODE = 0o600;

/** The route the closing check reads, and the two answers it treats specially. */
const TOKEN_CHECK_PATH = '/v1/me';
const TOKEN_OK = 200;
const TOKEN_REJECTED = 401;

/** The two flags. Any other argument, or a flag without a value, is a usage error. */
const API_URL_FLAG = '--api-url';
const OUT_FLAG = '--out';

/**
 * The end-of-options separator, ignored rather than refused: `pnpm run` forwards the `--` of
 * `pnpm --filter @tablemate/api perf:seed -- <flags>` verbatim into the argument list.
 */
const OPTIONS_SEPARATOR = '--';

/**
 * How long the app's shutdown may take before the process exits regardless (five seconds). A stuck
 * dependency must not hold the command open: the rows are committed by then and the file is written.
 */
const CLOSE_TIMEOUT_MS = 5_000;

/**
 * How long a drain may wait for the reader of stdout and stderr before the process is ended anyway
 * (one second). A consumer that never reads — a stopped `tee`, a detached log collector — must not
 * hold the run open once the seed file is written and the summary is reported.
 */
const EXIT_DRAIN_TIMEOUT_MS = 1_000;

/** The usage line, written for a missing, unknown or unterminated argument. */
const USAGE_LINE = `usage: ${COMMAND} [${API_URL_FLAG} <url>] [${OUT_FLAG} <path>]\n`;

/*
 * Types
 */

/** What the command line asked for; both members fall back to the defaults below. */
interface Invocation {
  /** The API the closing token check reaches, or `null` for the configured public address. */
  readonly apiUrl: string | null;
  /** Where the seed file is written, or `null` for {@link OUTPUT_FILE}. */
  readonly outPath: string | null;
}

/** One seeded account: what its token is signed for, and the city its proof names. */
interface PerfUser {
  readonly id: string;
  readonly sessionId: string;
  readonly cityId: string;
}

/** The three meetup statuses this seed writes: derived from the enum, so a rename fails to compile. */
type SeededStatus = Extract<MeetupStatus, 'proposed' | 'locked' | 'completed'>;

/** One seeded meetup, in the shape the k6 profile picks its reads and writes from. */
interface PerfMeetup {
  readonly id: string;
  readonly initiatorId: string;
  readonly recipientId: string;
  readonly venueId: string;
  readonly startsAt: Date;
  readonly status: SeededStatus;
}

/** One account with the token the load test carries, signed last so its full life remains. */
interface SeededUser extends PerfUser {
  readonly accessToken: string;
}

/** The signed accounts and the instant their tokens expire, which the seed file reports. */
interface SignedUsers {
  readonly users: readonly SeededUser[];
  readonly expiresAt: Date;
}

/** A city's active partner venues whose coordinates are known, and the coordinate itself. */
interface VenueRef {
  readonly id: string;
  readonly cityId: string;
  readonly lat: number;
  readonly lng: number;
}

/** One meetup to build, decided before any of them is written. */
interface MeetupPlan {
  readonly status: SeededStatus;
  readonly initiator: PerfUser;
  readonly recipient: PerfUser;
  readonly venueId: string;
  readonly startsAt: Date;
  readonly depositCents: DepositCents;
}

/** A refusal this file decided: the step it happened in, and a reason with no value in it. */
class SeedFailure extends Error {
  constructor(
    readonly step: string,
    readonly reason: string,
  ) {
    super(`${step}: ${reason}`);
    this.name = 'SeedFailure';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/*
 * The command
 */

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
 * Parse, seed and report in one call, and answer the process exit code.
 *
 * The app is built and closed around the seeding and never started as a server: `startBackground` is
 * deliberately not called, so this process holds no settlement worker, no sweeper, no outbox poller
 * and no socket. Everything below is written through the container's own client, keyring and clock,
 * so what a run leaves behind is what the API reads.
 *
 * @param argv - the arguments after the script name.
 * @returns `0` once the seed file is written and the API has accepted a seeded token, `1` for every
 *   refusal, which is one line on stderr.
 */
async function run(argv: readonly string[]): Promise<number> {
  const invocation = parseArguments(argv);
  if (invocation === null) {
    process.stderr.write(USAGE_LINE);
    return 1;
  }

  const env = loadEnvironment();
  if (env === null) {
    return 1;
  }
  if (env.APP_ENV !== 'test' && env.APP_ENV !== 'demo') {
    return refuse('environment', 'APP_ENV must be test or demo');
  }

  const app = buildApp({
    env,
    logger: createLogger({
      name: LOGGER_NAME,
      level: 'warn',
      appEnv: env.APP_ENV,
      destination: process.stderr,
    }),
  });

  try {
    await app.ready();
    const context = await buildContext(app, env);
    const factories = await import('../test/support/factories.ts');

    const cities = await requireSeededData(app.services.db);
    await purgePreviousRun(app.services.db, env);

    const users = await seedUsers(context, factories, env, cities);
    const meetups = await seedMeetups(context, factories, cities, users);
    const messages = await seedMessages(context, meetups);

    const signed = await signTokens(app.services, users);
    const outPath = await writeSeedFile(context, invocation, env, cities, signed, meetups);

    const first = signed.users[0];
    if (first === undefined) {
      return refuse('token check', 'no account was seeded');
    }
    const refused = await checkToken(apiUrlFor(invocation, env), first.accessToken);
    if (refused !== null) {
      return refuse('token check', refused);
    }

    process.stdout.write(summaryLine(signed.users, meetups, messages, outPath));
    return 0;
  } catch (error) {
    return error instanceof SeedFailure
      ? refuse(error.step, error.reason)
      : refuse('run', failureToken(error));
  } finally {
    await closeBounded(app);
  }
}

/*
 * Arguments, the environment and the app's container
 */

/**
 * Read the argument list: the two optional flags, each taking the value that follows it, and `--`
 * skipped — `pnpm run` forwards it verbatim. A repeated flag keeps its last value; anything else, or a
 * flag without a value, is a usage error.
 */
function parseArguments(argv: readonly string[]): Invocation | null {
  let apiUrl: string | null = null;
  let outPath: string | null = null;

  for (let position = 0; position < argv.length; position += 1) {
    const argument = argv[position];
    if (argument === OPTIONS_SEPARATOR) continue;
    if (argument !== API_URL_FLAG && argument !== OUT_FLAG) return null;

    const value = argv[position + 1];
    if (value === undefined) return null;
    position += 1;
    if (argument === API_URL_FLAG) apiUrl = value;
    else outPath = value;
  }

  return { apiUrl, outPath };
}

/**
 * Load the `api` environment, or report the loader's findings and answer `null` (AAP 0.6.2). The
 * message is the loader's own — a variable name with a fixed reason, never a value (AAP 0.12.2). Any
 * other throw is a defect rather than a configuration problem, so it travels on.
 */
function loadEnvironment(): ApiEnv | null {
  try {
    return loadApiEnv();
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error;
    process.stderr.write(`${COMMAND}: environment: ${error.message}\n`);
    return null;
  }
}

/**
 * The app's container as a fixture context (AAP 0.11.2): the app's own services satisfy the builders'
 * narrowed context structurally, so a fixture written here reads the same client, keyring and clock a
 * request would.
 */
async function buildContext(app: App, env: ApiEnv): Promise<FactoryContext> {
  return { services: app.services, stripe: await stripeContext(env), app };
}

/**
 * The Stripe topology a fixture reaches the provider through (AAP 0.11.2): the stateful proxy in
 * `mock`, whose control client builds a customer with a saved card in one call, and Stripe's own test
 * API in `test`. A `live` mode cannot occur here, because production is refused above.
 */
async function stripeContext(env: ApiEnv): Promise<FactoryContext['stripe']> {
  const webhookSecret = env.stripe.webhookSecret;
  if (env.stripe.mode !== 'mock') {
    return { mode: 'test', apiBase: null, webhookSecret, proxy: null };
  }

  // Loaded here rather than imported above: the proxy's control client is test support, and the
  // compiled `dist/scripts/perf-seed.js` must load where the image ships no `dist/test`.
  const { proxyControl } = await import('../test/support/stripe-proxy/state.ts');
  return {
    mode: 'mock',
    apiBase: env.stripe.apiBase,
    webhookSecret,
    proxy: proxyControl(env.stripe.apiBase),
  };
}

/**
 * The address the closing token check reaches: `--api-url` when given, else the configured
 * `API_PUBLIC_URL` — the address the deployment publishes the API on, which the compose stack leaves at
 * the default `http://localhost:3000`. A seed process on another network passes the flag: the compose
 * `migrate` container, for instance, reaches the API as `http://api:3000`.
 */
function apiUrlFor(invocation: Invocation, env: ApiEnv): string {
  return (invocation.apiUrl ?? env.API_PUBLIC_URL).replace(/\/+$/, '');
}

/** Where the seed file goes: `--out` when given, the repository's own git-ignored `.local/perf/`. */
function outPathFor(invocation: Invocation): string {
  return invocation.outPath ?? path.join(findRepoRoot(), OUTPUT_FILE);
}

/*
 * Preconditions and the rerun's cleanup (AAP 0.5.2)
 */

/**
 * Require what this seed writes against: every configured city, and at least one active partner fixture
 * venue in each, so a proposal may name a venue. Anything missing means the fixtures were never loaded.
 */
async function requireSeededData(db: DbClient): Promise<readonly CityConfig[]> {
  const cities = readCitiesConfig().cities;
  const cityIds = cities.map((city) => city.id);
  const [present, venues] = await Promise.all([
    db.city.findMany({ where: { id: { in: cityIds } }, select: { id: true } }),
    db.venue.findMany({
      where: { cityId: { in: cityIds }, isActivePartner: true, isFixture: true },
      select: { cityId: true },
    }),
  ]);

  const known = new Set(present.map((row) => row.id));
  const withVenue = new Set(venues.map((row) => row.cityId));
  if (
    cities.length === 0 ||
    !cities.every((city) => known.has(city.id) && withVenue.has(city.id))
  ) {
    throw new SeedFailure('preconditions', 'run pnpm db:seed first');
  }

  return cities;
}

/** The indexes 1…1000: the order the accounts are created in, and the basis of every derived value. */
function perfIndexes(): readonly number[] {
  return Array.from({ length: PERF_USER_COUNT }, (_unused, position) => position + 1);
}

/** The handle of account `index`, which is how a later run finds that account again. */
function perfHandle(index: number): string {
  return `${PERF_HANDLE_PREFIX}${String(index).padStart(PERF_HANDLE_DIGITS, '0')}`;
}

/** The address of account `index`: deterministic, so its lookup hash is recomputable at any time. */
function perfEmail(index: number): string {
  return `${PERF_EMAIL_PREFIX}${String(index).padStart(PERF_HANDLE_DIGITS, '0')}@${PERF_EMAIL_DOMAIN}`;
}

/** Every seeded address's lookup hash: the second key the cleanup finds a crashed run's rows by. */
function perfEmailHashes(pepper: string): readonly string[] {
  return perfIndexes().map((index) => emailLookupHash(pepper, perfEmail(index)));
}

/**
 * The deterministic nullifier of account `index` (AAP 0.5.2, 0.5.5): the low 248 bits of
 * `sha256("tablemate-perf-nullifier-<index>")`, in decimal.
 *
 * Deterministic on purpose: `spent_nullifier` carries no user link, so the cleanup can only find what a
 * previous run wrote by recomputing it. The 248-bit mask is what keeps the value inside the BN254 field
 * a circuit's public signal lives in, which a whole 256-bit digest would exceed.
 */
function perfNullifier(index: number): string {
  const digest = BigInt(`0x${sha256Hex(`${PERF_NULLIFIER_PREFIX}${index}`)}`);
  return (digest & ((1n << FIELD_ELEMENT_BITS) - 1n)).toString();
}

/** Every seeded nullifier, in index order. */
function perfNullifiers(): readonly string[] {
  return perfIndexes().map((index) => perfNullifier(index));
}

/** The ids a cleanup works from: the accounts it found, their meetups, and those meetups' deposits. */
interface PerfFootprint {
  readonly userIds: readonly string[];
  readonly meetupIds: readonly string[];
  readonly depositIds: readonly string[];
}

/**
 * Find the accounts a previous run seeded, then their meetups and those meetups' deposits. The accounts
 * are found by their handle prefix or their deterministic address hash, so a run that died before the
 * handles were written is still found.
 */
async function findPerfRows(db: DbClient, env: ApiEnv): Promise<PerfFootprint> {
  const users = await db.user.findMany({
    where: {
      OR: [
        { handle: { startsWith: PERF_HANDLE_PREFIX } },
        { emailLookupHash: { in: [...perfEmailHashes(env.EMAIL_LOOKUP_PEPPER)] } },
      ],
    },
    select: { id: true },
  });
  const userIds = users.map((row) => row.id);

  const meetups = await db.meetup.findMany({
    where: { OR: [{ initiatorId: { in: userIds } }, { recipientId: { in: userIds } }] },
    select: { id: true },
  });
  const meetupIds = meetups.map((row) => row.id);

  const deposits = await db.deposit.findMany({
    where: { meetupId: { in: meetupIds } },
    select: { id: true },
  });

  return { userIds, meetupIds, depositIds: deposits.map((row) => row.id) };
}

/**
 * Delete everything a previous run — or a load test run on its accounts — left behind, in foreign-key
 * order, and nothing else: a load test creates meetups, holds, check-ins and reports of its own, so this
 * is what makes a repeated run idempotent.
 *
 * Three tables have no foreign key to follow and are matched by recomputation instead: the proof rows by
 * their deterministic nullifiers, the analytics events by their salted actor hashes, and the outbox rows
 * by the ids their JSON payload carries. Nothing is truncated and no other process's row is touched.
 */
async function purgePreviousRun(db: DbClient, env: ApiEnv): Promise<void> {
  const { userIds, meetupIds, depositIds } = await findPerfRows(db, env);
  // Mutable copies: a Prisma filter takes `string[]`, and the footprint's own lists are readonly.
  const byUser = { in: [...userIds] };
  const byMeetup = { in: [...meetupIds] };
  const byDeposit = { in: [...depositIds] };

  await db.message.deleteMany({ where: { OR: [{ meetupId: byMeetup }, { senderId: byUser }] } });
  await db.checkIn.deleteMany({ where: { meetupId: byMeetup } });
  await db.witnessEvent.deleteMany({ where: { OR: [{ meetupId: byMeetup }, { userId: byUser }] } });
  await db.tableCreditEntry.deleteMany({
    where: { OR: [{ meetupId: byMeetup }, { userId: byUser }] },
  });
  await db.dispute.deleteMany({ where: { OR: [{ meetupId: byMeetup }, { filedById: byUser }] } });
  await db.report.deleteMany({
    where: { OR: [{ meetupId: byMeetup }, { reporterId: byUser }, { reportedId: byUser }] },
  });
  await db.meetupSettlement.deleteMany({ where: { meetupId: byMeetup } });
  await db.lodgingActivityFact.deleteMany({ where: { meetupId: byMeetup } });
  await db.paymentOperation.deleteMany({
    where: { OR: [{ userId: byUser }, { depositId: byDeposit }] },
  });
  await db.deposit.deleteMany({ where: { meetupId: byMeetup } });
  await db.meetup.deleteMany({ where: { id: byMeetup } });

  await db.pairHistory.deleteMany({
    where: { OR: [{ userLowId: byUser }, { userHighId: byUser }] },
  });
  await db.operatorAccessLog.deleteMany({ where: { operatorId: byUser } });
  await db.lodgingVisibility.deleteMany({ where: { userId: byUser } });
  await db.lodgingClaim.deleteMany({ where: { userId: byUser } });
  await db.session.deleteMany({ where: { userId: byUser } });
  await db.itineraryProof.deleteMany({ where: { userId: byUser } });
  await db.disclosureProfile.deleteMany({ where: { userId: byUser } });
  await db.profilePhoto.deleteMany({ where: { userId: byUser } });
  await db.pushToken.deleteMany({ where: { userId: byUser } });
  await db.experimentAssignment.deleteMany({ where: { userId: byUser } });
  await db.block.deleteMany({ where: { OR: [{ blockerId: byUser }, { blockedId: byUser }] } });
  await db.user.deleteMany({ where: { id: byUser } });

  await db.spentNullifier.deleteMany({ where: { nullifier: { in: [...perfNullifiers()] } } });
  await db.analyticsEvent.deleteMany({
    where: {
      OR: [
        { actorHash: { in: userIds.map((userId) => actorHash(env.ANALYTICS_SALT, userId)) } },
        { meetupId: byMeetup },
      ],
    },
  });
  await deleteOutboxRows(db, userIds, meetupIds);
}

/**
 * Delete the outbox rows a perf account or meetup is named in (AAP 0.3.2). The payload carries ids only,
 * so a jsonb comparison finds them; the table has no foreign key to follow.
 */
async function deleteOutboxRows(
  db: DbClient,
  userIds: readonly string[],
  meetupIds: readonly string[],
): Promise<void> {
  if (userIds.length > 0) {
    await db.$executeRaw(
      Prisma.sql`DELETE FROM "outbox_message" WHERE ("payload" ->> 'userId') IN (${Prisma.join(userIds)})`,
    );
  }
  if (meetupIds.length > 0) {
    await db.$executeRaw(
      Prisma.sql`DELETE FROM "outbox_message" WHERE ("payload" ->> 'meetupId') IN (${Prisma.join(meetupIds)})`,
    );
  }
}

/*
 * Accounts, proofs and cards (AAP 0.12.2, 0.5.2)
 */

/**
 * Seed the 1,000 accounts in bounded concurrency: each an account with its consents recorded, a saved
 * card, its handle and one proof row.
 *
 * The builder writes the account, its one experiment assignment, its session and the customer a hold is
 * placed against; the handle and the proof rows are written here, because both are deterministic values
 * no request would ever choose.
 */
async function seedUsers(
  ctx: FactoryContext,
  factories: typeof import('../test/support/factories.ts'),
  env: ApiEnv,
  cities: readonly CityConfig[],
): Promise<readonly PerfUser[]> {
  const now = ctx.services.clock.now();
  const issuerId = testIssuerId();
  const registryRoot = readRegistryFile('test').root;
  const card = env.stripe.mode === 'mock' ? 'visa' : 'none';

  if (env.stripe.mode !== 'mock') {
    progress(
      `stripe: no provider object is created in STRIPE_MODE=${env.stripe.mode}; a propose from a ` +
        'seeded account answers 402 hold_failed',
    );
  }

  const users: PerfUser[] = new Array<PerfUser>(PERF_USER_COUNT);
  await eachWithConcurrency(perfIndexes(), SEED_CONCURRENCY, async (index) => {
    const city = at(cities, index - 1);
    const account = await factories.makeUser(ctx, {
      email: perfEmail(index),
      consents: true,
      role: 'traveler',
      card,
    });
    await ctx.services.db.user.update({
      where: { id: account.id },
      data: { handle: perfHandle(index) },
    });
    await writeProof(ctx, account.id, city, issuerId, registryRoot, index, now);
    users[index - 1] = { id: account.id, sessionId: account.sessionId, cityId: city.id };
    if (index % PROGRESS_STEP === 0) progress(`users ${index}/${PERF_USER_COUNT}`);
  });

  return users;
}

/**
 * Write one account's proof row and the spent nullifier behind it (AAP 0.5.2, 0.5.5), for the synthetic
 * test issuer and the committed test registry root.
 *
 * A row rather than a proof: this is load-test data, so the cryptography is skipped and the routes that
 * need a valid proof — discovery, propose, lodgings — need only a window that is open now. That window
 * comes from `proofValidity`, the same helper the verifying route stores its own with.
 */
async function writeProof(
  ctx: FactoryContext,
  userId: string,
  city: CityConfig,
  issuerId: number,
  registryRoot: string,
  index: number,
  now: Date,
): Promise<void> {
  const today = localDateKey(city.timezone, now);
  const arrivalDate = addLocalDays(today, PERF_STAY_ARRIVAL_DAYS);
  const departureDate = addLocalDays(today, PERF_STAY_DEPARTURE_DAYS);
  const { validFrom, validTo } = proofValidity(city.timezone, arrivalDate, departureDate);
  const nullifier = perfNullifier(index);

  await ctx.services.db.$transaction(async (tx) => {
    await tx.itineraryProof.create({
      data: {
        userId,
        cityId: city.id,
        arrivalDate: dateColumn(arrivalDate),
        departureDate: dateColumn(departureDate),
        issuerId: BigInt(issuerId),
        nullifier,
        validFrom,
        validTo,
        registryRoot,
      },
    });
    await tx.spentNullifier.create({ data: { nullifier, spentAt: now } });
  });
}

/** The synthetic test issuer's id from `config/issuers/tablemate-test.json` (AAP 0.5.5). */
function testIssuerId(): number {
  const issuer = readIssuerConfigs().find((entry) => entry.stem === TEST_ISSUER_STEM);
  if (issuer === undefined) {
    throw new SeedFailure('preconditions', 'config/issuers/tablemate-test.json is missing');
  }
  return issuer.config.issuerId;
}

/*
 * Meetups and the message history (AAP 0.12.2, 0.5.3)
 */

/**
 * Seed 200 meetups over distinct pairs, through the fixture builder, so every one carries the deposits,
 * payment operations, live holds and settlement rows its status implies (AAP 0.5.3): a `proposed` meetup
 * the recipient can see, a `locked` one whose check-in window is open for the whole run, and a
 * `completed` one settled an hour ago, which is inside suggestions' 24-hour eligibility (AAP 0.7.3).
 */
async function seedMeetups(
  ctx: FactoryContext,
  factories: typeof import('../test/support/factories.ts'),
  cities: readonly CityConfig[],
  users: readonly PerfUser[],
): Promise<readonly PerfMeetup[]> {
  const now = ctx.services.clock.now();
  const venues = await readPartnerVenues(ctx, cities);
  const plans = cities.flatMap((city) => planCity(city, users, venues, now));

  const built: PerfMeetup[] = new Array<PerfMeetup>(plans.length);
  await eachWithConcurrency(plans, SEED_CONCURRENCY, async (plan, position) => {
    const meetup = await factories.makeMeetup(ctx, {
      status: plan.status,
      initiator: { id: plan.initiator.id },
      recipient: { id: plan.recipient.id },
      venue: { id: plan.venueId },
      startsAt: plan.startsAt,
      depositCents: plan.depositCents,
    });
    built[position] = {
      id: meetup.id,
      initiatorId: plan.initiator.id,
      recipientId: plan.recipient.id,
      venueId: plan.venueId,
      startsAt: meetup.startsAt,
      status: plan.status,
    };
  });

  progress(`meetups ${built.length}`);
  return built;
}

/**
 * The 40 meetups of one city: 12 proposals, 16 locks and 12 completed meetups over the first 40 pairs of
 * that city's accounts, the deposit levels rotating 500 / 1000 / 2000 and the venues in rotation. One
 * meetup per pair, which is what the one-open-meetup-per-pair index allows.
 */
function planCity(
  city: CityConfig,
  users: readonly PerfUser[],
  venues: readonly VenueRef[],
  now: Date,
): readonly MeetupPlan[] {
  const cityUsers = users.filter((user) => user.cityId === city.id);
  const cityVenues = venues.filter((venue) => venue.cityId === city.id);
  const count = PERF_PROPOSED_PER_CITY + PERF_LOCKED_PER_CITY + PERF_COMPLETED_PER_CITY;

  if (cityVenues.length === 0) {
    throw new SeedFailure('meetups', `${city.id}: no active partner venue with coordinates`);
  }
  if (cityUsers.length < count * 2) {
    throw new SeedFailure('meetups', `${city.id}: fewer than ${count * 2} accounts`);
  }

  return Array.from({ length: count }, (_unused, position) => {
    const status = meetupStatusAt(position);
    return {
      status,
      initiator: at(cityUsers, position * 2),
      recipient: at(cityUsers, position * 2 + 1),
      venueId: at(cityVenues, position).id,
      startsAt: startsAtFor(status, now, position),
      depositCents: at(DEPOSIT_LEVELS_CENTS, position),
    };
  });
}

/** Which of the three shapes the meetup at `position` in its city takes. */
function meetupStatusAt(position: number): SeededStatus {
  if (position < PERF_PROPOSED_PER_CITY) return 'proposed';
  if (position < PERF_PROPOSED_PER_CITY + PERF_LOCKED_PER_CITY) return 'locked';
  return 'completed';
}

/**
 * When a meetup at `position` starts: one to four days out for a proposal; ten minutes out for a lock, so
 * the window from fifteen minutes before to forty-five minutes after the start is open for the whole run
 * (AAP 0.5.7); and an hour and three quarters back for a completed one, which is what puts its
 * `settledAt` — the start plus forty-five minutes — an hour ago.
 */
function startsAtFor(status: SeededStatus, now: Date, position: number): Date {
  if (status === 'proposed') return new Date(now.getTime() + (1 + (position % 4)) * DAY_MS);
  if (status === 'locked') return new Date(now.getTime() + PERF_LOCKED_START_MINUTES * MINUTE_MS);
  return new Date(
    now.getTime() - (CHECK_IN_CLOSES_AFTER_MINUTES + PERF_COMPLETED_SETTLED_MINUTES) * MINUTE_MS,
  );
}

/**
 * The five cities' active partner fixture venues with their coordinates. The geography column is
 * `Unsupported` in the Prisma schema, so the points come from the PostGIS helper, which applies the
 * fixture predicate to this table itself (AAP 0.5.2).
 */
async function readPartnerVenues(
  ctx: FactoryContext,
  cities: readonly CityConfig[],
): Promise<readonly VenueRef[]> {
  const rows = await ctx.services.db.venue.findMany({
    where: {
      cityId: { in: cities.map((city) => city.id) },
      isActivePartner: true,
      isFixture: true,
    },
    select: { id: true, cityId: true },
    orderBy: { name: 'asc' },
  });
  const points = await readPoints(
    ctx.services.db,
    'venue',
    rows.map((row) => row.id),
    ctx.services.env.APP_ENV,
  );

  const venues: VenueRef[] = [];
  for (const row of rows) {
    const point = points.get(row.id);
    if (point === undefined) continue;
    venues.push({ id: row.id, cityId: row.cityId, lat: point.lat, lng: point.lng });
  }
  return venues;
}

/**
 * Write the message history of every locked and completed meetup (AAP 0.12.2): 20 messages, the two
 * participants alternating, spread over the two hours before the seed, so `GET /meetups/:id/messages`
 * has a page to answer with. `Message` has no fixture builder, and the route reads the rows directly.
 */
async function seedMessages(ctx: FactoryContext, meetups: readonly PerfMeetup[]): Promise<number> {
  const now = ctx.services.clock.now();
  const stepMs = (2 * HOUR_MS) / PERF_MESSAGES_PER_PAIR;
  const rows: { meetupId: string; senderId: string; body: string; createdAt: Date }[] = [];

  for (const meetup of meetups) {
    if (meetup.status !== 'locked' && meetup.status !== 'completed') continue;
    for (let number = 1; number <= PERF_MESSAGES_PER_PAIR; number += 1) {
      rows.push({
        meetupId: meetup.id,
        senderId: number % 2 === 0 ? meetup.recipientId : meetup.initiatorId,
        body: `${PERF_MESSAGE_PREFIX}${number}`,
        createdAt: new Date(now.getTime() - (PERF_MESSAGES_PER_PAIR - number) * stepMs),
      });
    }
  }

  if (rows.length === 0) return 0;
  await ctx.services.db.message.createMany({ data: rows });
  return rows.length;
}

/*
 * Tokens, the seed file and the closing check (AAP 0.3.3, 0.12.2)
 */

/**
 * Sign one access token per account, last, so the whole 15-minute lifetime is left for the run: the load
 * test starts immediately after this script, and an expired token answers `401`.
 */
async function signTokens(services: AppServices, users: readonly PerfUser[]): Promise<SignedUsers> {
  const expiresAt = new Date(services.clock.nowMs() + ACCESS_TOKEN_TTL_MINUTES * MINUTE_MS);
  const signed: SeededUser[] = [];
  for (const user of users) {
    signed.push({
      ...user,
      accessToken: await signAccessToken(services, {
        sub: user.id,
        role: 'traveler',
        sid: user.sessionId,
      }),
    });
  }
  return { users: signed, expiresAt };
}

/**
 * Write the file the k6 profile reads, and answer its path (AAP 0.12.2).
 *
 * It carries the five cities' partner venues with their coordinates, their lodgings, and — where the seed
 * wrote its console secrets — the venues of the locked meetups, so the profile can ask for a live
 * check-in code with the venue's own secret. No code is written down: it rotates every 60 seconds
 * (AAP 0.5.7), so it can only be fetched at run time.
 */
async function writeSeedFile(
  ctx: FactoryContext,
  invocation: Invocation,
  env: ApiEnv,
  cities: readonly CityConfig[],
  signed: SignedUsers,
  meetups: readonly PerfMeetup[],
): Promise<string> {
  const outPath = outPathFor(invocation);
  const cityIds = cities.map((city) => city.id);
  const [venues, lodgings] = await Promise.all([
    readPartnerVenues(ctx, cities),
    ctx.services.db.lodging.findMany({
      where: { cityId: { in: cityIds }, osmMissingAt: null },
      select: { id: true, cityId: true },
    }),
  ]);
  const codes = await readVenueSecrets(
    new Set(meetups.filter((meetup) => meetup.status === 'locked').map((meetup) => meetup.venueId)),
  );

  const payload = {
    apiUrl: apiUrlFor(invocation, env),
    generatedAt: ctx.services.clock.now().toISOString(),
    tokenExpiresAt: signed.expiresAt.toISOString(),
    users: signed.users.map((user) => ({
      id: user.id,
      accessToken: user.accessToken,
      cityId: user.cityId,
    })),
    meetups: meetups.map((meetup) => ({
      id: meetup.id,
      initiatorId: meetup.initiatorId,
      recipientId: meetup.recipientId,
      venueId: meetup.venueId,
      startsAt: meetup.startsAt.toISOString(),
      status: meetup.status,
    })),
    venues: venues.map((venue) => ({
      id: venue.id,
      cityId: venue.cityId,
      lat: venue.lat,
      lng: venue.lng,
    })),
    lodgings: lodgings.map((row) => ({ id: row.id, cityId: row.cityId })),
    ...(codes === null ? {} : { codes }),
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: FILE_MODE });
  return outPath;
}

/**
 * The console secrets of the venues the locked meetups happen at, or `null` when the seed wrote no local
 * secret file. The profile uses a venue secret to fetch the live code from `GET /venue/check-in-code`; a
 * run without the file still exercises the write path, and the route answers `422 invalid_code`.
 */
async function readVenueSecrets(
  venueIds: ReadonlySet<string>,
): Promise<readonly { readonly venueId: string; readonly venueSecret: string }[] | null> {
  const secrets = await readFixtureSecrets(
    path.join(findRepoRoot(), FIXTURE_SECRETS_RELATIVE_PATH),
  );
  if (secrets === null) {
    progress(
      `codes: ${FIXTURE_SECRETS_RELATIVE_PATH} is absent; check-in writes will answer 422 invalid_code`,
    );
    return null;
  }
  return secrets.venues
    .filter((entry) => venueIds.has(entry.id))
    .map((entry) => ({ venueId: entry.id, venueSecret: entry.secret }));
}

/**
 * The closing check (AAP 0.12.2): one seeded token against the running API's own read.
 *
 * `GET /me` answers `200` only when the API verifies the token, which means it was signed with the same
 * `JWT_SECRET` and serves the database this script wrote to. Anything else means the two ran against
 * different environments, and the run must not go on to a load test that would measure `401`s.
 *
 * @returns `null` when the API accepted the token, else a reason carrying no token, id or path.
 */
async function checkToken(apiUrl: string, accessToken: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${TOKEN_CHECK_PATH}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return `no answer from ${hostOf(apiUrl)}`;
  }

  if (response.status === TOKEN_OK) return null;
  if (response.status === TOKEN_REJECTED) {
    return 'the API rejected the token (environment differs from the api service)';
  }
  return `the API answered ${response.status}`;
}

/** The host of the API address, for a failure line: the host alone, never a path or a query. */
function hostOf(apiUrl: string): string {
  try {
    return new URL(apiUrl).host;
  } catch {
    return 'the configured api url';
  }
}

/*
 * Reporting and the small shared helpers
 */

/**
 * The closing line, on stdout: what was seeded, and where. It names the output path
 * repository-relative, and never a token, a secret or an address.
 */
function summaryLine(
  users: readonly SeededUser[],
  meetups: readonly PerfMeetup[],
  messages: number,
  outPath: string,
): string {
  const counts = countStatuses(meetups);
  return (
    `${COMMAND}: ${users.length} users, ${meetups.length} meetups ` +
    `(${counts.proposed} proposed, ${counts.locked} locked, ${counts.completed} completed), ` +
    `${messages} messages -> ${displayPath(outPath)}\n`
  );
}

/** How many meetups of each of the three seeded shapes were written. */
function countStatuses(meetups: readonly PerfMeetup[]): Record<SeededStatus, number> {
  const counts: Record<SeededStatus, number> = { proposed: 0, locked: 0, completed: 0 };
  for (const meetup of meetups) counts[meetup.status] += 1;
  return counts;
}

/** One refusal line on stderr, and the exit code that goes with it. */
function refuse(step: string, reason: string): number {
  process.stderr.write(`${COMMAND}: ${step}: ${reason}\n`);
  return 1;
}

/** One progress line on stderr, which is what keeps stdout to the closing line alone. */
function progress(message: string): void {
  process.stderr.write(`${COMMAND}: ${message}\n`);
}

/**
 * A short, value-free token for a failure: the driver's own code when the error carries one, else its
 * class name. A Prisma error reports `P2002` and the like, which is what tells an operator a duplicate
 * key from an unreachable database without quoting a value (AAP 0.11.1, 0.12.2).
 */
function failureToken(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown_error';
  if ('code' in error) {
    const code: unknown = error.code;
    if (typeof code === 'string' && code !== '') return code;
  }
  return error.name;
}

/** The output path as the closing line names it: repository-relative when it is inside the tree. */
function displayPath(outPath: string): string {
  const relative = path.relative(findRepoRoot(), outPath);
  return relative === '' || relative.startsWith('..') ? outPath : relative;
}

/**
 * Run `task` for every item with at most `limit` of them in flight. Seeding 1,000 accounts and 200 meetups
 * is dominated by the round trips to the database and, in `mock`, to the Stripe proxy; the callers' own
 * failure handling turns whatever a task throws into one refusal line.
 */
async function eachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, position: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const position = next;
      next += 1;
      const item = items[position];
      if (item === undefined) return;
      await task(item, position);
    }
  });
  await Promise.all(workers);
}

/**
 * The element of `items` at `position`, wrapping around the list. Wrapping is what rotates the deposit
 * levels and the venues; for the city's accounts the callers' bounds check has already established that
 * no wrap happens.
 */
function at<T>(items: readonly T[], position: number): T {
  const item = items[position % items.length];
  if (item === undefined) throw new SeedFailure('run', 'an empty list was indexed');
  return item;
}

/** The `@db.Date` value of a `YYYY-MM-DD` day: midnight UTC, so no offset can move the calendar day. */
function dateColumn(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

/**
 * Close the app, bounded by {@link CLOSE_TIMEOUT_MS}. Nothing was started in this process, so closing it
 * gives back only the connections and the Prisma client that building it created. A close that fails, or
 * that outlives the bound, is not reported as this command's failure: the seed is durable by then, so the
 * exit code describes the seed rather than the shutdown.
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
    // See above: the shutdown is not what this process was asked to do.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
