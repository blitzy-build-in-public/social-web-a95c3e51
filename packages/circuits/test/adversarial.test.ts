/**
 * The itinerary circuit's adversarial suite: one change at a time away from an honest witness, and the
 * circuit must refuse every one of them (AAP 0.5.5 "Adversarial circuit tests", AAP 0.12.2 "One booking backs
 * one proof"). Six classes of substitution are exercised:
 *
 *   - the key that verified the signature is outside the published registry, or the registry leaf the path
 *     names holds a different modulus;
 *   - any anchor, anchor length, terminator, charset or date format differs from the registered template, with
 *     the signed email untouched;
 *   - the city alias, the city id, the leaf type domain tag or a Merkle path bit is substituted;
 *   - an anchor index, a value length or the body window is moved by one step;
 *   - an anchor occurs twice in the window, or only in the headers a body extraction never reads;
 *   - a date no calendar has, a second value length over one booking reference, or a non-zero byte written
 *     past a value's length.
 *
 * Every body-changing case is DKIM-signed by `scripts/make-test-fixtures.ts` with the test issuer's key, and
 * each one's honest signature is asserted to verify first, so a refusal here demonstrates the extraction,
 * uniqueness, date or window constraint rather than a broken signature. Nothing here writes to the
 * repository: `build/` is only read, and the one temporary wrapper the padding case needs is compiled in an
 * `os.tmpdir()` directory removed in `afterAll`.
 *
 * Prerequisites throw rather than skip, so a missing build or a circom outside 2.1.9 is visible instead of a
 * green suite over an unproved circuit. A witness of this circuit carries about 2.5 million constraints, so a
 * run wants a raised heap (`NODE_OPTIONS=--max-old-space-size=8192`), which a test file cannot raise for
 * itself.
 */
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHARSET_CODE,
  CitiesFile,
  DATE_FORMAT_CODE,
  IssuerConfig,
  PUBLIC_SIGNAL_NAMES,
  RegistryFile,
} from '@tablemate/shared';
import type { IssuerTemplate, PublicSignalName } from '@tablemate/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MAX_BODY_LENGTH,
  MAX_BODY_WINDOW,
  assembleInputs,
  buildCircuitInputs,
  buildEmailVerifierInputs,
} from '../src/inputs/build-inputs.ts';
import type {
  BuildCircuitInputsResult,
  CircuitInputs,
  EmailVerifierParts,
  SupportedIssuer,
} from '../src/inputs/build-inputs.ts';
import { canonicalSignedHeader, canonicalizeBody } from '../src/inputs/dkim-canonicalize.ts';
import { CR, CircuitInputError, LF, indexOfBytes, parseEml } from '../src/inputs/eml-parse.ts';
import type { DkimSignature, ParsedEml } from '../src/inputs/eml-parse.ts';
import { generatePartialSha, sha256Pad } from '../src/inputs/sha-partial.ts';
import { locateField, locateFields, removeSoftLineBreaks } from '../src/inputs/template-locate.ts';
import { MAX_VALUE_BYTES } from '../src/inputs/template-locate.ts';
import type { FieldLocation } from '../src/inputs/template-locate.ts';
import { buildMerkleTree, buildRegistry } from '../src/registry/merkle.ts';
import { TEMPLATE_FIELD_ORDER, templateParams } from '../src/registry/template-hash.ts';
import type { TemplateParams } from '../src/registry/template-hash.ts';

/* Paths, the compiler, and the one fixed salt these witnesses are built with (AAP 0.5.5, AAP 0.8.1). */

/** This package's directory: this file sits one level below it, in `test/`. */
const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The repository root, two levels above the package. */
const REPO_ROOT = path.resolve(PKG_DIR, '..', '..');

/** The git-ignored build directory `pnpm circuits:compile` writes into. */
const BUILD = path.join(PKG_DIR, 'build');

/** The committed fixtures, signed by `scripts/make-test-fixtures.ts`. */
const FIXTURE_DIR = path.join(PKG_DIR, 'fixtures', 'test-issuer');

/** The circuit source `circom_tester` is pointed at; it never recompiles the main circuit here. */
const CIRCUIT_SOURCE = path.join(PKG_DIR, 'circuits', 'tablemate_itinerary.circom');

/** The library holding `FieldExtract`, the one template the padding case compiles on its own. */
const ANCHOR_EXTRACT_LIB = path.join(PKG_DIR, 'circuits', 'lib', 'anchor_extract.circom');

/* The compile's two artefacts, and the symbols of the main circuit this suite reads with them. */
const CIRCUIT_WASM = path.join(BUILD, 'tablemate_itinerary_js', 'tablemate_itinerary.wasm');
const CIRCUIT_SYMBOLS = path.join(BUILD, 'tablemate_itinerary.sym');

/**
 * circom's include search path: the circuit library first, where `anchor_extract.circom` and its
 * siblings live, then both `node_modules` roots, because a hoisted install keeps `@zk-email/circuits`
 * and `circomlib` at the repository root while a package-local copy may hold either instead.
 */
const INCLUDE = [
  path.join(PKG_DIR, 'circuits', 'lib'),
  path.join(PKG_DIR, 'node_modules'),
  path.join(REPO_ROOT, 'node_modules'),
];

/** The only circom line this circuit is built with: 2.2.x compiles a different constraint set. */
const REQUIRED_CIRCOM = '2.1.9';

/** Where 2.1.9 comes from, said once, in the message a missing compiler produces. */
const CIRCOM_INSTALL = 'cargo install --locked --git https://github.com/iden3/circom --tag v2.1.9';

/** The fixed public salt these witnesses are built with; the published one is asserted nowhere here. */
const NULLIFIER_SALT = '123456789';

/** Ten minutes: loading a circuit of a few million signals and generating one witness from it. */
const CIRCUIT_TIMEOUT_MS = 10 * 60_000;

/** Five minutes: one witness, plus the compilation the padding case adds in its own hook. */
const WITNESS_TIMEOUT_MS = 5 * 60_000;

/** The two window rules of `lib/body_window.circom`, as the cases below move the cut by. */
const WINDOW_STEP_BYTES = 64;

/**
 * The byte every padding row writes where the circuit requires a zero: a printable ASCII byte, so a
 * witness carrying it is one no email could have produced past a value's length.
 */
const TAMPER_BYTE = 0x41;

/** A path bit `bit · (bit − 1) === 0` cannot admit: neither of the two children a node has. */
const NON_BINARY_BIT = '2';

/** One committed fixture, by its path below `fixtures/test-issuer/`. */
type FixturePath =
  | 'valid.eml'
  | 'valid-second.eml'
  | 'other-issuer.eml'
  | 'adversarial/duplicate-anchor.eml'
  | 'adversarial/header-field.eml'
  | 'adversarial/date-feb-30.eml'
  | 'adversarial/date-month-13.eml'
  | 'adversarial/date-non-digit.eml';

/* circom_tester 0.0.24: CommonJS, untyped, and loaded through `createRequire`. */

