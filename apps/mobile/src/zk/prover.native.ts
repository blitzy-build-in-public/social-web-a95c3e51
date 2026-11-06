/**
 * Device proving on iOS and Android: rapidsnark through the local `tablemate-prover` module
 * (AAP 0.2.4, AAP 0.3.4, AAP 0.5.5, AAP 0.8.1).
 *
 * The native half of the platform split whose contract `./prover.ts` declares, and the half Metro
 * resolves an extensionless `./prover` import to on iOS and Android. It hands the witness over as an
 * in-memory JSON string and returns the module's own `{ proof, publicSignals, witnessMs, proveMs }`:
 * the native pipeline already serializes the proof into the `Groth16Proof` shape that `./prover.ts`
 * parses against `ProofSubmission`, so this engine adds, normalizes and drops nothing.
 *
 * Neither secret of an attempt reaches JavaScript heap memory. The email is not here at all:
 * `inputsJson` is passed straight through, never copied, stored, logged or attached to an error. And
 * the proving key stays at the verified path `./artifacts.native.ts` returned, where rapidsnark
 * opens it, so the whole key is never read into the heap (AAP 0.5.5).
 *
 * **The module has no cancel API.** An aborted attempt stops being waited for at once, while its
 * native work runs to completion in the background and its result is discarded. Progress reporting
 * and true cancellation are later integration work, after each platform passes the native smoke
 * check this engine exists for (AAP 0.2.4, AAP 0.8.2).
 *
 * Where there is no prover — Expo Go, the web bundle, which loads `prover.web.ts` instead, and any
 * native build made without `pnpm circuits:native` — `available()` is false, the generate screen
 * shows proving as unavailable, and the user stays unverified: the fallback AAP 0.2.4 allows.
 */

import { generateProof, isProverAvailable } from '../../modules/tablemate-prover';

import type { EngineOutput, ProverEngine, ResolvedArtifacts, ZkClientErrorCode } from './prover.ts';

/**
 * The engine's other half: the resumable, digest-checked proving-key download and the record that
 * says the key on disk is the artefact the manifest publishes (AAP 0.5.5). Re-exported from here
 * because `./prover.ts` reads both halves of this platform from one namespace.
 */
export { artifactStore } from './artifacts.native.ts';

/**
 * This client's error, shaped as the other platform files shape theirs: `name` is what
 * `errorCodeOf` reads, and `message` is the code alone, so no path, URI or input byte can leave an
 * attempt in an exception.
 */
function fail(code: ZkClientErrorCode): Error {
  return Object.assign(new Error(code), { name: 'ZkClientError', code });
}

/** Whether this build carries a prover: `isProverAvailable()` answers, and never throws. */
function available(): boolean {
  return isProverAvailable();
}

/**
 * Proves one witness against the proving key at `artifacts.zkey.location` and returns the module's
 * proof, public signals and two diagnostic timings (AAP 0.5.5).
 *
 * An abort is honoured at both ends: an already-aborted signal fails before the native prover is
 * asked to do anything, and an abort during the proof rejects with `cancelled` at once. The listener
 * is detached on whichever settlement comes first, because a screen reuses its controller for the
 * next attempt. The native proof itself is **not** cancelled — the module offers no way to stop it,
 * so it finishes in the background and its result is discarded.
 *
 * A `TablemateProverError` from the module propagates unchanged (`prover_unavailable`,
 * `zkey_missing`, `inputs_invalid`, `prover_failed`), and `errorCodeOf` reads its code.
 *
 * @param inputsJson - The witness, `JSON.stringify`ed by the caller and read here exactly once.
 * @param artifacts - Resolved artefacts; only `zkey` is used, and only as the path rapidsnark opens.
 * @param signal - Aborts the wait for the proof.
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
