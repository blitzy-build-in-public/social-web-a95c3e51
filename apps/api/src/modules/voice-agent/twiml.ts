/**
 * The ConversationRelay TwiML an answered call is given, and the encapsulated voice-agent context every Twilio URL is
 * served from: `POST /v1/webhooks/voice/twiml?attemptId=`.
 *
 * Twilio fetches this once a call is answered, form encoded, carrying the `CallAttempt` id in the query the dispatcher
 * built the URL with. The answer is either a `<Connect><ConversationRelay>` document that opens the socket
 * `./relay-ws.ts` serves, or a bare `<Hangup/>` for a call this API must not hold a conversation with. No Twilio REST
 * call is made here: dialing belongs to `apps/workers`.
 *
 * Three rules make the dialogue safe and the call traceable: the disclosure comes first, in the callee's language, with
 * `welcomeGreetingInterruptible="none"` and no recording and no `intelligenceService`, so no audio and no provider
 * transcript of a call is stored; every speech provider and model is written out on the root and on each `<Language>`,
 * because Twilio's root default for `transcriptionProvider` depends on the account's age; and a call with nobody to talk
 * to hangs up and records `no_answer`.
 *
 * The attempt id ties the three surfaces of one call together — this route's query parameter, the `<Parameter>` the relay
 * socket reads its attempt from, and the evidence that adopts a `dispatch_unknown` attempt — under `packages/shared`'s
 * {@link VOICE_ATTEMPT_PARAMETER}.
 *
 * A refusal is either the shared envelope — `400 bad_signature` from the signature hook, which runs before the schemas —
 * or, for a reason only this file knows, `<Hangup/>` with `200`, because Twilio has to be told what to do with a call it
 * has already placed. The one log line carries the event, the attempt id and the answer given, never a `CallSid`, a phone
 * number or a posted field.
 */

import { z } from 'zod';
import formbody from '@fastify/formbody';

import { isUniqueViolation, type CallAttempt, type DbTx } from '@tablemate/db';
import {
  ErrorEnvelope,
  TwilioTwimlRequest,
  VOICE_ATTEMPT_PARAMETER,
  VoiceCallbackQuery,
  isMachineAnswer,
  type CallAttemptState,
  type CallLanguage,
} from '@tablemate/shared';

import { webhookLimits } from '../../plugins/rate-limit.ts';
import { transact } from '../outbox/write.ts';

import {
  disclosureFor,
  isStripped,
  loadCallContext,
  lockAttempt,
  recordAttemptOutcome,
  reservationFor,
  type AttemptResult,
} from './dialogue.ts';
import { registerVoiceRelay } from './relay-ws.ts';
import { publicRelayUrl, twilioSignatureHook } from './signature.ts';
import { registerStatusWebhook } from './status-webhook.ts';

import type { FastifyContextConfig } from 'fastify';

// Type-only, so this file opens no runtime edge back to the composition root.
import type { App, AppServices } from '../../app.ts';

/** The route's path, relative to the `/v1` prefix `app.ts` mounts the modules under (AAP 0.5.4). */
const TWIML_PATH = '/webhooks/voice/twiml';

/** The tag the route groups under: a member of `plugins/openapi.ts`'s vocabulary (AAP 0.11.2). */
const VOICE_TAG = 'webhooks';

/** The media type a TwiML document is served as, rather than the JSON every other route answers. */
const TWIML_CONTENT_TYPE = 'text/xml; charset=utf-8';

/** That media type without its `charset` parameter, which is the form an OpenAPI content key carries for this route's
 * `200`. */
const TWIML_MEDIA_TYPE = TWIML_CONTENT_TYPE.replace(/;.*$/, '');

/** The XML declaration every document here opens with, encoding included. */
const DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/** The five characters an attribute value may not carry literally; `'` is among them because the disclosures contain it
 * and an unescaped value would be refused by the parser rather than spoken. */
const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

