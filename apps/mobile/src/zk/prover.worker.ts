/**
 * The web proving Worker: artefact delivery into OPFS, and snarkjs Groth16 proving, off the main
 * thread (AAP 0.3.4, AAP 0.5.5, AAP 0.8.1).
 *
 * One request per message and exactly one reply — `ensured`, `proved`, or a single error code.
 * `ensure` streams the circuit WASM and the proving key into the Origin Private File System, hashing
 * each with `@noble/hashes` as it arrives and refusing anything whose size or digest differs from the
 * page's declaration, so a download never holds a whole artefact in memory. `prove` re-verifies both
 * files by digest — the one check the origin private file system can support, because it never
 * advances a file's modification time — loads them into the shapes snarkjs 0.7.6 reads, builds the
 * witness and proves, and answers with the proof and the two component timings. The page owns this
 * Worker's lifetime and terminates it after every attempt or cancellation, which is what keeps a
 * cancel and a retry from overlapping (AAP 0.5.5).
 *
 * Why this file is a Metro entry of its own. Expo SDK 52's Metro does not bundle
 * `new Worker(new URL('./prover.worker.ts', import.meta.url))`: Worker bundling arrived with SDK 53,
 * and `import.meta` is not transformed in 52. This file is therefore a second entry point, served and
 * built separately from the app, and `src/zk/artifacts.web.ts` owns its URL:
 *
 *  - in development, Metro's own bundle URL for this entry, which in this pnpm monorepo (Metro's
 *    server root is the workspace root) is
 *    `/apps/mobile/src/zk/prover.worker.bundle?platform=web&dev=true&minify=false`;
 *  - in the web export, `/prover.worker.js`, emitted into `apps/mobile/public/` by the `export:worker`
 *    step of the app's own `export:web` script and copied into the export by `expo export`.
 *
 * The emitted file is a classic, self-contained script: it touches no `window` and no `document` while
 * loading, imports no Node built-in and no `Buffer`, and needs WebAssembly plus the artefacts origin —
 * so nginx serves it under `worker-src 'self' blob:`, `script-src 'self' … 'wasm-unsafe-eval'` and a
 * `connect-src` that includes the artefact host (AAP 0.3.2, `infra/nginx/web.conf`).
 *
 * What never leaves. The witness inputs arrive as a `postMessage` string, are parsed here, and are
 * never stored, logged or sent back; this file holds no `console` call at all. A failure leaves as a
 * code from {@link ZkClientErrorCode} and nothing else — no message, stack, URL, file name, artefact
 * byte or input value — because any of those could carry a piece of a booking confirmation
 * (AAP 0.5.5, AAP 0.12.2, success criterion 3).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
// @ts-expect-error -- snarkjs 0.7.6 ships no type declarations; this file calls only the subset typed below.
import * as snarkjs from 'snarkjs';

import type { ResolvedArtifacts, ResolvedFile, ZkClientErrorCode } from './prover.ts';

/* --- The frames ------------------------------------------------------------------------------ */

/**
 * One artefact as the page advertises it: where to fetch it, how many bytes it has, and the SHA-256
 * it must hash to. The page builds this from `GET /v1/zk/config` or from `artifacts.manifest.json`.
 */
export interface WorkerArtifactRef {
  readonly url: string;

  readonly size: number;

  readonly sha256: string;
}

/** Asks for both artefacts to be present, verified and current on disk; answered by `ensured`. */
export interface EnsureRequest {
  readonly type: 'ensure';

  /**
   * Echoed in every reply for this request; the page correlates the two by it. Any safe integer is
   * accepted, 0 included — the page owns the numbering.
   */
  readonly id: number;

  readonly artifacts: { readonly wasm: WorkerArtifactRef; readonly zkey: WorkerArtifactRef };

  /**
   * The app build that verified these files. A different version invalidates the size and
   * modification-time fast path, so the artefacts are re-hashed once after an app update.
   */
  readonly appVersion: string;
}

