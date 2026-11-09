/**
 * The no-server-proving suite (AAP 0.8.1, AAP 0.12.2): the API verifies an itinerary proof and never
 * produces one. Four facts, each read from the file that decides it:
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as shared from '@tablemate/shared';

/** The workspace marker: only the repository root holds it (AAP 0.6.2). */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/** The tree the scan reads, and the file whose runtime stage is checked instruction by instruction. */
const API_SOURCE_DIR = 'apps/api/src';
const API_DOCKERFILE = 'apps/api/Dockerfile';

/**
 * The repository root: the nearest ancestor of this file's directory that holds the workspace marker.
 * Walking up keeps the suite independent of where Vitest was started.
 */
function findRepoRoot(): string {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, WORKSPACE_MARKER))) {
      return dir;
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`repository root not found: no ancestor holds ${WORKSPACE_MARKER}`);
    }
  }
}

/** The repository root, resolved once. */
const REPO_ROOT = findRepoRoot();

/** Every file under a repository-relative directory, as sorted repository-relative POSIX paths. */
function filesUnder(relativeDir: string): string[] {
  return readdirSync(path.join(REPO_ROOT, relativeDir), { recursive: true, encoding: 'utf8' })
    .map((entry) => path.posix.join(relativeDir, entry.split(path.sep).join('/')))
    .sort();
}

/** The extensions the syntax scan parses, and a file read from the repository. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js']);

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** Every TypeScript or JavaScript file under `apps/api/src`, and every JSON file beside them. */
const API_SOURCE_FILES = filesUnder(API_SOURCE_DIR).filter((file) =>
  SOURCE_EXTENSIONS.has(path.extname(file)),
);
const API_JSON_FILES = filesUnder(API_SOURCE_DIR).filter((file) => path.extname(file) === '.json');

describe('the API source tree', () => {
  it('is read, so a wrong path cannot pass vacuously', () => {
    expect(API_SOURCE_FILES.length).toBeGreaterThan(50);
    expect(API_SOURCE_FILES).toContain('apps/api/src/modules/proofs/verifier.ts');
    expect(API_SOURCE_FILES.every((file) => SOURCE_EXTENSIONS.has(path.extname(file)))).toBe(true);
    expect(API_JSON_FILES).toContain('apps/api/src/modules/voice-agent/i18n/en-US.json');
  });
  it('holds the Dockerfile whose runtime stage is checked', () => {
    expect(readRepoFile(API_DOCKERFILE)).toContain('AS runtime');
  });
});

/** One Dockerfile stage: its name and the instructions that can bring a file into it. */
interface DockerStage {
  /** The stage's `AS` name, lowercased, or undefined for a stage that opens without one. */
  readonly name: string | undefined;
  /** Its COPY, ADD and RUN instructions, continuations joined and comments dropped. */
  readonly commands: string[];
}

/**
 * Parses a Dockerfile into its stages: comment lines dropped, backslash continuations joined so a
 * multi-line `RUN` is one instruction, then the lines split at `FROM`, each `FROM` opening a stage that
 * holds everything up to the next one.
 */
function parseDockerfile(text: string): DockerStage[] {
  const instructions: string[] = [];
  let pending = '';
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) {
      continue;
    }
    const continues = /\\\s*$/.test(line);
    pending += ` ${line.replace(/\\\s*$/, ' ')}`;
    if (!continues && pending.trim() !== '') {
      instructions.push(pending.trim());
      pending = '';
    }
  }
  const stages: DockerStage[] = [];
  for (const instruction of instructions) {
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(instruction);
    if (from !== null) {
      stages.push({ name: from[1]?.toLowerCase(), commands: [] });
      continue;
    }
    const stage = stages.at(-1);
    if (stage !== undefined && /^(COPY|ADD|RUN)\s+\S/i.test(instruction)) {
      stage.commands.push(instruction);
    }
  }
  return stages;
}

/** The stages of `apps/api/Dockerfile`, parsed once. */
const DOCKER_STAGES = parseDockerfile(readRepoFile(API_DOCKERFILE));

/**
 * The stage a plain build yields: the last one. A build with `--target` may stop at `test-support`,
 * which carries the dev dependencies the migrate, stripe-proxy and voice-sim services run on.
 */
function runtimeStage(): DockerStage {
  const stage = DOCKER_STAGES.at(-1);
  if (stage === undefined) {
    throw new Error(`${API_DOCKERFILE} holds no FROM stage`);
  }
  return stage;
}

