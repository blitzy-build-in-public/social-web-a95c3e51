/**
 * Security headers and cross-origin access for the API (AAP 0.3.2, 0.5.1, 0.8.1).
 *
 * Two registrations on the root instance, queued rather than awaited: `buildApp` is synchronous and
 * Fastify applies a queued plugin during `ready()`. Both plugins are wrapped in `fastify-plugin`, so
 * registering them here reaches every encapsulated route module — no route opts out, and none may.
 *
 * `@fastify/helmet` writes the transport and browser-hardening headers on every answer. Its defaults
 * are kept — `strict-transport-security`, `x-content-type-options: nosniff`, `referrer-policy` and
 * `x-frame-options` among them — and only the two that would break this instance are changed:
 *
 * - `contentSecurityPolicy` is off. This instance answers JSON and the two WebSocket upgrades and
 *   never serves HTML, so a policy here would protect no document; the strict policy the request
 *   requires belongs to the pages nginx serves (`infra/nginx/*.conf`), which is where it lives.
 * - `cross-origin-resource-policy` is `cross-origin`. The web client on `WEB_ORIGIN` renders the
 *   profile photo of `GET /v1/users/:userId/photo`, and helmet's `same-origin` default would make the
 *   browser discard that response. What protects the photo is the route's disclosure tier, which
 *   answers `404` below tier 2 (AAP 0.5.4), not this header.
 * - `crossOriginEmbedderPolicy` is off for the same reason: `require-corp` on a JSON API refuses
 *   nothing a client wants and would demand CORP-aware answers from every consumer.
 *
 * `@fastify/cors` publishes the allowlist the two browser clients are held to (AAP 0.3.2). The two
 * origins are compared as the exact strings the environment validated, with no wildcard and no
 * pattern: a request from any other origin is served without CORS headers, so the browser withholds
 * the response. Credentials stay off because authentication travels in the `Authorization` header and
 * the console secrets travel in their own headers — no cookie, and therefore no ambient authority a
 * cross-origin page could ride on. The methods and request headers are the ones the clients actually
 * use and nothing more.
 *
 * `Date` is the one response header exposed, and it has to be: it is not a CORS-safelisted response
 * header, so without this the venue console could not read the server clock. Its countdown is
 * measured from the offset between that header and the device clock (AAP 0.5.1, 0.12.2), which is what
 * keeps a skewed device from displaying a code the server will not accept. Nothing else is exposed —
 * a 429's `Retry-After` deliberately stays unreadable, so callers treat it as an optional hint
 * (`apps/mobile/src/api/errors.ts`).
 *
 * Side-effect free at import: this module registers nothing until `registerSecurity` is called, so a
 * script that builds no app pays nothing for it.
 */
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';

import { LODGING_SECRET_HEADER, VENUE_SECRET_HEADER } from '@tablemate/shared';

import type { ApiEnv } from '@tablemate/server-core';

// Type-only, so nothing of `app.ts` is read at run time and no import cycle reaches the root.
import type { App } from '../app.ts';

/**
 * The methods the clients use, and the whole set a preflight may approve: `GET` for every read,
 * `POST` for proposals, check-ins, reports and analytics, `PUT` for the profile and the lodging
 * visibility toggle, `PATCH` for the operator's venue, crawl-domain and dispute edits, and `DELETE`
 * for claims and account deletion (AAP 0.5.4).
 */
const ALLOWED_METHODS: string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * The headers a browser may send cross-origin: the bearer token, a JSON body's content type, and the
 * two console secrets, which are the only headers that carry a credential outside `Authorization`
 * (AAP 0.3.3, 0.5.4). Header names are case-insensitive in CORS matching, so a client that sends
 * `x-venue-secret` is covered by the name as written here.
 */
const ALLOWED_REQUEST_HEADERS: string[] = [
  'Authorization',
  'Content-Type',
  VENUE_SECRET_HEADER,
  LODGING_SECRET_HEADER,
];

/**
 * How long a browser may reuse one preflight answer, in seconds (`Access-Control-Max-Age`): ten
 * minutes, so a console polling the code each minute still refetches the answer, and a change to the
 * allowlist is never cached far beyond the process that published it.
 */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * The only response header a browser client is allowed to read, with the invariant that makes it
 * necessary stated once above: the venue console derives the server clock from `Date`, and no other
 * header is exposed (AAP 0.3.2, 0.5.1).
 */
const EXPOSED_RESPONSE_HEADERS: string[] = ['Date'];

/**
 * Registers the security headers and the CORS allowlist on the root app (AAP 0.5.1).
 *
 * Called while the app is being built, before any route is declared, and synchronous: the two
 * registrations are queued and applied in the order below during `ready()`, so every route — the
 * console routes, the webhook routes the providers call server-to-server, and the WebSocket upgrades
 * — is covered by the time it can receive a request. A provider's server-to-server call carries no
 * `Origin`, so CORS neither blocks nor is needed for it.
 *
 * The origins come from the validated environment and are used exactly as loaded; nothing here
 * normalizes them or adds a default. `env` is taken as the two fields this function reads, so a
 * caller passes the loaded configuration itself.
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