/**
 * Asks for one witness to be proved; answered by `proved`.
 *
 * `inputsJson` is the circuit input object built on the page and stringified there, so the private
 * inputs cross this boundary as one opaque string and are parsed only here (AAP 0.5.5).
 */
export interface ProveRequest {
  readonly type: 'prove';

  readonly id: number;

  readonly inputsJson: string;

  /** The artefacts `ensure` resolved, whose digests are re-verified before anything is loaded. */
  readonly artifacts: ResolvedArtifacts;

  readonly appVersion: string;
}

/** Either request this Worker accepts. */
export type WorkerRequest = EnsureRequest | ProveRequest;

/** The phases a progress report can name, in the order a first proof passes through them. */
type WorkerPhase = 'download' | 'verify' | 'load' | 'prove';

/**
 * What the Worker answers, exactly one frame per request besides progress reports.
 *
 * `code` is a `snake_case` code the page maps to a sentence, never free text. `proof` and
 * `publicSignals` stay `unknown` because the page validates them with `ProofSubmission` before
 * submitting, which is what turns a malformed result into `proof_output_invalid` rather than a proof
 * the API refuses.
 */
export type WorkerResponse =
  | {
      readonly type: 'progress';
      readonly id: number;
      readonly phase: WorkerPhase;
      readonly receivedBytes: number;
      readonly totalBytes: number;
    }
  | { readonly type: 'ensured'; readonly id: number; readonly artifacts: ResolvedArtifacts }
  | {
      readonly type: 'proved';
      readonly id: number;
      readonly proof: unknown;
      readonly publicSignals: unknown;
      readonly witnessMs: number;
      readonly proveMs: number;
    }
  | { readonly type: 'error'; readonly id: number; readonly code: string };

/* --- The Worker scope and the OPFS surface --------------------------------------------------- */

/**
 * The part of the global Worker scope this file uses, declared locally: the app's TypeScript
 * programme carries the DOM libraries and deliberately not `WebWorker`, because the two cannot
 * coexist, and only this file needs the worker half.
 */
interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
}

/**
 * A synchronous OPFS access handle. `FileSystemFileHandle.createSyncAccessHandle()` is part of the
 * origin private file system and is available inside a Worker only; like the rest of this surface it
 * is declared here rather than taken from a library.
 */
interface SyncAccessHandle {
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

/** A file handle that can be opened for synchronous access. */
type SyncFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
};

/* --- Constants ------------------------------------------------------------------------------- */

/** The OPFS directory holding both artefacts and their metadata, created on first use. */
const STORAGE_DIRECTORY = 'tablemate-zk';

/**
 * The OPFS entry names. They are this Worker's own local names, not the artefact file names: the
 * digest is what identifies an artefact, so a file is only ever read after its bytes were shown to
 * hash to the declaration, and `location` in the reply is this name.
 */
const WASM_FILE = 'tablemate_itinerary.wasm';
const ZKEY_FILE = 'tablemate_itinerary.zkey';
const META_SUFFIX = '.meta.json';

/**
 * One `bigMem` page: fastfile 0.0.20's own `1 << 22`. Every page but the last must be exactly this
 * many bytes, because fastfile derives the whole file's size from the last page's length.
 */
const ZKEY_PAGE_BYTES = 1 << 22;

/** Bytes read or hashed per step while verifying and loading, so no pass allocates a whole artefact. */
const READ_CHUNK_BYTES = 1 << 22;

/** The smallest movement a progress frame is posted for. */
const PROGRESS_STEP_BYTES = 1 << 20;

/** Free space kept beyond what the artefacts need, so a full origin cannot fail mid-proof. */
const STORAGE_HEADROOM_BYTES = 64 << 20;

/** The form the manifest publishes a digest in, and the only form this Worker compares against. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/* --- Failures, and the one code that leaves --------------------------------------------------- */

/** A failure this file raises on purpose, carrying the code the page turns into a sentence. */
class WorkerError extends Error {
  readonly code: ZkClientErrorCode;

