/**
 * Webhook payload schemas: Twilio's HTTP callbacks, ConversationRelay's WebSocket frames and the
 * Stripe fields the handler correlates a hold by (AAP 0.3.3, AAP 0.5.4, AAP 0.5.6).
 *
 * The two directions carry different contracts. A provider-sent payload — every callback Twilio
 * posts and every frame it sends — is a `z.looseObject`: Twilio posts far more form fields than
 * the API reads, and `twilio.validateRequest(authToken, signature, url, params)` must receive
 * every field Twilio sent for the signature to match, so nothing may be stripped or rejected
 * (AAP 0.3.3). A frame the API sends is a `z.strictObject`, because Twilio rejects a relay message
 * carrying an unknown field with error 64107: what validates here has to be what Twilio accepts.
 *
 * The Stripe event objects themselves are typed by the `stripe` SDK inside the API. This module
 * carries only what the transport and the correlation need: the metadata every hold attempt
 * carries, the event types the handler applies, and our own cancellation reason.
 *
 * It also holds the two call facts the API process and the workers process have to agree on: the
 * parameter name that carries a `CallAttempt` id on every Twilio URL, and the rule that reads
 * Twilio's machine-detection verdict, both of which only `packages/shared` can define once for the
 * two processes (AAP 0.3.2, 0.5.3, 0.8.1).
 *
 * Client-safe like the rest of the package — `zod` and two sibling modules, no Node built-in, no
 * DOM global, no top-level side effect — even though only server code imports it.
 *
 * @see AAP 0.3.2 for idempotency, the voice-webhook dedupe key and "our cancels versus Stripe's",
 * AAP 0.3.3 for the Twilio and Stripe integration rows, 0.5.3 for the call and deposit lifecycles
 * and 0.5.6 for the voice agent's dialogue rules.
 */

import { z } from 'zod';
import { CallLanguage } from '../enums.ts';
import { Uuid } from './common.ts';

/*
 * Request signatures.
 */

/**
 * The header carrying Twilio's request signature on `POST /v1/webhooks/voice`,
 * `POST /v1/webhooks/voice/twiml` and the `WS /v1/webhooks/voice/relay` upgrade. The route checks
 * it with `twilio.validateRequest(authToken, signature, url, params)` and answers
 * `400 bad_signature` when it fails (AAP 0.3.3).
 *
 * Spelled as Twilio sends it; Fastify lowercases incoming header names, so a handler reads it
 * through `request.headers['x-twilio-signature']`.
 */
export const TWILIO_SIGNATURE_HEADER = 'X-Twilio-Signature' as const;

/**
 * The header carrying Stripe's event signature on `POST /v1/webhooks/stripe`, verified against the
 * raw request body with `stripe.webhooks.constructEvent(rawBody, signature, secret)`; a failure
 * answers `400 bad_signature` (AAP 0.3.3).
 *
 * Fastify lowercases incoming header names.
 */
export const STRIPE_SIGNATURE_HEADER = 'Stripe-Signature' as const;

/*
 * Twilio HTTP callbacks — `application/x-www-form-urlencoded`, parsed by `@fastify/formbody`
 * inside the encapsulated voice-agent plugin (AAP 0.3.3).
 */

/**
 * Twilio's `CallStatus` values, verbatim, hyphens and all: these are provider values rather than
 * Tablemate's own snake_case domain values (AAP 0.11.1).
 */
export const TwilioCallStatus = z.enum([
  'queued',
  'initiated',
  'ringing',
  'in-progress',
  'completed',
  'busy',
  'no-answer',
  'canceled',
  'failed',
]);
export type TwilioCallStatus = z.infer<typeof TwilioCallStatus>;

/**
 * The body of `POST /v1/webhooks/voice`, Twilio's call-status callback (AAP 0.3.3).
 *
 * `CallSid`, `CallStatus` and `SequenceNumber` together are the dedupe key recorded in
 * `VoiceCallbackEvent`, so a redelivered callback is acknowledged without a second effect
 * (AAP 0.3.2). The reconciliation rules read the rest (AAP 0.5.3): machine values in `AnsweredBy`,
 * and the `busy` and `no-answer` statuses, map to the `no_answer` outcome; the `ErrorCode` of an
 * unroutable number maps to `unreachable`.
 *
 * `SequenceNumber` and `CallDuration` arrive as form strings and are coerced. Unknown fields are
 * kept, because the signature check re-serializes every parsed field.
 */
