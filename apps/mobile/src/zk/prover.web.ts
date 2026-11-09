/**
 * Web proving: snarkjs 0.7.6 in a dedicated Worker, one Worker per attempt (AAP 0.3.4, AAP 0.5.5).
 *
 * Both halves of this platform come from `./artifacts.web.ts`, which owns the one place the client creates a Worker:
 * this engine reuses its launcher for the `prove` frame and re-exports its artefact store, so `./prover.ts` reads a
 * whole platform from one namespace, as it does from `prover.native.ts`.
 * The private inputs cross the boundary as the one opaque `inputsJson` string the caller built, which `postMessage`
 * structured-clones: the page keeps no reference to them. A Worker that proves holds the whole proving key plus the
 * witness buffers, and no message cancels a run in flight, so terminating it is both how that memory comes back and the
 * only cancellation this path has. A browser that cannot prove is reported as such and the proof is never routed to a
 * server: the `api` image holds no proving key, no circuit WASM and no private input.
 */
import Constants from 'expo-constants';
import { runWorker } from './artifacts.web.ts';
import type { RunWorkerOptions } from './artifacts.web.ts';
import type { EngineOutput, ProverEngine, ResolvedArtifacts, ZkClientErrorCode } from './prover.ts';
import type { WorkerResponse } from './prover.worker.ts';
export { artifactStore } from './artifacts.web.ts';

function fail(code: ZkClientErrorCode): Error {
  return Object.assign(new Error(code), { name: 'ZkClientError', code });
}

type ProvedFrame = Extract<WorkerResponse, { readonly type: 'proved' }>;

function appVersion(): string {
  return Constants.expoConfig?.version ?? 'unknown';
}

function available(): boolean {
  return typeof Worker === 'function' && typeof WebAssembly === 'object';
}

async function generate(
  inputsJson: string,
  artifacts: ResolvedArtifacts,
  signal?: AbortSignal,
): Promise<EngineOutput> {
  if (artifacts.wasm === null) throw fail('artifact_download_failed');
  const options: RunWorkerOptions = {};
  if (signal !== undefined) options.signal = signal;
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

export const engine = { available, generate } satisfies ProverEngine;
