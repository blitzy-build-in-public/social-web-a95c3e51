/**
 * The scripted telephony simulator: Twilio's own side of an automated call, played in-process
 * (AAP 0.5.6, AAP 0.11.2).
 *
 * A call the product dispatches is played out here rather than placed. The create returns a SID, and
 * the lifecycle then posts the signed status callbacks Twilio would post, fetches the
 * ConversationRelay TwiML from the API, opens the relay socket and sends each scripted utterance as a
 * `prompt` frame until the API closes the session. The suite therefore gets a deterministic call — an
 * answer, a script, a refusal, a machine, a busy line or a dropped connection — and asserts what the
 * API did with it (AAP 0.12.1 criteria 12, 14 and 17).
 *
 * Two behaviours here are deliberate and load-bearing:
 *
 *  - **Every request is signed over the URL Twilio would have called, and sent to the API's real
 *    address.** `API_PUBLIC_URL` is what the API rebuilds its signature check from
 *    (`src/modules/voice-agent/signature.ts`), so signing the public URL is the only way a signature
 *    can ever match; the HTTP posts and the socket go to `targetUrl` — a `TestApp.listen()` base URL,
 *    or the compose service address — so a suite runs with no public hostname. A create URL whose
 *    origin is not `apiPublicUrl` is recorded as a failure and still signed exactly as given, because
 *    that is what Twilio would do with it.
 *  - **The simulator waits for the agent's turn before every prompt.** ConversationRelay speaks first
 *    (the TwiML's `welcomeGreeting`, then the dialogue's first question), and each scripted utterance
 *    is an answer to the question the API just asked, which is what makes a turn's classification
 *    unambiguous. A turn the agent never answers within `stepTimeoutMs` is recorded as `agent_timeout`
 *    and the session is closed, so a broken dialogue fails fast instead of hanging a suite.
 *
 * Nothing here logs a phone number, a signature, an utterance or the auth token, and no failure is
 * thrown into an unrelated test: everything the lifecycle could not do is recorded on the call as a
 * failure carrying a step name, a status or an error code (AAP 0.11.1, AAP 0.12.2). The auth token is
 * `TWILIO_SIMULATOR.authToken`, a published test value, and it is never written out here.
 *
 * State lives in each {@link createVoiceSimulator} closure, because a suite runs two app instances in
 * one process: each gets its own call store, target, scenario map and vendor switch.
 *
 * `vendor-down` is an in-process scenario only. A refused connection is what makes a dispatch
 * *definite* (server-core classifies `ECONNREFUSED` that way), and a connection already accepted
 * cannot produce one — so criterion 17's isolation check runs through the injected HTTP client, where
 * {@link vendorDownError} is thrown before any call exists, and the standalone server refuses to serve
 * that scenario at all.
 *
 * @see AAP 0.5.6 for the simulator, the scripts, the caps and the disclosure; AAP 0.3.2 for the
 *   relay-refusal semantics and the dispatch reconciliation; AAP 0.3.3 for the Twilio integration row
 *   and the signature check; AAP 0.6.2 for `TELEPHONY_MODE=simulator`, `VOICE_SIM_URL` and the fixed
 *   non-secret token; AAP 0.11.2 for the suites that use it; AAP 0.12.2 for disclosure first and
 *   `record: false`.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import WebSocket from 'ws';
import { z } from 'zod';

import {
  CALL_STATUS_CALLBACK_EVENTS,
  TWILIO_SIMULATOR,
  type FakeLlmOptions,
  type LlmRequest,
  type TwilioHttpClient,
  type TwilioHttpMethod,
  type TwilioHttpRequest,
} from '@tablemate/server-core';
import {
  CallLanguage,
  E164,
  RelayInboundFrame,
  RelayOutboundFrame,
  TwilioStatusCallback,
  TwilioTwimlRequest,
  type TwilioCallStatus,
} from '@tablemate/shared';

import {
  CLASSIFICATION_JSON_SCHEMA,
  UTTERANCE_LABELS,
} from '../../../src/modules/voice-agent/understanding.ts';

import {
  createSimulatorHttpClient,
  handleTwilioRequest,
  parseTwilioForm,
  vendorDownError,
  type SimCallCreateParams,
  type SimCallListFilter,
  type SimCallResource,
  type SimCallTarget,
} from './twilio-http-client.ts';

import budgetExhaustion from './scenarios/budget-exhaustion.json' with { type: 'json' };
import busyScenario from './scenarios/busy.json' with { type: 'json' };
import doNotCallScenario from './scenarios/do-not-call.json' with { type: 'json' };
import dropMidScriptScenario from './scenarios/drop-mid-script.json' with { type: 'json' };
import englishSwitchScenario from './scenarios/english-switch.json' with { type: 'json' };
import noAnswerScenario from './scenarios/no-answer.json' with { type: 'json' };
import noScenario from './scenarios/no.json' with { type: 'json' };
import pricesHighScenario from './scenarios/prices-high.json' with { type: 'json' };
import pricesLowScenario from './scenarios/prices-low.json' with { type: 'json' };
import stopScenario from './scenarios/stop.json' with { type: 'json' };
import vendorDownScenario from './scenarios/vendor-down.json' with { type: 'json' };
import yesScenario from './scenarios/yes.json' with { type: 'json' };

// ---------------------------------------------------------------------------------------------
// The Twilio request signature (AAP 0.3.3)
// ---------------------------------------------------------------------------------------------

/**
 * Twilio's request signature for a URL and its posted fields (AAP 0.3.3): a base64 HMAC-SHA1, keyed
 * by the account's auth token, over the URL followed by each parameter name and value concatenated in
 * ascending key order. The simulator computes it locally — the `twilio` SDK is imported only by
 * `packages/server-core/src/telephony/twilio-client.ts` (AAP 0.11.1) — and so can a test that wants to
 * forge or tamper with one.
 *
 * A relay upgrade carries no fields and a socket is signed over its URL alone, which is why `params`
 * defaults to empty and why the default auth token is {@link TWILIO_SIMULATOR}'s published test value
 * rather than a secret (AAP 0.6.2).
 *
 * @param url - The URL exactly as the provider would call it: the public address, query string and
 *   all, never the address the simulator sends the request to.
 * @param params - Every field of the request, as strings; empty for a WebSocket upgrade.
 * @param authToken - The signing token; the simulator's own by default.
 * @returns The base64 signature for the `X-Twilio-Signature` header.
 */
export function twilioSignature(
  url: string,
  params: Record<string, string> = {},
  authToken: string = TWILIO_SIMULATOR.authToken,
): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + (params[key] ?? '');
  }
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

// ---------------------------------------------------------------------------------------------
// Scenarios (AAP 0.5.6, AAP 0.11.2)
// ---------------------------------------------------------------------------------------------

/**
 * The twelve scripts one call can play, in `./scenarios/<name>.json` (AAP 0.8.1): three price calls, a
 * lodging yes and no, an unanswered line, a busy line, a drop mid-script, a refusal, a do-not-call
 * request, a switch to English, a dialogue that never progresses and a down vendor.
 */
export const SCENARIO_NAMES = [
  'prices-high',
  'prices-low',
  'yes',
  'no',
  'no-answer',
  'busy',
  'drop-mid-script',
  'stop',
  'do-not-call',
  'english-switch',
  'budget-exhaustion',
  'vendor-down',
] as const;

/** One scripted scenario's name, which is also its file's stem under `./scenarios/`. */
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** How a scripted call is answered, before any turn is spoken. */
const ScenarioAnswer = z.enum(['human', 'machine', 'no-answer', 'busy', 'failed']);

/** How a scripted call ends, which is the `CallStatus` its final callback carries. */
const ScenarioFinalStatus = z.enum(['completed', 'no-answer', 'busy', 'failed']);

/** The answers that produce no turn at all: the line was never picked up, so nothing is asked. */
const UNANSWERED_ANSWERS: readonly z.infer<typeof ScenarioAnswer>[] = [
  'no-answer',
  'busy',
  'failed',
];

/** One value a classification may carry, mirroring the classifier's strict schema. */
const ScenarioClassifyValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * What the classifier answers for one scripted utterance, and the values it reads back (AAP 0.5.6).
 * `values` carries only the fields the turn really said, and `classify` is absent when the turn is not
 * classified at all — a turn whose words the model cannot use, which is what `unclear` is for.
 *
 * The label set is the classifier's own exported vocabulary, `UTTERANCE_LABELS`, rather than a copy:
 * a turn's scripted label is therefore always one `understanding.ts` can read, and the two cannot
 * drift apart.
 */
const ScenarioClassify = z.strictObject({
  label: z.enum(UTTERANCE_LABELS),
  values: z.record(z.string(), ScenarioClassifyValue).optional(),
});

/**
 * One utterance the callee makes, and the classification the agent's classifier must read from it
 * (AAP 0.5.6). `lang` is the language the utterance is spoken in, as a real transcription carries it;
 * the turn without one is spoken in the language the call is in.
 */
const ScenarioTurnSchema = z.strictObject({
  say: z.string().min(1).max(500),
  lang: CallLanguage.optional(),
  classify: ScenarioClassify.optional(),
});

/** One scripted call: how it answers, what it says, and how it ends (AAP 0.5.6). */
const ScenarioSchema = z.strictObject({
  name: z.string(),
  answer: ScenarioAnswer,
  /** `down` marks the vendor switch this scenario's calls refuse with (AAP 0.12.1 criterion 17). */
  vendor: z.literal('down').optional(),
  /** The language the callee speaks; the city's own language comes from the TwiML (AAP 0.5.6). */
  language: CallLanguage.optional(),
  turns: z.array(ScenarioTurnSchema),
  /** Drop the socket abruptly once this many prompts have been sent, leaving partial data. */
  dropAfterTurn: z.number().int().min(1).optional(),
  /** Keep repeating the last turn — a callee who never answers the question (AAP 0.5.6). */
  loopLastTurn: z.boolean().optional(),
  finalStatus: ScenarioFinalStatus,
  /** Twilio's terminal error code, for a call that failed rather than completed. */
  errorCode: z.number().int().optional(),
  durationSec: z.number().int().min(0),
});

