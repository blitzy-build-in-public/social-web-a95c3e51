/**
 * `grant-operator`: grants or revokes the `operator` role (AAP 0.3.3). Every `/v1/admin/*` route and the `/ops`
 * dashboard are guarded by `requireOperator`, so this CLI is the only way an account obtains the role; it is an
 * operator-run command, never a request path, and no file of the API imports it.
 *
 * Inputs: one positional email address and the optional `--revoke`, which demotes to `traveler`. The address is
 * hashed under `EMAIL_LOOKUP_PEPPER` exactly as `POST /auth/magic-link` hashes it, and the target must have signed
 * in at least once, since the row is created by the first `POST /auth/verify`.
 *
 * Output is exactly one stdout line of JSON, `{"userId":…,"role":…,"changed":…}`, and the process exit code:
 * `0` once the account holds the requested role, `1` for every refusal, which is one line on stderr. Neither
 * stream carries the address, the lookup hash, a session id, a token or a connection string (AAP 0.11.1, 0.12.2).
 *
 * A change revokes every unrevoked session of the account inside the same transaction, so the next access token
 * carries the new `role` claim. That revocation is durable in PostgreSQL; Redis carries only the cache and the
 * socket-closing invalidation, so an unreachable Redis leaves the change in force and warns rather than fails.
 */

import { Prisma, type DbTx } from '@tablemate/db';
import {
  EnvValidationError,
  createLogger,
  emailLookupHash,
  loadApiEnv,
  waitForRedisReady,
} from '@tablemate/server-core';
import { MagicLinkRequest, type UserRole } from '@tablemate/shared';

import { buildApp, type App, type AppServices } from '../src/app.ts';
import { invalidateUserSessions } from '../src/plugins/auth.ts';

import type { ApiEnv } from '@tablemate/server-core';

/** The command's name, used by the usage line and by every refusal this file writes itself. */
const COMMAND = 'grant-operator';

/** The logger's service name: a warning names this CLI, not the API whose container it borrows. */
const LOGGER_NAME = 'grant-operator';

/** The one flag accepted. Any other argument beginning with `-` is a usage error. */
const REVOKE_FLAG = '--revoke';

/**
 * The end-of-options separator, ignored rather than refused: `pnpm run` forwards the `--` of the documented host
 * invocation verbatim into the argument list, so it reaches this parser as `['--', <email>]`.
 */
const OPTIONS_SEPARATOR = '--';

/**
 * How long the app's shutdown may take before the process exits regardless (five seconds): a stuck dependency
 * must not hold the command open, since the role change is committed by then and nothing is left to wait for.
 */
const CLOSE_TIMEOUT_MS = 5_000;

/**
 * How long a drain may wait for the reader of stdout and stderr before the process is ended anyway (one second):
 * a consumer that never reads must not hold the command open once the role change is committed.
 */
const EXIT_DRAIN_TIMEOUT_MS = 1_000;

/** The usage line, written for a missing, extra or unknown argument. It never quotes the argument. */
const USAGE_LINE = `usage: ${COMMAND} <email> [--revoke]\n`;

/** The refusal a malformed address gets, in place of the usage line. It never echoes the argument. */
const INVALID_EMAIL = `${COMMAND}: invalid email argument\n`;

/**
 * How long to wait for the Redis connection's first `ready` before giving up on the invalidation (two seconds).
 * The session cache's own commands are bounded far more tightly (250 ms).
 */
const INVALIDATION_READY_TIMEOUT_MS = 2_000;

/**
 * The warning an unreachable Redis leaves: the change and the revocations are committed, and a cached
 * session can serve reads for 30 seconds longer.
 */
const CACHE_WARNING = `${COMMAND}: session cache not invalidated; cached sessions expire within 30 s\n`;

interface Invocation {
  /** The address as given, validated but not normalized; the lookup hash normalizes it. */
  readonly email: string;
  /** True when the account is demoted to `traveler` rather than promoted to `operator`. */
  readonly revoke: boolean;
}

/**
 * The outcome of parsing the argument list, so the caller can tell a usage mistake from a malformed
 * address without re-reading the arguments.
 */
type ParsedInvocation =
  | { readonly kind: 'ok'; readonly invocation: Invocation }
  | { readonly kind: 'usage' }
  | { readonly kind: 'invalid_email' };

/**
 * The target account as its locking read returns it: the four facts the decision is made from, and nothing that
 * identifies the person.
 */
interface LockedUserRow {
  readonly id: string;
  readonly role: UserRole;
  readonly deletion_requested_at: Date | null;
  readonly deleted_at: Date | null;
}

interface RoleChange {
  readonly userId: string;
  /** The role the account holds now: the requested one, whether or not it had to change. */
  readonly role: UserRole;
  /** False when the account already held the requested role, in which case nothing was written. */
  readonly changed: boolean;
  /** The sessions this run revoked, whose cache entries and sockets are dropped after the commit. */
  readonly sessionIds: readonly string[];
}