/**
 * What the runtime stage may not contain, one pattern per reason, read against its COPY, ADD and RUN
 * instructions. A `.wasm` inside `node_modules` is deliberately not one: snarkjs' verification code and
 * the curve code ffjavascript builds for it arrive with the production dependency install, never
 * through an explicit `COPY` of a `.wasm` path, which is what the third row would find.
 */
const FORBIDDEN_IN_RUNTIME: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  { what: 'proving key', pattern: /\.zkey\b/ },
  { what: 'circuit WASM build', pattern: /\.wasm\b/ },
  { what: 'powers-of-tau file', pattern: /\.ptau\b/ },
  {
    what: 'circuit, outside the verification key and the artefact manifest',
    pattern: /tablemate_itinerary(?!.*(verification_key\.json|artifacts\.manifest\.json))/,
  },
  { what: 'circuit witness generator', pattern: /tablemate_itinerary_js/ },
  { what: 'witness generator', pattern: /witness|wtns|witnesscalc/ },
  { what: 'native prover', pattern: /rapidsnark|\bprover\b/ },
  { what: 'anything from mopro', pattern: /mopro/ },
  { what: 'test harness', pattern: /dist\/test|test\/support/ },
];

/** The two instruction kinds that copy files into an image. */
const COPY_KINDS = new Set(['COPY', 'ADD']);

/**
 * The source paths the COPY and ADD instructions of a stage name: every argument before the last, which
 * is the destination. Each path loses the image's `/app` prefix and any trailing slash, so it compares
 * the way the workspace spells it.
 */
function copySources(commands: readonly string[]): string[] {
  const sources: string[] = [];
  for (const command of commands) {
    const [kind, ...rest] = command.split(/\s+/);
    if (kind === undefined || !COPY_KINDS.has(kind.toUpperCase())) {
      continue;
    }
    const args = rest.filter((arg) => !arg.startsWith('--'));
    for (const source of args.slice(0, -1)) {
      sources.push(source.replace(/^\/app\//, '').replace(/\/+$/, ''));
    }
  }
  return sources;
}

describe('the runtime image', () => {
  it('is the last stage, built after the stage the test tooling runs on', () => {
    expect(runtimeStage().name).toBe('runtime');
    expect(DOCKER_STAGES.slice(0, -1).map((stage) => stage.name)).toContain('test-support');
    // A stage whose instructions parsed to nothing would pass every row below in silence.
    expect(runtimeStage().commands.length).toBeGreaterThan(10);
  });
  it.each(FORBIDDEN_IN_RUNTIME)('copies no $what', ({ pattern }) => {
    expect(runtimeStage().commands.filter((command) => pattern.test(command))).toEqual([]);
  });
  it('copies the compiled server and its scripts, and never the whole api build output', () => {
    const sources = copySources(runtimeStage().commands);
    // `rootDir: "."` puts `dist/test` beside `dist/src`, so the whole output would carry the suite and
    // its support harness into the serving image.
    expect(sources.filter((source) => source === 'apps/api/dist')).toEqual([]);
    expect(sources).toContain('apps/api/dist/src');
    expect(sources).toContain('apps/api/dist/scripts');
  });
  it('takes nothing from the circuit build directory, which the run-time mount supplies', () => {
    // One runtime instruction names `packages/circuits/build`: a `RUN mkdir` creating the empty
    // directory the compose bind mounts of the verification key and the manifest land in. No COPY or
    // ADD may name it, so no proving material is ever baked into the serving image (AAP 0.5.5).
    const sources = copySources(runtimeStage().commands);
    expect(sources.filter((source) => source.startsWith('packages/circuits/build'))).toEqual([]);
  });
});

/** The two snarkjs entry points that produce a proof, the receiver they hang off, and that name. */
const PROVING_ENTRYPOINTS = new Set(['prove', 'fullProve']);
const GROTH16 = 'groth16';
const FULL_PROVE = 'fullProve';

/** Every member of these receivers witnesses: `plonk.prove`, `fflonk.prove`, `wtns.calculate`. */
const WITNESS_ONLY_RECEIVERS: readonly string[] = ['plonk', 'fflonk', 'wtns'];

/** The packages holding a native prover: a specifier that reaches either is the failure itself. */
const PROVING_MODULE = /rapidsnark|mopro/i;

/** One property or string-keyed element access: the node and the static name it reads. */
interface NamedAccess {
  readonly node: ts.Node;
  readonly name: string;
}

/** One source text, parsed without checking it: the scan reads syntax, not types. */
function parseSource(fileName: string, sourceText: string): ts.SourceFile {
  return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
}

/**
 * Calls `visit` on every node of a tree, parents before children. Comments are not nodes, which is what
 * keeps a TSDoc line saying "never call groth16.fullProve" out of the scan's results.
 */
function walkTree(root: ts.Node, visit: (node: ts.Node) => void): void {
  visit(root);
  ts.forEachChild(root, (child) => walkTree(child, visit));
}

/** The name a property access or string-keyed element access reads, when it is static. */
function accessedName(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  const key = node.argumentExpression;
  return key !== undefined && ts.isStringLiteral(key) ? key.text : undefined;
}

/**
 * The last static name of an expression: `snarkjs.groth16`, `a.snarkjs.groth16` and `snarkjs['groth16']`
 * all read `groth16`, so the receiver rules see through either spelling.
 */
function lastAccessedName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    ? accessedName(expression)
    : undefined;
}

/** Every property or string-keyed element access on a receiver whose last static name is `receiver`. */
function accessesOf(root: ts.Node, receiver: string): NamedAccess[] {
  const found: NamedAccess[] = [];
  walkTree(root, (node) => {
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) {
      return;
    }
    const name = accessedName(node);
    if (name !== undefined && lastAccessedName(node.expression) === receiver) {
      found.push({ node, name });
    }
  });
  return found;
}

