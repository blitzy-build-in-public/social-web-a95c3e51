/**
 * OpenAPI document generation for the API (AAP 0.4.1, 0.5.1, 0.8.1, 0.11.2).
 *
 * Every route is described by the Zod schema it validates its request with and serializes its
 * response through, so the emitted document cannot drift from the contract the code enforces. It is
 * produced once, by `apps/api/scripts/emit-openapi.ts`, which calls `app.swagger()` after `ready()`
 * and writes `docs/api/openapi.json`; no route serves it, and Swagger UI is not mounted (AAP 0.8.1).
 *
 * Three invariants hold for the registration below:
 *
 * - `@fastify/swagger` collects routes through an `onRoute` hook, so `app.ts` must call
 *   {@link registerOpenApi} before it registers any route plugin, and every route must be declared
 *   inside a plugin registered after this call. Fastify loads the queued swagger plugin only at
 *   `ready()`, so a route declared on the root instance — before this call or after it — is emitted
 *   nowhere.
 * - The declared OpenAPI version is what the Zod transform reads to pick its JSON Schema dialect
 *   (`getJSONSchemaTarget`): `3.0.3` selects the `openapi-3.0` output, which writes a nullable value
 *   as `nullable: true` and a single-value enum as `enum`, instead of the JSON Schema 2020-12 forms
 *   an OpenAPI 3.0 document may not carry.
 * - A route that must stay out of the document sets `schema.hide` — the ConversationRelay socket
 *   `WS /v1/webhooks/voice/relay`, and the test-control routes that exist only when
 *   `APP_ENV=test` (AAP 0.5.4) — and nothing registered here carries a timestamp, a random id or the
 *   environment it ran in, so two emits of the same tree are byte-identical.
 */

import swagger from '@fastify/swagger';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

import { LODGING_SECRET_HEADER, VENUE_SECRET_HEADER } from '@tablemate/shared';

import type { ApiEnv } from '@tablemate/server-core';

// Type-only, and taken from the module that builds the instance rather than from this file's
// dependency whitelist: `App` is the plan's one declaration of the app's type, it is erased at
// compile time, and nothing of `app.ts` is read at runtime (the same import the sibling plugins
// `errors.ts`, `raw-body.ts` and `websocket.ts` take).
import type { App } from '../app.ts';

/**
 * The tag every route groups under, in the order the document lists them. A route names one through
 * `schema.tags`, which is what keeps the emitted operations grouped the way `docs/api/README.md`
 * indexes them (AAP 0.11.2); an untagged route still appears, under no tag. The order below is
 * document order, so it is also the order a reader meets the API in: the public and account routes
 * first, the partner consoles and the operator area next, and the provider callbacks after them.
 */
export const OPENAPI_TAGS = [
  'health',
  'auth',
  'me',
  'users',
  'proofs',
  'cities',
  'meetups',
  'payments',
  'consoles',
  'messaging',
  'analytics',
  'suggestions',
  'lodgings',
  'admin',
  'webhooks',
  'test',
] as const;

/** One tag a route may group under: a member of {@link OPENAPI_TAGS}. */
export type OpenApiTag = (typeof OPENAPI_TAGS)[number];

/**
 * The `security` requirement a route declares, one entry per authentication mode the API has
 * (AAP 0.3.3): `bearer` for the traveler and operator routes that carry the 15-minute access token,
 * and the two console schemes, whose secret a route reads from the header named beside it. Route
 * schemas set `security: OPENAPI_SECURITY.bearer` and so on; a public route, a webhook and a health
 * check declare no `security` at all, which is what marks them as open in the document.
 *
 * The two header names are the constants the console handlers read, so the document and the code
 * cannot disagree about where a secret travels.
 */
export const OPENAPI_SECURITY = {
  bearer: [{ bearer: [] }],
  venueSecret: [{ venueSecret: [] }],
  lodgingSecret: [{ lodgingSecret: [] }],
} as const;

/**
 * Registers the OpenAPI generator on `app` (AAP 0.4.1, 0.5.1).
 *
 * Synchronous, so the composition root keeps its synchronous `buildApp` contract: the registration
 * is queued on the instance and the plugin is loaded during `ready()`. It must therefore run before
 * any route plugin is registered, as the header of this file sets out.
 *
 * The single server is the API's public URL — what a client calls, never the address the process
 * listens on — and the three security schemes are the ones {@link OPENAPI_SECURITY} names. The
 * description points a reader at `docs/api/README.md`, where the routes and error codes the pilot
 * adds to the contract are listed as additions (AAP 0.5.4).
 *
 * @param app - the instance being built; the document is read back from it with `app.swagger()`.
 * @param env - the loaded environment, for the public URL the document advertises.
 */
export function registerOpenApi(app: App, env: Pick<ApiEnv, 'API_PUBLIC_URL'>): void {
  app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Tablemate API',
        version: '0.1.0',
        description:
          'Additive routes and error codes are marked in docs/api/README.md. ' +
          'Errors use the { error: { code, message } } envelope.',
      },
      servers: [{ url: env.API_PUBLIC_URL }],
      tags: OPENAPI_TAGS.map((name) => ({ name })),
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          venueSecret: { type: 'apiKey', in: 'header', name: VENUE_SECRET_HEADER },
          lodgingSecret: { type: 'apiKey', in: 'header', name: LODGING_SECRET_HEADER },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
}
