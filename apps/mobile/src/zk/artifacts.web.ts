/**
 * Proving-artefact delivery on the web, page side, and the launcher of the proving Worker (AAP 0.3.4,
 * AAP 0.5.5 "Delivery of proving artefacts — Web", AAP 0.8.1).
 *
 * The download belongs to the Worker — it streams the circuit WASM and the proving key into the Origin Private
 * File System, hashing each as it arrives, and serves the request from the artefacts' published URLs where that
 * file system cannot be used — so this page holds no byte of the key and takes no view of which source served
 * it: only the Worker can see whether the origin private file system works (AAP 0.3.4). What this page owns is
 * the Worker's lifetime, its frame protocol, the reclaim of what a failed attempt left in the store, and the
 * cheap question a generate screen asks before a gigabyte moves.
 *
 * That reclaim is a sweep that retries, because terminating a Worker does not release the entry it was writing
 * at once: its synchronous access handle outlives it by seconds while its last writes land, and for that whole
 * window the store refuses this page's read of the entry and its removal, so one sweep inside the window
 * reclaims nothing at all. It is never awaited either — the failure a traveller waits on must not wait for space
 * — and it removes only an entry whose size differs from the declaration, because an entry of the declared size
 * may still be the artefact the next attempt's digest check accepts.
 *
 * A Worker never outlives an attempt: while it proves it holds the whole key plus the witness buffers, and no
 * message cancels a run in flight, so terminating it is both how that memory comes back and the only
 * cancellation the web proving path has. A Worker the browser kills for holding that much leaves no event
 * behind, so its silence is bounded here. A failure leaves as one {@link ZkClientErrorCode}, never as text that
 * could carry a booking confirmation.
 *
 * Everything here is `import type` except `expo-constants`, so the app's bundle carries no snarkjs and no
 * `@noble/hashes`: those load only in the Worker, and `prover.web.ts` reuses {@link runWorker} for its `prove`
 * frames.
 */
import Constants from 'expo-constants';

import type { ZkConfig } from '@tablemate/shared';

import type {
  ArtifactPlan,
  ArtifactStore,
  DownloadProgress,
  ResolvedArtifacts,
  ZkClientErrorCode,
} from './prover.ts';
import type { WorkerRequest, WorkerResponse } from './prover.worker.ts';

/** A `snake_case` code, the only form a frame, an error and a screen's sentence carry. */
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The client's own error, shaped as `prover.ts`'s `errorCodeOf` reads it. Its `message` is the code
 * alone, so no text can travel out of an attempt.
 */
function fail(code: ZkClientErrorCode): Error {
  return Object.assign(new Error(code), { name: 'ZkClientError', code });
}

/* --- Where the Worker comes from (AAP 0.5.5) ------------------------------------------------- */

/*
 * Metro's own bundle of the Worker entry in development — relative to Metro's server root, this pnpm workspace's
 * root, hence the full `apps/mobile/...` path — and the export's `prover.worker.js`, emitted beside the bundle by
 * the `export:worker` step of the app's `export:web` script.
 */
const DEV_WORKER_URL =
  '/apps/mobile/src/zk/prover.worker.bundle?platform=web&dev=true&minify=false';
const EXPORTED_WORKER_URL = '/prover.worker.js';

/** This build's Worker URL: a classic same-origin script, which `worker-src 'self' blob:` allows. */
export function proverWorkerUrl(): string {
  return __DEV__ ? DEV_WORKER_URL : EXPORTED_WORKER_URL;
}

/* --- The launcher (AAP 0.5.5) ---------------------------------------------------------------- */

/** The fields of either side's frames, before any of them is trusted. */
interface FrameFields {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly phase?: unknown;
  readonly receivedBytes?: unknown;
  readonly totalBytes?: unknown;
  readonly code?: unknown;
}

/** One message's fields, or null when the message is not an object at all. */
function frameOf(data: unknown): FrameFields | null {
  return typeof data === 'object' && data !== null ? data : null;
}