/** One utterance of a scenario, with the classification its words must produce. */
export type ScenarioTurn = z.infer<typeof ScenarioTurnSchema>;

/** One scripted call, parsed and validated. */
export type Scenario = z.infer<typeof ScenarioSchema>;

/** Each scenario payload by name; the key is checked against the file's own `name` at load. */
const SCENARIO_SOURCES: Readonly<Record<ScenarioName, unknown>> = {
  'prices-high': pricesHighScenario,
  'prices-low': pricesLowScenario,
  yes: yesScenario,
  no: noScenario,
  'no-answer': noAnswerScenario,
  busy: busyScenario,
  'drop-mid-script': dropMidScriptScenario,
  stop: stopScenario,
  'do-not-call': doNotCallScenario,
  'english-switch': englishSwitchScenario,
  'budget-exhaustion': budgetExhaustion,
  'vendor-down': vendorDownScenario,
};

/** The parsed scenarios, built on the first {@link loadScenarios} call and reused after that. */
let parsedScenarios: ReadonlyMap<ScenarioName, Scenario> | null = null;

/**
 * The names of the properties of the classifier's structured-output schema (AAP 0.5.6).
 *
 * Read from {@link CLASSIFICATION_JSON_SCHEMA} rather than listed here, because
 * `@tablemate/server-core` types its `schema` as a plain record: a reply that omitted a property the
 * schema requires would be unusable, so the simulator mirrors whatever the classifier declares instead
 * of a copy that can drift from it.
 */
const CLASSIFICATION_PROPERTIES: readonly string[] = readClassificationProperties();

/** The property names of the classifier's schema object, ordered as the schema declares them. */
function readClassificationProperties(): readonly string[] {
  const properties = CLASSIFICATION_JSON_SCHEMA.schema['properties'];
  if (typeof properties !== 'object' || properties === null) {
    return [];
  }
  return Object.freeze(Object.keys(properties as Record<string, unknown>));
}

/**
 * Every scripted scenario, parsed and validated on the first call (AAP 0.11.2).
 *
 * Lazy on purpose: importing this module has no side effect, so a unit suite that only wants
 * {@link scenarioClassifier} or {@link twilioSignature} still parses nothing, and a broken scenario
 * file fails the suite that reads it with that file named.
 *
 * @returns The scenarios by name, immutable and shared by every simulator in the process.
 * @throws Error when a scenario file does not match {@link ScenarioSchema}, when its `name` disagrees
 *   with its file, when a rule the plain schema cannot express is broken (a human answer with no
 *   turns, a drop beyond the last turn, a duration on an unanswered call, a classification value the
 *   classifier's schema does not declare), or when two turns anywhere share identical words with
 *   different classifications — which would make {@link scenarioClassifier} ambiguous.
 */
export function loadScenarios(): ReadonlyMap<ScenarioName, Scenario> {
  if (parsedScenarios !== null) {
    return parsedScenarios;
  }

  const scenarios = new Map<ScenarioName, Scenario>();
  for (const name of SCENARIO_NAMES) {
    const file = `./scenarios/${name}.json`;
    const parsed = ScenarioSchema.safeParse(SCENARIO_SOURCES[name]);
    if (!parsed.success) {
      throw new Error(`${file} is not a valid scenario: ${describeIssues(parsed.error)}`);
    }
    if (parsed.data.name !== name) {
      throw new Error(`${file} names the scenario "${parsed.data.name}"`);
    }
    assertScenarioRules(parsed.data, file);
    scenarios.set(name, parsed.data);
  }
  assertUnambiguousTurns(scenarios);

  parsedScenarios = scenarios;
  return scenarios;
}

/**
 * Enforce the scenario rules a plain object schema cannot state, each reported with its file.
 *
 * These are the refinements AAP 0.8.1 gives the scenario shape, plus the one the classifier depends
 * on: a `classify.values` key has to be a property of the classification schema, because a value the
 * schema does not declare would be dropped by `understanding.ts`'s strict parse and the turn would
 * read as `unclear`. They run here rather than as a Zod refinement so the error can name the file the
 * scenario came from.
 */
function assertScenarioRules(scenario: Scenario, file: string): void {
  const answered = !UNANSWERED_ANSWERS.includes(scenario.answer);
  if (scenario.answer === 'human' && scenario.turns.length === 0 && scenario.vendor === undefined) {
    throw new Error(`${file} answers as a human but scripts no turn`);
  }
  if (scenario.dropAfterTurn !== undefined && scenario.dropAfterTurn > scenario.turns.length) {
    throw new Error(
      `${file} drops after turn ${scenario.dropAfterTurn} of ${scenario.turns.length}`,
    );
  }
  if (!answered && scenario.durationSec !== 0) {
    throw new Error(`${file} answers "${scenario.answer}" but lasts ${scenario.durationSec}s`);
  }
  for (const [index, turn] of scenario.turns.entries()) {
    for (const key of Object.keys(turn.classify?.values ?? {})) {
      if (!CLASSIFICATION_PROPERTIES.includes(key)) {
        throw new Error(`${file} turn ${index + 1} classifies the unknown value "${key}"`);
      }
    }
  }
}

/**
 * Refuse two turns that say the same thing but are classified differently.
 *
 * {@link scenarioClassifier} finds a turn by its words, so identical words with two classifications
 * would make a call's answer depend on which scenario the classifier visited first. Identical words
 * classified identically are fine and are not reported.
 */
function assertUnambiguousTurns(scenarios: ReadonlyMap<ScenarioName, Scenario>): void {
  const seen = new Map<string, string>();
  for (const [name, scenario] of scenarios) {
    for (const turn of scenario.turns) {
      const classify = JSON.stringify(turn.classify ?? null);
      const previous = seen.get(turn.say);
      if (previous === undefined) {
        seen.set(turn.say, classify);
      } else if (previous !== classify) {
        throw new Error(`the scripted utterance "${turn.say}" is classified two ways (${name})`);
      }
    }
  }
}

/** A Zod failure as one line: every issue's path and message, in the order they were found. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`,
    )
    .join('; ');
}

// ---------------------------------------------------------------------------------------------
// The classifier stand-in (AAP 0.5.6, AAP 0.11.2)
// ---------------------------------------------------------------------------------------------

/**
 * The stand-in for the provider's utterance classifier, reading a scenario's own words back.
 *
 * `LLM_PROVIDER=fake` answers `{}` to every request, which would classify every turn as `unclear` and
 * leave a scripted call stuck on its first question. A suite therefore hands this function to
 * `createFakeLlmAdapter({ respond })`: it finds the last scripted utterance that appears in the
 * conversation window the caller sent and answers with that turn's classification, so a call advances
 * exactly as the scenario scripts it.
 *
 * The window is searched by whole utterance, never by keyword, and the turn whose occurrence *ends*
 * latest wins — that is the callee's most recent words, which is what makes the answer a function of
 * one turn rather than of the dialogue's whole history. Ties go to the longer utterance. A request
 * that is not a classification is answered with `{}`, the fake's own default, so menu extraction and
 * every other model user in the suite are unaffected.
 *
 * The reply carries every property the classification schema declares, each `null` first, then the
 * label, then the turn's own values: `understanding.ts` parses the reply with a strict schema in which
 * every key but the label is nullable, so a missing key would read as `unclear`. `unclear` is also
 * what a window matching no scripted turn produces.
 *
 * The function's shape satisfies `NonNullable<FakeLlmOptions['respond']>`, which its return type
 * states; it takes the request as a parameter rather than an annotation so its TSDoc documents the
 * behaviour a suite relies on.
 *
 * @param request - The request the adapter was asked to count or send.
 * @returns The scripted classification as a plain object, or `{}` for any other request.
 */
export function scenarioClassifier(
  request: LlmRequest,
): ReturnType<NonNullable<FakeLlmOptions['respond']>> {
  if (
    request.jsonSchema === undefined ||
    request.jsonSchema.name !== CLASSIFICATION_JSON_SCHEMA.name
  ) {
    return {};
  }

  const window = request.messages.map((message) => message.content).join('\n');
  const turn = lastTurnIn(window);

  const reply: Record<string, unknown> = {};
  for (const property of CLASSIFICATION_PROPERTIES) {
    reply[property] = null;
  }
  reply['label'] = turn?.classify?.label ?? 'unclear';
  for (const [key, value] of Object.entries(turn?.classify?.values ?? {})) {
    reply[key] = value;
  }
  return reply;
}

/**
 * The scripted turn whose words appear last in `window`, or `null` when none appears.
 *
 * "Last" is where the match ends rather than where it starts, so the turn the callee said most
 * recently wins even where an earlier utterance is a prefix of it.
 */
function lastTurnIn(window: string): ScenarioTurn | null {
  let best: { turn: ScenarioTurn; end: number } | null = null;
  for (const scenario of loadScenarios().values()) {
    for (const turn of scenario.turns) {
      const found = window.lastIndexOf(turn.say);
      if (found < 0) {
        continue;
      }
      const end = found + turn.say.length;
      const longer = best !== null && end === best.end && turn.say.length > best.turn.say.length;
      if (best === null || end > best.end || longer) {
        best = { turn, end };
      }
    }
  }
  return best === null ? null : best.turn;
}

// ---------------------------------------------------------------------------------------------
// What one simulated call recorded (AAP 0.11.2)
// ---------------------------------------------------------------------------------------------

/**
 * The create parameters the SDK sent, as they were observed (AAP 0.5.6).
 *
 * This is evidence about the dispatch itself rather than about the dialogue: `record` is what proves
 * recording was never requested, `timeLimit` that the call is bounded by `CAP_CALL_SECONDS`, and
 * `statusCallbackEvent` which progress events the call subscribed to (AAP 0.12.2). It is `null` for a
 * call a test started through {@link StartCallInput}, which builds its own URLs and has no create
 * request to report.
 */