/**
 * A refusal this command can name: the step that failed and a reason that quotes nothing the caller or the
 * environment supplied. Thrown rather than returned, so it rolls the Prisma transaction back and leaves a refused
 * promotion with no row touched.
 */
class GrantFailure extends Error {
  /** The step that failed: `lookup` for an address with no account, `role change` for the rest. */
  readonly step: string;

  constructor(step: string, reason: string) {
    super(`${step}: ${reason}`);
    this.name = 'GrantFailure';
    this.step = step;
  }
}

/**
 * End the process with `code` once every byte already written to stdout and stderr has reached its consumer.
 *
 * A write to a pipe is completed by the event loop, so `process.exit()` discards whatever is still queued — under
 * `| tee` or a CI log collector that is the last, machine-readable line this command exists to print. An empty
 * write queued behind the real ones calls back once they have been flushed, and a consumer that stopped reading
 * closes the pipe instead, which ends the drain the same way. {@link EXIT_DRAIN_TIMEOUT_MS} bounds a consumer that
 * never drains.
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
 * Parse, apply and report in one call, and answer the process exit code. The app is built and closed around the
 * change and never started as a server: `startBackground` is deliberately not called, so this process holds no
 * worker, no sweeper and no socket.
 */
async function run(argv: readonly string[]): Promise<number> {
  const parsed = parseArguments(argv);
  if (parsed.kind !== 'ok') {
    process.stderr.write(parsed.kind === 'usage' ? USAGE_LINE : INVALID_EMAIL);
    return 1;
  }
  const env = loadEnvironment();
  if (env === null) {
    return 1;
  }
  const app = buildApp({ env, logger: createLoggerFor(env) });
  try {
    const change = await applyRole(app.services, parsed.invocation);
    await announceSessions(app.services, change);
    process.stdout.write(
      `${JSON.stringify({ userId: change.userId, role: change.role, changed: change.changed })}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${COMMAND}: ${failureText(error)}\n`);
    return 1;
  } finally {
    await closeBounded(app);
  }
}

/**
 * Read the argument list: one positional address and the optional `--revoke` flag. Validation is the sign-in
 * route's own schema (`MagicLinkRequest`), so an address this command accepts is one `POST /auth/magic-link`
 * accepts, and a malformed address — a padded one included — is refused as an argument error rather than hashed
 * into a lookup that matches nothing.
 */
function parseArguments(argv: readonly string[]): ParsedInvocation {
  let revoke = false;
  const positional: string[] = [];
  for (const argument of argv) {
    if (argument === OPTIONS_SEPARATOR) {
      continue;
    }
    if (argument === REVOKE_FLAG) {
      revoke = true;
      continue;
    }
    if (argument.startsWith('-')) {
      return { kind: 'usage' };
    }
    positional.push(argument);
  }
  const email = positional.length === 1 ? positional[0] : undefined;
  if (email === undefined) {
    return { kind: 'usage' };
  }
  if (!MagicLinkRequest.safeParse({ email }).success) {
    return { kind: 'invalid_email' };
  }
  return { kind: 'ok', invocation: { email, revoke } };
}

/**
 * Load the `api` environment, or report the loader's findings and answer `null` (AAP 0.6.2). The message is the
 * loader's own — a variable name with a fixed reason for each finding, never a value (AAP 0.12.2); any other throw
 * is a defect in the loader rather than a configuration problem, so it travels on to the caller's reporting.
 */
function loadEnvironment(): ApiEnv | null {
  try {
    return loadApiEnv();
  } catch (error) {
    if (!(error instanceof EnvValidationError)) {
      throw error;
    }
    process.stderr.write(`${COMMAND}: environment: ${error.message}\n`);
    return null;
  }
}

/**
 * The CLI's logger: warnings and above, written to stderr, which is what keeps stdout to the one result line —
 * otherwise the session-cache warning `invalidateUserSessions` logs when a Redis drop fails would share it.
 */
function createLoggerFor(env: ApiEnv): ReturnType<typeof createLogger> {
  return createLogger({
    name: LOGGER_NAME,
    level: 'warn',
    appEnv: env.APP_ENV,
    destination: process.stderr,
  });
}

/**
 * Apply the requested role to the account that owns the address, in one transaction.
 *
 * The address is hashed into `emailLookupHash` and resolved to an account, which is locked with `SELECT … FOR
 * UPDATE` before anything is decided: `DELETE /me` takes `FOR UPDATE` on the same row and revokes the account's
 * sessions in the same transaction, so the two are serialized (AAP 0.5.3). An account that has requested deletion
 * refuses here rather than being promoted.
 *
 * An account that already holds the requested role is written to not at all — no role update and no revocation —
 * so a repeated run changes neither the account nor its signed-in sessions.
 */