/** The module specifier a `require()`, a dynamic `import()` or a `createRequire()(…)` call names. */
function requiredSpecifier(call: ts.CallExpression): string | undefined {
  const first = call.arguments.at(0);
  if (first === undefined || !ts.isStringLiteral(first)) {
    return undefined;
  }
  const callee = call.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) {
    return first.text;
  }
  if (ts.isIdentifier(callee) && callee.text === 'require') {
    return first.text;
  }
  if (
    ts.isCallExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'createRequire'
  ) {
    return first.text;
  }
  return undefined;
}

/**
 * Every proving use in one source text, as `fileName:line:kind` (AAP 0.12.2): a Groth16 proof call, the
 * `fullProve` name wherever it appears, any access on `plonk`, `fflonk` or `wtns`, and a specifier that
 * reaches `rapidsnark` or `mopro` through an import, an export, an `import … = require`, a dynamic
 * import, a `require` or a `createRequire`. The Groth16 *verification* is not a proving use.
 */
function findProvingUses(sourceText: string, fileName: string): string[] {
  const file = parseSource(fileName, sourceText);
  const findings = new Set<string>();
  const report = (kind: string, node: ts.Node): void => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    findings.add(`${fileName}:${line}:${kind}`);
  };
  const checkSpecifier = (specifier: string, node: ts.Node): void => {
    if (PROVING_MODULE.test(specifier)) {
      report(`proving-module:${specifier}`, node);
    }
  };
  for (const { node, name } of accessesOf(file, GROTH16)) {
    if (PROVING_ENTRYPOINTS.has(name)) {
      report(`${GROTH16}.${name}`, node);
    }
  }
  for (const receiver of WITNESS_ONLY_RECEIVERS) {
    for (const { node, name } of accessesOf(file, receiver)) {
      report(`${receiver}.${name}`, node);
    }
  }
  walkTree(file, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      checkSpecifier(node.moduleSpecifier.text, node);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      checkSpecifier(node.moduleSpecifier.text, node);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      checkSpecifier(node.moduleReference.expression.text, node);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      checkSpecifier(node.argument.literal.text, node);
    } else if (ts.isCallExpression(node)) {
      const specifier = requiredSpecifier(node);
      if (specifier !== undefined) {
        checkSpecifier(specifier, node);
      }
    } else if (ts.isIdentifier(node) && node.text === FULL_PROVE) {
      report(FULL_PROVE, node);
    }
  });
  return [...findings].sort();
}

/** One synthetic source text and whether {@link findProvingUses} must report it. */
type ScanCase = readonly [label: string, source: string, flagged: boolean];

/**
 * The scan's own cases (AAP 0.12.2): the three Groth16 spellings and the destructured binding, the two
 * witness-only receivers, the three ways a native prover is reached, and the two shapes that stay clean
 * — the verification call the API does make, and a comment naming the call it must not.
 */