export interface SimCreateParams {
  record: boolean | null;
  timeLimit: number | null;
  statusCallbackEvent: string[];
  machineDetection: string | null;
  statusCallbackMethod: string | null;
}

/** What the API answered the TwiML fetch with (AAP 0.5.6, AAP 0.5.3). */
export interface SimTwiml {
  /** The HTTP status the fetch was answered with, or `null` when the fetch never completed. */
  httpStatus: number | null;
  /** True when the document was `<Response><Hangup/></Response>`, i.e. no dialogue was offered. */
  hangup: boolean;
  /** The `ConversationRelay url` attribute: the public `wss://` address of the relay socket. */
  relayUrl: string | null;
  /** The `language` attribute, when it named a supported pairing. */
  language: CallLanguage | null;
  /** The `welcomeGreeting` attribute: the disclosure the call opens with (AAP 0.12.2). */
  welcomeGreeting: string | null;
  /** Every `<Parameter name value/>` the document carried, by name. */
  parameters: Record<string, string>;
}

/**
 * One utterance the callee heard (AAP 0.12.2): the disclosure Twilio speaks from the TwiML, or a line
 * the dialogue sent as `text` frames. Recording the greeting separately is what lets a suite assert
 * that the disclosure came first and in the city's own language.
 */
export interface SimSpokenLine {
  text: string;
  lang: CallLanguage;
  source: 'welcome_greeting' | 'text';
}

/** One mid-call language switch the dialogue asked for (AAP 0.2.4, AAP 0.5.6). */
export interface SimLanguageSwitch {
  ttsLanguage: CallLanguage;
  transcriptionLanguage: CallLanguage;
}

/** One utterance the simulator transcribed back, as a `prompt` frame (AAP 0.5.6). */
export interface SimPrompt {
  text: string;
  lang: CallLanguage;
}

/** One status callback the simulator posted, and what the API answered (AAP 0.3.2). */
export interface SimCallback {
  callStatus: TwilioCallStatus;
  sequenceNumber: number;
  /** The HTTP status the callback was answered with, or `null` when it could not be posted. */
  httpStatus: number | null;
}

/**
 * Something the simulator could not do, or something the dialogue did that no scenario asked for.
 * A failure never throws into an unrelated test: it is recorded on the call under the step it
 * happened at, and its detail carries a status, a step name or an error code — never a phone number,
 * a signature or an utterance (AAP 0.11.1).
 */
export interface SimFailure {
  step: string;
  detail: string;
}

/**
 * One simulated call: what the scenario scripted, what the API answered and what the simulator did
 * (AAP 0.11.2). A suite reads these fields after the call finishes.
 */
export interface SimCall {
  /** The `CallSid` the create returned, which the attempt adopts (AAP 0.3.2). */
  sid: string;
  /** The `CallAttempt` id both URLs carried, or `null` when they carried none. */
  attemptId: string | null;
  to: string;
  from: string;
  /** The scenario this call played. */
  scenario: ScenarioName;
  /** The create request's parameters, or `null` for a test-started call. */
  createParams: SimCreateParams | null;
  /** The status the call is in now; the final one once `done` is set. */
  status: TwilioCallStatus;
  /** Twilio's machine-detection verdict, `human` or `machine_start`, once the call was answered. */
  answeredBy: string | null;
  twiml: SimTwiml;
  /** Everything the callee heard, in order; the disclosure greeting first when there was one. */
  spoken: SimSpokenLine[];
  languageSwitches: SimLanguageSwitch[];
  promptsSent: SimPrompt[];
  /** True once the dialogue sent its `end` frame. */
  endReceived: boolean;
  /** The `handoffData` the `end` frame carried, when it carried any. */
  endHandoffData: string | null;
  /** The code the relay socket closed with, when it closed at all. */
  relayCloseCode: number | null;
  /** The HTTP status a refused relay upgrade was answered with, when it was refused. */
  relayRefusedStatus: number | null;
  callbacks: SimCallback[];
  failures: SimFailure[];
  warnings: SimFailure[];
  /** The status the call settled at, or `null` while it is still running. */
  finalStatus: TwilioCallStatus | null;
  /** The call's length in seconds, as `CallDuration` reported it. */
  durationSec: number | null;
  /** True once the lifecycle has finished, whether it completed or was aborted. */
  done: boolean;
  /** True when {@link VoiceSimulator.reset} or {@link VoiceSimulator.close} ended the call. */
  aborted: boolean;
}

/**
 * A call a test starts directly, without a Twilio create (AAP 0.11.2).
 *
 * It builds the two URLs the dispatcher would have built, from `apiPublicUrl` and the attempt id, and
 * subscribes to all four progress events, so a suite can drive a call whose `CallAttempt` it created
 * itself — which is how the relay, the outcome and the refusal paths are tested without the dispatch
 * queue in the loop.
 */
export interface StartCallInput {
  /** The `CallAttempt` id both URLs carry, the evidence that adopts the call (AAP 0.3.2). */
  attemptId: string;
  /** The number to call, in E.164. */
  to: string;
  /** The caller id; {@link TWILIO_SIMULATOR}'s number by default. */
  from?: string;
  /** The scenario to play; the number's assignment, then the default, otherwise. */
  scenario?: ScenarioName;
  /** The API's address for this call alone, overriding {@link VoiceSimulator.setTarget}. */
  targetUrl?: string;
}

/** What {@link createVoiceSimulator} needs (AAP 0.11.2). */
export interface VoiceSimulatorOptions {
  /** The origin Twilio would call: the API's `API_PUBLIC_URL`. Signatures are computed over it. */
  apiPublicUrl: string;
  /** The API's real address, e.g. `TestApp.listen()`'s base URL. Omitted until `setTarget`. */
  targetUrl?: string;
  /** The scenarios to play; {@link loadScenarios} by default. */
  scenarios?: ReadonlyMap<string, Scenario>;
  /** The scenario a call plays when its number has none assigned; `prices-high` by default. */
  defaultScenario?: ScenarioName;
  /**
   * The clock the resource timestamps and the `StartTime>` filter read. A suite passes the app's own
   * test clock, so a listing agrees with the API's injected time (AAP 0.11.1).
   */
  now?: () => Date;
  /** How long one step waits for the agent before it is recorded as a timeout. */
  stepTimeoutMs?: number;
}

/**
 * The simulator a suite drives (AAP 0.5.6, AAP 0.11.2).
 *
 * It is a {@link SimCallTarget}, so {@link VoiceSimulator.httpClient} can be handed to
 * `createTelephonyClient({ httpClient })` and every REST request the SDK builds is answered here.
 * {@link VoiceSimulator.startCall} additionally accepts a {@link StartCallInput}, which is what lets a
 * suite play a call the API never dispatched.
 */
export interface VoiceSimulator extends SimCallTarget {
  /** The transport to inject into the Twilio client, so the SDK's calls reach this simulator. */
  readonly httpClient: TwilioHttpClient;
  /** Point the simulator at the API's real address, e.g. `TestApp.listen()`'s base URL. */
  setTarget(url: string): void;
  /** Play `name` for calls to `e164`, until the next {@link VoiceSimulator.reset}. */
  setScenarioFor(e164: string, name: ScenarioName): void;
  /** Play `name` for every call whose number has none of its own. */
  setDefaultScenario(name: ScenarioName): void;
  /** The scenario an unassigned number plays now. */
  readonly defaultScenario: ScenarioName;
  /** Refuse every create with `ECONNREFUSED` until it is turned off (AAP 0.12.1 criterion 17). */
  vendorDown(on: boolean): void;
  /** Accept a call and play it. The SID it answers with is the one an attempt adopts. */
  startCall(
    input: SimCallCreateParams | StartCallInput,
  ): Promise<{ sid: string; status: 'queued' }>;
  /** Resolve with the finished call, or reject naming its SID and the step it stopped at. */
  waitForCall(callSid: string, options?: { timeoutMs?: number }): Promise<SimCall>;
  /** Resolve once every call the simulator holds has finished. */
  waitIdle(options?: { timeoutMs?: number }): Promise<void>;
  /** Every call, in the order it was started. */
  readonly calls: readonly SimCall[];
  /** Every call to one number, in the order it was started. */
  callsTo(e164: string): readonly SimCall[];
  /** Abort the calls in flight and forget every call, assignment and switch. */
  reset(): void;
  /** The same, for a suite that is finished with the simulator. */
  close(): void;
}

// ---------------------------------------------------------------------------------------------
// The simulator (AAP 0.5.6, AAP 0.11.2)
// ---------------------------------------------------------------------------------------------

/** How long a step waits for the agent before it is recorded as a timeout. */
const DEFAULT_STEP_TIMEOUT_MS = 10_000;

/** How long {@link VoiceSimulator.waitForCall} and {@link VoiceSimulator.waitIdle} wait by default. */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

/** The most prompts a `loopLastTurn` scenario sends before it gives up and closes the session. */
const LOOP_CAP = 200;

/** Twilio's HTTP retrieval failure, the code a failed TwiML fetch ends the call with (AAP 0.5.3). */
const HTTP_RETRIEVAL_ERROR_CODE = '11200';

/** The API's TwiML route and its status-callback route, which {@link StartCallInput} targets. */
const TWIML_PATH = '/v1/webhooks/voice/twiml';
const STATUS_CALLBACK_PATH = '/v1/webhooks/voice';

/** Where one call's lifecycle has got to, for a `waitForCall` rejection message. */
type LifecycleStep = 'created' | 'initiated' | 'ringing' | 'answered' | 'twiml' | 'relay' | 'final';

/** One thing the relay loop waits for. */
type RelayEvent = { kind: 'turn' } | { kind: 'end' } | { kind: 'closed' } | { kind: 'timeout' };

/** A promise with its resolver, for the awaits that can end more than one way. */
interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

