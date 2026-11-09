/**
 * The client's cold-start ordering: the session restore is awaited before the first authenticated
 * send of a load, so that send carries the token the restore installed, and a restore that ended
 * without a session refuses the request instead of letting it leave unauthenticated (AAP 0.3.3,
 * AAP 0.5.4, AAP 0.11.2).
 *
 * `src/auth/session.ts` cannot be imported from here: its extensionless `./storage` import has only
 * `storage.native.ts` and `storage.web.ts` halves, which Metro resolves per platform and Node does
 * not. The client is therefore exercised against fake hooks, which is the whole of what it asks of
 * the auth module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureAuth, request, type AuthHooks, type HttpMethod } from '../src/api/client.ts';
import { ApiError, type ClientErrorCode } from '../src/api/errors.ts';

/** The origin `apiBaseUrl()` resolves the routes against; it reads the variable per call. */
const API_ORIGIN = 'http://api.test';

/** The access token a fake restore installs. */
const ACCESS_TOKEN = 'access-token-1';

/** A route a case drives: the method and the path under `/v1`. */
type RouteCase = readonly [method: HttpMethod, path: string];

/** A failure a restore can end with: the status and code of the {@link ApiError} it raises. */
type RestoreFailure = readonly [status: number, code: ClientErrorCode];

/** The `fetch` arguments `./client` passes: a URL, and headers as a plain record. */
interface StubInit {
  readonly headers?: Record<string, string>;
}

/** The part of a fetch answer `./client` reads, so the stub builds no real `Response`. */
interface StubAnswer {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly text: () => Promise<string>;
}

/** One request the stub saw, with the bearer header it carried. */
interface SentRequest {
  readonly url: string;
  readonly authorization: string | null;
}

/** A promise with its resolver, for the case that observes the client while the restore runs. */
interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

/** Build a {@link Deferred}. */
function deferred(): Deferred {
  let settle: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

/**
 * Replaces `globalThis.fetch` with a stub answering `200`, and records every request it received.
 * The answer carries the `Date` header the client records and an empty body, which a route whose
 * answer is ignored reads fine: no DOM API and no real `Response` is involved.
 */
function stubFetch(): SentRequest[] {
  const sent: SentRequest[] = [];
  const answer: StubAnswer = {
    ok: true,
    status: 200,
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() === 'date' ? new Date(0).toUTCString() : null,
    },
    text: () => Promise.resolve(''),
  };
  vi.stubGlobal('fetch', (url: string, init: StubInit): Promise<StubAnswer> => {
    sent.push({ url, authorization: init.headers?.Authorization ?? null });
    return Promise.resolve(answer);
  });
  return sent;
}

/** What the fake hooks saw the client ask them for. */
interface HookCalls {
  /** How many times the client asked for a session to be ensured. */
  ensure: number;
}

/**
 * Installs a fake hook set in the client, as `src/auth/session.ts` does at the foot of its module,
 * and counts the gate's calls. The token is read per request, so a case can install one while a
 * request waits on the gate.
 */
function installHooks(options: {
  readonly token: () => string | null;
  readonly ensure: () => Promise<void>;
}): HookCalls {
  const calls: HookCalls = { ensure: 0 };
  const hooks: AuthHooks = {
    getAccessToken: options.token,
    ensureSession: () => {
      calls.ensure += 1;
      return options.ensure();
    },
    refresh: () => Promise.resolve(),
    onSignedOut: () => undefined,
  };
  configureAuth(hooks);
  return calls;
}

/**
 * The gate a case installs where the client must not reach for one. It rejects rather than resolves,
 * so a request that awaited it by mistake fails loudly instead of quietly sending without a token.
 */
function unexpectedGate(): Promise<void> {
  return Promise.reject(new ApiError(401, 'token_invalid'));
}

