/**
 * `.eml` intake cleanup and email-content privacy (AAP 0.5.5, criterion 3): every path of an attempt runs
 * through the real intake, proving flow and store, proving an app-owned copy — cache, `Inbox/`, `tmp/` or the
 * share-intent App Group container — is deleted on success, on a failed read, on a failed input generation, on a
 * failed proof and on cancellation, and never twice, that the traveller's own URI is never deleted or written,
 * and that no snapshot, log line or surfaced error carries a byte of the email. Thirty-four cases run as nine
 * tables over that harness, the platform modules, the API client and the engine being the only fakes.
 */
import { existsSync, readFileSync } from 'node:fs';

import { IssuerConfig, ProofAccepted, RegistryFile, ZkConfig } from '@tablemate/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as proof from '../src/state/proof-store.ts';
import * as native from '../src/zk/eml-intake.native.ts';
import * as web from '../src/zk/eml-intake.web.ts';
import { importAndProve, type EngineOutput } from '../src/zk/prover.ts';
/** One handle either intake hands over; `null` is the cancelled pick. */
type Opened = Awaited<ReturnType<typeof native.pickEml>>;

const h = vi.hoisted(() => {
  // iOS-shaped sandbox URIs; `TEMP` is Documents' sibling, by the rule the native intake documents.
  const CACHE = 'file:///var/mobile/Containers/Data/Application/APP/Library/Caches/';
  const DOCS = 'file:///var/mobile/Containers/Data/Application/APP/Documents/';
  const APP_GROUP = 'file:///private/var/mobile/Containers/Shared/AppGroup/APP/booking.eml';
  const TEMP = `${DOCS.slice(0, -'Documents/'.length)}tmp/`;
  /** The per-case state the mocks read; tests mutate it directly, so it is never copied by value. */
  const state = {
    files: new Map<string, string>(),
    noise: [] as string[],
    snapshots: [] as string[],
    injected: null as Error | null,
    readError: null as Error | null,
    engineError: null as Error | null,
    cancel: false,
    pick: { canceled: true, assets: null } as unknown,
    accepted: {} as unknown,
    root: '0',
    issuer: 1,
    entered: Promise.resolve(),
    enter: () => undefined as void,
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
  /** The error a cancelled attempt carries, named as the platform modules name theirs. */
  const abortError = (): Error => Object.assign(new Error('cancelled'), { name: 'AbortError' });
  /** A recorder for an operation a flow must never perform, or one whose target it must record. */
  const recorder = () => vi.fn((): Promise<void> => Promise.resolve());
  return {
    state,
    CACHE,
    DOCS,
    APP_GROUP,
    TEMP,
    fs: {
      readAsStringAsync: vi.fn((uri: string): Promise<string> => {
        if (state.readError !== null) return Promise.reject(state.readError);
        const encoded = state.files.get(uri);
        if (encoded === undefined) return Promise.reject(new Error('no such file'));
        return Promise.resolve(encoded);
      }),
      deleteAsync: vi.fn((_uri: string): Promise<void> => Promise.resolve()),
      writeAsStringAsync: recorder(),
      copyAsync: recorder(),
      moveAsync: recorder(),
      makeDirectoryAsync: recorder(),
      getInfoAsync: recorder(),
    },
    getDocumentAsync: vi.fn((_options: unknown): Promise<unknown> => Promise.resolve(state.pick)),
    submitProof: vi.fn((_body: unknown): Promise<unknown> => Promise.resolve(state.accepted)),
    generate: vi.fn(
      (_json: string, _artifacts: unknown, signal?: AbortSignal): Promise<EngineOutput> => {
        state.enter();
        const aborting: AbortSignal | undefined = signal;
        if (state.cancel) {
          return new Promise<EngineOutput>((_ok, reject) => {
            aborting?.addEventListener('abort', () => reject(abortError()), { once: true });
          });
        }
        if (state.engineError !== null) return Promise.reject(state.engineError);
        return Promise.resolve(output());
      },
    ),
    waitForEngine: (): Promise<void> => state.entered,
    reset: (): void => {
      state.files.clear();
      for (const list of [state.noise, state.snapshots]) list.length = 0;
      state.injected = null;
      state.readError = null;
      state.engineError = null;
      state.cancel = false;
      state.pick = { canceled: true, assets: null };
      state.entered = new Promise<void>((resolve) => {
        state.enter = resolve;
      });
    },
  };
});

vi.mock('expo-document-picker', () => ({ getDocumentAsync: h.getDocumentAsync }));
vi.mock('expo-file-system', () => ({
  cacheDirectory: h.CACHE,
  documentDirectory: h.DOCS,
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  ...h.fs,
}));
// Matched by resolved file id, so this also intercepts `prover.ts`'s extensionless `../api/client`.
vi.mock('../src/api/client.ts', () => ({ apiClient: { submitProof: h.submitProof } }));

const { APP_GROUP, CACHE, DOCS, TEMP, fs, state } = h;
/** Where the fake engine's key lives; nothing downloads it, so any Document URI serves. */
const ZKEY = { location: `${DOCS}circuit.zkey`, sha256: 'b'.repeat(64), size: 1 };
/** The four app-owned locations a copy can land in, and the URI each case must delete. */
const OWNED: readonly (readonly [string, string])[] = [
  ['cache', `${CACHE}booking.eml`],
  ['inbox', `${DOCS}Inbox/booking.eml`],
  ['tmp', `${TEMP}booking.eml`],
  ['share-intent', APP_GROUP],
];
/** The traveller's own files. The look-alike and the traversal must not pass as app-owned. */
const ORIGINALS = [
  'content://com.android.providers.downloads.documents/document/42',
  'file:///private/var/mobile/Library/Mobile%20Documents/com~apple~CloudDocs/booking.eml',
  `${DOCS}booking.eml`,
  `${CACHE.slice(0, -1)}Evil/booking.eml`,
  `${CACHE}../../Documents/booking.eml`,
];
const OUTCOMES = [
  'accepted',
  'read-failed',
  'generator-failed',
  'engine-failed',
  'cancelled',
] as const;
type Outcome = (typeof OUTCOMES)[number];
const STATE_KEYS: readonly string[] = ['status', 'issuerId', 'errorCode', 'downloadProgress'];
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
const RESTORES: (() => void)[] = [];
const revoked: string[] = [];
const fx = { valid: '', tampered: '', guest: '', reference: '', runs: [] as string[] };

let zkConfig: ZkConfig;
let bytes: Uint8Array<ArrayBuffer> = new Uint8Array();
let issuerId = 0;
let unsubscribe: () => void = () => undefined;
const engine = { available: () => true, generate: h.generate };
const store = {
  plan: () => Promise.resolve({ cached: true, downloadBytes: 0, connection: 'wifi' as const }),
  ensureArtifacts: () => Promise.resolve({ zkey: ZKEY, wasm: null }),
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

const base64Of = (text: string): string => Buffer.from(text, 'latin1').toString('base64');
const codeOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
const textOf = (args: readonly unknown[]): string =>
  args
    .map((arg) =>
      arg instanceof Error ? `${arg.name}: ${arg.message} ${arg.stack ?? ''}` : String(arg),
    )
    .join(' ');
/** The URIs the flow deleted, read back from the recorder so no second list can drift from it. */
const deleted = (): string[] => fs.deleteAsync.mock.calls.map((call) => String(call[0]));
/** Records an error the flow itself surfaced; the engine's injected error is excluded, by identity. */
function recordRejection(error: unknown): void {
  if (error === state.injected || error === null) return;
  const text = error instanceof Error ? error.message : `${typeof error} rejection`;
  state.noise.push(`error: ${text}`);
}

function expectedState(outcome: Outcome): unknown {
  if (outcome === 'accepted') return { status: 'accepted', issuerId };
  if (outcome === 'read-failed') return { status: 'idle' };
  if (outcome === 'generator-failed') return { status: 'error', errorCode: 'body_hash_mismatch' };
  if (outcome === 'engine-failed') return { status: 'error', errorCode: 'unknown_error' };
  return { status: 'cancelled' };
}
/** Asserts that neither the state, the logs nor a surfaced error carries a byte of the email. */
function assertPrivate(): void {
  const states = [...state.snapshots, JSON.stringify(proof.getProofSnapshot())];
  for (const text of states) {
    const snapshot = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(snapshot).every((key) => STATE_KEYS.includes(key))).toBe(true);
    expect(snapshot['errorCode'] ?? 'code').toMatch(/^[a-z0-9_]+$/);
    if (snapshot['issuerId'] !== undefined)
      expect(Number.isInteger(snapshot['issuerId'])).toBe(true);
    const progress = snapshot['downloadProgress'];
    if (progress !== undefined) expect(Number.isFinite(progress)).toBe(true);
  }
  const haystack = [...states, ...state.noise].join('\n');
  expect(fx.guest).not.toHaveLength(0);
  expect(haystack).not.toContain(fx.guest);
  expect(fx.reference.length).toBeGreaterThanOrEqual(12);
  expect(haystack).not.toContain(fx.reference);
  expect(fx.runs.filter((run) => haystack.includes(run))).toEqual([]);
}
/** Arms one case: the reader's and the engine's failure, the cancel flag and the picker's answer. */
function arm(outcome: Outcome, uri: string, file?: File): void {
  state.readError = outcome === 'read-failed' ? new Error(fx.reference) : null;
  state.engineError = outcome === 'engine-failed' ? new Error(fx.reference) : null;
  state.injected = state.engineError;
  state.cancel = outcome === 'cancelled';
  state.files.set(uri, base64Of(outcome === 'generator-failed' ? fx.tampered : fx.valid));
  const asset = { uri, name: 'booking.eml', mimeType: 'message/rfc822', size: bytes.length, file };
  state.pick = { canceled: false, assets: [asset] };
}

interface Attempt {
  readonly handle: Opened;
  readonly error: unknown;
}
/** Runs one attempt through `importAndProve`, aborting only once the engine is inside `generate`, so a
 * cancel is the abort the proof sees. */
async function attempt(open: () => Promise<Opened>, outcome: Outcome): Promise<Attempt> {
  const controller = new AbortController();
  let handle: Opened = null;
  let error: unknown = null;
  try {
    handle = await open();
    if (handle === null) throw new Error('the intake returned no file');
    const engineProof = importAndProve(handle, zkConfig, {
      engine,
      artifactStore: store,
      signal: controller.signal,
    });
    if (outcome === 'cancelled') {
      await h.waitForEngine();
      controller.abort();
    }
    await engineProof;
  } catch (caught) {
    error = caught;
    recordRejection(caught);
  }
  return { handle, error };
}

async function drive(uri: string, outcome: Outcome, viaPicker: boolean): Promise<Attempt> {
  arm(outcome, uri);
  const open = (): Promise<Opened> => (viaPicker ? native.pickEml() : native.fromShareIntent(uri));
  return await attempt(open, outcome);
}
/** One web attempt, on a blob URL this page must revoke and zero-fill before it returns. */
async function driveWeb(outcome: Outcome): Promise<string> {
  const file = new File([bytes], 'booking.eml', { type: 'message/rfc822' });
  const uri = URL.createObjectURL(new Blob([bytes]));
  arm(outcome, uri, file);
  const { handle } = await attempt(() => web.pickEml(), outcome);
  expect(handle?.bytes.every((byte) => byte === 0)).toBe(true);
  for (const recorder of Object.values(fs)) expect(recorder).not.toHaveBeenCalled();
  return uri;
}
/** The four assertions every driven case shares, so no table repeats them. */
async function assertOutcome(
  { handle, error }: Attempt,
  outcome: Outcome,
  uri: string,
): Promise<void> {
  expect(deleted()).toEqual([uri]);
  expect(proof.getProofSnapshot()).toEqual(expectedState(outcome));
  if (outcome === 'accepted') {
    expect(error).toBeNull();
    expect(fs.readAsStringAsync).toHaveBeenCalledWith(uri, { encoding: 'base64' });
    expect(Object.keys(h.submitProof.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      'proof',
      'publicSignals',
    ]);
    expect(typeof h.generate.mock.calls[0]?.[0]).toBe('string');
  }
  if (outcome === 'read-failed') expect(codeOf(error)).toBe('eml_read_failed');
  if (outcome === 'engine-failed') expect(error).toBe(state.engineError);
  if (handle !== null) {
    // The second release is the idempotent one: it must neither throw nor delete again.
    await handle.release();
    expect(deleted()).toEqual([uri]);
  }
}

beforeAll(() => {
  fx.valid = read('packages/circuits/fixtures/test-issuer/valid.eml');
  fx.tampered = read('packages/circuits/fixtures/test-issuer/tampered.eml');
  const issuer = IssuerConfig.parse(
    JSON.parse(read('config/issuers/tablemate-test.json')) as unknown,
  );
  const registry = RegistryFile.parse(JSON.parse(read('config/registry/test.json')) as unknown);
  const link = (name: string, sha256: string) => ({
    url: `http://127.0.0.1:1/${name}`,
    size: 1,
    sha256,
  });
  zkConfig = ZkConfig.parse({
    issuers: [issuer],
    unsupportedIssuers: [],
    registry,
    nullifierSalt: '12345',
    artifacts: {
      wasm: link('circuit.wasm', 'a'.repeat(64)),
      zkey: link('circuit.zkey', 'b'.repeat(64)),
    },
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
  // The guest name comes from its own fixture line, the reference from the registered body anchor.
  const anchor = issuer.template?.fields.reference.anchor ?? '';
  fx.reference = fx.valid.slice(fx.valid.indexOf(anchor) + anchor.length).split('\r')[0] ?? '';
  fx.guest = /^Guest: ([^\r\n]+)/m.exec(fx.valid)?.[1] ?? '';
  // Checked raw and base64-encoded, so a leak that encodes the bytes before writing them is caught.
  fx.runs = [...contentWindows(fx.valid), ...contentWindows(base64Of(fx.valid))];
  unsubscribe = proof.subscribeProof(() =>
    state.snapshots.push(JSON.stringify(proof.getProofSnapshot())),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  h.reset();
  proof.resetProof();
  revoked.length = 0;
  // Every console line an attempt writes is noise this test then reads for email content.
  for (const method of CONSOLE_METHODS) {
    const spy = vi.spyOn(console, method);
    spy.mockImplementation((...args: unknown[]) => state.noise.push(`log: ${textOf(args)}`));
    RESTORES.push(() => spy.mockRestore());
  }
  RESTORES.push(
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
      revoked.push(url);
    }).mockRestore,
  );
});

afterEach(() => {
  // Only the read and the delete ever happen: no case writes, copies, moves or probes a file.
  const untouched = [fs.writeAsStringAsync, fs.copyAsync, fs.moveAsync, fs.makeDirectoryAsync];
  for (const recorder of [...untouched, fs.getInfoAsync]) expect(recorder).not.toHaveBeenCalled();
  for (const restore of RESTORES.splice(0)) restore();
});

afterAll(() => {
  unsubscribe();
});

describe('the .eml intake', () => {
  it('derives the three owned roots and treats the share container as its own', () => {
    expect(new Set(native.appOwnedRoots())).toEqual(new Set([CACHE, `${DOCS}Inbox/`, TEMP]));
    expect(native.appOwnedRoots()).not.toContain(DOCS);
    expect(native.isAppOwnedUri(APP_GROUP)).toBe(true);
  });
  it('reads and deletes nothing on a cancelled pick, and asks for no cache copy', async () => {
    await expect(native.pickEml()).resolves.toBeNull();
    expect(h.getDocumentAsync).toHaveBeenCalledWith(
      expect.objectContaining({ copyToCacheDirectory: false }),
    );
    expect(fs.readAsStringAsync).not.toHaveBeenCalled();
    expect(deleted()).toEqual([]);
    expect(proof.getProofSnapshot()).toEqual({ status: 'idle' });
    assertPrivate();
  });
  const matrix: [string, Outcome, string][] = OWNED.flatMap(([root, uri]) =>
    OUTCOMES.map((outcome): [string, Outcome, string] => [root, outcome, uri]),
  );
  it.each(matrix)('deletes the %s copy after %s', async (_root, outcome, uri) => {
    await assertOutcome(await drive(uri, outcome, false), outcome, uri);
    assertPrivate();
  });
  it('deletes the copy the picker handed over', async () => {
    const uri = `${CACHE}booking.eml`;
    const driven = await drive(uri, 'accepted', true);
    expect(h.getDocumentAsync).toHaveBeenCalledWith(
      expect.objectContaining({ copyToCacheDirectory: false }),
    );
    await assertOutcome(driven, 'accepted', uri);
    assertPrivate();
  });
  it.each(ORIGINALS)('never touches or writes %s', async (uri) => {
    expect(native.isAppOwnedUri(uri)).toBe(false);
    for (const outcome of ['accepted', 'engine-failed'] as const) {
      for (const viaPicker of [true, false]) {
        h.reset();
        const { error } = await drive(uri, outcome, viaPicker);
        if (outcome === 'accepted') expect(error).toBeNull();
        expect(deleted()).toEqual([]);
        assertPrivate();
      }
    }
  });
  it('reads the picked web file into memory, zero-fills it and revokes its blob URL', async () => {
    const file = new File([bytes], 'booking.eml', { type: 'message/rfc822' });
    const readSpy = vi.spyOn(file, 'arrayBuffer');
    const uri = URL.createObjectURL(new Blob([bytes]));
    state.pick = { canceled: false, assets: [{ uri, name: 'booking.eml', file }] };
    const handle = await web.pickEml();
    expect(readSpy).toHaveBeenCalled();
    expect(Uint8Array.from(handle?.bytes ?? [])).toEqual(bytes);
    await handle?.release();
    expect(revoked).toEqual([uri]);
    expect(handle?.bytes.every((byte) => byte === 0)).toBe(true);
    await handle?.release();
    expect(revoked).toEqual([uri]);
    for (const recorder of Object.values(fs)) expect(recorder).not.toHaveBeenCalled();
    assertPrivate();
  });
  it.each(['accepted', 'engine-failed', 'cancelled'] as const)(
    'revokes and zero-fills the blob URL after %s',
    async (outcome) => {
      const uri = await driveWeb(outcome);
      expect(revoked).toEqual([uri]);
      expect(proof.getProofSnapshot()).toEqual(expectedState(outcome));
      assertPrivate();
    },
  );
  it('rejects share intake on the web, owning no directory', async () => {
    const error = await web
      .fromShareIntent('file:///tmp/booking.eml')
      .catch((caught: unknown) => caught);
    recordRejection(error);
    expect(codeOf(error)).toBe('share_intake_unsupported');
    expect(web.isAppOwnedUri('file:///tmp/booking.eml')).toBe(false);
    expect(web.appOwnedRoots()).toEqual([]);
    assertPrivate();
  });
  it('keeps the proof state to the four keys AAP 0.5.5 allows', () => {
    expect([...proof.PROOF_STATE_KEYS].every((key) => STATE_KEYS.includes(key))).toBe(true);
  });
});
