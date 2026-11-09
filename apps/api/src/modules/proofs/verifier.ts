/**
 * Groth16 verification of a submitted itinerary proof, and the server-side checks that bind it to the circuit configuration
 * this API published.
 * `POST /itinerary-proofs` hands this module the only thing the server ever receives about a booking confirmation —
 * `{ proof, publicSignals }` — and answers with the stay that proof proves. The checks run in the order the contract fixes,
 * each answering its own code: every signal must be a canonical field element and the proof must verify against the mounted
 * verification key, or `422 proof_invalid`; the `nullifierSalt` signal must equal the published `NULLIFIER_SALT`; the
 * `registryRoot` signal must be a root this process publishes, or `422 issuer_not_allowlisted`; the `cityId` and `issuerId`
 * signals must name entries of that registry, the city's slug must resolve in the launch-city configuration and both date
 * signals must decode as calendar dates; and the stay must be between `STAY_MIN_DAYS` and `STAY_MAX_DAYS`, or
 * `422 stay_out_of_range`.
 * The last step belongs to the route: `routes.ts` spends the returned `nullifier` by inserting it into `SpentNullifier`, which
 * answers `409 nullifier_used`. Canonicalizing the signals first is what makes that insert the one key a booking has —
 * `FieldElement` admits leading zeros, so `"007"` and `"7"` would otherwise be two spellings of one nullifier and slip past a
 * unique index — and it is also what verification is fed.
 * No proving happens here, and the API image holds no proving key, no circuit WASM, no witness generator and no private input.
 * The hot path is deliberately free of I/O after the first call: ffjavascript's `buildBn128` reuses the singleton
 * `globalThis.curve_bn128` whenever it is asked without `singleThread`, and snarkjs' Groth16 verifier asks for the curve on
 * every call, so one built instance serves every later proof and a verification costs a pairing check rather than a
 * WebAssembly module build — which is what the 500 ms server-verification budget rests on. {@link closeVerifier} releases that
 * instance, because its worker threads would otherwise keep a process alive after `app.close()`.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { FieldElement, PUBLIC_SIGNAL_NAMES, STAY_MAX_DAYS, STAY_MIN_DAYS } from '@tablemate/shared';
import type { ErrorCode, ProofSubmission, PublicSignalName } from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { activeRegistries, circuitsBuildPath, cityBySlug } from './registry.ts';
import { signalDateToIso, stayDays } from './validity.ts';

// Type-only, so this file holds no runtime edge to the module that builds the app — the single `AppServices` declaration every module of `apps/api/src/modules` names.
import type { AppServices } from '../../app.ts';

const VERIFICATION_KEY_FILE = 'verification_key.json';

const BN128 = 'bn128';

/**
 * The BN254 scalar field order `r`: the largest value a public signal may carry. A larger one is reduced modulo `r`
 * in-circuit, so accepting it would verify a proof over a different number than the checks below read.
 */
const FIELD_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const PROOF_REJECTED = 'proof_rejected';

/** The BN254 curve instance ffjavascript builds, as the one member this module calls on it: releasing it stops the curve's
 * worker threads (AAP 0.5.1, `app.close()`). */
interface CachedCurve {
  terminate(): Promise<void>;
}

/**
 * The two parts of snarkjs 0.7.6 this module reaches, narrowed here because the package ships no declarations: `verify` takes
 * the parsed verification key object, the public signals in circuit order and the parsed proof.
 */
interface Snarkjs {
  readonly groth16: {
    verify(
      verificationKey: unknown,
      publicSignals: readonly string[],
      proof: unknown,
    ): Promise<boolean>;
  };
  /** Absent on a build that does not export it, in which case the first verification builds it. */
  readonly curves?: {
    getCurveFromName(name: string): Promise<CachedCurve>;
  };
}

/**
 * snarkjs 0.7.6, loaded through `createRequire` because it is CommonJS with no declarations — the one shape that both
 * typechecks and resolves under Node ESM, Vitest and tsx, as `apps/workers/src/menus/robots.ts` does for the same reason.
 */
const snarkjs = createRequire(import.meta.url)('snarkjs') as Snarkjs;

