/**
 * The Twilio call-status callback: `POST /v1/webhooks/voice?attemptId=`.
 * Twilio posts the lifecycle of a dispatched call here — `initiated`, `ringing`, `in-progress` and one terminal status —
 * form-encoded, carrying the `CallAttempt` id in the query this route's URL was built with. The route authenticates by
 * signature alone ({@link twilioSignatureHook}), resolves the attempt by that id and never by the `CallSid` — a
 * `calls.list` match may belong to another dispatch, while a signed callback carrying the attempt id is the evidence that
 * adopts a `dispatch_unknown` attempt — and answers `204` for every callback it accepts, including one it deliberately
 * does nothing about, so the provider never retries a no-op.
 * Four rules shape what it does with that evidence:
 * - **One transaction, one record.** The whole handler is a single {@link transact}, and neither Redis nor Twilio's REST
 *   API is touched inside it.
 * - **Deduplicated on `(CallSid, CallStatus, SequenceNumber)`.** `voice_callback_event` carries that unique key and the
 *   insert decides it: a callback whose key is already recorded has no second effect. It goes through the model API rather
 *   than a hand-written `INSERT`, because `skipDuplicates` is that table's `ON CONFLICT DO NOTHING`.
 * - **Forward-only state.** Callbacks may arrive out of order, so the state only ever moves forward, and `endedAt` is
 *   written once, by whichever writer reached `ended` first.
 * - **The outcome only for an unanswered call** ({@link mapFinalStatus}): an answered call belongs to `twiml.ts` and to the
 *   ConversationRelay session, and the gap those two can leave is the workers' reconciliation's.
 * A recorded outcome is what the workers' `call-results` applies to the task and its claim: `no_answer` with attempts left
 * queues the task a day later, a second `no_answer` makes it `unreachable`, which blocks it with `invalid_number`. The whole
 * dialogue budget the call held is released with the outcome, because a call that was never answered spent no turn of it.
 * Nothing here logs a phone number, a `CallSid`, a posted field or the body: a log line carries an event name, the attempt
 * id and Twilio's status word, and the outcome's own line is written by {@link recordAttemptOutcome}.
 */

import { z } from 'zod';

import {
  ErrorEnvelope,
  TwilioStatusCallback,
  VoiceCallbackQuery,
  type CallAttemptOutcome,
  type CallAttemptState,
  type TwilioCallStatus,
} from '@tablemate/shared';

import {
  Prisma,
  fixturePredicate,
  isUniqueViolation,
  type CallAttempt,
  type DbTx,
} from '@tablemate/db';

import { localDateKey, type LlmReservation } from '@tablemate/server-core';

import { AppError } from '../../plugins/errors.ts';
import type { OpenApiTag } from '../../plugins/openapi.ts';
import { webhookLimits } from '../../plugins/rate-limit.ts';

import { transact } from '../outbox/write.ts';

import { isStripped, lockAttempt, recordAttemptOutcome, type AttemptResult } from './dialogue.ts';
import { twilioSignatureHook } from './signature.ts';

import type { App, AppServices } from '../../app.ts';

/** The tag the route groups under: a member of the document's own vocabulary, never a new string. */
const VOICE_TAG = 'webhooks' satisfies OpenApiTag;

/**
 * The statuses that end a call: the five `CallStatus` values Twilio never follows with another callback for the same call.
 * A call Twilio reports as `in-progress` was answered, and its later `completed` is left to the writers named above.
 */
const FINAL_STATUSES: ReadonlySet<TwilioCallStatus> = new Set([
  'completed',
  'busy',
  'no-answer',
  'canceled',
  'failed',
]);

/**
 * Twilio's error codes for a destination number that cannot exist: `21211` an invalid `To`, `21217` a number that does not
 * appear valid, `13223` a malformed destination in a `<Dial>`.
 * `13224` and `13225` are deliberately absent, and so is every other code: `13224` also covers a local carrier outage and
 * `13225` a fraud or regulatory block on the account, neither of which says the number cannot exist. Membership here ends a
 * task's attempts, so a code is admitted only when it means the number itself is unusable.
 */