/** The part of circom_tester's `WasmTester` this suite calls. */
interface WasmCircuit {
  /** `sanityCheck` makes the generator assert every `===` constraint, which is what a rejection is. */
  calculateWitness(input: object, sanityCheck?: boolean): Promise<bigint[]>;

  /** Reads the compiled `.sym` table; only the small wrapper below ever needs it. */
  loadSymbols(): Promise<void>;

  /** Every signal of the compiled circuit, by the name the circuit writes it under. */
  symbols: Record<string, { varIdx: number }>;

  /** Evaluates the compiled R1CS against a given witness: how a tampered witness is refused. */
  checkConstraints(witness: readonly bigint[]): Promise<void>;
}

/** `require('circom_tester').wasm`, narrowed to the options this file passes. */
interface CircomTester {
  wasm(
    source: string,
    options: { output: string; recompile?: boolean; include?: string[] },
  ): Promise<WasmCircuit>;
}

/** The one shape that both typechecks and resolves under Node ESM, Vitest and tsx. */
const circomTester = createRequire(import.meta.url)('circom_tester') as CircomTester;

/* The committed configuration the honest witness is built from. */

/**
 * The synthetic test issuer whose RSA-2048 key signed every fixture (AAP 0.5.5). The record itself, so
 * both the registry builder and the input builder take it.
 */
const issuer: IssuerConfig = readConfig('config/issuers/tablemate-test.json', IssuerConfig);

/** The committed test registry: the depth-8 tree both Merkle paths must reach. */
const registry = readConfig('config/registry/test.json', RegistryFile);

/** The launch cities, whose aliases the registry's city leaves carry. */
const cities = readConfig('config/cities.json', CitiesFile).cities;

/** The test issuer's registered template: the extraction parameters a mutation must differ from. */
const params: TemplateParams = templateParams(templateOf(issuer));

/** The registry's tree, rebuilt from its leaves: both paths of every case below come from it. */
const registryTree = buildMerkleTree(registry.leaves.map((leaf) => BigInt(leaf)));

/** Reads one committed configuration file with the schema the registry builder and the API share. */
function readConfig<T>(relative: string, schema: { parse(value: unknown): T }): T {
  const text = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
  return schema.parse(JSON.parse(text) as unknown);
}

/** Reads `list[index]`, which `noUncheckedIndexedAccess` widens, throwing instead of widening. */
function at<T>(list: readonly T[], index: number, what: string): T {
  const value = list[index];
  if (value === undefined) {
    throw new Error(`${what}: no entry at index ${index}`);
  }
  return value;
}

/** One byte of a window, which `noUncheckedIndexedAccess` widens the same way. */
function byteAt(bytes: Uint8Array, offset: number, what: string): number {
  const byte = bytes[offset];
  if (byte === undefined) {
    throw new Error(`${what}: no byte at offset ${offset}`);
  }
  return byte;
}

/** The issuer's template, which only an issuer awaiting samples may lack. */
function templateOf(value: SupportedIssuer): IssuerTemplate {
  if (value.template === null) {
    throw new Error('the test issuer record carries no template');
  }
  return value.template;
}

/** One committed fixture's bytes, read into memory only: no email reaches a file this suite writes. */
function fixture(file: FixturePath): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURE_DIR, file)));
}

/* The main circuit, loaded once for every witness case below (AAP 0.5.5). */

let mainCircuit: WasmCircuit | undefined;

beforeAll(async () => {
  demand(
    circomVersion().includes(REQUIRED_CIRCOM),
    `circom ${REQUIRED_CIRCOM} is required to load this circuit, but PATH has: ` +
      `${circomVersion().trim() === '' ? 'no circom' : circomVersion().trim()}; ` +
      `install it with: ${CIRCOM_INSTALL}`,
  );
  demand(existsSync(CIRCUIT_WASM), `${CIRCUIT_WASM} is missing: run pnpm circuits:compile`);
  demand(existsSync(CIRCUIT_SYMBOLS), `${CIRCUIT_SYMBOLS} is missing: run pnpm circuits:compile`);
  // `recompile: false` reads the compile's own wasm, so nothing here depends on circom agreeing with
  // the build's flags beyond the version checked above. The include array is copied because
  // circom_tester appends the source's directory to whatever array it is handed.
  mainCircuit = await circomTester.wasm(CIRCUIT_SOURCE, {
    output: BUILD,
    recompile: false,
    include: [...INCLUDE],
  });
}, CIRCUIT_TIMEOUT_MS);

