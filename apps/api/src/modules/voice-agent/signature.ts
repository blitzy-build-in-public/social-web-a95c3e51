/**
 * The Twilio request-signature check every voice route runs before it does anything else
 * (AAP 0.3.3, 0.8.1).
 *
 * A voice callback carries no user and no bearer token, so `X-Twilio-Signature` is the only thing
 * that authenticates it: an HMAC over the exact URL Twilio called and every form field it posted,
 * keyed by the auth token (AAP 0.3.3). The URL is as load-bearing as the fields, because the check
 * recomputes that HMAC over the string it is handed — a URL rebuilt from the internal host
 * (`request.host`, `request.protocol`, `X-Forwarded-*`) can never match one Twilio computed for the
 * address it dialled. It is therefore built the way the dispatcher built the URL it gave Twilio:
 * `API_PUBLIC_URL` plus Fastify's raw request target, path and query together
 * ({@link publicHttpUrl}), and the same public base with the `ws`/`wss` scheme for the
 * ConversationRelay upgrade ({@link publicRelayUrl}).
 *
 * The fields are checked over the raw parsed body, before the route's Zod schema sees it: the shared
 * callback schemas are `z.looseObject` and coerce some numbers, so a field they dropped or rewrote
 * would no longer match the bytes Twilio signed ({@link formParams}).
 *
 * A refusal is a plain `AppError('bad_signature')` (400) thrown from a hook, so it is answered
 * through the shared error envelope — on the relay route before the connection is upgraded
 * ({@link twilioSignatureHook}) — and it stops the route before any provider work, any call-attempt
 * lookup and any dialogue. What a refusal logs is a fixed event and the surface it came from, never
 * the header, the query, the body, a URL or a phone number (AAP 0.11.1).
 *
 * No `twilio` import: `TelephonyClient.validateSignature` is the one seam that reaches them
 * (AAP 0.11.1), and in `simulator` mode that client is built with the simulator's public auth token,
 * so nothing here branches on the telephony mode.
 *
 * @see AAP 0.3.2 for call dispatch and reconciliation, 0.3.3 for the Twilio integration row,
 * 0.5.6 for the dialogue, 0.6.2 for `TELEPHONY_MODE` and the credentials each mode takes.
 */

import { TWILIO_SIGNATURE_HEADER } from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';

import type { FastifyRequest, preValidationAsyncHookHandler } from 'fastify';

import type { ApiEnv } from '@tablemate/server-core';

import type { AppServices } from '../../app.ts';

/**
 * The two surfaces a Twilio signature is checked on (AAP 0.3.3): the HTTP callbacks
 * (`POST /v1/webhooks/voice/twiml` and `POST /v1/webhooks/voice`), whose signed URL carries the
 * attempt id as a query string and whose fields are part of the signature, and the relay upgrade
 * (`WS /v1/webhooks/voice/relay`), signed over its URL alone.
 */
export type TwilioSignatureKind = 'http' | 'ws';

/**
 * The relay socket's path. It is the one voice URL with no query string: the attempt id travels as a
 * ConversationRelay `<Parameter>` inside the TwiML, so the signed upgrade URL is exactly the value
 * built from this path — which is why `modules/voice-agent/twiml.ts` writes that same value into the
 * TwiML's `url` attribute rather than spelling one of its own (AAP 0.3.2).
 */
const RELAY_PATH = '/v1/webhooks/voice/relay';

/**
 * The header name Fastify's parsed headers are keyed by: it lowercases incoming header names, so the
 * shared constant's spelling is not what a lookup finds (AAP 0.3.3).
 */
const SIGNATURE_HEADER = TWILIO_SIGNATURE_HEADER.toLowerCase();

/**
 * One posted form field as `@fastify/formbody` parses it: every value is a string, and a repeated key
 * arrives as that key's entries. Anything else is not a form field and is left out.
 */
type FormField = string | readonly string[] | number | boolean | undefined;

/** Whether a field arrived as a repeated key's entries rather than as one value. */
function isRepeated(field: FormField): field is readonly string[] {
  return Array.isArray(field);
}

/**
 * The public address Twilio called, for the two HTTP callbacks (AAP 0.3.3).
 *
 * `API_PUBLIC_URL` is the base the dispatcher gave Twilio (`workers` builds the TwiML and
 * status-callback URLs from the same variable), and `request.url` is Fastify's raw request target —
 * the path and the query string exactly as received, attempt id included. Both are concatenated as
 * strings, so a base carrying a reverse-proxy prefix keeps it, and trailing slashes are dropped from
 * the base alone so that a base written with one does not double it.
 */
export function publicHttpUrl(env: ApiEnv, request: FastifyRequest): string {
  return `${publicBaseUrl(env.API_PUBLIC_URL)}${request.url}`;
}

/**
 * The URL Twilio signed when it opened the ConversationRelay socket (AAP 0.3.3).
 *
 * The same public base with the HTTP scheme mapped to the WebSocket one — `https:` to `wss:` in
 * every deployed environment, `http:` to `ws:` on the local and simulator stacks — and the relay
 * path with no query string.
 */
