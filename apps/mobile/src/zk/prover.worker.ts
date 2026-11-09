/**
 * The web proving Worker: artefact delivery from the origin private file system or the artefacts' published URLs, and
 * snarkjs Groth16 proving, off the main thread (AAP 0.3.4, AAP 0.5.5). One request per message and exactly one reply —
 * `ensured`, `proved`, or a single error code.
 *
 * `ensure` streams the circuit WASM and the proving key into the Origin Private File System, hashing each as it arrives
 * and refusing anything whose size or digest differs from the page's declaration, so a download never holds a whole
 * artefact in memory. Where that file system cannot be used, the request is served from the published URLs instead,
 * because an engine whose origin private file system cannot be used must still prove locally (AAP 0.3.4). An OPFS entry
 * is re-verified by digest first — Chromium never advances a file's modification time on an overwrite — and either source
 * ends in the shapes snarkjs 0.7.6 reads: the WASM whole, in `mem` form, and the key as the 4 MiB page array of a
 * fastfile `bigMem` file. The page terminates this Worker after every attempt or cancellation, which keeps a cancel and a
 * retry from overlapping.
 * It is a Metro entry of its own, because Expo SDK 52's Metro does not bundle
 * `new Worker(new URL('./prover.worker.ts', import.meta.url))`: the file is a second entry point, and
 * `src/zk/artifacts.web.ts` owns its URL. The emitted script touches no `window` and no `document` while loading — nginx
 * serves it under `worker-src 'self' blob:` with `wasm-unsafe-eval` and a `connect-src` that includes the artefact host.
 * The witness inputs arrive as a `postMessage` string, are parsed here, and are never stored, logged or sent back; a
 * failure leaves as a code and nothing else, because a message, stack, URL, file name, artefact byte or input value could
 * carry a piece of a booking confirmation (criterion 3).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
// @ts-expect-error -- snarkjs 0.7.6 ships no type declarations; this file calls only the subset typed below.
import * as snarkjs from 'snarkjs';
import type { ResolvedArtifacts, ResolvedFile, ZkClientErrorCode } from './prover.ts';

/**
 * Where to fetch it, how many bytes it has, and the SHA-256 it must hash to. The page builds this from
 * `GET /v1/zk/config` or from the artefact manifest.
 */
export interface WorkerArtifactRef {
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

export interface EnsureRequest {
  readonly type: 'ensure';
  readonly id: number;
  readonly artifacts: { readonly wasm: WorkerArtifactRef; readonly zkey: WorkerArtifactRef };
  /** A different version invalidates the size and modification-time fast path, so the artefacts are re-hashed once after an app update. */
  readonly appVersion: string;
}

/** The circuit inputs are built and stringified on the page, so the private inputs cross this boundary as one opaque string (AAP 0.5.5). */
export interface ProveRequest {
  readonly type: 'prove';
  readonly id: number;
  readonly inputsJson: string;
  readonly artifacts: ResolvedArtifacts;
  readonly appVersion: string;
}

export type WorkerRequest = EnsureRequest | ProveRequest;
type WorkerPhase = 'download' | 'verify' | 'load' | 'prove';

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

interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
}

interface SyncAccessHandle {
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

type SyncFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
};
const STORAGE_DIRECTORY = 'tablemate-zk';
const WASM_FILE = 'tablemate_itinerary.wasm';
const ZKEY_FILE = 'tablemate_itinerary.zkey';
const META_SUFFIX = '.meta.json';
/** Every page but the last must be exactly this many bytes, because fastfile derives the whole file's size from the last page's length. */
const ZKEY_PAGE_BYTES = 1 << 22;
const READ_CHUNK_BYTES = 1 << 22;
const PROGRESS_STEP_BYTES = 1 << 20;
const STORAGE_HEADROOM_BYTES = 64 << 20;
const SHA256_HEX = /^[0-9a-f]{64}$/;

class WorkerError extends Error {
  readonly code: ZkClientErrorCode;
  constructor(code: ZkClientErrorCode) {
    super(code);
    this.name = 'ZkClientError';
    this.code = code;
    Object.setPrototypeOf(this, WorkerError.prototype);
  }
}

const QUOTA_ERROR_NAMES = ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'];
const STORAGE_ERROR_NAMES = ['SecurityError', 'NotAllowedError', 'InvalidStateError'];

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

