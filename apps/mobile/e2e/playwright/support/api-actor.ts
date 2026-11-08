/** The shared end-to-end harness: */
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { chromium } from '@playwright/test';
import { buildCircuitInputs } from '@tablemate/circuits';
import {
  AdminDisputeDto,
  AdminDisputesResponse,
  ArtifactsManifest,
  CancelResponse,
  CitiesResponse,
  ErrorEnvelope,
  MeetupListResponse,
  ProofAccepted,
  ProofSubmission,
  RefreshResponse,
  ResolveDispute,
  SecretIssued,
  TEST_CONTROL_HEADER,
  TestClockRequest,
  VENUE_SECRET_HEADER,
  VenueCodeResponse,
  VenuesResponse,
  VerifyResponse,
  ZkConfig,
  MeDto,
} from '@tablemate/shared';
import { TERMS_VERSION } from '../../../src/copy/strings.ts';
import { waitForMagicLink } from './mailpit.ts';
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Frame,
  Locator,
  Page,
} from '@playwright/test';

/*
 * The suite's vocabulary.
 */

/** The two traveler actors of criterion 1, and the operator the queues are driven as (AAP 0.11.2). */
export type Role = 'a' | 'b' | 'operator';

/** What `e2eEnv` resolves: the stack's origins and the two mode switches the suite reacts to. */
export interface E2eEnv {
  readonly webUrl: string;
  readonly consoleUrl: string;
  /** The API origin, to which `/v1` is appended by every request. */
  readonly apiUrl: string;
  readonly mailpitUrl: string;
  readonly testControlToken: string;
  /** `test` when the stack holds Stripe test-mode keys, otherwise `mock` (AAP 0.11.2). */
  readonly stripeMode: 'test' | 'mock';
}

/** A response schema as this harness reads one: the shared Zod schema, typed by what it parses to. */
interface ResponseSchema<T> {
  parse(value: unknown): T;
}

/** The parsed shape of a shared schema, so no contract shape is restated here (AAP 0.11.1). */
type Me = ReturnType<typeof MeDto.parse>;
type Zk = ReturnType<typeof ZkConfig.parse>;
type Manifest = ReturnType<typeof ArtifactsManifest.parse>;
type Verified = ReturnType<typeof VerifyResponse.parse>;
type Rotation = ReturnType<typeof RefreshResponse.parse>;
type Code = ReturnType<typeof VenueCodeResponse.parse>;
type Submission = ReturnType<typeof ProofSubmission.parse>;
type MeetupPage = ReturnType<typeof MeetupListResponse.parse>;
type Meetup = MeetupPage['items'][number];

/** One actor's persisted, non-secret state plus the chain its access tokens are minted from. */
interface ActorRecord {
  email: string;
  userId: string;
  refreshToken: string;
  variant: string | null;
  cityId: string | null;
  arrivalDate: string | null;
  departureDate: string | null;
  hasCard: boolean;
}

/** The venue criterion 1 meets at, with the console secret the rotation code is validated by. */
interface VenueRecord {
  id: string;
  cityId: string;
  lat: number;
  lng: number;
  secret: string;
}

/** The city days the suite has consumed, and the window both proofs cover. */
interface CursorRecord {
  overlapStart: string;
  overlapEnd: string;
  lastLocalDate: string;
  timezone: string;
}

/** `.local/e2e/actors-<sha>.json`: everything that must survive between spec files (AAP 0.11.2). */
interface Registry {
  refreshKey: string | null;
  actors: { a: ActorRecord | null; b: ActorRecord | null };
  operator: { email: string; userId: string; refreshToken: string } | null;
  maestroOperators: Record<string, string>;
  venue: VenueRecord | null;
  cursor: CursorRecord | null;
  /** Every magic-link request per address, so the 5-per-hour budget cannot be exceeded (AAP 0.5.4). */
  magicLinks: Record<string, number[]>;
}

/** One meetup day for a criterion walk: what to propose and what the clock was moved to. */
export interface MeetupDay {
  localDate: string;
  startsAt: string;
  timezone: string;
}

/** The non-secret facts a spec may assert on, for either actor. */
export interface ActorInfo {
  email: string;
  userId: string;
  variant: string | null;
  cityId: string | null;
  arrivalDate: string | null;
  departureDate: string | null;
}

/*
 * Constants.
 */

/** What `scripts/e2e.ts` writes for every flow it can only run with Stripe test-mode keys. */
export const BLOCKED_REASON = 'Blocked — Stripe test-mode keys not supplied';

/** The workspace marker that locates the repository root, as every other harness does. */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/** Where everything this harness writes lives, relative to the repository root (AAP 0.11.2). */
const LOCAL_DIR = '.local';

/** The directory the registry and the recorded proof request live in. */
const E2E_DIR = 'e2e';

/** The cached harness proofs, shared in name with the API's own fixture-proof cache. */
const PROOF_CACHE_DIR = 'test-proofs';

/** Where `POST /itinerary-proofs` bodies are recorded, for criterion 3's assertion. */
const PROOF_REQUEST_KIND = 'criterion3';
const PROOF_REQUEST_NAME = 'actor-a-proof-request.json';

/** The committed fixture emails, by stem (AAP 0.8.1). */
const FIXTURE_DIR = 'packages/circuits/fixtures/test-issuer';

/** `pnpm circuits:build`'s output: the files `snarkjs` proves with. */
const BUILD_DIR = 'packages/circuits/build';

/** The seed's console secrets, written once and reused by every reader (AAP 0.5.2). */
const FIXTURE_SECRETS_FILE = 'fixture-secrets.json';

/** A magic link may be requested 5 times an hour per address, and the 6th is `429` (AAP 0.5.4). */
const MAGIC_LINK_BUDGET = 5;
const MAGIC_LINK_WINDOW_MS = 3_600_000;

/** The access-token lifetime is 15 minutes, so a cached one is trusted for 10 (AAP 0.3.3). */
const ACCESS_TOKEN_TRUST_MS = 600_000;

/** One step of the rotating venue code, which is the resolution of `apiNow()` (AAP 0.5.7). */
const CODE_STEP_MS = 60_000;

/** How long a proof may take in the browser Worker: minutes, on a device with the key cached. */
const UI_STEP_TIMEOUT_MS = 15 * 60_000;

/** The Payment Element's own controls, filled with Stripe's public test card (AAP 0.11.2). */
const TEST_CARD = {
  number: '4242 4242 4242 4242',
  expiry: '12 / 34',
  cvc: '123',
  postalCode: '10001',
};

/** A missing circuit build is one failure, naming the command that fixes it. */
const MISSING_ARTEFACTS = `circuit artefacts missing at ${BUILD_DIR} — run pnpm circuits:build`;

/*
 * Environment: the suite's only reader, memoized so the defaults cannot drift between callers.
 */

let envCache: E2eEnv | undefined;

/** The stack this suite runs against (AAP 0.11.2), read once.
 *
 * @returns The frozen environment.
 * @throws Error naming `TEST_CONTROL_TOKEN` when it is unset.
 */
export function e2eEnv(): E2eEnv {
  const existing = envCache;
  if (existing !== undefined) return existing;

  const testControlToken = envVar('TEST_CONTROL_TOKEN');
  if (testControlToken === '') {
    throw new Error(
      'TEST_CONTROL_TOKEN is not set: the e2e stack must run with APP_ENV=test and that token, which scripts/e2e.ts supplies',
    );
  }

  envCache = Object.freeze({
    webUrl: originOf('E2E_WEB_URL', 'http://localhost:8080'),
    consoleUrl: originOf('E2E_CONSOLE_URL', 'http://localhost:8090'),
    apiUrl: originOf('E2E_API_URL', 'http://localhost:3000'),
    mailpitUrl: originOf('E2E_MAILPIT_URL', 'http://localhost:8025'),
    testControlToken,
    stripeMode: envVar('STRIPE_MODE') === 'test' ? 'test' : 'mock',
  });

  return envCache;
}

/** One environment variable, trimmed. */
function envVar(name: string): string {
  const from = process.env as Record<string, string | undefined>;
  const value = from[name];
  return typeof value === 'string' ? value.trim() : '';
}

/** One origin from the environment, without a trailing slash, or the published default. */
function originOf(name: string, fallback: string): string {
  const configured = envVar(name);
  return (configured === '' ? fallback : configured).replace(/\/+$/, '');
}

/**
 * A locator for the visible element carrying one test id.
 *
 * React Navigation keeps a hidden copy of every screen mounted — a `display: none` twin of each
 * `data-testid` — so a plain `getByTestId` resolves to one that is not on screen and a click on it
 * never lands. `:visible` is what selects the live copy, and it is how every screen and tab is
 * reached here.
 */
function visible(page: Page, testID: string): Locator {
  return page.locator(`[data-testid="${testID}"]:visible`);
}

