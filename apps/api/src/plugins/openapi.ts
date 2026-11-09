/**
 * OpenAPI document generation for the API.
 *
 * Every route is described by the Zod schema it validates its request with and serializes its response through, so the
 * emitted document cannot drift from the contract the code enforces. It is produced once, by
 * `apps/api/scripts/emit-openapi.ts`, which writes `docs/api/openapi.json`; no route serves it.
 *
 * Two invariants hold for the registration below. `@fastify/swagger` collects routes through an `onRoute` hook, so
 * `app.ts` must call {@link registerOpenApi} before it registers any route plugin — and a route that must stay out of
 * the document sets `schema.hide`. The declared OpenAPI version is what the Zod transform reads to pick its JSON Schema
 * dialect: `3.0.3` selects the `openapi-3.0` output, which writes a nullable value as `nullable: true` rather than the
 * JSON Schema 2020-12 forms an OpenAPI 3.0 document may not carry. Nothing registered here carries a timestamp, a
 * random id or the environment it ran in, so two emits of the same tree are byte-identical.
 */
import swagger from '@fastify/swagger';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

import { LODGING_SECRET_HEADER, VENUE_SECRET_HEADER } from '@tablemate/shared';

import type { ApiEnv } from '@tablemate/server-core';

// Type-only, so nothing of `app.ts` is read at run time and no import cycle reaches the root.
import type { App } from '../app.ts';

/**
 * The tag every route groups under, in the order the document lists them. A route names one through `schema.tags`,
 * which keeps the emitted operations grouped the way `docs/api/README.md` indexes them; an untagged route still
 * appears, under no tag. The order below is document order: the public and account routes first, the partner consoles
 * and the operator area next, and the provider callbacks after them.
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

export type OpenApiTag = (typeof OPENAPI_TAGS)[number];

/**
 * The `security` requirement a route declares: `bearer` for the traveler and operator routes that carry the
 * 15-minute access token, and the two console schemes, whose secret a route reads from the header named beside it. A
 * public route, a webhook and a health check declare no `security` at all, which is what marks them as open in the
 * document. The two header names are the constants the console handlers read, so the document and the code cannot
 * disagree about where a secret travels.
 */
export const OPENAPI_SECURITY = {
  bearer: [{ bearer: [] }],
  venueSecret: [{ venueSecret: [] }],
  lodgingSecret: [{ lodgingSecret: [] }],
} as const;

/**
 * Registers the OpenAPI generator on `app`. Synchronous, so the composition root keeps its synchronous `buildApp`
 * contract — the registration is queued on the instance and loaded during `ready()` — and it must therefore run
 * before any route plugin is registered, as the header of this file sets out.
 *
 * The single server is the API's public URL — what a client calls, never the address the process listens on — and the
 * description points a reader at `docs/api/README.md`, which lists the routes and error codes the pilot adds to the
 * contract as additions.
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
