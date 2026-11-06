/**
 * The injected clock and the instant each request is stamped with (AAP 0.5.1, 0.11.1).
 *
 * AAP 0.11.1 makes time an injected dependency: "Time comes from the injected clock, never
 * `Date.now()` directly, so tests can advance it." The criterion tests have to cross the 45-minute
 * check-in window, the 24-hour booking-detail erasure limit and the 30-day anti-farming rule, and
 * `POST /v1/test/clock` (AAP 0.5.4) moves the very instance the API was built with. Every server
 * module therefore takes a `Clock` from `packages/server-core` and asks it for the time, which is
 * what lets the root eslint configuration ban `Date.now()` and argument-less `new Date()` across
 * `apps/api/src`, `apps/workers/src`, `packages/server-core/src` and `packages/db` (AAP 0.11.1).
 *
 * Handlers that need "now" read `request.receivedAt`, set once per request by the hook below, so
 * every window check inside one handler — the check-in window, the `startsAt − 2 h` cancellation
 * boundary, suggestion eligibility, a dispute deadline — is measured from one instant rather than
 * from several reads that could straddle that boundary (AAP 0.5.3, 0.5.7). Background code that
 * runs outside a request (the settlement sweeper, the outbox dispatcher, the timer scheduler) reads
 * `services.clock` instead. The `Date` each read returns is a new instance, so no caller can move
 * the clock another caller reads.
 *
 * `registerClock` is called first by `app.ts`, on the root instance, before the error, security,
 * auth, rate-limit, WebSocket and OpenAPI plugins and before any route: `decorate` and
 * `decorateRequest` throw once an instance has started, and a hook registered on the root runs for
 * every route its children declare.
 */

import type { Clock } from '@tablemate/server-core';

// Type-only, and taken from the module that builds the instance rather than from this file's
// dependency whitelist: `App` is the plan's one declaration of the app's type, it is erased at
// compile time, and nothing of `app.ts` is read at runtime (the same import the sibling plugins
// `errors.ts`, `raw-body.ts` and `websocket.ts` take).
import type { App } from '../app.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** The clock this instance was built with: `systemClock`, or the test clock a test injected. */
    clock: Clock;
  }

  interface FastifyRequest {
    /**
     * When this request arrived, from {@link FastifyInstance.clock}. Set by the root `onRequest`
     * hook {@link registerClock} installs, so it is present in every hook and handler after it.
     */
    receivedAt: Date;
  }
}

/**
 * Registers the injected clock on the instance `app.ts` builds (AAP 0.5.1, AAP 0.11.1).
 *
 * Synchronous, because `buildApp` is: the decorations and the hook are installed while the app is
 * being composed, and callers `await app.ready()` before serving.
 *
 * @param app - the root instance; the hook is added to it, so every encapsulated module inherits it.
 * @param clock - the time source every handler and job of this process reads, from `buildApp`'s
 * dependencies, defaulting to `systemClock` and replaced by a test clock in `APP_ENV=test`.
 */
export function registerClock(app: App, clock: Clock): void {
  app.decorate('clock', clock);

  // `null` is the value every request starts from — Fastify 5 accepts it here and applies it in its
  // request constructor, so each request has the same shape — and it is never read: the hook below
  // replaces it before anything that runs after `onRequest` can.
  app.decorateRequest('receivedAt', null as unknown as Date);

  app.addHook('onRequest', (request, _reply, done) => {
    request.receivedAt = clock.now();
    done();
  });
}
