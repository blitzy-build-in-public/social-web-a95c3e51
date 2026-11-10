/**
 * The response-compression stage's unit suite (AAP 0.1.1, 0.11.2, 0.12.2): which request receives an encoded
 * body, which response is left alone, and what encoding one response costs.
 *
 * The stage is exercised where it lives — a bare `Fastify()` carrying only `registerCompression` and the nine
 * routes below, one per shape the stage has to judge — so every case is one `app.inject()` and a look at the
 * reply it produced, with no database, no Redis, no route schema and no other plugin in the way. What the
 * suite pins: `Accept-Encoding` is parsed rather than matched (`q=0` refuses a coding, `*` admits what the
 * header does not name, a named coding beats the wildcard, gzip is preferred over deflate wherever both are
 * acceptable, and a request offering no coding receives none); a body is compressed only when the whole
 * response qualifies (at least {@link COMPRESSION_THRESHOLD_BYTES} bytes, a compressible media type, a status
 * that carries a body, no `Content-Encoding` already set, and never a stream); an encoded body names its
 * coding, its `content-length` counts the encoded bytes and the bytes inflate back to exactly the body the
 * route produced; every compressible response varies by `Accept-Encoding`, compressed or not, and a `Vary` a
 * route set itself is extended rather than replaced; and the request is untouched, a POST body reaching its
 * handler byte for byte, which keeps the Stripe webhook's signature check valid (AAP 0.3.2).
 */

import { Readable } from 'node:stream';
import { gunzipSync, inflateSync } from 'node:zlib';

import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';

import { COMPRESSION_THRESHOLD_BYTES, registerCompression } from '../../src/plugins/compression.ts';

import type { FastifyInstance } from 'fastify';

/**
 * The page the JSON routes answer with: twenty items, the page size of the contract's list routes
 * (AAP 0.5.4), each carrying enough fields to put the serialized body well above the threshold.
 */
const PAGE = {
  items: Array.from({ length: 20 }, (_value, index) => ({
    id: `itinerary-${index}`,
    cityId: 'lisbon',
    handle: `traveler-${index}`,
    startsAt: '2026-11-20T18:00:00.000Z',
  })),
};

/** {@link PAGE} as the route's payload becomes it: Fastify serializes an object with `JSON.stringify`. */
const PAGE_JSON = JSON.stringify(PAGE);

/** A body below the threshold, to pin that a small answer is sent as it is. */
const SMALL_PAGE = { status: 'proposed' };

const SMALL_JSON = JSON.stringify(SMALL_PAGE);

/**
 * A body of exactly {@link COMPRESSION_THRESHOLD_BYTES} bytes, to pin the threshold as inclusive: the stage
 * compresses a payload of at least that many bytes.
 */
const THRESHOLD_BODY = 'x'.repeat(COMPRESSION_THRESHOLD_BYTES);

/** A photo's bytes, as `GET /v1/users/:userId/photo` sends them: a binary type gzip cannot help. */
const PHOTO_BYTES = Buffer.alloc(4096, 0x2a);

/**
 * The POST bodies a handler has seen, verbatim, so the suite can show the stage never touches a request.
 */
const receivedBodies: unknown[] = [];

/**
 * One row of the encoding table: what the row describes, the `Accept-Encoding` header the client sent, and
 * the coding it must receive back.
 */
type EncodingCase = readonly [label: string, acceptEncoding: string, coding: 'gzip' | 'deflate'];

/**
 * Every way a request can admit a coding (RFC 9110 §12.4.1 as the stage reads it). The rows differ only in
 * the header: every reply names the coding in the third column, carries a `content-length` of the encoded
 * bytes, and a body that inflates to {@link PAGE}.
 */
const ENCODING_CASES: readonly EncodingCase[] = [
  ['gzip and deflate both offered', 'gzip, deflate', 'gzip'],
  ['deflate offered alone', 'deflate', 'deflate'],
  [
    'gzip weighted below deflate, which the stage still prefers',
    'deflate;q=0.9, gzip;q=0.5',
    'gzip',
  ],
  ['gzip refused with q=0', 'gzip;q=0, deflate', 'deflate'],
  ['a wildcard alone', '*', 'gzip'],
  ['a wildcard beside a coding the stage cannot produce', 'br, *;q=0.5', 'gzip'],
  ['a wildcard refused where a named coding is allowed', 'gzip;q=1, *;q=0', 'gzip'],
];

/**
 * One row of the plain-body table: what the row describes and the `Accept-Encoding` header the client sent —
 * undefined for a request that sends none.
 */
type PlainCase = readonly [label: string, acceptEncoding: string | undefined];

/**
 * Every header that asks for no coding at all, each of which must leave the body exactly as the route
 * produced it: no `content-encoding`, `Vary: Accept-Encoding`, and the plain {@link PAGE_JSON} body.
 */
const PLAIN_CASES: readonly PlainCase[] = [
  ['no Accept-Encoding header at all', undefined],
  ['an empty Accept-Encoding header', ''],
  ['an identity-only header', 'identity'],
  ['a coding the stage cannot produce', 'br'],
  ['a wildcard that refuses everything', '*;q=0'],
  ['both codings refused', 'gzip;q=0, deflate;q=0'],
  ['a coding this stage cannot produce refused as well', 'br;q=0, gzip;q=0, deflate;q=0'],
];

