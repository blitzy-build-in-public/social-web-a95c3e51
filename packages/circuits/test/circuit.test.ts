/**
 * The itinerary circuit's own suite: honest witnesses for both body-window cases, the seven public signals a
 * proof carries, the rejections the circuit exists to perform, and the date layouts (AAP 0.5.5, AAP 0.8.1,
 * AAP 0.12.1 criterion 3, AAP 0.12.2 "circuit public-signal count"). Four things are asserted:
 *
 *   - `valid.eml` and `valid-second.eml` build a witness satisfying every constraint, with the outputs the
 *     email itself holds — the city's circuit id, both dates as `YYYYMMDD`, the issuer's id and the
 *     reference's nullifier — computed from the signed bytes, never copied from the circuit (AAP 0.5.5
 *     "Boundary tests").
 *   - A proof carries exactly the seven signals of `PUBLIC_SIGNAL_NAMES`, in that order, each equal to what
 *     the witness computed; altering any single one makes verification fail (AAP 0.12.1 criterion 3,
 *     AAP 0.12.2).
 *   - `tampered.eml` is refused twice: by the input generator, as `body_hash_mismatch`, and by the circuit,
 *     when a witness is assembled by hand around its bytes. So is a 1,024-byte window, 64 bytes wider than
 *     `BodyWindow` admits (AAP 0.5.5).
 *   - `DateParse` accepts each of its four layouts and refuses the dates no calendar has.
 *
 * Prerequisites throw rather than skip, so a missing build or a circom outside 2.1.9 is visible instead of a
 * green suite over an unproved file; the proof suite needs the trusted setup on top of the compile and fails
 * alone, naming the command that produces it. A witness of this circuit is a few million signals and the
 * proving key is far larger, so a run wants a raised heap (`NODE_OPTIONS=--max-old-space-size=8192`), which a
 * test file cannot raise for itself.
 */
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CitiesFile,
  DATE_FORMAT_CODE,
  IssuerConfig,
  PUBLIC_SIGNAL_NAMES,
  RegistryFile,
} from '@tablemate/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DateFormat, DkimKey, IssuerTemplate, PublicSignalName } from '@tablemate/shared';

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
import { canonicalizeBody } from '../src/inputs/dkim-canonicalize.ts';
import { CircuitInputError, parseEml } from '../src/inputs/eml-parse.ts';
import { generatePartialSha, sha256Pad } from '../src/inputs/sha-partial.ts';
import {
  locateFields,
  parseDateValue,
  removeSoftLineBreaks,
} from '../src/inputs/template-locate.ts';
import type { FieldLocation } from '../src/inputs/template-locate.ts';
import {
  BN254_SCALAR_FIELD,
  modulusFromBase64,
  nullifierOf,
  pubkeyHash,
  utf8Encode,
} from '../src/registry/leaves.ts';
import { templateParams } from '../src/registry/template-hash.ts';
import type { TemplateParams } from '../src/registry/template-hash.ts';

/* Paths and constants (AAP 0.8.1, AAP 0.5.5). */

/** This package's directory: this file sits one level below it, in `test/`. */
const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The repository root, two levels above the package. */
const REPO_ROOT = path.resolve(PKG_DIR, '..', '..');

/** The git-ignored build directory `pnpm circuits:compile` and `pnpm circuits:setup` write into. */
const BUILD = path.join(PKG_DIR, 'build');

/** The committed test-issuer fixtures, signed by `scripts/make-test-fixtures.ts`. */
const FIXTURE_DIR = path.join(PKG_DIR, 'fixtures', 'test-issuer');

/** The circuit source `circom_tester` is pointed at; it never recompiles it here. */
const CIRCUIT_SOURCE = path.join(PKG_DIR, 'circuits', 'tablemate_itinerary.circom');

/* The compile's two artefacts: the witness generator and the symbol table that names its signals. */
const CIRCUIT_WASM = path.join(BUILD, 'tablemate_itinerary_js', 'tablemate_itinerary.wasm');
const CIRCUIT_SYMBOLS = path.join(BUILD, 'tablemate_itinerary.sym');

/* The setup's three artefacts: the flattened wasm snarkjs proves with, the key and the verification key. */
const CIRCUIT_WASM_FLAT = path.join(BUILD, 'tablemate_itinerary.wasm');
const CIRCUIT_ZKEY = path.join(BUILD, 'tablemate_itinerary.zkey');
const VERIFICATION_KEY = path.join(BUILD, 'verification_key.json');