/** The code is read off the failure itself, never from the phase's fallback, so an unrelated failure keeps the code it had. */
function isStorageUnavailable(err: unknown): boolean {
  return codeForFailure(err, 'worker_failed') === 'artifact_storage_unavailable';
}

function assertDeclared(ref: Pick<WorkerArtifactRef, 'size' | 'sha256'>): void {
  if (!Number.isSafeInteger(ref.size) || ref.size <= 0 || !SHA256_HEX.test(ref.sha256)) {
    throw new WorkerError('artifact_hash_mismatch');
  }
}

const scope = self as unknown as WorkerScope;
/** Monotonic, so a device clock change cannot distort a proving measurement; `Date.now()` is the fallback (AAP 0.11.1 does not apply to this client code). */
function now(): number {
  const perf = globalThis.performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

/** At most one frame per megabyte, and always the last report of a phase, so a bar that finishes shows finished. */
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

type PhaseReporter = (phase: WorkerPhase, total: number) => (received: number) => void;

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

async function openSync(
  directory: FileSystemDirectoryHandle,
  name: string,
  create = false,
): Promise<SyncAccessHandle> {
  try {
    const handle = (await directory.getFileHandle(name, { create })) as SyncFileHandle;
    if (typeof handle.createSyncAccessHandle !== 'function') {
      throw new WorkerError('artifact_storage_unavailable');
    }
    return await handle.createSyncAccessHandle();
  } catch (err) {
    if (!create && err instanceof DOMException && err.name === 'NotFoundError') {
      throw new WorkerError('artifact_hash_mismatch');
    }
    throw new WorkerError(codeForFailure(err, 'artifact_storage_unavailable'));
  }
}

async function removeEntry(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await directory.removeEntry(name);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') return;
    throw new WorkerError(codeForFailure(err, 'artifact_storage_unavailable'));
  }
}

async function eraseArtifact(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  await removeEntry(directory, name);
  await removeEntry(directory, `${name}${META_SUFFIX}`);
}

/** The digest, size, modification time and app version together are the rule AAP 0.5.5 re-verifies by before every use; any of them changing sends the file back through the re-hash. */
interface StoredMeta {
  readonly sha256: string;
  readonly size: number;
  readonly mtime: number;
  readonly appVersion: string;
}

function isMeta(value: unknown): value is StoredMeta {
  const meta = value as Partial<StoredMeta> | null;
  return (
    typeof meta?.sha256 === 'string' &&
    typeof meta.size === 'number' &&
    typeof meta.mtime === 'number' &&
    typeof meta.appVersion === 'string'
  );
}

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

/** Read in 4 MiB chunks through one reused buffer, so hashing a gigabyte-scale key never allocates the file a second time (AAP 0.5.5). */
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

function writeAll(handle: SyncAccessHandle, chunk: Uint8Array, at: number): number {
  let written = 0;
  while (written < chunk.byteLength) {
    const wrote = handle.write(chunk.subarray(written), { at: at + written });
    if (wrote <= 0) throw new WorkerError('artifact_storage_unavailable');
    written += wrote;
  }
  return written;
}

async function fetchArtifact(url: string): Promise<ReadableStream<Uint8Array>> {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    const body = response.body;
    if (!response.ok || body === null) throw new WorkerError('artifact_download_failed');
    return body;
  } catch (err) {
    throw new WorkerError(codeForFailure(err, 'artifact_download_failed'));
  }
}

/** The artefacts are gigabyte-scale, and a quota failure in the middle of one costs the whole transfer. */
async function assertCapacity(neededBytes: number): Promise<void> {
  const storage: StorageManager | undefined = navigator.storage;
  if (typeof storage?.estimate !== 'function') return;
  const { quota, usage } = await storage.estimate();
  if (typeof quota !== 'number' || typeof usage !== 'number') return;
  if (quota - usage < neededBytes + STORAGE_HEADROOM_BYTES) {
    throw new WorkerError('artifact_insufficient_storage');
  }
}

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
  // Declared out here because the catch below has to release it: a body still being pulled when the
  // transfer fails would keep fetching in this Worker until the page terminates it, and nothing else
  // stops it. It stays null until the body arrives, because the fetch itself can fail first.
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    handle.truncate(0);
    const body = await fetchArtifact(ref.url);
    reader = body.getReader();
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
    // Every failure releases the transfer, as {@link streamArtifact} does, and not only the oversize
    // one: what threw may be a write to storage, the reader's own rejection or the flush. Cancelling
    // a body whose oversize branch already cancelled it is harmless — a closed stream has nothing
    // left to cancel.
    if (reader !== null) await reader.cancel().catch(() => undefined);
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