/**
 * Waits until one of `testIDs` is on screen and answers it.
 *
 * A screen is reached with `page.goto` or a tab press, and between the two the app re-renders: a
 * click issued in that window lands on a node React has already replaced and changes nothing. So
 * every step waits for the screen it moved to before it touches anything on it.
 *
 * Every node carrying an id is examined rather than the first one in document order, for the reason
 * {@link visible} gives: React Navigation keeps a hidden copy of each screen mounted, and that copy
 * is usually the earlier of the two, so its zero-sized box would answer for a screen that is on
 * screen. An id counts as arrived when any of its nodes is laid out and not `visibility: hidden`.
 *
 * @throws Error when none of the ids appears inside the deadline.
 */
async function awaited(
  page: Page,
  testIDs: readonly string[],
  timeoutMs = PAGE_READY_TIMEOUT_MS,
): Promise<string> {
  const handle = await page
    .waitForFunction(
      (ids: string[]) =>
        ids.find((id) =>
          [...document.querySelectorAll(`[data-testid="${id}"]`)].some((el) => {
            const box = el.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
          }),
        ) ?? false,
      [...testIDs],
      { timeout: timeoutMs },
    )
    .catch(() => null);

  const found: unknown = handle === null ? undefined : await handle.jsonValue();
  if (typeof found === 'string') return found;

  throw new Error(`none of ${testIDs.join(', ')} appeared within ${String(timeoutMs)} ms`);
}

/*
 * Paths. Everything this harness writes lives under the git-ignored `.local/` (AAP 0.11.2).
 */

let rootCache: string | undefined;

/**
 * The repository root: the nearest ancestor of the working directory holding the workspace marker.
 *
 * @returns Its absolute path.
 * @throws Error when no ancestor holds `pnpm-workspace.yaml`.
 */
export function repoRoot(): string {
  const existing = rootCache;
  if (existing !== undefined) return existing;

  let dir = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) {
      rootCache = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`repository root not found (${WORKSPACE_MARKER})`);
    dir = parent;
  }
}

/** An absolute path inside `.local/e2e/`. */
export function localPath(...segments: readonly string[]): string {
  return join(repoRoot(), LOCAL_DIR, E2E_DIR, ...segments);
}

/** Writes one JSON result under `.local/e2e/<kind>/<name>.json`, creating the directory.
 *
 * @param kind - The result's group, such as `criterion3`.
 * @param name - Its file name, extension included.
 * @param data - Any JSON-serializable value.
 * @returns The path written.
 */
export function writeResult(kind: string, name: string, data: unknown): string {
  const file = localPath(kind, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

/** A fresh address for an account that is not one of the two actors, e.g. a throwaway operator. */
export function throwawayEmail(purpose: string): string {
  return `e2e-${purpose}-${randomHex(8)}@example.com`;
}

/** Random hex characters, from the platform's own entropy source. */
function randomHex(chars: number): string {
  return randomBytes(Math.ceil(chars / 2))
    .toString('hex')
    .slice(0, chars);
}

/** The first `chars` hex characters of the SHA-256 of `text`, for a stable per-stack name. */
function digestOf(text: string, chars: number): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, chars);
}

/*
 * The registry: the stack's own scratch state, keyed by the test-control token so a fresh stack
 * starts from a fresh registry and a rerun against the same one reuses its accounts (AAP 0.11.2).
 */

let registryCache: Registry | null = null;

/** Where this stack's registry lives, mode 0600 because it holds refresh tokens. */
function registryFile(): string {
  return localPath(`actors-${digestOf(e2eEnv().testControlToken, 12)}.json`);
}

/** An empty registry: no accounts, no venue, no consumed days. */
function emptyRegistry(): Registry {
  return {
    refreshKey: null,
    actors: { a: null, b: null },
    operator: null,
    maestroOperators: {},
    venue: null,
    cursor: null,
    magicLinks: {},
  };
}

/** The registry, read once per process. */
function registry(): Registry {
  const existing = registryCache;
  if (existing !== null) return existing;

  const file = registryFile();
  if (!existsSync(file)) {
    registryCache = emptyRegistry();
    return registryCache;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    throw new Error(`${file} is not JSON — delete it and restart the stack`);
  }

  registryCache = asRegistry(raw);
  return registryCache;
}

/** Writes the registry atomically, mode 0600, after every rotation and every change (AAP 0.11.2). */
function saveRegistry(): void {
  const file = registryFile();
  mkdirSync(dirname(file), { recursive: true });

  const temporary = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(registry(), null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

/** Reads the registry's shape, defaulting each field a previous run's schema did not carry. */
function asRegistry(raw: unknown): Registry {
  if (!isRecord(raw)) {
    throw new Error(`${registryFile()} is not a registry object — delete it and restart the stack`);
  }

  const actors = isRecord(raw.actors) ? raw.actors : {};
  const operator = isRecord(raw.operator) ? raw.operator : null;

  return {
    refreshKey: text(raw.refreshKey),
    actors: { a: asActor(actors.a), b: asActor(actors.b) },
    operator:
      operator === null || text(operator.email) === null || text(operator.refreshToken) === null
        ? null
        : {
            email: text(operator.email) ?? '',
            userId: text(operator.userId) ?? '',
            refreshToken: text(operator.refreshToken) ?? '',
          },
    maestroOperators: asStringMap(raw.maestroOperators),
    venue: asVenue(raw.venue),
    cursor: asCursor(raw.cursor),
    magicLinks: asTimestamps(raw.magicLinks),
  };
}

/** One actor record, or null when the file carries nothing usable for it. */
function asActor(raw: unknown): ActorRecord | null {
  if (!isRecord(raw)) return null;
  const email = text(raw.email);
  const refreshToken = text(raw.refreshToken);
  if (email === null || refreshToken === null) return null;

  return {
    email,
    refreshToken,
    userId: text(raw.userId) ?? '',
    variant: text(raw.variant),
    cityId: text(raw.cityId),
    arrivalDate: text(raw.arrivalDate),
    departureDate: text(raw.departureDate),
    hasCard: raw.hasCard === true,
  };
}

/** The venue record, or null when any field of it is missing. */
function asVenue(raw: unknown): VenueRecord | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id);
  const cityId = text(raw.cityId);
  const secret = text(raw.secret);
  if (id === null || cityId === null || secret === null) return null;

  const lat = number(raw.lat);
  const lng = number(raw.lng);
  if (lat === null || lng === null) return null;

  return { id, cityId, lat, lng, secret };
}

/** The consumed-day cursor, or null when any field of it is missing. */
function asCursor(raw: unknown): CursorRecord | null {
  if (!isRecord(raw)) return null;
  const overlapStart = text(raw.overlapStart);
  const overlapEnd = text(raw.overlapEnd);
  const lastLocalDate = text(raw.lastLocalDate);
  const timezone = text(raw.timezone);
  if (overlapStart === null || overlapEnd === null || lastLocalDate === null || timezone === null) {
    return null;
  }

  return { overlapStart, overlapEnd, lastLocalDate, timezone };
}

/** Whether a parsed JSON value is an object with named fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string, or null for every other JSON value. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A finite number, or null. */
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A map of string to string, keeping only well-formed entries. */
function asStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const entryText = text(entry);
    if (entryText !== null) out[key] = entryText;
  }
  return out;
}

/** A map of address to the instants a magic link was requested for it. */
function asTimestamps(value: unknown): Record<string, number[]> {
  if (!isRecord(value)) return {};
  const out: Record<string, number[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry)) {
      out[key] = entry.filter((at): at is number => typeof at === 'number' && Number.isFinite(at));
    }
  }
  return out;
}

/*
 * The HTTP client: one request shape for every call, and refusals that carry no body (AAP 0.11.1).
 */

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** An API refusal: the status and the error code, never the body, a token or a header. */
export class ApiCallError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(method: string, path: string, status: number, code: string) {
    super(`${method} ${path} → ${status} ${code}`);
    this.name = 'ApiCallError';
    this.status = status;
    this.code = code;
  }
}

/** What one request needs: the path relative to `/v1`, a bearer, a body, extra headers, a schema. */
export interface ApiRequestOptions<T> {
  method: Method;
  /** The path after `/v1`, e.g. `/meetups` — the only place `/v1` is not written out. */
  path: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  schema?: ResponseSchema<T>;
}

/** One authenticated-or-public API call (AAP 0.5.4).
 *
 * @param options - The method, the path and the request's own parts.
 * @returns The parsed body, or `undefined` where the route answers none.
 * @throws {ApiCallError} For every non-2xx answer.
 * @throws Error when a 2xx body does not match the shared schema.
 */
export async function apiRequest<T>(
  options: ApiRequestOptions<T> & { schema: ResponseSchema<T> },
): Promise<T>;
export async function apiRequest(options: ApiRequestOptions<never>): Promise<void>;
export async function apiRequest<T>(options: ApiRequestOptions<T>): Promise<T | undefined> {
  return await send(options);
}

