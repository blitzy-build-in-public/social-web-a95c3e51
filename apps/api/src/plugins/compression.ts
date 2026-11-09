/**
 * Response compression on `node:zlib` (AAP 0.1.1, 0.11.2, 0.12.2).
 *
 * The API answers JSON on a port `docker-compose` publishes directly, with no proxy between the
 * client and the process — `app.ts` sets `trustProxy: false` precisely because nothing in front of
 * it may describe the client (AAP 0.3.2) — so no other stage can compress an API body. The web
 * client's nginx gzips its static export; this plugin gives the API's own bodies the same treatment,
 * and at 50 requests a second those are the larger share of the bytes: the discovery page is 7,031
 * bytes and a page of 20 own meetups 17,828 bytes, against 676 bytes for `GET /me`.
 *
 * **`node:zlib`, not a dependency.** The delivery installs one pinned dependency set with
 * `pnpm install --frozen-lockfile` (AAP 0.1.2), so a compression package would have to be added to
 * `apps/api/package.json`, to the root lockfile and to every image build that installs from it.
 * Node's own `zlib` already produces both codings an HTTP client asks for, so this stage is built on
 * it and the dependency set is left exactly as it is.
 *
 * **When a body is compressed.** Only when the client asked for it — `Accept-Encoding` naming gzip or
 * deflate, a `q=0` refusing that coding, `*` standing for every coding the header does not name, and
 * an absent or non-matching header meaning no compression at all — and only when the response is a
 * compressible one: a `string` or `Buffer` payload (a stream is written as it is read and is left
 * alone), a status that carries a body (not 1xx, 204 or 304), no `Content-Encoding` a route already
 * chose, a compressible media type, and at least {@link COMPRESSION_THRESHOLD_BYTES} bytes. Below
 * that threshold the framing costs more than the coding saves, and a body that is not text at all —
 * `image/webp`, `application/octet-stream`, a font — is sent exactly as the route produced it.
 *
 * **`Vary`.** Every response this stage judged compressible carries `Accept-Encoding` in `Vary`,
 * whether or not it was actually compressed: a cache that stored the gzip body of one client must
 * never hand it to a client that asked for none. A value a route set itself (`@fastify/cors` sets
 * `Vary: Origin`) is extended, never replaced.
 *
 * **It fails open.** A `zlib` failure hands the caller the payload the route produced: an
 * uncompressed 200 beats a broken response, and a body the client can read in its plain form is a
 * legal answer to the request it made.
 *
 * **Responses only, and never a frame.** Nothing here decodes or re-encodes a request body, so the
 * bytes a parser sees are the bytes that arrived: `POST /v1/webhooks/stripe` still checks its
 * signature against exactly what Stripe sent (AAP 0.3.2). A WebSocket frame never reaches this hook
 * either — the socket is detached from the reply when it is hijacked, so the chat and voice-relay
 * connections carry nothing through `onSend`.
 *
 * @see AAP 0.5.1 for the plugin list this plugin joins, 0.11.1 for the comment and TSDoc rules it
 *   follows, 0.12.2 for the read and write latency targets it must not cost, and 0.1.2 for the one
 *   pinned dependency set it keeps.
 */

import { deflate, gzip } from 'node:zlib';

import type { FastifyInstance } from 'fastify';

/**
 * The smallest payload this stage compresses, in bytes: 1024, one kibibyte.
 *
 * The bodies this stage exists for are the paginated lists — 7,031 bytes of discovery, 17,828 bytes
 * of own meetups at 20 items — while a small answer such as `GET /me` is a few hundred bytes whose
 * gzip is almost as large as the body itself. One kibibyte is also the threshold the load profile
 * can pay for: a body this size compresses on a thread-pool thread in well under the read target of
 * AAP 0.12.2, and anything below it is sent untouched.
 */
export const COMPRESSION_THRESHOLD_BYTES = 1024;

/**
 * The codings this stage produces, most preferred first. Every client that offers gzip decodes it,
 * so gzip wins wherever both it and deflate are acceptable; deflate is the fallback for a client
 * that refuses gzip with `q=0`.
 */
const SUPPORTED_CODINGS = ['gzip', 'deflate'] as const;

/** One of the codings {@link SUPPORTED_CODINGS} names. */
type SupportedCoding = (typeof SUPPORTED_CODINGS)[number];

/**
 * The exact media types this stage compresses, beside the `text/*` family and the `+json` and `+xml`
 * suffixes. `application/json` is what every route of the contract answers with (AAP 0.5.4), and the
 * three others are the text types a route of this API could plausibly send: the errors envelope as
 * JSON, the TwiML document as `application/xml`, and a script as `application/javascript`. A binary
 * type (`image/webp` for the profile photo, `application/octet-stream`, a font) is deliberately
 * absent: gzip does not meaningfully shrink those, and the bytes reach the client as they were
 * stored.
 */
