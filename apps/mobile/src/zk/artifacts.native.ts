/**
 * Proving-key delivery on iOS and Android: one resumable, hash-verified download (AAP 0.5.1, AAP 0.5.5). Only the
 * proving key is fetched — `tablemate-prover` compiles the witness generator into the app, so `ResolvedArtifacts.wasm`
 * is null (AAP 0.3.4).
 *
 * A key is proved against only after it has been checked: the downloading session compares its digest and size
 * with the artefact manifest, every later session compares the stored size and modification time, and either
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

/** One downloadable artefact, as the artefact manifest and `GET /v1/zk/config` publish it. */
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

function fail(code: ZkClientErrorCode): Error {
  return Object.assign(new Error(code), { name: 'ZkClientError', code });
}

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

async function locations(): Promise<Locations> {
  const root = FileSystem.documentDirectory;
  if (root === null) throw fail('artifact_storage_unavailable');
  const directory = `${root.endsWith('/') ? root : `${root}/`}${ZK_DIRECTORY}/`;
  try {
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

function appVersion(): string {
  return Constants.expoConfig?.version ?? 'unknown';
}

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

async function readMeta(metaUri: string): Promise<ZkeyMeta | null> {
  const parsed = await readJson(metaUri);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { sha256, size, mtime, appVersion: version } = parsed as Record<string, unknown>;
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return null;
  if (typeof size !== 'number' || typeof mtime !== 'number' || !Number.isFinite(mtime)) return null;
  if (typeof version !== 'string') return null;
  return { sha256, size, mtime, appVersion: version };
}

function isCurrent(meta: ZkeyMeta | null, facts: FileFacts, zkey: ZkeyLink): boolean {
  return (
    meta !== null &&
    meta.sha256 === zkey.sha256 &&
    meta.size === facts.size &&
    meta.mtime === facts.mtime &&
    meta.appVersion === appVersion()
  );
}

async function record(paths: Locations, zkey: ZkeyLink, mtime: number): Promise<void> {
  const meta: ZkeyMeta = { sha256: zkey.sha256, size: zkey.size, mtime, appVersion: appVersion() };
  try {
    await FileSystem.writeAsStringAsync(paths.meta, JSON.stringify(meta));
  } catch {
    // The record saves the next session one hash and nothing else, so a refused write costs speed.
  }
}

function resolved(zkeyUri: string, zkey: ZkeyLink): ResolvedArtifacts {
  return { zkey: { location: zkeyUri, sha256: zkey.sha256, size: zkey.size }, wasm: null };
}

async function digestOf(uri: string): Promise<string | null> {
  try {
    return await sha256File(uri);
  } catch (error: unknown) {
    if (errorCodeOf(error) === 'file_missing') return null;
    throw error;
  }
}

async function verifyExisting(zkey: ZkeyLink, paths: Locations): Promise<ResolvedArtifacts | null> {
  const facts = await fileFacts(paths.zkey);
  if (facts === null) return null;
  if (facts.size !== zkey.size) {
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

interface ResumeState {
  readonly url: string;
  readonly sha256: string;
  readonly resumeData: string;
}

/** Whether a resume token belongs to this artefact: one URL, one digest. */
function describes(state: ResumeState, zkey: ZkeyLink): boolean {
  return state.url === zkey.url && state.sha256 === zkey.sha256;
}

async function readResumeState(resumeUri: string): Promise<ResumeState | null> {
  const parsed = await readJson(resumeUri);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { url, sha256, resumeData } = parsed as Record<string, unknown>;
  if (typeof url !== 'string' || typeof sha256 !== 'string' || typeof resumeData !== 'string') {
    return null;
  }
  return { url, sha256, resumeData };
}

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

async function resumeTokenFor(paths: Locations, zkey: ZkeyLink): Promise<string | undefined> {
  const state = await readResumeState(paths.resume);
  if (state !== null && describes(state, zkey) && (await fileFacts(paths.download)) !== null) {
    return state.resumeData === '' ? undefined : state.resumeData;
  }
  await removeQuietly(paths.download);
  await removeQuietly(paths.resume);
  return undefined;
}

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

async function connectionType(): Promise<ArtifactPlan['connection']> {
  try {
    const state = await NetInfo.fetch();
    return state.isConnected === true ? (CONNECTIONS[state.type] ?? 'other') : 'unknown';
  } catch {
    // A device that cannot report its interface is reported as unknown rather than as a slow one.
    return 'unknown';
  }
}

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