/** The one implementation both overloads reach, so no call site duplicates request handling. */
async function send<T>(options: ApiRequestOptions<T>): Promise<T | undefined> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${e2eEnv().apiUrl}/v1${options.path}`, {
    method: options.method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  if (!response.ok) {
    throw new ApiCallError(
      options.method,
      options.path,
      response.status,
      await errorCodeOf(response),
    );
  }

  if (response.status === 202 || response.status === 204) return undefined;

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error(`${options.method} ${options.path} → ${response.status} is not JSON`);
  }

  if (options.schema === undefined) return undefined;

  try {
    return options.schema.parse(raw);
  } catch {
    throw new Error(
      `${options.method} ${options.path} → ${response.status} does not match the shared schema`,
    );
  }
}

/** The error code a failing answer carried, or a stand-in when its envelope cannot be read. */
async function errorCodeOf(response: Response): Promise<string> {
  try {
    return ErrorEnvelope.parse(await response.json()).error.code;
  } catch {
    return 'unreadable_error';
  }
}

/*
 * Sessions. Each role has exactly one refresh chain, and the chain rotates only when no page holds
 * that role's bearer, because a second rotation of the same token is read as reuse and revokes the
 * session (AAP 0.11.2).
 */

/** A role's cached access token, with the instant it was minted. */
interface Chain {
  accessToken: string;
  obtainedAt: number;
}

const chains = new Map<Role, Chain>();

/** The registry record a role's chain rotates, or null when the role has not signed in. */
function sessionOf(role: Role): { email: string; refreshToken: string } | null {
  const reg = registry();
  return role === 'operator' ? reg.operator : reg.actors[role];
}

/** Stores a rotated refresh token at once: a rotation the file does not carry is a lost session. */
function setRefreshToken(role: Role, refreshToken: string): void {
  const reg = registry();

  if (role === 'operator') {
    if (reg.operator === null) return;
    reg.operator.refreshToken = refreshToken;
  } else {
    const actor = reg.actors[role];
    if (actor === null) return;
    actor.refreshToken = refreshToken;
  }

  saveRegistry();
}

/** Whether a cached access token is close enough to its 15-minute expiry to rotate instead. */
function stale(chain: Chain): boolean {
  return Date.now() - chain.obtainedAt >= ACCESS_TOKEN_TRUST_MS;
}

/** The access token to send as a role. */
async function accessToken(role: Role): Promise<string> {
  const open = openContexts.get(role);
  const cached = chains.get(role);

  if (open !== undefined) {
    if (open.bearer !== null) return open.bearer;
    if (cached !== undefined && !stale(cached)) return cached.accessToken;
    throw new Error(
      `no bearer captured from the ${role} page yet: it must make one authenticated request before the API is called`,
    );
  }

  if (cached !== undefined && !stale(cached)) return cached.accessToken;
  return await rotate(role);
}

/** Rotates a role's refresh token and caches the access token it answers with (AAP 0.11.2). */
async function rotate(role: Role): Promise<string> {
  const session = sessionOf(role);
  if (session === null) {
    throw new Error(`actor ${role} has no session: call ensureActors() first`);
  }

  let rotated: Rotation;
  try {
    rotated = await apiRequest({
      method: 'POST',
      path: '/auth/refresh',
      body: { refreshToken: session.refreshToken },
      schema: RefreshResponse,
    });
  } catch (error) {
    if (error instanceof ApiCallError && error.status === 401) {
      throw new Error(`actor ${role} session revoked — reset the stack`);
    }
    throw error;
  }

  setRefreshToken(role, rotated.refreshToken);
  chains.set(role, { accessToken: rotated.accessToken, obtainedAt: Date.now() });
  return rotated.accessToken;
}

/*
 * The actor-scoped client.
 */

/** The client one role drives: every call carries that role's own session (AAP 0.11.2). */
export interface ActorApi {
  get<T>(path: string, schema: ResponseSchema<T>): Promise<T>;
  post<T>(path: string, schema: ResponseSchema<T>, body?: unknown): Promise<T>;
  put<T>(path: string, schema: ResponseSchema<T>, body?: unknown): Promise<T>;
  delete(path: string): Promise<void>;
}

/**
 * The client of one role.
 *
 * @param role - The actor whose token every call is authorised with.
 * @returns The four verbs over `/v1` paths.
 */
export function api(role: Role): ActorApi {
  return {
    async get<T>(path: string, schema: ResponseSchema<T>): Promise<T> {
      return await attempt(
        role,
        async (token) => await apiRequest({ method: 'GET', path, token, schema }),
      );
    },
    async post<T>(path: string, schema: ResponseSchema<T>, body?: unknown): Promise<T> {
      return await attempt(
        role,
        async (token) => await apiRequest({ method: 'POST', path, token, body, schema }),
      );
    },
    async put<T>(path: string, schema: ResponseSchema<T>, body?: unknown): Promise<T> {
      return await attempt(
        role,
        async (token) => await apiRequest({ method: 'PUT', path, token, body, schema }),
      );
    },
    async delete(path: string): Promise<void> {
      await attempt(role, async (token) => await apiRequest({ method: 'DELETE', path, token }));
    },
  };
}

/**
 * Runs one authenticated call, retrying it once with a live token after a `401 token_invalid`.
 *
 * The access token lasts 15 minutes of the API's own clock, and a suite moves that clock days
 * forward through `POST /v1/test/clock`, so the token it held a moment ago can be expired without a
 * second passing for the caller. A page that is open rotates the chain itself, so its next bearer
 * is waited for; otherwise the chain is rotated here, which is the only place outside a page that
 * may do so.
 */
async function attempt<T>(role: Role, run: (token: string) => Promise<T>): Promise<T> {
  try {
    return await run(await accessToken(role));
  } catch (error) {
    if (!(error instanceof ApiCallError) || error.status !== 401) throw error;

    const open = openContexts.get(role);
    if (open !== undefined) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      if (open.bearer !== null) return await run(open.bearer);
      throw new Error(`the ${role} page sent no token the API accepts — reset the stack`);
    }

    chains.delete(role);
    return await run(await rotate(role));
  }
}

/** The operator client: the dashboard, the queues, the registry and the secret issue routes. */
export function operatorApi(): ActorApi {
  return api('operator');
}

/*
 * Sign-in. The API allows 5 links an hour per address, so every request is recorded and a sixth is
 * a refusal rather than a loop (AAP 0.5.4).
 */

/** What a sign-in yields: the session it minted and the account it belongs to. */
export interface SignIn {
  email: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  me: Me;
}

/** Records one magic-link request, refusing a sixth inside the rolling hour. */
function noteMagicLinkRequest(email: string, purpose: string): void {
  const reg = registry();
  const now = Date.now();
  const recent = (reg.magicLinks[email] ?? []).filter((at) => now - at < MAGIC_LINK_WINDOW_MS);

  if (recent.length >= MAGIC_LINK_BUDGET) {
    throw new Error(
      `${purpose}: ${String(recent.length)} magic links already requested for this address within the hour, the API's limit is ${String(MAGIC_LINK_BUDGET)} — reset the stack`,
    );
  }

  reg.magicLinks[email] = [...recent, now];
  saveRegistry();
}

/** Signs an account in through the API and records its consent when the account is new (AAP 0.11.2).
 *
 * @param email - The address to sign in, which is never logged.
 * @param purpose - The role or flow the refusal messages name, e.g. `actor-a`.
 * @returns The session, with the account it created or resumed.
 * @throws Error when the magic-link budget is spent, the link is refused, or Mailpit never carries it.
 */
export async function signInViaApi(email: string, purpose: string): Promise<SignIn> {
  const since = Date.now();
  noteMagicLinkRequest(email, purpose);

  try {
    await apiRequest({ method: 'POST', path: '/auth/magic-link', body: { email } });
  } catch (error) {
    if (error instanceof ApiCallError && error.status === 429) {
      throw new Error(
        `${purpose}: the API rate limited this address — ${String(MAGIC_LINK_BUDGET)} magic links an hour — reset the stack`,
      );
    }
    throw error;
  }

  const message = await waitForMagicLink(email, {
    since,
    mailpitUrl: e2eEnv().mailpitUrl,
    purpose,
  });

  let verified: Verified;
  try {
    verified = await apiRequest({
      method: 'POST',
      path: '/auth/verify',
      body: { token: message.token },
      schema: VerifyResponse,
    });
  } catch (error) {
    if (error instanceof ApiCallError && error.status === 401) {
      throw new Error(`${purpose}: the magic link has expired or was already used`);
    }
    throw error;
  }

  const session: SignIn = {
    email,
    userId: verified.user.id,
    accessToken: verified.accessToken,
    refreshToken: verified.refreshToken,
    me: verified.user,
  };

  if (session.me.consents.ageConfirmedAt === null) {
    session.me = await apiRequest({
      method: 'POST',
      path: '/me/consents',
      token: session.accessToken,
      body: { adult: true, termsVersion: TERMS_VERSION },
      schema: MeDto,
    });
  }

  return session;
}

