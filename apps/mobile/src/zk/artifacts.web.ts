/**
 * Proving-artefact delivery on the web, page side, and the launcher of the proving Worker
 * (AAP 0.3.4, AAP 0.5.5 "Delivery of proving artefacts — Web", AAP 0.8.1).
 *
 * The browser half of the artefact pair whose contract `./prover.ts` declares, and the only place the
 * client creates a `Worker`. The download belongs to the Worker — it streams the circuit WASM and the
 * proving key into the Origin Private File System, hashing each as it arrives — so this page holds no
 * byte of the key. What it owns is the Worker's lifetime, its frame protocol, and the cheap question a
 * generate screen asks before a gigabyte moves: is the key already here (AAP 0.5.5)?
 *
 * A Worker never outlives an attempt: while it proves it holds the whole key plus the witness buffers,
 * and no message cancels a run in flight, so terminating it is both how that memory comes back and the
 * only cancellation the web proving path has. A failure leaves as one {@link ZkClientErrorCode}, never
 * as text that could carry a booking confirmation.
 *
 * Everything here is `import type` except `expo-constants`, so the app's bundle carries no snarkjs and
 * no `@noble/hashes`: those load only in the Worker. `prover.web.ts` reuses {@link runWorker} for its
 * `prove` frames, so this one launcher owns that boundary.
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
 * Metro's own bundle of the Worker entry in development — relative to Metro's server root, this pnpm
 * workspace's root, hence the full `apps/mobile/...` path — and the export's `prover.worker.js`,
 * emitted beside the bundle by the `export:worker` step of the app's `export:web` script. The
 * `prover.worker.ts` header records why the Worker is a second Metro entry at all.
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
 * A type argument may be written as the request's own name (`ensure`, `prove`) or as the reply that
 * answers it (`ensured`, `proved`), so a call site reads the way it thinks about the exchange. Either
 * way the request it may pass and the reply it gets back are nailed to that one name: a `prove`
 * request under an `ensured` argument does not compile, which keeps the call sites in
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

/**
 * Runs one request in a fresh proving Worker and answers with its reply (AAP 0.3.4, AAP 0.5.5).
 *
 * The Worker serves this call alone and is terminated before the promise settles, on every path — a
 * reply, a failure, an abort. That is the memory and cancellation contract of the web path, above.
 * Nothing about the request is retained: `postMessage` structured-clones it, so the Worker owns its
 * own copy of a `prove` frame's `inputsJson` and this frame keeps no reference to it.
 *
 * @param request - The request to run; the reply that settles this call is the one carrying its `id`.
 * @param options - A progress reporter, and the signal that aborts the attempt.
 * @throws A `ZkClientError`: `worker_unavailable` when this browser has no `Worker` or the script
 *   fails to load, `cancelled` when `signal` aborted, `worker_failed` when a frame could not be
 *   structured-cloned, and otherwise the code the Worker reported for its own failure.
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

    /** Settles the attempt: the listeners go, and then the Worker and all it holds go with them. */
    const end = (): void => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };

    function onMessage(event: MessageEvent<unknown>): void {
      const frame = frameOf(event.data);
      // One request per Worker, so a frame for another id is ignored rather than allowed to settle
      // an attempt it does not belong to.
      if (frame === null || frame.id !== id) return;

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
    worker.postMessage(request);
  });
}

/* --- The artefact store (AAP 0.5.1, AAP 0.5.5) ----------------------------------------------- */

/** The OPFS directory the Worker keeps both artefacts and their records in, and the Worker's entry
 * names, which is what `location` in its `ensured` reply carries. */
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
 * Whether one stored artefact is the published file and current: its record's digest, size and app
 * version, and the entry's own size. Only `File` metadata is read, because getting a `File` does not
 * load its bytes, so this costs a kilobyte of JSON rather than a gigabyte of key. The modification
 * time is deliberately not consulted: on OPFS Chromium leaves it at the file's creation time, so a
 * same-length edit is invisible to it — which is why the Worker re-hashes by digest before proving.
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
 * `cached` comes from the records and the entries' sizes, so a generate screen can say a proof needs
 * no download and recommend Wi-Fi otherwise, and `downloadBytes` counts only what is missing. Both
 * are advice: the attempt that follows re-verifies by digest and downloads for real. A browser with no
 * OPFS, a directory it cannot read and a record it cannot parse all answer with the whole download,
 * because none of them can show that a download is unnecessary. `connection` is always `unknown`: a
 * browser exposes no dependable way to tell Wi-Fi from cellular, and a guess would drive the warning
 * the traveller reads.
 *
 * @param artifacts - The artefact links of `GET /v1/zk/config`.
 */
export async function plan(artifacts: ZkConfig['artifacts']): Promise<ArtifactPlan> {
  const { wasm, zkey } = artifacts;
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

/**
 * Both artefacts, present and verified in OPFS (AAP 0.5.1, AAP 0.5.5).
 *
 * The streaming, the hashing and every write happen in the Worker, which is what keeps a
 * gigabyte-scale key off the page's main thread; this call owns the attempt — one `ensure` request,
 * its progress reports, and the Worker's termination when it ends. The reply's `location`s are the
 * Worker's own OPFS entry names, which `prover.web.ts` passes straight back in its `prove` frames.
 *
 * @param artifacts - The artefact links of `GET /v1/zk/config`.
 * @param onProgress - Called as bytes arrive, across both artefacts.
 * @param signal - Aborts the download, which terminates the Worker and stops the transfer.
 * @throws A `ZkClientError`: `cancelled`, `artifact_storage_unavailable` on a browser without OPFS,
 *   `worker_unavailable`, and otherwise what the Worker reported — `artifact_download_failed`,
 *   `artifact_insufficient_storage` or `artifact_hash_mismatch`.
 */
export async function ensureArtifacts(
  artifacts: ZkConfig['artifacts'],
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<ResolvedArtifacts> {
  if (signal?.aborted === true) throw fail('cancelled');

  const storage = storageManager();
  if (typeof storage?.getDirectory !== 'function') throw fail('artifact_storage_unavailable');

  // Best effort, and the answer is not read: a granted persistence makes the browser far less likely
  // to evict a gigabyte-scale key under storage pressure, and a refusal costs nothing (AAP 0.5.5).
  // Deliberately not awaited: Firefox settles this promise only once its persistent-storage prompt is
  // answered, so a session that never answers one — an automated browser — would otherwise sit in the
  // download phase forever. Persistence is an optimisation, never a condition of proving.
  try {
    void Promise.resolve(storage.persist?.()).catch(() => undefined);
  } catch {
    // Intentionally ignored: persistence is an optimisation, never a condition of proving.
  }

  // Built field by field rather than spread: `exactOptionalPropertyTypes` makes an explicit
  // `undefined` a different thing from an absent property, and the frame must carry only what the
  // caller supplied.
  const options: RunWorkerOptions = {};
  if (onProgress !== undefined) options.onProgress = onProgress;
  if (signal !== undefined) options.signal = signal;

  const reply = await runWorker<'ensured'>(
    {
      type: 'ensure',
      id: 1,
      artifacts: { wasm: artifacts.wasm, zkey: artifacts.zkey },
      appVersion: appVersion(),
    },
    options,
  );
  return reply.artifacts;
}

/** The artefact store this platform downloads and verifies through (AAP 0.5.5). */
export const artifactStore = { plan, ensureArtifacts } satisfies ArtifactStore;