/** A number a frame reported, or 0 when it reported something that is not one. */
function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The code an `error` frame reported, as one of this client's own (`worker_failed` otherwise). */
function codeOf(value: unknown): ZkClientErrorCode {
  return typeof value === 'string' && CODE_PATTERN.test(value)
    ? (value as ZkClientErrorCode)
    : 'worker_failed';
}

/*
 * A type argument may be written as the request's own name (`ensure`, `prove`) or as the reply that answers it
 * (`ensured`, `proved`), and either way the request it may pass and the reply it gets back are nailed to that one
 * name: a `prove` request under an `ensured` argument does not compile, which keeps the call sites in
 * `prover.web.ts` honest.
 */
type WorkerName = WorkerRequest['type'] | WorkerResponse['type'];

type RequestFor<T extends WorkerName> = Extract<
  WorkerRequest,
  { readonly type: T extends 'ensured' ? 'ensure' : T extends 'proved' ? 'prove' : T }
>;

type ReplyFor<T extends WorkerName> = Extract<
  WorkerResponse,
  { readonly type: T extends 'ensure' ? 'ensured' : T extends 'prove' ? 'proved' : T }
>;

/** What {@link runWorker} may be told besides the request itself. */
export interface RunWorkerOptions {
  /** Called as the Worker reports bytes, for its download, verify and load phases. */
  onProgress?: (progress: DownloadProgress) => void;
  /** Aborts the attempt: the Worker is terminated and the call rejects with `cancelled`. */
  signal?: AbortSignal;
}

/*
 * How long the launcher waits for the Worker to say something, in the two kinds of silence this Worker can
 * produce. A Worker the browser kills under memory pressure — the risk of holding the whole proving key, which
 * AAP 0.3.4 names for this path — sends no event at all, so a deadline is the only thing that can turn that death
 * into an answer. Both bounds sit far above the pace of a working attempt, because failing one that is merely slow
 * would cost the traveller the transfer or the proof it was making.
 *
 * {@link WATCHDOG_TRANSFER_MS} covers every phase that reports bytes, and the silence before the first frame,
 * which holds the Worker's own script load and first fetch: such a phase posts a frame at least every
 * `PROGRESS_STEP_BYTES` (1 MiB), so five minutes of silence is a transfer slower than 3.4 KiB/s, while a Worker
 * that never starts at all is failed in minutes rather than never. {@link WATCHDOG_PROVING_MS} covers the prove
 * phase, the one phase in which a working single-threaded Worker cannot post anything at all: the desktop web runs
 * recorded in `docs/zk-performance.md` took 209-263 s, so thirty minutes is several times the slowest measured
 * engine, and the 90-second figure of AAP 0.5.5 names the phone classes only.
 */
const WATCHDOG_TRANSFER_MS = 5 * 60_000;
const WATCHDOG_PROVING_MS = 30 * 60_000;

/**
 * Runs one request in a fresh proving Worker and answers with its reply (AAP 0.3.4, AAP 0.5.5).
 *
 * The Worker serves this call alone and is terminated before the promise settles, on every path — a reply, a
 * failure, an abort — which is the memory and cancellation contract of the web path. Nothing about the request is
 * retained: `postMessage` structured-clones it, so this frame keeps no reference to a `prove` frame's `inputsJson`.
 *
 * A Worker that answers nothing is failed rather than waited on: the browser can kill one that holds the whole
 * key, and that death leaves no event behind, so each frame restarts a deadline sized by the phase it names and a
 * silence past it is `worker_failed`. Silence is the one signal a Worker cannot send, and this deadline is what
 * reads it. Throws `worker_unavailable` when this browser has no `Worker` or the script fails to load,
 * `cancelled` when `signal` aborted, and otherwise the code the Worker reported.
 */