/** Build a {@link Deferred}. */
function deferred(): Deferred {
  let settle: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

/**
 * One call's internals: everything the lifecycle needs that a suite does not read on {@link SimCall}.
 */
interface SimRuntime {
  /** The create request's parameters, whichever form built them. */
  readonly params: SimCallCreateParams;
  readonly scenario: Scenario;
  readonly call: SimCall;
  /** The status events the create subscribed to; all four when it named none. */
  readonly events: readonly string[];
  readonly createdAt: Date;
  updatedAt: Date;
  /** When the call was answered, which is the resource's `start_time`. */
  startedAt: Date | null;
  endedAt: Date | null;
  /** The sequence number the next callback carries. */
  sequence: number;
  socket: WebSocket | null;
  /** Aborts the HTTP posts, so {@link VoiceSimulator.reset} cannot leave one hanging. */
  readonly control: AbortController;
  readonly timers: Set<NodeJS.Timeout>;
  step: LifecycleStep;
  /** The address this call alone posts to, when {@link StartCallInput} overrode the target. */
  readonly target: string | undefined;
  /** Set when the call can never finish, which makes `waitForCall` reject with it. */
  blocked: string | null;
  /** The status the call must settle at, when the scenario's own is not the right answer. */
  finalOverride: { status: TwilioCallStatus; errorCode?: string } | null;
  readonly settled: Promise<void>;
  readonly settle: () => void;
  /** Unblocks every await this call is sitting in, for an abort. */
  wake: (() => void) | null;
}

/**
 * `createVoiceSimulator`'s own target: the {@link SimCallTarget} the SDK's transport is handed, plus
 * the wider {@link VoiceSimulator.startCall} a test can call with a {@link StartCallInput}.
 *
 * The SDK only ever calls `startCall` with a create request, and a method's parameters are checked
 * bivariantly, so a wider one stays a {@link SimCallTarget}.
 */
interface SimulatorTarget extends SimCallTarget {
  startCall(
    input: SimCallCreateParams | StartCallInput,
  ): Promise<{ sid: string; status: 'queued' }>;
}

/**
 * Build the simulator a suite drives (AAP 0.5.6, AAP 0.11.2).
 *
 * All state — the calls, the per-number scenarios, the vendor switch and the default scenario — lives
 * in this closure, so a suite that builds two apps gets two independent simulators and no call,
 * assignment or switch leaks between them.
 *
 * @param options - The public URL signatures are computed over, the API's real address, the scenarios
 *   and the clock.
 * @returns The simulator, whose `httpClient` is the transport to inject into the Twilio client.
 * @throws Error when `apiPublicUrl` or `targetUrl` is not an absolute `http(s)` URL, or when a
 *   scenario name the options name is not in the scenario map.
 */
export function createVoiceSimulator(options: VoiceSimulatorOptions): VoiceSimulator {
  const apiBase = options.apiPublicUrl.replace(/\/+$/, '');
  const apiOrigin = readHttpOrigin(apiBase, 'apiPublicUrl');
  const scenarios = options.scenarios ?? loadScenarios();
  /** The scenario each number plays, from {@link VoiceSimulator.setScenarioFor}. */
  const assignments = new Map<string, ScenarioName>();
  const runtimes: SimRuntime[] = [];
  const bySid = new Map<string, SimRuntime>();
  const now = options.now ?? ((): Date => new Date());
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const initialDefault = options.defaultScenario ?? 'prices-high';
  let defaultScenario = initialDefault;
  let targetUrl =
    options.targetUrl === undefined ? undefined : readHttpOrigin(options.targetUrl, 'targetUrl');
  let down = false;

  // --- the call store ------------------------------------------------------------------------

  /** The scenario `name` names, or an error naming it — a scenario map a suite replaced may lack it. */
  function scenarioNamed(name: ScenarioName): Scenario {
    const scenario = scenarios.get(name);
    if (scenario === undefined) {
      throw new Error(`the voice simulator has no scenario "${name}"`);
    }
    return scenario;
  }

  /** Which scenario a call to `to` plays: the explicit one, the number's, then the default. */
  function resolveScenarioName(to: string, explicit: ScenarioName | undefined): ScenarioName {
    return explicit ?? assignments.get(to) ?? defaultScenario;
  }

  /** Record a failure on a call under the step it happened at (AAP 0.11.1). */
  function fail(runtime: SimRuntime, step: string, detail: string): void {
    runtime.call.failures.push({ step, detail });
  }

  /** Record something the dialogue did that no scenario asked for. */
  function warn(runtime: SimRuntime, step: string, detail: string): void {
    runtime.call.warnings.push({ step, detail });
  }

  /** Move the call's status and stamp the resource's `date_updated`. */
  function setStatus(runtime: SimRuntime, status: TwilioCallStatus): void {
    runtime.call.status = status;
    runtime.updatedAt = now();
  }

  /** Clear a tracked timer, so an aborted call leaves none behind. */
  function clearTimer(runtime: SimRuntime, timer: NodeJS.Timeout): void {
    clearTimeout(timer);
    runtime.timers.delete(timer);
  }

  /** Finish the call's lifecycle: the resolved promise `waitForCall` waits on, exactly once. */
  function settleCall(runtime: SimRuntime): void {
    runtime.call.done = true;
    runtime.settle();
  }

  /** The address a call posts to: its own override, then the simulator's current target. */
  function addressFor(runtime: SimRuntime): string | undefined {
    return runtime.target ?? targetUrl;
  }

  /** Abort one call: unblock its awaits, drop its socket, forget its timers and settle it. */
  function abortRuntime(runtime: SimRuntime): void {
    if (runtime.call.done) {
      return;
    }
    runtime.call.aborted = true;
    runtime.wake?.();
    runtime.control.abort();
    const socket = runtime.socket;
    if (socket !== null && socket.readyState !== socket.CLOSED) {
      socket.terminate();
    }
    for (const timer of [...runtime.timers]) {
      clearTimeout(timer);
    }
    runtime.timers.clear();
    settleCall(runtime);
  }

  /** One runtime, with everything the lifecycle starts from. */
  function createRuntime(
    params: SimCallCreateParams,
    name: ScenarioName,
    scenario: Scenario,
    createParams: SimCreateParams | null,
    target: string | undefined,
  ): SimRuntime {
    const settled = deferred();
    const createdAt = now();
    return {
      params,
      scenario,
      events: subscribedEvents(params.statusCallbackEvent),
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      endedAt: null,
      sequence: 0,
      socket: null,
      control: new AbortController(),
      timers: new Set<NodeJS.Timeout>(),
      step: 'created',
      target,
      blocked: null,
      finalOverride: null,
      settled: settled.promise,
      settle: settled.resolve,
      wake: null,
      call: {
        sid: `CA${randomBytes(16).toString('hex')}`,
        attemptId: params.attemptId,
        to: params.to,
        from: params.from,
        scenario: name,
        createParams,
        status: 'queued',
        answeredBy: null,
        twiml: {
          httpStatus: null,
          hangup: false,
          relayUrl: null,
          language: null,
          welcomeGreeting: null,
          parameters: {},
        },
        spoken: [],
        languageSwitches: [],
        promptsSent: [],
        endReceived: false,
        endHandoffData: null,
        relayCloseCode: null,
        relayRefusedStatus: null,
        callbacks: [],
        failures: [],
        warnings: [],
        finalStatus: null,
        durationSec: null,
        done: false,
        aborted: false,
      },
    };
  }

  // --- the lifecycle ------------------------------------------------------------------------

  /**
   * Play one call: the callbacks Twilio posts, the TwiML it fetches, the relay it opens and the
   * ending it reports.
   *
   * Everything the lifecycle cannot do is recorded on the call; nothing is thrown out of it. The
   * final callback belongs in the `finally`, because every path — an answer, a refusal, a machine, a
   * fetch that failed, a socket that never opened, an abort — owes Twilio its last status callback
   * and the waiters on the call one ending.
   *
   * @param runtime - The call to play.
   */
  async function playCall(runtime: SimRuntime): Promise<void> {
    const { call, scenario } = runtime;
    try {
      if (addressFor(runtime) === undefined) {
        fail(runtime, 'no_target', 'the simulator has no target address');
        runtime.blocked =
          'the simulator has no target address: call setTarget() with the API base url';
        setStatus(runtime, 'failed');
        return;
      }
      assertOrigins(runtime);

      runtime.step = 'initiated';
      setStatus(runtime, 'initiated');
      await postStatus(runtime, 'initiated');

      // Twilio rings a line it found; a call it rejected outright never rings.
      if (scenario.answer !== 'failed') {
        runtime.step = 'ringing';
        setStatus(runtime, 'ringing');
        await postStatus(runtime, 'ringing');
      }

      if (UNANSWERED_ANSWERS.includes(scenario.answer)) {
        return;
      }

      runtime.step = 'answered';
      call.answeredBy = scenario.answer === 'machine' ? 'machine_start' : 'human';
      runtime.startedAt = now();
      setStatus(runtime, 'in-progress');
      await postStatus(runtime, 'in-progress');

      runtime.step = 'twiml';
      const twiml = await fetchTwiml(runtime);
      if (twiml === null) {
        runtime.finalOverride = { status: 'failed', errorCode: HTTP_RETRIEVAL_ERROR_CODE };
        return;
      }
      // `<Hangup/>`: a machine, or an attempt the API will not converse with. Twilio ends the call.
      if (twiml.hangup) {
        return;
      }

      runtime.step = 'relay';
      const language = twiml.language ?? scenario.language ?? 'en-US';
      if (
        twiml.language !== null &&
        scenario.language !== undefined &&
        twiml.language !== scenario.language
      ) {
        warn(
          runtime,
          'language_mismatch',
          `scenario ${scenario.language}, twiml ${twiml.language}`,
        );
      }
      if (twiml.welcomeGreeting !== null && twiml.welcomeGreeting !== '') {
        call.spoken.push({
          text: twiml.welcomeGreeting,
          lang: language,
          source: 'welcome_greeting',
        });
      }
      if (twiml.relayUrl === null) {
        fail(runtime, 'relay', 'the document carried no ConversationRelay url');
        runtime.finalOverride = { status: 'failed' };
        return;
      }
      await runRelay(runtime, language);
    } catch (error) {
      if (!call.aborted) {
        fail(runtime, runtime.step, errorCodeOf(error));
        setStatus(runtime, 'failed');
        runtime.finalOverride = { status: 'failed' };
      }
    } finally {
      if (!call.aborted) {
        await finishCall(runtime);
      }
      settleCall(runtime);
    }
  }

  /** Report the ending: the final status, its duration, its error code and the closing callback. */
  async function finishCall(runtime: SimRuntime): Promise<void> {
    const { call, scenario } = runtime;
    const override = runtime.finalOverride;
    call.finalStatus = override?.status ?? scenario.finalStatus;
    call.status = call.finalStatus;
    call.durationSec = scenario.durationSec;
    runtime.endedAt = now();
    runtime.updatedAt = now();
    runtime.step = 'final';

    const code =
      override?.errorCode ??
      (scenario.errorCode === undefined ? undefined : String(scenario.errorCode));
    if (addressFor(runtime) !== undefined) {
      await postStatus(runtime, call.finalStatus, {
        durationSec: scenario.durationSec,
        ...(code === undefined ? {} : { errorCode: code }),
      });
    }
  }

  /**
   * Post one status callback for the current status (AAP 0.3.2).
   *
   * The body is validated against the shared callback schema before it is signed — a self-check, so a
   * simulator that sent a body the API would refuse fails here rather than looking like a rejection.
   * Only the events the create subscribed to are posted, in the order the call reaches them.
   */
  async function postStatus(
    runtime: SimRuntime,
    callStatus: TwilioCallStatus,
    options: { durationSec?: number; errorCode?: string } = {},
  ): Promise<void> {
    const { call } = runtime;
    const event = callbackEventFor(callStatus);
    if (!runtime.events.includes(event)) {
      return;
    }

    const params: Record<string, string> = {
      CallSid: call.sid,
      AccountSid: TWILIO_SIMULATOR.accountSid,
      From: call.from,
      To: call.to,
      CallStatus: callStatus,
      SequenceNumber: String(runtime.sequence),
      ApiVersion: '2010-04-01',
      Direction: 'outbound-api',
      CallbackSource: 'call-progress-events',
      Timestamp: toRfc2822(now()),
    };
    if (call.answeredBy !== null) {
      params['AnsweredBy'] = call.answeredBy;
    }
    if (options.durationSec !== undefined) {
      params['CallDuration'] = String(options.durationSec);
    }
    if (options.errorCode !== undefined) {
      params['ErrorCode'] = options.errorCode;
    }

    const checked = TwilioStatusCallback.safeParse(params);
    if (!checked.success) {
      fail(runtime, `${event}_callback`, `invalid body: ${describeIssues(checked.error)}`);
      return;
    }

    const sequence = runtime.sequence;
    const answer = await post(
      runtime,
      runtime.params.statusCallbackUrl,
      params,
      `${event}_callback`,
    );
    runtime.sequence = sequence + 1;
    call.callbacks.push({
      callStatus,
      sequenceNumber: sequence,
      httpStatus: answer === null ? null : answer.status,
    });
  }

  /**
   * Fetch the ConversationRelay TwiML for the answered call and read it (AAP 0.5.6).
   *
   * The fetch carries the `CallSid`, the machine-detection verdict and the attempt id in its query,
   * which is what the route adopts the attempt from; the document is parsed by {@link parseTwiml}.
   *
   * @returns The parsed document, or `null` when the fetch failed — which the lifecycle reports as
   *   Twilio's HTTP retrieval failure.
   */
  async function fetchTwiml(runtime: SimRuntime): Promise<SimTwiml | null> {
    const { call } = runtime;
    const params: Record<string, string> = {
      CallSid: call.sid,
      AccountSid: TWILIO_SIMULATOR.accountSid,
      From: call.from,
      To: call.to,
      CallStatus: 'in-progress',
      ApiVersion: '2010-04-01',
      Direction: 'outbound-api',
    };
    if (call.answeredBy !== null) {
      params['AnsweredBy'] = call.answeredBy;
    }

    const checked = TwilioTwimlRequest.safeParse(params);
    if (!checked.success) {
      fail(runtime, 'twiml', `invalid body: ${describeIssues(checked.error)}`);
      return null;
    }

    const answer = await post(runtime, runtime.params.twimlUrl, params, 'twiml_fetch_failed');
    call.twiml.httpStatus = answer === null ? null : answer.status;
    if (answer === null || answer.status !== 200) {
      return null;
    }
    Object.assign(call.twiml, parseTwiml(answer.body));
    return call.twiml;
  }

  /**
   * Post one request to the API, signed over the public URL and sent to the target's address.
   *
   * The two are deliberately different: the API rebuilds the signed URL from `API_PUBLIC_URL` and the
   * request it received, so the signature can only match when it covers the public address, while the
   * connection has to reach wherever the API is actually listening.
   *
   * @returns The answer's status and body, or `null` when the request could not be made — a failure is
   *   recorded either way, and an aborted call records none.
   */
  async function post(
    runtime: SimRuntime,
    publicUrl: string,
    params: Record<string, string>,
    step: string,
  ): Promise<{ status: number; body: string } | null> {
    const address = addressFor(runtime);
    if (address === undefined) {
      fail(runtime, step, 'the simulator has no target address');
      return null;
    }

    try {
      const publicTarget = new URL(publicUrl);
      const sendUrl = `${readHttpOrigin(address, 'targetUrl')}${publicTarget.pathname}${publicTarget.search}`;
      const response = await fetch(sendUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': twilioSignature(publicUrl, params),
        },
        body: new URLSearchParams(params).toString(),
        signal: runtime.control.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        fail(runtime, step, `http ${response.status}`);
      }
      return { status: response.status, body };
    } catch (error) {
      if (!runtime.call.aborted) {
        fail(runtime, step, errorCodeOf(error));
      }
      return null;
    }
  }

  /** Record a create URL that does not use `apiPublicUrl`, which Twilio would still sign as given. */
  function assertOrigins(runtime: SimRuntime): void {
    const urls: ReadonlyArray<readonly [string, string]> = [
      ['twimlUrl', runtime.params.twimlUrl],
      ['statusCallbackUrl', runtime.params.statusCallbackUrl],
    ];
    for (const [label, url] of urls) {
      if (originOf(url) !== apiOrigin) {
        fail(runtime, 'url_origin_mismatch', `${label} does not use apiPublicUrl`);
      }
    }
  }

  /** The call store's record of one call, in the field names twilio 6.2.0 reads. */
  function toResource(runtime: SimRuntime): SimCallResource {
    const { call } = runtime;
    return {
      sid: call.sid,
      account_sid: TWILIO_SIMULATOR.accountSid,
      to: call.to,
      from: call.from,
      status: call.status,
      direction: 'outbound-api',
      answered_by: call.answeredBy,
      duration: call.done && call.durationSec !== null ? String(call.durationSec) : null,
      start_time: runtime.startedAt === null ? null : toRfc2822(runtime.startedAt),
      end_time: runtime.endedAt === null ? null : toRfc2822(runtime.endedAt),
      date_created: toRfc2822(runtime.createdAt),
      date_updated: toRfc2822(runtime.updatedAt),
      api_version: '2010-04-01',
      uri: `/2010-04-01/Accounts/${TWILIO_SIMULATOR.accountSid}/Calls/${call.sid}.json`,
    };
  }

  /** Whether a call matches a list request's `To`, `From` and `StartTime>` filters. */
  function matchesFilter(runtime: SimRuntime, filter: SimCallListFilter): boolean {
    if (filter.to !== undefined && filter.to !== runtime.call.to) {
      return false;
    }
    if (filter.from !== undefined && filter.from !== runtime.call.from) {
      return false;
    }
    if (filter.startTimeAfter !== undefined) {
      // A call that has not started is dated by its creation, so a listing taken while a dispatch is
      // in flight still reports the call the SDK created (AAP 0.3.2).
      const started = runtime.startedAt ?? runtime.createdAt;
      if (started.getTime() < filter.startTimeAfter.getTime()) {
        return false;
      }
    }
    return true;
  }

  /**
   * Resolve after `ms`, tracked like every other timer so an abort cannot leave it behind.
   *
   * @param runtime - The call the timer belongs to.
   * @param ms - How long to wait.
   */
  function delay(runtime: SimRuntime, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        runtime.timers.delete(timer);
        resolve();
      }, ms);
      runtime.timers.add(timer);
    });
  }

  /** Resolve when `promise` does, or reject with the message when the timer fires first. */
  function raceTimeout(
    runtime: SimRuntime,
    promise: Promise<void>,
    timeoutMs: number,
    message: () => string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(message()));
      }, timeoutMs);
      runtime.timers.add(timer);
      void promise.then(
        () => {
          clearTimer(runtime, timer);
          resolve();
        },
        (error: unknown) => {
          clearTimer(runtime, timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  // --- the relay ----------------------------------------------------------------------------

  /**
   * Open the relay socket, answer each agent utterance with the next scripted turn, and stop on the
   * dialogue's `end`, on a drop, on a close or on a timeout (AAP 0.5.6).
   *
   * The socket is signed over the relay URL exactly as the TwiML wrote it — the public `wss://`
   * address — while the connection goes to the target's host, so the API's signature check over its
   * own `publicRelayUrl` matches. A refused upgrade (over `VOICE_RELAY_MAX_SESSIONS`, or a bad
   * signature) is recorded as `relayRefusedStatus` and ends the call `failed`: AAP 0.3.2 gives a
   * refused relay no error code, because Twilio reports it as a failed call of its own.
   *
   * @param runtime - The call, whose TwiML and socket this reads and writes.
   * @param language - The language the conversation opens in, from the TwiML or the scenario.
   */
  async function runRelay(runtime: SimRuntime, language: CallLanguage): Promise<void> {
    const { call, scenario } = runtime;
    const relayUrl = call.twiml.relayUrl;
    const address = addressFor(runtime);
    if (relayUrl === null || address === undefined) {
      fail(runtime, 'relay', 'the relay socket has no url or no address');
      runtime.finalOverride = { status: 'failed' };
      return;
    }

    let socketUrl: string;
    try {
      const base = new URL(address);
      const relay = new URL(relayUrl);
      socketUrl = `${base.protocol === 'https:' ? 'wss:' : 'ws:'}//${base.host}${relay.pathname}${relay.search}`;
    } catch {
      fail(runtime, 'relay', 'the relay url could not be read');
      runtime.finalOverride = { status: 'failed' };
      return;
    }

    const pending: RelayEvent[] = [];
    const waiters: { resolve: (event: RelayEvent) => void; timer: NodeJS.Timeout | null }[] = [];
    const closed = deferred();
    let currentLanguage = language;
    let utterance = '';

    /** Hand one event to the loop, or hold it until the loop asks for one. */
    function deliver(event: RelayEvent): void {
      const waiter = waiters.shift();
      if (waiter === undefined) {
        pending.push(event);
        return;
      }
      if (waiter.timer !== null) {
        clearTimer(runtime, waiter.timer);
      }
      waiter.resolve(event);
    }

    /** The next event, or `timeout` when the step outlasts the step bound. */
    function nextEvent(): Promise<RelayEvent> {
      return new Promise<RelayEvent>((resolve) => {
        const held = pending.shift();
        if (held !== undefined) {
          resolve(held);
          return;
        }
        const waiter: { resolve: (event: RelayEvent) => void; timer: NodeJS.Timeout | null } = {
          resolve,
          timer: null,
        };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          resolve({ kind: 'timeout' });
        }, stepTimeoutMs);
        runtime.timers.add(waiter.timer);
        waiters.push(waiter);
      });
    }

    /** Wake every waiting step with a close, so an abort cannot leave one hanging. */
    function wake(): void {
      closed.resolve();
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        if (waiter === undefined) {
          break;
        }
        if (waiter.timer !== null) {
          clearTimer(runtime, waiter.timer);
        }
        waiter.resolve({ kind: 'closed' });
      }
    }

    /** Read one frame the agent sent (AAP 0.5.6). */
    function onAgentFrame(value: unknown): void {
      const frame = RelayOutboundFrame.safeParse(value);
      if (!frame.success) {
        warn(runtime, 'invalid_agent_frame', frameTypeOf(value));
        return;
      }
      switch (frame.data.type) {
        case 'text':
          utterance += frame.data.token;
          if (frame.data.last) {
            const line = utterance;
            utterance = '';
            call.spoken.push({
              text: line,
              lang: frame.data.lang ?? currentLanguage,
              source: 'text',
            });
            deliver({ kind: 'turn' });
          }
          return;
        case 'language':
          currentLanguage = frame.data.ttsLanguage;
          call.languageSwitches.push({
            ttsLanguage: frame.data.ttsLanguage,
            transcriptionLanguage: frame.data.transcriptionLanguage,
          });
          return;
        case 'end':
          call.endReceived = true;
          call.endHandoffData = frame.data.handoffData ?? null;
          deliver({ kind: 'end' });
          if (socket.readyState === socket.OPEN) {
            socket.close(1000);
          }
          return;
      }
    }

    const socket = new WebSocket(socketUrl, {
      headers: { 'X-Twilio-Signature': twilioSignature(relayUrl) },
    });
    runtime.socket = socket;

    // The handshake's outcome, as a promise rather than a flag: the listeners below settle it, and a
    // promise cannot be narrowed by the analysis the way a `let` the listeners assign would be.
    let handshake: (outcome: 'open' | 'refused' | 'failed') => void = () => undefined;
    const ready = new Promise<'open' | 'refused' | 'failed'>((resolve) => {
      handshake = resolve;
    });

    runtime.wake = (): void => {
      wake();
      handshake('failed');
    };

    socket.on('open', () => {
      handshake('open');
    });
    socket.on('unexpected-response', (_request, response) => {
      call.relayRefusedStatus = response.statusCode ?? null;
      response.destroy();
      handshake('refused');
    });
    socket.on('error', (error: unknown) => {
      if (!call.aborted) {
        fail(runtime, 'relay_connect', errorCodeOf(error));
      }
      handshake('failed');
    });
    socket.on('close', (code: number) => {
      call.relayCloseCode = code;
      deliver({ kind: 'closed' });
      handshake('failed');
      closed.resolve();
    });
    socket.on('message', (data: unknown) => {
      try {
        onAgentFrame(JSON.parse(messageText(data)) as unknown);
      } catch {
        warn(runtime, 'invalid_agent_frame', 'unparseable');
      }
    });

    const outcome = await ready;
    if (outcome !== 'open') {
      runtime.finalOverride = { status: 'failed' };
      return;
    }
    if (call.aborted) {
      return;
    }

    const setup = RelayInboundFrame.safeParse({
      type: 'setup',
      sessionId: `VX${randomBytes(16).toString('hex')}`,
      callSid: call.sid,
      accountSid: TWILIO_SIMULATOR.accountSid,
      from: call.from,
      to: call.to,
      direction: 'outbound-api',
      customParameters: call.twiml.parameters,
    });
    if (!setup.success) {
      fail(runtime, 'relay', `the setup frame was refused: ${describeIssues(setup.error)}`);
      socket.close(1000);
      return;
    }
    socket.send(JSON.stringify(setup.data));

    let sent = 0;
    for (;;) {
      const event = await nextEvent();
      if (event.kind === 'timeout') {
        fail(
          runtime,
          sent >= scenario.turns.length ? 'no_end' : 'agent_timeout',
          `after ${sent} prompt(s)`,
        );
        break;
      }
      if (event.kind === 'closed') {
        if (!call.endReceived) {
          warn(runtime, 'relay_closed', `close code ${call.relayCloseCode ?? 'unknown'}`);
        }
        break;
      }
      if (event.kind === 'end') {
        break;
      }

      // The agent finished an utterance: answer it with the next scripted turn. A script with none
      // left leaves the loop waiting for the agent's own ending, which the step bound finishes.
      const turn = scenario.loopLastTurn === true ? lastTurn(scenario.turns) : scenario.turns[sent];
      if (turn === undefined) {
        continue;
      }
      if (sent >= LOOP_CAP) {
        fail(runtime, 'loop_cap', `after ${sent} prompts`);
        break;
      }
      if (!sendPrompt(runtime, turn, currentLanguage)) {
        break;
      }
      sent += 1;
      // A call that drops here leaves the dialogue mid-script, which is what its outcome reports as
      // partial data rather than as an answer (AAP 0.5.3).
      if (scenario.dropAfterTurn !== undefined && sent >= scenario.dropAfterTurn) {
        socket.terminate();
        break;
      }
    }

    if (socket.readyState === socket.OPEN) {
      socket.close(1000);
    }
    // The close handshake is asynchronous, and a suite reads `relayCloseCode`: waiting for it, bounded
    // by the step bound, is what keeps that field filled by the time the call settles.
    if (!call.aborted) {
      await Promise.race([closed.promise, delay(runtime, stepTimeoutMs)]);
    }
  }

  /** Send one scripted utterance as a final `prompt` frame. `false` ends the relay loop. */
  function sendPrompt(
    runtime: SimRuntime,
    turn: ScenarioTurn,
    currentLanguage: CallLanguage,
  ): boolean {
    const lang = turn.lang ?? currentLanguage;
    const frame = RelayInboundFrame.safeParse({
      type: 'prompt',
      voicePrompt: turn.say,
      lang,
      last: true,
    });
    if (!frame.success) {
      fail(runtime, 'relay', `the prompt frame was refused: ${describeIssues(frame.error)}`);
      return false;
    }
    const socket = runtime.socket;
    if (socket === null || socket.readyState !== socket.OPEN) {
      fail(runtime, 'relay', 'the relay socket is not open');
      return false;
    }
    socket.send(JSON.stringify(frame.data));
    runtime.call.promptsSent.push({ text: turn.say, lang });
    return true;
  }

  // --- the target, the call store and the suite's controls -----------------------------------

  /** Build the two URLs and the create parameters {@link StartCallInput} does not carry. */
  function buildCreateParams(input: StartCallInput): SimCallCreateParams {
    const query = `attemptId=${encodeURIComponent(input.attemptId)}`;
    return {
      to: input.to,
      from: input.from ?? TWILIO_SIMULATOR.fromNumber,
      twimlUrl: `${apiBase}${TWIML_PATH}?${query}`,
      statusCallbackUrl: `${apiBase}${STATUS_CALLBACK_PATH}?${query}`,
      attemptId: input.attemptId,
      statusCallbackEvent: [...CALL_STATUS_CALLBACK_EVENTS],
      statusCallbackMethod: 'POST',
      record: false,
      timeLimit: null,
      machineDetection: null,
    };
  }

  /** What the SDK's create request said, as evidence about recording, the bound and the events. */
  function observedCreateParams(params: SimCallCreateParams): SimCreateParams {
    return {
      record: params.record,
      timeLimit: params.timeLimit,
      statusCallbackEvent: params.statusCallbackEvent,
      machineDetection: params.machineDetection,
      statusCallbackMethod: params.statusCallbackMethod,
    };
  }

  /** Abort every call in flight and forget the calls, the assignments and the vendor switch. */
  function reset(): void {
    for (const runtime of runtimes) {
      abortRuntime(runtime);
    }
    runtimes.length = 0;
    bySid.clear();
    assignments.clear();
    down = false;
    defaultScenario = initialDefault;
  }

  const target: SimulatorTarget = {
    startCall(input: SimCallCreateParams | StartCallInput): Promise<{
      sid: string;
      status: 'queued';
    }> {
      try {
        const fromSdk = isCreateParams(input);
        const params = fromSdk ? input : buildCreateParams(input);
        const explicit = fromSdk ? undefined : input.scenario;
        const name = resolveScenarioName(params.to, explicit);
        const scenario = scenarioNamed(name);

        // A down vendor never leaves a call behind: the create is refused before the call exists,
        // which is what makes the dispatch failure *definite* rather than one the task may never
        // redial (AAP 0.3.2, AAP 0.12.1 criterion 17).
        if (down || scenario.vendor === 'down') {
          throw vendorDownError();
        }

        const runtime = createRuntime(
          params,
          name,
          scenario,
          fromSdk ? observedCreateParams(params) : null,
          fromSdk ? undefined : input.targetUrl,
        );
        runtimes.push(runtime);
        bySid.set(runtime.call.sid, runtime);
        // The create's answer reaches its caller first, so the API's own bookkeeping of the SID and
        // the first callback can arrive in either order and both are tolerated (AAP 0.3.2).
        setImmediate(() => {
          void playCall(runtime);
        });
        const created: { sid: string; status: 'queued' } = {
          sid: runtime.call.sid,
          status: 'queued',
        };
        return Promise.resolve(created);
      } catch (error) {
        // A refused create reaches the SDK as a rejected promise, which is how it reads an error its
        // transport reported.
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },

    fetchCall(sid: string): SimCallResource | null {
      const runtime = bySid.get(sid);
      return runtime === undefined ? null : toResource(runtime);
    },

    listCalls(filter: SimCallListFilter): SimCallResource[] {
      return [...runtimes]
        .reverse()
        .filter((runtime) => matchesFilter(runtime, filter))
        .map((runtime) => toResource(runtime));
    },

    isVendorDown(to?: string): boolean {
      if (down) {
        return true;
      }
      const name = to === undefined ? defaultScenario : resolveScenarioName(to, undefined);
      return scenarios.get(name)?.vendor === 'down';
    },
  };

  return {
    ...target,
    httpClient: createSimulatorHttpClient(target),

    get calls(): readonly SimCall[] {
      return runtimes.map((runtime) => runtime.call);
    },

    get defaultScenario(): ScenarioName {
      return defaultScenario;
    },

    setTarget(url: string): void {
      targetUrl = readHttpOrigin(url, 'targetUrl');
    },

    setScenarioFor(e164: string, name: ScenarioName): void {
      if (!E164.safeParse(e164).success) {
        throw new Error('setScenarioFor requires an E.164 number');
      }
      scenarioNamed(name);
      assignments.set(e164, name);
    },

    setDefaultScenario(name: ScenarioName): void {
      scenarioNamed(name);
      defaultScenario = name;
    },

    vendorDown(on: boolean): void {
      down = on;
    },

    startCall(input: SimCallCreateParams | StartCallInput): Promise<{
      sid: string;
      status: 'queued';
    }> {
      return target.startCall(input);
    },

    callsTo(e164: string): readonly SimCall[] {
      return runtimes.filter((runtime) => runtime.call.to === e164).map((runtime) => runtime.call);
    },

    async waitForCall(callSid: string, options: { timeoutMs?: number } = {}): Promise<SimCall> {
      const runtime = bySid.get(callSid);
      if (runtime === undefined) {
        throw new Error(`no simulated call with sid ${callSid}`);
      }
      const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      if (!runtime.call.done) {
        await raceTimeout(
          runtime,
          runtime.settled,
          timeoutMs,
          () => `call ${callSid} did not finish within ${timeoutMs}ms (last step: ${runtime.step})`,
        );
      }
      if (runtime.blocked !== null) {
        throw new Error(`call ${callSid} did not run: ${runtime.blocked}`);
      }
      return runtime.call;
    },

    async waitIdle(options: { timeoutMs?: number } = {}): Promise<void> {
      const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const inFlight = runtimes.filter((runtime) => !runtime.call.done);
        const first = inFlight[0];
        if (first === undefined) {
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`the voice simulator still holds ${inFlight.length} call(s) in flight`);
        }
        await raceTimeout(
          first,
          Promise.all(inFlight.map((runtime) => runtime.settled)).then(() => undefined),
          remaining,
          () => `the voice simulator still holds ${inFlight.length} call(s) in flight`,
        );
      }
    },

    reset,

    close(): void {
      reset();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/** The last turn of a script, which a `loopLastTurn` scenario repeats. */
function lastTurn(turns: readonly ScenarioTurn[]): ScenarioTurn | undefined {
  return turns[turns.length - 1];
}

/**
 * Whether a create came from the SDK rather than from {@link StartCallInput}.
 *
 * The two forms are told apart by the URLs only a create carries: a test's input names an attempt and
 * a number, while the SDK's names the TwiML and status-callback URLs it built (AAP 0.5.6).
 */
function isCreateParams(input: SimCallCreateParams | StartCallInput): input is SimCallCreateParams {
  return 'twimlUrl' in input;
}

/**
 * Which progress events a call subscribes to: the ones it named, or all four.
 *
 * Twilio subscribes a call to every event when `StatusCallbackEvent` is omitted, which is why an
 * empty list means "all of them" rather than "none" (AAP 0.3.2).
 */
function subscribedEvents(events: readonly string[]): readonly string[] {
  const named = CALL_STATUS_CALLBACK_EVENTS.filter(
    (event) => events.length === 0 || events.includes(event),
  );
  return named;
}

/**
 * Which of the subscribed events one status corresponds to: `answered` carries the `in-progress`
 * status, and every terminal status is the `completed` event (AAP 0.3.2).
 */
function callbackEventFor(status: TwilioCallStatus): string {
  if (status === 'initiated' || status === 'ringing') {
    return status;
  }
  return status === 'in-progress' ? 'answered' : 'completed';
}

/** The `type` of a frame this file could not parse, or `unknown` — never its content (AAP 0.11.1). */
function frameTypeOf(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const type = (value as { type?: unknown }).type;
    if (typeof type === 'string') {
      return type;
    }
  }
  return 'unknown';
}

