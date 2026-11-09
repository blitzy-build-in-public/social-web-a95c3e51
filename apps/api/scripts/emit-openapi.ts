/**
 * Emits `docs/api/openapi.json` from the routes the API actually registers.
 *
 * Run it with `pnpm --filter @tablemate/api openapi:emit`, or with `--check` for the drift check a release step runs. The app is
 * composed through `buildApp` with a placeholder environment built from the constants in this file and never from `process.env`,
 * so the document depends neither on the shell nor on any running service; the placeholder secrets are generated per run and
 * appear in no output.
 *
 * The committed file is generated: never hand-edit it, and re-run this script after changing a route's schema.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { EnvValidationError, createLogger, loadApiEnv } from '@tablemate/server-core';

import { buildApp } from '../src/app.ts';
import { findRepoRoot } from '../src/modules/proofs/registry.ts';

import type { ApiEnv } from '@tablemate/server-core';
import type { App } from '../src/app.ts';

/** Where the document is written, relative to the repository root (AAP 0.8.1). */
const OUTPUT_FILE = 'docs/api/openapi.json';

/** The version prefix every emitted document carries; anything else is not an OpenAPI 3 document. */
const OPENAPI_VERSION_PREFIX = '3.';

/** The prefix the test-control routes carry. `APP_ENV=demo` keeps them unregistered, so a path under it can only mean the
 * placeholder environment drifted from `test`. */
const TEST_PATH_PREFIX = '/v1/test/';

/** How long the app is given to close before the process ends anyway: no client may hang the run. */
const CLOSE_TIMEOUT_MS = 5_000;

/** How long a drain may wait for the reader of stdout and stderr before the process is ended anyway (one second): a consumer
 * that never reads must not hold the run open. */
const EXIT_DRAIN_TIMEOUT_MS = 1_000;

/** One route per contract group, whose absence means the document was collected too early (AAP 0.5.4). */
const REQUIRED_PATHS = [
  '/v1/health',
  '/v1/itinerary-proofs',
  '/v1/meetups',
  '/v1/meetups/{id}/accept',
  '/v1/webhooks/stripe',
  '/v1/admin/metrics',
  '/v1/zk/config',
] as const;

/** The authentication modes the document must document (AAP 0.3.3). */
const REQUIRED_SECURITY_SCHEMES = ['bearer', 'venueSecret', 'lodgingSecret'] as const;

/** The parts of the emitted document this script reads: its version, its path table and its schemes. */
interface EmittedDocument {
  readonly openapi: string;
  readonly paths: Record<string, unknown>;
  readonly components?: { readonly securitySchemes?: Record<string, unknown> };
}

/**
 * End the process with `code` once every byte already written to stdout and stderr has reached its consumer: a write to a pipe is
 * completed by the event loop, so `process.exit()` discards whatever is still queued — under `| tee` that is the last,
 * machine-readable line this script exists to print. {@link EXIT_DRAIN_TIMEOUT_MS} bounds a consumer that never drains.
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
 * The marker a refusal throws once its own line is written: only the top-level handler can drain the streams before the process
 * ends, and throwing is what keeps `fail`'s `never` return type, which the callers rely on for the definite assignment of `env`.
 */
class RefusalError extends Error {
  constructor() {
    super('emit-openapi: refused the run');
    this.name = 'RefusalError';
  }
}

function writeRefusal(step: string, reason: string): void {
  process.stderr.write(`emit-openapi: ${step}: ${reason}\n`);
}

/**
 * Refuse the run in the one-line form every failure takes: the line is written where the failure is detected and the refusal is
 * thrown rather than the process ended here, so the top-level handler can drain the line first. Throws {@link RefusalError}
 * always.
 */
function fail(step: string, reason: string): never {
  writeRefusal(step, reason);
  throw new RefusalError();
}

/** A per-run placeholder for a secret variable (`envSecret`): it reaches no output and no log line. */
function placeholderSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** A per-run placeholder for `FIELD_ENCRYPTION_KEY`: standard base64 of exactly 32 bytes. */
function placeholderFieldKey(): string {
  return randomBytes(32).toString('base64');
}

/**
 * The placeholder environment the app is composed with. Every value is a constant of this file, so two runs on two machines emit
 * the same bytes, and the combination reaches no provider: `STRIPE_MODE=mock` takes server-core's own non-secret placeholders,
 * `TELEPHONY_MODE=off` and `LLM_PROVIDER=fake` hold no credential, and no test-only variable is set, because the loader refuses
 * one outside `APP_ENV=test`. The service URLs name the reserved `.invalid` TLD.
 */
