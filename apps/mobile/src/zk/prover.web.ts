/**
 * Web proving: snarkjs 0.7.6 in a dedicated Worker, one Worker per attempt (AAP 0.3.4, AAP 0.5.5,
 * AAP 0.8.1).
 *
 * The web half of the platform split whose contract `./prover.ts` declares, and the half Metro
 * resolves an extensionless `./prover` import to in a browser. Both halves of this platform come from
 * `./artifacts.web.ts`, which owns the one place the client creates a Worker: this engine reuses its
 * launcher for the `prove` frame and re-exports its artefact store, so `./prover.ts` reads a whole
 * platform from one namespace, exactly as it does from `prover.native.ts`.
 *
 * The private inputs cross the boundary as the one opaque `inputsJson` string the caller built, which
 * `postMessage` structured-clones: the page keeps no reference to them, and the email bytes are not
 * here at all (AAP 0.5.5). While it proves, the Worker holds the whole proving key plus the witness
 * buffers, and no message cancels a run in flight, so terminating it is both how that memory comes
 * back and the only cancellation this path has — `runWorker` terminates it on every path.
 *
 * A browser that cannot prove is reported as such and the proof is never routed to a server: the
 * `api` image holds no proving key, no circuit WASM and no private input (AAP 0.12.2).
 */
import Constants from 'expo-constants';

import { runWorker } from './artifacts.web.ts';
import type { RunWorkerOptions } from './artifacts.web.ts';
import type { EngineOutput, ProverEngine, ResolvedArtifacts, ZkClientErrorCode } from './prover.ts';
import type { WorkerResponse } from './prover.worker.ts';

/**
 * The engine's other half: the streaming, digest-checked delivery of the circuit WASM and the proving
 * key — into the Origin Private File System where the browser gives us one, and from the artefacts'
 * published URLs where it cannot be used — and the record of what was verified. Re-exported from here
 * because `./prover.ts` reads both halves of this platform from one namespace (AAP 0.5.5).
 */
export { artifactStore } from './artifacts.web.ts';

/**
 * This client's error, shaped as the other platform file shapes its own: `name` is what `errorCodeOf`
 * reads, and `message` is the code alone, so no input byte can leave an attempt in an exception.
 */
function fail(code: ZkClientErrorCode): Error {
  return Object.assign(new Error(code), { name: 'ZkClientError', code });
}

/**
 * The reply a `prove` request is answered by, named from the Worker's own frame union so the four
 * fields returned below are checked against the protocol rather than restated here.
 */
type ProvedFrame = Extract<WorkerResponse, { readonly type: 'proved' }>;

/**
 * The running app's version, which the Worker records with every artefact it verified: an app update
 * can replace the circuit without touching the key's bytes, so the version that verified them is part
 * of their being current (AAP 0.5.5).
 */
function appVersion(): string {
  return Constants.expoConfig?.version ?? 'unknown';
}

/**
 * Whether this build can prove at all, as far as the page can tell: a Worker to prove in and the
 * WebAssembly the circuit runs on (AAP 0.3.4).
 *
 * The origin private file system is deliberately not a condition here: a browser that cannot use it
 * still proves locally, because the Worker streams the artefacts from their published URLs instead.
 * The synchronous access handle `prove` needs can only be reached from inside the Worker, so its
 * absence is not tested here either: that build's OPFS source reports
 * `artifact_storage_unavailable`, the Worker answers from the published URLs, and the attempt fails
 * only if the artefacts cannot be read from there at all.
 */
function available(): boolean {
  return typeof Worker === 'function' && typeof WebAssembly === 'object';
}

/**
 * Proves one witness in a fresh Worker against the artefacts `./artifacts.web.ts` verified, and
 * returns the proof, the public signals and the Worker's two component timings (AAP 0.5.5).
 *
 * Each artefact is read from where its own `location` says, inside the Worker: an OPFS entry is
 * re-verified by digest before anything is loaded, because OPFS metadata cannot show a same-length
 * edit, and a published URL — what `ensureArtifacts` answers with on a browser whose origin private
 * file system cannot be used — is hashed and length-checked as it streams. An
 * `artifact_hash_mismatch` therefore means the bytes are no longer the ones `ensureArtifacts` resolved:
 * the caller re-runs `ensureArtifacts` and proves again, which is the code `importAndProve` puts on the
 * store for the screen's retry (AAP 0.5.5, AAP 0.5.8).
 *
 * @param inputsJson - The witness, `JSON.stringify`ed by the caller and read only in the Worker.
 * @param artifacts - The verified artefacts. The web runs the witness generator from the WASM, so a
 *   resolved set without one cannot produce a witness at all.
 * @param signal - Aborts the attempt, which terminates the Worker.
 * @throws A `ZkClientError`: `artifact_download_failed` when the resolved set carries no WASM,
 *   `cancelled` on an abort, `worker_unavailable` in a browser with no Worker or a script that will
 *   not load, `worker_failed` when the Worker goes silent past `runWorker`'s deadline — a browser
 *   killing it under the memory the whole key takes (AAP 0.3.4) — or on a frame that will not
 *   serialize, and otherwise the code the Worker reported — `artifact_hash_mismatch`,
 *   `artifact_storage_unavailable`, `out_of_memory`, …
 */
async function generate(
  inputsJson: string,
  artifacts: ResolvedArtifacts,
  signal?: AbortSignal,
): Promise<EngineOutput> {
  if (artifacts.wasm === null) throw fail('artifact_download_failed');

  // Built only from what the caller supplied: `exactOptionalPropertyTypes` makes an explicit
  // `undefined` a different property from an absent one, and the frame carries only what is real.
  const options: RunWorkerOptions = {};
  if (signal !== undefined) options.signal = signal;

  // One request per Worker, so the frame id is a constant, and it names the reply form so the frame
  // that settles this call is the `proved` one. The Worker serves this call alone and `runWorker`
  // terminates it before the promise settles, which is what releases the key it loaded.
  const reply: ProvedFrame = await runWorker<'proved'>(
    { type: 'prove', id: 1, inputsJson, artifacts, appVersion: appVersion() },
    options,
  );

  return {
    proof: reply.proof,
    publicSignals: reply.publicSignals,
    witnessMs: reply.witnessMs,
    proveMs: reply.proveMs,
  };
}

/** The proving engine of the web: snarkjs in a dedicated Worker, one per attempt (AAP 0.3.4). */
export const engine = { available, generate } satisfies ProverEngine;