/**
 * circom's include search path: the circuit library first, where `date_parse.circom` and its siblings
 * live, then both `node_modules` roots, because a hoisted install keeps `@zk-email/circuits` and
 * `circomlib` at the repository root while a package-local copy may hold either instead.
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

/** Twenty minutes: one Groth16 proof against a gigabyte-scale proving key. */
const PROOF_TIMEOUT_MS = 20 * 60_000;

/**
 * The SHA-256 initial state as 32 big-endian bytes, spelled out rather than imported: `BodyWindow`
 * requires exactly this state of `precomputedSHA` when the window starts at block 0, and the
 * assertion would be worth little if the expected value came from the module it checks.
 */
const SHA256_IV_BYTES: readonly number[] = [
  0x6a, 0x09, 0xe6, 0x67, 0xbb, 0x67, 0xae, 0x85, 0x3c, 0x6e, 0xf3, 0x72, 0xa5, 0x4f, 0xf5, 0x3a,
  0x51, 0x0e, 0x52, 0x7f, 0x9b, 0x05, 0x68, 0x8c, 0x1f, 0x83, 0xd9, 0xab, 0x5b, 0xe0, 0xcd, 0x19,
];

/** One committed fixture, by the stem of its file in `fixtures/test-issuer/`. */
type FixtureStem = 'valid' | 'valid-second' | 'tampered';

/* circom_tester 0.0.24 and snarkjs 0.7.6: CommonJS, untyped, loaded through `createRequire`. */

/** The witness index of every signal a suite reads, keyed by the name the circuit writes it under. */
type SignalIndex = ReadonlyMap<string, number>;

/** The part of circom_tester's `WasmTester` this suite calls. */
interface WasmCircuit {
  /** `sanityCheck` makes the generator assert every `===` constraint, which is what a rejection is. */
  calculateWitness(input: object, sanityCheck?: boolean): Promise<bigint[]>;
}

/** `require('circom_tester').wasm`, narrowed to the options this file passes. */
interface CircomTester {
  wasm(
    source: string,
    options: { output: string; recompile?: boolean; include?: string[] },
  ): Promise<WasmCircuit>;
}

/** The two Groth16 entry points of snarkjs 0.7.6 this suite calls. */
interface Snarkjs {
  readonly groth16: {
    fullProve(
      input: object,
      wasmPath: string,
      zkeyPath: string,
    ): Promise<{ proof: unknown; publicSignals: string[] }>;
    verify(
      verificationKey: unknown,
      publicSignals: readonly string[],
      proof: unknown,
    ): Promise<boolean>;
  };
}

/** The one shape that both typechecks and resolves under Node ESM, Vitest and tsx. */
const circomTester = createRequire(import.meta.url)('circom_tester') as CircomTester;
const snarkjs = createRequire(import.meta.url)('snarkjs') as Snarkjs;

/* The committed configuration the witnesses are built from. */

/** The synthetic test issuer whose RSA-2048 key signed every fixture (AAP 0.5.5). */
const issuer: SupportedIssuer = readConfig('config/issuers/tablemate-test.json', IssuerConfig);

/** The committed test registry: the depth-8 tree both Merkle paths must reach. */
const registry = readConfig('config/registry/test.json', RegistryFile);

/** The launch cities, whose aliases the registry's city leaves carry. */
const cities = readConfig('config/cities.json', CitiesFile);

/** The test issuer's registered template, as the circuit takes it. */
const params: TemplateParams = templateParams(templateOf(issuer));

/**
 * Reads one committed configuration file and parses it with the schema the registry builder, the
 * client and the API share, so this suite reads the same contract they do (AAP 0.11.1).
 */
function readConfig<T>(relative: string, schema: { parse(value: unknown): T }): T {
  const text = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
  return schema.parse(JSON.parse(text) as unknown);
}

/** The issuer's template, which only an issuer awaiting samples may lack. */
function templateOf(value: SupportedIssuer): IssuerTemplate {
  if (value.template === null) {
    throw new Error('the test issuer record carries no template');
  }
  return value.template;
}

/** The issuer's DKIM key, whose modulus the issuer leaf's `pubkeyHash` commits to. */
function firstKey(): DkimKey {
  const key = issuer.keys[0];
  if (key === undefined) {
    throw new Error('the test issuer record carries no DKIM key');
  }
  return key;
}

/** One committed fixture's bytes, read into memory only: the email never reaches a fixture file. */
function fixture(stem: FixtureStem): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURE_DIR, `${stem}.eml`)));
}

/** Builds are pure and the fixtures are small, so each one's witness inputs are built once. */
const builtCache = new Map<FixtureStem, BuildCircuitInputsResult>();