function placeholderEnv(): Readonly<ApiEnv> {
  return loadApiEnv({
    APP_ENV: 'demo',
    LOG_LEVEL: 'error',
    DATABASE_URL: 'postgresql://db.invalid:5432/openapi',
    REDIS_URL: 'redis://redis.invalid:6379',
    FIELD_ENCRYPTION_KEY: placeholderFieldKey(),
    FIELD_ENCRYPTION_KEY_ID: 'openapi',
    ANALYTICS_SALT: placeholderSecret(),
    TELEPHONY_MODE: 'off',
    LLM_PROVIDER: 'fake',
    STRIPE_MODE: 'mock',
    STRIPE_API_BASE: 'http://stripe-proxy.invalid:12100',
    API_PUBLIC_URL: 'http://localhost:3000',
    WEB_ORIGIN: 'http://localhost:8080',
    VENUE_CONSOLE_ORIGIN: 'http://localhost:8090',
    ARTIFACTS_BASE_URL: 'http://localhost:8070',
    JWT_SECRET: placeholderSecret(),
    EMAIL_LOOKUP_PEPPER: placeholderSecret(),
    EXPERIMENT_SALT: placeholderSecret(),
    NULLIFIER_SALT: '1',
    TERMS_VERSION: 'openapi-placeholder',
  });
}

/**
 * The document `app.swagger()` returned, checked structurally: `@fastify/swagger` types that call as any OpenAPI version, so the
 * two members this script reads are narrowed rather than asserted.
 */
function readDocument(value: unknown): EmittedDocument {
  const candidate = value as Partial<EmittedDocument> | null;
  if (candidate === null || typeof candidate !== 'object') {
    fail('document', 'the generator returned no document');
  }
  const { openapi, paths } = candidate;
  if (typeof openapi !== 'string' || !openapi.startsWith(OPENAPI_VERSION_PREFIX)) {
    fail('document', `the generator returned no OpenAPI ${OPENAPI_VERSION_PREFIX}x document`);
  }
  if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) {
    fail('document', 'the generated document carries no path table');
  }
  return candidate as EmittedDocument;
}

/** Require the document to hold the routes and the security schemes the contract names, and no test-only path. */
function assertDocumentShape(doc: EmittedDocument): void {
  const missing = REQUIRED_PATHS.filter((route) => !(route in doc.paths));
  if (missing.length > 0) {
    fail('document', `path(s) absent from the generated document: ${missing.join(', ')}`);
  }
  const testPath = Object.keys(doc.paths).find((route) => route.startsWith(TEST_PATH_PREFIX));
  if (testPath !== undefined) {
    fail('document', `test-only path present in the generated document: ${testPath}`);
  }
  const schemes = doc.components?.securitySchemes ?? {};
  const absent = REQUIRED_SECURITY_SCHEMES.filter((scheme) => !(scheme in schemes));
  if (absent.length > 0) {
    fail('document', `security scheme(s) absent from the generated document: ${absent.join(', ')}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/** Close the app, bounded: a client built lazily but never connected must not be able to hang the run, and the caller ends the
 * process explicitly either way. */
async function closeWithin(app: App, timeoutMs: number): Promise<void> {
  await Promise.race([app.close(), sleep(timeoutMs)]);
}

async function readIfPresent(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, 'utf8');
  } catch {
    return undefined;
  }
}

/** Write the document, or compare it with the committed file; a mismatch refuses the run. */
async function writeOrCheck(
  text: string,
  target: string,
  pathCount: number,
  check: boolean,
): Promise<void> {
  if (check) {
    if ((await readIfPresent(target)) !== text) {
      process.stderr.write(`${OUTPUT_FILE} is out of date\n`);
      throw new RefusalError();
    }
    process.stdout.write(`openapi: ${OUTPUT_FILE} is up to date (${pathCount} paths)\n`);
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
  process.stdout.write(`openapi: wrote ${OUTPUT_FILE} (${pathCount} paths)\n`);
}

function describeError(error: unknown): string {
  if (error instanceof EnvValidationError) {
    return error.message;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown failure';
}

/** Emit the document: load the placeholder environment, compose the app, read the document back once every route is resolved, and
 * write it or compare it. */
async function main(argv: readonly string[]): Promise<void> {
  const check = argv.includes('--check');
  let env: Readonly<ApiEnv>;
  try {
    env = placeholderEnv();
  } catch (error) {
    fail('environment', describeError(error));
  }
  const logger = createLogger({ name: 'emit-openapi', level: 'error', appEnv: 'demo' });
  const app = buildApp({ env, logger });
  let document: EmittedDocument | undefined;
  try {
    // Loading the plugins resolves every route, and `@fastify/swagger` collects them through its own
    // `onRoute` hook while they are resolved — so a document read before this point is empty.
    await app.ready();
    document = readDocument(app.swagger({ yaml: false }));
  } finally {
    await closeWithin(app, CLOSE_TIMEOUT_MS);
  }
  if (document === undefined) {
    fail('document', 'the app was closed before a document was read');
  }
  assertDocumentShape(document);
  // Two spaces and one trailing newline: an unchanged route set therefore yields byte-identical
  // output across runs and machines, because nothing here carries a time, an id or the environment.
  const text = `${JSON.stringify(document, null, 2)}\n`;
  await writeOrCheck(
    text,
    path.join(findRepoRoot(), OUTPUT_FILE),
    Object.keys(document.paths).length,
    check,
  );
}

main(process.argv.slice(2)).then(
  () => {
    exitAfterFlush(0);
  },
  (error: unknown) => {
    // A refusal wrote its own line where it was detected; anything else is reported in the same form.
    if (!(error instanceof RefusalError)) {
      writeRefusal('emit', describeError(error));
    }
    exitAfterFlush(1);
  },
);
