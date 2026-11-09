/**
 * The registry suite (AAP 0.5.5): the committed `config/registry/{production,test}.json`, the off-circuit encodings of
 * `src/registry`, and their parity with the Circom templates the itinerary circuit instantiates.
 *
 * The committed registries are reproduced byte for byte from `config/`, production carrying no leaf for an issuer that
 * is not `verified` or for the synthetic test issuer; every leaf, index and root is re-derived from configuration, so an
 * edited registry fails here rather than at verification time; the boundary cases of the packing the leaf and the
 * nullifier both rest on are pinned in TypeScript; and each mirror is compared with its template through a generated
 * wrapper, because a mirror that is only self-consistent still lets the device produce a proof the server cannot verify,
 * and the domain tags and path bits are the substitution attacks that would follow.
 * The parity suite needs circom 2.1.9 on `PATH` and is never skipped, its failure naming the install command. The other
 * cases need no compiler and sit outside its `describe`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CitiesFile, IssuerConfig, RegistryFile } from '@tablemate/shared';
import type { IssuerTemplate } from '@tablemate/shared';
import { poseidon3 } from 'poseidon-lite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bytesToLatin1, parseEml } from '../src/inputs/eml-parse.ts';
import {
  ISSUER_LEAF_TAG,
  PACKED_VALUE_BYTES,
  cityAliasHash,
  cityLeaf,
  issuerLeaf,
  modulusFromBase64,
  modulusToLimbs,
  nullifierOf,
  packBytes,
  pubkeyHash,
  utf8Encode,
} from '../src/registry/leaves.ts';
import {
  EMPTY_LEAF,
  buildMerkleTree,
  buildRegistry,
  verifyMerkleProof,
} from '../src/registry/merkle.ts';
import type { TemplateParams } from '../src/registry/template-hash.ts';
import {
  TEMPLATE_FIELD_ORDER,
  templateHash,
  templateParams,
} from '../src/registry/template-hash.ts';

/* Paths, the compiler and the three fixed test values. The workspace install is hoisted, so circom
 * finds `circomlib/circuits/*` and `@zk-email/circuits/*` at the repository root. */
const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = path.resolve(PKG_DIR, '../..');
const LIB_DIR = path.join(PKG_DIR, 'circuits/lib');
const INCLUDE = [LIB_DIR, path.join(PKG_DIR, 'node_modules'), path.join(REPO_ROOT, 'node_modules')];

/** The compiler the wrappers' pragma and the pinned toolchain (AAP 0.4.2) require, and the one
 * message a missing or older one produces. */
const CIRCOM_VERSION = '2.1.9';
const CIRCOM_MESSAGE =
  `circom ${CIRCOM_VERSION} is required on PATH: ` +
  'cargo install --locked --git https://github.com/iden3/circom --tag v2.1.9';

/** The seven wrappers' compilation budget: circom compiles each one in a few seconds. */
const COMPILE_TIMEOUT_MS = 10 * 60_000;

/** The stem of the synthetic test issuer: added to the test registry, withheld from production. */
const TEST_ISSUER_STEM = 'tablemate-test';

/**
 * The fixture whose unsigned `X-Tablemate-Fixture-Key` header carries a key outside the registry; the header is not in
 * that fixture's `h=` list, so no signature covers it.
 */
const OTHER_ISSUER_EML = 'packages/circuits/fixtures/test-issuer/other-issuer.eml';
const FIXTURE_KEY_HEADER = 'x-tablemate-fixture-key';

/** The published nullifier salt as a test takes it: any decimal field element, fixed here. */
const SALT = '123456789';

/**
 * What circom's witness generator reports for a failed `!==`/`===`: the only failure a rejected parity row may throw,
 * so a row cannot pass because it was handed a bad input instead.
 */
const ASSERT_FAILED = 'Assert Failed';

/** Which registry: the `name` of `RegistryFile`, and the `config/registry/<name>.json` file stem. */
type RegistryName = 'production' | 'test';

