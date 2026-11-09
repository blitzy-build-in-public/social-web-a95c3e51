/** Webhook payload schemas (AAP 0.8.1): Twilio's HTTP callbacks, ConversationRelay's WebSocket frames and the Stripe fields the handler correlates a hold by. A provider-sent payload is a `z.looseObject`, because Twilio posts far more form fields than the API reads and `twilio.validateRequest` must receive every one of them for the signature to match; a frame the API sends is a `z.strictObject`, because Twilio rejects a relay message carrying an unknown field with error 64107. The Stripe event objects are typed by the `stripe` SDK. */

import { z } from 'zod';
import { CallLanguage } from '../enums.ts';
import { Uuid } from './common.ts';
/** The header carrying Twilio's request signature on the voice webhook and relay routes; the route checks it with `twilio.validateRequest` and answers `400 bad_signature` when it fails. */
export const TWILIO_SIGNATURE_HEADER = 'X-Twilio-Signature' as const;
/** The header carrying Stripe's event signature on `POST /v1/webhooks/stripe`, verified against the raw request body; a failure answers `400 bad_signature`. */
export const STRIPE_SIGNATURE_HEADER = 'Stripe-Signature' as const;
/** Twilio's `CallStatus` values, verbatim and hyphenated: provider values rather than Tablemate's own snake_case domain values. */
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
/** The body of `POST /v1/webhooks/voice`, Twilio's call-status callback. `CallSid`, `CallStatus` and `SequenceNumber` together are the dedupe key recorded in `VoiceCallbackEvent`, and unknown fields are kept because the signature check re-serializes every parsed field. */
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
/** The body of `POST /v1/webhooks/voice/twiml`, the request Twilio makes for the TwiML that opens a ConversationRelay session. */
export const TwilioTwimlRequest = z.looseObject({
  CallSid: z.string(),
  AccountSid: z.string(),
  From: z.string(),
  To: z.string(),
  CallStatus: TwilioCallStatus.optional(),
  AnsweredBy: z.string().optional(),
});
export type TwilioTwimlRequest = z.infer<typeof TwilioTwimlRequest>;
/** The one spelling of the parameter that carries the `CallAttempt` id on all three surfaces of a call: the status callback's query string, the TwiML fetch's query string and the relay WebSocket's `setup.customParameters`. It lives in this package because `apps/workers` builds the two URLs and cannot import the API that serves them, so a name changed on one side alone would leave a relay socket attached to no call. */
export const VOICE_ATTEMPT_PARAMETER = 'attemptId' as const;
/** The query string of every Twilio URL that carries the `CallAttempt` id. A signed callback carrying the id of a `dispatch_unknown` attempt is the only evidence that adopts it, so the id is required here and is what a handler resolves the attempt by. */
export const VoiceCallbackQuery = z.looseObject({ [VOICE_ATTEMPT_PARAMETER]: Uuid });
export type VoiceCallbackQuery = z.infer<typeof VoiceCallbackQuery>;
const MACHINE_VERDICT = 'machine_start';
const MACHINE_END_PREFIX = 'machine_end_';
/** Whether Twilio's machine detection found a machine rather than a person. `machine_start`, the three `machine_end_*` verdicts and `fax` are an answering machine, which takes the `no_answer` outcome; `human`, `unknown`, a missing value and any other verdict read as a person, because treating a person as a machine throws a reachable call away. */
export function isMachineAnswer(answeredBy?: string): boolean {
  const verdict = answeredBy?.trim().toLowerCase() ?? '';
  return verdict === MACHINE_VERDICT || verdict === 'fax' || verdict.startsWith(MACHINE_END_PREFIX);
}
/** The first frame of a relay session: the ids and numbers of the call it belongs to. */
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
/** A transcription of the callee's speech; `last` is `true` on the final prompt of an utterance, the only one the dialogue advances on. */
export const RelayPromptFrame = z.looseObject({
  type: z.literal('prompt'),
  voicePrompt: z.string(),
  lang: z.string(),
  last: z.boolean(),
});
export type RelayPromptFrame = z.infer<typeof RelayPromptFrame>;
/** The callee started speaking while the agent was talking. */
export const RelayInterruptFrame = z.looseObject({
  type: z.literal('interrupt'),
  utteranceUntilInterrupt: z.string().optional(),
  durationUntilInterruptMs: z.number().optional(),
});
export type RelayInterruptFrame = z.infer<typeof RelayInterruptFrame>;
/** A key the callee pressed, when DTMF detection is on. */
export const RelayDtmfFrame = z.looseObject({
  type: z.literal('dtmf'),
  digit: z.string(),
});
export type RelayDtmfFrame = z.infer<typeof RelayDtmfFrame>;
/** A diagnostic frame Twilio sends at session start and on configuration changes. */
export const RelayInfoFrame = z.looseObject({
  type: z.literal('info'),
  name: z.string(),
  value: z.unknown(),
});
export type RelayInfoFrame = z.infer<typeof RelayInfoFrame>;
/** A relay-side failure, such as a message the session rejected; the dialogue ends the call politely and leaves the task for retry. */
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
/** One token of an utterance the agent speaks; every utterance is a fixed per-language template, so `token` never carries language-model text, and `last` is always set explicitly. */
export const RelayTextFrame = z.strictObject({
  type: z.literal('text'),
  token: z.string(),
  last: z.boolean(),
  lang: CallLanguage.optional(),
  interruptible: z.boolean().optional(),
});
export type RelayTextFrame = z.infer<typeof RelayTextFrame>;
/** The mid-call switch to `en-US` when the callee prefers English. Both languages are required although Twilio accepts either alone: the switch moves recognition and speech together, which keeps a session from listening in one language and speaking in another. */
export const RelayLanguageFrame = z.strictObject({
  type: z.literal('language'),
  ttsLanguage: CallLanguage,
  transcriptionLanguage: CallLanguage,
});
export type RelayLanguageFrame = z.infer<typeof RelayLanguageFrame>;
/** The closing frame: the polite closing line has already been spoken as the final `text` token. */
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
/** The metadata every hold attempt's PaymentIntent carries: the meetup, the deposit and the attempt number it belongs to. Each attempt is its own PaymentIntent, so a webhook is matched to its attempt by the PaymentIntent id and never by the deposit alone. */
export const PaymentIntentMetadata = z.looseObject({
  meetupId: Uuid,
  depositId: Uuid,
  attempt: z.coerce.number().int().positive(),
});
export type PaymentIntentMetadata = z.infer<typeof PaymentIntentMetadata>;
/** The Stripe event types the webhook handler applies; every other type is acknowledged `200` without effect, so a type Stripe adds later cannot fail the endpoint. */
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
/** The `cancellation_reason` every cancel this application sends carries. It distinguishes our release from Stripe's own cancellation: a `payment_intent.canceled` with any other reason — notably `expired` — or a `charge.expired` event means the hold was lost, and a hold loss is never a forfeit. */
export const OUR_CANCELLATION_REASON = 'requested_by_customer' as const;