/** One `ws` message as text, whatever shape the listener was handed. */
function messageText(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data as readonly Uint8Array[]).toString('utf8');
  }
  return '';
}

/** A failed request's code, or the error's own name — never its message, which may carry a URL. */
function errorCodeOf(error: unknown): string {
  if (error instanceof Error) {
    const code: unknown = (error as { code?: unknown }).code;
    return typeof code === 'string' && code !== '' ? code : error.name;
  }
  return 'unknown';
}

/** A URL's origin, or `null` when it is not an absolute URL this file can read. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * An absolute `http(s)` URL's origin, or an error naming the option that was wrong.
 *
 * The simulator posts to an origin and appends the public URL's own path and query, so a base address
 * carrying a path is not used as one — which is also why a reverse-proxied API base is written as its
 * scheme, host and port here.
 */
function readHttpOrigin(url: string, name: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('scheme');
    }
    return parsed.origin;
  } catch {
    throw new Error(`${name} must be an absolute http(s) url`);
  }
}

/** A date in the RFC 2822 form the SDK parses, from the simulator's own clock. */
function toRfc2822(date: Date): string {
  return date.toUTCString().replace(/GMT$/, '+0000');
}

/**
 * Read the ConversationRelay TwiML the API served (AAP 0.5.6).
 *
 * A small pattern-based reader rather than an XML parser: the document is one this API wrote, its
 * shape is fixed by `modules/voice-agent/twiml.ts`, and the three things a suite reads off it — the
 * relay address, the greeting, the parameters — sit in its first tag. Every attribute value is
 * unescaped, because the greeting carries the city's own apostrophes and accents.
 *
 * @param xml - The document the TwiML route answered with.
 * @returns Everything {@link SimTwiml} carries but the HTTP status, which the fetch set.
 */