const XML_ESCAPE_RE = /[&<>"']/g;

/**
 * Escape one value for use inside an XML attribute. Every attribute this file writes goes through it, fixed values
 * included: one rule for all of them cannot be forgotten for the one that needed it.
 */
export function xmlEscape(value: string): string {
  return value.replace(XML_ESCAPE_RE, (character) => XML_ESCAPES[character] ?? character);
}

export interface SpeechProvider {
  readonly ttsProvider: 'Google' | 'ElevenLabs';
  readonly transcriptionProvider: 'Deepgram';
  /** The transcriber's model: `nova-3-general` is Deepgram's default and covers every launch language but Thai, which
   * `nova-2-general` serves. */
  readonly speechModel: 'nova-2-general' | 'nova-3-general';
}

/**
 * The speech pairing each call language opens in, confirmed against Twilio's ConversationRelay voice configuration.
 * Which pairing a call opens in is the city's own property — `City.callLanguage` — and this table says only how that
 * pairing is spoken and transcribed.
 */
export const SPEECH_PROVIDERS: Readonly<Record<CallLanguage, SpeechProvider>> = {
  'en-US': {
    ttsProvider: 'ElevenLabs',
    transcriptionProvider: 'Deepgram',
    speechModel: 'nova-3-general',
  },
  'es-US': {
    ttsProvider: 'ElevenLabs',
    transcriptionProvider: 'Deepgram',
    speechModel: 'nova-3-general',
  },
  'pt-PT': {
    ttsProvider: 'Google',
    transcriptionProvider: 'Deepgram',
    speechModel: 'nova-3-general',
  },
  'id-ID': {
    ttsProvider: 'ElevenLabs',
    transcriptionProvider: 'Deepgram',
    speechModel: 'nova-3-general',
  },
  'th-TH': {
    ttsProvider: 'Google',
    transcriptionProvider: 'Deepgram',
    speechModel: 'nova-2-general',
  },
};

export interface TwimlOptions {
  readonly relayUrl: string;
  readonly language: CallLanguage;
  readonly welcomeGreeting: string;
  readonly attemptId: string;
}

function languageElement(code: CallLanguage, provider: SpeechProvider): string {
  return (
    `<Language code="${xmlEscape(code)}"` +
    ` ttsProvider="${xmlEscape(provider.ttsProvider)}"` +
    ` transcriptionProvider="${xmlEscape(provider.transcriptionProvider)}"` +
    ` speechModel="${xmlEscape(provider.speechModel)}"/>`
  );
}

/**
 * The TwiML that answers an answered call and opens the ConversationRelay dialogue. The document declares the city's
 * pairing and `en-US` — the pairing the dialogue switches to when the callee prefers English — and no more, so a session
 * cannot be moved to a language this API holds no templates for. `dtmfDetection="false"` states the default explicitly,
 * and partial prompts are not enabled, so every prompt the socket delivers is a final transcription.
 */
export function renderTwiml(options: TwimlOptions): string {
  const { relayUrl, language, welcomeGreeting, attemptId } = options;
  const provider = SPEECH_PROVIDERS[language];
  const languages = [languageElement(language, provider)];
  if (language !== 'en-US') {
    languages.push(languageElement('en-US', SPEECH_PROVIDERS['en-US']));
  }
  return (
    `${DECLARATION}\n` +
    '<Response><Connect>' +
    `<ConversationRelay url="${xmlEscape(relayUrl)}"` +
    ` welcomeGreeting="${xmlEscape(welcomeGreeting)}"` +
    ' welcomeGreetingInterruptible="none"' +
    ` language="${xmlEscape(language)}"` +
    ` ttsProvider="${xmlEscape(provider.ttsProvider)}"` +
    ` transcriptionProvider="${xmlEscape(provider.transcriptionProvider)}"` +
    ` speechModel="${xmlEscape(provider.speechModel)}"` +
    ' dtmfDetection="false">' +
    `\n  ${languages.join('\n  ')}` +
    `\n  <Parameter name="${VOICE_ATTEMPT_PARAMETER}" value="${xmlEscape(attemptId)}"/>` +
    '\n</ConversationRelay></Connect></Response>'
  );
}

/**
 * The TwiML that ends a call this API will not converse with: `<Hangup/>` rather than an empty document, because the
 * call is answered and Twilio expects a verb, and nothing is spoken.
 */
export function renderHangup(): string {
  return `${DECLARATION}<Response><Hangup/></Response>`;
}

/**
 * Re-exported unchanged so the file's public surface stays what it was: `packages/shared`'s {@link isMachineAnswer} has
 * the one definition, because the workers' reconciliation reads the same verdicts and cannot import this process.
 */
export { isMachineAnswer };

interface TwimlDecision {
  readonly result: 'relay' | 'hangup';
  readonly xml: string;
}

const HANGUP: TwimlDecision = { result: 'hangup', xml: renderHangup() };

/** What an unanswered call produced: an outcome and no data, because nothing was asked — `transcript: null` for the same
 * reason a lodging call always stores none. */
const UNANSWERED: AttemptResult = {
  outcome: 'no_answer',
  confidence: null,
  extractedFields: null,
  summary: null,
  transcript: null,
};

/**
 * The one route flag the composition root reads to let a route answer bytes rather than a serialized DTO; it is set on
 * the two routes that do — this one, whose XML no Zod schema describes, and the photo route.
 */
const RAW_XML_RESPONSE = { rawResponse: true } as FastifyContextConfig;

/**
 * The state an attempt that adopted its `CallSid` on this signed fetch moves to: a TwiML fetch is evidence that the call
 * exists and was answered, which is what `dialing` says. Any other state stands, because the state only ever moves
 * forward.
 */
function adoptedState(state: CallAttemptState): CallAttemptState {
  return state === 'dispatching' || state === 'dispatch_unknown' ? 'dialing' : state;
}

/**
 * Registers the voice agent on the context `app.ts` mounts under `/v1`. The order is load-bearing: `@fastify/formbody`
 * comes first, because every Twilio callback arrives as `application/x-www-form-urlencoded`, which Fastify 5 does not
 * parse by default, and registering it here rather than on the root scopes that parser. This function is deliberately not
 * wrapped in `fastify-plugin`: its encapsulation is what keeps these three routes out of every other module's context.
 */
export async function voiceAgentRoutes(app: App): Promise<void> {
  await app.register(formbody);
  registerTwimlRoute(app);
  registerStatusWebhook(app);
  registerVoiceRelay(app);
}

/**
 * Registers `POST /webhooks/voice/twiml?attemptId=`.
 *
 * The route carries no bearer guard and no age gate: a provider signed it, so there is no caller to authenticate. It
 * takes the webhook per-IP counter alone, at the higher provider allowance, because the requests arrive from a handful of
 * Twilio addresses.
 *
 * The signature is checked in `preValidation`, before the schemas: it covers every field Twilio posted, including those a
 * schema would rewrite, so it has to run over the parsed body rather than the validated one.
 */
function registerTwimlRoute(app: App): void {
  app.post(
    TWIML_PATH,
    {
      ...webhookLimits(app),
      preValidation: twilioSignatureHook('http'),
      schema: {
        tags: [VOICE_TAG],
        querystring: VoiceCallbackQuery,
        body: TwilioTwimlRequest,
        // The document describes what this route answers: the `200` under the media type the reply carries — a
        // content-typed entry, the shape that keeps a success answer for a body no Zod schema describes — and the `400`
        // the signature hook raises before the schemas.
        response: {
          200: { content: { [TWIML_MEDIA_TYPE]: { schema: z.string() } } },
          400: ErrorEnvelope,
        },
      },
      config: RAW_XML_RESPONSE,
    },
    async (request, reply) => {
      const { attemptId } = request.query;
      const decision = await decideTwiml(app.services, attemptId, request.body);
      // The one line this route writes: the event, the attempt id and which answer it gave. Never a
      // `CallSid`, a phone number, a posted field or a URL (AAP 0.11.1).
      request.log.info({ event: 'voice_twiml', attemptId, result: decision.result }, 'voice_twiml');
      return reply.type(TWIML_CONTENT_TYPE).send(decision.xml);
    },
  );
}

/**
 * Decide what Twilio's fetch is answered with, in one transaction.
 *
 *  1. **Lock the attempt** ({@link lockAttempt}), which serializes this fetch against the relay socket's own adoption of
 *     the same attempt, the status callbacks and the workers' reconciliation. An attempt that is gone, or whose call
 *     content was stripped, is answered `<Hangup/>` with nothing written.
 *  2. **Adopt the `CallSid`** ({@link adoptCallSid}), or refuse a fetch that is not this attempt's.
 *  3. **Read the call** ({@link loadCallContext}): a call missing its task, its target or its city has no language to
 *     speak in and no budget to release against, so it is answered `<Hangup/>` and the workers pick the attempt up as
 *     `needs_review`.
 *  4. **Hand the call to the relay, or hang up**: a machine answered, the task is no longer `in_progress`, or the attempt
 *     was superseded mid-call — all three record `no_answer` through {@link recordAttemptOutcome}, which writes the single
 *     `apply_call_result` row in this transaction and releases the unused dialogue budget after the commit.
 *
 * Nothing here ends the attempt: `endedAt` is Twilio's status callback's to stamp.
 */
async function decideTwiml(
  services: AppServices,
  attemptId: string,
  body: TwilioTwimlRequest,
): Promise<TwimlDecision> {
  return transact(services, async (tx, after) => {
    const attempt = await lockAttempt(tx, attemptId);
    if (attempt === null || isStripped(attempt)) {
      return HANGUP;
    }
    if ((await adoptCallSid(tx, attempt, body.CallSid)) === 'refused') {
      return HANGUP;
    }
    const call = await loadCallContext(services.db, attemptId);
    if (call === null) {
      return HANGUP;
    }
    if (
      isMachineAnswer(body.AnsweredBy) ||
      attempt.superseded ||
      call.task.status !== 'in_progress'
    ) {
      // The whole budget is unused, because a call that never reaches the dialogue holds no turn of
      // it (AAP 0.5.6); the reservation's amount is the attempt's own reserved micros.
      const reservation = reservationFor(services, call);
      await recordAttemptOutcome(tx, services, after, attempt, UNANSWERED, {
        reservation,
        unusedMicros: reservation.micros,
      });
      return HANGUP;
    }
    return {
      result: 'relay',
      xml: renderTwiml({
        relayUrl: publicRelayUrl(services.env),
        language: call.city.callLanguage,
        welcomeGreeting: disclosureFor(call.task.kind, call.city.callLanguage),
        attemptId,
      }),
    };
  });
}

/**
 * Adopt this fetch's `CallSid` on the attempt, or refuse the fetch. Three answers, and only one of them lets the fetch
 * open a dialogue: `'matches'` — the attempt already holds this `CallSid`; `'adopted'` — the attempt holds none, and this
 * signed fetch is the evidence AAP 0.3.2 accepts for a dispatch whose outcome was uncertain and what `./relay-ws.ts`
 * compares the socket's own `CallSid` against; `'refused'` — the attempt holds a different `CallSid`, or another attempt
 * already holds this one, so the fetch is answered `<Hangup/>` and nothing is written.
 *
 * The current owner is looked up before the update rather than left to the unique index, because a unique violation
 * inside the transaction aborts it; the index is still the guarantee, since the catch below treats its violation as the
 * same refusal, so two fetches racing to adopt one `CallSid` cannot both succeed.
 */
async function adoptCallSid(
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
  if (owner !== null) {
    return 'refused';
  }
  try {
    await tx.callAttempt.update({
      where: { id: attempt.id },
      data: { twilioCallSid: callSid, state: adoptedState(attempt.state) },
    });
    return 'adopted';
  } catch (error) {
    // Another fetch took this `CallSid` first. Nothing of this fetch was written, so the aborted
    // transaction rolls back to the state it found and the fetch is answered without effect.
    if (isUniqueViolation(error, 'twilio_call_sid')) {
      return 'refused';
    }
    throw error;
  }
}
