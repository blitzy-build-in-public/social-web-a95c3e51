/**
 * The proving Worker's two artefact sources, from the page's side: the artefacts' published URLs, for
 * an engine whose origin private file system cannot be used, and the origin private file system's own
 * download, on the failure path a write takes (AAP 0.3.4, AAP 0.5.5, AAP 0.8.1, AAP 0.12.2).
 *
 * A Node process has no `navigator.storage` at all, which is exactly the environment the URL source
 * exists for: the Worker's first attempt at the origin private file system is
 * `artifact_storage_unavailable`, and `ensure` then has to answer from the URLs the artefacts are
 * published at. That storage is therefore deliberately left alone everywhere but the one case at the
 * end — which stubs it to reach the download — and so is snarkjs, because this suite is about where
 * the Worker gets the artefact bytes from and not about the proof it makes with them.
 *
 * Everything else is the Worker's own code: `self` is stubbed with the scope it registers its message
 * listener on and posts its frames to, `fetch` with a server that answers the ranged GET and the
 * artefact bodies, and the entry is imported dynamically because it reads `self` while loading. Every
 * case drives one frame through that loop and reads the frames that come back, so what it asserts is
 * the protocol the page sees rather than the shape of the module.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  EnsureRequest,
  ProveRequest,
  WorkerArtifactRef,
  WorkerRequest,
} from '../src/zk/prover.worker.ts';

/**
 * snarkjs, replaced: a real Groth16 proof over the real key belongs to the engine walk of
 * `web-proving.spec.ts`, while what matters here is the key the Worker hands snarkjs and how much of
 * the network it read to get it. Every call is recorded, so a case can read both back.
 */
const snark = vi.hoisted(() => {
  /** One `groth16.prove` call, recorded as it was made: the Worker drops the pages when it returns. */
  interface KeyCall {
    readonly type: string;
    readonly pageLengths: readonly number[];
    readonly options: unknown;
  }
  /** One `wtns.calculate` call, likewise recorded at the moment it was made. */
  interface WasmCall {
    readonly type: string;
    readonly byteLength: number | undefined;
  }
  const keys: KeyCall[] = [];
  const wasms: WasmCall[] = [];
  return {
    keys,
    wasms,
    wtns: {
      calculate: (
        _input: unknown,
        wasm: { readonly type: string; readonly data?: Uint8Array },
        _out: unknown,
        _options: unknown,
      ): Promise<void> => {
        wasms.push({ type: wasm.type, byteLength: wasm.data?.byteLength });
        return Promise.resolve();
      },
    },
    groth16: {
      prove: (
        zkey: { readonly type: string; readonly data: readonly Uint8Array[] },
        _witness: unknown,
        _logger: unknown,
        options: unknown,
      ): Promise<{ proof: unknown; publicSignals: unknown }> => {
        keys.push({
          type: zkey.type,
          pageLengths: zkey.data.map((page) => page.byteLength),
          options,
        });
        return Promise.resolve({ proof: { protocol: 'groth16' }, publicSignals: ['1'] });
      },
    },
  };
});

vi.mock('snarkjs', () => snark);

/* --- The artefacts a case publishes ------------------------------------------------------------ */

/** fastfile 0.0.20's page size, which `prover.worker.ts` mirrors: a key of one page and five bytes is
 * the smallest one that shows the page array the Worker builds. */
const ZKEY_PAGE_BYTES = 1 << 22;

/** The bytes of the two artefacts a `prove` case streams: a tiny circuit WASM, and such a key. */
const WASM_BYTES = Uint8Array.from({ length: 64 }, (_value, index) => index);
const ZKEY_BYTES = Uint8Array.from(
  { length: ZKEY_PAGE_BYTES + 5 },
  (_value, index) => index & 0xff,
);

/** One artefact as its URL publishes it: the declared size and digest are the served bytes' own. */
function published(bytes: Uint8Array, name: string): WorkerArtifactRef {
  return {
    url: `https://artifacts.test/${name}`,
    size: bytes.byteLength,
    sha256: bytesToHex(sha256(bytes)),
  };
}

const WASM: WorkerArtifactRef = published(WASM_BYTES, 'tablemate_itinerary.wasm');
const ZKEY: WorkerArtifactRef = published(ZKEY_BYTES, 'tablemate_itinerary.zkey');

