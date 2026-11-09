/**
 * Platform-neutral proving orchestration and the zero-knowledge client contracts (AAP 0.5.1, AAP 0.5.5,
 * AAP 0.8.1).
 *
 * The proof is built on the device and nowhere else: the email bytes, the private inputs and the inputs
 * JSON live in local variables for the length of one call and reach neither the proof store, a route
 * parameter, a log line nor an error (AAP 0.5.5, AAP 0.12.2, success criterion 3). The neutral half of a
 * three-file split — it imports no `expo-*`, no `react-native`, no snarkjs, no native module and no Node
 * built-in, so it loads on every platform and in a Node test process — and its two collaborators arrive
 * per platform through the extensionless `./prover` and `./circuits` imports below.
 *
 * {@link prove} measures one span — input construction through witness generation and proving to the
 * proof output — which is the figure AAP 0.5.5 holds against p95 ≤ 90 s on phone-class devices; artefact
 * downloads happen before it, so network time cannot distort a proving measurement. Client state keeps
 * only `{ status, issuerId?, errorCode? }` and a numeric download progress.
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
 * The circuit API — the witness input generator, and the way this platform recognises the error it
 * raises — resolved by the bundler exactly as the platform half below is: `circuits.ts` on iOS and
 * Android, where the package is in the bundle the app starts from, `circuits.web.ts` on the web.
 */
import { isCircuitInputError, loadCircuitApi } from './circuits';

/*
 * The platform half of the split, resolved by the bundler rather than a runtime flag: Metro maps this
 * extensionless path to `prover.native.ts` on iOS and Android and to `prover.web.ts` on the web, and
 * `tsconfig.json` type-checks it through `moduleSuffixes` against the native half.
 *
 * Its properties are read lazily inside the functions below, never at module load, because in a Vitest
 * run this path resolves back to this file: a harmless self-cycle in which both properties are absent,
 * so a test injects its own engine and artefact store instead of reading a missing default at load time.
 */
import * as platform from './prover';

/* --- The platform contracts (AAP 0.3.4, AAP 0.5.5) ------------------------------------------ */

/**
 * One picked or shared booking-confirmation file. It carries no file name, path or URI, because the
 * name of a confirmation email can hold a booking reference.
 */
export interface EmlHandle {
  /** The bytes, passed to the input generator and never stored or sent. */
  readonly bytes: Uint8Array;
  /**
   * Deletes the app-owned copy and releases its bytes; idempotent, and awaited on every path —
   * success, failure and cancellation (AAP 0.5.5). The user's own original is never touched.
   */
  release(): Promise<void>;
}

/** How the flow obtains an `.eml`: the document picker everywhere, plus the native share sheet. */
export interface EmlIntake {
  /** Opens the platform's file picker; `null` means the user cancelled. */
  pickEml(): Promise<EmlHandle | null>;
  /** Reads a file the operating system handed to the app. Absent on the web. */
  fromShareIntent?(uri: string): Promise<EmlHandle>;
}

/** One artefact on disk, after download and SHA-256 verification against the manifest. */
export interface ResolvedFile {
  /**
   * Where the engine reads it: a verified file URI on native, an OPFS entry on the web, or the
   * artefact's published URL on an engine whose origin-private file system cannot be used.
   */
  readonly location: string;
  readonly sha256: string;
  readonly size: number;
}

/**
 * The two artefacts a proof needs, resolved and verified. `wasm` is null on native, where
 * `tablemate-prover` compiles the witness generator into the app (AAP 0.3.4).
 */
export interface ResolvedArtifacts {
  readonly zkey: ResolvedFile;
  readonly wasm: ResolvedFile | null;
}

/** How far an artefact download has got, as a store reports it. */
export interface DownloadProgress {
  readonly receivedBytes: number;
  /** The total the manifest declared, or 0 while it is unknown. */
  readonly totalBytes: number;
}

/**
 * What {@link ArtifactStore.plan} reports before downloading anything, so the generate screen can show
 * the download size and recommend Wi-Fi (AAP 0.5.5).
 */
export interface ArtifactPlan {
  /** True when both artefacts are already on disk, verified and current. */
  readonly cached: boolean;
  /** Bytes a download would still fetch; 0 when `cached`. */
  readonly downloadBytes: number;
  readonly connection: 'wifi' | 'cellular' | 'other' | 'unknown';
}

