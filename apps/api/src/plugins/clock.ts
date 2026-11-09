/**
 * The injected clock and the instant each request is stamped with (AAP 0.5.1, 0.11.1).
 *
 * AAP 0.11.1 makes time an injected dependency: "Time comes from the injected clock, never `Date.now()`
 * directly, so tests can advance it." The criterion tests have to cross the 45-minute check-in window, the
 * 24-hour booking-detail erasure limit and the 30-day anti-farming rule, and `POST /v1/test/clock` moves the very
 * instance the API was built with. Every server module therefore takes a `Clock` from `packages/server-core`,
 * which is what lets the root eslint configuration ban `Date.now()` and argument-less `new Date()` across
 * `apps/api/src`, `apps/workers/src`, `packages/server-core/src` and `packages/db`.
 *
 * Handlers that need "now" read `request.receivedAt`, set once per request by the hook below, so every window
 * check inside one handler is measured from one instant rather than from several reads that could straddle that
 * boundary (AAP 0.5.3, 0.5.7). Background code that runs outside a request reads `services.clock` instead.
 * `registerClock` is called first by `app.ts`, before every other plugin and any route, because `decorate` and
 * `decorateRequest` throw once an instance has started.
 */
import type { Clock } from '@tablemate/server-core';

// Type-only, so nothing of `app.ts` is read at run time and no import cycle reaches the root.
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
 * What a request's `receivedAt` holds before the hook below replaces it: `null`, under the `Date`
 * the augmentation declares.
 *
 * `null` and not a `Date`, because Fastify refuses a reference type as a request decorator's
 * initial value (`FST_ERR_DEC_REFERENCE_TYPE`): one `Date` instance would be shared by every
 * request. The assertion is what reconciles that with the augmentation, and it is written on a
 * named constant rather than inline so it stands for a value rather than for the call it is
 * passed to.
 */
const UNSET_RECEIVED_AT: Date = null as unknown as Date;

/**
 * Registers the injected clock on the instance `app.ts` builds (AAP 0.5.1, AAP 0.11.1).
 *
 * Synchronous, because `buildApp` is: the decorations and the hook are installed while the app is
 * being composed, and callers `await app.ready()` before serving.
 */
export function registerClock(app: App, clock: Clock): void {
  app.decorate('clock', clock);
  // `null` is the value every request starts from — Fastify 5 accepts it here and applies it in its
  // request constructor, so each request has the same shape — and it is never read: the hook below
  // replaces it before anything that runs after `onRequest` can.
  app.decorateRequest('receivedAt', UNSET_RECEIVED_AT);
  app.addHook('onRequest', (request, _reply, done) => {
    request.receivedAt = clock.now();
    done();
  });
}