/* --- The page's side of the protocol ----------------------------------------------------------- */

/** One frame either side of the Worker's protocol, as this suite reads it. */
type Frame = Record<string, unknown>;

/**
 * What a case's server answers one request with. `status: 0` stands for a request that never got an
 * answer at all. `chunks` is what a read of the body yields — absent for the ranged GET, whose body the
 * Worker is required to cancel without reading.
 */
interface Answer {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly chunks?: readonly Uint8Array[];
}

/** The server one case runs against, addressed by the artefact the request is about. */
type Server = (ref: WorkerArtifactRef) => Answer;

/** The Worker under test, and everything the page would otherwise own. */
interface Harness {
  /** Every frame the Worker posted, in order, progress reports included. */
  readonly frames: Frame[];

  /** The requests it made: the URL it asked for and the `Range` header it sent, or null for none. */
  readonly requests: { readonly url: string; readonly range: string | null }[];

  /** What the bodies it was answered with saw: cancelled, and read. */
  readonly bodies: { cancelled: number; pulled: number };

  /** Posts one request frame, as `runWorker` in `artifacts.web.ts` does. */
  send(frame: WorkerRequest): void;

  /** The one frame that answers request `id`, besides its progress reports. */
  reply(id: number): Promise<Frame>;
}

/**
 * The body of one response: it yields `chunks` when it is read, and records being read and being
 * cancelled. The high-water mark of 0 is what makes the two tellable apart — such a stream holds no
 * chunk until a reader asks for one, so `pulled === 0` is proof that nothing read the body.
 */
function bodyOf(
  chunks: readonly Uint8Array[],
  record: { cancelled: number; pulled: number },
): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller): void {
        record.pulled += 1;
        const chunk = chunks[at];
        at += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel(): void {
        record.cancelled += 1;
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Loads the Worker entry with `self` and `fetch` stubbed, which is what a browser gives it: the scope
 * it registers its listener on and the network its requests go out on. The module is imported
 * dynamically, and the registry is reset first, because it reads `self` while it loads.
 */
async function loadWorker(server: Server): Promise<Harness> {
  const frames: Frame[] = [];
  const requests: { url: string; range: string | null }[] = [];
  const bodies = { cancelled: 0, pulled: 0 };
  const waiting = new Map<number, (frame: Frame) => void>();
  let listener: ((event: MessageEvent<unknown>) => void) | null = null;

  const scope = {
    postMessage(message: Frame): void {
      frames.push(message);
      // Only a reply settles a wait: a request reports its progress as often as it likes before one.
      if (message.type === 'progress') return;
      const id = message.id;
      const waitingFor = typeof id === 'number' ? waiting.get(id) : undefined;
      if (waitingFor === undefined) return;
      waiting.delete(id as number);
      waitingFor(message);
    },
    addEventListener(type: string, handler: (event: MessageEvent<unknown>) => void): void {
      if (type === 'message') listener = handler;
    },
  };

  vi.stubGlobal('self', scope);
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push({ url, range: new Headers(init?.headers).get('range') });
    const ref = [WASM, ZKEY].find((artefact) => artefact.url === url);
    const answer = server(ref ?? WASM);
    if (answer.status === 0) return Promise.reject(new TypeError('Failed to fetch'));
    const body = bodyOf(answer.chunks ?? [], bodies);
    const responseInit: ResponseInit = { status: answer.status, headers: answer.headers ?? {} };
    return Promise.resolve(new Response(body, responseInit));
  });

  vi.resetModules();
  await import('../src/zk/prover.worker.ts');

  return {
    frames,
    requests,
    bodies,
    send(frame: WorkerRequest): void {
      const handler = listener;
      if (handler === null) throw new Error('the Worker registered no message listener');
      handler({ data: frame } as MessageEvent<unknown>);
    },
    reply(id: number): Promise<Frame> {
      const arrived = frames.find((frame) => frame.id === id && frame.type !== 'progress');
      return arrived === undefined
        ? new Promise<Frame>((resolve) => waiting.set(id, resolve))
        : Promise.resolve(arrived);
    },
  };
}