/* Helpers, kept inline because this folder has no shared test-support module (AAP 0.11.1). */

/** Reads `list[index]`, which `noUncheckedIndexedAccess` widens, throwing instead of widening. */
function at<T>(list: readonly T[], index: number, what: string): T {
  const value = list[index];
  if (value === undefined) {
    throw new Error(`${what}: no entry at index ${index}`);
  }
  return value;
}

/** A run of printable ASCII bytes, the synthetic values the parity rows pack and hash. */
function ascii(length: number, first = 0x41): number[] {
  return Array.from({ length }, (_, index) => first + (index % 26));
}

/** Zero-pads a byte list to the 32 bytes every packed wrapper input takes. */
function pad32(bytes: readonly number[]): string[] {
  return [
    ...bytes.map((byte) => String(byte)),
    ...new Array<string>(PACKED_VALUE_BYTES - bytes.length).fill('0'),
  ];
}

/** 32 ASCII bytes whose last one is `byte`: the position byte 31 is read at. */
function withByte31(byte: number): Uint8Array {
  const bytes = new Uint8Array(PACKED_VALUE_BYTES).fill(0x41);
  bytes[PACKED_VALUE_BYTES - 1] = byte;
  return bytes;
}

/** Path bits as the decimal strings the witness calculator takes, with bit 0 replaced by `value`. */
function withFirstBit(bits: readonly (0 | 1)[], value: number): string[] {
  return bits.map((bit, index) => String(index === 0 ? value : bit));
}

/** A template's signals, as the `TemplateHash` wrapper takes them. */
function templateInput(params: TemplateParams): Record<string, unknown> {
  return {
    anchors: params.anchors.map((anchor) => [...anchor].map(String)),
    anchorLength: params.anchorLength.map(String),
    terminator: params.terminator.map(String),
    charset: params.charset.map(String),
    dateFormat: String(params.dateFormat),
  };
}

/** `params` with the booking-reference anchor replaced: the one parameter the byte-31 rows alter. */
function withReferenceAnchor(params: TemplateParams, anchor: Uint8Array): TemplateParams {
  const reference = TEMPLATE_FIELD_ORDER.indexOf('reference');
  return {
    ...params,
    anchors: params.anchors.map((existing, index) => (index === reference ? anchor : existing)),
  };
}

/** `params` with every anchor widened to its full 32 bytes: a template hashed from those signals. */
function wideAnchors(params: TemplateParams): TemplateParams {
  return {
    ...params,
    anchors: params.anchors.map(() => new Uint8Array(PACKED_VALUE_BYTES).fill(0x41)),
    anchorLength: params.anchors.map(() => PACKED_VALUE_BYTES),
  };
}

/** Reads and parses one repository configuration file, named repository-relative. */
function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')) as unknown;
}

/* The configuration both registries are rebuilt from. */

/** One issuer record of `config/issuers`, with the file stem a script selects it by. */
interface LoadedIssuer {
  stem: string;
  config: IssuerConfig;
}

/** The issuer records, ordered by file name as `scripts/build-registry.ts` orders them. */
const ISSUERS: readonly LoadedIssuer[] = readdirSync(path.join(REPO_ROOT, 'config/issuers'))
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => ({
    stem: name.slice(0, -'.json'.length),
    config: IssuerConfig.parse(readJson(`config/issuers/${name}`)),
  }));

/** The launch cities, whose aliases are the city leaves of both registries. */
const CITIES = CitiesFile.parse(readJson('config/cities.json')).cities;

/** The record `scripts/build-registry.ts`, the fixture build and the test registry select by stem. */
function issuerByStem(stem: string): IssuerConfig {
  const record = ISSUERS.find((issuer) => issuer.stem === stem);
  if (record === undefined) {
    throw new Error(`config/issuers/${stem}.json: the record is missing`);
  }
  return record.config;
}