/** `circom --version` as the compiler prints it, or nothing when it is not on PATH. */
function circomVersion(): string {
  try {
    return execFileSync('circom', ['--version'], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

/** The loaded circuit, or a failure naming the hook that loads it. */
function circuit(): WasmCircuit {
  demand(mainCircuit !== undefined, 'the circuit was not loaded: its beforeAll hook failed');
  return mainCircuit;
}

/** Throws unless `condition` holds: every prerequisite fails the run instead of skipping it. */
function demand(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * The verdict of every row below: circom turns a violated `===` into an assertion failure, and
 * `sanityCheck` is what makes the generator evaluate the constraints instead of walking past them.
 */
async function expectRejected(inputs: CircuitInputs): Promise<void> {
  await expect(circuit().calculateWitness(inputs, true)).rejects.toThrow();
}

/** The other verdict: the honest baseline, and the row showing a substitution case is coherent. */
async function expectAccepted(inputs: CircuitInputs): Promise<bigint[]> {
  const witness = await circuit().calculateWitness(inputs, true);
  expect(witness.length).toBeGreaterThan(1);
  return witness;
}

/* The honest witness: the email, its email-verifier parts, its located fields and its two paths. */

/** The honest `valid.eml` inputs and the two ids they prove, built once and never re-derived. */
const honest: BuildCircuitInputsResult = buildCircuitInputs(
  fixture('valid.eml'),
  [issuer],
  registry,
  {
    nullifierSalt: NULLIFIER_SALT,
  },
);

/** The honest EmailVerifier half, kept beside the assembled inputs for the cases that rebuild one. */
const honestParts: EmailVerifierParts = buildEmailVerifierInputs(fixture('valid.eml'), [issuer]);

/** The four fields the honest witness's template locates, in `TEMPLATE_FIELD_ORDER` order. */
const honestFields: FieldLocation[] = locateFields(honestParts.decodedEmailBodyIn, params);

/** The decoded body window the honest witness hands the extraction. */
const honestWindow: Uint8Array = honestParts.decodedEmailBodyIn;

/**
 * One field's slot as the `[4]` circuit arrays and {@link TEMPLATE_FIELD_ORDER} index it: the order
 * the circuit writes down once, never restated as a number here.
 */
function slotOf(name: (typeof TEMPLATE_FIELD_ORDER)[number]): 0 | 1 | 2 | 3 {
  const slot = TEMPLATE_FIELD_ORDER.indexOf(name);
  if (slot !== 0 && slot !== 1 && slot !== 2 && slot !== 3) {
    throw new Error(`TEMPLATE_FIELD_ORDER carries no ${name} slot`);
  }
  return slot;
}

/** One field of the honest witness, by its slot name. */
function honestField(name: (typeof TEMPLATE_FIELD_ORDER)[number]): FieldLocation {
  return at(honestFields, slotOf(name), `the honest ${name} field`);
}

/** A deep copy of one witness, which every mutation row below is applied to. */
function copy(inputs: CircuitInputs): CircuitInputs {
  return structuredClone(inputs);
}

/**
 * One leaf's Merkle path as the circuit takes it: `REGISTRY_DEPTH` siblings, level 0 first, with the
 * path bit that says which side the current node is.
 */
interface MerklePath {
  readonly pathElements: bigint[];
  readonly pathIndices: (0 | 1)[];
}

/** One registry entry's path, taken from the tree the committed registry's own leaves build. */
function pathOf(leafIndex: number): MerklePath {
  const proof = registryTree.proof(leafIndex);
  return { pathElements: proof.pathElements, pathIndices: proof.pathIndices };
}

/** The registry's issuer entry: the one leaf a proof of `valid.eml` must name, and its path. */
function issuerEntry(): RegistryFile['issuers'][number] {
  const entry = registry.issuers.find((candidate) => candidate.issuerId === issuer.issuerId);
  if (entry === undefined) {
    throw new Error(`config/registry/test.json holds no leaf for issuer ${issuer.issuerId}`);
  }
  return entry;
}

/** The registry's city entry whose alias is `alias`, byte for byte as the signed body carries it. */
function cityEntryFor(alias: string): RegistryFile['cities'][number] {
  const entry = registry.cities.find((candidate) => candidate.alias === alias);
  if (entry === undefined) {
    throw new Error('config/registry/test.json holds no leaf for the alias this fixture proves');
  }
  return entry;
}

/** The city text one field location carries, over the `valueLength` bytes that hold it. */
function textOf(field: FieldLocation): string {
  let text = '';
  for (let index = 0; index < field.valueLength; index += 1) {
    text += String.fromCharCode(field.value[index] ?? 0);
  }
  return text;
}

/** The city alias the honest body carries, and the registry entry it must prove against. */
const honestCity = cityEntryFor(textOf(honestField('city')));

/**
 * Assembles a witness around the parts of a fixture the client generator refuses, which is what lets
 * the date, duplicate-anchor and header-field cases reach witness generation at all: `build-inputs.ts`
 * checks those rules off-circuit, and the circuit is the authority this file tests.
 *
 * Nothing is re-derived here. The registry paths, the two ids and the root are the caller's, the
 * template is the registered one, and the fields are whatever the caller located, so a refusal is the
 * mutation's doing rather than this helper's.
 */
function inputsFromParts(
  parts: EmailVerifierParts,
  decoded: Uint8Array,
  locations: readonly FieldLocation[],
  where: RegistryWhere,
): CircuitInputs {
  return assembleInputs({
    emailVerifier: {
      emailHeader: parts.emailHeader,
      emailHeaderLength: parts.emailHeaderLength,
      pubkey: parts.pubkey,
      signature: parts.signature,
      emailBody: parts.emailBody,
      emailBodyLength: parts.emailBodyLength,
      bodyHashIndex: parts.bodyHashIndex,
      precomputedSHA: parts.precomputedSHA,
      decodedEmailBodyIn: decoded,
    },
    fields: locations,
    template: params,
    issuerId: where.issuerId,
    cityId: where.cityId,
    issuerPath: where.issuerPath,
    cityPath: where.cityPath,
    registryRoot: where.root,
    nullifierSalt: NULLIFIER_SALT,
  });
}

/**
 * One fixture's message, its EmailVerifier parts and the decoded window its extraction reads: the
 * half of a witness that needs no field, date or registry rule.
 *
 * Kept apart from the located fields because two of the adversarial fixtures are built to break the
 * four-field extraction itself, so `locateFields` is a decision each case takes on its own rather than
 * something this helper takes for it.
 */
interface FixtureMessage {
  /** The message bytes, which every assertion about the signature reads. */
  readonly bytes: Uint8Array;
  /** The parsed message: its headers, its body and its one usable signature. */
  readonly parsed: ParsedEml;
  /** Its signature, the field the canonicalization and the honest-signature check both take. */
  readonly sig: DkimSignature;
  /** The EmailVerifier half of its witness. */
  readonly parts: EmailVerifierParts;
  /** The decoded window its extraction reads. */
  readonly decoded: Uint8Array;
}

/**
 * The parts of one adversarial fixture the client generator refuses, which is the only way these cases
 * reach the circuit: `buildEmailVerifierInputs` runs the DKIM, header and window half and no field or
 * date rule, so the parts are those of a validly signed message, and `locateFields` is then the
 * caller's decision — a `field_not_found` fixture can be handled field by field only if it is.
 */
function messageOf(file: FixturePath): FixtureMessage {
  const bytes = fixture(file);
  const parsed = parseEml(bytes);
  const sig = signatureOf(parsed);
  const parts = buildEmailVerifierInputs(bytes, [issuer]);
  return { bytes, parsed, sig, parts, decoded: parts.decodedEmailBodyIn };
}

/** One parsed message's signature: every fixture here carries exactly one the circuit can use. */
function signatureOf(parsed: ParsedEml): DkimSignature {
  const sig = parsed.signatures[0];
  if (sig === undefined) {
    throw new Error('the fixture carries no usable DKIM signature');
  }
  return sig;
}

/**
 * Asserts that a fixture's own DKIM signature is honest under `publicKey`, before any mutation is
 * applied to it: the RSA-SHA256 signature over the canonical signed header verifies, and the
 * canonicalized body hashes to the `bh=` the signature commits to.
 *
 * This is the canonicalization under test rather than a third-party one; `test/inputs.test.ts`
 * separately compares the generator's canonicalization with the `@zk-email/helpers` oracle. Without
 * this check, a refusal could equally be a signature that was broken on the way in, which is what
 * criterion 3's fixtures are built to keep apart.
 */
function assertHonestSignature(bytes: Uint8Array, publicKey: KeyObject): void {
  const parsed = parseEml(bytes);
  const sig = signatureOf(parsed);
  const header = canonicalSignedHeader(parsed, sig);
  expect(
    verifySignature('sha256', header, publicKey, sig.b),
    'the fixture’s RSA-SHA256 signature does not verify under the key it names',
  ).toBe(true);
  expect(
    createHash('sha256').update(canonicalizeBody(parsed.body, sig.c.body)).digest().equals(sig.bh),
    'the fixture’s body does not hash to the bh= its signature commits to',
  ).toBe(true);
}

/* The two public keys: the registered one, and the one outside the registry (AAP 0.5.5). */

/**
 * One RSA-2048 public key from the base64 modulus a fixture or a configuration carries, as the JWK
 * `createPublicKey` takes. The modulus is the only part of the key a DKIM record publishes, and the
 * fixtures are all signed with the exponent 65537.
 */
function publicKeyOf(modulusBase64: string): KeyObject {
  return createPublicKey({
    key: {
      kty: 'RSA',
      n: Buffer.from(modulusBase64, 'base64').toString('base64url'),
      e: 'AQAB',
    },
    format: 'jwk',
  });
}

/** The registered test issuer's public key. */
const testKey: KeyObject = publicKeyOf(at(issuer.keys, 0, 'the test issuer key').modulusBase64);

/**
 * The modulus the outside-key fixture carries in its unsigned `X-Tablemate-Fixture-Key` header: the
 * key that signed it, which no registry holds. It is read from the fixture rather than written here,
 * because the key is generated afresh by `scripts/make-test-fixtures.ts` on every fixture build.
 */
function outsideModulusBase64(): string {
  const { headers } = parseEml(fixture('other-issuer.eml'));
  const field = headers.find((header) => header.lowerName === 'x-tablemate-fixture-key');
  if (field === undefined) {
    throw new Error('other-issuer.eml carries no X-Tablemate-Fixture-Key header');
  }
  let text = '';
  for (const byte of field.raw) {
    text += String.fromCharCode(byte);
  }
  return text.slice(text.indexOf(':') + 1).replace(/\s+/g, '');
}

/**
 * The key outside the registry, as the issuer record that would hold it if it were allowlisted: the
 * fixture's own `d=` and `s=`, its own modulus, and the test issuer's id and template, so the only
 * thing that differs from a registered issuer is the key. Its status is `unverified`, which is what an
 * issuer whose samples have not passed the check is, and which no registry takes a production leaf for
 * (AAP 0.5.5).
 */
function rogueIssuer(): IssuerConfig {
  const sig = signatureOf(parseEml(fixture('other-issuer.eml')));
  return IssuerConfig.parse({
    issuerId: issuer.issuerId,
    displayName: issuer.displayName,
    verificationStatus: 'unverified',
    keys: [{ domain: sig.d, selector: sig.s, modulusBase64: outsideModulusBase64() }],
    template: templateOf(issuer),
  });
}

/** One of the seven public signals a witness carries, read by the order `PUBLIC_SIGNAL_NAMES` fixes. */
function publicSignal(witness: readonly bigint[], name: PublicSignalName): bigint {
  return at(witness, PUBLIC_SIGNAL_NAMES.indexOf(name) + 1, 'the witness’s public signals');
}

/** The registry side of a witness: the two leaf paths, the two ids they name and the root. */
interface RegistryWhere {
  readonly issuerPath: MerklePath;
  readonly cityPath: MerklePath;
  readonly issuerId: number;
  readonly cityId: number;
  readonly root: string;
}

/**
 * The registry side of every case that keeps the honest registry: the test issuer's leaf, the leaf of
 * the city the honest body names, and the root the published configuration holds.
 */
function honestWhere(): RegistryWhere {
  return {
    issuerPath: pathOf(issuerEntry().leafIndex),
    cityPath: pathOf(honestCity.leafIndex),
    issuerId: issuer.issuerId,
    cityId: honestCity.cityId,
    root: registry.root,
  };
}

/* The honest witness, and the key the registry does not hold (AAP 0.5.5, criterion 3). */

describe('the witness every substitution case starts from', () => {
  it(
    'satisfies every constraint and names the published registry root, salt and ids',
    async () => {
      const witness = await expectAccepted(honest.inputs);
      // The witness's first eight entries are the constant 1, the five outputs in
      // `PUBLIC_SIGNAL_NAMES` order and the two public inputs, so a circuit that reordered or dropped
      // one moves these values before any proof is made.
      expect(witness[0]).toBe(1n);
      expect(publicSignal(witness, 'issuerId')).toBe(BigInt(issuer.issuerId));
      expect(publicSignal(witness, 'cityId')).toBe(BigInt(honestCity.cityId));
      expect(publicSignal(witness, 'registryRoot')).toBe(BigInt(registry.root));
      expect(publicSignal(witness, 'nullifierSalt')).toBe(BigInt(NULLIFIER_SALT));
    },
    WITNESS_TIMEOUT_MS,
  );
});

describe('a key the published registry does not hold', () => {
  it(
    'proves under a registry rebuilt around its own key, and is refused under the published root',
    async () => {
      const bytes = fixture('other-issuer.eml');
      assertHonestSignature(bytes, publicKeyOf(outsideModulusBase64()));
      // The registry the AAP's rogue-issuer procedure builds: the same cities, the same issuer id and
      // the same template, with the outside key's modulus in place of the registered one.
      const rogue = buildRegistry({ name: 'test', issuers: [rogueIssuer()], cities }).registry;
      expect(rogue.root).not.toBe(registry.root);
      // Self-consistent first: under its own root the message proves, so what the second verdict shows
      // is the published root refusing the key, not a message that was broken on the way in.
      const built = buildCircuitInputs(bytes, [rogueIssuer()], rogue, {
        nullifierSalt: NULLIFIER_SALT,
      });
      await expectAccepted(built.inputs);
      // The in-circuit counterpart of the API's `422 issuer_not_allowlisted`: the same witness, folded
      // against the root the server publishes, reaches no leaf.
      await expectRejected({ ...built.inputs, registryRoot: registry.root });
    },
    WITNESS_TIMEOUT_MS,
  );
  it(
    'is refused when the path names the registered leaf but the modulus is another key’s',
    async () => {
      const bytes = fixture('other-issuer.eml');
      assertHonestSignature(bytes, publicKeyOf(outsideModulusBase64()));
      // `EmailVerifier.pubkeyHash` is computed in-circuit from the modulus the prover submits, so a
      // registered issuer leaf can only be reached by the very key that leaf commits to. The message
      // here is honest, its signature verifies, and the leaf is the published one: the only thing that
      // disagrees is the key.
      const parts = buildEmailVerifierInputs(bytes, [rogueIssuer()]);
      const fields = locateFields(parts.decodedEmailBodyIn, params);
      const city = cityEntryFor(textOf(at(fields, slotOf('city'), 'the outside-key city field')));
      await expectRejected(
        inputsFromParts(parts, parts.decodedEmailBodyIn, fields, {
          issuerPath: pathOf(issuerEntry().leafIndex),
          cityPath: pathOf(city.leafIndex),
          issuerId: issuer.issuerId,
          cityId: city.cityId,
          root: registry.root,
        }),
      );
    },
    WITNESS_TIMEOUT_MS,
  );
});

/* The template: the anchors, lengths, terminators, charsets and layout the leaf commits to (AAP 0.5.5). */

/** One row of a mutation table: what it changes, and the pure change itself over a copied witness. */
interface MutationCase {
  /** What the row changes, as the sentence its test name completes. */
  readonly what: string;
  /** The change, applied to a deep copy of the honest witness. */
  readonly mutate: (inputs: CircuitInputs) => CircuitInputs;
}

/** One non-zero byte other than `byte`: keeps an anchor's shape canonical while its bytes differ. */
function otherByte(byte: string): string {
  return String(Number(byte) === 0x41 ? 0x42 : 0x41);
}

/**
 * One field's anchors array, from a copied witness: every row below rewrites one entry of a `[4]`
 * array, and `noUncheckedIndexedAccess` is what makes reading them a checked operation.
 */
function anchorAt(inputs: CircuitInputs, name: (typeof TEMPLATE_FIELD_ORDER)[number]): string[] {
  return at(inputs.anchors, slotOf(name), `the ${name} anchors`);
}

/** Every way the extraction template can differ from the registered one, one mutation per row. */
const TEMPLATE_CASES: readonly MutationCase[] = [
  ...TEMPLATE_FIELD_ORDER.map((name) => ({
    what: `the ${name} anchor’s first byte is another non-zero byte`,
    mutate: (inputs: CircuitInputs): CircuitInputs => {
      const mutated = copy(inputs);
      const anchor = anchorAt(mutated, name);
      anchor[0] = otherByte(at(anchor, 0, `the ${name} anchor’s first byte`));
      return mutated;
    },
  })),
  {
    what: 'the city anchor is one byte shorter, the byte it stops covering zeroed',
    mutate: (inputs) => {
      const mutated = copy(inputs);
      const index = slotOf('city');
      const length = Number(at(mutated.anchorLength, index, 'the anchor lengths'));
      // The anchor loses its last byte, which is zeroed: the value it locates then starts one byte
      // earlier, and the parameters no longer hash to the leaf's template hash.
      anchorAt(mutated, 'city')[length - 1] = '0';
      mutated.anchorLength[index] = String(length - 1);
      return mutated;
    },
  },
  {
    what: 'the reference terminator is the other line-ending byte',
    mutate: (inputs) => {
      const mutated = copy(inputs);
      const index = slotOf('reference');
      const terminator = Number(at(mutated.terminator, index, 'the terminators'));
      mutated.terminator[index] = String(terminator === CR ? LF : CR);
      return mutated;
    },
  },
  {
    what: 'the reference charset is widened from alnum to text',
    mutate: (inputs) => {
      const mutated = copy(inputs);
      mutated.charset[slotOf('reference')] = String(CHARSET_CODE.text);
      return mutated;
    },
  },
  {
    what: 'the date format is the second layout rather than the first',
    mutate: (inputs) => {
      const mutated = copy(inputs);
      mutated.dateFormat = String(DATE_FORMAT_CODE.D_MONTH_YYYY);
      return mutated;
    },
  },
];

describe('a template that is not the registered one', () => {
  it('is the registered template to begin with, signal by signal', () => {
    // The base every row below departs from, read from the honest witness rather than from the
    // template: an anchor is the 32-byte zero-padded encoding `CheckedPackBytes(32)` hashes, and the
    // five arrays are what the issuer leaf commits to.
    expect(honest.inputs.anchors).toEqual(params.anchors.map((anchor) => [...anchor].map(String)));
    expect(honest.inputs.anchorLength).toEqual(params.anchorLength.map(String));
    expect(honest.inputs.terminator).toEqual(params.terminator.map(String));
    expect(honest.inputs.charset).toEqual(params.charset.map(String));
    expect(honest.inputs.dateFormat).toBe(String(DATE_FORMAT_CODE[templateOf(issuer).dateFormat]));
    // The two parameters the rows below widen and move, as the configuration records them.
    expect(honest.inputs.charset[slotOf('reference')]).toBe(String(CHARSET_CODE.alnum));
    expect(honest.inputs.terminator[slotOf('reference')]).toBe(String(CR));
  });
  it.each(TEMPLATE_CASES)(
    'is refused when $what, the signed email unchanged',
    async ({ mutate }) => {
      // The email is untouched: every byte the signature covers still verifies, and only the
      // parameters the extraction and the template hash are built from differ.
      assertHonestSignature(fixture('valid.eml'), testKey);
      await expectRejected(mutate(honest.inputs));
    },
    WITNESS_TIMEOUT_MS,
  );
});

/* The registry: the alias, the id, the leaf type and the two Merkle paths (AAP 0.5.5, AAP 0.12.2). */

/** The city text the honest body carries, which is the alias the registry must hold a leaf for. */
const honestCityText = textOf(honestField('city'));

/** A city leaf other than the one the honest body proves, for the substitution rows below. */
function otherCityEntry(): RegistryFile['cities'][number] {
  const entry = registry.cities.find((candidate) => candidate.cityId !== honestCity.cityId);
  if (entry === undefined) {
    throw new Error('config/registry/test.json holds one city only, so no substitution exists');
  }
  return entry;
}

/** Replaces one leaf's Merkle path in a copied witness with `path`'s. */
function withPath(
  inputs: CircuitInputs,
  which: 'issuer' | 'city',
  path: MerklePath,
): CircuitInputs {
  const mutated = copy(inputs);
  if (which === 'issuer') {
    mutated.issuerPathElements = path.pathElements.map(String);
    mutated.issuerPathIndices = path.pathIndices.map(String);
  } else {
    mutated.cityPathElements = path.pathElements.map(String);
    mutated.cityPathIndices = path.pathIndices.map(String);
  }
  return mutated;
}

/** One path bit of a copied witness, as the decimal string the circuit reads it as. */
function pathBit(inputs: CircuitInputs, which: 'issuer' | 'city', level: number): string {
  const indices = which === 'issuer' ? inputs.issuerPathIndices : inputs.cityPathIndices;
  return at(indices, level, `the ${which} path bits`);
}

/** The registry cases: each names both leaf types or one path bit, and must be refused. */
const REGISTRY_CASES: readonly MutationCase[] = [
  {
    what: 'the city leaf and its path are replaced by another city’s, over the alias the body carries',
    mutate: (inputs) => {
      const other = otherCityEntry();
      const mutated = withPath(inputs, 'city', pathOf(other.leafIndex));
      mutated.cityIdIn = String(other.cityId);
      return mutated;
    },
  },
  {
    what: 'the city id is another city’s while the path stays the one the alias folds along',
    mutate: (inputs) => {
      const mutated = copy(inputs);
      mutated.cityIdIn = String(otherCityEntry().cityId);
      return mutated;
    },
  },
  {
    what: 'an issuer leaf is presented as the city leaf, with the path that folds it',
    mutate: (inputs) => {
      const mutated = withPath(inputs, 'city', pathOf(issuerEntry().leafIndex));
      mutated.cityIdIn = mutated.issuerIdIn;
      return mutated;
    },
  },
  {
    what: 'the issuer path’s first bit is flipped',
    mutate: (inputs) => {
      const mutated = copy(inputs);
      mutated.issuerPathIndices[0] = String(Number(pathBit(inputs, 'issuer', 0)) ^ 1);
      return mutated;
    },
  },
  {
    what: 'the city path’s first bit is flipped',
    mutate: (inputs) => {
      const mutated = copy(inputs);
      mutated.cityPathIndices[0] = String(Number(pathBit(inputs, 'city', 0)) ^ 1);
      return mutated;
    },
  },
  {
    what: 'the issuer path’s first bit is not a bit',
    mutate: (inputs) => {
      const mutated = copy(inputs);
      mutated.issuerPathIndices[0] = NON_BINARY_BIT;
      return mutated;
    },
  },
  {
    what: 'the city path’s first bit is not a bit',
    mutate: (inputs) => {
      const mutated = copy(inputs);
      mutated.cityPathIndices[0] = NON_BINARY_BIT;
      return mutated;
    },
  },
];

describe('a leaf or a path the registry does not hold', () => {
  it('is refused off-circuit when no city leaf holds the alias the signed body carries', () => {
    // The registry a device would hold if the pilot's configuration stopped listing the alias this
    // booking site writes. A city left with no alias registers no leaf at all, so it is dropped, and
    // the configuration stays one `config/cities.json` may hold.
    const withoutAlias = cities
      .map((city) => ({
        ...city,
        aliases: city.aliases.filter((alias) => alias !== honestCityText),
      }))
      .filter((city) => city.aliases.length > 0);
    const rebuilt = buildRegistry({
      name: 'test',
      issuers: [issuer],
      cities: withoutAlias,
    }).registry;
    expect(rebuilt.cities.some((entry) => entry.alias === honestCityText)).toBe(false);
    // The code that puts "This booking site isn't supported yet." on the import screen, and the
    // off-circuit counterpart of the witness rows below (AAP 0.5.8).
    let thrown: unknown;
    try {
      buildCircuitInputs(fixture('valid.eml'), [issuer], rebuilt, {
        nullifierSalt: NULLIFIER_SALT,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CircuitInputError);
    expect((thrown as CircuitInputError).code).toBe('city_not_supported');
  });
  it.each(REGISTRY_CASES)(
    'is refused when $what',
    async ({ mutate }) => {
      await expectRejected(mutate(honest.inputs));
    },
    WITNESS_TIMEOUT_MS,
  );
});

/* The field boundaries: the anchor index, the value length, and occurrences of the anchor itself. */

/** One field's anchor's bytes, without the zero padding past the anchor's length. */
function anchorNeedle(slot: number): Uint8Array {
  const anchor = at(params.anchors, slot, 'the anchors');
  return anchor.subarray(0, at(params.anchorLength, slot, 'the anchor lengths'));
}

/** Every position one field's anchor starts at in `haystack`, in order, overlaps included. */
function anchorPositions(haystack: Uint8Array, slot: number): number[] {
  const needle = anchorNeedle(slot);
  const positions: number[] = [];
  for (
    let found = indexOfBytes(haystack, needle);
    found >= 0;
    found = indexOfBytes(haystack, needle, found + 1)
  ) {
    positions.push(found);
  }
  return positions;
}

/** The one slot whose anchor occurs `count` times in a window: each fixture here changes one field. */
function slotWithOccurrences(decoded: Uint8Array, count: number): number {
  const slots = TEMPLATE_FIELD_ORDER.map((_, slot) => slot).filter(
    (slot) => anchorPositions(decoded, slot).length === count,
  );
  if (slots.length !== 1) {
    throw new Error(`the fixture holds ${slots.length} anchors occurring ${count} times, not one`);
  }
  return at(slots, 0, 'the slots');
}

/**
 * The value length `FieldExtract` reads at `start`: the bytes between the anchor and the first
 * terminator after it, which is what makes one position admit exactly one length. A terminator
 * immediately after the anchor answers zero, a boundary the circuit's own `valueLength` rejects.
 */
function valueLengthAt(bytes: Uint8Array, slot: number, start: number, what: string): number {
  const terminator = at(params.terminator, slot, 'the terminators');
  const from = start + at(params.anchorLength, slot, 'the anchor lengths');
  for (let length = 1; length <= MAX_VALUE_BYTES; length += 1) {
    if ((bytes[from + length - 1] ?? 0) === terminator) return length - 1;
  }
  throw new Error(
    `${what}: no terminator follows the anchor inside the ${MAX_VALUE_BYTES}-byte bound`,
  );
}

/** One field location as `locateField` would report it at `start`, which no window has to agree with. */
function locationAt(bytes: Uint8Array, slot: number, start: number, what: string): FieldLocation {
  const valueLength = valueLengthAt(bytes, slot, start, what);
  const value = new Uint8Array(MAX_VALUE_BYTES);
  const from = start + at(params.anchorLength, slot, 'the anchor lengths');
  for (let index = 0; index < valueLength; index += 1) {
    value[index] = bytes[from + index] ?? 0;
  }
  return { anchorIndex: start, valueLength, value };
}

/**
 * The four field slots, in the order {@link TEMPLATE_FIELD_ORDER} fixes: the circuit's arrays are
 * positional, so the tables below are written over the slots rather than over the names.
 */
const FIELD_SLOTS = [0, 1, 2, 3] as const;

/** The two steps a boundary row takes: one byte back, and one byte forward. */
const BOUNDARY_STEPS: readonly number[] = [-1, 1];

describe('a field boundary one step from the honest one', () => {
  it.each(
    FIELD_SLOTS.flatMap((slot) =>
      BOUNDARY_STEPS.map((step) => ({ slot, step, name: TEMPLATE_FIELD_ORDER[slot] })),
    ),
  )(
    'is refused when the $name anchor index moves by $step',
    async ({ slot, step }) => {
      const mutated = copy(honest.inputs);
      const index = Number(at(mutated.anchorIndex, slot, 'the anchor indexes'));
      mutated.anchorIndex[slot] = String(index + step);
      await expectRejected(mutated);
    },
    WITNESS_TIMEOUT_MS,
  );
  it.each(
    FIELD_SLOTS.flatMap((slot) =>
      BOUNDARY_STEPS.map((step) => ({ slot, step, name: TEMPLATE_FIELD_ORDER[slot] })),
    ),
  )(
    'is refused when the $name value length moves by $step',
    async ({ slot, step }) => {
      const mutated = copy(honest.inputs);
      const length = Number(at(mutated.valueLength, slot, 'the value lengths'));
      mutated.valueLength[slot] = String(length + step);
      await expectRejected(mutated);
    },
    WITNESS_TIMEOUT_MS,
  );
});

/* The two fixtures whose bodies break the four-field extraction itself (AAP 0.5.5). */

/** The fixture whose city anchor occurs twice, so neither occurrence is the field's one position. */
const duplicated = messageOf('adversarial/duplicate-anchor.eml');
const duplicatedSlot = slotWithOccurrences(duplicated.decoded, 2);
const duplicatedPositions = anchorPositions(duplicated.decoded, duplicatedSlot);

/** The fixture whose booking reference sits only in a signed header, never in the body. */
const headerOnly = messageOf('adversarial/header-field.eml');
const headerOnlySlot = slotWithOccurrences(headerOnly.decoded, 0);

/** The canonical signed headers of the header-only fixture, where its reference anchor does occur. */
const headerOnlyHeader = canonicalSignedHeader(headerOnly.parsed, headerOnly.sig);
const headerOnlyAnchorAt = indexOfBytes(headerOnlyHeader, anchorNeedle(headerOnlySlot));

/** Every field but `slot`, located as the circuit's own extraction locates them. */
function fieldsExcept(decoded: Uint8Array, slot: number, override: FieldLocation): FieldLocation[] {
  return FIELD_SLOTS.map((candidate) =>
    candidate === slot ? override : locateField(decoded, params, candidate),
  );
}

/** The text an anchor's value carries at `start`, without locating the field around it. */
function textAt(bytes: Uint8Array, slot: number, start: number, what: string): string {
  return textOf(locationAt(bytes, slot, start, what));
}

/**
 * The city entry the duplicated-anchor fixture names: the alias its own body carries at the first of
 * the two occurrences, so the registry side is coherent and the row's refusal is the count's doing.
 */
const duplicatedCity = cityEntryFor(
  textAt(
    duplicated.decoded,
    duplicatedSlot,
    at(duplicatedPositions, 0, 'the duplicated anchor’s positions'),
    'the duplicated anchor',
  ),
);

/** The registry side of the duplicated-anchor fixture: its own city leaf, at its own path. */
const duplicatedWhere = { ...honestWhere(), cityPath: pathOf(duplicatedCity.leafIndex) };

describe('an anchor that occurs twice in the window', () => {
  it('is refused off-circuit, and its anchor is the one the window holds twice', () => {
    assertHonestSignature(duplicated.bytes, testKey);
    let thrown: unknown;
    try {
      locateFields(duplicated.decoded, params);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CircuitInputError);
    expect((thrown as CircuitInputError).code).toBe('field_ambiguous');
    expect((thrown as CircuitInputError).field).toBe(TEMPLATE_FIELD_ORDER[duplicatedSlot]);
    expect(duplicatedPositions).toHaveLength(2);
  });
  it.each(duplicatedPositions.map((start) => ({ start })))(
    'is refused when the duplicated anchor is read at position $start',
    async ({ start }) => {
      // One occurrence of the two, with the value that follows it: the extraction the client refuses
      // for ambiguity, handed to the circuit, which counts both occurrences at every position.
      const override = locationAt(
        duplicated.decoded,
        duplicatedSlot,
        start,
        'the duplicated anchor',
      );
      const fields = fieldsExcept(duplicated.decoded, duplicatedSlot, override);
      await expectRejected(
        inputsFromParts(duplicated.parts, duplicated.decoded, fields, duplicatedWhere),
      );
    },
    WITNESS_TIMEOUT_MS,
  );
});

describe('a field that occurs only in the headers', () => {
  it('is refused off-circuit, and its anchor does occur in the canonical signed header', () => {
    assertHonestSignature(headerOnly.bytes, testKey);
    let thrown: unknown;
    try {
      locateFields(headerOnly.decoded, params);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CircuitInputError);
    expect((thrown as CircuitInputError).code).toBe('field_not_found');
    expect((thrown as CircuitInputError).field).toBe(TEMPLATE_FIELD_ORDER[headerOnlySlot]);
    // The statement places every stay field in the body, so a header extraction has no position at
    // all: the anchor is in the signed headers, which the circuit never reads for it.
    expect(headerOnlyAnchorAt).toBeGreaterThan(0);
    expect(anchorPositions(headerOnly.decoded, headerOnlySlot)).toHaveLength(0);
  });
  it.each([0, headerOnlyAnchorAt].map((start) => ({ start })))(
    'is refused when the header-only anchor is offered at position $start',
    async ({ start }) => {
      // The length the header carries, which is the length a header field would have. It is offered
      // twice: at the window's first byte, and at the offset the anchor sits at in the header, where
      // the window holds unrelated text. Both are positions the body never fixed.
      const override = locationAt(
        headerOnlyHeader,
        headerOnlySlot,
        headerOnlyAnchorAt,
        'the header',
      );
      const atPosition = { ...override, anchorIndex: start };
      const fields = fieldsExcept(headerOnly.decoded, headerOnlySlot, atPosition);
      await expectRejected(
        inputsFromParts(headerOnly.parts, headerOnly.decoded, fields, honestWhere()),
      );
    },
    WITNESS_TIMEOUT_MS,
  );
});

/* The window: the email's own length bytes fix it, and a prover may not choose a narrower one. */

/** One body window, and the decoded form the extraction reads. */
interface NarrowedWindow {
  readonly emailBody: Uint8Array;
  readonly emailBodyLength: number;
  readonly precomputedSHA: Uint8Array;
  readonly decoded: Uint8Array;
}

/**
 * The honest fixture's padded body, cut `step` bytes past the cut its own length bytes fix: a suffix
 * the email did not choose, still a whole number of SHA-256 blocks and still inside the window bound.
 */
function narrowedWindow(step: number): NarrowedWindow {
  const parsed = parseEml(fixture('valid.eml'));
  const body = canonicalizeBody(parsed.body, signatureOf(parsed).c.body);
  // A body whose minimal padding is wider than the circuit's body bound needs a larger buffer to pad
  // into; the window is cut down to the bound either way, exactly as `build-inputs.ts` does it.
  const maxLength = Math.max(MAX_BODY_LENGTH, 64 * Math.ceil((body.length + 9) / 64));
  const { padded, paddedLength } = sha256Pad(body, maxLength);
  const { precomputedSha, bodyRemaining, bodyRemainingLength } = generatePartialSha(
    padded,
    paddedLength,
    honestParts.precomputeCut + step,
    MAX_BODY_LENGTH,
  );
  return {
    emailBody: bodyRemaining,
    emailBodyLength: bodyRemainingLength,
    precomputedSHA: precomputedSha,
    decoded: removeSoftLineBreaks(bodyRemaining, MAX_BODY_LENGTH),
  };
}

describe('a body window the email did not fix', () => {
  it(
    'is refused when the window is one block narrower than the padded body requires',
    async () => {
      // `valid.eml`'s padded body is wider than the window, so `BodyWindow` requires the window to be
      // exactly `MAX_BODY_WINDOW` bytes: the length here is one block less, and the fields still extract
      // from it, so nothing but the window rule refuses it. Removing that rule is the one change that
      // would let a prover pick which occurrence of an anchor its extraction can reach.
      const window = narrowedWindow(WINDOW_STEP_BYTES);
      expect(window.emailBodyLength).toBe(MAX_BODY_WINDOW - WINDOW_STEP_BYTES);
      const fields = locateFields(window.decoded, params);
      expect(fields).toHaveLength(TEMPLATE_FIELD_ORDER.length);
      await expectRejected(
        inputsFromParts({ ...honestParts, ...window }, window.decoded, fields, honestWhere()),
      );
    },
    WITNESS_TIMEOUT_MS,
  );
});

/* The dates, the reference's own lengths, and the padding no input can carry (AAP 0.5.5, 0.12.2). */

/** One fixture the client refuses, with the sentence naming the value it was built around. */
interface DateCase {
  readonly file: FixturePath;
  readonly what: string;
}

/** The three arrival dates no calendar has, one fixture each, all else equal to a signed message. */
const DATE_CASES: readonly DateCase[] = [
  { file: 'adversarial/date-feb-30.eml', what: 'the 30th of February' },
  { file: 'adversarial/date-month-13.eml', what: 'a thirteenth month' },
  { file: 'adversarial/date-non-digit.eml', what: 'a letter where a year digit belongs' },
];

/** One copy of the honest witness with one field's value length moved by `step`. */
function withValueLength(slot: number, step: number): CircuitInputs {
  const mutated = copy(honest.inputs);
  const length = Number(at(mutated.valueLength, slot, 'the value lengths'));
  mutated.valueLength[slot] = String(length + step);
  return mutated;
}

/** The reference's value length in the honest witness, which the three rows below move. */
const honestReferenceLength = Number(
  at(honest.inputs.valueLength, slotOf('reference'), 'the reference value length'),
);

describe('a date no calendar has', () => {
  it.each(DATE_CASES)(
    'is refused by DateParse when the arrival value is $what',
    async ({ file }) => {
      const message = messageOf(file);
      assertHonestSignature(message.bytes, testKey);
      // The client refuses it first, naming the field's slot and never its text, so a device never
      // spends a proving run on a value the circuit cannot read.
      let thrown: unknown;
      try {
        buildCircuitInputs(message.bytes, [issuer], registry, { nullifierSalt: NULLIFIER_SALT });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CircuitInputError);
      expect((thrown as CircuitInputError).code).toBe('field_invalid');
      expect((thrown as CircuitInputError).field).toBe(TEMPLATE_FIELD_ORDER[slotOf('arrival')]);
      // Handed to the circuit anyway, which is the authority: every byte of the value is inside the
      // arrival field's charset and the extraction locates it, so what refuses this witness is
      // `lib/date_parse.circom`'s calendar rule rather than a boundary or a signature.
      const fields = locateFields(message.decoded, params);
      await expectRejected(inputsFromParts(message.parts, message.decoded, fields, honestWhere()));
    },
    WITNESS_TIMEOUT_MS,
  );
});

describe('a second value length over one booking reference', () => {
  it.each([-1, 1, 2].map((step) => ({ step, length: honestReferenceLength + step })))(
    'is refused when the reference length is $length over the same bytes',
    async ({ step }) => {
      // The nullifier is `Poseidon(refLength, pack(ref)[0], pack(ref)[1], salt)`, so a prover who
      // could move the length over the bytes the signed body holds would have a second nullifier for
      // one booking — and the API keys `SpentNullifier` on that value. The reference's boundary is
      // therefore its own case here, named beside the four symmetric ones above.
      await expectRejected(withValueLength(slotOf('reference'), step));
    },
    WITNESS_TIMEOUT_MS,
  );
  it('holds one length only: the honest witness’s length is the terminator’s own offset', () => {
    const field = honestField('reference');
    const terminatorAt =
      field.anchorIndex +
      at(params.anchorLength, slotOf('reference'), 'the anchor lengths') +
      field.valueLength;
    expect(byteAt(honestWindow, terminatorAt, 'the honest window')).toBe(
      at(params.terminator, slotOf('reference'), 'the terminators'),
    );
  });
});

/* The padding, which only a witness can carry: `FieldExtract` computes `value[]` from the window. */

/** One signal of a compiled circuit, read out of a witness by the name the circuit writes it under. */
function signalIndex(compiled: WasmCircuit, name: string): number {
  const symbol = compiled.symbols[name];
  if (symbol === undefined) {
    throw new Error(`the compiled circuit carries no ${name} signal`);
  }
  return symbol.varIdx;
}

describe('a non-zero byte written past a value’s length', () => {
  let extractor: WasmCircuit | undefined;
  let workDir: string | undefined;
  beforeAll(async () => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'tablemate-adversarial-'));
    // `FieldExtract` on its own, around the honest window: the padding is what the circuit computes
    // past `valueLength`, so this is the one case that cannot be injected through the inputs of the
    // whole circuit. No test circuit is committed — the file lives in a temporary directory that
    // `afterAll` removes, which is also why the wrapper is compiled here rather than by the compile.
    const source = path.join(workDir, 'field_extract.circom');
    writeFileSync(
      source,
      [
        'pragma circom 2.1.9;',
        `include "${ANCHOR_EXTRACT_LIB}";`,
        'component main = FieldExtract(1024, 32, 32);',
        '',
      ].join('\n'),
      'utf8',
    );
    const compiled = await circomTester.wasm(source, { output: workDir, include: [...INCLUDE] });
    await compiled.loadSymbols();
    extractor = compiled;
  }, CIRCUIT_TIMEOUT_MS);
  afterAll(() => {
    if (workDir !== undefined) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
  it(
    'is zero in an honest witness, and refused by the constraints the moment it is not',
    async () => {
      const compiled = extractor;
      demand(compiled !== undefined, 'the FieldExtract wrapper was not compiled: its hook failed');
      const slot = slotOf('reference');
      const field = honestField('reference');
      const witness = await compiled.calculateWitness(
        {
          in: [...honestWindow],
          anchor: [...at(params.anchors, slot, 'the anchors')],
          anchorLength: at(params.anchorLength, slot, 'the anchor lengths'),
          anchorIndex: field.anchorIndex,
          valueLength: field.valueLength,
          terminator: at(params.terminator, slot, 'the terminators'),
          charset: at(params.charset, slot, 'the charsets'),
        },
        true,
      );
      // The honest witness satisfies the extraction's constraints, and every byte from `valueLength` on
      // is zero: that zero fill is what makes a packed value canonical, so two references that differ
      // only past the length cannot be confused for one another.
      await expect(compiled.checkConstraints(witness)).resolves.toBeUndefined();
      for (let byte = field.valueLength; byte < MAX_VALUE_BYTES; byte += 1) {
        expect(at(witness, signalIndex(compiled, `main.value[${byte}]`), 'the witness')).toBe(0n);
      }
      // The one tampering below is the witness rather than the inputs: `value[]` is an output of the
      // extraction, so no input can put a byte there. Writing one into a witness the circuit accepted
      // and asking the compiled constraints again is what shows the padding is constrained rather than
      // merely computed.
      const tampered = [...witness];
      tampered[signalIndex(compiled, `main.value[${field.valueLength}]`)] = BigInt(TAMPER_BYTE);
      await expect(compiled.checkConstraints(tampered)).rejects.toThrow();
    },
    WITNESS_TIMEOUT_MS,
  );
});