/** The `ensure` request the page posts for the two artefacts a case publishes. */
function ensureFrame(id: number): EnsureRequest {
  return { type: 'ensure', id, artifacts: { wasm: WASM, zkey: ZKEY }, appVersion: '0.1.0' };
}

/* --- `ensure`: the ranged GET that confirms what is published ---------------------------------- */

/** The one request that answers a case once its reply has arrived. */
function onlyReply(worker: Harness, id: number): Frame[] {
  return worker.frames.filter((frame) => frame.id === id && frame.type !== 'progress');
}

/**
 * One row per answer a static file server can give the ranged GET, and per answer that leaves an
 * artefact unconfirmed. `probes` and `cancelled` are what the Worker's handling implies: it asks about
 * each artefact until one contradicts the declaration and then stops, and it cancels every body it is
 * handed, having read none of them.
 */
const CONFIRMATIONS = [
  {
    name: 'a 206 stating the whole file in Content-Range',
    answer: (ref: WorkerArtifactRef): Answer => ({
      status: 206,
      headers: { 'content-range': `bytes 0-0/${ref.size}`, 'content-length': '1' },
    }),
    code: null,
    probes: 2,
    cancelled: 2,
  },
  {
    name: 'a 200 that ignored the range and states the size in Content-Length',
    answer: (ref: WorkerArtifactRef): Answer => ({
      status: 200,
      headers: { 'content-length': String(ref.size) },
    }),
    code: null,
    probes: 2,
    cancelled: 2,
  },
  {
    name: 'a 206 whose Content-Range is missing',
    answer: (): Answer => ({ status: 206, headers: { 'content-length': '1' } }),
    code: 'artifact_download_failed',
    probes: 1,
    cancelled: 1,
  },
  {
    name: 'a 200 that states no Content-Length',
    answer: (): Answer => ({ status: 200 }),
    code: 'artifact_download_failed',
    probes: 1,
    cancelled: 1,
  },
  {
    name: 'a 206 whose Content-Range contradicts the declaration',
    answer: (ref: WorkerArtifactRef): Answer => ({
      status: 206,
      headers: { 'content-range': `bytes 0-0/${ref.size - 1}`, 'content-length': '1' },
    }),
    code: 'artifact_download_failed',
    probes: 1,
    cancelled: 1,
  },
  {
    name: 'a 404',
    answer: (): Answer => ({ status: 404 }),
    code: 'artifact_download_failed',
    probes: 1,
    cancelled: 1,
  },
  {
    name: 'a host that refuses the request outright',
    answer: (): Answer => ({ status: 0 }),
    code: 'artifact_download_failed',
    probes: 1,
    cancelled: 0,
  },
  {
    name: 'a second artefact whose Content-Range contradicts the declaration',
    answer: (ref: WorkerArtifactRef): Answer =>
      ref.url === ZKEY.url
        ? {
            status: 206,
            headers: { 'content-range': `bytes 0-0/${ref.size + 1}`, 'content-length': '1' },
          }
        : {
            status: 206,
            headers: { 'content-range': `bytes 0-0/${ref.size}`, 'content-length': '1' },
          },
    code: 'artifact_download_failed',
    probes: 2,
    cancelled: 2,
  },
];

describe('ensure where the origin private file system cannot be used', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(CONFIRMATIONS.filter((row) => row.code === null))(
    'resolves both artefacts to their published URLs: $name',
    async (row) => {
      const worker = await loadWorker(row.answer);
      const reply = worker.reply(1);
      worker.send(ensureFrame(1));
      const frame = await reply;

      expect(frame).toEqual({
        type: 'ensured',
        id: 1,
        artifacts: {
          wasm: { location: WASM.url, sha256: WASM.sha256, size: WASM.size },
          zkey: { location: ZKEY.url, sha256: ZKEY.sha256, size: ZKEY.size },
        },
      });
      // One reply and nothing else: the request that fetches no bytes reports no progress.
      expect(worker.frames).toEqual([frame]);
      expect(worker.requests).toEqual([
        { url: WASM.url, range: 'bytes=0-0' },
        { url: ZKEY.url, range: 'bytes=0-0' },
      ]);
      // The promise behind the ranged GET: every body cancelled, not one of them read.
      expect(worker.bodies).toEqual({ cancelled: 2, pulled: 0 });
    },
  );

  it.each(CONFIRMATIONS.filter((row) => row.code !== null))(
    'answers one error frame: $name',
    async (row) => {
      const worker = await loadWorker(row.answer);
      const reply = worker.reply(1);
      worker.send(ensureFrame(1));
      const frame = await reply;

      expect(frame).toEqual({ type: 'error', id: 1, code: row.code });
      // The failure is the whole answer: no progress frames, and the artefact after the failing one
      // is never asked about.
      expect(worker.frames).toEqual([frame]);
      expect(worker.requests).toHaveLength(row.probes);
      expect(worker.requests.map((request) => request.range)).toEqual(
        new Array<string>(row.probes).fill('bytes=0-0'),
      );
      expect(worker.bodies).toEqual({ cancelled: row.cancelled, pulled: 0 });
    },
  );
});

