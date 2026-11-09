/**
 * Test control: the clock route and the settlement route the suites drive (AAP 0.5.1, 0.5.4).
 *
 *  - `POST /v1/test/clock` moves the clock the app was built with, so a criterion test can cross the 45-minute
 *    check-in window, the 24-hour booking-detail erasure limit and the 30-day anti-farming rule instead of waiting
 *    for them. It moves the very `Clock` instance `plugins/clock.ts` decorates the instance with, which is the
 *    reason every module asks that clock for the time rather than reading `Date.now()` (AAP 0.11.1).
 *  - `POST /v1/test/run-settlement` settles the meetup a caller names, or sweeps when it names none, and then
 *    carries out what that settlement planned: a settlement only *plans* the provider calls it decides, so without
 *    this step a suite that had just moved the clock would read a meetup settled while its money stayed pending.
 *
 * What a jump moves is the server's clock alone. A delayed BullMQ job fires on Redis' own wall-clock time, and
 * `settle-<meetupId>`, `lapse-<meetupId>` and `remind-<meetupId>` are scheduled against it, so a jump never makes
 * them fire early: settlement after a jump is driven through `POST /v1/test/run-settlement`, whose sweeper judges
 * "overdue" by `services.clock` (AAP 0.3.2, 0.5.6). The 15-minute access token and the 30-second session cache are
 * judged by that same clock, so a jump past 15 minutes expires the caller's own access token.
 *
 * Both routes exist only in `APP_ENV=test` with `TEST_CONTROL_TOKEN` set (AAP 0.5.1, 0.6.2). The composition root
 * registers this plugin only when both hold, and {@link testControlRoutes} refuses to register at all otherwise:
 * defence in depth, because the environment schema already refuses to start a process outside `test` that sets
 * that variable.
 *
 * The credential is a header rather than a session, because these routes are driven by test harnesses that hold no
 * account, and the token is compared with `timingSafeEqualString`. A request without a usable header — absent,
 * repeated or wrong — is answered exactly as a request with a wrong one is: `404 not_found`, never `401`, so a
 * probe cannot tell the two apart. Neither the header nor the expected token is ever logged (AAP 0.11.1).
 */
import { z } from 'zod';

import {
  ErrorEnvelope,
  RunSettlementRequest,
  TEST_CONTROL_HEADER,
  TestClockRequest,
} from '@tablemate/shared';
import { isTestClock, timingSafeEqualString } from '@tablemate/server-core';
import type { Clock } from '@tablemate/server-core';

import { AppError } from '../../plugins/errors.ts';
import { settleMeetup } from '../settlement/settle.ts';
import { runSweeper } from '../settlement/sweeper.ts';
import type { SweepSummary } from '../settlement/sweeper.ts';
import type { SettleResult } from '../settlement/settle.ts';

/** How many outbox passes a settlement trigger drains before it answers (AAP 0.5.6, bounded on purpose). */
const MAX_OUTBOX_PASSES = 5;

// Type-only, so nothing of `app.ts` is read at run time and no import cycle reaches the root.
import type { App, AppServices } from '../../app.ts';

/**
 * Move the clock the instance was built with (AAP 0.5.1, 0.5.4, 0.11.1).
 *
 * `now` sets the clock and `advanceMs` moves it forward; `TestClockRequest` rejects a body that
 * supplies neither or both, so exactly one of the two is set by the time this runs. The clock is only
 * moved once it is known to be controllable — `buildApp` may have been handed the process clock, and
 * there is nothing to move in that case — so an environment that claims `test` without a test clock
 * fails loudly instead of answering a `204` that changed nothing.
 */
function moveClock(clock: Clock, body: TestClockRequest): void {
  if (!isTestClock(clock)) {
    throw new Error(
      'test_control_clock_not_controllable: the injected clock implements no set and no advance',
    );
  }
  if (body.now !== undefined) {
    clock.set(new Date(body.now));
  } else if (body.advanceMs !== undefined) {
    clock.advance(body.advanceMs);
  }
}

/**
 * Settle what the caller asked for, then carry out what that settlement planned (AAP 0.5.1, 0.5.4).
 *
 * A named meetup is settled by this call, so the outcome of the meetup the caller named is decided
 * before it is answered; a call that names none asks for the sweeper's whole pass instead. In both
 * cases a pass follows, and it is not redundant: every settlement only plans the provider calls it
 * decides, and the pass's fourth step is the executor that runs them, resuming each unfinished
 * operation of the meetup just settled along with any other. It runs with `waitForLock`, so it waits
 * out a background pass in flight instead of skipping and reporting nothing (AAP 0.3.2).
 *
 * The outbox pass at the end delivers the rows the settlement committed in its own transaction — its
 * notifications, and the jobs an operator's or a notification's row carries — so a suite that has
 * just moved the clock reads a settled state rather than one still pending delivery.
 */