function parseTwiml(xml: string): Omit<SimTwiml, 'httpStatus'> {
  const relay = /<\s*ConversationRelay\b([^>]*)>/i.exec(xml);
  const attributes = relay === null ? {} : readAttributes(relay[1] ?? '');
  const language = attributes['language'];
  const parsedLanguage = language === undefined ? null : CallLanguage.safeParse(language);

  return {
    hangup: /<\s*Hangup\b/i.test(xml),
    relayUrl: attributes['url'] ?? null,
    language: parsedLanguage !== null && parsedLanguage.success ? parsedLanguage.data : null,
    welcomeGreeting: attributes['welcomeGreeting'] ?? null,
    parameters: readParameters(xml),
  };
}

/** The attributes of one XML tag's attribute list, unescaped, by name. */
function readAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([-A-Za-z0-9_:.]+)\s*=\s*"([^"]*)"/g;
  let match = pattern.exec(source);
  while (match !== null) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined && attributes[name] === undefined) {
      attributes[name] = decodeXml(value);
    }
    match = pattern.exec(source);
  }
  return attributes;
}

/** Every `<Parameter name value/>` the document carried, by name (AAP 0.3.2). */
function readParameters(xml: string): Record<string, string> {
  const parameters: Record<string, string> = {};
  const pattern = /<\s*Parameter\b([^>]*?)\/?>/gi;
  let match = pattern.exec(xml);
  while (match !== null) {
    const attributes = readAttributes(match[1] ?? '');
    const name = attributes['name'];
    const value = attributes['value'];
    if (name !== undefined && value !== undefined) {
      parameters[name] = value;
    }
    match = pattern.exec(xml);
  }
  return parameters;
}