const INVALID_NUMBER_ERROR_CODES: ReadonlySet<string> = new Set(['13223', '21211', '21217']);

/**
 * The SIP response codes that mean the destination does not exist: Twilio documents `404` on a terminal status callback as
 * the destination being unreachable, and publishes no meaning of its own for `484` (RFC 3261 address incomplete) or `604`
 * (does not exist anywhere).
 * The value is read defensively ({@link sipResponseCode}): the shared `TwilioStatusCallback` does not declare
 * `SipResponseCode`, so it reaches this route through the schema's loose object unvalidated — as `ErrorCode` does, that one
 * because Twilio documents it in the Debugger rather than as a callback parameter.
 */
const INVALID_NUMBER_SIP_CODES: ReadonlySet<number> = new Set([404, 484, 604]);

/**
 * The media type Twilio posts every one of its callbacks as, and the only one this route accepts: `@fastify/formbody` is
 * what parses it, and a body in any other form is refused `400 invalid_field` before the callback is read. A JSON body here
 * is a caller that is not Twilio — and the signature check upstream authenticates the ones that are.
 */
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

/**
 * Registers the voice status callback. Registered by `./twiml.ts` inside the encapsulated voice-agent context, after
 * `@fastify/formbody` is registered there: Twilio posts every callback as `application/x-www-form-urlencoded`, which
 * Fastify 5 does not parse by default, and the parser belongs to the context that serves all three Twilio URLs.
 * The route carries no bearer guard and no age gate — a provider signed it, so there is no caller to authenticate — and it
 * takes only the webhook per-IP counter, because a provider's traffic arrives from a handful of addresses.
 */
