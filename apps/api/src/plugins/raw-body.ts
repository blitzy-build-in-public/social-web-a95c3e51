/**
 * Raw-body JSON parsing for the Stripe webhook.
 *
 * Stripe signs the bytes of the body it sent, so `stripe.webhooks.constructEvent` in `modules/payments/webhook.ts`
 * must check the signature against those exact bytes: a signature computed over a re-serialized object fails on a
 * request that was genuine, because JSON key order, number form and whitespace are not preserved by a parse/serialize
 * round trip. This module replaces Fastify's `application/json` parser with one that keeps the received bytes on
 * `request.rawBody` and still parses the body, so the route verifies the signature and then reads `request.body`.
 *
 * The replacement belongs to the ENCAPSULATED child `modules/payments/webhook.ts` registers for
 * `POST /v1/webhooks/stripe`, never to the instance `app.ts` builds: Fastify clones the content-type-parser table into
 * every child context, so a parser added inside the child serves that route alone, while on the root it would hold the
 * raw bytes of every request in the process's memory and replace the parser every other route relies on.
 *
 * Nothing here logs a body: an event payload is customer data, and the failure below answers a fixed sentence rather
 * than a parser message that could quote what was sent.
 */
import { AppError } from './errors.ts';

import type { FastifyBodyParser, FastifyInstance } from 'fastify';

import type { App } from '../app.ts';

/** The bytes this request was received with, verbatim: set by {@link registerRawJsonBody} alone. */
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

const INVALID_JSON_MESSAGE = 'Body is not valid JSON.';

/**
 * The two methods this module calls, taken from the instance type: `addContentTypeParser` is overloaded and a union of
 * instance types cannot call it — TypeScript synthesizes the union's signatures and matches the `{ bodyLimit }`
 * overload first, which rejects `parseAs` — so this narrower type is what keeps the call well defined.
 */
type RawBodyInstance = Pick<FastifyInstance, 'addContentTypeParser' | 'removeContentTypeParser'>;

/**
 * Typed as the buffer variant `FastifyBodyParser<Buffer>`, which is what selects Fastify's `parseAs: 'buffer'` overload
 * for the call below, so `body` arrives as the received `Buffer` rather than as a decoded string.
 */
const rawJsonParser: FastifyBodyParser<Buffer> = (request, body, done) => {
  request.rawBody = body;
  const text = body.toString('utf8');
  if (text.length === 0) {
    done(new AppError('invalid_field', INVALID_JSON_MESSAGE), undefined);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    done(new AppError('invalid_field', INVALID_JSON_MESSAGE), undefined);
    return;
  }
  done(null, parsed);
};

/**
 * Registers a JSON parser on `ctx` that keeps the received bytes on `request.rawBody` and parses the body as Fastify's
 * own parser does. Synchronous, and called while the webhook plugin is being registered, before its routes are declared:
 * `addContentTypeParser` throws once the instance has started, and `ctx` is the encapsulated child that plugin creates.
 *
 * The parser takes no `bodyLimit`, so the route's own limit applies — the default 1 MiB from `app.ts`, far above any
 * event Stripe sends — and it matches `application/json; charset=utf-8` too, because Fastify compares a header's media
 * type once a full match with its parameters fails.
 *
 * A body that is empty or not JSON at all is refused with `invalid_field` (400) — the code the error plugin gives
 * Fastify's own JSON-parser refusals — before the route runs, so the signature check never sees that body. The bytes are
 * set on the request before parsing, so a failure inside a later hook or handler still leaves them available.
 */
export function registerRawJsonBody(ctx: App | FastifyInstance): void {
  const instance: RawBodyInstance = ctx;
  // A child inherits the root's parser for this media type, and a second parser for a type that already
  // has one can be refused, so the inherited parser is removed first; removal in a child context leaves
  // the root's table untouched.
  instance.removeContentTypeParser('application/json');
  instance.addContentTypeParser('application/json', { parseAs: 'buffer' }, rawJsonParser);
}