/** Signs an account in through the real sign-in screen, which is how the web and native walks reach the app (AAP 0.11.2).
 *
 * @param context - A fresh browser context; one holding a session would never show the form.
 * @param email - The address to sign in.
 * @param purpose - The role or flow the refusal messages name.
 * @returns The page, sitting on the Discover tab.
 * @throws Error when the form, the mail or the tabs never appear.
 */
export async function signInViaUi(
  context: BrowserContext,
  email: string,
  purpose: string,
): Promise<Page> {
  const page = await context.newPage();
  await driveSignIn(page, context, email, purpose);
  return page;
}

/** The sign-in itself, shared by {@link signInViaUi} and the actor flow that owns its own page. */
async function driveSignIn(
  page: Page,
  context: BrowserContext,
  email: string,
  purpose: string,
): Promise<void> {
  const { webUrl, mailpitUrl } = e2eEnv();

  await page.goto(`${webUrl}/`);
  const form = await awaited(page, ['sign-in-email', 'tab-discover']);
  if (form === 'tab-discover') {
    throw new Error(`the ${purpose} page was already signed in: use a fresh context`);
  }

  await visible(page, 'sign-in-email').fill(email);

  const since = Date.now();
  noteMagicLinkRequest(email, purpose);
  await visible(page, 'sign-in-submit').click();

  const message = await waitForMagicLink(email, { since, mailpitUrl, purpose });
  await page.goto(message.link);

  // The link verifies on mount and routes on what the account still needs: the age gate for a new
  // account, the tabs for one that has already passed it.
  const landed = await awaited(page, ['age-gate', 'tab-discover']);
  if (landed === 'age-gate') await passAgeGate(page);

  await visible(page, 'tab-discover').waitFor({ timeout: PAGE_READY_TIMEOUT_MS });
  await discoverRefreshKey(context);
}

/**
 * Confirms the age gate, retrying the switch until the submit control accepts the press.
 *
 * The press is retried because the screen re-renders while the app settles, and a click issued
 * across that re-render lands on a node React has already replaced: the switch stays off and the
 * continue button stays disabled, which reads as a hung form rather than as a miss.
 */
async function passAgeGate(page: Page): Promise<void> {
  const submit = visible(page, 'age-gate-submit');
  const deadline = Date.now() + PAGE_READY_TIMEOUT_MS;

  while (!(await submit.isEnabled())) {
    if (Date.now() >= deadline) {
      throw new Error('the age gate never accepted the adult confirmation');
    }

    const adult = visible(page, 'age-gate-adult');
    const toggle = adult.locator('input[type="checkbox"]');
    const on = (await toggle.count()) > 0 && (await toggle.isChecked());
    if (!on && (await adult.count()) > 0) {
      await adult.click().catch(() => undefined);
    }

    await page.waitForTimeout(200);
  }

  await submit.click();
}

/** Records the `localStorage` key the refresh token is stored under, once per stack. */
function discoverRefreshKey(context: BrowserContext): Promise<void> {
  const reg = registry();
  if (reg.refreshKey !== null) return Promise.resolve();

  const origin = new URL(e2eEnv().webUrl).origin;

  return context.storageState().then((state) => {
    const keys = (
      state.origins.find((candidate) => candidate.origin === origin)?.localStorage ?? []
    )
      .map((entry) => entry.name)
      .filter((name) => name.toLowerCase().includes('refresh'));

    if (keys.length !== 1) {
      throw new Error(
        `the signed-in page held ${String(keys.length)} refresh-token storage keys, expected exactly one`,
      );
    }

    reg.refreshKey = keys[0] ?? null;
    saveRegistry();
  });
}

/*
 * Hand-off contexts: a role's page, the bearer it sends, and the one chain rule that keeps the
 * session alive (AAP 0.11.2).
 */

/** One open page, and the last bearer it sent to the API. */
interface OpenContext {
  readonly context: BrowserContext;
  readonly page: Page;
  bearer: string | null;
}

const openContexts = new Map<Role, OpenContext>();

/** How long a spec waits for the page it opened to reach the tabs. */
const PAGE_READY_TIMEOUT_MS = 30_000;

/** Opens a page for a role, holding that role's session in the storage key the web client reads.
 *
 * @param browser - The browser to open the context in.
 * @param role - Whose session the page carries.
 * @param options - Playwright context options, such as a viewport or `locale`.
 * @returns The context and its page.
 * @throws Error when the role already has an open context, or has not signed in yet.
 */
export async function contextFor(
  browser: Browser,
  role: Role,
  options?: BrowserContextOptions,
): Promise<{ context: BrowserContext; page: Page }> {
  if (openContexts.has(role)) {
    throw new Error(`role ${role} already has an open page: release it before opening another`);
  }

  const reg = registry();
  const refreshKey = reg.refreshKey;
  const session = sessionOf(role);
  if (refreshKey === null || session === null) {
    throw new Error(`role ${role} has no stored session: call ensureActors() first`);
  }

  const storageKey = refreshKey;
  const context = await browser.newContext({
    ...options,
    baseURL: e2eEnv().webUrl,
    storageState: {
      cookies: [],
      origins: [
        {
          origin: new URL(e2eEnv().webUrl).origin,
          localStorage: [{ name: storageKey, value: session.refreshToken }],
        },
      ],
    },
  });

  const page = await context.newPage();
  const entry: OpenContext = { context, page, bearer: null };
  openContexts.set(role, entry);
  captureBearers(entry);

  await page.goto('/');
  await visible(page, 'tab-discover').waitFor({ timeout: PAGE_READY_TIMEOUT_MS });

  return { context, page };
}

/** Records the bearer of every API request the page makes, which is the token the chain must use. */
function captureBearers(entry: OpenContext): void {
  entry.page.on('request', (request) => {
    if (!request.url().startsWith(e2eEnv().apiUrl)) return;

    const header = request.headers()['authorization'];
    if (header?.startsWith('Bearer ') === true) {
      entry.bearer = header.slice('Bearer '.length);
    }
  });
}

/** Adopts the page's rotated refresh token and closes it (AAP 0.11.2).
 *
 * @param role - The role the page belonged to.
 * @param context - That page's context, closed here.
 * @throws Error when the role has no open context, or the page holds no refresh token.
 */
export async function releaseContext(role: Role, context: BrowserContext): Promise<void> {
  const entry = openContexts.get(role);
  if (entry === undefined || entry.context !== context) {
    throw new Error(`role ${role} has no page to release`);
  }

  const refreshKey = registry().refreshKey;
  const state = await context.storageState();
  const stored = state.origins
    .flatMap((origin) => origin.localStorage)
    .find((record) => record.name === refreshKey);

  if (refreshKey === null || stored === undefined || stored.value === '') {
    throw new Error(`the ${role} page held no refresh token under the discovered key`);
  }

  setRefreshToken(role, stored.value);
  if (entry.bearer !== null) {
    chains.set(role, { accessToken: entry.bearer, obtainedAt: Date.now() });
  }

  openContexts.delete(role);
  await context.close();
}

/*
 * Proofs: the harness proves exactly as a device does — inputs from the email, snarkjs over the
 * artefacts `pnpm circuits:build` wrote — and sends `{ proof, publicSignals }` alone (AAP 0.5.5).
 */

type FixtureName = 'valid' | 'valid-second';

/** snarkjs 0.7.6's proving entrypoint, narrowed here because the package ships no declarations. */
interface Groth16Prover {
  readonly groth16: {
    fullProve(
      input: object,
      wasmFile: string,
      zkeyFile: string,
    ): Promise<{ proof: unknown; publicSignals: unknown }>;
  };
}

/** The circuit build this harness proves with, and the manifest that names it. */
interface Artefacts {
  wasm: string;
  zkey: string;
  manifest: Manifest;
}

/** A committed fixture email's path, refusing a checkout whose fixtures were never built. */
function fixturePath(name: FixtureName): string {
  const file = join(repoRoot(), FIXTURE_DIR, `${name}.eml`);
  if (!existsSync(file)) throw new Error(`${file} is missing: run pnpm circuits:fixtures`);
  return file;
}

/** The build directory's three files, or the one failure that names the command producing them. */
function artefacts(): Artefacts {
  const dir = join(repoRoot(), BUILD_DIR);
  const wasm = join(dir, 'tablemate_itinerary.wasm');
  const zkey = join(dir, 'tablemate_itinerary.zkey');
  const manifestFile = join(dir, 'artifacts.manifest.json');

  if (!existsSync(wasm) || !existsSync(zkey) || !existsSync(manifestFile)) {
    throw new Error(MISSING_ARTEFACTS);
  }

  return {
    wasm,
    zkey,
    manifest: ArtifactsManifest.parse(JSON.parse(readFileSync(manifestFile, 'utf8')) as unknown),
  };
}