  constructor(code: ZkClientErrorCode) {
    super(code);
    this.name = 'ZkClientError';
    this.code = code;
    // Metro transpiles classes with Babel, which does not preserve the prototype chain of a built-in
    // subclass; restoring it keeps `instanceof WorkerError` true in the running Worker.
    Object.setPrototypeOf(this, WorkerError.prototype);
  }
}

/** `DOMException` names that mean the origin's storage is full: Chrome and Firefox spell it apart. */
const QUOTA_ERROR_NAMES = ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'];

/** `DOMException` names that mean OPFS itself is unusable, as in Firefox private browsing. */
const STORAGE_ERROR_NAMES = ['SecurityError', 'NotAllowedError', 'InvalidStateError'];

/**
 * The code a failure maps to. A {@link WorkerError} keeps its own; a full origin, an unusable OPFS, an
 * aborted or failed fetch and an allocation failure each map to theirs; anything else takes the
 * caller's fallback, which is the code of the phase that failed.
 *
 * Only the code is read from the error — never its message, which can carry a URL or a file name.
 */
function codeForFailure(err: unknown, fallback: ZkClientErrorCode): ZkClientErrorCode {
  if (err instanceof WorkerError) return err.code;
  if (err instanceof DOMException) {
    if (QUOTA_ERROR_NAMES.includes(err.name)) return 'artifact_insufficient_storage';
    if (STORAGE_ERROR_NAMES.includes(err.name)) return 'artifact_storage_unavailable';
    if (err.name === 'AbortError') return 'artifact_download_failed';
  }
  if (err instanceof RangeError) return 'out_of_memory';
  return fallback;
}

/**
 * Refuses a declaration this Worker could never confirm: a size that is not a positive integer or a
 * digest that is not a lowercase SHA-256. Such a declaration would send the re-hash path after a file
 * that cannot match it and delete a good cached artefact, so it is rejected before anything is read.
 */
function assertDeclared(ref: Pick<WorkerArtifactRef, 'size' | 'sha256'>): void {
  if (!Number.isSafeInteger(ref.size) || ref.size <= 0 || !SHA256_HEX.test(ref.sha256)) {
    throw new WorkerError('artifact_hash_mismatch');
  }
}

/* --- The Worker scope, progress and the clock ------------------------------------------------- */

const scope = self as unknown as WorkerScope;

/**
 * A monotonic clock, so a device clock change cannot distort a proving measurement; `Date.now()` is
 * the fallback for an engine without `performance.now`. This is client code, so the server's
 * injected-clock rule (AAP 0.11.1) does not apply.
 */