/** The witness inputs of one fixture, and the two ids it proves. */
function built(stem: FixtureStem): BuildCircuitInputsResult {
  const cached = builtCache.get(stem);
  if (cached !== undefined) {
    return cached;
  }
  const result = buildCircuitInputs(fixture(stem), [issuer], registry, {
    nullifierSalt: NULLIFIER_SALT,
  });
  builtCache.set(stem, result);
  return result;
}

/** What a fixture's own bytes say a proof must publish, computed without the circuit. */
interface Expectations {
  /** The five outputs and the two public inputs, by signal name. */
  readonly signals: Record<PublicSignalName, bigint>;
  /** The Poseidon hash of the modulus the signature verified under: `emailVerifier.pubkeyHash`. */
  readonly pubkeyHashValue: bigint;
  /** The padded body window's length in bytes, the circuit input `emailBodyLength`. */
  readonly windowBytes: number;
  /** Whether `precomputedSHA` is the SHA-256 IV, which it is only when nothing was precomputed. */
  readonly precomputedIsIv: boolean;
}

/**
 * Derives, from a fixture and the published configuration alone, every value the witness's outputs
 * must equal: the city the signed body names, the two dates it holds, the issuer, the nullifier of
 * its booking reference, and the two public inputs. Nothing is read back from the circuit.
 */
function expectationsFor(stem: FixtureStem): Expectations {
  const { inputs } = built(stem);
  // `locateFields` reads the template's own anchors out of the decoded window, so the four values
  // are the bytes the signed body carries rather than any value this file knows in advance.
  const decoded = new Uint8Array(inputs.decodedEmailBodyIn.map(Number));
  const fields = locateFields(decoded, params);
  const arrival = fieldAt(fields, 1, stem);
  const departure = fieldAt(fields, 2, stem);
  const cityText = latin1(fieldAt(fields, 0, stem));
  const referenceText = latin1(fieldAt(fields, 3, stem));
  const city = cities.cities.find((entry) => entry.aliases.includes(cityText));
  if (city === undefined) {
    throw new Error(`no configured city carries the alias ${stem}.eml proves`);
  }
  const signals: Record<PublicSignalName, bigint> = {
    cityId: BigInt(city.circuitCityId),
    arrivalDate: BigInt(dateOf(arrival, stem)),
    departureDate: BigInt(dateOf(departure, stem)),
    issuerId: BigInt(issuer.issuerId),
    nullifier: nullifierOf(utf8Encode(referenceText), NULLIFIER_SALT),
    registryRoot: BigInt(registry.root),
    nullifierSalt: BigInt(NULLIFIER_SALT),
  };
  return {
    signals,
    pubkeyHashValue: pubkeyHash(modulusFromBase64(firstKey().modulusBase64)),
    windowBytes: Number(inputs.emailBodyLength),
    precomputedIsIv: inputs.precomputedSHA
      .map(Number)
      .every((byte, index) => byte === SHA256_IV_BYTES[index]),
  };
}

/** One of the four located stay fields, which every parsed fixture has. */
function fieldAt(
  fields: readonly FieldLocation[],
  index: number,
  stem: FixtureStem,
): FieldLocation {
  const field = fields[index];
  if (field === undefined) {
    throw new Error(`${stem}.eml has no field ${index}`);
  }
  return field;
}

/**
 * A date field as the circuit's `YYYYMMDD` integer. The test template is `ISO_YMD`, so the value is
 * the ISO text with its dashes removed; the circuit's own parser reads it as well, and the two must
 * agree, which is what makes the expected number independent of how the layout is spelled.
 */
function dateOf(field: FieldLocation, stem: FixtureStem): number {
  const parsed = parseDateValue(field.value, field.valueLength, params.dateFormat);
  if (parsed === null) {
    throw new Error(`${stem}.eml carries a date the circuit cannot parse`);
  }
  if (params.dateFormat === DATE_FORMAT_CODE.ISO_YMD) {
    const iso = Number(latin1(field).replaceAll('-', ''));
    if (iso !== parsed) {
      throw new Error(`${stem}.eml's ISO date and its parsed date disagree`);
    }
  }
  return parsed;
}

/** A located field's ASCII text, over the `valueLength` bytes that carry it. */
function latin1(field: FieldLocation): string {
  let text = '';
  for (let index = 0; index < field.valueLength; index += 1) {
    text += String.fromCharCode(field.value[index] ?? 0);
  }
  return text;
}

/**
 * Throws unless `condition` holds. Every prerequisite of this suite goes through it, so a missing
 * circuit build or compiler fails the run instead of silently skipping it.
 */