/** The cache entry one proof belongs in: the email, the proving key and the salt (AAP 0.11.2). */
function proofCacheFile(eml: Uint8Array, zkeySha256: string, salt: string): string {
  const digest = createHash('sha256')
    .update(eml)
    .update(zkeySha256, 'utf8')
    .update(salt, 'utf8')
    .digest('hex');

  return join(repoRoot(), LOCAL_DIR, PROOF_CACHE_DIR, `${digest}.json`);
}

/** The cached proof at `file`, or null: scratch state a shape change may invalidate. */
function readCachedProof(file: string): Submission | null {
  if (!existsSync(file)) return null;

  try {
    return ProofSubmission.parse(JSON.parse(readFileSync(file, 'utf8')) as unknown);
  } catch {
    return null;
  }
}

/** Writes a proof atomically, so a killed run leaves no half-written proof to trust. */
function writeCachedProof(file: string, submission: Submission): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.tmp`;

  writeFileSync(temporary, JSON.stringify(submission));
  renameSync(temporary, file);
}

/** snarkjs as `apps/mobile` resolves it, which is the version this app proves with. */
function loadSnarkjs(): Groth16Prover {
  return createRequire(join(repoRoot(), 'apps/mobile/package.json'))('snarkjs') as Groth16Prover;
}

/** Ends the curve worker snarkjs keeps alive, without which a CLI run would never exit. */
function terminateCurve(): void {
  const holder = globalThis as { curve_bn128?: { terminate?: () => unknown } };
  holder.curve_bn128?.terminate?.();
}

/** A proof of one committed fixture booking, in the client's role (AAP 0.11.2).
 *
 * @param name - The fixture to prove.
 * @returns The `{ proof, publicSignals }` body `POST /itinerary-proofs` accepts.
 * @throws Error when the artefacts are missing, the email cannot be proved, or the prover answers
 * something that is not a proof.
 */
export async function harnessProof(name: FixtureName): Promise<Submission> {
  const zk: Zk = await apiRequest({ method: 'GET', path: '/zk/config', schema: ZkConfig });
  const build = artefacts();
  const eml = new Uint8Array(readFileSync(fixturePath(name)));

  const cache = proofCacheFile(eml, build.manifest.files.zkey.sha256, zk.nullifierSalt);
  const cached = readCachedProof(cache);
  if (cached !== null) return cached;

  const built = buildCircuitInputs(eml, zk.issuers, zk.registry, {
    nullifierSalt: zk.nullifierSalt,
  });

  let submission: Submission;
  try {
    submission = ProofSubmission.parse(
      await loadSnarkjs().groth16.fullProve(built.inputs, build.wasm, build.zkey),
    );
  } catch {
    throw new Error(`${name}.eml produced no proof: the build does not match the published config`);
  } finally {
    terminateCurve();
  }

  writeCachedProof(cache, submission);
  return submission;
}

/**
 * The raw `POST /itinerary-proofs` body actor A's browser sent, which criterion 3 asserts on.
 *
 * @returns The request body as text, whose top-level keys are exactly `proof` and `publicSignals`.
 * @throws Error when no run has recorded it, naming the file.
 */
export function recordedProofBody(): string {
  const file = localPath(PROOF_REQUEST_KIND, PROOF_REQUEST_NAME);
  if (!existsSync(file)) {
    throw new Error(
      `${file} is missing: actor A's proof import through the UI records it once per stack`,
    );
  }

  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const body = isRecord(parsed) ? text(parsed.body) : null;
  if (body === null) throw new Error(`${file} carries no recorded request body`);

  return body;
}

/*
 * The actors. Criterion 1 needs two accounts with a proof in one city, and only `valid.eml` and
 * `valid-second.eml` are signed bookings whose nullifiers the stack has not spent (AAP 0.5.2), so
 * every web and native suite shares these two and reuses them from the registry (AAP 0.11.2).
 */

type ActorRole = 'a' | 'b';

let actorsPromise: Promise<void> | null = null;

/** One actor's address, stable for a stack because the test-control token keys it. */
function actorEmail(role: ActorRole): string {
  return `e2e-actor-${role}-${digestOf(e2eEnv().testControlToken, 8)}@example.com`;
}

/** The operator's address. */
function operatorEmail(): string {
  return `e2e-operator-${digestOf(e2eEnv().testControlToken, 8)}@example.com`;
}

/** Ensures both actors of criterion 1 exist, with a valid proof each, and that their stays overlap.
 *
 * @returns A promise that settles once both actors are ready.
 * @throws Error when the stack's fixtures, artefacts or stay window cannot support a walk.
 */
export function ensureActors(): Promise<void> {
  const running = actorsPromise ?? createActors();
  actorsPromise = running;
  return running;
}

/** Creates or resumes both actors, then checks the window their two bookings share. */
async function createActors(): Promise<void> {
  const reg = registry();
  const created = reg.actors.a !== null && reg.actors.b !== null;

  if (!created && (reg.actors.a !== null || reg.actors.b !== null)) {
    throw new Error(
      'the registry holds one actor but not the other — delete it and restart the stack',
    );
  }

  if (created) {
    await hydrateActor('a');
    await hydrateActor('b');
    await requireStayWindow();
    return;
  }

  const browser = await chromium.launch();
  try {
    await createActorA(browser);
    await createActorB(browser);
  } finally {
    await closeIfOpen('a');
    await closeIfOpen('b');
    await browser.close();
  }

  await requireStayWindow();
}

/** Signs actor A in and imports `valid.eml` through the real proof screen, so the browser Worker proves it (AAP 0.11.2, criterion 3). */
async function createActorA(browser: Browser): Promise<void> {
  const email = actorEmail('a');
  const opened =
    registry().actors.a === null
      ? await openUiSession('a', browser, email)
      : await contextFor(browser, 'a');

  // A resumed account may already hold its proof, and a second submission of a spent booking is the
  // one 409 the fixtures cannot survive, so the proof is read back before the UI imports anything.
  if ((await hydrateActor('a')).proof.status !== 'valid') {
    await importFixtureProof(opened.page);
    await hydrateActor('a');
  }

  await releaseContext('a', opened.context);
}

/**
 * Signs actor B in through the UI once, then submits its own booking as a harness proof
 * (AAP 0.11.2): only the initiator of criterion 1 walks the proof screen.
 */
async function createActorB(browser: Browser): Promise<void> {
  if (registry().actors.b === null) {
    const opened = await openUiSession('b', browser, actorEmail('b'));
    await releaseContext('b', opened.context);
  }

  if ((await hydrateActor('b')).proof.status === 'valid') return;

  const proof = await harnessProof('valid-second');
  try {
    await api('b').post('/itinerary-proofs', ProofAccepted, proof);
  } catch (error) {
    // A spent booking is the only 409 these fixtures can explain: a previous run's submission was
    // stored, so the proof is only re-read below and the reset is reported there if it is missing.
    if (!(error instanceof ApiCallError) || error.code !== 'nullifier_used') throw error;
  }

  if ((await hydrateActor('b')).proof.status !== 'valid') {
    throw new Error('stack database not reset — run a fresh `pnpm test:e2e`');
  }
}

/** Opens a page for a role and signs it in, holding the context open for the caller. */
async function openUiSession(
  role: ActorRole,
  browser: Browser,
  email: string,
): Promise<{ context: BrowserContext; page: Page }> {
  if (openContexts.has(role)) throw new Error(`role ${role} already has an open page`);

  const context = await browser.newContext({ baseURL: e2eEnv().webUrl });
  const page = await context.newPage();
  const entry: OpenContext = { context, page, bearer: null };
  openContexts.set(role, entry);
  captureBearers(entry);

  try {
    await driveSignIn(page, context, email, `actor-${role}`);
  } catch (error) {
    openContexts.delete(role);
    await context.close();
    throw error;
  }

  await recordActorSession(role, email, context);
  return { context, page };
}

/** Persists an actor's address and the refresh token the page it just signed in with holds. */
async function recordActorSession(
  role: ActorRole,
  email: string,
  context: BrowserContext,
): Promise<void> {
  const refreshKey = registry().refreshKey;
  const stored = (await context.storageState()).origins
    .flatMap((origin) => origin.localStorage)
    .find((record) => record.name === refreshKey);

  if (refreshKey === null || stored === undefined || stored.value === '') {
    throw new Error(`the ${role} page holds no refresh token under the discovered storage key`);
  }

  const reg = registry();
  reg.actors[role] = {
    email,
    userId: '',
    refreshToken: stored.value,
    variant: null,
    cityId: null,
    arrivalDate: null,
    departureDate: null,
    hasCard: false,
  };
  saveRegistry();
}

/** Refreshes one actor's own account into the registry, which is also a liveness check on its chain. */
async function hydrateActor(role: ActorRole): Promise<Me> {
  const me = await api(role).get('/me', MeDto);
  const reg = registry();
  const actor = reg.actors[role];
  if (actor === null) throw new Error(`actor ${role} has no record to refresh`);

  actor.userId = me.id;
  actor.variant = me.variant;
  actor.cityId = me.proof.cityId ?? null;
  actor.arrivalDate = me.proof.arrivalDate ?? null;
  actor.departureDate = me.proof.departureDate ?? null;
  saveRegistry();

  return me;
}