function now(): number {
  const perf = globalThis.performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

/**
 * Posts progress at most once per megabyte, and always the last report of a phase, so a bar that
 * finishes shows finished. A `total` of 0 means the size is unknown, which only the `prove` phase
 * uses: how long a proof takes cannot be read off a byte count.
 */
function progressReporter(
  id: number,
  phase: WorkerPhase,
  total: number,
): (received: number) => void {
  let posted = 0;
  return (received: number): void => {
    if (received < total && received - posted < PROGRESS_STEP_BYTES) return;
    posted = received;
    scope.postMessage({ type: 'progress', id, phase, receivedBytes: received, totalBytes: total });
  };
}

/** Makes one reporter per artefact, so the verify and load phases can report against their own size. */
type PhaseReporter = (phase: WorkerPhase, total: number) => (received: number) => void;

/* --- OPFS ------------------------------------------------------------------------------------ */

/**
 * The OPFS directory holding both artefacts and their metadata, created on first use. A browser
 * without OPFS, or one that refuses it (Firefox private browsing, a sandboxed frame), is
 * `artifact_storage_unavailable` rather than a crash, and the page then reports the web client as
 * unable to prove on this browser.
 */
async function storageDirectory(): Promise<FileSystemDirectoryHandle> {
  const storage: StorageManager | undefined = navigator.storage;
  if (typeof storage?.getDirectory !== 'function')
    throw new WorkerError('artifact_storage_unavailable');
  try {
    const root = await storage.getDirectory();
    return await root.getDirectoryHandle(STORAGE_DIRECTORY, { create: true });
  } catch (err) {
    throw new WorkerError(codeForFailure(err, 'artifact_storage_unavailable'));
  }
}

/** The handle for `name`, or null when the directory holds no such entry. */
async function existingHandle(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | null> {
  try {
    return await directory.getFileHandle(name);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') return null;
    throw new WorkerError(codeForFailure(err, 'artifact_storage_unavailable'));
  }
}

/** Opens an OPFS entry for synchronous access, creating it when `create` is set. */
async function openSync(
  directory: FileSystemDirectoryHandle,
  name: string,
  create = false,
): Promise<SyncAccessHandle> {
  try {
    // The synchronous handle this file needs is the OPFS addition to the interface, so the widening
    // to `SyncFileHandle` is a cast rather than an assignable subtype.
    const handle = (await directory.getFileHandle(name, { create })) as SyncFileHandle;
    if (typeof handle.createSyncAccessHandle !== 'function') {
      throw new WorkerError('artifact_storage_unavailable');
    }
    return await handle.createSyncAccessHandle();
  } catch (err) {
    // The reading paths only ever open a file they found a moment earlier, so a file that has gone
    // is the same failure as a digest that does not match: nothing verified can be loaded.
    if (!create && err instanceof DOMException && err.name === 'NotFoundError') {
      throw new WorkerError('artifact_hash_mismatch');
    }
    throw new WorkerError(codeForFailure(err, 'artifact_storage_unavailable'));
  }
}

/** Removes one entry, tolerating its absence: cleanup must never be the failure of an attempt. */
async function removeEntry(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await directory.removeEntry(name);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') return;
    throw new WorkerError(codeForFailure(err, 'artifact_storage_unavailable'));
  }
}

/** Removes an artefact and the metadata that vouched for it. */
async function eraseArtifact(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  await removeEntry(directory, name);
  await removeEntry(directory, `${name}${META_SUFFIX}`);
}

/* --- Metadata -------------------------------------------------------------------------------- */

/**
 * What a stored file's metadata records. It exists so an unchanged artefact is never hashed again: the
 * digest, size, modification time and app version together are the rule AAP 0.5.5 re-verifies by
 * before every use, and any of them changing sends the file back through the re-hash.
 */
interface StoredMeta {
  readonly sha256: string;
  readonly size: number;
  readonly mtime: number;
  readonly appVersion: string;
}

/** True for a well-formed metadata record; anything else is ignored and the file is re-hashed. */
function isMeta(value: unknown): value is StoredMeta {
  const meta = value as Partial<StoredMeta> | null;
  return (
    typeof meta?.sha256 === 'string' &&
    typeof meta.size === 'number' &&
    typeof meta.mtime === 'number' &&
    typeof meta.appVersion === 'string'
  );
}

/** The metadata for `name`, or null when it is absent or unreadable, which forces a re-hash. */
async function readMeta(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<StoredMeta | null> {
  const handle = await existingHandle(directory, `${name}${META_SUFFIX}`);
  if (handle === null) return null;
  try {
    const parsed: unknown = JSON.parse(await (await handle.getFile()).text());
    return isMeta(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Writes the metadata for a verified `name`, so the next session can skip the hash. */
async function writeMeta(
  directory: FileSystemDirectoryHandle,
  name: string,
  stored: Pick<StoredMeta, 'sha256' | 'size' | 'mtime'>,
  appVersion: string,
): Promise<void> {
  const meta: StoredMeta = { ...stored, appVersion };
  const handle = await directory.getFileHandle(`${name}${META_SUFFIX}`, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(meta));
  await writable.close();
}

/* --- Verification and download --------------------------------------------------------------- */

/**
 * The SHA-256 of a stored file, read in 4 MiB chunks through one reused buffer, so hashing a
 * gigabyte-scale key never allocates the file a second time (AAP 0.5.5).
 */
async function hashStored(
  directory: FileSystemDirectoryHandle,
  name: string,
  size: number,
  report: (received: number) => void,
): Promise<string> {
  const handle = await openSync(directory, name);
  const hasher = sha256.create();
  const buffer = new Uint8Array(READ_CHUNK_BYTES);
  try {
    let read = 0;
    while (read < size) {
      const want = Math.min(buffer.byteLength, size - read);
      const got = handle.read(buffer.subarray(0, want), { at: read });
      if (got <= 0) break;
      hasher.update(buffer.subarray(0, got));
      read += got;
      report(read);
    }
  } finally {
    handle.close();
  }
  return bytesToHex(hasher.digest());
}

/**
 * The artefact that is already on disk, verified and current, or null when it must be downloaded.
 *
 * `mode` decides how much of the check is done. `'metadata'` accepts the artefact on the recorded
 * metadata — the declared digest and size, the file's own size and modification time and the app
 * version — and re-hashes only when one of them changed: that is the download question `ensure`
 * asks, and answering it by hashing a gigabyte every time would cost more than the download saves.
 * `'digest'` always re-hashes, and is what `prove` asks for, because on the origin private file
 * system the modification time cannot be the whole rule: Chromium leaves `lastModified` at the
 * file's creation time through both a writable-stream overwrite and a Worker's synchronous write
 * (measured, not assumed), so a file edited to the same length under the same app version is
 * indistinguishable from an untouched one by metadata alone. Only the digest shows that the bytes
 * about to be loaded are the bytes that were verified, and an artefact that fails it is deleted —
 * file and record — so the next step is a download rather than a proof (AAP 0.5.5).
 */
async function verifyStored(
  directory: FileSystemDirectoryHandle,
  name: string,
  ref: Pick<WorkerArtifactRef, 'size' | 'sha256'>,
  appVersion: string,
  reportPhase: PhaseReporter,
  mode: 'metadata' | 'digest',
): Promise<ResolvedFile | null> {
  const handle = await existingHandle(directory, name);
  if (handle === null) return null;
  const file = await handle.getFile();
  const meta = await readMeta(directory, name);
  const current =
    mode === 'metadata' &&
    meta !== null &&
    file.size === ref.size &&
    meta.sha256 === ref.sha256 &&
    meta.size === ref.size &&
    meta.mtime === file.lastModified &&
    meta.appVersion === appVersion;
  if (current) return { location: name, sha256: ref.sha256, size: ref.size };

  // A file of the wrong length can never hash to the declared digest, so the re-hash is skipped for
  // it; anything else is read in full before it is trusted again.
  const digest =
    file.size === ref.size
      ? await hashStored(directory, name, file.size, reportPhase('verify', ref.size))
      : '';
  if (digest !== ref.sha256) {
    await eraseArtifact(directory, name);
    return null;
  }
  await writeMeta(
    directory,
    name,
    { sha256: ref.sha256, size: ref.size, mtime: file.lastModified },
    appVersion,
  );
  return { location: name, sha256: ref.sha256, size: ref.size };
}

/** Writes every byte of `chunk` at `at`, and says how many were written: a sync handle may write less. */
function writeAll(handle: SyncAccessHandle, chunk: Uint8Array, at: number): number {
  let written = 0;
  while (written < chunk.byteLength) {
    const wrote = handle.write(chunk.subarray(written), { at: at + written });
    if (wrote <= 0) throw new WorkerError('artifact_storage_unavailable');
    written += wrote;
  }
  return written;
}

/**
 * Fetches one artefact, without the HTTP cache, and returns its streamed body.
 *
 * A streamed body is the point of this phase: a browser that cannot stream would have to hold the
 * whole proving key in memory, which is the risk AAP 0.3.4 names, so an unusable response is a
 * download failure rather than a fallback to buffering.
 */
async function fetchArtifact(url: string): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(url, { cache: 'no-store' });
  const body = response.body;
  if (!response.ok || body === null) throw new WorkerError('artifact_download_failed');
  return body;
}

/**
 * Refuses a download the origin cannot hold, before a byte of it is fetched: the artefacts are
 * gigabyte-scale, and a quota failure in the middle of one costs the whole transfer.
 */
async function assertCapacity(neededBytes: number): Promise<void> {
  const storage: StorageManager | undefined = navigator.storage;
  if (typeof storage?.estimate !== 'function') return;
  const { quota, usage } = await storage.estimate();
  if (typeof quota !== 'number' || typeof usage !== 'number') return;
  if (quota - usage < neededBytes + STORAGE_HEADROOM_BYTES) {
    throw new WorkerError('artifact_insufficient_storage');
  }
}

/**
 * Streams one artefact into OPFS, hashing as it arrives, and reports it only once both the declared
 * size and the declared digest match. `base` is what earlier artefacts of this transfer already
 * fetched, so the download phase reports one bar for the pair.
 *
 * There is no resume, and a failed attempt deletes what it wrote: the incremental hash state lives in
 * this call's memory and cannot be persisted, so an interrupted download restarts from zero — and
 * restarting from a fragment would mean re-hashing it only to throw it away.
 */
async function download(
  directory: FileSystemDirectoryHandle,
  name: string,
  ref: WorkerArtifactRef,
  appVersion: string,
  base: number,
  report: (received: number) => void,
): Promise<ResolvedFile> {
  // A record left by an earlier attempt must not vouch for the bytes this one is about to write.
  await removeEntry(directory, `${name}${META_SUFFIX}`);
  await assertCapacity(ref.size);

  const handle = await openSync(directory, name, true);
  const hasher = sha256.create();
  let offset = 0;
  let failure: unknown;
  try {
    handle.truncate(0);
    const body = await fetchArtifact(ref.url);
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > ref.size) {
        // The answer is not the artefact that was declared, so nothing about it can be verified.
        await reader.cancel().catch(() => undefined);
        throw new WorkerError('artifact_download_failed');
      }
      hasher.update(value);
      offset += writeAll(handle, value, offset);
      report(base + offset);
    }
    handle.flush();
  } catch (err) {
    failure = err;
  } finally {
    handle.close();
  }

  if (failure !== undefined) {
    await eraseArtifact(directory, name);
    throw new WorkerError(codeForFailure(failure, 'artifact_download_failed'));
  }
  if (offset !== ref.size || bytesToHex(hasher.digest()) !== ref.sha256) {
    await eraseArtifact(directory, name);
    throw new WorkerError('artifact_hash_mismatch');
  }

  const stored = await existingHandle(directory, name);
  const mtime = stored === null ? 0 : (await stored.getFile()).lastModified;
  await writeMeta(directory, name, { sha256: ref.sha256, size: ref.size, mtime }, appVersion);
  return { location: name, sha256: ref.sha256, size: ref.size };
}

/** The artefact that is already verified, or the one this call downloads and verifies. */
async function ensureOne(
  directory: FileSystemDirectoryHandle,
  name: string,
  ref: WorkerArtifactRef,
  appVersion: string,
  base: number,
  report: (received: number) => void,
  reportPhase: PhaseReporter,
): Promise<ResolvedFile> {
  const stored = await verifyStored(directory, name, ref, appVersion, reportPhase, 'metadata');
  return stored ?? (await download(directory, name, ref, appVersion, base, report));
}

/** `ensure`: both artefacts present and verified on disk, the WASM first because it is the smaller. */
async function runEnsure(request: EnsureRequest): Promise<void> {
  const { wasm: wasmRef, zkey: zkeyRef } = request.artifacts;
  assertDeclared(wasmRef);
  assertDeclared(zkeyRef);

  const directory = await storageDirectory();
  const reportPhase: PhaseReporter = (phase, total) => progressReporter(request.id, phase, total);
  const report = reportPhase('download', wasmRef.size + zkeyRef.size);
  const wasm = await ensureOne(
    directory,
    WASM_FILE,
    wasmRef,
    request.appVersion,
    0,
    report,
    reportPhase,
  );
  const zkey = await ensureOne(
    directory,
    ZKEY_FILE,
    zkeyRef,
    request.appVersion,
    wasmRef.size,
    report,
    reportPhase,
  );
  scope.postMessage({ type: 'ensured', id: request.id, artifacts: { zkey, wasm } });
}

/* --- Loading and proving ---------------------------------------------------------------------- */

/**
 * Reads a small artefact into one buffer, in `mem` form, which is the shape `wtns.calculate` takes for
 * the circuit WASM: it reads the whole buffer to build the witness calculator.
 */
async function loadWhole(
  directory: FileSystemDirectoryHandle,
  name: string,
  size: number,
  base: number,
  report: (received: number) => void,
): Promise<Uint8Array> {
  const handle = await openSync(directory, name);
  const bytes = new Uint8Array(size);
  try {
    let read = 0;
    while (read < size) {
      const got = handle.read(bytes.subarray(read), { at: read });
      if (got <= 0) throw new WorkerError('artifact_hash_mismatch');
      read += got;
      report(base + read);
    }
    return bytes;
  } finally {
    handle.close();
  }
}

/**
 * Reads the proving key into the page array of a fastfile `bigMem` file, one page at a time.
 *
 * Two invariants hold here. The page size is fastfile 0.0.20's own `1 << 22` and every page but the
 * last is exactly that many bytes, because `bigMem` derives the file's total size from the last
 * page's length. And the whole key is resident in this Worker while it proves, and nowhere else: the
 * page's main thread never holds it, which is the memory contract of AAP 0.3.4 and AAP 0.5.5.
 */
async function loadPages(
  directory: FileSystemDirectoryHandle,
  name: string,
  size: number,
  base: number,
  report: (received: number) => void,
): Promise<Uint8Array[]> {
  const handle = await openSync(directory, name);
  const pages: Uint8Array[] = [];
  try {
    for (let offset = 0; offset < size; offset += ZKEY_PAGE_BYTES) {
      const page = new Uint8Array(Math.min(ZKEY_PAGE_BYTES, size - offset));
      let read = 0;
      while (read < page.byteLength) {
        const got = handle.read(page.subarray(read), { at: offset + read });
        if (got <= 0) throw new WorkerError('artifact_hash_mismatch');
        read += got;
      }
      pages.push(page);
      report(base + offset + page.byteLength);
    }
    return pages;
  } catch (err) {
    // Whatever was loaded goes back at once: a failed load must not keep a gigabyte of pages alive.
    pages.length = 0;
    throw err;
  } finally {
    handle.close();
  }
}

/**
 * The two calls snarkjs 0.7.6 makes, typed locally because the package ships no declarations. This is
 * exactly what `groth16.fullProve` does — `wtns.calculate(input, wasm, { type: 'mem' })` and then
 * `groth16.prove(zkey, wtns, logger, options)` — split only so the two component timings can be
 * reported separately. `singleThread: true` is what keeps the ffjavascript curve in this process:
 * without it the engine spawns a nested Worker per hardware thread and copies the proving key into
 * each, which is the peak-memory risk the web path carries (AAP 0.3.4).
 */
interface SnarkjsSubset {
  readonly wtns: {
    calculate(
      input: unknown,
      wasm: unknown,
      out: { type: 'mem'; data?: Uint8Array },
      options?: unknown,
    ): Promise<void>;
  };
  readonly groth16: {
    prove(
      zkey: unknown,
      wtns: unknown,
      logger?: unknown,
      options?: { readonly singleThread?: boolean },
    ): Promise<{ proof: unknown; publicSignals: unknown }>;
  };
}

/** snarkjs, narrowed to {@link SnarkjsSubset}. The import itself carries no declarations. */
const snark = snarkjs as unknown as SnarkjsSubset;

/**
 * `prove`: re-verify both artefacts by digest, load them, build the witness, prove, and answer with
 * the proof and the component timings.
 *
 * The digest is what stands in for the other platforms' size, modification-time and app-version rule
 * here, and the reason is recorded on {@link verifyStored}: OPFS metadata cannot show a same-length
 * edit. A file that no longer holds up is `artifact_hash_mismatch`, which is the page's signal to run
 * `ensure` again rather than to prove against something unverified.
 */
async function runProve(request: ProveRequest): Promise<void> {
  const { wasm, zkey } = request.artifacts;
  if (wasm === null) throw new WorkerError('artifact_hash_mismatch');
  assertDeclared(wasm);
  assertDeclared(zkey);

  const directory = await storageDirectory();
  const reportPhase: PhaseReporter = (phase, total) => progressReporter(request.id, phase, total);
  const verifiedWasm = await verifyStored(
    directory,
    WASM_FILE,
    wasm,
    request.appVersion,
    reportPhase,
    'digest',
  );
  const verifiedZkey = await verifyStored(
    directory,
    ZKEY_FILE,
    zkey,
    request.appVersion,
    reportPhase,
    'digest',
  );
  if (verifiedWasm === null || verifiedZkey === null) {
    throw new WorkerError('artifact_hash_mismatch');
  }

  const report = reportPhase('load', verifiedWasm.size + verifiedZkey.size);
  const wasmBytes = await loadWhole(directory, WASM_FILE, verifiedWasm.size, 0, report);
  const pages = await loadPages(
    directory,
    ZKEY_FILE,
    verifiedZkey.size,
    wasmBytes.byteLength,
    report,
  );

  // Proving has no byte count to report against, so the phase frame carries a 0 total: the page shows
  // the step, not a made-up percentage.
  const id = request.id;
  scope.postMessage({ type: 'progress', id, phase: 'prove', receivedBytes: 0, totalBytes: 0 });

  const input: unknown = JSON.parse(request.inputsJson);
  const witness: { type: 'mem'; data?: Uint8Array } = { type: 'mem' };
  const wasmFile: { type: 'mem'; data?: Uint8Array } = { type: 'mem', data: wasmBytes };

  const witnessStartedAt = now();
  await snark.wtns.calculate(input, wasmFile, witness, undefined);
  const witnessMs = now() - witnessStartedAt;

  const proveStartedAt = now();
  const proved = await snark.groth16.prove({ type: 'bigMem', data: pages }, witness, undefined, {
    singleThread: true,
  });
  const proveMs = now() - proveStartedAt;

  scope.postMessage({
    type: 'proved',
    id,
    proof: proved.proof,
    publicSignals: proved.publicSignals,
    witnessMs,
    proveMs,
  });

  // The reply is out, so the key, the witness and the witness buffer are dropped before this call
  // returns. The page terminates the Worker after every attempt regardless.
  pages.length = 0;
  delete witness.data;
  delete wasmFile.data;
}

/* --- The message loop -------------------------------------------------------------------------- */

/** The id a frame carries, or null when it carries none: a reply is addressed to the id the page sent. */
function frameId(value: unknown): number | null {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : null;
}

/** True for a frame this Worker accepts: one of its two request types, carrying an id. */
function isRequestFrame(value: unknown): value is WorkerRequest {
  const type = (value as { type?: unknown } | null)?.type;
  return (type === 'ensure' || type === 'prove') && frameId(value) !== null;
}

/** Runs one request and posts exactly one reply; progress frames are the only other message sent. */
async function handleRequest(request: WorkerRequest): Promise<void> {
  const { id } = request;
  try {
    switch (request.type) {
      case 'ensure':
        await runEnsure(request);
        return;
      case 'prove':
        await runProve(request);
        return;
      default:
        throw new WorkerError('worker_failed');
    }
  } catch (err) {
    // A code and nothing else: an error's text can carry a URL, a file name or a byte of the email.
    scope.postMessage({ type: 'error', id, code: codeForFailure(err, 'worker_failed') });
  }
}

/**
 * The single entry point of this Worker. Each request is handled on its own, so one failure answers
 * its own id and leaves the Worker usable for whatever attempt the page starts next.
 */
scope.addEventListener('message', (event: MessageEvent<unknown>): void => {
  const frame = event.data;
  if (!isRequestFrame(frame)) {
    scope.postMessage({ type: 'error', id: frameId(frame) ?? 0, code: 'worker_failed' });
    return;
  }
  void handleRequest(frame);
});