/**
 * The parsed `verification_key.json`: the Groth16 key `pnpm circuits:setup` writes and the `api` image mounts. Only the three
 * fields the shape check reads are typed; the key material is handed to snarkjs untouched.
 */
export interface VerificationKey {
  readonly protocol: string;
  readonly curve: string;
  readonly nPublic: number;
  readonly [field: string]: unknown;
}

/**
 * What verifying a proof reads of the app's services: the process configuration the proof is checked against, and the logger a
 * rejection is recorded in. Narrowed to those two — the narrow environment `./registry.ts` declares as `ZkEnv`, for exactly
 * this caller — so `apps/api/scripts/bench-verify.ts` can drive the verifier without building the app.
 */
export type VerifierServices = Pick<AppServices, 'env' | 'logger'>;

type VerifierLogger = VerifierServices['logger'];

/** The verifier a submission is checked with, injectable so `apps/api/test/unit/nullifier.test.ts` runs without built
 * artefacts; the default is snarkjs' own Groth16 verification. */
export type Groth16Verify = (
  verificationKey: unknown,
  publicSignals: readonly string[],
  proof: ProofSubmission['proof'],
) => Promise<boolean>;

/** snarkjs' own Groth16 verification, used unless a test injects one: the mounted key, the signals in circuit order and the
 * submitted proof, answered as a boolean. */
const defaultVerify: Groth16Verify = (verificationKey, publicSignals, proof) =>
  snarkjs.groth16.verify(verificationKey, publicSignals, proof);
export interface VerifiedItinerary {
  readonly cityId: string;
  readonly circuitCityId: number;
  readonly arrivalDate: string;
  readonly departureDate: string;
  /** The allowlisted issuer's integer id, from the proof's `issuerId` signal. */
  readonly issuerId: number;
  /** The booking's nullifier, canonical, for the route's `SpentNullifier` insert (AAP 0.5.5). */
  readonly nullifier: string;
  /** The active registry root the proof proved membership of, canonical. */
  readonly registryRoot: string;
}

/** The key load in flight or completed, so the file is read once per process. */
let keyLoad: Promise<VerificationKey> | undefined;

/** The curve build in flight or completed, so two proofs arriving together share one build. */
let curveBuild: Promise<CachedCurve | undefined> | undefined;

/** The built BN254 curve, while it is held. */
let cachedCurve: CachedCurve | undefined;

/**
 * Whether a parsed value is the Groth16 key over BN254 for this circuit: the protocol, the curve and the seven public signals
 * the submitted proofs carry. Anything else is refused rather than passed to snarkjs, whose failure for a mismatched key would
 * be indistinguishable from a rejectable proof.
 */
function isVerificationKey(value: unknown): value is VerificationKey {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const key = value as Record<string, unknown>;
  return (
    key.protocol === 'groth16' && key.curve === BN128 && key.nPublic === PUBLIC_SIGNAL_NAMES.length
  );
}

/** Whether a read failed because the file is not there, the one failure a late mount clears. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * The rejection of a submission this API will not accept as a proof of a stay, recorded as one line naming the event and the
 * code and nothing else: no signal, no root, no salt, no proof.
 */
function reject(logger: VerifierLogger, code: ErrorCode): AppError {
  logger.warn({ event: PROOF_REJECTED, code }, PROOF_REJECTED);
  return new AppError(code);
}

/**
 * Reads, parses and checks `verification_key.json`.
 * A missing file, or one that is not the key, is a `503 service_unavailable`, because proof submission has no way to verify
 * without it. The failure travels as the thrown error's `cause` — the `ENOENT` naming the file, or the `zk_vkey_invalid` marker
 * an operator greps for with the parse failure beneath it — so the one line it is recorded by is the errors plugin's, which logs
 * the code with the head of that chain. `main.ts` requires the file outright in staging and production, so this state is
 * reachable only where a build has not run or the mount is absent.
 */
async function readVerificationKey(): Promise<VerificationKey> {
  const file = VERIFICATION_KEY_FILE;
  let text: string;
  try {
    text = await readFile(circuitsBuildPath(file), 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      throw new AppError('service_unavailable', undefined, { cause: error });
    }
    throw error;
  }
  let parsed: unknown;
  let parseError: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    parseError = error;
    parsed = undefined;
  }
  if (!isVerificationKey(parsed)) {
    throw new AppError('service_unavailable', undefined, {
      cause: new Error(
        'zk_vkey_invalid',
        parseError === undefined ? undefined : { cause: parseError },
      ),
    });
  }
  return parsed;
}