const SCAN_CASES: readonly ScanCase[] = [
  ['reports a Groth16 full proof', 'snarkjs.groth16.fullProve(i, w, z);', true],
  ['reports a Groth16 proof', 'snarkjs.groth16.prove(z, w);', true],
  ['reports a bracketed Groth16 proof', "snarkjs.groth16['fullProve'](i, w, z);", true],
  ['reports a destructured Groth16 prover', 'const { fullProve } = snarkjs.groth16;', true],
  ['reports a witness calculation', 'snarkjs.wtns.calculate(i, w, o);', true],
  ['reports a PLONK proof', 'snarkjs.plonk.prove(z, w);', true],
  ['reports an import of the native prover', "import { x } from 'rapidsnark';", true],
  ['reports a dynamic import of mopro', "await import('@zkmopro/x');", true],
  ['reports a require of the native prover', "require('rapidsnark');", true],
  ['ignores a comment naming the proving call', '// groth16.fullProve is forbidden', false],
  ['ignores the Groth16 verification', 'snarkjs.groth16.verify(vk, s, p);', false],
];

describe('findProvingUses', () => {
  it.each(SCAN_CASES)('%s', (_label, source, flagged) => {
    const findings = findProvingUses(source, 'inline.ts');
    if (flagged) {
      expect(findings.length, findings.join(' ')).toBeGreaterThan(0);
    } else {
      expect(findings, findings.join(' ')).toEqual([]);
    }
  });
  it('names the entry point it found, with its line', () => {
    expect(findProvingUses('snarkjs.groth16.fullProve(i, w, z);', 'inline.ts')).toEqual([
      'inline.ts:1:fullProve',
      'inline.ts:1:groth16.fullProve',
    ]);
  });
});

describe('the API sources', () => {
  it('call no proving entry point and import no native prover', () => {
    const findings = API_SOURCE_FILES.flatMap((file) => findProvingUses(readRepoFile(file), file));
    expect(findings).toEqual([]);
  });
  it('verify a proof through the Groth16 verifier and nothing else', () => {
    const file = 'apps/api/src/modules/proofs/verifier.ts';
    const accesses = accessesOf(parseSource(file, readRepoFile(file)), GROTH16);
    // The positive control: the one file that verifies a proof is found by the same walk that must find
    // a proving call, so a scan reporting nothing is proven to be reading the tree.
    expect(accesses.map((access) => access.name)).toContain('verify');
    expect(accesses.filter((access) => PROVING_ENTRYPOINTS.has(access.name))).toEqual([]);
  });
});

/** The generator that builds circuit inputs: the witness inputs are read from it on every run. */
const CIRCUIT_INPUTS_FILE = 'packages/circuits/src/inputs/build-inputs.ts';

/** The property names one interface declares: two-space declarations between its braces, TSDoc excluded. */
function interfaceMembers(sourceText: string, name: string): string[] {
  const lines = sourceText.split('\n');
  const header = lines.findIndex((line) => new RegExp(`interface\\s+${name}\\s*\\{`).test(line));
  if (header < 0) {
    return [];
  }
  const members: string[] = [];
  for (const line of lines.slice(header + 1)) {
    if (line.startsWith('}')) {
      break;
    }
    const member = /^ {2}([A-Za-z][A-Za-z0-9]*)\??:/.exec(line);
    if (member?.[1] !== undefined) {
      members.push(member[1]);
    }
  }
  return members;
}

/**
 * The witness inputs `buildCircuitInputs` emits (AAP 0.5.5), read from the interface that declares them
 * rather than copied here, so a new private input extends the forbidden set instead of slipping past it.
 */
const GENERATOR_INPUTS = interfaceMembers(readRepoFile(CIRCUIT_INPUTS_FILE), 'CircuitInputs');

/**
 * The names of {@link GENERATOR_INPUTS} that are not private, and so may legitimately key a schema.
 *
 * `registryRoot` and `nullifierSalt` are the circuit's two *public* inputs, and `anchor`,
 * `terminator`, `charset` and `dateFormat` are the issuer's extraction template — all published by
 * `GET /v1/zk/config`, because the device cannot build inputs without them (AAP 0.5.4, AAP 0.5.5).
 * `anchor` is the template's field name in `IssuerTemplate`, beside the generator's own `anchors`.
 */
const PUBLISHED_INPUT_NAMES = new Set([
  'registryRoot',
  'nullifierSalt',
  'anchor',
  'terminator',
  'charset',
  'dateFormat',
]);

