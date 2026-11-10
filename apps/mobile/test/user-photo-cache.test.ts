/**
 * The shared photo cache: one download per distinct traveler however many frames draw them, one session rotation per
 * refused token, and no entry left behind where the bytes or the entitlement can change (AAP 0.3.3, AAP 0.5.4,
 * AAP 0.5.7).
 *
 * `globalThis.fetch` is the whole of what the cache touches besides the auth hooks `./client` reads: no DOM, no
 * component and no API origin beyond the build-time variable the client resolves per call. Object URLs are counted
 * rather than minted, so a case reads what the browser would have been handed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureAuth, type AuthHooks } from '../src/api/client.ts';
import { ApiError } from '../src/api/errors.ts';
import {
  clearUserPhotos,
  discardUserPhoto,
  forgetUserPhoto,
  requestUserPhoto,
  subscribeUserPhotos,
  userPhotoSnapshot,
  type UserPhotoState,
} from '../src/api/user-photo-cache.ts';

/** The API origin `apiBaseUrl()` resolves the photo route against; it reads the variable per call. */
const API_ORIGIN = 'http://api.test';
/** The pair's two travelers: the counterpart a list draws in many rows, and a second one beside them. */
const FIRST_TRAVELER = 'traveler-1';
const SECOND_TRAVELER = 'traveler-2';
/** The token a session installs, and the one the rotation the cache joins installs in its place. */
const FIRST_TOKEN = 'access-token-1';
const ROTATED_TOKEN = 'access-token-2';
/** The bytes a successful answer carries; the cache never reads their content. */
const PHOTO_BYTES = new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])], { type: 'image/webp' });

/**
 * What the stubbed `fetch` does for one request: `'ok'` answers `200` with {@link PHOTO_BYTES}, any other number
 * answers that refusal carrying no bytes, and `'failure'` rejects, which is what a lost connection looks like here.
 */
type Outcome = 'ok' | 'failure' | number;

/** The part of a fetch answer the cache reads, so the stub builds no real `Response`. */
interface StubAnswer {
  readonly ok: boolean;
  readonly status: number;
  readonly blob: () => Promise<Blob>;
}

/** One request the stub saw, with the bearer header it carried. */
interface SentRequest {
  readonly url: string;
  readonly authorization: string | null;
}

interface StubFetch {
  /** Every request, in the order it arrived. */
  readonly sent: SentRequest[];
  /** How many requests the stub answered. */
  readonly count: () => number;
}

/**
 * Replaces `globalThis.fetch` with a stub working through `outcomes` in order. A request beyond that list is answered
 * as a failure, which the cache leaves uncached: a case that over-fetches fails on its own count assertion rather
 * than on the stub's answer for it.
 */
function stubFetch(outcomes: readonly Outcome[]): StubFetch {
  const sent: SentRequest[] = [];
  vi.stubGlobal(
    'fetch',
    (url: string, init: { readonly headers?: Record<string, string> }): Promise<StubAnswer> => {
      sent.push({ url, authorization: init.headers?.['Authorization'] ?? null });
      const outcome = outcomes[sent.length - 1] ?? 'failure';
      if (outcome === 'failure') return Promise.reject(new Error('fetch failed'));
      const status = outcome === 'ok' ? 200 : outcome;
      return Promise.resolve({
        ok: status === 200,
        status,
        blob: () => Promise.resolve(PHOTO_BYTES),
      });
    },
  );
  return { sent, count: () => sent.length };
}

interface StubObjectUrls {
  /** The URLs the cache would have handed the browser, in the order it minted them. */
  readonly minted: string[];
  /** The URLs it revoked, in the order it revoked them. */
  readonly revoked: string[];
}