async function applyRole(services: AppServices, invocation: Invocation): Promise<RoleChange> {
  const lookup = emailLookupHash(services.env.EMAIL_LOOKUP_PEPPER, invocation.email);
  const target: UserRole = invocation.revoke ? 'traveler' : 'operator';
  // Read once, outside the transaction: the clock is a dependency of the decision rather than part of
  // it, and every revocation this run writes carries the same instant (AAP 0.11.1).
  const now = services.clock.now();
  try {
    return await services.db.$transaction(async (tx: DbTx): Promise<RoleChange> => {
      const located = await tx.user.findUnique({
        where: { emailLookupHash: lookup },
        select: { id: true },
      });
      if (located === null) {
        throw new GrantFailure('lookup', 'no account for that email');
      }
      // `user` is a reserved word, so the table is double-quoted, and the id binds as a parameter cast
      // to uuid (AAP 0.11.2). The row is read for the three columns the decision needs and nothing
      // else: no email ciphertext, handle or Stripe customer id leaves this statement.
      const rows = await tx.$queryRaw<LockedUserRow[]>(Prisma.sql`
        SELECT "id"::text AS "id", "role", "deletion_requested_at", "deleted_at"
          FROM "user"
         WHERE "id" = ${located.id}::uuid
           FOR UPDATE
      `);
      const row = rows[0];
      if (row === undefined) {
        throw new GrantFailure('lookup', 'no account for that email');
      }
      if (row.deleted_at !== null || row.deletion_requested_at !== null) {
        throw new GrantFailure('role change', 'account is deleted or pending deletion');
      }
      if (row.role === target) {
        return { userId: row.id, role: row.role, changed: false, sessionIds: [] };
      }
      await tx.user.update({ where: { id: row.id }, data: { role: target } });
      // Every unrevoked session of the account: a fresh sign-in is what mints a token carrying the
      // new claim. `revoked_at` is the condition as well as the value, so a session a concurrent
      // logout already revoked is left to that logout.
      const revoked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE "session" SET "revoked_at" = ${now}
         WHERE "user_id" = ${row.id}::uuid AND "revoked_at" IS NULL
        RETURNING "id"::text AS "id"
      `);
      return {
        userId: row.id,
        role: target,
        changed: true,
        sessionIds: revoked.map((session) => session.id),
      };
    });
  } catch (error) {
    if (error instanceof GrantFailure) {
      throw error;
    }
    throw new GrantFailure('role change', failureToken(error));
  }
}

/**
 * Tell every API instance that the revoked sessions are gone, after the transaction committed.
 *
 * A connection of a fail-fast role rejects a command issued before its first `ready` (`enableOfflineQueue:
 * false`, AAP 0.3.2) and nothing in this short-lived process has awaited one yet, so the wait below is what makes
 * a healthy Redis actually drop the cache entries and close the sockets. `api/src/main.ts` awaits the same helper
 * before serving its first request.
 *
 * The change and the revocations are already durable, so this is an optimisation whose failure costs at most the
 * 30-second cache lifetime of a read-only session, and no write can ride a cached session because every write
 * re-reads its own session behind the deletion fence (AAP 0.5.3) — hence a warning and a successful exit code.
 */
async function announceSessions(services: AppServices, change: RoleChange): Promise<void> {
  if (change.sessionIds.length === 0) {
    return;
  }
  try {
    await waitForRedisReady(services.redis.client, INVALIDATION_READY_TIMEOUT_MS);
    await invalidateUserSessions(services, change.userId, change.sessionIds);
  } catch {
    process.stderr.write(CACHE_WARNING);
  }
}

/**
 * Close the app, bounded by {@link CLOSE_TIMEOUT_MS}. A close that fails, or that outlives the bound, is not
 * reported as this command's failure: the role change is committed, so the exit code describes the change rather
 * than the shutdown, and the app's one `onClose` hook has already logged the failed step.
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
    // See above: the shutdown is not what this process was asked to do, and it is already reported.
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * One `<step>: <reason>` payload for the `grant-operator: ` line. A {@link GrantFailure} already carries both;
 * anything else is a defect rather than a refusal, so it is named by its code or its class, since a driver's
 * message can quote the value it was given (AAP 0.11.1, 0.12.2).
 */
function failureText(error: unknown): string {
  if (error instanceof GrantFailure) {
    return error.message;
  }
  return `run: ${failureToken(error)}`;
}

/**
 * A short, value-free token for a failure: the driver's own code when the error carries one, else its class name.
 * A Prisma error reports `P1001` and the like, which tells an operator an unreachable database from a refused
 * statement.
 */
function failureToken(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown_error';
  }
  if ('code' in error) {
    const code: unknown = error.code;
    if (typeof code === 'string' && code !== '') {
      return code;
    }
  }
  return error.name;
}
