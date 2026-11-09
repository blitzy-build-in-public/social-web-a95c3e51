/**
 * The web proving Worker's launcher, page side: the deadline that ends an attempt whose Worker has
 * gone silent, the termination every settling path performs, and the reclaim of the partial artefact
 * a failed attempt leaves behind (AAP 0.3.4, AAP 0.5.5, AAP 0.8.1).
 *
 * The Worker is a stub, because no script runs here: what a case drives is the frame protocol and the
 * page's own storage. `globalThis.Worker` is a class that records everything the launcher does to it —
 * the request it posts, the listeners it registers, the termination — while the behaviour behind it
 * belongs to the case, which is how a Worker that never answers, one whose `postMessage` throws and
 * one that keeps reporting bytes are all the same class. `navigator.storage` is a directory the case
 * builds, holding the entries an interrupted download would have left in OPFS.
 *
 * `runWorker`, `ensureArtifacts` and `plan` are the real ones, and the clock is Vitest's, so a deadline
 * is crossed by advancing time rather than by waiting for it. The two deadlines the launcher keeps
 * private are minute-scale, so every case here advances well past them; the reclaim retries every half
 * second and is never awaited by the attempt that fires it, so the cases that watch it advance the
 * clock half a second at a time and read the store in between.
 */
import type { ZkConfig } from '@tablemate/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureArtifacts, plan, runWorker } from '../src/zk/artifacts.web.ts';
import type { EnsureRequest } from '../src/zk/prover.worker.ts';

vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.1.0' } } }));

/* --- The Worker the launcher starts ------------------------------------------------------------ */

/** Every Worker the launcher started in the current case, in the order it started them. */
let started: FakeWorker[] = [];

/** What a Worker does with a request that was posted to it: answer it, throw, or nothing at all. */
let behaviour: (worker: FakeWorker, request: unknown) => void = () => undefined;

/** One Worker, as far as the page can tell: its script never runs, and every call is recorded. */
class FakeWorker {
  readonly url: string;

  /** The listeners the launcher registered, by event type; the case delivers frames through them. */
  readonly listeners = new Map<string, (event: unknown) => void>();

  /** Every request the launcher posted to this Worker. */
  readonly posted: unknown[] = [];

  /** How many times the launcher terminated it. */
  terminated = 0;