/** The five XML entities this API escapes, plus the numeric forms, decoded. */
function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (match: string, hex: string) => fromCodePoint(match, hex, 16))
    .replace(/&#(\d+);/g, (match: string, digits: string) => fromCodePoint(match, digits, 10))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** One numeric character reference, or the reference itself when it does not name a code point. */
function fromCodePoint(match: string, digits: string, radix: number): string {
  const code = Number.parseInt(digits, radix);
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : match;
}

// ---------------------------------------------------------------------------------------------
// The standalone server and its CLI (AAP 0.6.2, AAP 0.11.2)
// ---------------------------------------------------------------------------------------------

/** The port `VOICE_SIM_URL`'s server listens on when `PORT` names none. */
const DEFAULT_VOICE_SIM_PORT = 4010;

/** The most of a REST request body the server will read, so a runaway client cannot exhaust it. */
const MAX_REQUEST_BYTES = 64 * 1024;

/** What {@link startVoiceSimulatorServer} needs. */
export interface VoiceSimulatorServerOptions {
  port: number;
  /** The interface to bind; every interface by default, which the compose network needs. */
  host?: string;
  /** The origin Twilio would call: the API's `API_PUBLIC_URL`. */
  apiPublicUrl: string;
  /** The API's real address, e.g. the compose service's `http://api:3000`. */
  targetUrl: string;
  /** The scenarios to play; {@link loadScenarios} by default. */
  scenarioMap?: ReadonlyMap<string, Scenario>;
  /** The scenario an unassigned number plays. */
  defaultScenario?: ScenarioName;
}

/** The running server, and the simulator it serves. */
export interface VoiceSimulatorServer {
  /** The address to give server-core as `VOICE_SIM_URL`. */
  url: string;
  simulator: VoiceSimulator;
  /** Stop listening, drop the open connections and abort the calls in flight. */
  close(): Promise<void>;
}

/**
 * Serve the simulator over HTTP, for a process that is not the API (AAP 0.6.2, AAP 0.11.2).
 *
 * Two clients share this one server. server-core's own forwarding transport sends every REST request
 * the SDK builds to `VOICE_SIM_URL`, so `apps/workers` dispatches through it with no credential and no
 * network; and the compose `voice-sim` service is this binary with `API_PUBLIC_URL` and
 * `VOICE_SIM_TARGET_URL` set.
 *
 * `vendor-down` is the one scenario this server refuses, on both surfaces: an accepted connection
 * cannot be refused at the TCP layer, so destroying it yields a non-definite error the dispatcher must
 * treat as ambiguous, which is not what criterion 17 checks. The in-process simulator, where
 * {@link vendorDownError} is thrown before the connection is made, is the only place it means what it
 * says.
 *
 * @param options - The port, the bind address, the two URLs and the scenarios.
 * @returns The server, its simulator and its `close`.
 */
export async function startVoiceSimulatorServer(
  options: VoiceSimulatorServerOptions,
): Promise<VoiceSimulatorServer> {
  const host = options.host ?? '0.0.0.0';
  const scenarios = options.scenarioMap ?? loadScenarios();
  const simulator = createVoiceSimulator({
    apiPublicUrl: options.apiPublicUrl,
    targetUrl: options.targetUrl,
    scenarios,
    ...(options.defaultScenario === undefined ? {} : { defaultScenario: options.defaultScenario }),
  });

  /** Answer one REST request from the SDK's forwarding transport (AAP 0.3.3). */
  async function serveRest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const body = await readBody(request);
    const forwarded: TwilioHttpRequest = {
      method: httpMethod(request.method),
      uri: `http://${request.headers.host ?? host}${url.pathname}${url.search}`,
      data: parseTwilioForm(body),
      headers: headersOf(request),
    };
    const answer = await handleTwilioRequest(simulator, forwarded);
    response.writeHead(answer.statusCode, { 'content-type': 'application/json' });
    response.end(
      typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? null),
    );
  }

  /** Answer the simulator's own control routes, which a suite or an operator script calls. */
  async function serveControl(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (url.pathname === '/__sim/scenario' && request.method === 'POST') {
      const body = await readBody(request);
      const parsed = readScenarioAssignment(body, scenarios);
      if (parsed === null) {
        response.writeHead(422, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid_scenario_assignment' }));
        return true;
      }
      simulator.setScenarioFor(parsed[0], parsed[1]);
      response.writeHead(204);
      response.end();
      return true;
    }
    if (url.pathname === '/__sim/calls' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(simulator.calls));
      return true;
    }
    return false;
  }

  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
      try {
        if (url.pathname.startsWith('/2010-04-01/')) {
          await serveRest(request, response, url);
          return;
        }
        if (await serveControl(request, response, url)) {
          return;
        }
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'not_found' }));
      } catch (error) {
        // A down vendor is answered by dropping the connection: it is best effort, because the
        // connection was already accepted and the SDK will classify it as ambiguous (AAP 0.3.2).
        if (isVendorDownError(error)) {
          response.destroy();
          return;
        }
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' });
        }
        response.end(JSON.stringify({ error: 'simulator_failure' }));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      resolve();
    });
  });

  const bound = server.address();
  const port = typeof bound === 'object' && bound !== null ? bound.port : options.port;
  const reachable = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

  return {
    url: `http://${reachable}:${port}`,
    simulator,
    async close(): Promise<void> {
      simulator.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/** Read a request body, refusing one larger than the simulator will carry. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error('the voice simulator refuses a request body over 64 kib'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve();
    });
    request.on('error', (error: Error) => {
      reject(error);
    });
  });
  return Buffer.concat(chunks).toString('utf8');
}

/** The request's headers as a plain map, which is what the SDK's transport hands a client. */
function headersOf(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') {
      headers[name] = value;
    } else if (Array.isArray(value)) {
      const [first] = value;
      if (first !== undefined) {
        headers[name] = first;
      }
    }
  }
  return headers;
}

