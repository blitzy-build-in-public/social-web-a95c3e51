/**
 * The itinerary-proof check order and the nullifier rule's unit suite (AAP 0.5.5, 0.8.1).
 *
 * `verifyItineraryProof` answers the only question `POST /itinerary-proofs` asks — is this
 * `{ proof, publicSignals }` a proof of a stay this API accepts — and AAP 0.5.5 fixes the order its
 * checks run in: canonical field elements, the Groth16 verification, the published nullifier salt, a
 * registry root this process publishes, the city and issuer that root's registry holds, the two dates
 * as calendar dates, and the 1-120 day stay bound. The order is what gives each refusal its own code —
 * a salt that is not the published one is `proof_invalid` while an unlisted root is
 * `issuer_not_allowlisted` — so every row below is one change from an otherwise accepted submission,
 * and `verifyCalls` states whether a check before the verification already refused it.
 *
 * The two injectable dependencies AAP 0.5.5 leaves open keep this suite independent of the circuit
 * build, which is git-ignored and absent on a fresh checkout: the verification itself, and the key.
 * What is real is everything a refusal is decided against — the environment loader, the logger, and
 * the committed city, issuer and registry configuration.
 *
 * The second half covers the rule off the circuit, `nullifierOf` of `@tablemate/circuits`:
 * `Poseidon(refLength, pack[ref][0], pack[ref][1], salt)`. Hashing the length with the zero-padded
 * bytes is what makes one booking yield one nullifier however its reference is laid out, which is the
 * key `SpentNullifier` holds (AAP 0.12.2). The `409 nullifier_used` that insert answers belongs to the
 * route, and to `integration/proofs.test.ts`.
 *
 * @see AAP 0.5.4 for the code each refusal answers and the stay bound, 0.6.2 for the credential-free
 *   posture this environment takes, 0.11.1 for the table-driven convention, and 0.8.1 for this file.
 */

import { randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nullifierOf } from '@tablemate/circuits';
import { PUBLIC_SIGNAL_NAMES } from '@tablemate/shared';
import type { ErrorCode, ProofSubmission, PublicSignalName } from '@tablemate/shared';
import { createLogger, loadApiEnv } from '@tablemate/server-core';

import {
  readCitiesConfig,
  readIssuerConfigs,
  readRegistryFile,
  TEST_ISSUER_STEM,
} from '../../src/modules/proofs/registry.ts';
import {
  verifyItineraryProof,
  type Groth16Verify,
  type VerificationKey,
  type VerifierServices,
} from '../../src/modules/proofs/verifier.ts';

/**
 * The status each refusal code is answered with, restated from the contract rather than read from the
 * `ERROR_STATUS` table the thrown `AppError` derives its own status from (AAP 0.5.4).
 */
const STATUS = {
  proof_malformed: 400,
  proof_invalid: 422,
  issuer_not_allowlisted: 422,
  stay_out_of_range: 422,
} as const satisfies Partial<Record<ErrorCode, number>>;

/** One of the four codes {@link STATUS} covers. */
type RefusalCode = keyof typeof STATUS;

/* The refusals' own values, and the stay bound (AAP 0.5.4, 0.5.5) */

/** The published nullifier salt: a short decimal field element, public by design. */
const NULLIFIER_SALT = '1234567';

/** The salt a row makes a submission wrong with: distinct from the published one. */
const OTHER_SALT = '7654321';

/** A registry root no process publishes, so the root check has something to refuse. */
const UNSIGNED_ROOT = '42';

/** The stay bound of AAP 0.5.4, restated: a stay lasts 1 to 120 days and both ends are admitted. */
const STAY_MIN = 1;
const STAY_MAX = 120;

/**
 * The BN254 scalar field order `r`, written here as `verifier.ts` and `@tablemate/circuits`' `leaves.ts`
 * each write it — the package does not publish it from its entry point. It is the largest value a
 * public signal may carry and the bound a Poseidon output stays under: a signal at or above it is
 * `422 proof_invalid`, because the circuit would reduce it modulo `r` (AAP 0.5.5).
 */
const FIELD_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** The first day of the stay every row starts from, as the circuit's `YYYYMMDD` arrival signal. */
const ARRIVAL = '20261110';

/**
 * The raw environment of an `api` process in `test`: the credential-free modes the automated suite
 * runs in — `STRIPE_MODE=mock` with the proxy's address and no key at all, `TELEPHONY_MODE=off`,
 * `LLM_PROVIDER=fake` — and secrets generated per run, so no key reaches tracked source
 * (AAP 0.6.2, 0.12.2). Read through the real loader, so a variable this suite forgets fails the way it
 * would fail a start.
 */
