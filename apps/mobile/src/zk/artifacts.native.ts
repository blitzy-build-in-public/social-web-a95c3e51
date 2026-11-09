/**
 * Proving-key delivery on iOS and Android: one resumable, hash-verified download (AAP 0.5.1, AAP 0.5.5). Only
 * the proving key is fetched — `tablemate-prover` compiles the witness generator into the app, so
 * `ResolvedArtifacts.wasm` is null (AAP 0.3.4).
 *
 * A key is proved against only after it has been checked: the downloading session compares its digest and size
 * with `artifacts.manifest.json`, every later session compares the stored size and modification time, and either
 * check is redone whenever the file changed or the app version did, because an update can replace the circuit
 * without touching the key file. A download of this size is expected to be interrupted, so the platform's resume
 * token is persisted whenever a transfer pauses, and a token written for another artefact is discarded with the
 * partial file it describes. Nothing here logs a URL, a path or a byte of the key: a failure is one
 * `ZkClientErrorCode` (AAP 0.5.5).
 */
import NetInfo from '@react-native-community/netinfo';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system';
import { AppState, type AppStateStatus } from 'react-native';

import type { ZkConfig } from '@tablemate/shared';

import { sha256File } from '../../modules/tablemate-prover';

import type {
  ArtifactPlan,
  ArtifactStore,
  DownloadProgress,
  ResolvedArtifacts,
  ZkClientErrorCode,
} from './prover.ts';

/** One downloadable artefact, as `artifacts.manifest.json` and `GET /v1/zk/config` publish it. */
type ZkeyLink = ZkConfig['artifacts']['zkey'];

const ZK_DIRECTORY = 'zk';
const ZKEY_NAME = 'tablemate_itinerary.zkey';
const DOWNLOAD_SUFFIX = '.download';
const META_SUFFIX = '.meta.json';
const RESUME_NAME = 'download-state.json';

const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

const DOWNLOAD_ATTEMPTS = 2;

const SHA256_HEX = /^[0-9a-f]{64}$/;

const CONNECTIONS: Record<string, ArtifactPlan['connection']> = {
  wifi: 'wifi',
  cellular: 'cellular',
  ethernet: 'other',
  bluetooth: 'other',
  wimax: 'other',
  vpn: 'other',
  other: 'other',
  none: 'unknown',
  unknown: 'unknown',
};

/**
 * `name` is what `prover.ts`'s `errorCodeOf` reads and `message` is the code alone, so no URL, path or key
 * byte can travel out of a download.
 */
function fail(code: ZkClientErrorCode): Error {
  return Object.assign(new Error(code), { name: 'ZkClientError', code });
}

/** The `code` of a rejection as the platform raises it, or null for anything else. */
function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : null;
}

interface Locations {
  readonly zkey: string;
  readonly download: string;
  readonly meta: string;
  readonly resume: string;
}

/**
 * Read from `expo-file-system` on every call rather than at module load, so a running build answers with the
 * directory it has and a test's mock applies; a platform that gives the app no writable documents directory is
 * `artifact_storage_unavailable`. The document directory is the location AAP 0.5.5 names — on iOS it is also the
 * directory iCloud backs up, and `expo-file-system` offers no way to exclude a single file from that backup.
 */
async function locations(): Promise<Locations> {
  const root = FileSystem.documentDirectory;
  if (root === null) throw fail('artifact_storage_unavailable');
  const directory = `${root.endsWith('/') ? root : `${root}/`}${ZK_DIRECTORY}/`;
  try {
    // `intermediates` is what makes an already-existing directory a no-op on both platforms.
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  } catch {
    throw fail('artifact_storage_unavailable');
  }
  const zkey = `${directory}${ZKEY_NAME}`;
  return {
    zkey,
    download: `${zkey}${DOWNLOAD_SUFFIX}`,
    meta: `${zkey}${META_SUFFIX}`,
    resume: `${directory}${RESUME_NAME}`,
  };
}

/**
 * An update is the one change that can replace the circuit without touching the key file, so the version a
 * key was verified under is part of what a later session checks (AAP 0.5.5).
 */