export const TwilioStatusCallback = z.looseObject({
  CallSid: z.string(),
  AccountSid: z.string(),
  CallStatus: TwilioCallStatus,
  SequenceNumber: z.coerce.number().int().nonnegative(),
  ErrorCode: z.string().optional(),
  AnsweredBy: z.string().optional(),
  CallDuration: z.coerce.number().int().nonnegative().optional(),
  To: z.string(),
  From: z.string(),
});
export type TwilioStatusCallback = z.infer<typeof TwilioStatusCallback>;

/**
 * The body of `POST /v1/webhooks/voice/twiml`, the request Twilio makes for the TwiML that opens a
 * ConversationRelay session for an outbound call (AAP 0.3.3). Signature-checked like every other
 * callback; `AnsweredBy` carries the machine-detection result when one was requested.
 */
export const TwilioTwimlRequest = z.looseObject({
  CallSid: z.string(),
  AccountSid: z.string(),
  From: z.string(),
  To: z.string(),
  CallStatus: TwilioCallStatus.optional(),
  AnsweredBy: z.string().optional(),
});
export type TwilioTwimlRequest = z.infer<typeof TwilioTwimlRequest>;

/**
 * The one spelling of the parameter that carries the `CallAttempt` id on all three surfaces of a
 * call: the status callback's query string, the TwiML fetch's query string, and the relay
 * WebSocket's `setup.customParameters`, whose value arrives from the TwiML `<Parameter>` of this
 * name (AAP 0.3.2, AAP 0.3.3).
 *
 * It lives here because it is the single thing tying those three surfaces to one attempt and
 * because `apps/workers`, which builds the two HTTP URLs, cannot import `apps/api`, which serves
 * them: a name changed on one side alone would leave a relay socket attached to no call and a
 * signed callback adopting nothing (AAP 0.8.1, AAP 0.11.1).
 */
export const VOICE_ATTEMPT_PARAMETER = 'attemptId' as const;

/**
 * The query string of every Twilio URL that carries the `CallAttempt` id: the status callback, the
 * TwiML fetch and the relay WebSocket upgrade (AAP 0.3.2).
 *
 * A signed callback or TwiML fetch carrying the id of a `dispatch_unknown` attempt is the only
 * evidence that adopts it — a `calls.list` match may belong to another dispatch and an empty
 * listing proves nothing — so the id is required here, and the id rather than the `CallSid` is
 * what a handler resolves the attempt by. Its one key is {@link VOICE_ATTEMPT_PARAMETER}, so the
 * schema and the URL builders that feed it cannot spell the parameter differently.
 */
export const VoiceCallbackQuery = z.looseObject({ [VOICE_ATTEMPT_PARAMETER]: Uuid });
export type VoiceCallbackQuery = z.infer<typeof VoiceCallbackQuery>;

/*
 * Twilio's machine-detection vocabulary — the verdicts the API's TwiML route reads to decide
 * whether to converse with the call it just answered, and that the workers' reconciliation reads on
 * the call it fetched by its `CallSid` (AAP 0.3.2, AAP 0.5.3).
 */

/** Twilio's verdict for a machine that answered and is still speaking its greeting. */
const MACHINE_VERDICT = 'machine_start';

/** The prefix of the verdicts for a machine whose greeting has ended: beep, silence or other. */
const MACHINE_END_PREFIX = 'machine_end_';

/**
 * Whether Twilio's machine detection found a machine rather than a person (AAP 0.5.3).
 *
 * `machine_start`, the three `machine_end_*` verdicts and `fax` are an answering machine, and
 * AAP 0.5.3 gives an answering machine the `no_answer` outcome, which keeps the task's retry.
 * `human`, `unknown`, a missing value and any other verdict read as a person, because treating a
 * person as a machine throws a reachable call away — which is why the set is exact rather than a
 * `machine`-prefix match, the one direction a broadening would silently move in. The value is
 * normalized first, so a stray case or space cannot turn a machine into a person.
 *
 * One definition, read by both processes: the API's TwiML route hangs up on the call it answered,
 * and the workers' reconciliation gives the call it fetched by its `CallSid` the same outcome, so
 * one call cannot be a person in one process and a machine in the other (AAP 0.8.1, AAP 0.11.1).
 *
 * @param answeredBy - Twilio's `AnsweredBy`, if it sent one.
 * @returns True for a machine, a fax or a machine-greeting-end verdict; false otherwise.
 */
