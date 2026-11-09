/**
 * Raw-body JSON parsing for the Stripe webhook (AAP 0.3.2, 0.3.3, 0.5.1, 0.8.1).
 *
 * Stripe signs the bytes of the body it sent, so `stripe.webhooks.constructEvent` in
 * `modules/payments/webhook.ts` must check the signature against those exact bytes: a signature
 * computed over a re-serialized object fails on a request that was genuine, because JSON key order,
 * number form and whitespace are not preserved by a parse/serialize round trip (AAP 0.3.3). This
 * module replaces Fastify's `application/json` parser with one that keeps the received bytes on
 * `request.rawBody` and still parses the body, so the webhook route verifies the signature and then
 * reads `request.body` as usual.
 *
 * The replacement belongs to an ENCAPSULATED instance — the child `modules/payments/webhook.ts`
 * registers for `POST /v1/webhooks/stripe` — and must never be registered on the instance
 * `app.ts` builds. Fastify clones the content-type-parser table into every child context, so a
 * parser added inside the child serves that route alone; on the root it would hold the raw bytes of
 * every request in the process's memory and replace the parser every other route relies on.
 *
 * Nothing here logs a body: an event payload is customer data, and the failure below answers a
 * fixed sentence rather than a parser message that could quote what was sent.
 */
import { AppError } from './errors.ts';

import type { FastifyBodyParser, FastifyInstance } from 'fastify';

// Type-only, so nothing of `app.ts` is read at run time and no import cycle reaches the root.
import type { App } from '../app.ts';

/**
 * The bytes this request was received with, verbatim, for the routes that verify a signature over
 * them. Set by {@link registerRawJsonBody} and left undefined on every other route, because only a
 * context that registered the parser below ever has it set.
 */
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/** The answer for a body that is not JSON at all, including an empty one. */
const INVALID_JSON_MESSAGE = 'Body is not valid JSON.';

/**
 * The two methods this module calls, taken from the instance type. A union of instance types cannot
 * call `addContentTypeParser` itself: it is overloaded, TypeScript synthesizes the union's
 * signatures and matches the `{ bodyLimit }` overload first, and `parseAs` is then rejected as an
 * unknown property. Both members of the union below do satisfy this narrower type.
 */
type RawBodyInstance = Pick<FastifyInstance, 'addContentTypeParser' | 'removeContentTypeParser'>;

/**
 * The parser itself, typed as the buffer variant `FastifyBodyParser<Buffer>`: that annotation is
 * what selects Fastify's `parseAs: 'buffer'` overload for the call below, and it is why `body`
 * arrives as the received `Buffer` rather than as a decoded string.
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
 * Registers a JSON parser on `ctx` that keeps the received bytes on `request.rawBody` and parses
 * the body as Fastify's own parser does (AAP 0.5.1).
 *
 * Synchronous, and called while the webhook plugin is being registered, before its routes are
 * declared: `addContentTypeParser` throws once the instance has started. `ctx` is the encapsulated
 * child that plugin creates, as above.
 *
 * The parser takes no `bodyLimit`, so the route's own limit applies — the default 1 MiB from
 * `app.ts`, far above any event Stripe sends, and unchanged here. It matches
 * `application/json; charset=utf-8` too: Fastify compares a header's media type once a full match
 * with its parameters fails.
 *
 * A body that is empty or not JSON at all is refused with `invalid_field` (400) — the code the error
 * plugin gives Fastify's own JSON-parser refusals — before the route runs, so the signature check
 * never sees that body. The bytes are set on the request before parsing, so a failure inside a later
 * hook or handler still leaves them available.
 */
export function registerRawJsonBody(ctx: App | FastifyInstance): void {
  const instance: RawBodyInstance = ctx;
  // A child inherits the root's parser for this media type, and a second parser for a type that
  // already has one can be refused, so the inherited parser is removed first. Removal in a child
  // context leaves the root's table untouched.
  instance.removeContentTypeParser('application/json');
  instance.addContentTypeParser('application/json', { parseAs: 'buffer' }, rawJsonParser);
}
