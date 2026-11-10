/**
 * Device proving on iOS and Android: rapidsnark through the local `tablemate-prover` module (AAP 0.2.4, AAP 0.3.4,
 * AAP 0.5.5), the half Metro resolves an extensionless `./prover` import to.
 *
 * It hands the witness over as an in-memory JSON string and returns the module's own
 * `{ proof, publicSignals, witnessMs, proveMs }`, already in the shape `./prover.ts` parses against `ProofSubmission`,
 * so this engine adds, normalizes and drops nothing. Neither secret of an attempt reaches JavaScript heap memory:
 * `inputsJson` is passed straight through, and the proving key stays at the verified path where rapidsnark opens it.
 * The module has no cancel API: an aborted attempt stops being waited for at once, while its native work runs to
 * completion and its result is discarded. Where there is no prover — Expo Go, the web bundle, and any native build made
 * without `pnpm circuits:native` — `available()` is false and the generate screen shows proving as unavailable, the
 * fallback AAP 0.2.4 allows.
 */

import { generateProof, isProverAvailable } from '../../modules/tablemate-prover';
import type { EngineOutput, ProverEngine, ResolvedArtifacts, ZkClientErrorCode } from './prover.ts';
export { artifactStore } from './artifacts.native.ts';

function fail(code: ZkClientErrorCode): Error {
  return Object.assign(new Error(code), { name: 'ZkClientError', code });
}

function available(): boolean {
  return isProverAvailable();
}

async function generate(
  inputsJson: string,
  artifacts: ResolvedArtifacts,
  signal?: AbortSignal,
): Promise<EngineOutput> {
  if (signal?.aborted === true) throw fail('cancelled');
  if (!isProverAvailable()) throw fail('prover_unavailable');
  const proving = generateProof(artifacts.zkey.location, inputsJson);
  if (signal === undefined) return proving;
  const cancel: { reject?: (reason: Error) => void } = {};
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel.reject = reject;
  });
  const onAbort = (): void => {
    cancel.reject?.(fail('cancelled'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([proving, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export const engine = { available, generate } satisfies ProverEngine;
