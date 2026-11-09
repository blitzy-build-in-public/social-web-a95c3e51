/**
 * Proof-flow pre-flight validation (AAP 0.5.5, AAP 0.5.8, criterion 3, QA finding qavf1-07): the
 * witness inputs are built from the picked bytes *before* any artefact is fetched, so a file that is
 * not a booking confirmation and an email from an issuer the published configuration does not support
 * are both refused without the ~1.6 GB download, and an email the configuration does support still
 * reaches proving and submission.
 *
 * Every case runs the real `prover.ts` and the real `state/proof-store.ts` against the real fixtures
 * with an injected engine, an injected artefact store whose `ensureArtifacts` is a spy, and the one
 * mock a Node run needs — the API client `prover.ts` imports, which no case may reach for real. The
 * store's snapshots are read on every change to check that they stay inside the four keys AAP 0.5.5
 * allows and carry no byte of the fixture email.
 */
import { existsSync, readFileSync } from 'node:fs';

import { IssuerConfig, ProofAccepted, RegistryFile, ZkConfig } from '@tablemate/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as proof from '../src/state/proof-store.ts';
import { importAndProve } from '../src/zk/prover.ts';
import type {
  ArtifactPlan,
  DownloadProgress,
  EmlHandle,
  EngineOutput,
  ImportAndProveResult,
  ProofErrorCode,
  ResolvedArtifacts,
} from '../src/zk/prover.ts';

const h = vi.hoisted(() => {
  /** The per-case state the mocks read; tests mutate it directly, so it is never copied by value. */
  const state = {
    accepted: {} as unknown,
    snapshots: [] as string[],
    root: '0',
    issuer: 1,
  };
  /** The proof a scripted engine returns: valid under `ProofSubmission`, tied to the test registry. */
  const output = (): EngineOutput => ({
    proof: {
      pi_a: ['1', '1', '1'],
      pi_b: [
        ['1', '1'],
        ['1', '1'],
        ['1', '0'],
      ],
      pi_c: ['1', '1', '1'],
      protocol: 'groth16',
      curve: 'bn128',
    },
    publicSignals: ['1', '20261102', '20270227', String(state.issuer), '123', state.root, '12345'],
    witnessMs: 1,
    proveMs: 2,
  });
  return {
    state,
    generate: vi.fn(
      (_json: string, _artifacts: unknown, _signal?: AbortSignal): Promise<EngineOutput> =>
        Promise.resolve(output()),
    ),
    submitProof: vi.fn((_body: unknown): Promise<unknown> => Promise.resolve(state.accepted)),
  };
});

// Matched by resolved file id, so this also intercepts `prover.ts`'s extensionless `../api/client`.
vi.mock('../src/api/client.ts', () => ({ apiClient: { submitProof: h.submitProof } }));

const { state, generate, submitProof } = h;
const STATE_KEYS: readonly string[] = ['status', 'issuerId', 'errorCode', 'downloadProgress'];
/** What the fake store hands over; nothing downloads it, so any location serves. */
const RESOLVED: ResolvedArtifacts = {
  zkey: { location: 'test://circuit.zkey', sha256: 'b'.repeat(64), size: 1 },
  wasm: null,
};
/** A PNG's magic bytes and the start of its `IHDR` chunk: a picked file that is not a booking email. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

let zkConfig: ZkConfig;
let demoConfig: ZkConfig;
let bytes = new Uint8Array();
let issuerId = 0;
let unsubscribe: () => void = () => undefined;
const fx = { valid: '' };
const engine = { available: () => true, generate };
const store = {
  plan: vi.fn((_artifacts: ZkConfig['artifacts']): Promise<ArtifactPlan> =>
    Promise.resolve({ cached: true, downloadBytes: 0, connection: 'wifi' }),
  ),
  ensureArtifacts: vi.fn(
    (
      _artifacts: ZkConfig['artifacts'],
      _onProgress?: (progress: DownloadProgress) => void,
      _signal?: AbortSignal,
    ): Promise<ResolvedArtifacts> => Promise.resolve(RESOLVED),
  ),
};

/** Reads a repository file as latin1, so a fixture's CRLF bytes and its text agree. */
function read(relativePath: string): string {
  const path = new URL(`../../../${relativePath}`, import.meta.url);
  if (!existsSync(path))
    throw new Error(`Missing ${relativePath}; run \`pnpm circuits:fixtures\`.`);
  return readFileSync(path, 'latin1');
}