function rawEnv(): Record<string, string> {
  return {
    APP_ENV: 'test',
    ZK_ALLOW_TEST_ISSUER: 'true',
    DATABASE_URL: 'postgresql://tablemate:tablemate@127.0.0.1:5432/tablemate_test',
    REDIS_URL: 'redis://127.0.0.1:6379/0',
    FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    FIELD_ENCRYPTION_KEY_ID: 'k1',
    ANALYTICS_SALT: randomBytes(32).toString('hex'),
    JWT_SECRET: randomBytes(32).toString('hex'),
    EMAIL_LOOKUP_PEPPER: randomBytes(32).toString('hex'),
    EXPERIMENT_SALT: randomBytes(32).toString('hex'),
    NULLIFIER_SALT,
    API_PUBLIC_URL: 'http://127.0.0.1:3000',
    WEB_ORIGIN: 'http://127.0.0.1:8081',
    VENUE_CONSOLE_ORIGIN: 'http://127.0.0.1:8082',
    ARTIFACTS_BASE_URL: 'http://127.0.0.1:8083',
    TERMS_VERSION: '2026-11-04',
    STRIPE_MODE: 'mock',
    STRIPE_API_BASE: 'http://127.0.0.1:12111',
    TELEPHONY_MODE: 'off',
    LLM_PROVIDER: 'fake',
  };
}

/**
 * The test-issuer configuration, whose active roots include the test registry's root; and the same
 * environment with `ZK_ALLOW_TEST_ISSUER` emptied, under which no test root is published at all
 * (AAP 0.5.5, 0.6.2). An empty value is how a raw environment drops a variable.
 */
const ENV = loadApiEnv(rawEnv());
const ENV_WITHOUT_TEST_ISSUER = loadApiEnv({ ...rawEnv(), ZK_ALLOW_TEST_ISSUER: '' });

/**
 * What the verifier reads of the app (AAP 0.5.1): the configuration, and the logger a rejection is
 * recorded in.
 */
const SERVICES: VerifierServices = {
  env: ENV,
  logger: createLogger({ name: 'unit', level: 'silent', appEnv: 'test' }),
};

/**
 * The injectable Groth16 verification (AAP 0.5.5): what stands in for snarkjs, so this suite needs no
 * built circuit. `beforeEach` returns it to accepting every proof, and a row that wants a refusal makes
 * it answer `false`.
 */
const verify = vi.fn<Groth16Verify>();

/**
 * The key the injected verification is handed: a well-formed key rather than a placeholder cast, so the
 * accepted rows run against the same shape the mounted key has. That the process reads the real file,
 * and holds no proving key at all, is for `no-prover.test.ts` and the integration suite.
 */
const VERIFICATION_KEY: VerificationKey = {
  protocol: 'groth16',
  curve: 'bn128',
  nPublic: PUBLIC_SIGNAL_NAMES.length,
};

/** The dependencies every call in this suite reads. */
const DEPS = { verify, verificationKey: VERIFICATION_KEY };

beforeEach(() => {
  verify.mockReset();
  verify.mockResolvedValue(true);
});

/* The accepted submission, built from the committed configuration (AAP 0.5.5) */

/** The configuration value a lookup found, or the failure naming what this run is missing. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`nullifier suite: ${what} is missing from the committed configuration`);
  }
  return value;
}

/** Lisbon, the city every accepted row proves a stay in (AAP 0.5.2). */
const LISBON = required(
  readCitiesConfig().cities.find((city) => city.id === 'lisbon'),
  'the lisbon city',
);

/** The synthetic test issuer, whose record the test registry carries (AAP 0.5.5). */
const TEST_ISSUER = required(
  readIssuerConfigs().find((entry) => entry.stem === TEST_ISSUER_STEM),
  'the tablemate-test issuer record',
);

/** The registry the test-issuer environment accepts, and the one root it publishes. */
const TEST_REGISTRY = readRegistryFile('test');

/** One signal value of an accepted submission, by name. */
type Signals = Readonly<Record<PublicSignalName, string>>;

/** The signals of an accepted submission: Lisbon, the test issuer, its registry root and its salt. */
const ACCEPTED_SIGNALS: Signals = {
  cityId: String(LISBON.circuitCityId),
  arrivalDate: ARRIVAL,
  departureDate: '20261117',
  issuerId: String(TEST_ISSUER.config.issuerId),
  nullifier: '987654321',
  registryRoot: TEST_REGISTRY.root,
  nullifierSalt: NULLIFIER_SALT,
};

/** A Groth16 proof of the shape `ProofSubmission` fixes; the injected verification is what reads it. */
const PROOF: ProofSubmission['proof'] = {
  pi_a: ['1', '2', '1'],
  pi_b: [
    ['1', '2'],
    ['3', '4'],
    ['1', '0'],
  ],
  pi_c: ['1', '2', '1'],
  protocol: 'groth16',
  curve: 'bn128',
};

