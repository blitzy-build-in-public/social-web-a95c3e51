/**
 * Platform-neutral proving orchestration and the zero-knowledge client contracts (AAP 0.5.1, AAP 0.5.5).
 *
 * The proof is built on the device and nowhere else: the email bytes, the private inputs and the inputs JSON live in
 * local variables for the length of one call and reach neither the proof store, a route parameter, a log line nor an
 * error (criterion 3). The neutral half of a three-file split — no `expo-*`, no `react-native`, no snarkjs, no native
 * module, no Node built-in — with its two collaborators arriving through the extensionless `./prover` and `./circuits`
 * imports.
 * {@link prove} measures input construction through witness generation and proving, the span AAP 0.5.5 holds against
 * p95 <= 90 s on phone-class devices; artefact downloads happen before it.
 */
import type { CircuitInputErrorCode, CircuitInputs, SupportedIssuer } from '@tablemate/circuits';
import { PUBLIC_SIGNAL_NAMES, ProofSubmission } from '@tablemate/shared';
import type {
  ArtifactRef,
  ArtifactsManifest,
  ProofAccepted,
  PublicSignalName,
  RegistryFile,
  ZkConfig,
} from '@tablemate/shared';
import { apiClient } from '../api/client';
import { isApiError } from '../api/errors';
import type { ClientErrorCode } from '../api/errors';
import { resetProof, setProofError, setProofStatus } from '../state/proof-store';

/*
 * The circuit API — the witness input generator and the way this platform recognises the error it raises — resolved
 * by the bundler: `circuits.ts` on iOS and Android, `circuits.web.ts` on the web.
 */
import { isCircuitInputError, loadCircuitApi } from './circuits';

/*
 * The platform half of the split, resolved by the bundler rather than a runtime flag: Metro maps this extensionless
 * path to `prover.native.ts` on iOS and Android and to `prover.web.ts` on the web.
 */
import * as platform from './prover';
/**
 * One picked or shared booking-confirmation file. It carries no file name, path or URI, because the name of a
 * confirmation email can hold a booking reference.
 */
export interface EmlHandle {
  /** The bytes, passed to the input generator and never stored or sent. */
  readonly bytes: Uint8Array;
  /**
   * Deletes the app-owned copy and releases its bytes; idempotent, and awaited on every path — success, failure and
   * cancellation. The user's own original is never touched.
   */
  release(): Promise<void>;
}

/** How the flow obtains an `.eml`: the document picker everywhere, plus the native share sheet. */
export interface EmlIntake {
  pickEml(): Promise<EmlHandle | null>;
  fromShareIntent?(uri: string): Promise<EmlHandle>;
}

/** One artefact on disk, after download and SHA-256 verification against the manifest. */
export interface ResolvedFile {
  /**
   * Where the engine reads it: a verified file URI on native, an OPFS entry on the web, or the artefact's published
   * URL on an engine whose origin-private file system cannot be used.
   */
  readonly location: string;
  readonly sha256: string;
  readonly size: number;
}

/**
 * The two artefacts a proof needs, resolved and verified. `wasm` is null on native, where `tablemate-prover` compiles
 * the witness generator into the app.
 */
export interface ResolvedArtifacts {
  readonly zkey: ResolvedFile;
  readonly wasm: ResolvedFile | null;
}

export interface DownloadProgress {
  readonly receivedBytes: number;
  /** The total the manifest declared, or 0 while it is unknown. */
  readonly totalBytes: number;
}

/**
 * What {@link ArtifactStore.plan} reports before downloading anything, so the generate screen can show the download
 * size and recommend Wi-Fi.
 */
export interface ArtifactPlan {
  /** True when both artefacts are already on disk, verified and current. */
  readonly cached: boolean;
  /** Bytes a download would still fetch; 0 when `cached`. */
  readonly downloadBytes: number;
  readonly connection: 'wifi' | 'cellular' | 'other' | 'unknown';
}

