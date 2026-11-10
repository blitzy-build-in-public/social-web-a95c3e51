/**
 * The injected clock and the instant each request is stamped with.
 *
 * Time is injected — the root eslint configuration bans `Date.now()` and argument-less `new Date()` in `apps/api/src`
 * — and the criterion tests have to cross the 45-minute check-in window, the 24-hour booking-detail erasure limit and
 * the 30-day anti-farming rule, so `POST /v1/test/clock` moves the very instance the API was built with.
 *
 * Handlers read `request.receivedAt`, set once per request by the hook below, so every window check inside one handler
 * is measured from one instant rather than from several reads that could straddle that boundary. Background code reads
 * `services.clock`. `registerClock` is called first by `app.ts`, because `decorate` and `decorateRequest` throw once an
 * instance has started.
 */
import type { Clock } from '@tablemate/server-core';

import type { App } from '../app.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** The clock this instance was built with: `systemClock`, or the test clock a test injected. */
    clock: Clock;
  }
  interface FastifyRequest {
    /** When this request arrived, stamped by the root `onRequest` hook {@link registerClock} installs. */
    receivedAt: Date;
  }
}

/**
 * What `receivedAt` holds before the hook below replaces it. `null` and not a `Date`, because Fastify refuses a
 * reference type as a request decorator's initial value (`FST_ERR_DEC_REFERENCE_TYPE`) — one `Date` instance would be
 * shared by every request — and the assertion is what reconciles that with the augmentation above.
 */
const UNSET_RECEIVED_AT: Date = null as unknown as Date;

/**
 * Registers the injected clock on the instance `app.ts` builds. Synchronous, because `buildApp` is: the decorations
 * and the hook are installed while the app is composed, and callers `await app.ready()` before serving.
 */
export function registerClock(app: App, clock: Clock): void {
  app.decorate('clock', clock);
  // Every request starts from `null` and never reads it: the hook below replaces it before anything
  // that runs after `onRequest` can.
  app.decorateRequest('receivedAt', UNSET_RECEIVED_AT);
  app.addHook('onRequest', (request, _reply, done) => {
    request.receivedAt = clock.now();
    done();
  });
}