/** An issuer's template, which its configuration guarantees for every status but `awaiting_samples`. */
function requiredTemplate(issuer: IssuerConfig): IssuerTemplate {
  if (issuer.template === null) {
    throw new Error('config/issuers: an issuer that records no template cannot carry a leaf');
  }
  return issuer.template;
}

/** The record with the keys that carry no modulus dropped, the rule the builder's script applies. */
function usableKeys(issuer: IssuerConfig): IssuerConfig {
  return { ...issuer, keys: issuer.keys.filter((key) => key.modulusBase64.trim() !== '') };
}

const TEST_ISSUER = issuerByStem(TEST_ISSUER_STEM);
const TEST_TEMPLATE = requiredTemplate(TEST_ISSUER);

/**
 * The records the production registry takes leaves from: the `verified` issuers other than the synthetic test one,
 * which is withheld by name whatever status it declares (AAP 0.5.5).
 */
const PRODUCTION_ISSUERS = ISSUERS.filter(
  (issuer) => issuer.stem !== TEST_ISSUER_STEM && issuer.config.verificationStatus === 'verified',
).map((issuer) => usableKeys(issuer.config));

/** The records the test registry takes leaves from: the production set plus the test issuer. */
const TEST_ISSUERS = [...PRODUCTION_ISSUERS, usableKeys(TEST_ISSUER)];

/** One committed registry, kept as its file's exact text beside its parsed value. */
interface CommittedRegistry {
  text: string;
  file: RegistryFile;
}

/** Reads one committed registry and parses it, so a malformed file fails this suite. */
function readRegistry(name: RegistryName): CommittedRegistry {
  const relativePath = `config/registry/${name}.json`;
  return {
    text: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
    file: RegistryFile.parse(readJson(relativePath)),
  };
}

/** The committed registries by name, for the table-driven cases below. */
const REGISTRIES: Readonly<Record<RegistryName, CommittedRegistry>> = {
  production: readRegistry('production'),
  test: readRegistry('test'),
};

/* Values derived from configuration, so no case below carries a number of its own. */

const TEST_KEY = at(TEST_ISSUER.keys, 0, 'the test issuer key');
const KEY_HASH = pubkeyHash(modulusFromBase64(TEST_KEY.modulusBase64));
const TEMPLATE_HASH = templateHash(TEST_TEMPLATE);

const CITY = at(CITIES, 0, 'a launch city');
const ALIAS_HASH = cityAliasHash(utf8Encode(at(CITY.aliases, 0, 'a city alias')));

/** The leaves and tree of the committed test registry, whose root that file records. */
const COMMITTED_LEAVES = REGISTRIES.test.file.leaves.map((leaf) => BigInt(leaf));
const COMMITTED_TREE = buildMerkleTree(COMMITTED_LEAVES);

/** The two-leaf tree every `RegistryMembership` case changes one thing about. */
const TWO_LEAF_TREE = buildMerkleTree([
  issuerLeaf(TEST_ISSUER.issuerId, KEY_HASH, TEMPLATE_HASH),
  cityLeaf(CITY.circuitCityId, ALIAS_HASH),
]);
const ISSUER_PATH = TWO_LEAF_TREE.proof(0);
const CITY_PATH = TWO_LEAF_TREE.proof(1);

/** The issuer path bits with bit 0 flipped: the wrong sibling hashed at the leaf level. */
const FLIPPED_ISSUER_BITS = withFirstBit(
  ISSUER_PATH.pathIndices,
  1 - at(ISSUER_PATH.pathIndices, 0, 'a path bit'),
);

/** A circuit input whose field elements are decimal strings, as the witness calculator takes them. */
const HONEST_MEMBERSHIP: Record<string, unknown> = {
  registryRoot: String(TWO_LEAF_TREE.root),
  issuerId: String(TEST_ISSUER.issuerId),
  pubkeyHash: String(KEY_HASH),
  templateHash: String(TEMPLATE_HASH),
  issuerPathElements: ISSUER_PATH.pathElements.map(String),
  issuerPathIndices: ISSUER_PATH.pathIndices.map(String),
  cityId: String(CITY.circuitCityId),
  cityAliasHash: String(ALIAS_HASH),
  cityPathElements: CITY_PATH.pathElements.map(String),
  cityPathIndices: CITY_PATH.pathIndices.map(String),
};