/** Every witness-only input name: the set no schema key may hold (AAP 0.12.2). */
const PRIVATE_INPUT_NAMES = new Set(
  GENERATOR_INPUTS.filter((name) => !PUBLISHED_INPUT_NAMES.has(name)),
);

/** The Zod 4 internals this suite reads, narrowed to the fields it needs. */
interface SchemaDef {
  readonly type: string;
  readonly shape?: Record<string, unknown>;
  readonly element?: unknown;
  readonly innerType?: unknown;
  readonly options?: readonly unknown[];
  readonly in?: unknown;
  readonly out?: unknown;
  readonly left?: unknown;
  readonly right?: unknown;
  readonly items?: readonly unknown[];
  readonly valueType?: unknown;
  readonly getter?: () => unknown;
}

/** A schema as Zod 4.6.7 holds it: `_zod.def` carries the kind and that kind's children. */
interface SchemaHolder {
  readonly _zod?: { readonly def?: SchemaDef };
}

/** The kind and children of a schema's definition, and whether a value is a schema at all. */
function defOf(value: unknown): SchemaDef | undefined {
  return (value as SchemaHolder)._zod?.def;
}

function asSchema(value: unknown): z.ZodType | undefined {
  return value instanceof z.ZodType ? value : undefined;
}

/** What one walk of a schema tree found: every object key it reached, and how many schemas it visited. */
interface SchemaTree {
  readonly keys: ReadonlySet<string>;
  readonly schemas: number;
}

/**
 * Every object key reachable from a schema (AAP 0.12.2).
 *
 * The walk follows the children each kind of Zod 4 definition holds — an object's `shape`, an array's
 * `element`, the `innerType` of an optional, a nullable, a default, a readonly, a non-optional or a
 * catch, a union's or discriminated union's `options`, a pipe's `in` and `out`, an intersection's `left`
 * and `right`, a tuple's `items`, a record's `valueType` and a lazy's `getter` — and keeps a visited
 * set, so a recursive schema terminates. Keys come off the definitions themselves, never off a source
 * text, which is what keeps a constant such as `Stripe-Signature` from counting as a key.
 */
function walkSchema(root: unknown): SchemaTree {
  const seen = new Set<z.ZodType>();
  const keys = new Set<string>();
  const pending: z.ZodType[] = [];
  const push = (value: unknown): void => {
    const schema = asSchema(value);
    if (schema !== undefined) {
      pending.push(schema);
    }
  };
  push(root);
  while (pending.length > 0) {
    const schema = pending.pop();
    if (schema === undefined || seen.has(schema)) {
      continue;
    }
    seen.add(schema);
    const def = defOf(schema);
    if (def === undefined) {
      continue;
    }
    switch (def.type) {
      case 'object':
        for (const [key, child] of Object.entries(def.shape ?? {})) {
          keys.add(key);
          push(child);
        }
        break;
      case 'array':
        push(def.element);
        break;
      case 'union':
        for (const option of def.options ?? []) {
          push(option);
        }
        break;
      case 'optional':
      case 'nullable':
      case 'default':
      case 'readonly':
      case 'nonoptional':
      case 'catch':
        push(def.innerType);
        break;
      case 'pipe':
        push(def.in);
        push(def.out);
        break;
      case 'intersection':
        push(def.left);
        push(def.right);
        break;
      case 'tuple':
        for (const item of def.items ?? []) {
          push(item);
        }
        break;
      case 'record':
        push(def.valueType);
        break;
      case 'lazy': {
        const read = def.getter;
        if (read !== undefined) {
          push(read());
        }
        break;
      }
      default:
        break;
    }
  }
  return { keys, schemas: seen.size };
}

/** The object keys a schema declares, and nothing for a value that is not an object schema. */
function keysOf(value: unknown): readonly string[] {
  const def = defOf(value);
  return def?.type === 'object' ? Object.keys(def.shape ?? {}) : [];
}

/** Every key of a parsed JSON value, at any depth. */
function collectKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, keys);
    }
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  const record = value as unknown as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    keys.add(key);
    collectKeys(child, keys);
  }
}

/** Every export of `@tablemate/shared` that is a schema, under the name it is exported as. */
const SHARED_SCHEMA_EXPORTS: readonly (readonly [string, unknown])[] = Object.entries(
  shared as unknown as Record<string, unknown>,
).filter(([, value]) => value instanceof z.ZodType);