/** Closes a role's page if it is still open, without touching the token it already stored. */
async function closeIfOpen(role: Role): Promise<void> {
  const entry = openContexts.get(role);
  if (entry === undefined) return;

  openContexts.delete(role);
  await entry.context.close();
}

/** Imports `valid.eml` through the proof screens and records the request that submits it. */
async function importFixtureProof(page: Page): Promise<void> {
  await visible(page, 'tab-profile').click();
  await awaited(page, ['profile']);

  await visible(page, 'profile-verify-stay').click();
  await awaited(page, ['proof-import']);

  const chooser = page.waitForEvent('filechooser', { timeout: PAGE_READY_TIMEOUT_MS });
  await visible(page, 'proof-import-pick').click();

  const picked = await chooser.catch(() => null);
  if (picked === null) {
    await page.locator('input[type="file"]').setInputFiles(fixturePath('valid'));
  } else {
    await picked.setFiles(fixturePath('valid'));
  }

  // The generate screen appears once the bytes are staged; its start control only exists while the
  // attempt can begin, so a configuration refusal surfaces as the error banner instead.
  const ready = await awaited(
    page,
    ['proof-generate-start', 'proof-generate-error'],
    UI_STEP_TIMEOUT_MS,
  );
  if (ready === 'proof-generate-error') {
    throw new Error('the proof screen refused to start: see the message it shows');
  }

  const answer = page.waitForResponse(
    (response) =>
      response.url() === `${e2eEnv().apiUrl}/v1/itinerary-proofs` &&
      response.request().method() === 'POST',
    { timeout: UI_STEP_TIMEOUT_MS },
  );

  await visible(page, 'proof-generate-start').click();
  const response = await answer;

  writeResult(PROOF_REQUEST_KIND, PROOF_REQUEST_NAME, {
    body: response.request().postData() ?? '',
  });

  const status = response.status();
  if (status === 409) throw new Error('stack database not reset — run a fresh `pnpm test:e2e`');
  if (status !== 201) throw new Error(`actor a's proof import answered ${String(status)}`);

  try {
    ProofAccepted.parse(await response.json());
  } catch {
    throw new Error('the proof the browser submitted was not accepted in the documented shape');
  }

  await visible(page, 'proof-accepted').waitFor({ timeout: UI_STEP_TIMEOUT_MS });
}

/** Checks what every walk needs and that no other check can supply: */
async function requireStayWindow(): Promise<void> {
  const reg = registry();
  const a = reg.actors.a;
  const b = reg.actors.b;

  if (a === null || b === null) {
    throw new Error('both actors must sign in before a meetup day can be chosen');
  }

  const fixtures = 'see packages/circuits/scripts/make-test-fixtures.ts';
  if (
    a.cityId === null ||
    b.cityId === null ||
    a.arrivalDate === null ||
    a.departureDate === null ||
    b.arrivalDate === null ||
    b.departureDate === null
  ) {
    throw new Error(`both actors must hold a valid proof — ${fixtures}`);
  }

  if (a.cityId !== b.cityId) {
    throw new Error(
      `the two fixture bookings name different cities (${a.cityId}, ${b.cityId}) — ${fixtures}`,
    );
  }

  const overlapStart = a.arrivalDate > b.arrivalDate ? a.arrivalDate : b.arrivalDate;
  const overlapEnd = a.departureDate < b.departureDate ? a.departureDate : b.departureDate;
  const overlapDays = daysBetween(overlapStart, overlapEnd);
  if (overlapDays < 10) {
    throw new Error(
      `the two fixture bookings overlap for ${String(overlapDays)} days, fewer than the ten a criterion walk needs — ${fixtures}`,
    );
  }

  const timezone = await cityTimezone(a.cityId);
  if (reg.cursor === null) {
    reg.cursor = { overlapStart, overlapEnd, lastLocalDate: addDays(overlapStart, -1), timezone };
    saveRegistry();
  }

  // The venue is resolved here because the API's own time — the bound of every clock move — is read
  // off its console route, and because every walk needs the console anyway.
  await partnerVenue(a.cityId);
  const nowMs = await apiNow();
  if (localDateOf(nowMs, timezone) > overlapEnd) {
    throw new Error(
      `the fixture bookings end on ${overlapEnd}, before the stack's own date — reset the stack`,
    );
  }
}

/** One configured city's IANA zone, read once per process (AAP 0.5.4). */
async function cityTimezone(cityId: string): Promise<string> {
  const known = timezoneCache?.get(cityId);
  if (known !== undefined) return known;

  const answer = await api('a').get('/cities', CitiesResponse);
  const cache = timezoneCache ?? new Map<string, string>();
  for (const city of answer.items) cache.set(city.id, city.timezone);
  timezoneCache = cache;

  const zone = cache.get(cityId);
  if (zone === undefined) {
    throw new Error(`city ${cityId} is not configured — see config/cities.json`);
  }

  return zone;
}

let timezoneCache: Map<string, string> | null = null;

/** One actor's non-secret facts, for a spec that reports or asserts on them. */
export function actorInfo(role: ActorRole): ActorInfo {
  const actor = registry().actors[role];
  if (actor === null) throw new Error(`actor ${role} has not signed in: call ensureActors() first`);

  return {
    email: actor.email,
    userId: actor.userId,
    variant: actor.variant,
    cityId: actor.cityId,
    arrivalDate: actor.arrivalDate,
    departureDate: actor.departureDate,
  };
}

/** The city both actors' proofs name, which every meetup day and venue is chosen by. */
function provedCityId(): string {
  const actor = registry().actors.a;
  if (actor === null || actor.cityId === null) {
    throw new Error('actor a holds no valid proof: call ensureActors() first');
  }
  return actor.cityId;
}

/*
 * The operator, which the queues, the registry and the secret issue routes are driven as. The role
 * is granted by a CLI inside the container, which Maestro cannot run (AAP 0.3.3).
 */

let operatorPromise: Promise<void> | null = null;

/** Ensures an operator account exists and its session is in the registry. */
export function ensureOperator(): Promise<void> {
  const running = operatorPromise ?? createOperator();
  operatorPromise = running;
  return running;
}

/** Resumes the operator when its role still holds, and re-grants and re-signs in when it does not. */
async function createOperator(): Promise<void> {
  const existing = registry().operator;

  if (existing !== null && existing.userId !== '') {
    try {
      // The queue read is both a liveness check on the chain and proof that the role is held: any
      // other answer than `403 operator_only` means the account is still an operator.
      await operatorApi().get('/admin/disputes', AdminDisputesResponse);
      return;
    } catch (error) {
      if (!(error instanceof ApiCallError) || error.status !== 403) throw error;
    }
  }

  const email = existing?.email ?? operatorEmail();
  if (existing === null) await signInViaApi(email, 'operator');

  grantOperator(email);

  // A grant revokes every live session of the account, so the role is carried by a new sign-in.
  const session = await signInViaApi(email, 'operator');
  const reg = registry();
  reg.operator = { email, userId: session.userId, refreshToken: session.refreshToken };
  saveRegistry();
  chains.set('operator', { accessToken: session.accessToken, obtainedAt: Date.now() });
}

/**
 * Grants the operator role by running the API image's own CLI (AAP 0.3.3).
 *
 * @param email - The account to promote, which the CLI's output never echoes.
 * @throws Error naming the exit status alone, never a token or an address.
 */