/**
 * The modulus the outside-key fixture carries in its unsigned `X-Tablemate-Fixture-Key` header: the key the
 * `PoseidonLarge` parity row hashes to show it is not the registered one. It is read from the fixture rather than
 * written here, with every byte of folding whitespace dropped.
 */
function fixtureKeyModulus(): bigint {
  const { headers } = parseEml(readFileSync(path.join(REPO_ROOT, OTHER_ISSUER_EML)));
  const field = headers.find((header) => header.lowerName === FIXTURE_KEY_HEADER);
  if (field === undefined) {
    throw new Error(`${OTHER_ISSUER_EML}: no ${FIXTURE_KEY_HEADER} header`);
  }
  const raw = bytesToLatin1(field.raw);
  return modulusFromBase64(raw.slice(raw.indexOf(':') + 1).replace(/\s+/g, ''));
}

const FIXTURE_KEY_HASH = pubkeyHash(fixtureKeyModulus());

/* The committed registries: no compiler needed. */

describe('the committed registries', () => {
  it.each<[RegistryName]>([['production'], ['test']])(
    'reproduces config/registry/%s.json byte for byte from config/',
    (name) => {
      const issuers = name === 'production' ? PRODUCTION_ISSUERS : TEST_ISSUERS;
      const { registry } = buildRegistry({ name, issuers, cities: CITIES });
      // The exact bytes `scripts/build-registry.ts` writes, which `--check` and every reader of the
      // committed file depend on.
      expect(`${JSON.stringify(registry, null, 2)}\n`).toBe(REGISTRIES[name].text);
    },
  );
  it('gives production a leaf only to a verified issuer other than the test one', () => {
    const leafIssuerIds = new Set(
      REGISTRIES.production.file.issuers.map((entry) => entry.issuerId),
    );
    for (const { stem, config } of ISSUERS) {
      const recordsLeaf =
        stem !== TEST_ISSUER_STEM &&
        config.verificationStatus === 'verified' &&
        usableKeys(config).keys.length > 0;
      // Both directions, so an issuer that should have no leaf cannot acquire one: Booking.com and
      // Airbnb, awaiting samples with no key and no template, have no entry at all.
      expect(leafIssuerIds.has(config.issuerId)).toBe(recordsLeaf);
    }
  });
  it.each<[RegistryName]>([['production'], ['test']])(
    'registers every configured city alias of %s under its computed hash',
    (name) => {
      const hashes = new Map(
        REGISTRIES[name].file.cities.map((entry) => [
          `${entry.cityId}:${entry.alias}`,
          entry.aliasHash,
        ]),
      );
      const expected = CITIES.flatMap((city) =>
        city.aliases.map((alias) => ({
          key: `${city.circuitCityId}:${alias}`,
          hash: cityAliasHash(utf8Encode(alias)).toString(),
        })),
      );
      // Sizes first, so an alias the configuration does not hold is a failure too.
      expect(hashes.size).toBe(expected.length);
      for (const { key, hash } of expected) {
        expect(hashes.get(key)).toBe(hash);
      }
    },
  );
  it.each<[RegistryName]>([['production'], ['test']])(
    'places every %s entry at the leaf its index names and holds its path to the root',
    (name) => {
      const { file } = REGISTRIES[name];
      const leaves = file.leaves.map((leaf) => BigInt(leaf));
      const tree = buildMerkleTree(leaves);
      const indexes = [...file.issuers, ...file.cities].map((entry) => entry.leafIndex);
      expect(leaves.length).toBe(file.issuers.length + file.cities.length);
      expect(tree.root.toString()).toBe(file.root);
      expect(new Set(indexes).size).toBe(indexes.length);
      for (const entry of file.issuers) {
        expect(at(leaves, entry.leafIndex, 'a leaf')).toBe(
          issuerLeaf(entry.issuerId, BigInt(entry.pubkeyHash), BigInt(entry.templateHash)),
        );
      }
      for (const entry of file.cities) {
        expect(at(leaves, entry.leafIndex, 'a leaf')).toBe(
          cityLeaf(entry.cityId, BigInt(entry.aliasHash)),
        );
      }
      for (const index of indexes) {
        expect(verifyMerkleProof(at(leaves, index, 'a leaf'), tree.proof(index))).toBe(true);
      }
    },
  );
  it('derives the test registry leaf from the configured key and template', () => {
    const entry = at(REGISTRIES.test.file.issuers, 0, 'the test issuer entry');
    expect(entry.pubkeyHash).toBe(KEY_HASH.toString());
    expect(entry.templateHash).toBe(TEMPLATE_HASH.toString());
  });
});