/** The eight private inputs of the itinerary circuit's `EmailVerifier` half (AAP 0.5.5). */
const NAMED_PRIVATE_INPUTS: readonly string[] = [
  'emailHeader',
  'emailHeaderLength',
  'emailBody',
  'emailBodyLength',
  'pubkey',
  'signature',
  'precomputedSHA',
  'bodyHashIndex',
];

/** A well-formed Groth16 submission: the seven public signals, in circuit order. */
const SUBMISSION = {
  proof: {
    pi_a: ['1', '2', '3'],
    pi_b: [
      ['4', '5'],
      ['6', '7'],
      ['8', '9'],
    ],
    pi_c: ['10', '11', '12'],
    protocol: 'groth16',
    curve: 'bn128',
  },
  publicSignals: ['1', '2', '3', '4', '5', '6', '7'],
};

/** A submission the strict schema must refuse, and the reason it must. */
type RejectedSubmission = readonly [what: string, submission: unknown];

/** The shape a client must never be able to send (AAP 0.5.5, AAP 0.12.2). */
const REJECTED_SUBMISSIONS: readonly RejectedSubmission[] = [
  ['an email body among the top-level keys', { ...SUBMISSION, emailBody: ['104'] }],
  ['an unknown top-level key', { ...SUBMISSION, extra: true }],
  ['a modulus inside the proof', { ...SUBMISSION, proof: { ...SUBMISSION.proof, modulus: '1' } }],
  ['six public signals', { ...SUBMISSION, publicSignals: SUBMISSION.publicSignals.slice(0, 6) }],
  [
    'a signal that is not a decimal field element',
    { ...SUBMISSION, publicSignals: ['1', '2', '3', '4', '5', '6', 'seven'] },
  ],
];

describe('the witness-input names', () => {
  it('are read from the generator, so the forbidden set is never empty', () => {
    expect(GENERATOR_INPUTS.length).toBeGreaterThan(20);
    for (const named of NAMED_PRIVATE_INPUTS) {
      expect(PRIVATE_INPUT_NAMES.has(named), named).toBe(true);
    }
  });
  it('classify every declared input, and exclude the published template parameters', () => {
    for (const published of PUBLISHED_INPUT_NAMES) {
      expect(PRIVATE_INPUT_NAMES.has(published), published).toBe(false);
    }
    for (const declared of GENERATOR_INPUTS) {
      const classified = PRIVATE_INPUT_NAMES.has(declared) || PUBLISHED_INPUT_NAMES.has(declared);
      expect(classified, declared).toBe(true);
    }
  });
});

describe('the shared contract schemas', () => {
  it('are walked in full, so the key check cannot pass vacuously', () => {
    expect(SHARED_SCHEMA_EXPORTS.length).toBeGreaterThan(100);
    // `ZkConfig` publishes the issuer template and the two public inputs, so the walk reaching them
    // proves it enters nested objects, arrays and unions before it looks for a private name.
    const published = walkSchema(shared.ZkConfig);
    expect([...published.keys]).toEqual(
      expect.arrayContaining(['anchor', 'terminator', 'charset', 'dateFormat', 'nullifierSalt']),
    );
    expect(published.schemas).toBeGreaterThan(20);
  });
  it('hold no private witness input as an object key', () => {
    const found: string[] = [];
    for (const [name, schema] of SHARED_SCHEMA_EXPORTS) {
      for (const key of walkSchema(schema).keys) {
        if (PRIVATE_INPUT_NAMES.has(key)) {
          found.push(`${name}:${key}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
  it('leave no private witness input among the API sources JSON keys', () => {
    expect(API_JSON_FILES.length).toBeGreaterThan(0);
    const found: string[] = [];
    for (const file of API_JSON_FILES) {
      const keys = new Set<string>();
      collectKeys(JSON.parse(readRepoFile(file)) as unknown, keys);
      for (const key of keys) {
        if (PRIVATE_INPUT_NAMES.has(key)) {
          found.push(`${file}:${key}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});

describe('ProofSubmission', () => {
  it('accepts a Groth16 proof and its seven public signals, and nothing else', () => {
    expect(keysOf(shared.ProofSubmission)).toEqual(['proof', 'publicSignals']);
    const parsed = shared.ProofSubmission.safeParse(SUBMISSION);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
  it.each(REJECTED_SUBMISSIONS)('refuses %s', (_what, submission) => {
    expect(shared.ProofSubmission.safeParse(submission).success).toBe(false);
  });
});
