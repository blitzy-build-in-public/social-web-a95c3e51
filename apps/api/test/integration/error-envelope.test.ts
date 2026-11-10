/**
 * The envelope for a request the HTTP layer refuses before any handler runs.
 *
 * Two layers refuse such a request, and the framework carries a body of its own for each: the HTTP parser, which
 * rejects a header value it cannot read and a header block past the server's limit before a request exists at all,
 * and the router, which refuses a URL it cannot parse and a path parameter past the route's limit as it looks the
 * request up. The framework's own answer —
 * `{"error":"Bad Request","message":"Client Error","statusCode":400}`, whose `statusCode` field and `Client Error`
 * wording disclose the framework, and which quotes the request path back — would otherwise be what the caller
 * receives. Every such answer must carry the shared `{ error: { code, message } }` envelope instead, with a code
 * from the vocabulary in `packages/shared/src/errors.ts` and the status that vocabulary gives the code (AAP 0.5.4;
 * `docs/api/README.md` "Errors").
 *
 * The cases speak HTTP by hand over a raw TCP socket, because no client library puts these bytes on the wire: a
 * client normalizes or refuses such a path before it sends it.
 */
import { connect } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ErrorEnvelope } from '@tablemate/shared';

import { createTestApp } from '../support/app.ts';
import { rows } from '../support/factories.ts';

import type { Socket } from 'node:net';

import type { TestApp } from '../support/app.ts';

/** The venue console route a request names. Each request is refused before any route is resolved, so it is only a path. */
const REQUEST_PATH = '/v1/venue/check-in-code';

/** How long one raw request may take to be answered: a refusal at this layer is answered at once. */
const ANSWER_TIMEOUT_MS = 10_000;

/** Where a response's head ends. */
const HEAD_END = '\r\n\r\n';

/**
 * The header value of the oversized case, longer than node's own 16 KiB header limit, so the parser raises
 * `HPE_HEADER_OVERFLOW` while it reads the request.
 */
const OVERSIZED_HEADER_CHARS = 20_000;

/** The path the router cannot parse: `%ZZ` is not a valid percent-encoding, so its lookup raises `FST_ERR_BAD_URL`. */
const UNPARSEABLE_PATH = '/v1/%ZZ';

/** How long the path parameter of the router's other case is: past Fastify's default `maxParamLength` of 100. */
const OVERSIZED_PARAM_CHARS = 150;

/**
 * The path whose parameter is too long for the router: `/v1/cities/:cityId/travelers` is a route the app registers,
 * so the lookup raises `FST_ERR_MAX_PARAM_LENGTH` rather than missing the route.
 */
const OVERSIZED_PARAM_PATH = `/v1/cities/${'a'.repeat(OVERSIZED_PARAM_CHARS)}/travelers`;

/** One request this layer refuses, with the answer the envelope gives it: one row per refusal. */
interface RefusedRequest {
  readonly name: string;
  readonly request: string;
  readonly message: string;
  /**
   * The `Content-Type` the answer carries. The parser's own head is written by hand and names the media type alone;
   * an answer Fastify's reply writes — the router's two — carries the charset it appends for JSON, which is the
   * value every other JSON answer of this app carries.
   */
  readonly contentType: string;
}

/**
 * The five refusals the framework writes a body of its own for: three the parser raises before a request exists —
 * any llhttp parse failure (a control byte in a header value here), a request line it cannot read at all, and a
 * header block past the server's limit — and two the router raises as it looks the request up. The sixth,
 * `ERR_HTTP_REQUEST_TIMEOUT`, is unreachable while Fastify leaves `requestTimeout` at its default of 0.
 */