describe("the client's first authenticated request on a cold start", () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_URL = API_ORIGIN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.EXPO_PUBLIC_API_URL;
  });

  /** The two reads the cold-load reports name, and one write that leaves the same way. */
  const ROUTES: readonly RouteCase[] = [
    ['GET', '/cities'],
    ['GET', '/cities/lisbon/venues'],
    ['POST', '/me/consents'],
  ];

  it.each(ROUTES)(
    'waits for the restore and sends the token it installs on %s %s',
    async (method, path) => {
      const sent = stubFetch();
      const restore = deferred();
      let held: string | null = null;
      const calls = installHooks({ token: () => held, ensure: () => restore.promise });

      const answered = request(method, path, { response: null });

      // The send sits behind the gate: nothing has left while the restore is still running.
      await Promise.resolve();
      expect(sent).toHaveLength(0);

      held = ACCESS_TOKEN;
      restore.resolve();
      await expect(answered).resolves.toBeUndefined();

      expect(calls.ensure).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.url).toBe(`${API_ORIGIN}/v1${path}`);
      expect(sent[0]?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    },
  );

  it('leaves no read of the city route unauthenticated when two start at once', async () => {
    const sent = stubFetch();
    const restore = deferred();
    let held: string | null = null;
    const calls = installHooks({ token: () => held, ensure: () => restore.promise });

    // The city page's two own reads, both issued at mount: the cities list and the city's venues.
    const reads = Promise.all([
      request('GET', '/cities', { response: null }),
      request('GET', '/cities/lisbon/venues', { response: null }),
    ]);

    await Promise.resolve();
    expect(sent).toHaveLength(0);

    held = ACCESS_TOKEN;
    restore.resolve();
    await expect(reads).resolves.toEqual([undefined, undefined]);

    // One send each, both authenticated: the 401, the rotation and the retry are gone.
    expect(sent).toHaveLength(2);
    expect(sent.map((one) => one.authorization)).toEqual([
      `Bearer ${ACCESS_TOKEN}`,
      `Bearer ${ACCESS_TOKEN}`,
    ]);
    // Each request asks the gate once. That the two calls share one restore is the session module's
    // own single flight, which is what keeps a second rotation from revoking the session (AAP 0.11.2).
    expect(calls.ensure).toBe(2);
  });

  /**
   * The failures a restore can end with (AAP 0.5.4): one that never reached the API, one this client
   * raises for a storage it cannot read, and the refusal the API answers a request carrying no token.
   */
  const RESTORE_FAILURES: readonly RestoreFailure[] = [
    [0, 'network_error'],
    [503, 'service_unavailable'],
    [401, 'token_invalid'],
  ];

  it.each(RESTORE_FAILURES)(
    'sends nothing when the restore ended with a %i %s failure, and reports it to the caller',
    async (status, code) => {
      const sent = stubFetch();
      const failure = new ApiError(status, code);
      const calls = installHooks({ token: () => null, ensure: () => Promise.reject(failure) });

      await expect(request('GET', '/cities', { response: null })).rejects.toBe(failure);

      expect(calls.ensure).toBe(1);
      expect(sent).toHaveLength(0);
    },
  );

  it('uses an access token already held and never asks for a session', async () => {
    const sent = stubFetch();
    const calls = installHooks({ token: () => ACCESS_TOKEN, ensure: unexpectedGate });

    await expect(request('GET', '/cities', { response: null })).resolves.toBeUndefined();

    expect(calls.ensure).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  /** Public routes: nothing to authenticate with, so no session has to exist for them (AAP 0.5.4). */
  const PUBLIC_ROUTES: readonly RouteCase[] = [
    ['GET', '/health'],
    ['POST', '/auth/refresh'],
  ];

  it.each(PUBLIC_ROUTES)(
    'never asks for a session on the public route %s %s',
    async (method, path) => {
      const sent = stubFetch();
      const calls = installHooks({ token: () => null, ensure: unexpectedGate });

      await expect(request(method, path, { auth: false, response: null })).resolves.toBeUndefined();

      expect(calls.ensure).toBe(0);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.authorization).toBeNull();
    },
  );
});