const COMPRESSIBLE_MEDIA_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
]);

/**
 * The one instance member this plugin calls, taken from the instance type.
 *
 * `app.ts` passes the composed `App`, a `FastifyInstance` carrying the Zod type provider, and the
 * suite passes a bare `Fastify()` instance that carries this stage and nothing else, so the parameter
 * is the narrowest type both satisfy — the same device `plugins/raw-body.ts` uses for the two members
 * it calls.
 */
export interface CompressionHost {
  addHook: FastifyInstance['addHook'];
}

/**
 * Registers the response-compression stage on the instance `app.ts` builds (AAP 0.5.1).
 *
 * Synchronous, like its siblings: the hook is added to the root instance while the app is being
 * composed, so it runs for every route every module declares — a hook added to a child context would
 * serve that context's routes alone. It is added before the `Server-Timing` and `Date` hook the
 * composition root installs at step 9, so those headers are set on the encoded response and their
 * values never travel through a compressor (AAP 0.3.2, 0.12.2).
 *
 * @param app - The root instance the `onSend` hook is added to.
 */
export function registerCompression(app: CompressionHost): void {
  app.addHook('onSend', (request, reply, payload, done) => {
    const body = compressibleBody(payload);

    // A response this stage will not touch at all: no body to encode, an encoding the route chose for
    // itself, or a media type the coding cannot help.
    if (
      body === null ||
      !statusCarriesBody(reply.statusCode) ||
      reply.getHeader('content-encoding') !== undefined ||
      !isCompressibleMediaType(reply.getHeader('content-type'))
    ) {
      done(null, payload);
      return;
    }

    // From here the response IS compressible, so it is marked as varying by `Accept-Encoding` even
    // when the decision below turns out to be to send it as it is: a client that asked for no coding
    // and a client that asked for gzip must never share one cached entry.
    const vary = withAcceptEncoding(reply.getHeader('vary'));
    if (vary !== null) {
      reply.header('vary', vary);
    }

    const acceptEncoding = request.headers['accept-encoding'];
    // Repeated headers arrive as an array from Node; the header is one list either way.
    const coding = negotiatedCoding(
      Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding,
    );
    if (coding === null || Buffer.byteLength(body) < COMPRESSION_THRESHOLD_BYTES) {
      done(null, payload);
      return;
    }

    compressBody(body, coding).then(
      (compressed) => {
        reply.header('content-encoding', coding);
        // The body is a different length now: a `content-length` left over from the uncompressed body
        // would truncate the response or make Node refuse the write, and Fastify recomputes it from
        // the Buffer returned here.
        reply.removeHeader('content-length');
        done(null, compressed);
      },
      // Fail open: the encoded body is the optional half of this response, and the client that asked
      // for gzip can still read the plain one it gets instead.
      () => done(null, payload),
    );
  });
}

/**
 * The payload as a body this stage may compress, or `null` when it must be left alone.
 *
 * Only a `string` and a `Buffer` are bodies here. Fastify hands an `onSend` hook whatever a route
 * produced, and a stream payload — a file, a long-lived response — is written as it is read, so
 * compressing it would mean buffering the whole thing in the process serving 50 requests a second.
 */
function compressibleBody(payload: unknown): string | Buffer | null {
  if (typeof payload === 'string') {
    return payload;
  }
  if (Buffer.isBuffer(payload)) {
    return payload;
  }
  return null;
}

/**
 * Whether a status code carries a body a client could inflate.
 *
 * 1xx are informational, and 204 and 304 answer with headers alone, so none of them has a payload —
 * RFC 9110 §8.6 forbids a `Content-Length` on them for the same reason. Compression is skipped over
 * them rather than left to produce an encoding header on a bodyless response.
 */
function statusCarriesBody(statusCode: number): boolean {
  return statusCode >= 200 && statusCode !== 204 && statusCode !== 304;
}

/**
 * Whether a response's media type is one of {@link COMPRESSIBLE_MEDIA_TYPES}, the `text/*` family, or
 * a `+json`/`+xml` suffixed type.
 *
 * The media type is read from the reply's own `content-type` header and is everything before the
 * first `;` parameter: a route that answers `application/json` sends
 * `application/json; charset=utf-8`, and the charset is not part of the type. A response with no
 * `content-type` at all is not compressed, because nothing declares its bytes to be text.
 */
function isCompressibleMediaType(contentType: number | string | string[] | undefined): boolean {
  const header = Array.isArray(contentType) ? contentType[0] : contentType;
  if (header === undefined) {
    return false;
  }

  const mediaType = String(header).split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType === '') {
    return false;
  }

  return (
    mediaType.startsWith('text/') ||
    COMPRESSIBLE_MEDIA_TYPES.has(mediaType) ||
    mediaType.endsWith('+json') ||
    mediaType.endsWith('+xml')
  );
}