/* --- `prove`: the streaming read that replaces the OPFS read ----------------------------------- */

/** The bytes of an artefact in the slices a server sends them: a size no page boundary divides. */
function chunks(bytes: Uint8Array): Uint8Array[] {
  const size = 1_500_000;
  const slices: Uint8Array[] = [];
  for (let at = 0; at < bytes.byteLength; at += size) slices.push(bytes.subarray(at, at + size));
  return slices;
}

/**
 * A server that streams each artefact's own bytes, with `adjust` free to serve the key differently —
 * more bytes than the declaration, or fewer — which is how a case asks for a refusal.
 */
function servingKey(adjust: (bytes: Uint8Array) => readonly Uint8Array[] = chunks): Server {
  return (ref) =>
    ref.url === ZKEY.url
      ? { status: 200, chunks: adjust(ZKEY_BYTES) }
      : { status: 200, chunks: chunks(WASM_BYTES) };
}

/** The `prove` request the page posts for the two artefacts a case publishes. */
function proveFrame(id: number): ProveRequest {
  return {
    type: 'prove',
    id,
    inputsJson: '{"nullifier":"1"}',
    artifacts: {
      wasm: { location: WASM.url, sha256: WASM.sha256, size: WASM.size },
      zkey: { location: ZKEY.url, sha256: ZKEY.sha256, size: ZKEY.size },
    },
    appVersion: '0.1.0',
  };
}

describe('prove over the published URLs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    snark.keys.length = 0;
    snark.wasms.length = 0;
  });

  it('loads each artefact from its own URL into the shape snarkjs reads', async () => {
    const worker = await loadWorker(servingKey());
    const reply = worker.reply(1);
    worker.send(proveFrame(1));
    const frame = await reply;

    expect(frame).toMatchObject({ type: 'proved', id: 1, publicSignals: ['1'] });
    expect(onlyReply(worker, 1)).toEqual([frame]);
    // Both artefacts were fetched whole from their URLs, with no range and nothing stored.
    expect(worker.requests).toEqual([
      { url: WASM.url, range: null },
      { url: ZKEY.url, range: null },
    ]);
    // The WASM reached the witness calculator whole, in the `mem` form `wtns.calculate` reads.
    expect(snark.wasms).toEqual([{ type: 'mem', byteLength: WASM.size }]);
    // And the key reached groth16 as the page array of a fastfile `bigMem` file: full pages, with the
    // last one short, which is what `bigMem` derives the file's size from — over a single-threaded
    // curve, so no nested Worker is given a copy of the key.
    expect(snark.keys).toEqual([
      {
        type: 'bigMem',
        pageLengths: [ZKEY_PAGE_BYTES, ZKEY_BYTES.byteLength - ZKEY_PAGE_BYTES],
        options: { singleThread: true },
      },
    ]);
  });

  it.each([
    {
      name: 'a key body longer than the declaration',
      adjust: (bytes: Uint8Array): readonly Uint8Array[] => [...chunks(bytes), new Uint8Array(1)],
      code: 'artifact_download_failed',
    },
    {
      name: 'a key body that ends short of the declaration',
      adjust: (bytes: Uint8Array): readonly Uint8Array[] => chunks(bytes).slice(0, -1),
      code: 'artifact_hash_mismatch',
    },
  ])('answers one error frame: $name', async (row) => {
    const worker = await loadWorker(servingKey(row.adjust));
    const reply = worker.reply(1);
    worker.send(proveFrame(1));
    const frame = await reply;

    expect(frame).toEqual({ type: 'error', id: 1, code: row.code });
    expect(onlyReply(worker, 1)).toEqual([frame]);
    // The WASM was read first and the key's own read was refused, so snarkjs was never called.
    expect(worker.requests).toEqual([
      { url: WASM.url, range: null },
      { url: ZKEY.url, range: null },
    ]);
    expect(snark.keys).toHaveLength(0);
    expect(snark.wasms).toHaveLength(0);
  });
});