export function grantOperator(email: string): void {
  try {
    execFileSync(
      'docker',
      ['compose', 'exec', '-T', 'api', 'node', 'apps/api/dist/scripts/grant-operator.js', email],
      { cwd: repoRoot(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const raw =
      typeof error === 'object' && error !== null && 'status' in error
        ? (error as { status?: unknown }).status
        : undefined;
    const status = typeof raw === 'number' ? String(raw) : 'unknown';
    throw new Error(`grant-operator exited ${status}: is the compose api service running?`);
  }
}

/*
 * The venue: where a walk meets, and the console secret its rotating code is read with.
 */

/** The first active partner venue of a city, by ascending id, kept in the registry (AAP 0.5.2). */
export async function partnerVenue(cityId: string): Promise<VenueRecord> {
  const known = registry().venue;
  if (known !== null && known.cityId === cityId && known.id !== '') return known;

  // The city reads sit behind the traveler guard — a bearer and the age gate — so they are made as
  // actor a, which is also the account whose proof names the city.
  const answer = await api('a').get(`/cities/${cityId}/venues`, VenuesResponse);

  const first = answer.items
    .filter((venue) => venue.isActivePartner)
    .sort((left, right) => (left.id < right.id ? -1 : 1))[0];

  if (first === undefined) {
    throw new Error(`city ${cityId} has no active partner venue — reseed the stack`);
  }

  const venue: VenueRecord = {
    id: first.id,
    cityId,
    lat: first.lat,
    lng: first.lng,
    secret: known?.secret ?? '',
  };

  registry().venue = venue;
  saveRegistry();
  return venue;
}

/** The venue's console secret:
 *
 * @param venueId - The venue whose code the console route is read with.
 * @returns The plaintext secret, which is never logged.
 * @throws Error when no source yields a usable secret.
 */
export async function venueSecret(venueId: string): Promise<string> {
  const known = registry().venue;
  if (known !== null && known.id === venueId && known.secret !== '') return known.secret;

  const fromSeed = seedVenueSecret(venueId);
  if (fromSeed !== null && (await isValidSecret(fromSeed))) {
    return storeVenueSecret(venueId, fromSeed);
  }

  if (registry().operator === null) {
    throw new Error(
      'no venue secret is available: .local/fixture-secrets.json holds none for this venue and no operator session exists — call ensureOperator() first',
    );
  }

  const issued = await operatorApi().post(`/admin/venues/${venueId}/secret`, SecretIssued);
  return storeVenueSecret(venueId, issued.secret);
}

/** Stores the resolved secret on the registry's venue record and answers it back. */
function storeVenueSecret(venueId: string, secret: string): string {
  const venue = registry().venue;
  if (venue === null || venue.id !== venueId) {
    throw new Error(`venue ${venueId} is not the resolved partner venue`);
  }

  venue.secret = secret;
  saveRegistry();
  return secret;
}

/** One venue's secret out of the seed's local file, read with a local guard: no `@tablemate/db`. */
function seedVenueSecret(venueId: string): string | null {
  const file = join(repoRoot(), LOCAL_DIR, FIXTURE_SECRETS_FILE);
  if (!existsSync(file)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(raw) || !Array.isArray(raw.venues)) return null;

  for (const entry of raw.venues) {
    if (isRecord(entry) && text(entry.id) === venueId) return text(entry.secret);
  }

  return null;
}

/** One `GET /venue/check-in-code`, which is also what tells whether a secret is still current. */
async function fetchCode(secret: string): Promise<Code> {
  return await apiRequest({
    method: 'GET',
    path: '/venue/check-in-code',
    headers: { [VENUE_SECRET_HEADER]: secret },
    schema: VenueCodeResponse,
  });
}

/** Whether the console route accepts a secret, rather than answering `401 bad_venue_secret`. */
async function isValidSecret(secret: string): Promise<boolean> {
  try {
    await fetchCode(secret);
    return true;
  } catch (error) {
    if (error instanceof ApiCallError && error.status === 401) return false;
    throw error;
  }
}

/*
 * Cards and claims.
 */

/**
 * Saves a card for one actor, which every hold needs (AAP 0.3.4).
 *
 * @param role - The actor to set the card up for.
 * @throws Error when the stack runs `STRIPE_MODE=mock`, where no card can be confirmed at all.
 */
export async function ensureCard(role: ActorRole): Promise<void> {
  if (e2eEnv().stripeMode !== 'test') {
    throw new Error(`a saved card needs a Stripe test-mode stack: ${BLOCKED_REASON}`);
  }

  const actor = registry().actors[role];
  if (actor === null) throw new Error(`actor ${role} has not signed in: call ensureActors() first`);
  if (actor.hasCard) return;

  const browser = await chromium.launch();
  try {
    const { context, page } = await contextFor(browser, role);

    await visible(page, 'tab-profile').click();
    await awaited(page, ['profile']);

    await visible(page, 'profile-payment').click();
    await awaited(page, ['payment']);

    await visible(page, 'payment-setup').click();
    await fillPaymentElement(page);

    await visible(page, 'payment-setup-submit').click();
    const done = await awaited(page, ['payment-saved', 'payment-setup-error']);
    if (done === 'payment-setup-error') {
      throw new Error(`the card was refused for actor ${role}: see the message the screen shows`);
    }

    const current = registry().actors[role];
    if (current !== null) {
      current.hasCard = true;
      saveRegistry();
    }

    await releaseContext(role, context);
  } finally {
    await closeIfOpen(role);
    await browser.close();
  }
}

/** Fills Stripe's Payment Element with its public test card (AAP 0.11.2).
 *
 * @param page - The page showing the card form.
 * @throws Error when no card field renders inside the deadline.
 */
export async function fillPaymentElement(page: Page): Promise<void> {
  const frame = await cardFrame(page);

  const cardTab = frame.getByRole('tab', { name: /card/i });
  if ((await cardTab.count()) > 0) await cardTab.first().click();

  await fillIfPresent(frame, 'number', TEST_CARD.number);
  await fillIfPresent(frame, 'expiry', TEST_CARD.expiry);
  await fillIfPresent(frame, 'cvc', TEST_CARD.cvc);
  await fillIfPresent(frame, 'postalCode', TEST_CARD.postalCode);

  const country = frame.locator('select[name="country"]');
  if ((await country.count()) > 0) await country.first().selectOption('US');
}

/** Fills one form control of Stripe's frame when that control exists. */
async function fillIfPresent(frame: Frame, name: string, value: string): Promise<void> {
  const field = frame.locator(`input[name="${name}"]`);
  if ((await field.count()) > 0) await field.first().fill(value);
}

/** The frame holding the card fields, found by the card-number input it renders. */
async function cardFrame(page: Page): Promise<Frame> {
  const deadline = Date.now() + PAGE_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if ((await frame.locator('input[name="number"]').count()) > 0) return frame;
    }
    await page.waitForTimeout(200);
  }

  throw new Error('the Payment Element never rendered a card field');
}

/** Deletes the actor's open lodging claim, so a claim suite starts from no claim (AAP 0.5.3).
 *
 * @param role - The actor whose claim is deleted.
 * @throws Error when the claim is still being called after two minutes.
 */
export async function ensureNoActiveClaim(role: ActorRole): Promise<void> {
  const client = api(role);
  const claim = (await client.get('/me', MeDto)).activeLodgingClaim;
  if (claim === null) return;

  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await client.delete(`/me/lodging-claims/${claim.id}`);
      return;
    } catch (error) {
      if (!(error instanceof ApiCallError) || error.code !== 'call_in_progress') throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `lodging claim ${claim.id} is still being called: retry once the call ends`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

/*
 * Test control. Both routes exist only in `APP_ENV=test` with `TEST_CONTROL_TOKEN` set, and both
 * answer `204`.
 */

/** Moves the clock the API was built with, refusing to move it backwards (AAP 0.5.4). */
export async function setClock(request: TestClockRequest): Promise<void> {
  const body = TestClockRequest.parse(request);

  if (body.now !== undefined) {
    // The API's own time is known only to one 60-second step, so the bound is the end of the current
    // step rather than `apiNow()`: a move any earlier could land behind the clock being moved.
    const upper = await clockUpperBound();
    if (Date.parse(body.now) < upper) {
      throw new Error(
        `setClock(${body.now}) would move the API's clock back: it is already at or past ${new Date(upper).toISOString()}`,
      );
    }
  }

  await testControl('/test/clock', body);
}

/**
 * Settles one meetup, or sweeps, and carries out what the settlement planned (AAP 0.5.1).
 *
 * @param meetupId - The meetup to settle; omitted, the sweeper settles whatever is due.
 */
export async function runSettlement(meetupId?: string): Promise<void> {
  await testControl('/test/run-settlement', meetupId === undefined ? {} : { meetupId });
}

/** One test-control call, with the token in its own header and `404` explained. */
async function testControl(path: string, body: unknown): Promise<void> {
  try {
    await apiRequest({
      method: 'POST',
      path,
      headers: { [TEST_CONTROL_HEADER]: e2eEnv().testControlToken },
      body,
    });
  } catch (error) {
    if (error instanceof ApiCallError && error.status === 404) {
      throw new Error(
        `${path} answered 404 not_found: the stack is not APP_ENV=test, or TEST_CONTROL_TOKEN differs from the API's`,
      );
    }
    throw error;
  }
}

/** The API's own time, to one 60-second step:
 *
 * @returns Epoch milliseconds inside the step the clock currently sits in.
 * @throws Error when no venue secret is available, which is also what `ensureActors` resolves.
 */
export async function apiNow(): Promise<number> {
  return (await clockUpperBound()) - CODE_STEP_MS;
}

/** The end of the current 60-second step of the API's clock, the bound of every clock move. */
async function clockUpperBound(): Promise<number> {
  const venue = await partnerVenue(provedCityId());
  return Date.parse((await fetchCode(await venueSecret(venue.id))).expiresAt);
}

/** The next city day a criterion walk may take, moving the clock to 09:00 of it (AAP 0.11.2).
 *
 * @returns The local date, the instant to propose for, and the city's zone.
 * @throws Error when the two proofs no longer overlap, or the move would go backwards.
 */
export async function nextMeetupDay(): Promise<MeetupDay> {
  const cursor = registry().cursor;
  if (cursor === null) throw new Error('no stay window: call ensureActors() first');

  const today = localDateOf(await apiNow(), cursor.timezone);
  const floor = today > cursor.lastLocalDate ? today : cursor.lastLocalDate;
  const candidate =
    addDays(floor, 1) > cursor.overlapStart ? addDays(floor, 1) : cursor.overlapStart;

  if (candidate > addDays(cursor.overlapEnd, -1)) {
    throw new Error('stay overlap exhausted — reset the stack');
  }

  await setClock({ now: zonedTimeToUtc(candidate, '09:00', cursor.timezone).toISOString() });

  cursor.lastLocalDate = candidate;
  saveRegistry();

  return {
    localDate: candidate,
    startsAt: zonedTimeToUtc(candidate, '12:00', cursor.timezone).toISOString(),
    timezone: cursor.timezone,
  };
}

/*
 * Pair hygiene: the one open meetup per pair is what lets a second walk propose at all, so every
 * suite clears it before and after its own (AAP 0.5.3).
 */

/** Removes every open meetup between the two actors, in the way that costs nothing (AAP 0.5.3).
 */
export async function clearPairMeetups(): Promise<void> {
  const counterpart = actorInfo('b').userId;

  for (const status of ['proposed', 'locked']) {
    for (const meetup of await meetupsWith(`status=${status}`)) {
      if (meetup.counterpart.id === counterpart) await clearMeetup(meetup);
    }
  }
}

/** Every page of the actor's own meetups under one query, following the keyset cursor. */
async function meetupsWith(query: string): Promise<Meetup[]> {
  const client = api('a');
  const found: Meetup[] = [];
  let cursor: string | null = null;

  for (;;) {
    const suffix = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    const page: MeetupPage = await client.get(`/meetups?${query}${suffix}`, MeetupListResponse);
    found.push(...page.items);

    cursor = page.nextCursor;
    if (cursor === null) return found;
  }
}

/** One open meetup, cancelled or settled, which are the only two ways it leaves the pair's way. */
async function clearMeetup(meetup: Meetup): Promise<void> {
  if (meetup.status === 'proposed') {
    await cancelMeetup(meetup.id);
    return;
  }

  if (meetup.disputeOpen) {
    await resolveOpenDispute(meetup.id);
    return;
  }

  // At or before `startsAt − 2 h` a cancel is free, with a minute of slack for the step the API's
  // own time is read to; later than that the meetup is settled rather than forfeited.
  if ((await apiNow()) + CODE_STEP_MS <= Date.parse(meetup.lateCancelFrom)) {
    await cancelMeetup(meetup.id);
    return;
  }

  const settledAt = Date.parse(meetup.startsAt) + 46 * CODE_STEP_MS;
  const upper = await clockUpperBound();
  if (settledAt > upper) await setClock({ now: new Date(settledAt).toISOString() });

  await runSettlement(meetup.id);
}

/** Cancels one meetup, tolerating a transition that already took it out of `proposed` or `locked`. */
async function cancelMeetup(meetupId: string): Promise<void> {
  try {
    await api('a').post(`/meetups/${meetupId}/cancel`, CancelResponse);
  } catch (error) {
    const settled =
      error instanceof ApiCallError &&
      (error.code === 'already_settled' || error.code === 'not_proposed');
    if (!settled) throw error;
  }
}

/** Resolves the open dispute on one meetup `no_fault`, which releases both holds and credits nobody. */
async function resolveOpenDispute(meetupId: string): Promise<void> {
  const queue = await operatorApi().get('/admin/disputes', AdminDisputesResponse);
  const open = queue.items.find(
    (dispute) => dispute.meetupId === meetupId && dispute.status === 'open',
  );

  if (open === undefined) {
    throw new Error(`meetup ${meetupId} reports an open dispute the operator queue does not hold`);
  }

  await operatorApi().post(
    `/admin/disputes/${open.id}/resolve`,
    AdminDisputeDto,
    ResolveDispute.parse({ outcome: 'no_fault' }),
  );
}

/*
 * Dates. `Intl` with an IANA zone is enough; no date library is a dependency of this workspace.
 */

/** The zone's offset from UTC at one instant: the wall clock read there, as UTC, less the instant. */
function zoneOffsetMs(at: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));

  const field = (type: string): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? Number.NaN : Number(part.value);
  };

  return (
    Date.UTC(
      field('year'),
      field('month') - 1,
      field('day'),
      field('hour'),
      field('minute'),
      field('second'),
    ) - at
  );
}