function appVersion(): string {
  return Constants.expoConfig?.version ?? 'unknown';
}

/** What is known about a key once its digest has been checked. */
interface ZkeyMeta {
  readonly sha256: string;
  readonly size: number;
  readonly mtime: number;
  readonly appVersion: string;
}

/** A file's size and modification time. */
interface FileFacts {
  readonly size: number;
  readonly mtime: number;
}

/** A file's facts, or null when it is absent or its store cannot be read. */
async function fileFacts(uri: string): Promise<FileFacts | null> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists ? { size: info.size, mtime: info.modificationTime } : null;
  } catch {
    // A store that cannot be read holds nothing this app may treat as verified.
    return null;
  }
}

/** Deletes a path this app owns, swallowing a failure: cleanup is never an attempt's outcome. */
async function removeQuietly(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Intentionally ignored: a storage error must not replace the failure being handled.
  }
}

/**
 * Every record here is written by this file alone, so a shape it does not recognise is treated as no record
 * at all and the artefact beside it is verified from the file itself.
 */
async function readJson(uri: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await FileSystem.readAsStringAsync(uri);
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** The record beside the key, or null when there is none or it cannot be read or trusted. */
async function readMeta(metaUri: string): Promise<ZkeyMeta | null> {
  const parsed = await readJson(metaUri);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { sha256, size, mtime, appVersion: version } = parsed as Record<string, unknown>;
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return null;
  if (typeof size !== 'number' || typeof mtime !== 'number' || !Number.isFinite(mtime)) return null;
  if (typeof version !== 'string') return null;
  return { sha256, size, mtime, appVersion: version };
}

/**
 * The digest, the size the record was written for, the file's modification time and the app version that
 * checked it (AAP 0.5.5).
 */
function isCurrent(meta: ZkeyMeta | null, facts: FileFacts, zkey: ZkeyLink): boolean {
  return (
    meta !== null &&
    meta.sha256 === zkey.sha256 &&
    meta.size === facts.size &&
    meta.mtime === facts.mtime &&
    meta.appVersion === appVersion()
  );
}

/** Writes the record beside a key whose digest has just been checked. */
async function record(paths: Locations, zkey: ZkeyLink, mtime: number): Promise<void> {
  const meta: ZkeyMeta = { sha256: zkey.sha256, size: zkey.size, mtime, appVersion: appVersion() };
  try {
    await FileSystem.writeAsStringAsync(paths.meta, JSON.stringify(meta));
  } catch {
    // The record saves the next session one hash and nothing else, so a refused write costs speed.
  }
}

/** The verified artefacts of one attempt: native proves without a circuit WASM (AAP 0.3.4). */
function resolved(zkeyUri: string, zkey: ZkeyLink): ResolvedArtifacts {
  return { zkey: { location: zkeyUri, sha256: zkey.sha256, size: zkey.size }, wasm: null };
}

/**
 * `null` when the file has gone by the time the hasher opens it — the one failure that says "no such file"
 * rather than "this store cannot be read".
 */
async function digestOf(uri: string): Promise<string | null> {
  try {
    return await sha256File(uri);
  } catch (error: unknown) {
    if (errorCodeOf(error) === 'file_missing') return null;
    throw error;
  }
}

/**
 * The record beside the key answers the common case without opening the file: a digest, size, modification time
 * and app version that all match what was verified mean the same bytes are still there. Every other case re-hashes
 * the key, and a key that does not match the manifest is deleted, so a later session cannot take a file this one
 * refused for a verified key. A build with no native hasher throws `prover_unavailable`, so the caller reports
 * proving as unavailable instead of fetching a key it could never check (AAP 0.5.5).
 */
async function verifyExisting(zkey: ZkeyLink, paths: Locations): Promise<ResolvedArtifacts | null> {
  const facts = await fileFacts(paths.zkey);
  if (facts === null) return null;
  if (facts.size !== zkey.size) {
    // Another build's key, or a truncated one: nothing it holds can be used.
    await removeQuietly(paths.zkey);
    await removeQuietly(paths.meta);
    return null;
  }
  if (isCurrent(await readMeta(paths.meta), facts, zkey)) return resolved(paths.zkey, zkey);
  if ((await digestOf(paths.zkey)) === zkey.sha256) {
    await record(paths, zkey, facts.mtime);
    return resolved(paths.zkey, zkey);
  }
  await removeQuietly(paths.zkey);
  await removeQuietly(paths.meta);
  return null;
}

/** Where a transfer stopped, so the next attempt continues instead of starting over. */
interface ResumeState {
  readonly url: string;
  readonly sha256: string;
  readonly resumeData: string;
}

/** Whether a resume token belongs to this artefact: one URL, one digest. */
function describes(state: ResumeState, zkey: ZkeyLink): boolean {
  return state.url === zkey.url && state.sha256 === zkey.sha256;
}

/** The stored resume token, or null when there is none or it cannot be read. */
async function readResumeState(resumeUri: string): Promise<ResumeState | null> {
  const parsed = await readJson(resumeUri);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { url, sha256, resumeData } = parsed as Record<string, unknown>;
  if (typeof url !== 'string' || typeof sha256 !== 'string' || typeof resumeData !== 'string') {
    return null;
  }
  return { url, sha256, resumeData };
}

/**
 * The platform's pause first, and the token the task already carries when pausing is refused because the transfer
 * has ended. Safe to call twice for one stop, which is what lets the app-state listener and the download loop
 * share it.
 */
async function persistPause(
  task: FileSystem.DownloadResumable,
  paths: Locations,
  zkey: ZkeyLink,
): Promise<void> {
  let resumeData: string | undefined;
  try {
    resumeData = (await task.pauseAsync()).resumeData;
  } catch {
    // The task has already stopped; whatever token it carries is still worth keeping.
  }
  if (resumeData === undefined) resumeData = task.savable().resumeData;
  const state: ResumeState = { url: zkey.url, sha256: zkey.sha256, resumeData: resumeData ?? '' };
  try {
    await FileSystem.writeAsStringAsync(paths.resume, JSON.stringify(state));
  } catch {
    // Without the token the next attempt starts over: a cost in bytes, never in correctness.
  }
}

/**
 * A token written for another build, or one whose partial file has gone, is discarded together with the partial
 * file it describes, so no attempt continues a download that does not belong to the artefact it wants.
 */
async function resumeTokenFor(paths: Locations, zkey: ZkeyLink): Promise<string | undefined> {
  const state = await readResumeState(paths.resume);
  if (state !== null && describes(state, zkey) && (await fileFacts(paths.download)) !== null) {
    return state.resumeData === '' ? undefined : state.resumeData;
  }
  await removeQuietly(paths.download);
  await removeQuietly(paths.resume);
  return undefined;
}

/**
 * The transfer is driven by a loop rather than one awaited call, because a paused download answers `undefined`
 * instead of a result: the app-state listener pauses the task when the app leaves the foreground and the loop
 * resumes it on the next `active`, while an abort pauses the task, records the token and stops for good, so a
 * cancelled download is still there to resume. A transfer that has already finished is kept as it is — the check
 * that follows belongs to `./prover.ts`, which re-reads the signal in `prove()` once the artefacts are resolved.
 * Throws `cancelled` when the loop observes the abort, and `artifact_download_failed` for a refused request, a
 * lost connection or any status other than 200 and 206 (AAP 0.5.5).
 */
async function runDownload(
  paths: Locations,
  zkey: ZkeyLink,
  resumeData: string | undefined,
  onProgress: ((progress: DownloadProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const report = (data: FileSystem.DownloadProgressData): void => {
    if (onProgress === undefined) return;
    // A server that sent no content length is reported at the size the manifest publishes.
    const total = data.totalBytesExpectedToWrite > 0 ? data.totalBytesExpectedToWrite : zkey.size;
    onProgress({ receivedBytes: data.totalBytesWritten, totalBytes: total });
  };
  const task = FileSystem.createDownloadResumable(zkey.url, paths.download, {}, report, resumeData);
  // Read through one call rather than comparing the property at each site: the abort flag can change
  // while the loop waits for the app to come back, and a narrowed property would hide the second
  // check from the compiler and from the next reader.
  const isAborted = (): boolean => signal?.aborted === true;
  let backgrounded = AppState.currentState !== 'active';
  let wake: (() => void) | null = null;
  const wakeLoop = (): void => {
    const waiting = wake;
    wake = null;
    waiting?.();
  };
  const untilActive = (): Promise<void> => {
    if (!backgrounded || isAborted()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      wake = resolve;
    });
  };
  const onAppState = (state: AppStateStatus): void => {
    if (state === 'background') {
      backgrounded = true;
      void persistPause(task, paths, zkey);
      return;
    }
    // 'inactive' is a transition on iOS (a permission dialog, the app switcher) and never a reason
    // to abandon a transfer the platform has paused or is still running.
    if (state === 'active' && backgrounded) {
      backgrounded = false;
      wakeLoop();
    }
  };
  // An abort stops the transfer the same way a backgrounded app does, so a cancelled attempt leaves
  // a resumable file behind; the loop then records the token and reports the cancellation.
  const onAbort = (): void => {
    backgrounded = false;
    void persistPause(task, paths, zkey);
    wakeLoop();
  };
  const subscription = AppState.addEventListener('change', onAppState);
  signal?.addEventListener('abort', onAbort);
  try {
    let inFlight: Promise<FileSystem.FileSystemDownloadResult | undefined> = task.downloadAsync();
    for (;;) {
      let result: FileSystem.FileSystemDownloadResult | undefined;
      try {
        result = await inFlight;
      } catch {
        // A lost connection, a refused host or a timeout: the partial file and the resume token stay
        // where they are, so the next attempt continues from the bytes already on disk.
        await persistPause(task, paths, zkey);
        throw fail('artifact_download_failed');
      }
      if (result !== undefined) {
        if (result.status !== 200 && result.status !== 206) {
          // The server sent something that is not the key, so none of it is kept.
          await removeQuietly(paths.download);
          await removeQuietly(paths.resume);
          throw fail('artifact_download_failed');
        }
        return;
      }
      // Stopped without a result: paused by the app state above, or by this attempt's abort.
      await persistPause(task, paths, zkey);
      if (isAborted()) throw fail('cancelled');
      await untilActive();
      if (isAborted()) throw fail('cancelled');
      inFlight = task.resumeAsync();
    }
  } finally {
    subscription.remove();
    signal?.removeEventListener('abort', onAbort);
  }
}

/** What still has to be written, plus the margin the platform needs for the copy it stages while a transfer is in flight. */
async function assertRoom(paths: Locations, zkey: ZkeyLink, resuming: boolean): Promise<void> {
  const partial = resuming ? await fileFacts(paths.download) : null;
  let free: number;
  try {
    free = await FileSystem.getFreeDiskStorageAsync();
  } catch {
    // A store that cannot report free space cannot be trusted with a file of this size.
    throw fail('artifact_storage_unavailable');
  }
  if (free < zkey.size - (partial?.size ?? 0) + FREE_SPACE_MARGIN_BYTES) {
    throw fail('artifact_insufficient_storage');
  }
}

/** Whether a finished download is the published key: the manifest's size, then its digest. */
async function matchesManifest(uri: string, zkey: ZkeyLink): Promise<boolean> {
  const facts = await fileFacts(uri);
  if (facts === null || facts.size !== zkey.size) return false;
  return (await digestOf(uri)) === zkey.sha256;
}

/**
 * The record is written here and nowhere else, so a file this app cannot vouch for is never treated as verified.
 * Where the platform cannot report the new file's modification time the key is still returned, and the next session
 * re-hashes it rather than trusting a record it does not have.
 */
async function adopt(paths: Locations, zkey: ZkeyLink): Promise<ResolvedArtifacts> {
  await removeQuietly(paths.zkey);
  try {
    await FileSystem.moveAsync({ from: paths.download, to: paths.zkey });
  } catch {
    // The download is complete but cannot be put in place; keeping it would leave a partial file no
    // resume token describes, so both go and the store reports itself unusable.
    await removeQuietly(paths.download);
    await removeQuietly(paths.resume);
    throw fail('artifact_storage_unavailable');
  }
  await removeQuietly(paths.resume);
  const facts = await fileFacts(paths.zkey);
  if (facts !== null) await record(paths, zkey, facts.mtime);
  return resolved(paths.zkey, zkey);
}

/**
 * Every session passes through {@link verifyExisting} first, so a key is re-checked by size and modification time —
 * and re-hashed after any change or app update — before it is proved against. A download then runs at most twice:
 * once from what the last attempt left behind, and once more from scratch when a finished transfer did not hash to
 * the manifest; a transfer that fails outright is reported as such and not retried here, because a second attempt
 * would only lengthen the wait. Throws `cancelled`, `artifact_storage_unavailable`, `artifact_insufficient_storage`,
 * `artifact_download_failed`, `artifact_hash_mismatch` or `prover_unavailable` (AAP 0.5.1, AAP 0.5.5).
 */
export async function ensureArtifacts(
  artifacts: ZkConfig['artifacts'],
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<ResolvedArtifacts> {
  if (signal?.aborted === true) throw fail('cancelled');
  const paths = await locations();
  const held = await verifyExisting(artifacts.zkey, paths);
  if (held !== null) return held;
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt += 1) {
    const resumeData = attempt === 0 ? await resumeTokenFor(paths, artifacts.zkey) : undefined;
    await assertRoom(paths, artifacts.zkey, resumeData !== undefined);
    await runDownload(paths, artifacts.zkey, resumeData, onProgress, signal);
    if (await matchesManifest(paths.download, artifacts.zkey)) {
      return adopt(paths, artifacts.zkey);
    }
    // A transfer whose digest does not match the manifest is of no use: it goes, with its resume
    // token, before the single from-scratch attempt that follows.
    await removeQuietly(paths.download);
    await removeQuietly(paths.resume);
  }
  throw fail('artifact_hash_mismatch');
}

/** The interface the device is on, as the plan reports it (AAP 0.5.5). */
async function connectionType(): Promise<ArtifactPlan['connection']> {
  try {
    const state = await NetInfo.fetch();
    return state.isConnected === true ? (CONNECTIONS[state.type] ?? 'other') : 'unknown';
  } catch {
    // A device that cannot report its interface is reported as unknown rather than as a slow one.
    return 'unknown';
  }
}

/**
 * `cached` comes from the record beside the key — the same digest, size, modification time and app version a session
 * verifies, and no hashing — and `downloadBytes` counts only what is still missing when a paused transfer left part
 * of the key on disk. Both are advice: the attempt that follows re-verifies and downloads for real (AAP 0.5.5).
 */
export async function plan(artifacts: ZkConfig['artifacts']): Promise<ArtifactPlan> {
  const connection = await connectionType();
  const { zkey } = artifacts;
  let paths: Locations;
  try {
    paths = await locations();
  } catch {
    // A store this device cannot write can still be told what the download would weigh.
    return { cached: false, downloadBytes: zkey.size, connection };
  }
  const facts = await fileFacts(paths.zkey);
  if (
    facts !== null &&
    facts.size === zkey.size &&
    isCurrent(await readMeta(paths.meta), facts, zkey)
  ) {
    return { cached: true, downloadBytes: 0, connection };
  }
  const state = await readResumeState(paths.resume);
  const partial = state !== null && describes(state, zkey) ? await fileFacts(paths.download) : null;
  const done = Math.min(partial?.size ?? 0, zkey.size);
  return { cached: false, downloadBytes: zkey.size - done, connection };
}

/** The artefact store this platform downloads and verifies through (AAP 0.5.5). */
export const artifactStore = { plan, ensureArtifacts } satisfies ArtifactStore;