/**
 * The artefact half of the split: fetching the proving key and the circuit WASM, verifying each against
 * its published SHA-256, and keeping them for the next attempt (AAP 0.5.5). A store re-verifies what it
 * holds by size and modification time before each use and re-hashes it after an app update; a store
 * whose platform cannot keep the artefacts resolves them to the URLs they are published at instead, and
 * the engine then re-verifies each as it streams it in.
 */
export interface ArtifactStore {
  /** Reports what a download would cost, without starting one. */
  plan(artifacts: ZkConfig['artifacts']): Promise<ArtifactPlan>;
  /** Downloads, hash-checks and returns both artefacts, reporting progress as bytes arrive. */
  ensureArtifacts(
    artifacts: ZkConfig['artifacts'],
    onProgress?: (progress: DownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<ResolvedArtifacts>;
}

/**
 * What a proving engine returns. `proof` and `publicSignals` stay `unknown` because this module validates
 * them with `ProofSubmission`, turning a malformed result into `proof_output_invalid` rather than a proof
 * the API refuses; {@link ProveTimings.totalMs} is the span AAP 0.5.5 records.
 */
export interface EngineOutput {
  readonly proof: unknown;
  readonly publicSignals: unknown;
  readonly witnessMs: number;
  readonly proveMs: number;
}

/**
 * The proving engine of one platform: rapidsnark through the native `tablemate-prover` module on iOS
 * and Android, snarkjs in a dedicated Web Worker on the web (AAP 0.3.4, AAP 0.5.5).
 */
export interface ProverEngine {
  /** True when this build can prove at all; a missing native module or Worker says false. */
  available(): boolean;
  /**
   * Proves one witness from the circuit inputs `JSON.stringify`ed in this process — an in-memory
   * string to the native module, a `postMessage` frame to the web Worker — against verified artefacts.
   */
  generate(
    inputsJson: string,
    artifacts: ResolvedArtifacts,
    signal?: AbortSignal,
  ): Promise<EngineOutput>;
}

/**
 * Everything a proof needs that does not come from the email (AAP 0.5.5). `ZkConfig` from
 * `GET /v1/zk/config` satisfies this shape, and `app/dev/zk-bench.tsx` builds one from the committed
 * configuration files without calling the API.
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
 * How one proof's span breaks down, in milliseconds. `totalMs` runs from input construction through
 * proving, which is what AAP 0.5.5 compares with its p95 ≤ 90 s target; the rest are diagnostics.
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
 * confirmation and one whose issuer the published configuration does not support are both refused by the
 * input generator, which settles the second by the message's own `d=`/`s=` tags against
 * `ZkConfig.issuers`. Building the inputs first, through {@link ProveOptions.built}, therefore refuses an
 * unusable email without downloading the ~1.6 GB artefact set (AAP 0.5.5, AAP 0.5.8).
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
  /** The proving engine; defaults to this platform's. */
  engine?: ProverEngine;
  /** Inputs already built from these bytes, which are proved instead of being built again. */
  built?: BuiltInputs;
  /** Artefacts already resolved, which skips the download entirely. */
  artifacts?: ResolvedArtifacts;
  /** The artefact store to download through; defaults to this platform's. */
  artifactStore?: ArtifactStore;
  /** Aborts the download or the proof. */
  signal?: AbortSignal;
  /** Called as artefact bytes arrive; never called when `artifacts` is supplied. */
  onProgress?: (progress: DownloadProgress) => void;
}

/** What {@link importAndProve} may be told. */
export interface ImportAndProveOptions {
  /** The proving engine; defaults to this platform's. */
  engine?: ProverEngine;
  /** The artefact store; defaults to this platform's. */
  artifactStore?: ArtifactStore;
  /** Aborts the download, the proof or the submission. */
  signal?: AbortSignal;
}

/** One completed import-and-prove attempt: the server's answer and the measured span. */
export interface ImportAndProveResult {
  /** The `201` answer of `POST /itinerary-proofs`. */
  readonly accepted: ProofAccepted;
  readonly timings: ProveTimings;
}

/* --- Error codes ---------------------------------------------------------------------------- */

/**
 * Every code this client's proving flow can raise, so a screen maps one code to one sentence (AAP 0.5.8).
 * The intake raises `eml_read_failed` and `share_intake_unsupported`; the artefact store raises
 * `artifact_download_failed`, `artifact_hash_mismatch`, `artifact_insufficient_storage` and
 * `artifact_storage_unavailable`; the engine raises `prover_unavailable`, `worker_unavailable`,
 * `worker_failed` and `out_of_memory`; `proof_output_invalid` is an engine result this module refuses,
 * and `proof_in_progress` and `cancelled` are the flow's own.
 *
 * The platform files raise these as errors shaped `{ name: 'ZkClientError', code, message: code }` and
 * import only the type, so an engine never imports this module at runtime.
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
 * Every code the proving flow can carry: the input generator's, this module's, the API client's and the
 * native module's five `ProverErrorCode` values — listed literally rather than imported, because
 * importing them would pull the native module into the web bundle.
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
 * The only error this module raises. Its `message` is the code, so no free text can travel out of a
 * proof attempt, and its `name` matches the shape the platform files use, which {@link errorCodeOf}
 * reads.
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
 * This platform's proving engine, or undefined where the build has none (AAP 0.3.4, AAP 0.5.5).
 *
 * The generate screen asks {@link ProverEngine.available} through this accessor *before* it offers to
 * prove, so a build without the native module — Expo Go, or a native build made before
 * `pnpm circuits:native` — or a browser without a Worker states that as its own screen state instead of
 * failing an attempt that has already read a booking email (AAP 0.2.4, AAP 0.5.8).
 */
export function platformEngine(): ProverEngine | undefined {
  return platformImplementations().engine;
}

/**
 * This platform's artefact store, or undefined where the build has none. The generate screen reads
 * {@link ArtifactStore.plan} through this accessor to show the download size and the Wi-Fi advice before
 * anything is downloaded (AAP 0.5.5).
 */
export function platformArtifactStore(): ArtifactStore | undefined {
  return platformImplementations().artifactStore;
}

/**
 * The clock the measured span is taken on, monotonic where the platform offers one so a device clock
 * change cannot distort a benchmark; `Date.now()` is the fallback. This is client code, so the
 * server's injected-clock rule does not apply (AAP 0.11.1).
 */
function now(): number {
  const perf = globalThis.performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

/**
 * Releases an intake handle, swallowing a failure: the copy is app-owned cleanup, so a storage error
 * must neither replace the error that caused the release nor fail an otherwise successful proof.
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

/* --- Reading an error ----------------------------------------------------------------------- */

/**
 * The code of anything the proving flow can throw, or `unknown_error` for an error that offers none.
 *
 * The two error types this client owns are recognised by identity: the input generator's refusal through
 * the circuit API's own predicate — membership of the class on iOS and Android, its shape on the web,
 * where the package is not loaded — and the API client's `ApiError` by class. Everything else is read by
 * shape: an `AbortError` is this flow's `cancelled`, and any error carrying a `snake_case` `code` keeps
 * it, which covers the platform files, the native module and a Web Worker's reported failure. No message
 * is ever read: an exception's text can carry a field value.
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

/* --- Proof output validation ---------------------------------------------------------------- */

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
 * Refuses an engine result this client cannot submit: a proof or signal list the contract rejects, or one
 * whose public signals name another registry root, another nullifier salt or another issuer than the
 * inputs were built from. Both are `proof_output_invalid`, which keeps a proof the server would answer
 * `422 proof_invalid` for from leaving the device. Signals are read by name through `PUBLIC_SIGNAL_NAMES`,
 * never by a hard-coded position, and compared as numbers, so padding cannot make equal values differ.
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

/* --- Artefact download ---------------------------------------------------------------------- */

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
 * Wraps a reporter so a store that calls back on every chunk publishes at most one state change per
 * percentage point — and always the last one, so a bar that reaches complete shows complete.
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
 * The artefacts a proof needs, downloaded and hash-checked unless the caller resolved them already. A
 * missing artefact link and a platform without an artefact store are both `artifact_download_failed`:
 * in either case no artefacts can be obtained, so proving cannot start.
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

/* --- Proving -------------------------------------------------------------------------------- */

/**
 * Builds the witness inputs from the in-memory email bytes, yielding once first so a status can paint
 * before the synchronous work below blocks the JS thread, and measuring how long the build took.
 *
 * Split out of {@link prove} so the import flow can run it *before* it fetches anything: refusing an
 * unusable file first costs ~1.6 GB less than refusing after the artefacts (AAP 0.5.5, AAP 0.5.8).
 */
async function buildInputs(emlBytes: Uint8Array, config: ProveConfig): Promise<BuiltInputs> {
  // Let a status paint before the input generation below blocks the JS thread, which under Hermes is
  // the whole window in which a screen can render that step.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  // The generator is loaded before the span starts: on the web this call fetches the package's chunk,
  // the one download a first attempt on the entry route pays, and a figure measured across it would
  // not be the span AAP 0.5.5 defines. Every caller reaches the generator through here — `prove` when
  // it is asked to build, and `importAndProve` before it downloads the artefacts — so the load happens
  // once, on whichever path builds the witness, and always outside the measured span.
  const { buildCircuitInputs } = await loadCircuitApi();
  const startedAt = now();
  const { inputs, issuerId } = buildCircuitInputs(emlBytes, config.issuers, config.registry, {
    nullifierSalt: config.nullifierSalt,
  });
  return { inputs, issuerId, inputMs: now() - startedAt };
}

/**
 * Builds the witness inputs from the in-memory email bytes, proves them on this device and returns a
 * schema-validated proof (AAP 0.5.1, AAP 0.5.5).
 *
 * The DKIM key comes from the published registry through the signature's own `d=` and `s=` tags, so
 * nothing is looked up over the network and the email never leaves the device. `timings.totalMs` is the
 * measured span — input construction on the in-memory bytes, witness generation and proving — while a
 * download triggered here runs before the timer starts; inputs the caller already built are proved as
 * they are, which is how {@link importAndProve} refuses an unusable email before the download and still
 * measures the same span. Throws a {@link ProofErrorCode}: `prover_unavailable` with no usable engine,
 * `artifact_download_failed`, `cancelled`, an input generator code, `proof_output_invalid`, or whatever
 * the engine reports.
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
 * Submits a proof to `POST /itinerary-proofs` (AAP 0.5.4).
 *
 * The body is built key by key, so exactly `{ proof, publicSignals }` leaves the device: the whole of what
 * the server learns about the email, with a strict schema at both ends rejecting anything else
 * (AAP 0.12.2, criterion 3). A refusal arrives as an `ApiError` whose code {@link errorCodeOf} reads.
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
 * The whole flow behind the generate screen: read the picked file, build the witness inputs, fetch and
 * verify the artefacts, prove, submit, and release the app-owned copy on every path (AAP 0.5.5,
 * AAP 0.5.8).
 *
 * It drives `../state/proof-store` one step at a time — `reading`, `downloading` with a 0-1 progress
 * fraction, `proving`, `submitting`, `accepted` — and ends a refused attempt as `error` with one code, or
 * as `cancelled` when it was aborted; the store and the screens built on it never see an email byte, a
 * field value or a proof. One attempt runs at a time: a second concurrent call releases its own handle
 * and fails with `proof_in_progress`, rather than interleaving two proofs over one artefact set. The
 * inputs are built before the artefacts are fetched, so a file that is not a booking confirmation and an
 * email whose issuer the published configuration does not support are refused as the import states
 * AAP 0.5.8 requires without downloading the ~1.6 GB artefact set. Throws the error that ended the
 * attempt, after the store recorded its code.
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
    // Build the witness before fetching anything (AAP 0.5.5, AAP 0.5.8): an email that is not a
    // booking confirmation, or one whose issuer the published configuration does not support, is
    // refused here by the generator reading the signature's own `d=`/`s=` tags against
    // `zkConfig.issuers`, so it costs no download of the ~1.6 GB artefact set.
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

/* --- The picked-file hand-off ---------------------------------------------------------------- */

/**
 * Holds a picked or shared file for the generate screen, which is how the bytes travel between the two
 * screens without a route parameter or a store field ever holding them. A file already staged is
 * released first, so staging a replacement leaves exactly one app-owned copy and no orphan.
 */
export async function stagePendingEml(handle: EmlHandle): Promise<void> {
  const previous = pendingEml;
  pendingEml = handle;
  if (previous !== null) await releaseQuietly(previous);
}

/**
 * Takes the staged file and clears the slot, so exactly one flow can run {@link importAndProve} on it.
 * The caller owns releasing it — `importAndProve` does that itself.
 */
export function takePendingEml(): EmlHandle | null {
  const handle = pendingEml;
  pendingEml = null;
  return handle;
}

/**
 * Releases the staged file and clears the slot, for an import screen the user left before generating
 * (AAP 0.5.5). Safe to call when nothing is staged.
 */
export async function discardPendingEml(): Promise<void> {
  const handle = pendingEml;
  pendingEml = null;
  if (handle !== null) await releaseQuietly(handle);
}

/* --- Published configuration helpers -------------------------------------------------------- */

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
 * The booking sites the import screen can name: those the published configuration supports today, and
 * those still awaiting real confirmation emails — Booking.com and Airbnb — which it shows as not yet
 * supported (AAP 0.5.5, AAP 0.5.8).
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