export function isMachineAnswer(answeredBy?: string): boolean {
  const verdict = answeredBy?.trim().toLowerCase() ?? '';
  return verdict === MACHINE_VERDICT || verdict === 'fax' || verdict.startsWith(MACHINE_END_PREFIX);
}

/*
 * ConversationRelay, inbound — the frames Twilio sends over `WS /v1/webhooks/voice/relay`
 * (AAP 0.5.6). Loose like every provider payload: the frame carries fields this API does not read
 * and must not lose.
 */

/**
 * The first frame of a relay session: the ids and numbers of the call it belongs to.
 *
 * `customParameters` holds whatever the TwiML `<Parameter>` elements passed. `sessionId` names the
 * socket, and `callSid` is the `CallSid` the attempt adopts when it was still `dispatch_unknown`.
 */
export const RelaySetupFrame = z.looseObject({
  type: z.literal('setup'),
  sessionId: z.string(),
  callSid: z.string(),
  from: z.string(),
  to: z.string(),
  direction: z.string().optional(),
  customParameters: z.record(z.string(), z.string()).optional(),
});
export type RelaySetupFrame = z.infer<typeof RelaySetupFrame>;

/**
 * A transcription of the callee's speech. `last` is `true` on the final prompt of an utterance —
 * the only one the dialogue advances on — and `lang` carries the detected BCP-47 tag.
 */
export const RelayPromptFrame = z.looseObject({
  type: z.literal('prompt'),
  voicePrompt: z.string(),
  lang: z.string(),
  last: z.boolean(),
});
export type RelayPromptFrame = z.infer<typeof RelayPromptFrame>;

/**
 * The callee started speaking while the agent was talking. Nothing is replayed in response:
 * the dialogue only records that the utterance was cut short.
 */
export const RelayInterruptFrame = z.looseObject({
  type: z.literal('interrupt'),
  utteranceUntilInterrupt: z.string().optional(),
  durationUntilInterruptMs: z.number().optional(),
});
export type RelayInterruptFrame = z.infer<typeof RelayInterruptFrame>;

/** A key the callee pressed, when DTMF detection is on. The `digit` is a string, as Twilio sends it. */
export const RelayDtmfFrame = z.looseObject({
  type: z.literal('dtmf'),
  digit: z.string(),
});
export type RelayDtmfFrame = z.infer<typeof RelayDtmfFrame>;

/**
 * A diagnostic frame Twilio sends at session start and on configuration changes. Its payload is
 * never read, so `value` is left unconstrained: what matters is that a documented frame parses,
 * because a rejected frame would break the dialogue of a live call.
 */
export const RelayInfoFrame = z.looseObject({
  type: z.literal('info'),
  name: z.string(),
  value: z.unknown(),
});
export type RelayInfoFrame = z.infer<typeof RelayInfoFrame>;

/**
 * A relay-side failure, such as a message the session rejected (Twilio reports its code inside
 * `description`). The dialogue ends the call politely and leaves the task for retry.
 */
export const RelayErrorFrame = z.looseObject({
  type: z.literal('error'),
  description: z.string(),
});
export type RelayErrorFrame = z.infer<typeof RelayErrorFrame>;

/** Every frame Twilio sends on the relay socket, discriminated on `type` (AAP 0.5.6). */
export const RelayInboundFrame = z.discriminatedUnion('type', [
  RelaySetupFrame,
  RelayPromptFrame,
  RelayInterruptFrame,
  RelayDtmfFrame,
  RelayInfoFrame,
  RelayErrorFrame,
]);
export type RelayInboundFrame = z.infer<typeof RelayInboundFrame>;

/*
 * ConversationRelay, outbound — the frames this API sends over the relay socket (AAP 0.5.6).
 * Strict, because Twilio answers an unknown field with error 64107.
 */