/**
 * The artefact half of the split: fetching the proving key and the circuit WASM, verifying each against its published
 * SHA-256, and keeping them for the next attempt. A store re-verifies what it holds before every use.
 */
export interface ArtifactStore {
  plan(artifacts: ZkConfig['artifacts']): Promise<ArtifactPlan>;
  ensureArtifacts(
    artifacts: ZkConfig['artifacts'],
    onProgress?: (progress: DownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<ResolvedArtifacts>;
}

/**
 * What a proving engine returns. `proof` and `publicSignals` stay `unknown` because this module validates them with
 * `ProofSubmission`, turning a malformed result into `proof_output_invalid`.
 */
export interface EngineOutput {
  readonly proof: unknown;
  readonly publicSignals: unknown;
  readonly witnessMs: number;
  readonly proveMs: number;
}

/**
 * The proving engine of one platform: rapidsnark through the native `tablemate-prover` module on iOS and Android,
 * snarkjs in a dedicated Web Worker on the web.
 */
export interface ProverEngine {
  /** True when this build can prove at all; a missing native module or Worker says false. */
  available(): boolean;
  /**
   * Proves one witness from the circuit inputs `JSON.stringify`ed in this process — an in-memory string to the native
   * module, a `postMessage` frame to the web Worker — against verified artefacts.
   */
  generate(
    inputsJson: string,
    artifacts: ResolvedArtifacts,
    signal?: AbortSignal,
  ): Promise<EngineOutput>;
}

/**
 * Everything a proof needs that does not come from the email. `ZkConfig` from `GET /v1/zk/config` satisfies this
 * shape, and `app/dev/zk-bench.tsx` builds one from the committed artefacts.
 */
export interface ProveConfig {
  /** The issuers whose keys and templates the input generator may use. */
  readonly issuers: readonly SupportedIssuer[];
  /** The tree whose root the proof names, and where its issuer and city leaves live. */
  readonly registry: RegistryFile;
  /** The published salt the booking reference is hashed with to form the nullifier. */
  readonly nullifierSalt: string;
  /** The artefacts, when the caller has already resolved them. */
  readonly artifacts?: ZkConfig['artifacts'];
}

/**
 * How one proof's span breaks down, in milliseconds: `totalMs` runs from input construction through proving, which
 * is what AAP 0.5.5 compares with its p95 <= 90 s target.
 */
export interface ProveTimings {
  readonly inputMs: number;
  readonly witnessMs: number;
  readonly proveMs: number;
  readonly totalMs: number;
}

/** One locally generated, schema-validated proof, ready to submit. */
export interface ProveResult {
  /** The Groth16 proof, in the shape `POST /itinerary-proofs` accepts. */
  readonly proof: ProofSubmission['proof'];
  /** The seven public signals, in circuit order. */
  readonly publicSignals: ProofSubmission['publicSignals'];
  /** The registry issuer id the proof named, for the screens that display it. */
  readonly issuerId: number;
  readonly timings: ProveTimings;
}

/**
 * The witness inputs of one attempt, built before any artefact is fetched: an email that is not a booking
 * confirmation and one whose issuer the published configuration does not support are refused by the input generator,
 * so an unusable email costs ~1.6 GB less than refusing after the artefacts.
 */
export interface BuiltInputs {
  /** The witness, ready for `JSON.stringify`. */
  readonly inputs: CircuitInputs;
  /** The registry issuer id the proof names, the circuit's public `issuerId` output. */
  readonly issuerId: number;
  /** How long the build took: the `inputMs` component of {@link ProveTimings}. */
  readonly inputMs: number;
}

/** What {@link prove} may be told besides the email bytes and the configuration. */
export interface ProveOptions {
  engine?: ProverEngine;
  /** Inputs already built from these bytes, which are proved instead of being built again. */
  built?: BuiltInputs;
  artifacts?: ResolvedArtifacts;
  artifactStore?: ArtifactStore;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface ImportAndProveOptions {
  engine?: ProverEngine;
  artifactStore?: ArtifactStore;
  signal?: AbortSignal;
}

export interface ImportAndProveResult {
  /** The `201` answer of `POST /itinerary-proofs`. */
  readonly accepted: ProofAccepted;
  readonly timings: ProveTimings;
}

/**
 * Every code this client's proving flow can raise, so a screen maps one code to one sentence (AAP 0.5.8): the input
 * generator's own codes, this module's `proof_output_invalid` and `cancelled`, and the `worker_failed` and
 * `unsupported_platform` a platform engine reports.
 */
export const ZK_CLIENT_ERROR_CODES = [
  'eml_read_failed',
  'share_intake_unsupported',
  'artifact_download_failed',
  'artifact_hash_mismatch',
  'artifact_insufficient_storage',
  'artifact_storage_unavailable',
  'prover_unavailable',
  'worker_unavailable',
  'worker_failed',
  'out_of_memory',
  'proof_output_invalid',
  'proof_in_progress',
  'cancelled',
] as const;
/** One {@link ZK_CLIENT_ERROR_CODES} entry. */
export type ZkClientErrorCode = (typeof ZK_CLIENT_ERROR_CODES)[number];
/**
 * The proving error a screen catches. The prototype chain is restored because Babel under Hermes does not preserve
 * it for a built-in subclass.
 */
export type ProofErrorCode =
  | CircuitInputErrorCode
  | ZkClientErrorCode
  | ClientErrorCode
  | 'zkey_missing'
  | 'inputs_invalid'
  | 'prover_failed'
  | 'file_missing'
  | 'hash_failed';
/**
 * The reason an attempt stopped, as a code and the shape `proof-store` requires, so a screen can map it to one
 * sentence.
 */
class ZkError extends Error {
  /** The reason the attempt stopped. */
  readonly code: ZkClientErrorCode;
  constructor(code: ZkClientErrorCode) {
    super(code);
    this.name = 'ZkClientError';
    this.code = code;
    // Metro transpiles classes with Babel, which does not preserve the prototype chain of a built-in
    // subclass; restoring it keeps `instanceof ZkError` true in the app.
    Object.setPrototypeOf(this, ZkError.prototype);
  }
}

/** The shape of a code {@link errorCodeOf} passes through, which `proof-store` also requires. */
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** A decimal field element, the form the circuit, the registry and the store all use. */
const FIELD_ELEMENT_PATTERN = /^\d{1,78}$/;
/** What the platform files export, read lazily and possibly absent. */
interface PlatformImplementations {
  readonly engine?: ProverEngine;
  readonly artifactStore?: ArtifactStore;
}

/** This platform's engine and artefact store, read inside functions rather than at module load. */
function platformImplementations(): PlatformImplementations {
  return platform as unknown as PlatformImplementations;
}

/**
 * This platform's proving engine, or undefined where the build has none: a capability probe returns false rather
 * than failing an attempt that has already read a booking email.
 */
export function platformEngine(): ProverEngine | undefined {
  return platformImplementations().engine;
}

/**
 * Why the flow may refuse before anything is downloaded: an unsupported build is reported to the traveler without
 * spending the ~1.6 GB artefact download.
 */
export function platformArtifactStore(): ArtifactStore | undefined {
  return platformImplementations().artifactStore;
}

/**
 * The stored proof status after a step, so a screen repaints from the store alone and never holds an email byte.
 */
function now(): number {
  const perf = globalThis.performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

/**
 * A staged picked file, waiting for the generate screen. It lives in memory alone, for the length of one attempt.
 */
async function releaseQuietly(handle: EmlHandle): Promise<void> {
  try {
    await handle.release();
  } catch {
    // Intentionally ignored: cleanup is best-effort and never the outcome of the attempt.
  }
}

/** The picked file waiting for the generate screen, in memory alone. */
let pendingEml: EmlHandle | null = null;
/** True while {@link importAndProve} is running, so a second attempt is refused, not interleaved. */
let sessionInFlight = false;
/**
 * The client code an error maps to: this module's own codes pass through, an `ApiError`'s code is read, and anything
 * else is `worker_failed`. `proof-store` requires the same shape.
 */
export function errorCodeOf(err: unknown): ProofErrorCode | 'unknown_error' {
  if (isCircuitInputError(err)) return err.code;
  if (isApiError(err)) return err.code;
  if (typeof err !== 'object' || err === null) return 'unknown_error';
  const shape = err as { name?: unknown; code?: unknown };
  if (shape.name === 'AbortError') return 'cancelled';
  return typeof shape.code === 'string' && CODE_PATTERN.test(shape.code)
    ? (shape.code as ProofErrorCode)
    : 'unknown_error';
}

/** The decimal value of one named public signal, or null when the submission carries no such signal. */
function signalValue(submission: ProofSubmission, name: PublicSignalName): string | null {
  const index = PUBLIC_SIGNAL_NAMES.indexOf(name);
  return index < 0 ? null : (submission.publicSignals[index] ?? null);
}

/** A decimal field element as a `bigint`, or null when the value is not one. */
function fieldValue(value: string | null): bigint | null {
  return value !== null && FIELD_ELEMENT_PATTERN.test(value) ? BigInt(value) : null;
}

/** True when a signal and an expected value denote the same field element, compared as numbers. */
function matchesSignal(signal: string | null, expected: string): boolean {
  const left = fieldValue(signal);
  const right = fieldValue(expected);
  return left !== null && right !== null && left === right;
}

/**
 * Validates a proof output against `ProofSubmission` and the seven public signals read by name through
 * `PUBLIC_SIGNAL_NAMES`, so a `422 proof_invalid` cannot come from a shape this client could have checked.
 */
function validatedSubmission(
  output: EngineOutput,
  config: ProveConfig,
  issuerId: number,
): ProofSubmission {
  const parsed = ProofSubmission.safeParse({
    proof: output.proof,
    publicSignals: output.publicSignals,
  });
  if (!parsed.success) throw new ZkError('proof_output_invalid');
  const submission = parsed.data;
  const valid =
    matchesSignal(signalValue(submission, 'issuerId'), String(issuerId)) &&
    matchesSignal(signalValue(submission, 'registryRoot'), config.registry.root) &&
    matchesSignal(signalValue(submission, 'nullifierSalt'), config.nullifierSalt);
  if (!valid) throw new ZkError('proof_output_invalid');
  return submission;
}

/** One percentage point: the smallest movement a download report is published for. */
const PROGRESS_STEP = 0.01;
/** A reported byte pair as a 0-1 ratio, or undefined when no usable total was reported. */
function progressRatio(progress: DownloadProgress): number | undefined {
  const { receivedBytes, totalBytes } = progress;
  if (!Number.isFinite(receivedBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) {
    return undefined;
  }
  return Math.min(1, Math.max(0, receivedBytes / totalBytes));
}

/**
 * What one artefact download reports as it runs: the bytes fetched so far and the total the manifest declared.
 */
function progressReporter(
  report: (progress: number) => void,
): (progress: DownloadProgress) => void {
  let lastReported = -1;
  return (progress: DownloadProgress): void => {
    const ratio = progressRatio(progress);
    if (ratio === undefined) return;
    if (ratio < 1 && ratio - lastReported < PROGRESS_STEP) return;
    lastReported = ratio;
    report(ratio);
  };
}

/**
 * Downloads both artefacts through the store, reporting whole percentage points of progress as bytes arrive, and
 * resolving with the verified refs.
 */
async function resolveArtifacts(
  artifacts: ZkConfig['artifacts'] | undefined,
  store: ArtifactStore | undefined,
  onProgress: ((progress: DownloadProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<ResolvedArtifacts> {
  const resolvedStore = store ?? platformImplementations().artifactStore;
  if (artifacts === undefined || resolvedStore === undefined) {
    throw new ZkError('artifact_download_failed');
  }
  return resolvedStore.ensureArtifacts(artifacts, onProgress, signal);
}

/**
 * Proves one email without submitting anything: builds (or accepts) the witness, resolves the artefacts, and returns
 * the proof with its measured span.
 */
async function buildInputs(emlBytes: Uint8Array, config: ProveConfig): Promise<BuiltInputs> {
  // Let a status paint before the input generation below blocks the JS thread, which under Hermes is
  // the whole window in which a screen can render that step.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  // The generator is loaded before the span starts: on the web this call fetches the package's chunk, which must not
  // be measured as proving time.
  const { buildCircuitInputs } = await loadCircuitApi();
  const startedAt = now();
  const { inputs, issuerId } = buildCircuitInputs(emlBytes, config.issuers, config.registry, {
    nullifierSalt: config.nullifierSalt,
  });
  return { inputs, issuerId, inputMs: now() - startedAt };
}

/**
 * Builds the witness from the email bytes and proves it, measuring one span from input construction to the proof
 * output.
 *
 * Nothing about the attempt leaves the device except the proof and its public signals: the email bytes and the private
 * inputs are local variables for the length of the call, and the witness is built before any download.
 * @returns The proof, its registry issuer id and the measured span.
 */
export async function prove(
  emlBytes: Uint8Array,
  config: ProveConfig,
  options: ProveOptions = {},
): Promise<ProveResult> {
  const engine = options.engine ?? platformImplementations().engine;
  if (engine === undefined || !engine.available()) throw new ZkError('prover_unavailable');
  const artifacts =
    options.artifacts ??
    (await resolveArtifacts(
      config.artifacts,
      options.artifactStore,
      options.onProgress,
      options.signal,
    ));
  if (options.signal?.aborted === true) throw new ZkError('cancelled');
  const built = options.built ?? (await buildInputs(emlBytes, config));
  const startedAt = now();
  // The engine reads exactly this string: decimal field elements under the circuit's signal names.
  const inputsJson = JSON.stringify(built.inputs);
  const output = await engine.generate(inputsJson, artifacts, options.signal);
  const totalMs = built.inputMs + (now() - startedAt);
  const submission = validatedSubmission(output, config, built.issuerId);
  return {
    proof: submission.proof,
    publicSignals: submission.publicSignals,
    issuerId: built.issuerId,
    timings: {
      inputMs: built.inputMs,
      witnessMs: output.witnessMs,
      proveMs: output.proveMs,
      totalMs,
    },
  };
}

/**
 * Submits a proof to `POST /itinerary-proofs` (AAP 0.5.4). The body is exactly `{ proof, publicSignals }`, so no
 * email byte leaves the device; a refusal arrives as an `ApiError` whose code {@link errorCodeOf} reads.
 */
export function submitProof(
  result: Pick<ProveResult, 'proof' | 'publicSignals'>,
): Promise<ProofAccepted> {
  return apiClient.submitProof({ proof: result.proof, publicSignals: result.publicSignals });
}

/** The options {@link prove} is called with, carrying only what the caller actually supplied. */
function proveOptions(
  options: ImportAndProveOptions,
  artifacts: ResolvedArtifacts,
  built?: BuiltInputs,
): ProveOptions {
  const resolved: ProveOptions = { artifacts };
  if (options.engine !== undefined) resolved.engine = options.engine;
  if (options.artifactStore !== undefined) resolved.artifactStore = options.artifactStore;
  if (options.signal !== undefined) resolved.signal = options.signal;
  if (built !== undefined) resolved.built = built;
  return resolved;
}

/**
 * The whole flow of the Import screen: read (or share in) the `.eml`, resolve and verify the artefacts, prove,
 * submit, and release the app-owned copy on every path.
 *
 * It drives `../state/proof-store` one step at a time — `reading`, `downloading` with a 0-1 progress fraction,
 * `proving`, `submitting` — and keeps only `{ status, issuerId?, errorCode? }` there. An email the input generator
 * refuses is reported before any download. Throws the error that ended the attempt.
 */
export async function importAndProve(
  handle: EmlHandle,
  zkConfig: ZkConfig,
  options: ImportAndProveOptions = {},
): Promise<ImportAndProveResult> {
  if (sessionInFlight) {
    await releaseQuietly(handle);
    throw new ZkError('proof_in_progress');
  }
  sessionInFlight = true;
  let issuerId: number | undefined;
  try {
    resetProof();
    setProofStatus('reading');
    // Build the witness before fetching anything: an email that is not a booking confirmation, or one whose issuer
    // `zkConfig.issuers` does not support, is refused here and so costs no download of the ~1.6 GB artefact set.
    const built = await buildInputs(handle.bytes, zkConfig);
    setProofStatus('downloading', { downloadProgress: 0 });
    const artifacts = await resolveArtifacts(
      zkConfig.artifacts,
      options.artifactStore,
      progressReporter((progress) => {
        setProofStatus('downloading', { downloadProgress: progress });
      }),
      options.signal,
    );
    setProofStatus('proving');
    const result = await prove(handle.bytes, zkConfig, proveOptions(options, artifacts, built));
    issuerId = result.issuerId;
    setProofStatus('submitting', { issuerId });
    const accepted = await submitProof(result);
    setProofStatus('accepted', { issuerId });
    return { accepted, timings: result.timings };
  } catch (err) {
    const code = errorCodeOf(err);
    if (code === 'cancelled') setProofStatus('cancelled');
    else setProofError(code, issuerId);
    throw err;
  } finally {
    sessionInFlight = false;
    await releaseQuietly(handle);
  }
}

/**
 * The staged file, or null when nothing is staged. The generate screen reads it so the two screens never hold the
 * bytes twice.
 */
export async function stagePendingEml(handle: EmlHandle): Promise<void> {
  const previous = pendingEml;
  pendingEml = handle;
  if (previous !== null) await releaseQuietly(previous);
}

/**
 * True while an import-and-prove attempt runs, so a second one is refused rather than interleaved.
 */
export function takePendingEml(): EmlHandle | null {
  const handle = pendingEml;
  pendingEml = null;
  return handle;
}

/**
 * Clears the staged file, safe to call when nothing is staged, so a cancelled or finished attempt leaves no bytes
 * behind.
 */
export async function discardPendingEml(): Promise<void> {
  const handle = pendingEml;
  pendingEml = null;
  if (handle !== null) await releaseQuietly(handle);
}

/**
 * The artefacts of `manifest` as the published configuration advertises them: one URL per file
 * built from `baseUrl`, carrying the size and SHA-256 the download is verified against.
 * `app/dev/zk-bench.tsx` uses it to prove against the local artefact service without calling the API,
 * which is what makes the benchmark and the native smoke check independent of the server.
 */
export function artifactsFromManifest(
  manifest: ArtifactsManifest,
  baseUrl: string,
): ZkConfig['artifacts'] {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    wasm: artifactLink(manifest.files.wasm, base),
    zkey: artifactLink(manifest.files.zkey, base),
  };
}

/** One manifest entry as the client fetches it. */
function artifactLink(file: ArtifactRef, base: string): ZkConfig['artifacts']['wasm'] {
  return { url: `${base}/${file.name}`, size: file.size, sha256: file.sha256 };
}

/**
 * The published configuration as the screens and the input generator read it: the supported issuers, the registry,
 * the nullifier salt and the artefact refs.
 */
export function issuerSupport(zkConfig: Pick<ZkConfig, 'issuers' | 'unsupportedIssuers'>): {
  supported: string[];
  unsupported: string[];
} {
  return {
    supported: zkConfig.issuers.map((issuer) => issuer.displayName),
    unsupported: [...zkConfig.unsupportedIssuers],
  };
}