  constructor(url: string) {
    this.url = url;
    started.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  postMessage(request: unknown): void {
    this.posted.push(request);
    behaviour(this, request);
  }

  terminate(): void {
    this.terminated += 1;
  }
}

/* --- The frames, and the outcome a case reads -------------------------------------------------- */

/** The two artefact links of `GET /v1/zk/config`, at the sizes the entries of a case are built to. */
const ARTIFACTS: ZkConfig['artifacts'] = {
  wasm: {
    url: 'https://artifacts.test/tablemate_itinerary.wasm',
    size: 64,
    sha256: 'b'.repeat(64),
  },
  zkey: {
    url: 'https://artifacts.test/tablemate_itinerary.zkey',
    size: 4096,
    sha256: 'a'.repeat(64),
  },
};

/** The OPFS entry names the page reclaims from, as `prover.worker.ts` stores them. */
const WASM_FILE = 'tablemate_itinerary.wasm';
const ZKEY_FILE = 'tablemate_itinerary.zkey';
const META_SUFFIX = '.meta.json';

/** One request per Worker, so the frame id is a constant. */
const ID = 1;

/**
 * Past both deadlines the launcher keeps private. Neither is anywhere near an hour — one allows
 * minutes of silence in a phase that reports bytes, the other tens of minutes while the proof is
 * made — so a Worker that never answers at all is settled by this much advancing.
 */
const AN_HOUR_MS = 60 * 60_000;

/**
 * Four minutes, which is under the shortest silence the launcher allows and so never a failure by
 * itself. Four of them without a frame exceed it, which is what makes the case below prove that a
 * frame restarts the deadline rather than merely that the deadline is long.
 */
const WATCHDOG_GAP_MS = 4 * 60_000;

/** The `ensure` request `ensureArtifacts` posts for the two artefact links above. */
function ensureRequest(): EnsureRequest {
  return {
    type: 'ensure',
    id: ID,
    artifacts: { wasm: ARTIFACTS.wasm, zkey: ARTIFACTS.zkey },
    appVersion: '0.1.0',
  };
}

/** One progress report, as the Worker posts it while it downloads, verifies, loads or proves. */
function progressFrame(phase: string): unknown {
  return { type: 'progress', id: ID, phase, receivedBytes: 1024, totalBytes: 4096 };
}

/** The reply that answers an `ensure`, carrying the two artefacts it resolved. */
const ENSURED = {
  type: 'ensured',
  id: ID,
  artifacts: {
    wasm: {
      location: WASM_FILE,
      sha256: ARTIFACTS.wasm.sha256,
      size: ARTIFACTS.wasm.size,
    },
    zkey: {
      location: ZKEY_FILE,
      sha256: ARTIFACTS.zkey.sha256,
      size: ARTIFACTS.zkey.size,
    },
  },
};

/** The one Worker the launcher started for the current case. */
function onlyWorker(): FakeWorker {
  const worker = started[0];
  if (started.length !== 1 || worker === undefined) {
    throw new Error(`expected one Worker, saw ${started.length}`);
  }
  return worker;
}

/** Delivers one frame to the launcher, as the Worker's own `message` event would. */
function deliver(worker: FakeWorker, frame: unknown): void {
  const listener = worker.listeners.get('message');
  if (listener === undefined) throw new Error('the launcher registered no message listener');
  listener({ data: frame });
}

/** The code an error carries, as `prover.ts`'s `errorCodeOf` reads it. */
function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

/** Whether an attempt settled, and the code it rejected with: never a rejection nothing handles. */
type Outcome =
  { readonly state: 'resolved' } | { readonly state: 'rejected'; readonly code: unknown };

/** An attempt read as data, so a case can ask both whether it settled and what it settled as. */
function watch(attempt: Promise<unknown>): Promise<Outcome> {
  return attempt.then(
    (): Outcome => ({ state: 'resolved' }),
    (error: unknown): Outcome => ({ state: 'rejected', code: codeOf(error) }),
  );
}

/* --- The deadline, and the termination every path performs ------------------------------------- */

describe('a Worker the page cannot hear from', () => {
  beforeEach(() => {
    started = [];
    behaviour = () => undefined;
    vi.stubGlobal('__DEV__', false);
    vi.stubGlobal('Worker', FakeWorker);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fails an attempt whose Worker never answers', async () => {
    const attempt = runWorker<'ensured'>(ensureRequest());
    const worker = onlyWorker();
    const watched = watch(attempt);

    // The request went out and nothing ever came back: only the deadline can settle this attempt,
    // which is what a Worker the browser killed under memory pressure looks like from here.
    expect(worker.posted).toEqual([ensureRequest()]);
    await vi.advanceTimersByTimeAsync(AN_HOUR_MS);

    expect(await watched).toEqual({ state: 'rejected', code: 'worker_failed' });
    expect(worker.terminated).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails an attempt whose request cannot be structured-cloned', async () => {
    behaviour = () => {
      throw new DOMException('could not be cloned', 'DataCloneError');
    };
    const attempt = runWorker<'ensured'>(ensureRequest());
    const worker = onlyWorker();

    // The request never reached the Worker, so nothing in it can answer: the launcher ends the one it
    // started rather than leaving it running behind a call that has already rejected.
    expect(await watch(attempt)).toEqual({ state: 'rejected', code: 'worker_failed' });
    expect(worker.terminated).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers a reply while every frame before it restarts the deadline', async () => {
    const attempt = runWorker<'ensured'>(ensureRequest());
    const worker = onlyWorker();
    let outcome: Outcome | null = null;
    void watch(attempt).then((settled) => {
      outcome = settled;
    });

    // One frame per phase, each followed by a silence under the deadline but four times over it
    // together: an attempt that stayed alive this long did so because each frame restarted it.
    for (const phase of ['download', 'verify', 'load', 'prove']) {
      deliver(worker, progressFrame(phase));
      await vi.advanceTimersByTimeAsync(WATCHDOG_GAP_MS);
      expect(outcome).toBeNull();
    }

    deliver(worker, ENSURED);
    await vi.advanceTimersByTimeAsync(0);

    expect(outcome).toEqual({ state: 'resolved' });
    expect(worker.terminated).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/* --- The reclaim a failed attempt performs ----------------------------------------------------- */

/** The entries of a fake OPFS directory, and everything a case asks about it afterwards. */
interface FakeStore {
  readonly entries: Map<string, File>;

  /** Every removal the store served, in order. */
  readonly removed: string[];

  /** Every read and removal it refused, in order: one entry per sweep that was locked out. */
  readonly refused: string[];
}

/** The entry a store still holds on to, and how many reads and removals it refuses it for. */
interface StoreLock {
  readonly name: string;
  readonly attempts: number;
}

/**
 * One reclaim retry interval, mirrored from the launcher's own constant, which it keeps private: the
 * sweep comes back this often while the store refuses it. Advancing an interval at a time, and reading
 * the store in between, is what shows that a case's sweep retried rather than merely waited.
 */
const RECLAIM_RETRY_MS = 500;

/** How many sweeps the launcher's reclaim makes before giving up, mirrored from the same constant. */
const RECLAIM_ATTEMPTS = 30;

/**
 * The store a cancelled download leaves behind: the key's entry, truncated where the Worker stopped,
 * with no record beside it — which the next attempt's verification reads as nothing stored — and a WASM
 * entry at its declared size, which may be a complete download whose record write was interrupted,
 * beside the record that vouches for it.
 */
function interruptedStore(): Map<string, File> {
  return new Map([
    [ZKEY_FILE, new File([new Uint8Array(1024)], ZKEY_FILE)],
    [WASM_FILE, new File([new Uint8Array(ARTIFACTS.wasm.size)], WASM_FILE)],
    [`${WASM_FILE}${META_SUFFIX}`, new File(['{}'], `${WASM_FILE}${META_SUFFIX}`)],
  ]);
}

/**
 * The origin private file system, stubbed: a directory that already exists — the page never creates
 * one — holding the entries a case puts in it. A name it does not hold answers `NotFoundError`, as
 * `getFileHandle` does, and a removal takes the entry out of the table it lists removals in.
 *
 * `lock` names an entry the store refuses to hand out or remove for its first `lock.attempts` reads and
 * removals, answering `NoModificationAllowedError` as Chromium does while a Worker's synchronous access
 * handle is still open on the entry it was writing. Each refusal is recorded, so a case sees both that
 * the sweep came back and how often it was turned away. Left out, the store refuses nothing: that is a
 * store whose handle has already gone.
 */
function storageWith(store: FakeStore, lock?: StoreLock): unknown {
  /** How many reads and removals the store still refuses the locked entry for. */
  let lockedFor = lock?.attempts ?? 0;

  /** The refusal for `name` while the store is still holding it, or null when it is answerable. */
  const refusalFor = (name: string): DOMException | null => {
    if (lock === undefined || name !== lock.name || lockedFor === 0) return null;
    lockedFor -= 1;
    store.refused.push(name);
    return new DOMException(`${name} is still being written`, 'NoModificationAllowedError');
  };

  const directory = {
    getFileHandle: (name: string): Promise<unknown> => {
      const refusal = refusalFor(name);
      if (refusal !== null) return Promise.reject(refusal);
      const file = store.entries.get(name);
      return file === undefined
        ? Promise.reject(new DOMException('no such entry', 'NotFoundError'))
        : Promise.resolve({ getFile: (): Promise<File> => Promise.resolve(file) });
    },
    removeEntry: (name: string): Promise<void> => {
      const refusal = refusalFor(name);
      if (refusal !== null) return Promise.reject(refusal);
      store.entries.delete(name);
      store.removed.push(name);
      return Promise.resolve();
    },
  };
  return {
    storage: {
      getDirectory: (): Promise<unknown> =>
        Promise.resolve({
          getDirectoryHandle: (_name: string): Promise<unknown> => Promise.resolve(directory),
        }),
    },
  };
}

/**
 * A proof attempt the traveller cancels at once: the Worker was asked for the artefacts and is
 * terminated before it answers, which is the state whose residue the reclaim exists for. The outcome is
 * watched from the start, so no rejection is ever one a case has nothing attached to.
 */
function cancelAttempt(): { readonly settled: Promise<Outcome>; readonly worker: FakeWorker } {
  const controller = new AbortController();
  const attempt = ensureArtifacts(ARTIFACTS, undefined, controller.signal);
  const worker = onlyWorker();
  const settled = watch(attempt);
  controller.abort();
  return { settled, worker };
}

describe('the reclaim of a cancelled download', () => {
  beforeEach(() => {
    started = [];
    behaviour = () => undefined;
    vi.stubGlobal('__DEV__', false);
    vi.stubGlobal('Worker', FakeWorker);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('removes what cannot be the artefact and keeps what may already be it', async () => {
    const store: FakeStore = { entries: interruptedStore(), removed: [], refused: [] };
    vi.stubGlobal('navigator', storageWith(store));

    const cancelled = cancelAttempt();

    // The Worker is terminated before the failure travels, so its own cleanup never ran; the page
    // reclaims the bytes it was writing, and the failure it reports is unchanged. The reclaim is no
    // part of that answer, so it is the flush below that lets it finish.
    expect(await cancelled.settled).toEqual({ state: 'rejected', code: 'cancelled' });
    expect(cancelled.worker.terminated).toBe(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(store.removed).toEqual([ZKEY_FILE]);
    expect(store.entries.has(ZKEY_FILE)).toBe(false);
    expect(store.entries.has(WASM_FILE)).toBe(true);
    expect(store.entries.has(`${WASM_FILE}${META_SUFFIX}`)).toBe(true);
  });

  it('reclaims the partial once the store lets go, without holding back the failure', async () => {
    const store: FakeStore = { entries: interruptedStore(), removed: [], refused: [] };
    // A store that refuses the entry for two sweeps: the window in which a terminated Worker's handle
    // is still on the entry it was writing while its last writes land.
    vi.stubGlobal('navigator', storageWith(store, { name: ZKEY_FILE, attempts: 2 }));

    const cancelled = cancelAttempt();

    // The traveller waits for the cancellation, never for the space: the failure settles while the
    // partial is still in the store, and it settles without waiting on the sweep.
    expect(await cancelled.settled).toEqual({ state: 'rejected', code: 'cancelled' });
    expect(cancelled.worker.terminated).toBe(1);
    expect(store.removed).toEqual([]);
    expect(store.entries.has(ZKEY_FILE)).toBe(true);

    // An interval later the sweep is back and refused again: it did come back, and the store is what
    // will not let go yet.
    await vi.advanceTimersByTimeAsync(RECLAIM_RETRY_MS);
    expect(store.refused).toEqual([ZKEY_FILE, ZKEY_FILE]);
    expect(store.removed).toEqual([]);

    // One more interval, and the store answers: the partial is gone, and the right-sized WASM entry
    // and the record vouching for it are untouched.
    await vi.advanceTimersByTimeAsync(RECLAIM_RETRY_MS);
    expect(store.removed).toEqual([ZKEY_FILE]);
    expect(store.entries.has(ZKEY_FILE)).toBe(false);
    expect(store.entries.has(WASM_FILE)).toBe(true);
    expect(store.entries.has(`${WASM_FILE}${META_SUFFIX}`)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up quietly on a store that never lets go of the entry', async () => {
    const store: FakeStore = { entries: interruptedStore(), removed: [], refused: [] };
    // A store that refuses the entry every time: the retry is bounded, and what it leaves behind is
    // silent — the sweep's promise is one nothing has to attach a handler to.
    vi.stubGlobal(
      'navigator',
      storageWith(store, { name: ZKEY_FILE, attempts: Number.POSITIVE_INFINITY }),
    );

    const cancelled = cancelAttempt();
    expect(await cancelled.settled).toEqual({ state: 'rejected', code: 'cancelled' });

    // Every sweep the reclaim makes is refused, an interval apart, and then it stops: nothing is left
    // scheduled, an hour of clock changes nothing, and the partial it could not reclaim stays for the
    // next attempt to download over.
    await vi.advanceTimersByTimeAsync(RECLAIM_RETRY_MS * RECLAIM_ATTEMPTS);
    expect(store.refused).toHaveLength(RECLAIM_ATTEMPTS);
    expect(store.removed).toEqual([]);
    expect(store.entries.has(ZKEY_FILE)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(AN_HOUR_MS);
    expect(store.refused).toHaveLength(RECLAIM_ATTEMPTS);
    expect(store.removed).toEqual([]);
  });

  it('sweeps a residue on the next visit, when a screen asks what a download would cost', async () => {
    // A tab closed inside the retry window leaves the partial behind with nobody sweeping it, and the
    // generate screen's own question is the next look at this store.
    const store: FakeStore = { entries: interruptedStore(), removed: [], refused: [] };
    vi.stubGlobal('navigator', storageWith(store));

    // The answer is the one this page gives without the reclaim — the partial is not the artefact, so
    // the whole download is still owed — and the sweep it fires is no part of it.
    expect(await plan(ARTIFACTS)).toEqual({
      cached: false,
      downloadBytes: ARTIFACTS.wasm.size + ARTIFACTS.zkey.size,
      connection: 'unknown',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(store.removed).toEqual([ZKEY_FILE]);
    expect(store.entries.has(ZKEY_FILE)).toBe(false);
    expect(store.entries.has(WASM_FILE)).toBe(true);
    expect(store.entries.has(`${WASM_FILE}${META_SUFFIX}`)).toBe(true);
  });
});
