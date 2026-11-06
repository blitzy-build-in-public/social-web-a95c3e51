/**
 * The typed JavaScript binding of the native prover and file hasher (AAP 0.5.1, AAP 0.5.5): the one
 * seam between the TypeScript client and the Rust library `../expo-module.config.json` registers as
 * `TablemateProver`. `generateProof` passes the circuit inputs over as an in-memory JSON string and
 * parses the prover's JSON back; `sha256File` checks a downloaded proving key against its published
 * digest without holding the key in memory. Expo Go, the web build and any build made without
 * `pnpm circuits:native` have no such module, so the lookup is lazy and optional: importing this
 * file never throws, and `isProverAvailable` says whether proving can run (AAP 0.2.4, AAP 0.3.4).
 */

import { requireOptionalNativeModule } from 'expo';
import type { ProofSubmission, PUBLIC_SIGNAL_NAMES } from '@tablemate/shared';

/** What the native module exposes under its registered name; both functions answer with text. */
interface NativeTablemateProver {
  generateProof(zkeyPath: string, inputsJson: string): Promise<string>;
  sha256File(path: string): Promise<string>;
  isProverAvailable(): boolean;
}

/** The name the native modules register under, from `../expo-module.config.json`. */
const NATIVE_MODULE_NAME = 'TablemateProver';

/** A lowercase SHA-256 digest, the form `artifacts.manifest.json` publishes (AAP 0.5.5). */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The signal count the prover returns, tied to the published contract: `PUBLIC_SIGNAL_NAMES` is a
 * readonly tuple, so a change to its length stops this literal from type-checking and the count
 * check in `parseNativeResult` is revisited with it (AAP 0.5.4, AAP 0.12.2).
 */
const PUBLIC_SIGNAL_COUNT: (typeof PUBLIC_SIGNAL_NAMES)['length'] = 7;

/** The native module, or `null` where this build has none; `undefined` means not yet looked up. */
let cached: NativeTablemateProver | null | undefined;

/**
 * The native module when this build has one, else `null`. The lookup is deferred and its outcome
 * cached, so a build without the module never throws on import.
 */
function nativeModule(): NativeTablemateProver | null {
  if (cached === undefined) {
    try {
      cached = requireOptionalNativeModule<NativeTablemateProver>(NATIVE_MODULE_NAME);
    } catch {
      // The web and a native build without the generated libraries can also throw on lookup.
      cached = null;
    }
  }
  return cached ?? null;
}

/**
 * One locally generated proof: the Groth16 proof `POST /itinerary-proofs` accepts, the seven public
 * signals in circuit order, and two diagnostic timings. The span AAP 0.5.5 measures is timed by the
 * caller around the whole attempt (AAP 0.5.5).
 */
export type NativeProofResult = {
  proof: ProofSubmission['proof'];
  publicSignals: ProofSubmission['publicSignals'];
  witnessMs: number;
  proveMs: number;
};

/**
 * Every reason this binding can fail, one code per outcome, so a screen maps a code to a sentence
 * and no free text leaves the device (AAP 0.5.5). `prover_unavailable` is raised by this file
 * alone, when the build has no native module.
 */
export type ProverErrorCode =
  | 'prover_unavailable'
  | 'zkey_missing'
  | 'inputs_invalid'
  | 'prover_failed'
  | 'file_missing'
  | 'hash_failed';

/**
 * The only error this file raises. Its message is its code, because a native message can carry the
 * proving-key path and a wrapped error part of the private inputs: neither the native error, the
 * path nor `inputsJson` is attached to it (AAP 0.5.5).
 */
export class TablemateProverError extends Error {
  /** Which step failed. */
  readonly code: ProverErrorCode;

  constructor(code: ProverErrorCode) {
    super(code);
    this.name = 'TablemateProverError';
    this.code = code;
    // Babel does not preserve the prototype chain of a built-in subclass; `new.target` restores it.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The native codes as this file's, one record shared by both native functions; a code the platform
 * does not raise is mapped by the caller's own fallback (the sibling modules raise these five).
 */
const NATIVE_ERROR_CODES: Record<string, ProverErrorCode> = {
  ERR_ZKEY_MISSING: 'zkey_missing',
  ERR_INPUTS_INVALID: 'inputs_invalid',
  ERR_PROVER_FAILED: 'prover_failed',
  ERR_FILE_MISSING: 'file_missing',
  ERR_HASH_FAILED: 'hash_failed',
};

/** The `code` a rejected native promise carries, or `undefined` for anything else. */
function nativeCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

/** A rejection as one of this file's codes: the mapped code, or `fallback` when there is none. */
function mappedErrorCode(error: unknown, fallback: ProverErrorCode): ProverErrorCode {
  const code = nativeCode(error);
  if (code === undefined) return fallback;
  return NATIVE_ERROR_CODES[code] ?? fallback;
}

/**
 * A path the native side can open: the absolute path out of a `file://` URI, percent-decoded, or
 * `null` for an empty value or malformed percent-encoding. `expo-file-system` deals in URIs while
 * the native modules open plain paths.
 */
function toNativePath(pathOrUri: string): string | null {
  const withoutScheme = pathOrUri.replace(/^file:\/\//, '');
  try {
    const decoded = decodeURI(withoutScheme);
    return decoded.length === 0 ? null : decoded;
  } catch {
    return null;
  }
}

/** True when the value is exactly the seven public signals, every one of them a decimal string. */
function isSignalList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length === PUBLIC_SIGNAL_COUNT &&
    value.every((signal: unknown) => typeof signal === 'string')
  );
}

/** True when the value is a finite, non-negative number of milliseconds. */
function isTiming(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * The prover's JSON string as `NativeProofResult`, or `prover_failed`. Only the top-level shape is
 * checked, because `apps/mobile/src/zk/prover.ts` parses the result against `ProofSubmission`: this
 * keeps a malformed result from reading as a proof without a second copy of the contract here.
 */
function parseNativeResult(raw: string): NativeProofResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new TablemateProverError('prover_failed');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new TablemateProverError('prover_failed');
  }
  const { proof, publicSignals, witnessMs, proveMs } = parsed as {
    proof?: unknown;
    publicSignals?: unknown;
    witnessMs?: unknown;
    proveMs?: unknown;
  };