/**
 * The verification key, read from `packages/circuits/build/verification_key.json` once and kept.
 * Only a successful read is kept: a failure is cleared, so a build directory mounted after the process started is picked up by
 * the next proof submission, and a suite that never proves still starts without the artefacts.
 * @throws {AppError} `service_unavailable` when the file is absent, is not JSON, or is not the Groth16 key over BN254 with
 *   seven public signals.
 */
export async function loadVerificationKey(): Promise<VerificationKey> {
  const inFlight = keyLoad ?? readVerificationKey();
  keyLoad = inFlight;
  try {
    return await inFlight;
  } catch (error) {
    if (keyLoad === inFlight) {
      keyLoad = undefined;
    }
    throw error;
  }
}

/**
 * Builds the process-wide BN254 curve before the first verification, so no request pays for it.
 * A build that fails is not kept and does not fail the request: the verification that follows builds the instance itself, and
 * whatever it then reports is answered in the contract's own terms.
 */
async function warmCurve(): Promise<void> {
  const curves = snarkjs.curves;
  if (cachedCurve !== undefined || curves === undefined) {
    return;
  }
  try {
    cachedCurve = await (curveBuild ??= curves.getCurveFromName(BN128));
  } catch {
    curveBuild = undefined;
  }
}

/**
 * Releases the shared BN254 curve: `app.ts` wires this into the instance's `onClose`, so a closed app leaves no curve worker
 * thread behind to keep the process, a Vitest run or a graceful shutdown alive. Idempotent and never throwing: a second close,
 * or a close before any proof arrived, does nothing.
 */
export async function closeVerifier(): Promise<void> {
  const curve = cachedCurve;
  cachedCurve = undefined;
  curveBuild = undefined;
  if (curve === undefined) {
    return;
  }
  try {
    await curve.terminate();
  } catch {
    // The instance was already terminated, or its threads are gone: nothing left to release.
  }
}

/** Each signal's position in circuit order, off the shared contract: a signal is read by name, never by a bare index written
 * here. */
const SIGNAL_INDEX = new Map<PublicSignalName, number>(
  PUBLIC_SIGNAL_NAMES.map((name, index) => [name, index] as const),
);

/**
 * One signal's text, or the `400 proof_malformed` the route answers a submission that does not carry the seven signals
 * `ProofSubmission` declares. Re-checked here with the schema the route already parsed with, so a direct caller meets the same
 * bound.
 */
function signalText(signals: readonly string[], name: PublicSignalName): string {
  const index = SIGNAL_INDEX.get(name);
  const value = index === undefined ? undefined : signals[index];
  if (value === undefined || !FieldElement.safeParse(value).success) {
    throw new AppError('proof_malformed');
  }
  return value;
}

/** The integer one signal denotes, or `422 proof_invalid` when it is not a safe integer. */
function signalInteger(value: bigint, logger: VerifierLogger): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw reject(logger, 'proof_invalid');
  }
  return asNumber;
}

/**
 * The seven signals as canonical field elements.
 * A signal outside the shared `FieldElement` shape is `400 proof_malformed`, because such a submission is not the contract's
 * body at all; one at or above {@link FIELD_ORDER} is `422 proof_invalid`, because the circuit reduces it modulo the field order
 * and would therefore verify a different number than the checks below read. Both are answered with a code and a log line and
 * never with a value.
 * The keys of `PUBLIC_SIGNAL_NAMES` are exactly the record's keys by construction, which is why the loop's result is the
 * complete record.
 */
function canonicalSignals(
  signals: readonly string[],
  logger: VerifierLogger,
): Readonly<Record<PublicSignalName, bigint>> {
  const canonical = {} as Record<PublicSignalName, bigint>;
  for (const name of PUBLIC_SIGNAL_NAMES) {
    const value = BigInt(signalText(signals, name));
    if (value >= FIELD_ORDER) {
      throw reject(logger, 'proof_invalid');
    }
    canonical[name] = value;
  }
  return canonical;
}

