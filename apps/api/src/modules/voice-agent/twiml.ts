/**
 * The ConversationRelay TwiML an answered call is given, and the encapsulated voice-agent context
 * every Twilio URL is served from: `POST /v1/webhooks/voice/twiml?attemptId=` (AAP 0.3.3, 0.5.4,
 * 0.5.6).
 *
 * Twilio fetches this once a call is answered, form encoded, carrying the `CallAttempt` id in the
 * query the dispatcher built the URL with. The answer is either a `<Connect><ConversationRelay>`
 * document that opens the socket `./relay-ws.ts` serves, or a bare `<Hangup/>` for a call this API
 * must not hold a conversation with. No Twilio REST call is made anywhere here: dialing belongs to
 * `apps/workers`.
 *
 * Three rules are what make the dialogue safe and the call traceable:
 *
 *  - **The disclosure comes first, in the callee's language.** The `welcomeGreeting` is
 *    `./dialogue.ts`'s {@link disclosureFor}, and `welcomeGreetingInterruptible="none"` is what makes
 *    the callee hear all of it before anything is asked (AAP 0.5.6). No recording and no
 *    `intelligenceService` appears, so no audio and no provider transcript of a call is stored.
 *  - **Every speech provider and model is written out**, on the root and on each `<Language>`: a
 *    `<Language>` whose `code` matches the root's `language` inherits the root's values, and Twilio's
 *    own root default for `transcriptionProvider` depends on the account's age. The pairing a call
 *    runs in is therefore a property of {@link SPEECH_PROVIDERS}, not of the dialling account
 *    (AAP 0.2.4, 0.5.6).
 *  - **A call with nobody to talk to hangs up and records `no_answer`**: an answering machine, a task
 *    that is no longer `in_progress` (cancelled, terminal, or waiting for an operator) and an attempt
 *    superseded mid-call. The outcome goes through `./dialogue.ts`'s {@link recordAttemptOutcome},
 *    the one writer of an attempt's outcome (AAP 0.5.3); the attempt stays open for Twilio's status
 *    callback to end.
 *
 * The attempt id ties the three surfaces of one call together: it is this route's query parameter,
 * the `<Parameter>` the relay socket reads its attempt from, and the evidence that adopts a
 * `dispatch_unknown` attempt (AAP 0.3.2). Its name, and the name of the parameter `apps/workers`'
 * dispatcher puts in both URLs, is `packages/shared`'s {@link VOICE_ATTEMPT_PARAMETER}: one
 * definition, imported by both processes. This route therefore adopts the fetch's `CallSid` and
 * `./relay-ws.ts` refuses a socket whose `CallSid` is not the adopted one.
 *
 * A refusal is either the shared envelope — `400 bad_signature` from the signature hook, which runs
 * before the schemas so a wrongly signed body is never validated, and `400 invalid_field` for a query
 * or body the schemas reject — or, for a reason only this file knows, `<Hangup/>` with `200`: Twilio
 * has to be told what to do with a call it has already placed. The one line logged carries the event,
 * the attempt id and which answer was given, never a `CallSid`, a phone number or a posted field
 * (AAP 0.11.1).
 *
 * @see AAP 0.3.2 for dispatch, adoption and reconciliation, 0.3.3 for the form parser Twilio's
 *   callbacks need, 0.5.4 for the route and its per-IP limit, 0.5.6 for the disclosure and the
 *   dialogue rules, and 0.8.1 for this file.
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

// Type-only, so this file opens no runtime edge back to the composition root: `App` and `AppServices`
// are the plan's one declaration of the instance and of what it hands its modules, as in every
// sibling module of `apps/api/src`.
import type { App, AppServices } from '../../app.ts';

/** The route's path, relative to the `/v1` prefix `app.ts` mounts the modules under (AAP 0.5.4). */
const TWIML_PATH = '/webhooks/voice/twiml';

/** The tag the route groups under: a member of `plugins/openapi.ts`'s vocabulary (AAP 0.11.2). */
const VOICE_TAG = 'webhooks';

/** The media type a TwiML document is served as, rather than the JSON every other route answers. */
const TWIML_CONTENT_TYPE = 'text/xml; charset=utf-8';