  if (typeof proof !== 'object' || proof === null || Array.isArray(proof)) {
    throw new TablemateProverError('prover_failed');
  }
  if (!isSignalList(publicSignals) || !isTiming(witnessMs) || !isTiming(proveMs)) {
    throw new TablemateProverError('prover_failed');
  }

  // An explicit field list: the prover's JSON may carry more than this shape, and these four fields
  // are all that leaves this file.
  return {
    proof: proof as ProofSubmission['proof'],
    publicSignals,
    witnessMs,
    proveMs,
  };
}

/** The native module when it can prove, or `prover_unavailable` before any native call is made. */
function prover(): NativeTablemateProver {
  const native = nativeModule();
  if (native === null || !isProverAvailable()) {
    throw new TablemateProverError('prover_unavailable');
  }
  return native;
}

/**
 * Whether this build can prove on the device: false in Expo Go, on the web and in any build made
 * without `pnpm circuits:native`, true only in a development or `bench` build that carries the
 * module and its Rust library. A caller shows proving as unavailable instead of crashing, and the
 * user then stays unverified, the fallback AAP 0.2.4 allows.
 */
export function isProverAvailable(): boolean {
  const native = nativeModule();
  if (native === null) return false;
  try {
    return native.isProverAvailable() === true;
  } catch {
    return false;
  }
}

/**
 * Proves the circuit inputs with the proving key at `zkeyPath` (AAP 0.5.1, AAP 0.5.5).
 *
 * `inputsJson` is the `JSON.stringify` of `buildCircuitInputs` output, in memory for this call
 * alone: never stored, never logged, never attached to an error. rapidsnark reads the key from the
 * path, so no copy of it reaches the JavaScript heap.
 *
 * @throws A `TablemateProverError` whose message is its code: `prover_unavailable` when this build
 *   has no prover, `zkey_missing`, `inputs_invalid`, or `prover_failed` for any other failure,
 *   including a result that is not the documented shape.
 */
export async function generateProof(
  zkeyPath: string,
  inputsJson: string,
): Promise<NativeProofResult> {
  const native = prover();

  const path = toNativePath(zkeyPath);
  if (path === null) throw new TablemateProverError('zkey_missing');

  let raw: unknown;
  try {
    raw = await native.generateProof(path, inputsJson);
  } catch (error: unknown) {
    throw new TablemateProverError(mappedErrorCode(error, 'prover_failed'));
  }
  if (typeof raw !== 'string') throw new TablemateProverError('prover_failed');

  return parseNativeResult(raw);
}

/**
 * The lowercase SHA-256 of the file at `path`, computed incrementally within bounded memory on both
 * platforms — CryptoKit on iOS, `MessageDigest` on Android — so a gigabyte-scale proving key is
 * never held whole (AAP 0.5.1, AAP 0.5.5).
 *
 * `apps/mobile/src/zk/artifacts.native.ts` compares this digest with the manifest that
 * `GET /v1/zk/config` publishes after a download, and re-hashes before a proving session whenever
 * the size, modification time or app version changed.
 *
 * @throws A `TablemateProverError` whose message is its code: `prover_unavailable`, `file_missing`,
 *   or `hash_failed` for any other failure, including a digest that is not 64 hex characters.
 */
export async function sha256File(path: string): Promise<string> {
  const native = prover();

  const target = toNativePath(path);
  if (target === null) throw new TablemateProverError('file_missing');

  let digest: unknown;
  try {
    digest = await native.sha256File(target);
  } catch (error: unknown) {
    throw new TablemateProverError(mappedErrorCode(error, 'hash_failed'));
  }

  const hex = typeof digest === 'string' ? digest.toLowerCase() : '';
  if (!SHA256_HEX.test(hex)) throw new TablemateProverError('hash_failed');
  return hex;
}