/** Replaces the browser's object-URL pair with counters, so a case can read what was minted and what was revoked. */
function stubObjectUrls(): StubObjectUrls {
  const minted: string[] = [];
  const revoked: string[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:photo-${minted.length + 1}`;
    minted.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    revoked.push(url);
  });
  return { minted, revoked };
}

interface StubSession {
  /** How many rotations the cache joined: one per refused load, whatever number of callers shared it. */
  readonly rotations: () => number;
}

/**
 * How the rotation the cache joins ends: it installs a fresh token, the API refuses it because the session is spent,
 * or it fails without reaching the API at all.
 */
type RotationAnswer = 'rotates' | 'refused' | 'unreachable';

/**
 * Installs the auth hooks `./client` reads, as `src/auth/session.ts` does at start-up: a token every request carries
 * and a rotation, which answers as `rotation` asks, that installs a fresh one whenever it succeeds.
 */
function stubSession(rotation: RotationAnswer = 'rotates'): StubSession {
  let token: string | null = FIRST_TOKEN;
  let rotations = 0;
  const hooks: AuthHooks = {
    getAccessToken: () => token,
    refresh: () => {
      rotations += 1;
      if (rotation === 'refused') return Promise.reject(new ApiError(401, 'token_invalid'));
      if (rotation === 'unreachable') return Promise.reject(new ApiError(0, 'network_error'));
      token = ROTATED_TOKEN;
      return Promise.resolve(ROTATED_TOKEN);
    },
    onSignedOut: () => undefined,
  };
  configureAuth(hooks);
  return { rotations: () => rotations };
}

/** Waits until a traveler's entry resolves, which is where an assertion about a finished load starts. */
async function resolved(userId: string): Promise<UserPhotoState> {
  await vi.waitFor(() => {
    expect(userPhotoSnapshot(userId)).toBeDefined();
  });
  return userPhotoSnapshot(userId);
}

/**
 * Lets a settled load finish without a fake clock: the stub answers already-resolved promises, so one turn of the
 * macrotask queue drains every microtask the loader has left and leaves its in-flight entry released.
 */
async function settleLoad(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the shared photo cache', () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_URL = API_ORIGIN;
  });
  afterEach(() => {
    clearUserPhotos();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.EXPO_PUBLIC_API_URL;
  });

  /** The callers one render makes for a single counterpart: a list row per meetup of the same pair. */
  const CALLERS = [1, 2, 14] as const;

  it.each(CALLERS)('downloads a traveler once for %i callers asking together', async (callers) => {
    stubSession();
    const fetchStub = stubFetch(['ok']);
    const urls = stubObjectUrls();
    for (let caller = 0; caller < callers; caller += 1) requestUserPhoto(FIRST_TRAVELER);
    expect(await resolved(FIRST_TRAVELER)).toBe(urls.minted[0]);
    expect(fetchStub.sent.map((request) => request.url)).toEqual([
      `${API_ORIGIN}/v1/users/${FIRST_TRAVELER}/photo`,
    ]);
    expect(urls.minted).toHaveLength(1);
  });

  it('answers a resolved traveler from the cache without asking the API again', async () => {
    stubSession();
    const fetchStub = stubFetch(['ok']);
    const urls = stubObjectUrls();
    requestUserPhoto(FIRST_TRAVELER);
    const url = await resolved(FIRST_TRAVELER);
    // The list remounts a row as it scrolls, which is the ask that used to cost a second download.
    requestUserPhoto(FIRST_TRAVELER);
    expect(userPhotoSnapshot(FIRST_TRAVELER)).toBe(url);
    expect(fetchStub.count()).toBe(1);
    expect(urls.minted).toHaveLength(1);
  });

  it('downloads two travelers separately, each with its own object URL', async () => {
    stubSession();
    const fetchStub = stubFetch(['ok', 'ok']);
    const urls = stubObjectUrls();
    requestUserPhoto(FIRST_TRAVELER);
    requestUserPhoto(SECOND_TRAVELER);
    const first = await resolved(FIRST_TRAVELER);
    const second = await resolved(SECOND_TRAVELER);
    expect(typeof first).toBe('string');
    expect(typeof second).toBe('string');
    expect(first).not.toBe(second);
    expect(fetchStub.count()).toBe(2);
    expect(urls.minted).toHaveLength(2);
  });

  /** The refusals that mean "nothing drawable here": the route's own `404` and any other answer a tier can produce. */
  const REFUSALS = [403, 404, 500] as const;

  it.each(REFUSALS)(
    'records the absent state for a %i answer and never asks again',
    async (status) => {
      stubSession();
      const fetchStub = stubFetch([status]);
      const urls = stubObjectUrls();
      requestUserPhoto(FIRST_TRAVELER);
      expect(await resolved(FIRST_TRAVELER)).toBeNull();
      requestUserPhoto(FIRST_TRAVELER);
      expect(fetchStub.count()).toBe(1);
      expect(urls.minted).toHaveLength(0);
    },
  );

  it.each(CALLERS)(
    'rotates once and retries once for %i callers refused together',
    async (callers) => {
      const session = stubSession();
      const fetchStub = stubFetch([401, 'ok']);
      const urls = stubObjectUrls();
      for (let caller = 0; caller < callers; caller += 1) requestUserPhoto(FIRST_TRAVELER);
      expect(await resolved(FIRST_TRAVELER)).toBe(urls.minted[0]);
      expect(session.rotations()).toBe(1);
      expect(fetchStub.sent.map((request) => request.authorization)).toEqual([
        `Bearer ${FIRST_TOKEN}`,
        `Bearer ${ROTATED_TOKEN}`,
      ]);
    },
  );

  it('gives up the photo alone when the rotation a 401 joined is refused', async () => {
    const session = stubSession('refused');
    const fetchStub = stubFetch([401, 'ok']);
    const urls = stubObjectUrls();
    requestUserPhoto(FIRST_TRAVELER);
    await settleLoad();
    expect(session.rotations()).toBe(1);
    expect(fetchStub.count()).toBe(1);
    expect(userPhotoSnapshot(FIRST_TRAVELER)).toBeNull();
    // A spent session leaves nothing to ask with, so the absent entry answers every later ask on its own.
    requestUserPhoto(FIRST_TRAVELER);
    await settleLoad();
    expect(fetchStub.count()).toBe(1);
    expect(urls.minted).toHaveLength(0);
  });

  it('records nothing when the rotation never reached the API, and a later ask retries it', async () => {
    const session = stubSession('unreachable');
    const fetchStub = stubFetch([401, 'ok']);
    const urls = stubObjectUrls();
    requestUserPhoto(FIRST_TRAVELER);
    await settleLoad();
    expect(session.rotations()).toBe(1);
    expect(fetchStub.count()).toBe(1);
    expect(userPhotoSnapshot(FIRST_TRAVELER)).toBeUndefined();
    requestUserPhoto(FIRST_TRAVELER);
    expect(await resolved(FIRST_TRAVELER)).toBe(urls.minted[0]);
    expect(fetchStub.count()).toBe(2);
  });

  it('records nothing for a request that never reached the API, and retries it on the next ask', async () => {
    stubSession();
    const fetchStub = stubFetch(['failure', 'ok']);
    const urls = stubObjectUrls();
    requestUserPhoto(FIRST_TRAVELER);
    await settleLoad();
    expect(fetchStub.count()).toBe(1);
    expect(userPhotoSnapshot(FIRST_TRAVELER)).toBeUndefined();
    requestUserPhoto(FIRST_TRAVELER);
    expect(await resolved(FIRST_TRAVELER)).toBe(urls.minted[0]);
    expect(fetchStub.count()).toBe(2);
  });

  /** The URL the frame drew, and one the entry no longer holds: the case it may act on, and the one it must not. */
  interface DiscardCase {
    readonly url: string;
    readonly state: UserPhotoState;
    readonly revoked: readonly string[];
  }

  const DISCARD_CASES: readonly DiscardCase[] = [
    { url: 'blob:photo-1', state: null, revoked: ['blob:photo-1'] },
    { url: 'blob:photo-2', state: 'blob:photo-1', revoked: [] },
  ];

  it.each(DISCARD_CASES)(
    'discards the entry only for the URL it holds ($url)',
    async (testCase) => {
      stubSession();
      stubFetch(['ok']);
      const urls = stubObjectUrls();
      requestUserPhoto(FIRST_TRAVELER);
      expect(await resolved(FIRST_TRAVELER)).toBe('blob:photo-1');
      discardUserPhoto(FIRST_TRAVELER, testCase.url);
      expect(userPhotoSnapshot(FIRST_TRAVELER)).toBe(testCase.state);
      expect(urls.revoked).toEqual(testCase.revoked);
    },
  );

  it('forgets a traveler, revoking the URL and fetching again on the next ask', async () => {
    stubSession();
    const fetchStub = stubFetch(['ok', 'ok']);
    const urls = stubObjectUrls();
    requestUserPhoto(FIRST_TRAVELER);
    expect(await resolved(FIRST_TRAVELER)).toBe('blob:photo-1');
    forgetUserPhoto(FIRST_TRAVELER);
    expect(urls.revoked).toEqual(['blob:photo-1']);
    expect(userPhotoSnapshot(FIRST_TRAVELER)).toBeUndefined();
    requestUserPhoto(FIRST_TRAVELER);
    expect(await resolved(FIRST_TRAVELER)).toBe('blob:photo-2');
    expect(fetchStub.count()).toBe(2);
  });

  it('clears every stored URL and the store itself', async () => {
    stubSession();
    const fetchStub = stubFetch(['ok', 'ok']);
    const urls = stubObjectUrls();
    requestUserPhoto(FIRST_TRAVELER);
    requestUserPhoto(SECOND_TRAVELER);
    await resolved(FIRST_TRAVELER);
    await resolved(SECOND_TRAVELER);
    clearUserPhotos();
    expect([...urls.revoked].sort()).toEqual(['blob:photo-1', 'blob:photo-2']);
    expect(userPhotoSnapshot(FIRST_TRAVELER)).toBeUndefined();
    expect(userPhotoSnapshot(SECOND_TRAVELER)).toBeUndefined();
    expect(fetchStub.count()).toBe(2);
  });

  it('notifies its subscribers as an entry resolves and stops once one unsubscribes', async () => {
    stubSession();
    stubFetch(['ok']);
    stubObjectUrls();
    const seen: UserPhotoState[] = [];
    const unsubscribe = subscribeUserPhotos(() => seen.push(userPhotoSnapshot(FIRST_TRAVELER)));
    requestUserPhoto(FIRST_TRAVELER);
    expect(await resolved(FIRST_TRAVELER)).toBe('blob:photo-1');
    expect(seen).toEqual(['blob:photo-1']);
    unsubscribe();
    forgetUserPhoto(FIRST_TRAVELER);
    expect(seen).toEqual(['blob:photo-1']);
  });

  it('asks for nothing and knows nothing for an empty traveler id', async () => {
    stubSession();
    const fetchStub = stubFetch(['ok']);
    stubObjectUrls();
    requestUserPhoto('');
    expect(userPhotoSnapshot('')).toBeUndefined();
    await settleLoad();
    expect(fetchStub.count()).toBe(0);
  });
});