const REFUSED_REQUESTS = rows<RefusedRequest>([
  {
    name: 'a control byte in a header value',
    request: `GET ${REQUEST_PATH} HTTP/1.1\r\nHost: localhost\r\nx-venue-secret: a\x01b\r\n\r\n`,
    message: 'Invalid request.',
    contentType: 'application/json',
  },
  {
    name: 'a malformed request line',
    request: 'GET\r\nHost: localhost\r\n\r\n',
    message: 'Invalid request.',
    contentType: 'application/json',
  },
  {
    name: 'a header block past the server limit',
    request: `GET ${REQUEST_PATH} HTTP/1.1\r\nHost: localhost\r\nx-venue-secret: ${'a'.repeat(OVERSIZED_HEADER_CHARS)}\r\n\r\n`,
    message: 'Request headers too large.',
    contentType: 'application/json',
  },
  {
    name: 'a URL the router cannot parse',
    request: `GET ${UNPARSEABLE_PATH} HTTP/1.1\r\nHost: localhost\r\n\r\n`,
    message: 'Invalid request.',
    contentType: 'application/json; charset=utf-8',
  },
  {
    name: 'a path parameter past the route limit',
    request: `GET ${OVERSIZED_PARAM_PATH} HTTP/1.1\r\nHost: localhost\r\n\r\n`,
    message: 'Invalid request.',
    contentType: 'application/json; charset=utf-8',
  },
]);

/** One answer read whole: its status line, its headers lower-cased, and its body. */
interface RawAnswer {
  readonly statusLine: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

let t: TestApp;

/** The address the app listens on: the harness asks the kernel for a free port and answers the same one again. */
let address: string;

beforeAll(async () => {
  t = await createTestApp();
  address = await t.listen();
});

afterAll(async () => {
  await t.close();
});

/**
 * The answer in `received`, once its head and the whole body its `Content-Length` names have arrived, and `null`
 * while more is outstanding. An answer is complete on arrival rather than when the socket ends, because a refusal at
 * this layer closes the connection.
 */
function completeAnswer(received: Buffer): RawAnswer | null {
  const headEnd = received.indexOf(HEAD_END);
  if (headEnd < 0) return null;
  const [statusLine = '', ...headerLines] = received
    .subarray(0, headEnd)
    .toString('utf8')
    .split('\r\n');
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
  }
  const length = Number(headers['content-length'] ?? Number.NaN);
  const body = received.subarray(headEnd + HEAD_END.length);
  if (!Number.isInteger(length) || body.byteLength < length) return null;
  return { statusLine, headers, body: body.subarray(0, length).toString('utf8') };
}

/** Writes one request once the connection is up and reads the whole answer back. */
function readAnswer(socket: Socket, request: string): Promise<RawAnswer> {
  return new Promise<RawAnswer>((done, fail) => {
    let received = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      abort(new Error('the request was not answered in time'));
    }, ANSWER_TIMEOUT_MS);
    function finish(answer: RawAnswer): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      done(answer);
    }
    function abort(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fail(error);
    }
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const answer = completeAnswer(received);
      if (answer !== null) finish(answer);
    });
    socket.once('error', abort);
    socket.once('close', () => {
      abort(new Error('the connection closed before the answer was complete'));
    });
    socket.once('connect', () => {
      socket.write(request);
    });
  });
}

/** One raw request to the listening app, and its whole answer. */
function sendRaw(request: string): Promise<RawAnswer> {
  const target = new URL(address);
  return readAnswer(connect({ host: target.hostname, port: Number(target.port) }), request);
}

describe('the envelope for a request the HTTP layer refuses (AAP 0.5.4)', () => {
  it.each(REFUSED_REQUESTS)(
    'answers $name in the envelope and in no framework shape',
    async (row) => {
      const answer = await sendRaw(row.request);
      expect(answer.statusLine).toBe('HTTP/1.1 400 Bad Request');
      expect(answer.headers['content-type']).toBe(row.contentType);
      // Read for the keys it carries as well as for its values: a `zod` object strips an unknown key, so a
      // key set asserted on the parsed envelope could not see the framework's `statusCode` find its way back.
      const body = JSON.parse(answer.body) as Record<string, unknown>;
      const envelope = ErrorEnvelope.parse(body);
      expect(envelope.error.code).toBe('invalid_field');
      expect(envelope.error.message).toBe(row.message);
      expect(Object.keys(body)).toEqual(['error']);
      expect(Object.keys(body['error'] as object)).toEqual(['code', 'message']);
    },
  );
});
