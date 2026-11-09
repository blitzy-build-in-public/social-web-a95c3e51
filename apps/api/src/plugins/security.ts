/**
 * Security headers and cross-origin access for the API.
 *
 * Two registrations on the root instance, queued rather than awaited: `buildApp` is synchronous and Fastify applies a queued plugin
 * during `ready()`. Both plugins are wrapped in `fastify-plugin`, so registering them here reaches every encapsulated route module —
 * no route opts out, and none may.
 *
 * `@fastify/helmet` writes the transport and browser-hardening headers on every answer; its defaults are kept, and only the three that
 * would break this instance are changed: `contentSecurityPolicy` is off, because this instance answers JSON and the two WebSocket
 * upgrades and never serves HTML, so the strict policy belongs to the pages nginx serves (`infra/nginx/*.conf`);
 * `cross-origin-resource-policy` is `cross-origin`, because the web client on `WEB_ORIGIN` renders the profile photo of
 * `GET /v1/users/:userId/photo` and helmet's `same-origin` default would make the browser discard that response — what protects the
 * photo is the route's disclosure tier, which answers `404` below tier 2; and `crossOriginEmbedderPolicy` is off for the same reason.
 *
 * `@fastify/cors` publishes the allowlist the two browser clients are held to: the two origins are compared as the exact strings the
 * environment validated, with no wildcard and no pattern, so a request from any other origin is served without CORS headers and the
 * browser withholds the response. Credentials stay off because authentication travels in the `Authorization` header and the console
 * secrets in their own headers — no cookie, and therefore no ambient authority a cross-origin page could ride on.
 *
 * `Date` is the one response header exposed, and it has to be: it is not a CORS-safelisted response header, so without this the venue
 * console could not read the server clock. Nothing else is exposed — a 429's `Retry-After` deliberately stays unreadable.
 */
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';

import { LODGING_SECRET_HEADER, VENUE_SECRET_HEADER } from '@tablemate/shared';

import type { ApiEnv } from '@tablemate/server-core';

// Type-only, so nothing of `app.ts` is read at run time and no import cycle reaches the root.
import type { App } from '../app.ts';

/**
 * The methods the clients use, and the whole set a preflight may approve: `GET` for every read, `POST` for proposals, check-ins,
 * reports and analytics, `PUT` for the profile and the lodging visibility toggle, `PATCH` for the operator's edits, and `DELETE` for
 * claims and account deletion.
 */
const ALLOWED_METHODS: string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * The headers a browser may send cross-origin: the bearer token, a JSON body's content type, and the two console secrets, which are
 * the only headers that carry a credential outside `Authorization`. Header names are case-insensitive in CORS matching.
 */
const ALLOWED_REQUEST_HEADERS: string[] = [
  'Authorization',
  'Content-Type',
  VENUE_SECRET_HEADER,
  LODGING_SECRET_HEADER,
];

/**
 * How long a browser may reuse one preflight answer, in seconds: ten minutes, so a console polling the code each minute still
 * refetches the answer, and a change to the allowlist is never cached far beyond the process that published it.
 */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/** The only response header a browser client is allowed to read: the venue console derives the server clock from `Date`, and no other
 * header is exposed. */
const EXPOSED_RESPONSE_HEADERS: string[] = ['Date'];

/**
 * Registers the security headers and the CORS allowlist on the root app.
 *
 * Called while the app is being built, before any route is declared, and synchronous: the two registrations are queued and applied in
 * the order below during `ready()`, so every route — the console routes, the webhook routes the providers call server-to-server, and
 * the WebSocket upgrades — is covered by the time it can receive a request. A provider's call carries no `Origin`, so CORS neither
 * blocks nor is needed for it.
 *
 * The origins come from the validated environment and are used exactly as loaded; nothing here normalizes them or adds a default.
 */
export function registerSecurity(
  app: App,
  env: Pick<ApiEnv, 'WEB_ORIGIN' | 'VENUE_CONSOLE_ORIGIN'>,
): void {
  app.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
  });
  app.register(cors, {
    origin: [env.WEB_ORIGIN, env.VENUE_CONSOLE_ORIGIN],
    methods: ALLOWED_METHODS,
    allowedHeaders: ALLOWED_REQUEST_HEADERS,
    exposedHeaders: EXPOSED_RESPONSE_HEADERS,
    credentials: false,
    maxAge: PREFLIGHT_MAX_AGE_SECONDS,
  });
}