export function registerStatusWebhook(app: App): void {
  app.post(
    '/webhooks/voice',
    {
      ...webhookLimits(app),
      // Before the route's own schema sees the body, and over the raw parsed fields: a bad signature is answered `400
      // bad_signature` rather than as whichever schema error the payload raises, and the fields the signature covers are the
      // ones Twilio posted.
      preValidation: twilioSignatureHook('http'),
      schema: {
        tags: [VOICE_TAG],
        querystring: VoiceCallbackQuery,
        body: TwilioStatusCallback,
        // A provider callback declares no `security`: its signature is its authentication. The `204` carries no body, so Fastify
        // runs no serializer for it; the `400` is the one refusal this route answers itself — an unusable attempt id, a body that
        // is not a form, or a field the schema rejects — and the document publishes it.
        response: {
          204: z.null(),
          400: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!isFormEncoded(request.headers)) {
        throw new AppError('invalid_field');
      }
      // The attempt id and Twilio's own status word, never a number or a `CallSid` (AAP 0.11.1).
      request.log.debug(
        {
          event: 'voice_status',
          attemptId: request.query.attemptId,
          callStatus: request.body.CallStatus,
        },
        'voice_status',
      );
      // The instant this request was stamped with, so every timestamp the callback writes comes from one read of the injected clock.
      await recordStatusCallback(
        app.services,
        request.query.attemptId,
        request.body,
        request.receivedAt,
      );
      reply.code(204).send(null);
    },
  );
}

/**
 * Whether this request carries the form body Twilio posts: the header is matched by substring, because Twilio sends the
 * media type with a charset parameter as often as without one; a request with no content type at all is not a form body
 * either.
 */
function isFormEncoded(headers: { readonly 'content-type'?: string | undefined }): boolean {
  return headers['content-type']?.toLowerCase().includes(FORM_MEDIA_TYPE) === true;
}

/**
 * Record one status callback, in one transaction, and apply what it says. The order of the steps below is the order the
 * decisions have to be taken in:
 *  1. **Lock the attempt.** {@link lockAttempt} takes `SELECT … FOR UPDATE` on the row, which is what serializes this
 *     callback against the ConversationRelay session's own ending of the same call, a TwiML fetch and the workers'
 *     reconciliation: the second writer sees the first one's outcome. An attempt that no longer exists, or whose call
 *     content was stripped, is answered without effect.
 *  2. **Check and adopt the `CallSid`** ({@link callSidRefusal}). An attempt still `dispatching` or `dispatch_unknown`
 *     adopts the `CallSid` from this signed, attempt-id-carrying callback — the only evidence AAP 0.3.2 accepts for an
 *     ambiguous dispatch — and moves to `dialing`.
 *  3. **Deduplicate.** The `voice_callback_event` insert decides it: no row means this exact
 *     `(CallSid, CallStatus, SequenceNumber)` was already recorded.
 *  4. **Move the state forward.** One update writes what Twilio reported before the outcome, so the row is already the
 *     provider's when the outcome's own write joins it.
 *  5. **Record the outcome of an unanswered call** ({@link mapFinalStatus}), which also releases the dialogue budget the
 *     call held and writes the `apply_call_result` row that `apps/workers` applies.
 */
async function recordStatusCallback(
  services: AppServices,
  attemptId: string,
  body: TwilioStatusCallback,
  now: Date,
): Promise<void> {
  await transact(services, async (tx, after) => {
    const attempt = await lockAttempt(tx, attemptId);
    if (attempt === null || isStripped(attempt)) {
      return;
    }
    const adoption = await callSidDecision(tx, attempt, body.CallSid);
    if (adoption === 'refused') {
      callSidRefusal(services, attempt.id);
      return;
    }
    const recorded = await tx.voiceCallbackEvent.createManyAndReturn({
      data: [
        {
          callAttemptId: attempt.id,
          callSid: body.CallSid,
          callStatus: body.CallStatus,
          sequenceNumber: body.SequenceNumber,
          receivedAt: now,
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    if (recorded.length === 0) {
      return;
    }
    const written = await writeReportedStatus(tx, attempt, body, adoption === 'adopted', now);
    if (!written) {
      callSidRefusal(services, attempt.id);
      return;
    }
    const outcome = mapFinalStatus(body);
    if (outcome === null) {
      return;
    }
    const reservation = await dialogueReservation(tx, services, attempt);
    const result: AttemptResult = {
      outcome,
      confidence: null,
      extractedFields: null,
      summary: null,
      transcript: null,
    };
    // `endCall: false`: this route has already moved the attempt to `ended` with its `endedAt`, and `endedAt` is set once. The
    // whole budget is unused, because a call that was never answered held no dialogue turn.
    await recordAttemptOutcome(tx, services, after, attempt, result, {
      reservation,
      unusedMicros: reservation.micros,
      endCall: false,
    });
  });
}

/**
 * Whether this callback may adopt its `CallSid`. Three answers, and only one of them lets the callback do anything:
 * `'matches'` — the attempt already holds this `CallSid`; `'adopted'` — the attempt holds none and no other attempt holds
 * this one; `'refused'` — the attempt holds a different `CallSid`, or another attempt already holds this one, both answered
 * without effect.
 * The owner is looked up before the update rather than left to the unique index, because a unique violation raised inside
 * the transaction aborts it: PostgreSQL refuses every later statement of an aborted transaction, and the driver reports the
 * violation as an error where this case is an ordinary one. The unique index is still the guarantee —
 * {@link writeReportedStatus} treats its violation as this same refusal — so two callbacks racing to adopt one `CallSid`
 * cannot both succeed.
 */
async function callSidDecision(
  tx: DbTx,
  attempt: CallAttempt,
  callSid: string,
): Promise<'matches' | 'adopted' | 'refused'> {
  if (attempt.twilioCallSid !== null) {
    return attempt.twilioCallSid === callSid ? 'matches' : 'refused';
  }
  const owner = await tx.callAttempt.findFirst({
    where: { twilioCallSid: callSid },
    select: { id: true },
  });
  return owner === null ? 'adopted' : 'refused';
}

/**
 * Write what Twilio reported in this callback, without ever moving the attempt backwards.
 * A callback that ends the call also ends the attempt, and `endedAt` is set only when it is still empty: a
 * ConversationRelay session that ended the call has already stamped it, and the provider's later callback must not move it.
 * `durationSec` is written only when Twilio sent one, and `false` comes back when another attempt took this `CallSid`
 * first, which leaves the caller to answer without effect.
 */
async function writeReportedStatus(
  tx: DbTx,
  attempt: CallAttempt,
  body: TwilioStatusCallback,
  adopts: boolean,
  now: Date,
): Promise<boolean> {
  const final = FINAL_STATUSES.has(body.CallStatus);
  const data: Prisma.CallAttemptUpdateInput = {
    state: forwardState(attempt.state, body.CallStatus),
  };
  if (adopts) {
    data.twilioCallSid = body.CallSid;
  }
  if (final) {
    data.twilioFinalStatus = body.CallStatus;
    if (body.CallDuration !== undefined) {
      data.durationSec = body.CallDuration;
    }
    if (attempt.endedAt === null) {
      data.endedAt = now;
    }
  }
  try {
    await tx.callAttempt.update({ where: { id: attempt.id }, data });
    return true;
  } catch (error) {
    // The adopt above lost a race to another attempt over the same `CallSid`, which the table's unique index is there to
    // catch: nothing was written yet, so the aborted transaction rolls back to the state this callback found.
    if (adopts && isUniqueViolation(error, 'twilio_call_sid')) {
      return false;
    }
    throw error;
  }
}

/**
 * The attempt state this callback moves to, or the one it is already in. Forward-only, because Twilio's callbacks are not
 * ordered: a `ringing` that arrives after an `in-progress` describes a call that has already been answered, and an `ended`
 * attempt is never reopened by a late event. Only these three moves exist — `initiated`/`ringing` reach `dialing`,
 * `in-progress` reaches `in_progress`, and a final status reaches `ended` — and Twilio's `queued` moves nothing.
 */
function forwardState(current: CallAttemptState, status: TwilioCallStatus): CallAttemptState {
  if (FINAL_STATUSES.has(status)) {
    return 'ended';
  }
  if (current === 'ended') {
    return current;
  }
  if (status === 'in-progress') {
    return 'in_progress';
  }
  if (status === 'initiated' || status === 'ringing') {
    return current === 'in_progress' ? 'in_progress' : 'dialing';
  }
  return current;
}

/**
 * What an unanswered call produced, or `null` when this callback must not record an outcome.
 * `busy`, `no-answer` and `canceled` are `no_answer` — the call reached nobody, so the task keeps the retry AAP 0.5.3 gives
 * it. A `failed` status is `unreachable` when the destination number cannot exist ({@link isInvalidNumber}) and `no_answer`
 * otherwise, which covers a carrier failure, a blocked call and every code this route does not recognize. `completed` is
 * `null`: the call was answered, so its script — not its transport — decided the outcome.
 * A call that was answered and then dropped, or one answered by a machine, is *not* mapped here: a machine or an
 * unanswerable task is recorded by `twiml.ts` when it answers `<Hangup/>`, and a drop mid-script is the relay's, which knows
 * how much of the dialogue it collected.
 */
function mapFinalStatus(body: TwilioStatusCallback): CallAttemptOutcome | null {
  switch (body.CallStatus) {
    case 'busy':
    case 'no-answer':
    case 'canceled':
      return 'no_answer';
    case 'failed':
      return isInvalidNumber(body) ? 'unreachable' : 'no_answer';
    default:
      return null;
  }
}

/**
 * Whether Twilio said the destination number itself cannot exist: one of {@link INVALID_NUMBER_ERROR_CODES} or one of
 * {@link INVALID_NUMBER_SIP_CODES}. Neither value is trusted to be well formed: a value that is not a bare code, and a
 * failure code this route does not recognize, both read as "not an invalid number", which leaves the task its retry.
 */
function isInvalidNumber(body: TwilioStatusCallback): boolean {
  const code = body.ErrorCode?.trim();
  if (code !== undefined && code !== '' && INVALID_NUMBER_ERROR_CODES.has(code)) {
    return true;
  }
  const sip = sipResponseCode(body);
  return sip !== null && INVALID_NUMBER_SIP_CODES.has(sip);
}

/** Twilio's `SipResponseCode` as a number, or `null` when the field is absent or not a number. */
function sipResponseCode(body: TwilioStatusCallback): number | null {
  const raw = readField(body, 'SipResponseCode');
  if (typeof raw === 'number') {
    return Number.isInteger(raw) ? raw : null;
  }
  if (typeof raw !== 'string') {
    return null;
  }
  // Digits alone: a value Twilio did not send as a bare SIP code is not one this route reasons about, so it is left out rather than read up to its first non-digit.
  const digits = raw.trim();
  return /^\d{1,3}$/.test(digits) ? Number.parseInt(digits, 10) : null;
}

/**
 * One field of a callback the shared schema does not declare: `TwilioStatusCallback` is a loose object, so a field it does
 * not name is kept unvalidated and untyped, and this reads such a field without asserting a shape onto it — the reader
 * decides what the value may be.
 */
function readField(body: unknown, field: string): unknown {
  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)[field]
    : undefined;
}

/**
 * The dialogue budget a call holds, rebuilt from the attempt that holds it.
 * The reservation was made before dialing, on the dispatch-time local day of the city, so releasing the unused part has to
 * name that same city and day, or the release would land on a counter nothing reserved against. The city comes from the
 * task's target rather than from `./dialogue.ts`'s `loadCallContext`, which would also read the target row and a lodging
 * claim's ciphertexts a status callback never uses.
 * The amount is read from the locked row, so two writers cannot release the same budget: the first one to record the outcome
 * zeroes it, and the second already sees it zero. A task naming no resolvable city throws, which its foreign keys make
 * unreachable, and a callback that cannot release against a counter is refused and retried rather than recorded against
 * none.
 * The read joins `place` and `lodging`, so it carries the shared {@link fixturePredicate} for each alias: raw SQL bypasses the
 * guarded client's fixture extension, while the fixture rule is written as every venue, lodging, place and price-record query
 * (AAP 0.5.2). Both are written NULL-safe, because each join is a `LEFT JOIN` — for a task whose target is the other table the
 * alias's columns are NULL, and a bare predicate would evaluate to NULL and drop that row rather than filter a fixture one.
 */
async function dialogueReservation(
  tx: DbTx,
  services: AppServices,
  attempt: CallAttempt,
): Promise<LlmReservation> {
  const rows = await tx.$queryRaw<{ cityId: string }[]>(Prisma.sql`
    SELECT COALESCE("p"."city_id", "l"."city_id") AS "cityId"
      FROM "call_task" AS "t"
      LEFT JOIN "place" AS "p" ON "p"."id" = "t"."place_id"
      LEFT JOIN "lodging" AS "l" ON "l"."id" = "t"."lodging_id"
     WHERE "t"."id" = ${attempt.callTaskId}::uuid
       AND ("p"."id" IS NULL OR ${fixturePredicate(services.env.APP_ENV, 'p')})
       AND ("l"."id" IS NULL OR ${fixturePredicate(services.env.APP_ENV, 'l')})`);
  const cityId = rows[0]?.cityId;
  if (cityId === undefined) {
    throw new Error('voice_status_webhook_target_missing');
  }
  const micros = Number(attempt.llmReservedMicros);
  return {
    cityId,
    localDate: localDateKey(services.timezoneFor(cityId), attempt.startedAt),
    micros: Number.isSafeInteger(micros) && micros > 0 ? micros : 0,
  };
}

/** Record the one refusal {@link callSidDecision} and {@link writeReportedStatus} both answer with. */
function callSidRefusal(services: AppServices, attemptId: string): void {
  services.logger.warn(
    { event: 'voice_callback_callsid_mismatch', attemptId },
    'voice_callback_callsid_mismatch',
  );
}