/** The form `ensure` answers with on an engine whose origin private file system cannot be used, and the form `prove` streams instead of reading from storage. */
function isPublishedUrl(location: string): boolean {
  return /^https?:\/\//i.test(location);
}

const CONTENT_RANGE_TOTAL = /^bytes \d+-\d+\/(\d+)$/;
/**
 * A range of one byte is what makes this cheap: a static file server answers `206` and states the whole
 * file's size in `Content-Range`, while a server that ignores the range answers `200` and states it in
 * `Content-Length`; the body is cancelled the moment the response arrives, so a gigabyte-scale key costs one
 * header round trip. `bytes=0-0` is a single range value in the CORS-safelisted form, so the request adds no
 * preflight to the cross-origin artefacts host. A response this Worker can read no size out of, and one that
 * declares another size than the page published, are both `artifact_download_failed`.
 */
async function confirmPublishedSize(ref: WorkerArtifactRef): Promise<void> {
  let response: Response;
  try {
    response = await fetch(ref.url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
  } catch (err) {
    throw new WorkerError(codeForFailure(err, 'artifact_download_failed'));
  }
  const body = response.body;
  if (body !== null) await body.cancel().catch(() => undefined);
  let declared: string | null;
  if (response.status === 206) {
    declared = CONTENT_RANGE_TOTAL.exec(response.headers.get('content-range') ?? '')?.[1] ?? null;
  } else if (response.ok) {
    declared = response.headers.get('content-length');
  } else {
    declared = null;
  }
  if (declared === null || Number(declared) !== ref.size) {
    throw new WorkerError('artifact_download_failed');
  }
}

/** The URL itself is the location `prove` reads from, because on this engine nothing is kept; the declared digest and size are echoed, so the set a `prove` frame carries says what its read is held to. */
function publishedFile(ref: WorkerArtifactRef): ResolvedFile {
  return { location: ref.url, sha256: ref.sha256, size: ref.size };
}

async function publishedArtifacts(
  wasmRef: WorkerArtifactRef,
  zkeyRef: WorkerArtifactRef,
): Promise<ResolvedArtifacts> {
  await confirmPublishedSize(wasmRef);
  await confirmPublishedSize(zkeyRef);
  return { wasm: publishedFile(wasmRef), zkey: publishedFile(zkeyRef) };
}

async function runEnsure(request: EnsureRequest): Promise<void> {
  const { wasm: wasmRef, zkey: zkeyRef } = request.artifacts;
  assertDeclared(wasmRef);
  assertDeclared(zkeyRef);
  let artifacts: ResolvedArtifacts;
  try {
    artifacts = await opfsArtifacts(request, wasmRef, zkeyRef);
  } catch (err) {
    if (!isStorageUnavailable(err)) throw err;
    artifacts = await publishedArtifacts(wasmRef, zkeyRef);
  }
  scope.postMessage({ type: 'ensured', id: request.id, artifacts });
}

async function opfsArtifacts(
  request: EnsureRequest,
  wasmRef: WorkerArtifactRef,
  zkeyRef: WorkerArtifactRef,
): Promise<ResolvedArtifacts> {
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
  return { zkey, wasm };
}

/** The shape `wtns.calculate` takes for the circuit WASM: it reads the whole buffer to build the witness calculator. */
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

const snark = snarkjs as unknown as SnarkjsSubset;

async function streamArtifact(
  url: string,
  declared: Pick<WorkerArtifactRef, 'size' | 'sha256'>,
  base: number,
  report: (received: number) => void,
  write: (chunk: Uint8Array) => void,
): Promise<void> {
  const body = await fetchArtifact(url);
  const reader = body.getReader();
  const hasher = sha256.create();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.byteLength > declared.size) {
        throw new WorkerError('artifact_download_failed');
      }
      hasher.update(value);
      write(value);
      received += value.byteLength;
      report(base + received);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw new WorkerError(codeForFailure(err, 'artifact_download_failed'));
  }
  if (received !== declared.size || bytesToHex(hasher.digest()) !== declared.sha256) {
    throw new WorkerError('artifact_hash_mismatch');
  }
}