/* The off-circuit encodings: no compiler needed either. */

describe('the off-circuit encodings', () => {
  it('tags the two leaf types apart over the same numbers', () => {
    const id = TEST_ISSUER.issuerId;
    // The issuer tag over the city leaf's preimage, which a city leaf must not equal.
    expect(cityLeaf(id, ALIAS_HASH)).not.toBe(poseidon3([ISSUER_LEAF_TAG, BigInt(id), ALIAS_HASH]));
    expect(issuerLeaf(id, KEY_HASH, TEMPLATE_HASH)).not.toBe(cityLeaf(id, KEY_HASH));
    expect(issuerLeaf(id, KEY_HASH, TEMPLATE_HASH)).not.toBe(cityLeaf(id, TEMPLATE_HASH));
  });
  it('hashes the key outside the registry to a different limb hash', () => {
    expect(FIXTURE_KEY_HASH).not.toBe(KEY_HASH);
  });
  it.each([
    { what: 'byte 31 from 0x01 to 0x02', before: 0x01, after: 0x02 },
    { what: 'byte 31 from 0xFE to 0xFF', before: 0xfe, after: 0xff },
    { what: 'byte 31 from 0xFF to 0x00', before: 0xff, after: 0x00 },
  ])(
    'separates two 32-byte values differing only at $what in the nullifier, the city leaf and the template',
    ({ before, after }) => {
      const a = withByte31(before);
      const b = withByte31(after);
      const params = templateParams(TEST_TEMPLATE);
      // One booking, one nullifier: byte 31 reaches the hash as `pack[1]`, never as weight inside
      // `pack[0]`, so two references differing there cannot collide.
      expect(nullifierOf(a, SALT)).not.toBe(nullifierOf(b, SALT));
      expect(cityAliasHash(a)).not.toBe(cityAliasHash(b));
      expect(cityLeaf(CITY.circuitCityId, cityAliasHash(a))).not.toBe(
        cityLeaf(CITY.circuitCityId, cityAliasHash(b)),
      );
      expect(templateHash(withReferenceAnchor(params, a))).not.toBe(
        templateHash(withReferenceAnchor(params, b)),
      );
    },
  );
  it('packs 31 bytes into a zero high half, 32 into their last byte, and refuses 33', () => {
    const [, highShort] = packBytes(new Uint8Array(31).fill(0x41));
    expect(highShort).toBe(0n);
    const [, highLong] = packBytes(withByte31(0x7f));
    expect(highLong).toBe(0x7fn);
    expect(() => packBytes(new Uint8Array(33))).toThrow(RangeError);
  });
  it('keeps a trailing zero byte distinct through the length it is hashed with', () => {
    const three = new Uint8Array([0x41, 0x42, 0x43]);
    const four = new Uint8Array([0x41, 0x42, 0x43, 0x00]);
    // The two pack alike — which is why a packed value is always hashed together with its length.
    expect(packBytes(three)).toEqual(packBytes(four));
    expect(nullifierOf(three, SALT)).not.toBe(nullifierOf(four, SALT));
  });
});

/* The Circom parity: circom 2.1.9 on PATH, and one generated wrapper per template under test. */