export function runWorker<T extends WorkerName = WorkerRequest['type']>(
  request: RequestFor<T>,
  options: RunWorkerOptions = {},
): Promise<ReplyFor<T>> {
  const { onProgress, signal } = options;
  if (typeof Worker !== 'function') return Promise.reject(fail('worker_unavailable'));
  if (signal?.aborted === true) return Promise.reject(fail('cancelled'));
  return new Promise<ReplyFor<T>>((resolve, reject) => {
    const worker = new Worker(proverWorkerUrl());
    const id = request.id;
    /** The deadline bounding the current silence, or null once the attempt has ended. */
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    /** Settles the attempt: the listeners go, and then the Worker and all it holds go with them. */
    const end = (): void => {
      if (watchdog !== null) {
        clearTimeout(watchdog);
        watchdog = null;
      }
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    /**
     * Waits for the next frame of this attempt. A Worker the browser killed sends nothing at all, so
     * that silence is the only evidence the death leaves, and the last frame's phase sizes how much
     * of it is allowed before the attempt is given up on.
     */
    function onSilence(): void {
      end();
      reject(fail('worker_failed'));
    }
    /** Restarts the deadline at the pace of the phase the frame that arrived belongs to. */
    function armWatchdog(phase: unknown): void {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = setTimeout(
        onSilence,
        phase === 'prove' ? WATCHDOG_PROVING_MS : WATCHDOG_TRANSFER_MS,
      );
    }
    function onMessage(event: MessageEvent<unknown>): void {
      const frame = frameOf(event.data);
      // One request per Worker, so a frame for another id is ignored rather than allowed to settle
      // an attempt it does not belong to.
      if (frame === null || frame.id !== id) return;
      // A frame of this attempt is proof the Worker is alive, and the phase it names is the pace the
      // next one is expected at: the deadline starts over here, on every frame, progress included.
      armWatchdog(frame.phase);
      switch (frame.type) {
        case 'progress':
          onProgress?.({
            receivedBytes: numberOf(frame.receivedBytes),
            totalBytes: numberOf(frame.totalBytes),
          });
          return;
        case 'ensured':
        case 'proved':
          end();
          resolve(event.data as ReplyFor<T>);
          return;
        case 'error':
          end();
          reject(fail(codeOf(frame.code)));
          return;
        default:
          return;
      }
    }
    function onError(): void {
      // The script failed to load or threw while loading: this build cannot prove on this browser.
      end();
      reject(fail('worker_unavailable'));
    }
    function onMessageError(): void {
      // A frame that could not be deserialized: nothing usable crossed the boundary either way.
      end();
      reject(fail('worker_failed'));
    }
    function onAbort(): void {
      end();
      reject(fail('cancelled'));
    }
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    signal?.addEventListener('abort', onAbort);
    // Armed before the request goes out: the Worker owes this attempt an answer from the moment it is
    // asked, and a Worker killed before its first frame is exactly as silent as one killed later.
    armWatchdog(undefined);
    try {
      worker.postMessage(request);
    } catch {
      // A request that cannot be structured-cloned never reaches the Worker, so nothing in it will
      // ever answer: the Worker is ended here, where every other path ends it.
      end();
      reject(fail('worker_failed'));
    }
  });
}

/* --- The artefact store (AAP 0.5.1, AAP 0.5.5) ----------------------------------------------- */

/** The OPFS directory the Worker keeps both artefacts and their records in, and the entry names it
 * stores them under. `location` in its `ensured` reply carries one of these names when the Worker
 * stored the artefact, and the artefact's published URL when it could not store it. */
const STORAGE_DIRECTORY = 'tablemate-zk';
const WASM_FILE = 'tablemate_itinerary.wasm';
const ZKEY_FILE = 'tablemate_itinerary.zkey';
const META_SUFFIX = '.meta.json';

/** The record the Worker writes beside a verified artefact, as far as this page reads it. */
interface StoredMeta {
  readonly sha256: string;
  readonly size: number;
  readonly appVersion: string;
}

/** That record once it is known to be one, or null for anything else a file might hold. */
function asStoredMeta(value: unknown): StoredMeta | null {
  const meta = value as Partial<StoredMeta> | null;
  const wellFormed =
    typeof meta?.sha256 === 'string' &&
    typeof meta.size === 'number' &&
    typeof meta.appVersion === 'string';
  return wellFormed ? { sha256: meta.sha256, size: meta.size, appVersion: meta.appVersion } : null;
}

/**
 * The running app's version, recorded with every verified artefact: an update can replace the circuit
 * without touching the key's bytes, so the version that verified it is part of being current.
 */
function appVersion(): string {
  return Constants.expoConfig?.version ?? 'unknown';
}

/** The page's storage manager, or undefined where the global is absent or offers no OPFS. */
function storageManager(): Partial<StorageManager> | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.storage;
}