/**
 * The accepted submission, or a copy of it with the named signals replaced. The signals are built by
 * walking `PUBLIC_SIGNAL_NAMES`, so every signal the contract fixes is present, in circuit order.
 */
function submission(overrides: Partial<Signals> = {}): ProofSubmission {
  return {
    proof: PROOF,
    publicSignals: PUBLIC_SIGNAL_NAMES.map((name) => overrides[name] ?? ACCEPTED_SIGNALS[name]),
  };
}

/** The `YYYY-MM-DD` spelling of a `YYYYMMDD` signal, as the verifier reports a stay. */
function iso(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/** The `YYYYMMDD` signal `days` whole days after `ymd`, by UTC arithmetic on the calendar date. */
function addDays(ymd: string, days: number): string {
  const at = new Date(
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)) + days),
  );
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  const day = String(at.getUTCDate()).padStart(2, '0');
  return `${at.getUTCFullYear()}${month}${day}`;
}

/* The check order (AAP 0.5.5) */

/**
 * One refusal: the signals that differ from an accepted submission, the code it must answer,
 * whether the injected verification refuses it, how often that verification must have run — 0 when a
 * check before it already refused — and the configuration to check against.
 */
interface RejectionRow {
  readonly name: string;
  readonly signals?: Partial<Signals>;
  readonly code: RefusalCode;
  readonly verified?: boolean;
  readonly verifyCalls?: number;
  readonly env?: typeof ENV;
}

/** One row per refusal, in the order the checks run. */
const REJECTIONS: readonly RejectionRow[] = [
  {
    name: 'a refused proof with a wrong salt and root',
    signals: { nullifierSalt: OTHER_SALT, registryRoot: UNSIGNED_ROOT },
    code: 'proof_invalid',
    verified: false,
  },
  {
    name: 'a signal outside the field shape',
    signals: { nullifier: '-1' },
    code: 'proof_malformed',
    verifyCalls: 0,
  },
  {
    name: 'a signal at the field order',
    signals: { nullifier: FIELD_ORDER.toString() },
    code: 'proof_invalid',
    verifyCalls: 0,
  },
  {
    name: 'a salt other than the published one',
    signals: { nullifierSalt: OTHER_SALT },
    code: 'proof_invalid',
  },
  {
    name: 'a wrong salt under an unlisted root',
    signals: { nullifierSalt: OTHER_SALT, registryRoot: UNSIGNED_ROOT },
    code: 'proof_invalid',
  },
  {
    name: 'a root this process does not publish',
    signals: { registryRoot: UNSIGNED_ROOT },
    code: 'issuer_not_allowlisted',
  },
  {
    name: 'the test registry root without ZK_ALLOW_TEST_ISSUER',
    code: 'issuer_not_allowlisted',
    env: ENV_WITHOUT_TEST_ISSUER,
  },
  { name: 'a city its registry does not hold', signals: { cityId: '999' }, code: 'proof_invalid' },
  {
    name: 'an issuer its registry does not hold',
    signals: { issuerId: '1000' },
    code: 'proof_invalid',
  },
  {
    name: 'an arrival that is not a calendar date',
    signals: { arrivalDate: '20260230' },
    code: 'proof_invalid',
  },
  { name: 'a stay of no days', signals: { departureDate: ARRIVAL }, code: 'stay_out_of_range' },
  {
    name: 'a stay past the bound',
    signals: { departureDate: addDays(ARRIVAL, STAY_MAX + 1) },
    code: 'stay_out_of_range',
  },
  {
    name: 'a departure before the arrival',
    signals: { departureDate: addDays(ARRIVAL, -1) },
    code: 'stay_out_of_range',
  },
];

/** The stays the bound admits, at both of its ends. */
const ACCEPTED_STAYS: readonly { readonly name: string; readonly days: number }[] = [
  { name: 'a stay of the minimum days', days: STAY_MIN },
  { name: 'a stay of the maximum days', days: STAY_MAX },
];

describe('verifyItineraryProof — the check order of AAP 0.5.5', () => {
  it.each(REJECTIONS)('$name is $code', async (row) => {
    if (row.verified === false) {
      verify.mockResolvedValue(false);
    }
    const checked = { env: row.env ?? SERVICES.env, logger: SERVICES.logger };

    await expect(
      verifyItineraryProof(checked, submission(row.signals), DEPS),
    ).rejects.toMatchObject({ code: row.code, httpStatus: STATUS[row.code] });

    expect(verify).toHaveBeenCalledTimes(row.verifyCalls ?? 1);
  });

  it.each(ACCEPTED_STAYS)('$name is accepted', async ({ days }) => {
    const departureDate = addDays(ARRIVAL, days);
    const accepted = submission({ departureDate });

    await expect(verifyItineraryProof(SERVICES, accepted, DEPS)).resolves.toEqual({
      cityId: 'lisbon',
      circuitCityId: LISBON.circuitCityId,
      arrivalDate: iso(ARRIVAL),
      departureDate: iso(departureDate),
      issuerId: TEST_ISSUER.config.issuerId,
      // The submitted signal, unchanged: the route keys SpentNullifier on it (AAP 0.5.5).
      nullifier: accepted.publicSignals[PUBLIC_SIGNAL_NAMES.indexOf('nullifier')],
      registryRoot: TEST_REGISTRY.root,
    });
  });

  it('verifies the submitted proof against the injected key and the signals in order', async () => {
    const accepted = submission();

    await verifyItineraryProof(SERVICES, accepted, DEPS);

    expect(verify).toHaveBeenCalledExactlyOnceWith(
      VERIFICATION_KEY,
      accepted.publicSignals,
      accepted.proof,
    );
  });
});