/** The HTTP method the SDK sent, restricted to the five it can send. */
function httpMethod(method: string | undefined): TwilioHttpMethod {
  const lower = (method ?? 'post').toLowerCase();
  if (
    lower === 'get' ||
    lower === 'post' ||
    lower === 'put' ||
    lower === 'patch' ||
    lower === 'delete'
  ) {
    return lower;
  }
  return 'post';
}

/** A scenario name and number a control request assigned, or `null` for anything unusable. */
function readScenarioAssignment(
  body: string,
  scenarios: ReadonlyMap<string, Scenario>,
): readonly [string, ScenarioName] | null {
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const fields = value as { number?: unknown; name?: unknown };
  const name = readScenarioName(fields.name, scenarios);
  if (
    typeof fields.number !== 'string' ||
    !E164.safeParse(fields.number).success ||
    name === null
  ) {
    return null;
  }
  return [fields.number, name];
}

/**
 * A scenario name the map holds and this server may serve, or `null`.
 *
 * An unknown name is refused, and so is a `vendor: 'down'` scenario: a refused connection cannot be
 * expressed on one that was already accepted, so the standalone server never serves it.
 */
function readScenarioName(
  value: unknown,
  scenarios: ReadonlyMap<string, Scenario>,
): ScenarioName | null {
  if (typeof value !== 'string') {
    return null;
  }
  const name = SCENARIO_NAMES.find((candidate) => candidate === value);
  if (name === undefined) {
    return null;
  }
  const scenario = scenarios.get(name);
  return scenario === undefined || scenario.vendor === 'down' ? null : name;
}

/** Whether a failure is the vendor-down refusal {@link vendorDownError} builds. */
function isVendorDownError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === 'ECONNREFUSED';
}

/**
 * Run the standalone server from the environment (`pnpm --filter @tablemate/api voice-sim`).
 *
 * Every variable is validated before anything listens, and a failure names the variable and exits 1
 * with no value echoed: a malformed address may carry a host, and this process logs its port alone.
 */
async function runVoiceSimulatorCli(): Promise<void> {
  const port = readCliPort(process.env['PORT']);
  const apiPublicUrl = requireCliVariable('API_PUBLIC_URL');
  const targetUrl = requireCliVariable('VOICE_SIM_TARGET_URL');
  const defaultScenario = readCliDefaultScenario(process.env['VOICE_SIM_DEFAULT_SCENARIO']);
  const assignments = readCliAssignments(process.env['VOICE_SIM_SCENARIOS']);

  const server = await startVoiceSimulatorServer({
    port,
    apiPublicUrl,
    targetUrl,
    ...(defaultScenario === undefined ? {} : { defaultScenario }),
  });
  for (const [number, name] of assignments) {
    server.simulator.setScenarioFor(number, name);
  }

  const stop = (): void => {
    void server.close().then(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdout.write(`voice-sim listening on port ${port}\n`);
}

/** Write the reason to stderr and exit 1, naming the variable and never its value. */
function exitWith(message: string): never {
  process.stderr.write(`voice-sim: ${message}\n`);
  process.exit(1);
}

/** One required environment variable, or an exit naming it. */
function requireCliVariable(name: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? exitWith(`${name} is required`) : value;
}

/** The port to bind: `PORT`, then {@link DEFAULT_VOICE_SIM_PORT}. */
function readCliPort(value: string | undefined): number {
  if (value === undefined || value === '') {
    return DEFAULT_VOICE_SIM_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return exitWith('PORT must be a port number');
  }
  return port;
}

/** The scenario every unassigned number plays, refusing the one this server cannot serve. */
function readCliDefaultScenario(value: string | undefined): ScenarioName | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const name = readScenarioName(value, loadScenarios());
  if (name === null) {
    return exitWith('VOICE_SIM_DEFAULT_SCENARIO must name a scenario this server can serve');
  }
  return name;
}

/** The `+E164=name` assignments `VOICE_SIM_SCENARIOS` carries. */
function readCliAssignments(
  value: string | undefined,
): ReadonlyArray<readonly [string, ScenarioName]> {
  if (value === undefined || value === '') {
    return [];
  }
  const scenarios = loadScenarios();
  const assignments: [string, ScenarioName][] = [];
  for (const entry of value.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') {
      continue;
    }
    const separator = trimmed.indexOf('=');
    const number = separator < 0 ? '' : trimmed.slice(0, separator);
    const name = readScenarioName(separator < 0 ? '' : trimmed.slice(separator + 1), scenarios);
    if (name === null || !E164.safeParse(number).success) {
      return exitWith('VOICE_SIM_SCENARIOS must be +E164=name pairs this server can serve');
    }
    assignments.push([number, name]);
  }
  return assignments;
}

// The entry point `apps/api/package.json`'s `voice-sim` script runs. Importing this module has no
// side effect, so a suite can take the simulator, the scenarios and the signature helper from it.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runVoiceSimulatorCli();
}