function demand(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/** One signal of a witness, by the name the circuit writes it under: `main.<name>`. */
function signalOf(index: SignalIndex, witness: readonly bigint[], name: string): bigint {
  const varIdx = index.get(`main.${name}`);
  if (varIdx === undefined) {
    throw new Error(`the circuit carries no signal named ${name}`);
  }
  const value = witness[varIdx];
  if (value === undefined) {
    throw new Error(`the witness carries no value for ${name}`);
  }
  return value;
}

/** The bytes read per pass over a symbol table; the table of this circuit takes a handful of passes. */
const SYMBOL_BLOCK_BYTES = 64 * 1024 * 1024;

/**
 * The witness index of each named signal, read from a compiled circuit's symbol table — the
 * `labelIdx,varIdx,componentIdx,name` lines of its `.sym` file.
 *
 * `circom_tester`'s own `loadSymbols()` is unusable for this circuit: it reads the whole table into
 * one JavaScript string, and the table is a gigabyte, past V8's maximum string length, so it fails
 * with `RangeError: Invalid string length` however large the heap is. This reads the same file in
 * blocks and keeps only the entries asked for, which is the whole of what
 * `symbols['main.<name>'].varIdx` would have given, and it stops as soon as every name is found.
 *
 * @param symbolFile - The compiled circuit's symbol table.
 * @param names - The signals to resolve, as the circuit writes them: `main.cityId`, and so on.
 * @returns Each name's index into the witness array.
 * @throws {Error} When the table carries no line for one of the names.
 */
async function signalIndexes(symbolFile: string, names: readonly string[]): Promise<SignalIndex> {
  const indexes = new Map<string, number>();
  const handle = await open(symbolFile, 'r');
  const block = Buffer.alloc(SYMBOL_BLOCK_BYTES);
  let carry = '';
  try {
    for (;;) {
      const { bytesRead } = await handle.read(block, 0, block.length, null);
      const text = carry + block.toString('latin1', 0, bytesRead);
      // `text` always begins at a line's start, so every complete line it holds is scanned here and
      // only the unterminated tail is carried into the next pass.
      const lastBreak = text.lastIndexOf('\n');
      if (lastBreak < 0) {
        carry = text;
      } else {
        scanSymbolText(text.slice(0, lastBreak + 1), names, indexes);
        carry = text.slice(lastBreak + 1);
      }
      if (bytesRead === 0 || indexes.size === names.length) break;
    }
    if (carry !== '') {
      scanSymbolText(`${carry}\n`, names, indexes);
    }
  } finally {
    await handle.close();
  }
  for (const name of names) {
    if (!indexes.has(name)) {
      throw new Error(`${symbolFile} carries no signal named ${name}`);
    }
  }
  return indexes;
}

/** Every line of `text` naming one of `wanted`, recorded by the `varIdx` that line carries. */
function scanSymbolText(
  text: string,
  wanted: readonly string[],
  indexes: Map<string, number>,
): void {
  for (const name of wanted) {
    if (indexes.has(name)) continue;
    // A name is a line's last field, so `,<name>\n` cannot match the tail of a longer name.
    const at = text.indexOf(`,${name}\n`);
    if (at < 0) continue;
    const fields = text.slice(text.lastIndexOf('\n', at) + 1, at).split(',');
    const varIdx = Number(fields[1]);
    if (fields.length === 3 && Number.isInteger(varIdx) && varIdx >= 0) {
      indexes.set(name, varIdx);
    }
  }
}

/** `circom --version` as the compiler prints it, or nothing when it is not on PATH. */
function circomVersion(): string {
  const result = spawnSync('circom', ['--version'], { encoding: 'utf8' });
  return result.status === 0 && typeof result.stdout === 'string' ? result.stdout : '';
}

/* The main circuit, loaded once for every witness suite below (AAP 0.5.5). */

/** The signals the witness suites read: the seven public ones, plus the key hash the leaf commits to. */
const MAIN_SIGNAL_NAMES: readonly string[] = [
  ...PUBLIC_SIGNAL_NAMES.map((name) => `main.${name}`),
  'main.emailVerifier.pubkeyHash',
];

let mainCircuit: WasmCircuit | undefined;
let mainIndex: SignalIndex | undefined;

beforeAll(async () => {
  const version = circomVersion();
  demand(
    version.includes(REQUIRED_CIRCOM),
    `circom ${REQUIRED_CIRCOM} is required to load this circuit, but PATH has: ` +
      `${version.trim() === '' ? 'no circom' : version.trim()}; install it with: ${CIRCOM_INSTALL}`,
  );
  demand(existsSync(CIRCUIT_WASM), `${CIRCUIT_WASM} is missing: run pnpm circuits:compile`);
  demand(existsSync(CIRCUIT_SYMBOLS), `${CIRCUIT_SYMBOLS} is missing: run pnpm circuits:compile`);
  // `recompile: false` reads the compile's own wasm, so nothing here depends on circom agreeing with
  // the build's flags beyond the version checked above. The include array is copied because
  // circom_tester appends the source's directory to whatever array it is handed. The library's
  // `loadSymbols()` is never called: see `signalIndexes`.
  mainCircuit = await circomTester.wasm(CIRCUIT_SOURCE, {
    output: BUILD,
    recompile: false,
    include: [...INCLUDE],
  });
  mainIndex = await signalIndexes(CIRCUIT_SYMBOLS, MAIN_SIGNAL_NAMES);
}, CIRCUIT_TIMEOUT_MS);

/** The loaded circuit, or a failure naming the hook that loads it. */
function circuit(): WasmCircuit {
  demand(mainCircuit !== undefined, 'the circuit was not loaded: its beforeAll hook failed');
  return mainCircuit;
}

/** The signal index read beside the circuit, in the same hook. */
function index(): SignalIndex {
  demand(mainIndex !== undefined, 'the signal table was not read: the beforeAll hook failed');
  return mainIndex;
}

/* The two window cases of AAP 0.5.5's boundary tests, and whether each fixture is cut. */

const WINDOW_CASES: [FixtureStem, boolean][] = [
  ['valid', true],
  ['valid-second', false],
];

describe('a witness for an honest booking', () => {
  it.each(WINDOW_CASES)(
    'proves what %s.eml holds, with the window cut: %s',
    async (stem, expectPrecompute) => {
      const expectations = expectationsFor(stem);
      // The window rule the circuit re-derives from the email's own length bytes: nothing is
      // precomputed when the whole padded body fits in 960 bytes, and otherwise the state entering
      // the window is the SHA-256 state after the bytes the window leaves behind.
      expect(expectations.precomputedIsIv).toBe(!expectPrecompute);
      expect(expectations.windowBytes).toBeLessThanOrEqual(MAX_BODY_WINDOW);
      if (expectPrecompute) {
        expect(expectations.windowBytes).toBe(MAX_BODY_WINDOW);
      }
      const witness = await circuit().calculateWitness(built(stem).inputs, true);
      // Position first: the witness's first eight entries are the constant 1 followed by the outputs
      // and public inputs in `PUBLIC_SIGNAL_NAMES` order, so a circuit that reordered them moves
      // these values even before a proof is made (AAP 0.5.5). Then each signal by name, through the
      // compiled symbol table.
      expect(witness.slice(1, PUBLIC_SIGNAL_NAMES.length + 1)).toEqual(
        PUBLIC_SIGNAL_NAMES.map((name) => expectations.signals[name]),
      );
      expect(signalOf(index(), witness, 'cityId')).toBe(expectations.signals.cityId);
      expect(signalOf(index(), witness, 'arrivalDate')).toBe(expectations.signals.arrivalDate);
      expect(signalOf(index(), witness, 'departureDate')).toBe(expectations.signals.departureDate);
      expect(signalOf(index(), witness, 'issuerId')).toBe(expectations.signals.issuerId);
      expect(signalOf(index(), witness, 'nullifier')).toBe(expectations.signals.nullifier);
      // The key the RSA check consumed, which the issuer leaf is built from: the circuit computes it
      // itself, so this is the one hash of the modulus the registry does not have to be trusted for.
      expect(signalOf(index(), witness, 'emailVerifier.pubkeyHash')).toBe(
        expectations.pubkeyHashValue,
      );
    },
    CIRCUIT_TIMEOUT_MS,
  );
});

/* One Groth16 proof, its seven signals, and what altering any one of them does (AAP 0.12.1-3). */

const ALTERED_SIGNAL_CASES: [PublicSignalName, number][] = PUBLIC_SIGNAL_NAMES.map(
  (name, index): [PublicSignalName, number] => [name, index],
);

describe('a Groth16 proof of valid.eml', () => {
  let proved: { proof: unknown; publicSignals: string[] } | undefined;
  let verificationKey: unknown;
  let expectations: Expectations;
  beforeAll(async () => {
    for (const artefact of [CIRCUIT_WASM_FLAT, CIRCUIT_ZKEY, VERIFICATION_KEY]) {
      demand(existsSync(artefact), `${artefact} is missing: run pnpm circuits:setup`);
    }
    expectations = expectationsFor('valid');
    verificationKey = JSON.parse(readFileSync(VERIFICATION_KEY, 'utf8')) as unknown;
    proved = await snarkjs.groth16.fullProve(
      built('valid').inputs,
      CIRCUIT_WASM_FLAT,
      CIRCUIT_ZKEY,
    );
  }, PROOF_TIMEOUT_MS);
  afterAll(async () => {
    // ffjavascript keeps a worker pool alive for the bn128 curve, so the curve is terminated by
    // hand: without this the Vitest process never exits after the last test.
    const curve = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
    if (curve !== undefined) {
      await curve.terminate();
    }
  });
  it('carries the seven signals of PUBLIC_SIGNAL_NAMES, each holding what the email says', async () => {
    demand(proved !== undefined, 'the fixture proof was not generated: its beforeAll hook failed');
    expect(proved.publicSignals).toHaveLength(PUBLIC_SIGNAL_NAMES.length);
    const published: Record<string, bigint> = {};
    PUBLIC_SIGNAL_NAMES.forEach((name, index) => {
      published[name] = BigInt(proved?.publicSignals[index] ?? '0');
    });
    expect(published).toEqual(expectations.signals);
    await expect(
      snarkjs.groth16.verify(verificationKey, proved.publicSignals, proved.proof),
    ).resolves.toBe(true);
  });
  it.each(ALTERED_SIGNAL_CASES)(
    'rejects a proof whose %s signal is altered',
    async (_name, index) => {
      demand(
        proved !== undefined,
        'the fixture proof was not generated: its beforeAll hook failed',
      );
      const altered = [...proved.publicSignals];
      altered[index] = ((BigInt(altered[index] ?? '0') + 1n) % BN254_SCALAR_FIELD).toString();
      await expect(snarkjs.groth16.verify(verificationKey, altered, proved.proof)).resolves.toBe(
        false,
      );
    },
    PROOF_TIMEOUT_MS,
  );
});

/* The rejections: a tampered body, and a window 64 bytes wider than the circuit admits (AAP 0.5.5). */

/** One body window, and the decoded form the field extraction reads. */
interface BodyWindow {
  readonly emailBody: Uint8Array;
  readonly emailBodyLength: number;
  readonly precomputedSHA: Uint8Array;
  readonly decoded: Uint8Array;
}

/** A fixture's canonical body, as the input generator canonicalizes it before hashing. */
function canonicalBodyOf(stem: FixtureStem): Uint8Array {
  const parsed = parseEml(fixture(stem));
  const sig = parsed.signatures[0];
  if (sig === undefined) {
    throw new Error(`${stem}.eml carries no usable DKIM signature`);
  }
  return canonicalizeBody(parsed.body, sig.c.body);
}

/**
 * Pads, cuts and decodes one canonical body exactly as `build-inputs.ts` does, at a cut of the
 * caller's choosing. The two deliberate witnesses below differ from an honest one in nothing but
 * the window they hand the circuit, which is what makes their refusal demonstrate the window rules.
 */
function bodyWindowAt(canonicalBody: Uint8Array, cut: number): BodyWindow {
  // A body whose minimal padding is wider than the circuit's body bound needs a larger buffer to pad
  // into; the window is cut down to `MAX_BODY_LENGTH` below either way.
  const maxLength = Math.max(MAX_BODY_LENGTH, 64 * Math.ceil((canonicalBody.length + 9) / 64));
  const { padded, paddedLength } = sha256Pad(canonicalBody, maxLength);
  const { precomputedSha, bodyRemaining, bodyRemainingLength } = generatePartialSha(
    padded,
    paddedLength,
    cut,
    MAX_BODY_LENGTH,
  );
  return {
    emailBody: bodyRemaining,
    emailBodyLength: bodyRemainingLength,
    precomputedSHA: precomputedSha,
    decoded: removeSoftLineBreaks(bodyRemaining, MAX_BODY_LENGTH),
  };
}

/** One registry path as `assembleInputs` takes it: the built witness's decimal strings, as bigints. */
function merklePath(
  elements: readonly string[],
  indices: readonly string[],
): { pathElements: bigint[]; pathIndices: bigint[] } {
  return {
    pathElements: elements.map((element) => BigInt(element)),
    pathIndices: indices.map((index) => BigInt(index)),
  };
}

/**
 * Assembles a witness around `honest`'s header, signature, key, registry paths and template, with a
 * replaced body window. Every other signal is the honest fixture's own, so a refusal here is the
 * window's doing and not a signature, a registry path or a nullifier that was broken on the way in.
 */
function withWindow(honest: EmailVerifierParts, window: BodyWindow): CircuitInputs {
  const honestInputs = built('valid').inputs;
  return assembleInputs({
    emailVerifier: {
      emailHeader: honest.emailHeader,
      emailHeaderLength: honest.emailHeaderLength,
      pubkey: honest.pubkey,
      signature: honest.signature,
      emailBody: window.emailBody,
      emailBodyLength: window.emailBodyLength,
      bodyHashIndex: honest.bodyHashIndex,
      precomputedSHA: window.precomputedSHA,
      decodedEmailBodyIn: window.decoded,
    },
    fields: locateFields(window.decoded, params),
    template: params,
    issuerId: issuer.issuerId,
    cityId: built('valid').cityId,
    issuerPath: merklePath(honestInputs.issuerPathElements, honestInputs.issuerPathIndices),
    cityPath: merklePath(honestInputs.cityPathElements, honestInputs.cityPathIndices),
    registryRoot: honestInputs.registryRoot,
    nullifierSalt: honestInputs.nullifierSalt,
  });
}

/** How many bytes narrower the window is in the refusal case below: one whole SHA-256 block. */
const NARROWER_WINDOW_BYTES = 64;

describe('a witness the circuit must refuse', () => {
  it('is refused by the input generator before a proving run is ever spent', () => {
    let thrown: unknown;
    try {
      buildCircuitInputs(fixture('tampered'), [issuer], registry, {
        nullifierSalt: NULLIFIER_SALT,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CircuitInputError);
    expect((thrown as CircuitInputError).code).toBe('body_hash_mismatch');
  });
  it('is refused when a tampered body is wrapped in valid.eml signed header', async () => {
    const honest = buildEmailVerifierInputs(fixture('valid'), [issuer]);
    const window = bodyWindowAt(canonicalBodyOf('tampered'), honest.precomputeCut);
    // The same length, so the same padded length and the same cut: only the body's own bytes differ,
    // and the body hash the signed header commits to no longer matches them.
    await expect(circuit().calculateWitness(withWindow(honest, window), true)).rejects.toThrow();
  });
  it('is refused when the window is 64 bytes wider than the circuit admits', async () => {
    const honest = buildEmailVerifierInputs(fixture('valid'), [issuer]);
    demand(honest.precomputeCut >= 64, 'valid.eml must be cut for this case to exist');
    const window = bodyWindowAt(canonicalBodyOf('valid'), honest.precomputeCut - 64);
    expect(window.emailBodyLength).toBe(MAX_BODY_WINDOW + 64);
    // `EmailVerifier` range-checks the length with `Num2Bits(10)` and `BodyWindow` requires it to be
    // `maxWindow` once the padded body no longer fits, so a 1,024-byte window is unsatisfiable.
    await expect(circuit().calculateWitness(withWindow(honest, window), true)).rejects.toThrow();
  });
  it('is refused when the window is a narrower suffix the email did not fix', async () => {
    const honest = buildEmailVerifierInputs(fixture('valid'), [issuer]);
    const window = bodyWindowAt(
      canonicalBodyOf('valid'),
      honest.precomputeCut + NARROWER_WINDOW_BYTES,
    );
    // A narrower suffix still hashes to the body hash the signed header commits to, because the
    // state entering it is the one the email's own bytes leave there, and the fields still extract
    // from it. `BodyWindow` is therefore the only thing stopping a prover choosing its own window —
    // and with it which occurrence of every anchor the extraction can reach (AAP 0.5.5).
    expect(window.emailBodyLength).toBe(MAX_BODY_WINDOW - NARROWER_WINDOW_BYTES);
    await expect(circuit().calculateWitness(withWindow(honest, window), true)).rejects.toThrow();
  });
});

/* DateParse, read through a wrapper of its own: four layouts and the dates no calendar has. */

/**
 * The wrapper the date rules are exercised through: `DateParse` instantiated as `main`, so the
 * layout selection, the length rule and the calendar bounds compile and run on their own. No test
 * circuit is committed; the file is written into a temporary directory and removed afterwards.
 */
const DATE_PARSE_WRAPPER = [
  'pragma circom 2.1.9;',
  '',
  'include "date_parse.circom";',
  '',
  'component main = DateParse();',
].join('\n');

/** One date case: the layout, the value's text, the `YYYYMMDD` it must yield, or `null` to refuse. */
type DateCase = [format: DateFormat, text: string, expected: number | null, extraLength?: number];

/** Every layout's shape and bounds, and the values each must accept or refuse. */
const DATE_CASES: DateCase[] = [
  ['ISO_YMD', '2026-03-05', 20260305],
  ['ISO_YMD', '2024-02-29', 20240229],
  ['ISO_YMD', '2025-02-29', null],
  ['ISO_YMD', '2019-12-31', null],
  ['ISO_YMD', '2020-01-01', 20200101],
  ['ISO_YMD', '2099-12-31', 20991231],
  ['ISO_YMD', '2100-01-01', null],
  ['D_MONTH_YYYY', '5 March 2026', 20260305],
  ['D_MONTH_YYYY', '29 February 2024', 20240229],
  ['D_MONTH_YYYY', '29 February 2025', null],
  ['D_MONTH_YYYY', '1 January 2019', null],
  ['D_MONTH_YYYY', '1 January 2020', 20200101],
  ['D_MONTH_YYYY', '31 December 2099', 20991231],
  ['D_MONTH_YYYY', '1 January 2100', null],
  ['MONTH_D_YYYY', 'March 5, 2026', 20260305],
  ['MONTH_D_YYYY', 'February 29, 2024', 20240229],
  ['MONTH_D_YYYY', 'February 29, 2025', null],
  ['MONTH_D_YYYY', 'December 31, 2019', null],
  ['MONTH_D_YYYY', 'January 1, 2020', 20200101],
  ['MONTH_D_YYYY', 'December 31, 2099', 20991231],
  ['MONTH_D_YYYY', 'January 1, 2100', null],
  ['DOW_D_MON_YYYY', 'Thu, 5 Mar 2026', 20260305],
  ['DOW_D_MON_YYYY', 'Thu, 29 Feb 2024', 20240229],
  ['DOW_D_MON_YYYY', 'Sat, 29 Feb 2025', null],
  ['DOW_D_MON_YYYY', 'Tue, 31 Dec 2019', null],
  ['DOW_D_MON_YYYY', 'Wed, 1 Jan 2020', 20200101],
  ['DOW_D_MON_YYYY', 'Thu, 31 Dec 2099', 20991231],
  ['DOW_D_MON_YYYY', 'Fri, 1 Jan 2100', null],
  // A day written with two digits where the layout admits one or two: the length rule has to accept
  // it, and the value is the same five.
  ['D_MONTH_YYYY', '05 March 2026', 20260305],
  // An ISO-shaped value offered to a layout that is not `ISO_YMD`: the selected grammar must match,
  // not merely parse, and the other layouts' parses of these bytes contribute nothing.
  ['D_MONTH_YYYY', '2026-03-05', null],
  // One byte more than the layout accounts for: the layout must consume the value exactly.
  ['ISO_YMD', '2026-03-05', null, 1],
];

/** One date text as the circuit's `value[32]`: ASCII bytes, zero-padded as `FieldExtract` leaves them. */
function paddedValue(text: string): number[] {
  const value = new Array<number>(32).fill(0);
  for (let index = 0; index < text.length && index < value.length; index += 1) {
    value[index] = text.charCodeAt(index);
  }
  return value;
}

describe('DateParse', () => {
  let dateCircuit: WasmCircuit | undefined;
  let dateIndex: SignalIndex | undefined;
  let workDir: string | undefined;
  beforeAll(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'tablemate-circuit-'));
    const wrapper = path.join(workDir, 'date_parse_main.circom');
    writeFileSync(wrapper, `${DATE_PARSE_WRAPPER}\n`);
    dateCircuit = await circomTester.wasm(wrapper, { output: workDir, include: [...INCLUDE] });
    dateIndex = await signalIndexes(path.join(workDir, 'date_parse_main.sym'), ['main.out']);
  }, CIRCUIT_TIMEOUT_MS);
  afterAll(() => {
    if (workDir !== undefined) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
  it.each(DATE_CASES)(
    'reads %s as %j, expecting %s',
    async (format, text, expected, extraLength) => {
      demand(
        dateCircuit !== undefined && dateIndex !== undefined,
        'the DateParse wrapper was not compiled: its beforeAll hook failed',
      );
      const input = {
        value: paddedValue(text),
        length: text.length + (extraLength ?? 0),
        format: DATE_FORMAT_CODE[format],
      };
      if (expected === null) {
        await expect(dateCircuit.calculateWitness(input, true)).rejects.toThrow();
        return;
      }
      const witness = await dateCircuit.calculateWitness(input, true);
      expect(signalOf(dateIndex, witness, 'out')).toBe(BigInt(expected));
    },
    CIRCUIT_TIMEOUT_MS,
  );
});