/**
 * The OPFS directory holding the artefacts, or null when this origin has none yet. Creating it belongs
 * to the Worker, so a page that only asks what a download would cost creates nothing.
 */
async function openedDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const storage = storageManager();
  if (typeof storage?.getDirectory !== 'function') return null;
  const root = await storage.getDirectory();
  try {
    return await root.getDirectoryHandle(STORAGE_DIRECTORY);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') return null;
    throw err;
  }
}

/** One entry of the directory, or null when the directory holds no such file. */
async function existingHandle(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | null> {
  try {
    return await directory.getFileHandle(name);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') return null;
    throw err;
  }
}

/**
 * The record beside `name`, or null when it is absent, unreadable or not one this client wrote — in
 * which case the artefact beside it counts as absent and is downloaded, never as verified.
 */
async function storedMetaOf(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<StoredMeta | null> {
  const handle = await existingHandle(directory, `${name}${META_SUFFIX}`);
  if (handle === null) return null;
  try {
    return asStoredMeta(JSON.parse(await (await handle.getFile()).text()));
  } catch {
    return null;
  }
}

/**
 * Whether one stored artefact is the published file and current: its record's digest, size and app version, and
 * the entry's own size. Only `File` metadata is read, so this costs a kilobyte of JSON rather than a gigabyte of
 * key, and the modification time is deliberately not consulted, because on OPFS Chromium leaves it at the file's
 * creation time — which is why the Worker re-hashes by digest before proving.
 */
async function isCurrent(
  directory: FileSystemDirectoryHandle,
  name: string,
  ref: ZkConfig['artifacts']['zkey'],
  version: string,
): Promise<boolean> {
  const handle = await existingHandle(directory, name);
  if (handle === null) return false;
  const meta = await storedMetaOf(directory, name);
  if (meta === null || meta.sha256 !== ref.sha256 || meta.size !== ref.size) return false;
  if (meta.appVersion !== version) return false;
  return (await handle.getFile()).size === ref.size;
}

/**
 * What a download would cost right now, without starting one (AAP 0.5.5).
 *
 * `cached` comes from the records and the entries' sizes, so a generate screen can say a proof needs no download
 * and recommend Wi-Fi otherwise, and `downloadBytes` counts only what is missing; both are advice, because the
 * attempt that follows re-verifies by digest and downloads for real. A browser with no OPFS, a directory it cannot
 * read and a record it cannot parse all answer with the whole download, because none of them can show that a
 * download is unnecessary. `connection` is always `unknown`, because a browser exposes no dependable way to tell
 * Wi-Fi from cellular and a guess would drive the warning the traveller reads.
 *
 * The artefact reclaim is fired here as well, unawaited, so a residue a tab left behind by closing inside its
 * retry window goes on the next visit; it changes nothing about the answer.
 */
export async function plan(artifacts: ZkConfig['artifacts']): Promise<ArtifactPlan> {
  const { wasm, zkey } = artifacts;
  // Not awaited: what the generate screen came for is the answer below, which is advice it reads at
  // once, and the reclaim may take RECLAIM_ATTEMPTS × RECLAIM_RETRY_MS to finish behind it.
  void reclaimPartialArtifacts(artifacts);
  const wholeDownload: ArtifactPlan = {
    cached: false,
    downloadBytes: wasm.size + zkey.size,
    connection: 'unknown',
  };
  try {
    const directory = await openedDirectory();
    if (directory === null) return wholeDownload;
    const version = appVersion();
    const [wasmStored, zkeyStored] = await Promise.all([
      isCurrent(directory, WASM_FILE, wasm, version),
      isCurrent(directory, ZKEY_FILE, zkey, version),
    ]);
    return {
      cached: wasmStored && zkeyStored,
      downloadBytes: (wasmStored ? 0 : wasm.size) + (zkeyStored ? 0 : zkey.size),
      connection: 'unknown',
    };
  } catch {
    // A store this page cannot read holds nothing it may call verified.
    return wholeDownload;
  }
}

/*
 * How long the reclaim waits before sweeping the store again, and how many sweeps it makes. A terminated Worker's
 * synchronous access handle on the entry it was writing is not released at once — measured here, that entry kept
 * growing for ~2 s after the page had terminated its Worker — and for that whole window the store refuses this
 * page's read of the entry and its removal, which is precisely the case this cleanup exists for; hence the retry,
 * and hence a bound, so a store that never lets go is left behind a screen that has long moved on (AAP 0.5.5).
 */
const RECLAIM_RETRY_MS = 500;
const RECLAIM_ATTEMPTS = 30;

/** Resolves after `ms`: how the reclaim waits out a store that is still refusing it. */
function waitForRetry(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Removes every entry of the store that can never become an artefact, and lets a store that refuses to be read or
 * written refuse out of it (AAP 0.5.5).
 *
 * The directory is only opened, never created, so an origin that has stored nothing is left untouched; an entry
 * that is absent is not a failure; and an entry the size of the declaration is skipped and never removed, because
 * it may be a complete download whose record write was interrupted and the digest check of the next attempt is
 * what decides it. No record is touched either, because a record vouching for a verified artefact must outlive
 * this cleanup. Nothing here is caught: a refusal — a locked entry's `NoModificationAllowedError` included — is
 * the caller's to wait out and ask again.
 */
async function removeIncompleteArtifacts(artifacts: ZkConfig['artifacts']): Promise<void> {
  const directory = await openedDirectory();
  if (directory === null) return;
  const entries: readonly (readonly [string, number])[] = [
    [WASM_FILE, artifacts.wasm.size],
    [ZKEY_FILE, artifacts.zkey.size],
  ];
  for (const [name, declaredSize] of entries) {
    const handle = await existingHandle(directory, name);
    if (handle === null) continue;
    if ((await handle.getFile()).size === declaredSize) continue;
    await directory.removeEntry(name);
  }
}

/**
 * Reclaims what a failed attempt left in the store, retrying while the store refuses it (AAP 0.5.5).
 *
 * An attempt that fails or is cancelled ends at `worker.terminate()`, so the Worker's own cleanup never happens
 * and the entry it was writing stays behind: the page measured ~625 MB of a 1.59 GB key held that way after a
 * cancel. Terminating that Worker does not let go of the entry at once either — its synchronous access handle
 * outlives it by seconds while the writes it had already issued land, and for all of that window the store refuses
 * this page's read of the entry and its removal — so a sweep that ran once and gave up would reclaim nothing in
 * exactly the case it exists for; this one is asked again every {@link RECLAIM_RETRY_MS} until it succeeds, or
 * until the store has refused it {@link RECLAIM_ATTEMPTS} times, after which it gives up quietly.
 *
 * Nothing on this page can finish that download, and an entry whose size differs from the declaration can never
 * become the artefact either, so the bytes are removed rather than held until the next attempt overwrites them; an
 * entry of the declared size and every record are left alone, for the reasons {@link removeIncompleteArtifacts}
 * gives.
 *
 * The returned promise always resolves, and no caller awaits it: reclaiming space is a best effort beside a failure
 * that has already happened, and the cancellation a traveller is waiting on must not wait up to
 * {@link RECLAIM_ATTEMPTS} × {@link RECLAIM_RETRY_MS} for it. Giving up is silent for the same reason, because
 * there is nothing a user could do about it and the next attempt downloads over whatever is left.
 */
async function reclaimPartialArtifacts(artifacts: ZkConfig['artifacts']): Promise<void> {
  for (let attempt = 0; attempt < RECLAIM_ATTEMPTS; attempt += 1) {
    try {
      await removeIncompleteArtifacts(artifacts);
      return;
    } catch {
      // A store that refused this sweep — a terminated Worker's handle still on the entry, or a store
      // momentarily unusable — is waited out and asked again, up to the bound above.
      await waitForRetry(RECLAIM_RETRY_MS);
    }
  }
}

/**
 * Both artefacts, present and verified on this browser (AAP 0.5.1, AAP 0.5.5).
 *
 * The streaming, the hashing and every write happen in the Worker, which is what keeps a gigabyte-scale key off the
 * page's main thread; this call owns the attempt — one `ensure` request, its progress reports, and the Worker's
 * termination when it ends. Which source serves that request is the Worker's to decide, and either way the reply's
 * `location`s are what `prover.web.ts` passes straight back in its `prove` frames (AAP 0.3.4).
 *
 * An attempt that fails or is cancelled takes its Worker with it, so the partial artefact that Worker was writing is
 * reclaimed by the sweep {@link reclaimPartialArtifacts} starts here, which retries until the terminated Worker's
 * handle releases the entry; the failure itself travels on at once instead of waiting for that sweep. Throws
 * `cancelled`, `worker_unavailable`, and otherwise what the Worker reported — `artifact_download_failed`,
 * `artifact_insufficient_storage` or `artifact_hash_mismatch`.
 */
export async function ensureArtifacts(
  artifacts: ZkConfig['artifacts'],
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<ResolvedArtifacts> {
  if (signal?.aborted === true) throw fail('cancelled');
  // Best effort, and the answer is not read: a granted persistence makes the browser far less likely
  // to evict a gigabyte-scale key under storage pressure, and a refusal costs nothing (AAP 0.5.5).
  // Deliberately not awaited: Firefox settles this promise only once its persistent-storage prompt is
  // answered, so a session that never answers one — an automated browser — would otherwise sit in the
  // download phase forever. Persistence is an optimisation, never a condition of proving, and neither
  // is the storage this asks it for: a browser offering none skips this and proves from the artefacts'
  // published URLs.
  try {
    void Promise.resolve(storageManager()?.persist?.()).catch(() => undefined);
  } catch {
    // Intentionally ignored: persistence is an optimisation, never a condition of proving.
  }
  // Built field by field rather than spread: `exactOptionalPropertyTypes` makes an explicit
  // `undefined` a different thing from an absent property, and the frame must carry only what the
  // caller supplied.
  const options: RunWorkerOptions = {};
  if (onProgress !== undefined) options.onProgress = onProgress;
  if (signal !== undefined) options.signal = signal;
  let reply: ReplyFor<'ensured'>;
  try {
    reply = await runWorker<'ensured'>(
      {
        type: 'ensure',
        id: 1,
        artifacts: { wasm: artifacts.wasm, zkey: artifacts.zkey },
        appVersion: appVersion(),
      },
      options,
    );
  } catch (err) {
    // What the attempt wrote on its way to failing is reclaimed, and the failure itself is re-raised
    // unchanged: the reclaim never becomes an attempt's outcome. Deliberately not awaited — the
    // cancellation this reports must not wait on space being reclaimed, and the sweep retries until
    // the terminated Worker's handle releases the entry (AAP 0.5.5).
    void reclaimPartialArtifacts(artifacts);
    throw err;
  }
  return reply.artifacts;
}

/** The artefact store this platform downloads and verifies through (AAP 0.5.5). */
export const artifactStore = { plan, ensureArtifacts } satisfies ArtifactStore;