export function publicRelayUrl(env: ApiEnv): string {
  const base = publicBaseUrl(env.API_PUBLIC_URL);
  // The env schema validates `API_PUBLIC_URL` as an http(s) URL, so a scheme separator is present;
  // a base without one is treated as an authority and mapped to the plain scheme.
  const separator = base.indexOf('://');
  const authority = separator === -1 ? base : base.slice(separator + 3);
  return `${base.startsWith('https:') ? 'wss:' : 'ws:'}//${authority}${RELAY_PATH}`;
}

/**
 * Every field Twilio posted, as the string map the signature covers (AAP 0.3.3).
 *
 * This runs over the raw parsed body rather than the validated one on purpose: the signature covers
 * all the fields Twilio sent, while a route's schema keeps only the ones it declares and coerces
 * some of them, so validating first would hand the check a different set of values. A repeated key —
 * which Twilio never sends — contributes its first entry, and a value that is not a form value is
 * skipped rather than stringified into a signature that could then match by accident.
 */
export function formParams(body: unknown): Record<string, string> {
  const params: Record<string, string> = {};
  if (typeof body !== 'object' || body === null) return params;

  // The parser's own output shape: untyped input, read field by field and never spread.
  for (const [key, field] of Object.entries(body as Record<string, FormField>)) {
    if (typeof field === 'string') {
      params[key] = field;
    } else if (typeof field === 'number' || typeof field === 'boolean') {
      params[key] = String(field);
    } else if (isRepeated(field)) {
      const [first] = field;
      if (first !== undefined) params[key] = first;
    }
  }
  return params;
}

/**
 * Check a voice request's `X-Twilio-Signature`, or throw `bad_signature` (AAP 0.3.3).
 *
 * The three refusals, in the order they are checked. A process with no telephony client
 * (`TELEPHONY_MODE=off`, AAP 0.6.2) serves no voice traffic at all, and a client that cannot validate
 * a signature is not a reason to accept an unauthenticated callback. A missing or empty header is
 * refused before anything is computed. Otherwise the client recomputes the HMAC over the public URL
 * and the posted fields, and a mismatch is refused.
 *
 * @param services - the app's injected services: the validated `api` configuration, and the telephony
 *   client, which is `null` in `off` mode.
 * @param request - the request to authenticate; its parsed body is read only for `kind === 'http'`.
 * @param kind - the surface, which decides both the signed URL and whether fields are covered.
 * @throws AppError `bad_signature` (400) on every refusal.
 */
export function assertTwilioSignature(
  services: AppServices,
  request: FastifyRequest,
  kind: TwilioSignatureKind,
): void {
  const telephony = services.telephony;
  if (telephony === null) {
    refuseSignature(request, kind);
  }

  const signature = signatureHeader(request);
  if (signature === undefined) {
    refuseSignature(request, kind);
  }

  const accepted =
    kind === 'http'
      ? telephony.validateSignature(
          signature,
          publicHttpUrl(services.env, request),
          formParams(request.body),
        )
      : telephony.validateSignature(signature, publicRelayUrl(services.env), {});

  if (!accepted) {
    refuseSignature(request, kind);
  }
}

/**
 * The hook a voice route registers (AAP 0.3.3).
 *
 * On the two HTTP callbacks it goes on `preValidation`, where the body is parsed but no schema has
 * run yet: a bad signature is then answered `400 bad_signature` rather than as whichever schema error
 * the payload happens to raise. On the relay route it goes on `preValidation`/`onRequest`, both of
 * which `@fastify/websocket` runs before it hijacks the connection, so the refusal is a plain HTTP
 * 400 on a socket Twilio never gets.
 *
 * The hook is asynchronous — it returns a promise Fastify settles before it runs the route, so the
 * refusal reaches the error handler as a settled promise exactly as an awaited one would, and it
 * opens no route handler on the way. The body itself awaits nothing: the check is synchronous, which
 * is why the promise is returned rather than the function being declared `async`.
 */
export function twilioSignatureHook(kind: TwilioSignatureKind): preValidationAsyncHookHandler {
  return (request) => {
    assertTwilioSignature(request.server.services, request, kind);
    return Promise.resolve();
  };
}

/** The public base address without trailing slashes, so a concatenation never doubles one. */
function publicBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * The signature Twilio sent, or `undefined` when the header is absent, empty or unusable. The value
 * is never logged, and never carried past this function (AAP 0.11.1).
 */
function signatureHeader(request: FastifyRequest): string | undefined {
  const header = request.headers[SIGNATURE_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Record the refusal and throw it. The log line names the event and the surface and nothing else:
 * the signature, the URL and its query, the posted fields, `To`/`From` and every other phone number
 * stay out of it (AAP 0.11.1).
 */
function refuseSignature(request: FastifyRequest, kind: TwilioSignatureKind): never {
  request.log.warn({ event: 'twilio_bad_signature', kind }, 'twilio_bad_signature');
  throw new AppError('bad_signature');
}