async function runSettlement(
  services: AppServices,
  meetupId: string | undefined,
): Promise<{ settle: SettleResult | null; sweep: SweepSummary }> {
  const settle =
    meetupId === undefined ? null : await settleMeetup(services, meetupId, { trigger: 'sweeper' });
  const sweep = await runSweeper(services, { waitForLock: true });
  // Until the dispatcher reports no row left, at most five passes: one pass delivers one batch, and a
  // settlement's notifications and job rows must all have reached BullMQ before the suite asserts.
  for (let pass = 0; pass < MAX_OUTBOX_PASSES; pass += 1) {
    if ((await services.outbox.runOnce()) === 0) break;
  }
  return { settle, sweep };
}

/**
 * Registers the two test-control routes on the context `app.ts` mounts under `/v1` (AAP 0.5.1,
 * 0.5.4).
 *
 * The registration guard is the first statement on purpose: a process that reaches this plugin
 * without `APP_ENV=test` and a `TEST_CONTROL_TOKEN` fails where the composition root built it,
 * instead of mounting a settlement trigger that any caller could reach. The root already registers
 * the plugin conditionally, which is why this is a second lock rather than the only one.
 *
 * The header guard is installed at context level, before either route, so both routes are covered and
 * no route outside this context can inherit it. Registration is synchronous, as in every plugin the
 * composition root installs — it awaits nothing, the hook and the routes are queued on the context,
 * and every value a handler needs is resolved per request. The declared `Promise<void>` is what keeps
 * this plugin usable wherever Fastify's own plugin types expect one.
 */
export default function testControlRoutes(app: App): Promise<void> {
  const env = app.services.env;
  const token = env.testOnly.testControlToken;
  if (env.APP_ENV !== 'test' || token === null) {
    throw new Error(
      'the test-control routes are registered only under APP_ENV=test with TEST_CONTROL_TOKEN set',
    );
  }
  app.addHook('onRequest', (request, _reply, done) => {
    // Fastify lowercases header names, so the shared constant is read in the one form the request
    // carries. A header repeated by a client arrives as an array, and a request that presents one is
    // treated as a request that presented none.
    const header = request.headers[TEST_CONTROL_HEADER.toLowerCase()];
    const presented = typeof header === 'string' ? header : null;
    // One answer for an absent header, a repeated one and a wrong token, and it is the status and
    // the code an unknown path answers with: `not_found` at `404`, never `401`. The comparison is
    // constant-time in the token, and the presented value is never logged.
    if (presented === null || !timingSafeEqualString(presented, token)) {
      throw new AppError('not_found');
    }
    // `done` is the hook's contract: a synchronous hook that neither throws nor returns a promise
    // ends nothing, and Fastify would hold the request open (`plugins/clock.ts` passes it too).
    done();
  });
  app.post(
    '/test/clock',
    {
      schema: {
        // Hidden: this route exists only in an `APP_ENV=test` process, so no client's view of the API
        // contains it (AAP 0.5.4).
        hide: true,
        body: TestClockRequest,
        // `204` carries no body: Fastify runs no serializer for that status, and the reply hands it the
        // `null` the schema declares. `400` is the body this route itself refuses, and `404` is what
        // the guard above answers outside `test` or without the header.
        response: { 204: z.null(), 400: ErrorEnvelope, 404: ErrorEnvelope },
      },
    },
    // Not `async`: moving a clock awaits nothing, and a handler that declared itself asynchronous
    // without awaiting anything is what `require-await` refuses (AAP 0.11.2).
    (request, reply) => {
      moveClock(app.services.clock, request.body);
      request.log.info(
        { event: 'test_clock_set', now: app.services.clock.now().toISOString() },
        'test_clock_set',
      );
      reply.code(204).send(null);
    },
  );
  app.post(
    '/test/run-settlement',
    {
      schema: {
        hide: true,
        // No `body` schema, on purpose. Fastify runs the body validator even when a request carries
        // none, and refuses `undefined` against any declared object schema — including one wrapped in
        // `.optional()`, which was measured against this provider and this Fastify version — so the
        // bare request this route exists for, the one asking for whatever is due, would answer
        // `400 invalid_field`. `RunSettlementRequest` still validates the body, in the handler below,
        // so the shared schema remains the one description of it: `{}`, `{ meetupId }` and a malformed
        // id keep exactly the meaning a declared schema would have given them.
        response: { 204: z.null(), 400: ErrorEnvelope, 404: ErrorEnvelope },
      },
    },
    async (request, reply) => {
      const body = RunSettlementRequest.safeParse(request.body ?? {});
      if (!body.success) {
        throw new AppError('invalid_field');
      }
      const meetupId = body.data.meetupId;
      const { settle, sweep } = await runSettlement(app.services, meetupId);
      request.log.info(
        {
          event: 'test_run_settlement',
          meetupId: meetupId ?? null,
          settle: settle?.result ?? null,
          sweep,
        },
        'test_run_settlement',
      );
      reply.code(204).send(null);
    },
  );
  return Promise.resolve();
}