/** The directory the wrappers are written into and compiled in; removed in `afterAll`. */
let tmpDir = '';

/**
 * `circom_tester` 0.0.24 ships no declarations, so the one entry point used here is loaded through `createRequire` and
 * typed by these two declarations rather than by a `.d.ts` for the package.
 */
interface WasmCircuit {
  calculateWitness(input: Record<string, unknown>, sanityCheck: boolean): Promise<bigint[]>;
  loadSymbols(): Promise<void>;
  symbols: Record<string, { varIdx: number }>;
}

type WasmTester = (
  file: string,
  options: { output?: string; recompile?: boolean; include?: string[] },
) => Promise<WasmCircuit>;

const wasmTester = (createRequire(import.meta.url)('circom_tester') as { wasm: WasmTester }).wasm;

/** The compiled wrappers, one per template under test. */
interface Wrappers {
  pack: WasmCircuit;
  cityAlias: WasmCircuit;
  template: WasmCircuit;
  nullifier: WasmCircuit;
  inclusion: WasmCircuit;
  membership: WasmCircuit;
  poseidonLarge: WasmCircuit;
}

/** The package's own libraries, by absolute path, and the one reached through `-l node_modules`. */
const libPath = (name: string): string => path.join(LIB_DIR, name);
const ANCHOR_EXTRACT_LIB = libPath('anchor_extract.circom');
const REGISTRY_MEMBERSHIP_LIB = libPath('registry_membership.circom');
const TEMPLATE_HASH_LIB = libPath('template_hash.circom');
const NULLIFIER_LIB = libPath('nullifier.circom');
const ZK_EMAIL_HASH_LIB = '@zk-email/circuits/utils/hash.circom';

/** One signal of a witness the caller has already computed, by the wrapper's symbol name. */
function signalOf(circuit: WasmCircuit, name: string, witness: readonly bigint[]): bigint {
  const symbol = circuit.symbols[name];
  if (symbol === undefined) {
    throw new Error(`the wrapper records no ${name} signal`);
  }
  return at(witness, symbol.varIdx, 'the witness');
}

/** Computes a wrapper's witness and reads one of its signals out of it. */
async function compute(
  circuit: WasmCircuit,
  name: string,
  input: Record<string, unknown>,
): Promise<bigint> {
  return signalOf(circuit, name, await circuit.calculateWitness(input, true));
}

/**
 * Requires circom 2.1.9 on `PATH`. A missing or older compiler fails the suite with the install command: these parity
 * cases are the only evidence that the mirrors above match the circuit, so skipping them silently would leave that
 * unproven.
 *
 * @throws {Error} With {@link CIRCOM_MESSAGE}.
 */
function assertCircom(): void {
  let version = '';
  try {
    version = execFileSync('circom', ['--version'], { encoding: 'utf8' });
  } catch {
    throw new Error(CIRCOM_MESSAGE);
  }
  if (!version.includes(CIRCOM_VERSION)) {
    throw new Error(CIRCOM_MESSAGE);
  }
}

/**
 * Writes one wrapper — a pragma, the includes and a `main` component — into {@link tmpDir} and compiles it there, so
 * no test circuit is committed.
 */
async function compileWrapper(
  name: string,
  includes: readonly string[],
  main: string,
): Promise<WasmCircuit> {
  const file = path.join(tmpDir, `${name}.circom`);
  const source = [
    'pragma circom 2.1.9;',
    ...includes.map((include) => `include "${include}";`),
    `component main = ${main};`,
    '',
  ];
  writeFileSync(file, source.join('\n'), 'utf8');
  const circuit = await wasmTester(file, { output: tmpDir, include: [...INCLUDE] });
  await circuit.loadSymbols();
  return circuit;
}