/**
 * That media type without its `charset` parameter, which is the form an OpenAPI content key carries:
 * the key this route's `200` is declared under in the emitted document (AAP 0.11.2).
 */
const TWIML_MEDIA_TYPE = TWIML_CONTENT_TYPE.replace(/;.*$/, '');

/** The XML declaration every document here opens with, encoding included. */
const DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/**
 * The five characters an attribute value may not carry literally. `'` is among them because the
 * disclosures contain it — "to confirm a guest's stay" — and an unescaped value would be refused by
 * the parser rather than spoken.
 */
const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** The characters {@link xmlEscape} replaces. */
const XML_ESCAPE_RE = /[&<>"']/g;

/**
 * Escape one value for use inside an XML attribute (AAP 0.5.6).
 *
 * Every attribute this file writes goes through it, fixed values included: one rule for all of them
 * cannot be forgotten for the one that needed it.
 *
 * @param value - The text to escape.
 * @returns The text with the five XML-significant characters replaced by their entities.
 */
export function xmlEscape(value: string): string {
  return value.replace(XML_ESCAPE_RE, (character) => XML_ESCAPES[character] ?? character);
}

/** One speech pairing: the text-to-speech provider, the transcriber and its model (AAP 0.2.4). */
export interface SpeechProvider {
  /** Twilio's text-to-speech provider for the language. */
  readonly ttsProvider: 'Google' | 'ElevenLabs';
  /** Twilio's speech-to-text provider for the language. */
  readonly transcriptionProvider: 'Deepgram';
  /**
   * The transcriber's model: `nova-3-general` is Deepgram's default and covers every launch language
   * but Thai, which `nova-2-general` serves.
   */
  readonly speechModel: 'nova-2-general' | 'nova-3-general';
}

/**
 * The speech pairing each call language opens in, confirmed against
 * twilio.com/docs/voice/conversationrelay/voice-configuration (AAP 0.2.4, 0.5.6).
 *
 * Which pairing a call opens in is the city's own property — `City.callLanguage`, loaded from
 * `config/cities.json` — and Mexico City and Medellín use `es-US`, the Latin American Spanish
 * pairing. This table says only how that pairing is spoken and transcribed.
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

/** What {@link renderTwiml} needs: the socket to open, the language, the first line and the call. */
export interface TwimlOptions {
  /** The public `wss://` relay address, from `./signature.ts`'s `publicRelayUrl`. */
  readonly relayUrl: string;
  /** The city's speech pairing, which is also the language its disclosure is written in. */
  readonly language: CallLanguage;
  /** The disclosure sentence the call opens with, from `./dialogue.ts`'s `disclosureFor`. */
  readonly welcomeGreeting: string;
  /** The `CallAttempt` id, handed back under {@link VOICE_ATTEMPT_PARAMETER} in the relay's setup. */
  readonly attemptId: string;
}

/** One `<Language>` entry, with its own provider and model so nothing is inherited (AAP 0.5.6). */
function languageElement(code: CallLanguage, provider: SpeechProvider): string {
  return (
    `<Language code="${xmlEscape(code)}"` +
    ` ttsProvider="${xmlEscape(provider.ttsProvider)}"` +
    ` transcriptionProvider="${xmlEscape(provider.transcriptionProvider)}"` +
    ` speechModel="${xmlEscape(provider.speechModel)}"/>`
  );
}

/**
 * The TwiML that answers an answered call and opens the ConversationRelay dialogue (AAP 0.5.6).
 *
 * The document declares the city's pairing and `en-US` — the pairing the dialogue switches to when
 * the callee prefers English — and no more, so a session cannot be moved to a language this API holds
 * no templates for. `dtmfDetection="false"` states the default explicitly, because no keypad menu is
 * served and a `dtmf` frame would be ignored, and partial prompts are not enabled, so every prompt
 * the socket delivers is a final transcription of a whole utterance.
 *
 * @param options - The socket, the pairing, the greeting and the attempt id.
 * @returns The TwiML document, ready to be served as `text/xml`.
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
 * The TwiML that ends a call this API will not converse with (AAP 0.5.3).
 *
 * `<Hangup/>` rather than an empty document: the call is answered, so Twilio expects a verb, and
 * nothing is spoken — a machine that was detected hears no question and learns nothing.
 *
 * @returns The TwiML document, ready to be served as `text/xml`.
 */
export function renderHangup(): string {
  return `${DECLARATION}<Response><Hangup/></Response>`;
}

/**
 * The machine-detection rule this route hangs up by, re-exported unchanged so the file's public
 * surface stays what it was: it is `packages/shared`'s {@link isMachineAnswer}, whose TSDoc carries
 * the AAP 0.5.3 rationale. It has one definition there because `apps/workers`' reconciliation reads
 * the same verdicts on the call it fetches and cannot import this process (AAP 0.8.1, AAP 0.11.1).
 */
export { isMachineAnswer };

// ---------------------------------------------------------------------------------------------
// The route (AAP 0.3.2, 0.3.3, 0.5.4)
// ---------------------------------------------------------------------------------------------

/** What the TwiML route decided: what to answer with, and which of the two answers it is. */
interface TwimlDecision {
  /** `relay` when the call was handed to the ConversationRelay dialogue, `hangup` otherwise. */
  readonly result: 'relay' | 'hangup';
  /** The TwiML document to answer with. */
  readonly xml: string;
}

/** The answer for every call this route will not hand to the dialogue (AAP 0.5.3). */
const HANGUP: TwimlDecision = { result: 'hangup', xml: renderHangup() };

/**
 * What an unanswered call produced (AAP 0.5.3): an outcome and no data, because nothing was asked.
 * `transcript: null` for the same reason a lodging call always stores none — there is nothing to keep
 * (AAP 0.5.2).
 */
const UNANSWERED: AttemptResult = {
  outcome: 'no_answer',
  confidence: null,
  extractedFields: null,
  summary: null,
  transcript: null,
};

/**
 * The one route flag `apps/api/src/app.ts` reads to let a route answer bytes rather than a serialized
 * DTO. It is set on the two routes that do — this one, whose XML no Zod schema describes, and
 * `GET /users/:userId/photo` — and the flag belongs to the composition root, so it is passed as a
 * context config here rather than added to the flag vocabulary from this file.
 */
const RAW_XML_RESPONSE = { rawResponse: true } as FastifyContextConfig;

/**
 * The state an attempt that adopted its `CallSid` on this signed fetch moves to (AAP 0.3.2).
 *
 * A TwiML fetch is evidence that the call exists and was answered, which is what `dialing` says, so
 * an attempt still `dispatching` (the dispatch never wrote its answer) or `dispatch_unknown` (the
 * call may exist) moves there. Any other state stands: a callback reporting `in-progress` reached the
 * attempt first, and the state only ever moves forward (AAP 0.5.3).
 */
function adoptedState(state: CallAttemptState): CallAttemptState {
  return state === 'dispatching' || state === 'dispatch_unknown' ? 'dialing' : state;
}

/**
 * Registers the voice agent on the context `app.ts` mounts under `/v1` (AAP 0.5.1, 0.3.3).
 *
 * The order is load-bearing. `@fastify/formbody` comes first, because every Twilio callback — this
 * fetch, the status callback and the relay upgrade — arrives as
 * `application/x-www-form-urlencoded`, which Fastify 5 does not parse by default. Registering it here
 * rather than on the root is what scopes that parser: `@fastify/formbody` is built on
 * `fastify-plugin`, so it applies to the instance it is registered on, and no other `/v1` route
 * begins accepting a form body (AAP 0.3.3, 0.5.4). The three surfaces of one call follow: the TwiML
 * fetch, the status webhook and the relay socket.
 *
 * This function is deliberately not wrapped in `fastify-plugin`: its encapsulation is what scopes the
 * parser and keeps these three routes out of every other module's context.
 *
 * @param app - The voice-agent context; its `services` carry the guarded database client, the
 *   injected clock, the logger, the outbox dispatcher, the spend meter, the telephony client and the
 *   configuration the public relay URL is built from.
 */
export async function voiceAgentRoutes(app: App): Promise<void> {
  await app.register(formbody);

  registerTwimlRoute(app);
  registerStatusWebhook(app);
  registerVoiceRelay(app);
}

/**
 * Registers `POST /webhooks/voice/twiml?attemptId=` (AAP 0.3.3, 0.5.4).
 *
 * The route carries no bearer guard and no age gate: a provider signed it, so there is no caller to
 * authenticate. It takes the webhook per-IP counter alone, at the higher provider allowance, because
 * the requests arrive from a handful of Twilio addresses.
 *
 * The signature is checked in `preValidation`, before the schemas: it covers every field Twilio
 * posted, including those a schema would rewrite, so it has to run over the parsed body rather than
 * the validated one. A refusal is answered `400 bad_signature` through the shared envelope instead of
 * as whichever field a schema happened to reject (AAP 0.3.3).
 *
 * @param app - The voice-agent context the route belongs to.
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
        // The document describes what this route answers (AAP 0.11.2): the `200` under the media
        // type the reply carries, and the one refusal the signature hook raises before the schemas.
        // The `200` is a content-typed entry — the shape that keeps the success answer in the
        // document for a body no Zod schema describes — and it never touches the reply, which sends
        // its XML string as it is. Naming only the `400` would drop the emitted `200` entirely.
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
 * Decide what Twilio's fetch is answered with, in one transaction (AAP 0.3.2, 0.5.3).
 *
 *  1. **Lock the attempt** ({@link lockAttempt}), which serializes this fetch against the relay
 *     socket's own adoption of the same attempt, the status callbacks and `apps/workers`'
 *     reconciliation. An attempt that is gone, or one whose call content was stripped (a failed
 *     dispatch, or a lodging attempt whose claim has resolved), is answered `<Hangup/>` with nothing
 *     written: the record exists, the call it describes does not (AAP 0.5.2).
 *  2. **Adopt the `CallSid`** ({@link adoptCallSid}), or refuse a fetch that is not this attempt's.
 *  3. **Read the call** ({@link loadCallContext}) — the task that asked for it, the place or lodging
 *     it concerns, the city's language and, for a stay call, the claim. A call missing any of them
 *     has no language to speak in and no budget to release against, so it is answered `<Hangup/>`
 *     with nothing written and `apps/workers` picks the attempt up as `needs_review`.
 *  4. **Hand the call to the relay, or hang up.** A machine answered, the task is no longer
 *     `in_progress`, or the attempt was superseded mid-call: all three record `no_answer` through
 *     {@link recordAttemptOutcome}, which writes the single `apply_call_result` row in this
 *     transaction and releases the call's unused dialogue budget after the commit, from the
 *     reservation {@link reservationFor} rebuilds against the city's own local day.
 *
 * Nothing here ends the attempt: `endedAt` is Twilio's status callback's to stamp (AAP 0.5.3).
 *
 * @param services - The app's services: the database, the clock, the logger, the outbox dispatcher,
 *   the spend meter, the city zone lookup and the configuration the relay URL comes from.
 * @param attemptId - The `CallAttempt` id from the fetch's query string.
 * @param body - The validated fetch, whose `AnsweredBy` carries the machine-detection verdict.
 * @returns The document to answer with, and whether it opens a relay.
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
 * Adopt this fetch's `CallSid` on the attempt, or refuse the fetch (AAP 0.3.2).
 *
 * Three answers, and only one of them lets the fetch open a dialogue:
 *
 *  - `'matches'` — the attempt already holds this `CallSid`, so nothing is adopted.
 *  - `'adopted'` — the attempt holds none. This signed fetch, carrying the attempt id the dispatcher
 *    put in the URL, is the evidence AAP 0.3.2 accepts for a dispatch whose outcome was uncertain,
 *    and it is also what `./relay-ws.ts` compares the socket's own `CallSid` against.
 *  - `'refused'` — the attempt holds a different `CallSid`, or another attempt already holds this
 *    one. Either way this is not this attempt's call, so the fetch is answered `<Hangup/>` and nothing
 *    is written.
 *
 * The current owner is looked up before the update rather than left to the unique index, because a
 * unique violation raised inside the transaction aborts it — PostgreSQL refuses every later statement
 * of an aborted transaction — and the driver reports the violation as an error where this case is an
 * ordinary one. The index is still the guarantee: the catch below treats its violation as the same
 * refusal, so two fetches racing to adopt one `CallSid` cannot both succeed.
 *
 * @param tx - The transaction, with the attempt already locked.
 * @param attempt - The locked attempt row.
 * @param callSid - The `CallSid` this fetch carries.
 * @returns Which of the three cases this fetch is.
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