/**
 * One token of an utterance the agent speaks. Every utterance is a fixed per-language template
 * (AAP 0.5.6), so `token` carries text that came from a template and never from a language model.
 *
 * `last` marks the end of the reply and is always set explicitly: `lang` is optional and only the
 * first token of a reply may set it.
 */
export const RelayTextFrame = z.strictObject({
  type: z.literal('text'),
  token: z.string(),
  last: z.boolean(),
  lang: CallLanguage.optional(),
  interruptible: z.boolean().optional(),
});
export type RelayTextFrame = z.infer<typeof RelayTextFrame>;

/**
 * The mid-call switch to `en-US` when the callee prefers English (AAP 0.2.4, AAP 0.5.6).
 *
 * Both languages are required, although Twilio accepts either one alone: the switch always moves
 * recognition and speech together, and sending both is what keeps a session from being left
 * listening in one language and speaking in another.
 */
export const RelayLanguageFrame = z.strictObject({
  type: z.literal('language'),
  ttsLanguage: CallLanguage,
  transcriptionLanguage: CallLanguage,
});
export type RelayLanguageFrame = z.infer<typeof RelayLanguageFrame>;

/**
 * The closing frame: the polite closing line has already been spoken as the final `text` token.
 * Sent when the callee asks for a human, asks not to be called, when the dialogue budget runs out
 * or when the task was superseded mid-call (AAP 0.5.3, AAP 0.5.6).
 */
export const RelayEndFrame = z.strictObject({
  type: z.literal('end'),
  handoffData: z.string().optional(),
});
export type RelayEndFrame = z.infer<typeof RelayEndFrame>;

/** Every frame this API sends on the relay socket, discriminated on `type` (AAP 0.5.6). */
export const RelayOutboundFrame = z.discriminatedUnion('type', [
  RelayTextFrame,
  RelayLanguageFrame,
  RelayEndFrame,
]);
export type RelayOutboundFrame = z.infer<typeof RelayOutboundFrame>;

/*
 * Stripe (AAP 0.3.2, AAP 0.3.3).
 */

/**
 * The metadata every hold attempt's PaymentIntent carries: the meetup, the deposit and the attempt
 * number the PaymentIntent belongs to (AAP 0.5.3, "Correlation").
 *
 * Each attempt is its own PaymentIntent, so a webhook is matched to the attempt it concerns by the
 * PaymentIntent id and never by the deposit alone; these values are what let the handler tie an
 * event back to the deposit and its attempt. Stripe metadata values are strings, hence the
 * coercion on `attempt`.
 */
export const PaymentIntentMetadata = z.looseObject({
  meetupId: Uuid,
  depositId: Uuid,
  attempt: z.coerce.number().int().positive(),
});
export type PaymentIntentMetadata = z.infer<typeof PaymentIntentMetadata>;

/**
 * The Stripe event types the webhook handler applies (AAP 0.3.3). Every other type is acknowledged
 * `200` without effect, so a type Stripe adds later cannot fail the endpoint.
 */
export const HANDLED_STRIPE_EVENT_TYPES = [
  'setup_intent.succeeded',
  'payment_intent.amount_capturable_updated',
  'payment_intent.payment_failed',
  'payment_intent.succeeded',
  'payment_intent.canceled',
  'charge.expired',
  'charge.refunded',
] as const;

/** One of the {@link HANDLED_STRIPE_EVENT_TYPES} the handler applies (AAP 0.3.3). */
export const HandledStripeEventType = z.enum(HANDLED_STRIPE_EVENT_TYPES);
export type HandledStripeEventType = z.infer<typeof HandledStripeEventType>;

/**
 * The `cancellation_reason` every cancel this application sends carries, for a release of a hold
 * as much as for a superseded attempt (AAP 0.3.2).
 *
 * It is what distinguishes our release from Stripe's own cancellation: a `payment_intent.canceled`
 * with any other reason — notably `expired`, which is how an expired authorization reads under the
 * pinned API version — or a `charge.expired` event means the hold was lost, not released, and the
 * deposit takes the `expired` transition. A hold loss is never a forfeit, and the deposit's
 * `canceledAt` records Stripe's own cancellation time.
 */
export const OUR_CANCELLATION_REASON = 'requested_by_customer' as const;