/* The nullifier rule (AAP 0.5.5) */

/** A booking reference: the canonical 1-32 bytes the circuit hashes with their length and the salt. */
const REFERENCE = new TextEncoder().encode('TM-8QF2K1');

/** A 32-byte reference: the packed width, whose last byte packs into its own field element. */
const WIDE_REFERENCE = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

/** The same 32 bytes with byte 31 replaced, so only the second packed element differs. */
const WIDE_REFERENCE_LAST_BYTE = Uint8Array.from({ length: 32 }, (_, i) =>
  i === 31 ? 200 : i + 1,
);

/** A 31-byte reference: one byte short of the packed width, so byte 30 is the highest it uses. */
const NARROW_REFERENCE = Uint8Array.from({ length: 31 }, (_, index) => index + 1);

/** The same 31 bytes with byte 30 replaced, the highest byte that a 31-byte reference carries. */
const NARROW_REFERENCE_LAST_BYTE = Uint8Array.from({ length: 31 }, (_, i) =>
  i === 30 ? 200 : i + 1,
);

/** `ABC`, and `ABC` with a trailing NUL byte: identical when packed, four bytes rather than three. */
const SHORT_REFERENCE = new TextEncoder().encode('ABC');
const SHORT_REFERENCE_PADDED = new TextEncoder().encode('ABC\u0000');

/** One pair of references the nullifier must tell apart, or hold equal, under one or two salts. */
interface NullifierRow {
  readonly name: string;
  readonly left: Uint8Array;
  readonly right: Uint8Array;
  /** The salt the right-hand reference is hashed under; the published one unless a row changes it. */
  readonly rightSalt?: string;
  readonly same: boolean;
}

/** One booking has one nullifier: only a different reference, length or salt may change it. */
const NULLIFIER_ROWS: readonly NullifierRow[] = [
  { name: 'the same reference and salt hash alike', left: REFERENCE, right: REFERENCE, same: true },
  {
    name: 'the same reference under another salt differs',
    left: REFERENCE,
    right: REFERENCE,
    rightSalt: OTHER_SALT,
    same: false,
  },
  {
    name: 'references differing only in byte 31 differ',
    left: WIDE_REFERENCE,
    right: WIDE_REFERENCE_LAST_BYTE,
    same: false,
  },
  {
    name: 'references differing only in byte 30 differ',
    left: NARROW_REFERENCE,
    right: NARROW_REFERENCE_LAST_BYTE,
    same: false,
  },
  {
    name: 'references packing alike at two lengths differ',
    left: SHORT_REFERENCE,
    right: SHORT_REFERENCE_PADDED,
    same: false,
  },
];

/** The references outside the 1-32 byte contract, each refused rather than hashed. */
const REFUSED_REFERENCES: readonly { readonly name: string; readonly reference: Uint8Array }[] = [
  { name: 'an empty reference', reference: new Uint8Array(0) },
  { name: 'a reference past the packed width', reference: new Uint8Array(33) },
];

describe('nullifierOf — the nullifier rule of AAP 0.5.5', () => {
  it.each(NULLIFIER_ROWS)('$name', ({ left, right, rightSalt, same }) => {
    const leftHash = nullifierOf(left, NULLIFIER_SALT);
    const rightHash = nullifierOf(right, rightSalt ?? NULLIFIER_SALT);

    expect(leftHash === rightHash).toBe(same);
  });

  it.each([1, 32])('a %i-byte reference hashes inside the field', (length) => {
    const bytes = Uint8Array.from({ length }, (_, index) => index + 1);
    const value = nullifierOf(bytes, NULLIFIER_SALT);

    expect(value).toBeGreaterThanOrEqual(0n);
    expect(value).toBeLessThan(FIELD_ORDER);
  });

  it.each(REFUSED_REFERENCES)('$name is refused', ({ reference }) => {
    expect(() => nullifierOf(reference, NULLIFIER_SALT)).toThrow(RangeError);
  });
});