/** `HH:MM` on a `YYYY-MM-DD` in one zone, as the UTC instant it names. */
function zonedTimeToUtc(dateOnly: string, timeOfDay: string, timezone: string): Date {
  const naive = Date.parse(`${dateOnly}T${timeOfDay}:00Z`);
  const firstGuess = naive - zoneOffsetMs(naive, timezone);

  // The second pass is what makes a day the zone shifts its clocks on come out right.
  return new Date(naive - zoneOffsetMs(firstGuess, timezone));
}

/** The calendar date one instant falls on in one zone. */
function localDateOf(at: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));

  const field = (type: string): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';

  return `${field('year')}-${field('month')}-${field('day')}`;
}

/** A calendar date moved by whole days. */
function addDays(dateOnly: string, days: number): string {
  return new Date(Date.parse(`${dateOnly}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Whole days between two calendar dates. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/*
 * `prepare-maestro`: what the native flows need and cannot do for themselves (AAP 0.11.2).
 */

/** The two flows of criterion 1, each needing an operator of its own on each platform. */
const MAESTRO_FLOWS = ['criterion1-initiator', 'criterion1-recipient'];

/** The two platforms those flows run on. */
const MAESTRO_PLATFORMS = ['ios', 'android'];

/** Whether this process was started to prepare Maestro rather than imported by a spec. */
function cliRequested(): boolean {
  if (process.argv[2] !== 'prepare-maestro') return false;

  const script = resolve(process.argv[1] ?? '');
  return (
    script.endsWith(join('support', 'api-actor.ts')) ||
    script.endsWith(join('support', 'api-actor.js'))
  );
}

/** Runs the preparation and ends the process with its outcome. */
async function runCli(): Promise<void> {
  try {
    await prepareMaestro();
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'prepare-maestro failed'}\n`);
    process.exit(1);
  }
}

/** Creates everything the native flows need, then writes the two fixture files Maestro reads. */
async function prepareMaestro(): Promise<void> {
  await ensureActors();
  await ensureOperator();

  const venue = await partnerVenue(provedCityId());
  await venueSecret(venue.id);

  if (e2eEnv().stripeMode === 'test') {
    await ensureCard('a');
    await ensureCard('b');
  }

  for (const platform of MAESTRO_PLATFORMS) {
    for (const flow of MAESTRO_FLOWS) await ensureMaestroOperator(`${platform}:${flow}`);
  }

  const reg = registry();
  const a = reg.actors.a;
  const b = reg.actors.b;
  if (a === null || b === null)
    throw new Error('both actors must exist before Maestro can be prepared');

  const fixture = {
    actors: { a: { email: a.email, userId: a.userId }, b: { email: b.email, userId: b.userId } },
    operators: reg.maestroOperators,
    venue: {
      id: venue.id,
      cityId: venue.cityId,
      lat: venue.lat,
      lng: venue.lng,
      secret: venue.secret,
    },
    salt: await nullifierSalt(),
    stay: { cursor: reg.cursor, overlapEnd: reg.cursor?.overlapEnd ?? null },
    stripeMode: e2eEnv().stripeMode,
  };

  writeFixtureProofs(fixture);
}

/** Creates one Maestro operator, whose role only this host can grant. */
async function ensureMaestroOperator(key: string): Promise<void> {
  const reg = registry();
  if (reg.maestroOperators[key] !== undefined) return;

  const email = throwawayEmail(key.replace(/[^a-z0-9]+/gi, '-'));
  await signInViaApi(email, `maestro-${key}`);
  grantOperator(email);

  // The grant revoked the session that created the account, which is of no use to Maestro: the
  // device signs in itself with its own magic link and needs the address alone.
  reg.maestroOperators[key] = email;
  saveRegistry();
}

/** The published nullifier salt, which the fixture files carry so the device proves the same one. */
async function nullifierSalt(): Promise<string> {
  return (await apiRequest({ method: 'GET', path: '/zk/config', schema: ZkConfig })).nullifierSalt;
}

/** Writes `.local/e2e/fixture-proofs.json` and its `output.e2e` JavaScript twin (AAP 0.11.2). */
function writeFixtureProofs(data: unknown): void {
  const dir = localPath();
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'fixture-proofs.json'), `${JSON.stringify(data, null, 2)}\n`);
  writeFileSync(join(dir, 'fixture-proofs.js'), `output.e2e = ${JSON.stringify(data)};\n`);
}

if (cliRequested()) void runCli();
