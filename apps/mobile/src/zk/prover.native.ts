/**
 * Device proving on iOS and Android: rapidsnark through the local `tablemate-prover` module (AAP 0.2.4,
 * AAP 0.3.4, AAP 0.5.5), the half Metro resolves an extensionless `./prover` import to.
 *
 * It hands the witness over as an in-memory JSON string and returns the module's own
 * `{ proof, publicSignals, witnessMs, proveMs }`: the native pipeline already serializes the proof into the shape
 * `./prover.ts` parses against `ProofSubmission`, so this engine adds, normalizes and drops nothing. Neither
 * secret of an attempt reaches JavaScript heap memory — `inputsJson` is passed straight through, never copied,
 * stored, logged or attached to an error, and the proving key stays at the verified path
 * `./artifacts.native.ts` returned, where rapidsnark opens it (AAP 0.5.5).
 *
 * The module has no cancel API: an aborted attempt stops being waited for at once, while its native work runs to
 * completion in the background and its result is discarded. Where there is no prover — Expo Go, the web bundle,
 * and any native build made without `pnpm circuits:native` — `available()` is false and the generate screen shows
 * proving as unavailable, the fallback AAP 0.2.4 allows.
 */

import { generateProof, isProverAvailable } from '../../modules/tablemate-prover';

import type { EngineOutput, ProverEngine, ResolvedArtifacts, ZkClientErrorCode } from './prover.ts';

/**
 * The resumable, digest-checked proving-key download and the record that says the key on disk is the artefact the
 * manifest publishes, re-exported because `./prover.ts` reads both halves of this platform from one namespace
 * (AAP 0.5.5).
 */
export { artifactStore } from './artifacts.native.ts';

/**
 * Shaped as the other platform files shape theirs: `name` is what `errorCodeOf` reads and `message` is the code
 * alone, so no path, URI or input byte can leave an attempt in an exception.
 */
function fail(code: ZkClientErrorCode): Error {
  return Object.assign(new Error(code), { name: 'ZkClientError', code });
}

/** Whether this build carries a prover: `isProverAvailable()` answers, and never throws. */
function available(): boolean {
  return isProverAvailable();
}

/**
 * An abort is honoured at both ends: an already-aborted signal fails before the native prover is asked to do
 * anything, and an abort during the proof rejects with `cancelled` at once; the listener is detached on whichever
 * settlement comes first, because a screen reuses its controller for the next attempt. The native proof itself is
 * not cancelled — the module offers no way to stop it — so it finishes in the background and its result is
 * discarded. A `TablemateProverError` from the module propagates unchanged and `errorCodeOf` reads its code
 * (AAP 0.5.5).
 */
async function generate(
  inputsJson: string,
  artifacts: ResolvedArtifacts,
  signal?: AbortSignal,
): Promise<EngineOutput> {
  if (signal?.aborted === true) throw fail('cancelled');
  if (!isProverAvailable()) throw fail('prover_unavailable');
  const proving = generateProof(artifacts.zkey.location, inputsJson);
  if (signal === undefined) return proving;
  // The abort handler rejects through this holder because the promise executor below runs
  // synchronously: by the time the race can settle, `reject` is set, and the one handler reference
  // serves both the rejection and the detach in `finally`.
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

/** The proving engine of iOS and Android: rapidsnark through the local native module (AAP 0.3.4). */
export const engine = { available, generate } satisfies ProverEngine;