/**
 * The app every case injects against: a bare instance carrying the stage under test and the routes below,
 * one per shape the stage judges — a large JSON page, a large page that already varies by origin, a body
 * below the threshold, a body exactly at it, a binary media type, a stream payload, a response that carries a
 * `Content-Encoding` already, a 204, and a POST that reports the bytes it saw.
 */
function buildApp(): FastifyInstance {
  const app = Fastify();

  registerCompression(app);

  app.get('/meetups', () => PAGE);

  app.get('/meetups-varied', (_request, reply) => {
    // A `Vary` of the route's own, as `@fastify/cors` sets one on every answer it decorates (AAP 0.3.2).
    reply.header('vary', 'Origin');
    return PAGE;
  });

  app.get('/small', () => SMALL_PAGE);

  app.get('/at-threshold', () => THRESHOLD_BODY);

  app.get('/photo', (_request, reply) => reply.type('image/webp').send(PHOTO_BYTES));

  app.get('/stream', (_request, reply) =>
    reply.type('application/json').send(Readable.from([PAGE_JSON])),
  );

  app.get('/encoded', (_request, reply) =>
    reply.header('content-encoding', 'br').type('application/json').send(PAGE_JSON),
  );

  // A 204 whose payload is compressible in every other respect, so only the status keeps it plain.
  app.get('/nothing', (_request, reply) =>
    reply.code(204).type('application/json').send(PAGE_JSON),
  );

  app.post('/echo', (request) => {
    receivedBodies.push(request.body);
    return { ok: true };
  });

  return app;
}

const app = buildApp();

afterAll(async () => {
  await app.close();
});

describe('the coding a request negotiates', () => {
  it.each(ENCODING_CASES)('%s -> %s', async (_label, acceptEncoding, coding) => {
    const response = await app.inject({
      method: 'GET',
      url: '/meetups',
      headers: { 'accept-encoding': acceptEncoding },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe(coding);
    expect(response.headers.vary).toBe('Accept-Encoding');
    expect(response.headers['content-length']).toBe(String(response.rawPayload.length));

    const decoded =
      coding === 'gzip' ? gunzipSync(response.rawPayload) : inflateSync(response.rawPayload);
    expect(JSON.parse(decoded.toString('utf8'))).toEqual(PAGE);
  });
});

describe('a request that asks for no coding', () => {
  it.each(PLAIN_CASES)('%s -> the body is sent as it is', async (_label, acceptEncoding) => {
    const response = await app.inject({
      method: 'GET',
      url: '/meetups',
      headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
    // The same URL answers an encoding to a client that asks for one, so a cache must key on the
    // header whether or not this particular response carried an encoding.
    expect(response.headers.vary).toBe('Accept-Encoding');
    expect(response.body).toBe(PAGE_JSON);
  });
});

describe('the size a body must reach', () => {
  it('compresses a body of exactly the threshold, and a shorter one not at all', async () => {
    const atThreshold = await app.inject({
      method: 'GET',
      url: '/at-threshold',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(atThreshold.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(atThreshold.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(atThreshold.rawPayload).toString('utf8')).toBe(THRESHOLD_BODY);

    const belowThreshold = await app.inject({
      method: 'GET',
      url: '/small',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(Buffer.byteLength(SMALL_JSON)).toBeLessThan(COMPRESSION_THRESHOLD_BYTES);
    expect(belowThreshold.headers['content-encoding']).toBeUndefined();
    expect(belowThreshold.headers.vary).toBe('Accept-Encoding');
    expect(belowThreshold.body).toBe(SMALL_JSON);
  });

  it('saves bytes rather than adding them', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/meetups',
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(response.rawPayload.length).toBeLessThan(Buffer.byteLength(PAGE_JSON));
  });
});

describe('what the stage leaves alone', () => {
  it('leaves a response that already carries a Content-Encoding untouched', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/encoded',
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(response.headers['content-encoding']).toBe('br');
    expect(response.headers.vary).toBeUndefined();
    expect(response.body).toBe(PAGE_JSON);
  });

  it('leaves a 204 untouched', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/nothing',
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.body).toBe('');
  });

  it('leaves a non-compressible media type untouched', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/photo',
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers.vary).toBeUndefined();
    expect(response.rawPayload.equals(PHOTO_BYTES)).toBe(true);
  });

  it('leaves a stream payload untouched', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/stream',
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers.vary).toBeUndefined();
    expect(response.body).toBe(PAGE_JSON);
  });

  it('extends a Vary the route set itself, rather than replacing it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/meetups-varied',
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(response.headers.vary).toBe('Origin, Accept-Encoding');
    expect(response.headers['content-encoding']).toBe('gzip');
  });
});

describe('the request', () => {
  it('reaches its handler byte for byte', async () => {
    // Whitespace a parse/serialize round trip would drop, so a body that arrived re-encoded could not
    // compare equal.
    const sent = '{"note":"  two  spaces  keep  their  places  "}\n';

    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'text/plain', 'accept-encoding': 'gzip' },
      payload: sent,
    });

    expect(response.statusCode).toBe(200);
    expect(receivedBodies).toEqual([sent]);
    expect(response.headers['content-encoding']).toBeUndefined();
  });
});