/**
 * Verifies a submitted itinerary proof and checks that it proves a stay this API accepts.
 * The checks run in the order the module documentation lists, and the value returned is the stay the proof proves, with its
 * nullifier in canonical form for the route's `SpentNullifier` insert.
 * @throws {AppError} `proof_malformed` for a submission that does not carry the seven signals; `proof_invalid` for a signal
 *   outside the field, a proof that does not verify, a salt that is not the published one, an unknown city or issuer, or a date
 *   signal that is not a calendar date; `issuer_not_allowlisted` for a registry root this process does not publish;
 *   `stay_out_of_range` for a stay outside `STAY_MIN_DAYS` to `STAY_MAX_DAYS` days; `service_unavailable` when the verification
 *   key is absent or unusable.
 */
export async function verifyItineraryProof(
  services: VerifierServices,
  submission: ProofSubmission,
  deps: { readonly verify?: Groth16Verify; readonly verificationKey?: VerificationKey } = {},
): Promise<VerifiedItinerary> {
  const logger = services.logger;
  // 0. Canonical field elements.
  const canonical = canonicalSignals(submission.publicSignals, logger);
  const signals = PUBLIC_SIGNAL_NAMES.map((name) => canonical[name].toString());
  // 1. Groth16 verification against the mounted key.
  const verificationKey = deps.verificationKey ?? (await loadVerificationKey());
  const verify = deps.verify ?? defaultVerify;
  if (deps.verify === undefined) {
    await warmCurve();
  }
  let verified: boolean;
  try {
    verified = await verify(verificationKey, signals, submission.proof);
  } catch {
    // A malformed point throws inside the verifier rather than answering false; both are a proof this
    // API does not accept, and the thrown value can carry signal material that must not be logged.
    throw reject(logger, 'proof_invalid');
  }
  if (!verified) {
    throw reject(logger, 'proof_invalid');
  }
  // 2. The published nullifier salt: it is what makes the nullifier below the one this API's
  // spent-nullifier registry holds, so a proof built for another salt is not this API's proof.
  if (canonical.nullifierSalt !== BigInt(services.env.NULLIFIER_SALT)) {
    throw reject(logger, 'proof_invalid');
  }
  // 3. An active registry root. The proof's city and issuer are then read out of that same registry,
  // so a root and its entries can never be mixed.
  const registry = activeRegistries(services.env).find(
    (candidate) => BigInt(candidate.root) === canonical.registryRoot,
  );
  if (registry === undefined) {
    throw reject(logger, 'issuer_not_allowlisted');
  }
  // 4. The city, the issuer and the two dates, all of which the registry and the launch-city
  // configuration decide.
  const circuitCityId = signalInteger(canonical.cityId, logger);
  const registryCity = registry.cities.find((entry) => entry.cityId === circuitCityId);
  const city = registryCity === undefined ? undefined : cityBySlug(registryCity.slug);
  if (registryCity === undefined || city === undefined) {
    throw reject(logger, 'proof_invalid');
  }
  const issuerId = signalInteger(canonical.issuerId, logger);
  if (!registry.issuers.some((entry) => entry.issuerId === issuerId)) {
    throw reject(logger, 'proof_invalid');
  }
  const arrivalDate = signalDateToIso(canonical.arrivalDate);
  const departureDate = signalDateToIso(canonical.departureDate);
  if (arrivalDate === null || departureDate === null) {
    throw reject(logger, 'proof_invalid');
  }
  // 5. The stay bound.
  const stay = stayDays(arrivalDate, departureDate);
  if (stay < STAY_MIN_DAYS || stay > STAY_MAX_DAYS) {
    throw reject(logger, 'stay_out_of_range');
  }
  return {
    // The configured city's own id: the registry was built from this configuration, so the two agree,
    // and the row is stored under the slug the rest of the API uses.
    cityId: city.id,
    circuitCityId: city.circuitCityId,
    arrivalDate,
    departureDate,
    issuerId,
    nullifier: canonical.nullifier.toString(),
    registryRoot: canonical.registryRoot.toString(),
  };
}