/**
 * The `Vary` value a compressible response must carry — `Accept-Encoding` added to whatever the route
 * already set — or `null` when the value needs no change.
 *
 * A route that varies by origin keeps its value and gains this one; a response that varies by `*`
 * already varies by everything and is left as it is; and the header name is only ever added once,
 * however many hooks run over one response.
 *
 * @param vary - The reply's current `vary` header, as Fastify holds it.
 * @returns The header value to write, or `null` to leave the header as it is.
 */
function withAcceptEncoding(vary: number | string | string[] | undefined): string | null {
  const current = Array.isArray(vary) ? vary.join(', ') : (vary?.toString() ?? '');
  if (current === '*' || current.toLowerCase().includes('accept-encoding')) {
    return null;
  }

  return current === '' ? 'Accept-Encoding' : `${current}, Accept-Encoding`;
}

/**
 * The coding to answer with, or `null` when the request asked for none this stage can produce.
 *
 * `acceptEncoding` is the raw `Accept-Encoding` header: a comma-separated list of codings, each with
 * an optional `;q=` weight between 0 and 1. A coding with `q=0` is refused, `*` stands for every
 * coding the header does not name (so `*;q=0` refuses everything), a named coding always beats `*`
 * whether it raises or lowers that coding's weight, and a header that names neither of
 * {@link SUPPORTED_CODINGS} and carries no `*` is a request for identity alone. An absent header is
 * the same as an empty one: no coding was offered, so none is used — a body is never compressed at a
 * client that did not ask for it.
 */
function negotiatedCoding(acceptEncoding: string | undefined): SupportedCoding | null {
  if (acceptEncoding === undefined) {
    return null;
  }

  const qualities = parseAcceptEncoding(acceptEncoding);
  const wildcard = qualities.get('*') ?? 0;
  for (const coding of SUPPORTED_CODINGS) {
    // A coding the header names is judged by its own weight; one it does not name is admitted by `*`.
    if ((qualities.get(coding) ?? wildcard) > 0) {
      return coding;
    }
  }
  return null;
}

/**
 * The weight each coding is named with in an `Accept-Encoding` header, by lower-cased coding.
 *
 * A coding is named once with its weight, `1` when no `;q=` parameter follows it. A `q` that is not a
 * number refuses the coding rather than being ignored, because a header this stage cannot read as
 * consent to a coding is not consent. A coding named twice keeps the weight of its first mention,
 * which is what RFC 9110 §12.4.1 gives the first occurrence.
 */
function parseAcceptEncoding(acceptEncoding: string): Map<string, number> {
  const qualities = new Map<string, number>();

  for (const entry of acceptEncoding.split(',')) {
    const [codingToken, ...parameters] = entry.split(';');
    const coding = (codingToken ?? '').trim().toLowerCase();
    if (coding === '') {
      continue;
    }

    let quality = 1;
    for (const parameter of parameters) {
      const [name, value] = parameter.split('=');
      if ((name ?? '').trim().toLowerCase() !== 'q') {
        continue;
      }
      const parsed = Number((value ?? '').trim());
      quality = Number.isFinite(parsed) ? parsed : 0;
    }

    if (!qualities.has(coding)) {
      qualities.set(coding, quality);
    }
  }

  return qualities;
}

/**
 * Compresses one body with the coding the client negotiated, rejecting when the coding fails.
 *
 * The asynchronous `zlib.gzip` and `zlib.deflate`, and never the `*Sync` pair: a 17 KB body looks
 * small enough to compress on the spot, but a body of a megabyte compressed on the event loop would
 * hold up the next request in a process serving 50 requests a second (AAP 0.12.2), while the
 * asynchronous form runs the coding on a thread-pool thread. The rejection is the caller's to turn
 * into the plain-body path of {@link registerCompression}; nothing here writes to the reply.
 *
 * @param body - The payload the route produced: a string, or the bytes of one.
 * @param coding - The coding the request negotiated.
 * @returns The encoded body, once `zlib` has produced it.
 */
function compressBody(body: string | Buffer, coding: SupportedCoding): Promise<Buffer> {
  // `Buffer.byteLength` measured the same UTF-8 bytes the response is written with, so a string body
  // is compressed as the bytes the client would otherwise have received.
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');

  return new Promise((resolve, reject) => {
    const settle = (error: Error | null, compressed: Buffer): void => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(compressed);
    };

    if (coding === 'gzip') {
      gzip(bytes, settle);
      return;
    }
    deflate(bytes, settle);
  });
}