describe('the circom templates', () => {
  let wrappers: Wrappers;
  beforeAll(async () => {
    assertCircom();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'tablemate-registry-'));
    // Sequentially, because each compilation is one `circom` process over the same include paths.
    wrappers = {
      pack: await compileWrapper('checked-pack', [ANCHOR_EXTRACT_LIB], 'CheckedPackBytes(32)'),
      cityAlias: await compileWrapper(
        'city-alias-hash',
        [REGISTRY_MEMBERSHIP_LIB],
        'CityAliasHash()',
      ),
      template: await compileWrapper('template-hash', [TEMPLATE_HASH_LIB], 'TemplateHash()'),
      nullifier: await compileWrapper('nullifier', [NULLIFIER_LIB], 'Nullifier()'),
      inclusion: await compileWrapper(
        'merkle-inclusion',
        [REGISTRY_MEMBERSHIP_LIB],
        'MerkleInclusion(8)',
      ),
      membership: await compileWrapper(
        'registry-membership',
        [REGISTRY_MEMBERSHIP_LIB],
        'RegistryMembership(8)',
      ),
      poseidonLarge: await compileWrapper(
        'poseidon-large',
        [ZK_EMAIL_HASH_LIB],
        'PoseidonLarge(121, 17)',
      ),
    };
  }, COMPILE_TIMEOUT_MS);
  afterAll(() => {
    if (tmpDir !== '') {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it.each<{ what: string; bytes: number[]; ok: boolean }>([
    { what: '31 ASCII bytes', bytes: ascii(31), ok: true },
    { what: '32 bytes with a non-zero byte 31', bytes: [...ascii(31), 0x2a], ok: true },
    { what: '32 bytes of 0xFF', bytes: new Array<number>(PACKED_VALUE_BYTES).fill(0xff), ok: true },
    { what: 'a single byte', bytes: [0x41], ok: true },
    { what: 'a byte above 255', bytes: [256], ok: false },
  ])('packs $what as packBytes does', async ({ bytes: row, ok }) => {
    const input = { in: pad32(row) };
    if (!ok) {
      // The `Num2Bits(8)` range check `CheckedPackBytes` adds to zk-email's own packing, which
      // circom turns into a witness-time assertion rather than a warning.
      await expect(wrappers.pack.calculateWitness(input, true)).rejects.toThrow(ASSERT_FAILED);
      return;
    }
    const witness = await wrappers.pack.calculateWitness(input, true);
    const [low, high] = packBytes(new Uint8Array(row));
    expect(signalOf(wrappers.pack, 'main.out[0]', witness)).toBe(low);
    expect(signalOf(wrappers.pack, 'main.out[1]', witness)).toBe(high);
  });
  it.each([
    { what: 'a configured city alias', value: at(CITY.aliases, 0, 'a city alias') },
    { what: 'a 31-byte alias', value: 'x'.repeat(31) },
    { what: 'a 32-byte alias', value: 'x'.repeat(32) },
  ])('hashes $what as cityAliasHash does', async ({ value }) => {
    const bytes = utf8Encode(value);
    expect(
      await compute(wrappers.cityAlias, 'main.out', {
        cityBytes: pad32([...bytes]),
        cityLength: String(bytes.length),
      }),
    ).toBe(cityAliasHash(bytes));
  });
  it.each([
    { what: 'the registered test-issuer template', params: templateParams(TEST_TEMPLATE) },
    { what: 'a template with 32-byte anchors', params: wideAnchors(templateParams(TEST_TEMPLATE)) },
  ])('hashes $what as templateHash does', async ({ params }) => {
    expect(await compute(wrappers.template, 'main.out', templateInput(params))).toBe(
      templateHash(params),
    );
  });
  it.each([
    { what: 'a 31-byte reference', value: 'R'.repeat(31) },
    { what: 'a 32-byte reference', value: 'R'.repeat(32) },
  ])('hashes $what as nullifierOf does', async ({ value }) => {
    const bytes = utf8Encode(value);
    expect(
      await compute(wrappers.nullifier, 'main.out', {
        refBytes: pad32([...bytes]),
        refLength: String(bytes.length),
        salt: SALT,
      }),
    ).toBe(nullifierOf(bytes, SALT));
  });
  it.each([0, 1, COMMITTED_LEAVES.length - 1, 255].map((index) => ({ index })))(
    'folds the committed path at index $index onto the committed root',
    async ({ index }) => {
      const proof = COMMITTED_TREE.proof(index);
      const leaf =
        index < COMMITTED_LEAVES.length ? at(COMMITTED_LEAVES, index, 'a leaf') : EMPTY_LEAF;
      expect(
        await compute(wrappers.inclusion, 'main.root', {
          leaf: String(leaf),
          pathElements: proof.pathElements.map(String),
          pathIndices: proof.pathIndices.map(String),
        }),
      ).toBe(COMMITTED_TREE.root);
    },
  );
  it.each<{ what: string; bits: string[]; ok: boolean }>([
    {
      what: 'the honest committed path',
      bits: COMMITTED_TREE.proof(1).pathIndices.map(String),
      ok: true,
    },
    {
      what: 'a non-binary path bit',
      bits: withFirstBit(COMMITTED_TREE.proof(1).pathIndices, 2),
      ok: false,
    },
  ])('answers $what by MerkleInclusion(8)', async ({ bits, ok }) => {
    const input = {
      leaf: at(COMMITTED_LEAVES, 1, 'a leaf').toString(),
      pathElements: COMMITTED_TREE.proof(1).pathElements.map(String),
      pathIndices: bits,
    };
    // `bit · (bit − 1) === 0` is what makes a path bit one of two children rather than any index.
    if (ok) {
      expect(await compute(wrappers.inclusion, 'main.root', input)).toBe(COMMITTED_TREE.root);
      return;
    }
    await expect(wrappers.inclusion.calculateWitness(input, true)).rejects.toThrow(ASSERT_FAILED);
  });
  it.each([
    { what: 'the test issuer modulus', modulus: modulusFromBase64(TEST_KEY.modulusBase64) },
    { what: 'the key outside the registry', modulus: fixtureKeyModulus() },
  ])('hashes $what as pubkeyHash does', async ({ modulus }) => {
    expect(
      await compute(wrappers.poseidonLarge, 'main.out', {
        in: modulusToLimbs(modulus).map(String),
      }),
    ).toBe(pubkeyHash(modulus));
  });
  it.each<{ what: string; input: Record<string, unknown>; ok: boolean }>([
    { what: 'the honest two-leaf witness', input: HONEST_MEMBERSHIP, ok: true },
    {
      what: 'an issuer leaf presented as the city leaf',
      input: {
        ...HONEST_MEMBERSHIP,
        cityId: String(TEST_ISSUER.issuerId),
        cityAliasHash: String(KEY_HASH),
        cityPathElements: ISSUER_PATH.pathElements.map(String),
        cityPathIndices: ISSUER_PATH.pathIndices.map(String),
      },
      ok: false,
    },
    {
      what: 'one flipped issuer path bit',
      input: { ...HONEST_MEMBERSHIP, issuerPathIndices: FLIPPED_ISSUER_BITS },
      ok: false,
    },
    {
      what: 'a non-binary issuer path bit',
      input: { ...HONEST_MEMBERSHIP, issuerPathIndices: withFirstBit(ISSUER_PATH.pathIndices, 2) },
      ok: false,
    },
    {
      what: 'a non-binary city path bit',
      input: { ...HONEST_MEMBERSHIP, cityPathIndices: withFirstBit(CITY_PATH.pathIndices, 2) },
      ok: false,
    },
  ])('answers $what by RegistryMembership(8)', async ({ input, ok }) => {
    // The template has no outputs: the two leaves are constrained to one published root, so an
    // honest witness is a witness that computes and a substituted leaf is one that does not.
    if (ok) {
      const witness = await wrappers.membership.calculateWitness(input, true);
      expect(witness.length).toBeGreaterThan(0);
      return;
    }
    await expect(wrappers.membership.calculateWitness(input, true)).rejects.toThrow(ASSERT_FAILED);
  });
});