/** Every 12-character window of the email that is not only digits, whitespace or `" , : [ ] { }`. */
const contentWindows = (text: string): string[] =>
  Array.from({ length: Math.max(0, text.length - 11) }, (_value, at) =>
    text.slice(at, at + 12),
  ).filter((window) => !/^[\d\s",:[\]{}]*$/.test(window));

const codeOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

/** The status of every snapshot the store published, in order. */
const publishedStatuses = (): string[] =>
  state.snapshots.map((text) => (JSON.parse(text) as { status: string }).status);

interface Attempt {
  readonly error: unknown;
  readonly result: ImportAndProveResult | null;
}

/** One attempt through `importAndProve`, returning its failure rather than throwing it. */
async function attempt(emlBytes: Uint8Array, config: ZkConfig): Promise<Attempt> {
  const handle: EmlHandle = { bytes: emlBytes, release: () => Promise.resolve() };
  try {
    const result = await importAndProve(handle, config, {
      engine,
      artifactStore: store,
      signal: new AbortController().signal,
    });
    return { error: null, result };
  } catch (error: unknown) {
    return { error, result: null };
  }
}

/** Asserts that every snapshot stays inside the four keys AAP 0.5.5 allows, carrying no email text. */
function assertSnapshotPrivacy(): void {
  const states = [...state.snapshots, JSON.stringify(proof.getProofSnapshot())];
  for (const text of states) {
    const snapshot = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(snapshot).every((key) => STATE_KEYS.includes(key))).toBe(true);
  }
  const haystack = states.join('\n');
  expect(fx.valid).not.toHaveLength(0);
  expect(contentWindows(fx.valid).filter((window) => haystack.includes(window))).toEqual([]);
}

interface Refusal {
  readonly label: string;
  readonly bytes: () => Uint8Array;
  readonly config: () => ZkConfig;
  readonly code: ProofErrorCode;
}

/** The two inputs a pre-flight refuses, differing only in their inputs, so they are one table. */
const REFUSALS: readonly Refusal[] = [
  {
    label: 'a pick that is not an email',
    bytes: () => PNG,
    config: () => zkConfig,
    code: 'eml_malformed',
  },
  {
    label: 'an email whose issuer the configuration does not support',
    bytes: () => bytes,
    config: () => demoConfig,
    code: 'unsupported_issuer',
  },
];

beforeAll(() => {
  fx.valid = read('packages/circuits/fixtures/test-issuer/valid.eml');
  const issuer = IssuerConfig.parse(
    JSON.parse(read('config/issuers/tablemate-test.json')) as unknown,
  );
  const registry = RegistryFile.parse(JSON.parse(read('config/registry/test.json')) as unknown);
  const link = (name: string, sha256: string) => ({
    url: `http://127.0.0.1:1/${name}`,
    size: 1,
    sha256,
  });
  const base = {
    registry,
    nullifierSalt: '12345',
    artifacts: {
      wasm: link('circuit.wasm', 'a'.repeat(64)),
      zkey: link('circuit.zkey', 'b'.repeat(64)),
    },
    manifestUrl: 'http://127.0.0.1:1/manifest.json',
  };
  zkConfig = ZkConfig.parse({ ...base, issuers: [issuer], unsupportedIssuers: [] });
  // The shipped posture while the two booking sites await samples (AAP 0.5.5, AAP 0.5.8): no issuer
  // has a key record or a template, so the registry holds no leaf an email could name.
  demoConfig = ZkConfig.parse({
    ...base,
    issuers: [],
    unsupportedIssuers: ['Booking.com', 'Airbnb'],
  });
  bytes = Uint8Array.from(Buffer.from(fx.valid, 'latin1'));
  state.root = registry.root;
  state.issuer = issuerId = issuer.issuerId;
  state.accepted = ProofAccepted.parse({
    proofId: '01920000-0000-7000-8000-000000000000',
    cityId: 'lisbon',
    arrivalDate: '2026-11-02',
    departureDate: '2027-02-27',
  });
  unsubscribe = proof.subscribeProof(() =>
    state.snapshots.push(JSON.stringify(proof.getProofSnapshot())),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  state.snapshots.length = 0;
  proof.resetProof();
});

afterAll(() => {
  unsubscribe();
});

describe('the proof flow pre-flight', () => {
  it.each(REFUSALS)('refuses $label before any artefact is fetched', async (refusal) => {
    const { error } = await attempt(refusal.bytes(), refusal.config());

    expect(codeOf(error)).toBe(refusal.code);
    expect(store.ensureArtifacts).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(submitProof).not.toHaveBeenCalled();
    // The refusal is the store's own error state, and the download never began.
    expect(proof.getProofSnapshot()).toEqual({ status: 'error', errorCode: refusal.code });
    expect(publishedStatuses()).toContain('reading');
    expect(publishedStatuses()).not.toContain('downloading');
    assertSnapshotPrivacy();
  });

  it('downloads once and proves an email the configuration supports', async () => {
    const { error, result } = await attempt(bytes, zkConfig);

    expect(error).toBeNull();
    expect(store.ensureArtifacts).toHaveBeenCalledTimes(1);
    expect(store.ensureArtifacts.mock.calls[0]?.[0]).toEqual(zkConfig.artifacts);
    expect(generate).toHaveBeenCalledTimes(1);
    // The witness the pre-flight built is the witness proved, handed over as one JSON string.
    const inputsJson = generate.mock.calls[0]?.[0];
    expect(typeof inputsJson).toBe('string');
    expect(Object.keys(JSON.parse(String(inputsJson)) as object)).toContain('emailHeaderLength');
    expect(submitProof).toHaveBeenCalledTimes(1);
    expect(result?.accepted).toEqual(state.accepted);
    // The measured span still runs from input construction to the proof output — the build's own
    // duration plus the proving span — with no download inside it (AAP 0.5.5).
    expect(Number.isFinite(result?.timings.totalMs)).toBe(true);
    expect(result?.timings.totalMs).toBeGreaterThanOrEqual(result?.timings.inputMs ?? 0);
    expect(proof.getProofSnapshot()).toEqual({ status: 'accepted', issuerId });
    assertSnapshotPrivacy();
  });

  it('keeps the proof state to the four keys AAP 0.5.5 allows', () => {
    expect([...proof.PROOF_STATE_KEYS].every((key) => STATE_KEYS.includes(key))).toBe(true);
  });
});