/** A few megabytes, so the whole of it arrives and is copied into its `mem` form as it streams. */
async function streamWhole(
  file: ResolvedFile,
  base: number,
  report: (received: number) => void,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(file.size);
  let offset = 0;
  await streamArtifact(file.location, file, base, report, (chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return bytes;
}

async function streamPages(
  file: ResolvedFile,
  base: number,
  report: (received: number) => void,
): Promise<Uint8Array[]> {
  const pages: Uint8Array[] = [];
  let page: Uint8Array | null = null;
  let filled = 0;
  try {
    await streamArtifact(file.location, file, base, report, (chunk) => {
      let read = 0;
      while (read < chunk.byteLength) {
        if (page === null || filled === page.byteLength) {
          page = new Uint8Array(
            Math.min(ZKEY_PAGE_BYTES, file.size - pages.length * ZKEY_PAGE_BYTES),
          );
          filled = 0;
          pages.push(page);
        }
        const take = Math.min(page.byteLength - filled, chunk.byteLength - read);
        page.set(chunk.subarray(read, read + take), filled);
        filled += take;
        read += take;
      }
    });
  } catch (err) {
    // Whatever was loaded goes back at once: a failed load must not keep a gigabyte of pages alive.
    pages.length = 0;
    throw err;
  }
  return pages;
}

async function verifiedSource(
  file: ResolvedFile,
  appVersion: string,
  reportPhase: PhaseReporter,
  opfsDirectory: () => Promise<FileSystemDirectoryHandle>,
): Promise<ResolvedFile> {
  if (isPublishedUrl(file.location)) return file;
  const verified = await verifyStored(
    await opfsDirectory(),
    file.location,
    file,
    appVersion,
    reportPhase,
    'digest',
  );
  if (verified === null) throw new WorkerError('artifact_hash_mismatch');
  return verified;
}

/**
 * Each artefact is read from the source its own location names: an absolute `http(s)` URL is streamed in one
 * pass and checked as it arrives, and any other location is the OPFS entry name the OPFS source wrote,
 * re-verified by digest before it is read. The directory is opened only for the artefacts that need it, so a
 * proving pass over published URLs never touches storage, and a file that no longer holds up is
 * `artifact_hash_mismatch` — the page's signal to run `ensure` again rather than to prove against something
 * unverified.
 */
async function runProve(request: ProveRequest): Promise<void> {
  const { wasm, zkey } = request.artifacts;
  // The page owns this condition; the guard carries the page's own `artifact_download_failed` code.
  if (wasm === null) throw new WorkerError('artifact_download_failed');
  assertDeclared(wasm);
  assertDeclared(zkey);
  const reportPhase: PhaseReporter = (phase, total) => progressReporter(request.id, phase, total);
  // Opened once, and only when a location names an OPFS entry: the published-URL source reads nothing
  // from storage, so an engine whose file system cannot be used never reaches it.
  let directory: FileSystemDirectoryHandle | null = null;
  const opfsDirectory = async (): Promise<FileSystemDirectoryHandle> => {
    if (directory === null) directory = await storageDirectory();
    return directory;
  };
  const verifiedWasm = await verifiedSource(wasm, request.appVersion, reportPhase, opfsDirectory);
  const verifiedZkey = await verifiedSource(zkey, request.appVersion, reportPhase, opfsDirectory);
  const report = reportPhase('load', verifiedWasm.size + verifiedZkey.size);
  const wasmBytes = isPublishedUrl(verifiedWasm.location)
    ? await streamWhole(verifiedWasm, 0, report)
    : await loadWhole(await opfsDirectory(), verifiedWasm.location, verifiedWasm.size, 0, report);
  const pages = isPublishedUrl(verifiedZkey.location)
    ? await streamPages(verifiedZkey, wasmBytes.byteLength, report)
    : await loadPages(
        await opfsDirectory(),
        verifiedZkey.location,
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

function frameId(value: unknown): number | null {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : null;
}

function isRequestFrame(value: unknown): value is WorkerRequest {
  const type = (value as { type?: unknown } | null)?.type;
  return (type === 'ensure' || type === 'prove') && frameId(value) !== null;
}

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

/** Each request is handled on its own, so one failure answers its own id and leaves the Worker usable for whatever attempt the page starts next. */
scope.addEventListener('message', (event: MessageEvent<unknown>): void => {
  const frame = event.data;
  if (!isRequestFrame(frame)) {
    scope.postMessage({ type: 'error', id: frameId(frame) ?? 0, code: 'worker_failed' });
    return;
  }
  void handleRequest(frame);
});