/* --- The declaration this Worker refuses before anything is read ------------------------------- */

describe('a declaration the Worker cannot confirm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers artifact_hash_mismatch without touching the network', async () => {
    const worker = await loadWorker(() => ({ status: 206 }));
    const reply = worker.reply(1);
    worker.send({
      ...ensureFrame(1),
      artifacts: { wasm: { ...WASM, sha256: 'nope' }, zkey: ZKEY },
    });
    const frame = await reply;

    expect(frame).toEqual({ type: 'error', id: 1, code: 'artifact_hash_mismatch' });
    expect(worker.requests).toEqual([]);
  });
});

/* --- `ensure` over the origin private file system: the download a write interrupts -------------- */

/**
 * The origin private file system, stubbed: a directory that answers a probe with `NotFoundError`, so
 * both artefacts count as absent and are downloaded, and a synchronous access handle whose every call
 * a case owns. `write` is the one that carries the case: the bytes it accepts, or the failure it
 * raises, which is how a write that fails part-way through a transfer — a full origin, a refused
 * handle — is reproduced here, the artefact being far too large to serve in this suite.
 */
function opfsStorage(write: (chunk: Uint8Array) => number): unknown {
  const file = {
    createSyncAccessHandle: (): Promise<unknown> =>
      Promise.resolve({
        read: (): number => 0,
        write,
        truncate: (): void => undefined,
        getSize: (): number => 0,
        flush: (): void => undefined,
        close: (): void => undefined,
      }),
  };
  const directory = {
    getFileHandle: (_name: string, options?: { readonly create?: boolean }): Promise<unknown> =>
      options?.create === true
        ? Promise.resolve(file)
        : Promise.reject(new DOMException('no such entry', 'NotFoundError')),
    removeEntry: (): Promise<void> => Promise.resolve(),
  };
  return {
    storage: {
      getDirectory: (): Promise<unknown> =>
        Promise.resolve({
          getDirectoryHandle: (_name: string, _options?: unknown): Promise<unknown> =>
            Promise.resolve(directory),
        }),
    },
  };
}

describe('ensure where a write fails part-way through a download', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers the failure that storage reported, with the transfer released', async () => {
    const worker = await loadWorker(() => ({
      status: 200,
      chunks: [WASM_BYTES.subarray(0, 32), WASM_BYTES.subarray(32)],
    }));
    // The origin runs out of room on the second chunk: the first is written, and the write that
    // follows is refused with the name Chromium gives a full origin — a failure of no phase's own
    // making, and not the oversize body the download already refuses for itself.
    let writes = 0;
    vi.stubGlobal(
      'navigator',
      opfsStorage((chunk) => {
        writes += 1;
        if (writes > 1) throw new DOMException('the origin is full', 'QuotaExceededError');
        return chunk.byteLength;
      }),
    );

    const reply = worker.reply(1);
    worker.send(ensureFrame(1));
    const frame = await reply;

    expect(frame).toEqual({ type: 'error', id: 1, code: 'artifact_insufficient_storage' });
    // One reply and nothing else: the single report of the transfer is below the step a frame needs.
    expect(worker.frames).toEqual([frame]);
    expect(worker.requests).toEqual([{ url: WASM.url, range: null }]);
    expect(writes).toBe(2);
    // The transfer was released rather than left pulling: the body was read as far as the write that
    // failed and then cancelled, so nothing keeps fetching in a Worker the page is about to kill.
    expect(worker.bodies).toEqual({ cancelled: 1, pulled: 2 });
  });
});
