/**
 * The scripted telephony simulator: Twilio's own side of an automated call, played in-process
 * (AAP 0.5.6, AAP 0.11.2).
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
import dropBeforePromptScenario from './scenarios/drop-before-prompt.json' with { type: 'json' };
import dropMidScriptScenario from './scenarios/drop-mid-script.json' with { type: 'json' };
import englishSwitchScenario from './scenarios/english-switch.json' with { type: 'json' };
import machineScenario from './scenarios/machine.json' with { type: 'json' };
import noAnswerScenario from './scenarios/no-answer.json' with { type: 'json' };
import noScenario from './scenarios/no.json' with { type: 'json' };
import pricesHighScenario from './scenarios/prices-high.json' with { type: 'json' };
import pricesLowScenario from './scenarios/prices-low.json' with { type: 'json' };
import stopScenario from './scenarios/stop.json' with { type: 'json' };
import vendorDownScenario from './scenarios/vendor-down.json' with { type: 'json' };
import wantsHumanScenario from './scenarios/wants-human.json' with { type: 'json' };
import yesScenario from './scenarios/yes.json' with { type: 'json' };

/**
 * Twilio's request signature for a URL and its posted fields (AAP 0.3.3): a base64 HMAC-SHA1, keyed by the account's
 * auth token, over the URL followed by each parameter name and value concatenated in ascending key order. The
 * simulator computes it locally, so a test that wants to forge or tamper with one can.
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

/**
 * The scripts one call can play, in `./scenarios/<name>.json` (AAP 0.8.1). Every one of the twelve names AAP 0.8.1's
 * canonical inventory lists has its fixture here; the three after them — `machine`, `drop-before-prompt` and
 * `wants-human` — are accepted additions, each the fixture of an AAP-named rule the twelve do not reach: the two
 * remaining `no_answer` triggers of AAP 0.5.3's call-task table, and the callee who asks for a person. All three are
 * played end to end by `apps/api/test/integration/webhooks-voice.test.ts`'s fixture table.
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
  'machine',
  'drop-before-prompt',
  'wants-human',
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
 * What the classifier answers for one scripted utterance, and the values it reads back (AAP 0.5.6). `classify` is
 * absent when the turn is not classified at all, which is what `unclear` is for.
 */
const ScenarioClassify = z.strictObject({
  label: z.enum(UTTERANCE_LABELS),
  values: z.record(z.string(), ScenarioClassifyValue).optional(),
});

/**
 * One utterance the callee makes, and the classification the agent's classifier must read from it (AAP 0.5.6).
 * `lang` is the language it is spoken in, as a real transcription carries it.
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
  /**
   * Drop the socket abruptly once this many prompts have been sent. `0` drops it before any prompt — the "call dropped
   * before any data" trigger AAP 0.5.3 maps to `no_answer`; a positive count leaves partial data, which is the
   * `needs_review` case of the same row.
   */
  dropAfterTurn: z.number().int().min(0).optional(),
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
  machine: machineScenario,
  'drop-before-prompt': dropBeforePromptScenario,
  'wants-human': wantsHumanScenario,
};

/**
 * The parsed scenarios, built and deep-frozen on the first {@link loadScenarios} call and reused after that, so no
 * suite can change what a later one plays.
 */
let parsedScenarios: ReadonlyMap<ScenarioName, Scenario> | null = null;

/**
 * The names of the properties of the classifier's structured-output schema (AAP 0.5.6). Read from
 * {@link CLASSIFICATION_JSON_SCHEMA} rather than listed here, because `@tablemate/server-core` types its `schema` as a
 * plain record: the simulator mirrors whatever the classifier declares instead of a copy that can drift from it.
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
 * Every scripted scenario, parsed, validated and deep-frozen on the first call (AAP 0.11.2).
 *
 * Lazy on purpose: importing this module has no side effect, so a unit suite that only wants {@link scenarioClassifier}
 * or {@link twilioSignature} still parses nothing, and a broken scenario file fails the suite that reads it.
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
  const frozen = freezeScenarios(scenarios);
  parsedScenarios = frozen;
  return frozen;
}

/**
 * Enforce the scenario rules a plain object schema cannot state, each reported with its file: the refinements AAP 0.8.1
 * gives the scenario shape, plus the one the classifier depends on — a `classify.values` key has to be a property of
 * the classification schema, because a value it does not declare would be dropped by `understanding.ts`'s strict parse
 * and the turn would read as `unclear`. They run here rather than as a Zod refinement so the error can name the file.
 */
function assertScenarioRules(scenario: Scenario, file: string): void {
  const answered = !UNANSWERED_ANSWERS.includes(scenario.answer);
  // A script that drops before the first prompt has no question to answer, so it owes no turn
  // (AAP 0.5.3, "a call dropped before any data"); every other human answer owes at least one.
  const dropsOnOpen = scenario.dropAfterTurn === 0;
  if (
    scenario.answer === 'human' &&
    scenario.turns.length === 0 &&
    scenario.vendor === undefined &&
    !dropsOnOpen
  ) {
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
 * Refuse two turns that say the same thing but are classified differently. {@link scenarioClassifier} finds a turn by its
 * words, so identical words with two classifications would make a call's answer depend on which scenario the classifier
 * visited first.
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

/**
 * Freeze everything {@link loadScenarios} hands out, so the immutability it documents holds at runtime and not only in
 * its type (AAP 0.11.2).
 */
function freezeScenarios(
  scenarios: Map<ScenarioName, Scenario>,
): ReadonlyMap<ScenarioName, Scenario> {
  for (const scenario of scenarios.values()) {
    for (const turn of scenario.turns) {
      if (turn.classify !== undefined) {
        if (turn.classify.values !== undefined) {
          Object.freeze(turn.classify.values);
        }
        Object.freeze(turn.classify);
      }
      Object.freeze(turn);
    }
    Object.freeze(scenario.turns);
    Object.freeze(scenario);
  }
  const refuse = (): never => {
    throw new Error(
      'the scenario map is immutable: a suite that needs a different scenario should pass its own ' +
        'map through createVoiceSimulator({ scenarios })',
    );
  };
  for (const mutator of ['set', 'delete', 'clear'] as const) {
    Object.defineProperty(scenarios, mutator, {
      value: refuse,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  Object.freeze(scenarios);
  return scenarios;
}

/** A Zod failure as one line: every issue's path and message, in the order they were found. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`,
    )
    .join('; ');
}

/**
 * The stand-in for the provider's utterance classifier, reading a scenario's own words back. `LLM_PROVIDER=fake` answers
 * `{}` to every request, which would classify every turn as `unclear` and leave a scripted call stuck on its first
 * question; a suite hands this to `createFakeLlmAdapter({ respond })` so a call advances exactly as the scenario scripts it.
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
 * The scripted turn whose words appear last in `window`, or `null` when none appears. "Last" is where the match ends
 * rather than where it starts, so the most recent utterance wins even where an earlier one is a prefix of it.
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

/**
 * The create parameters the SDK sent, as they were observed (AAP 0.5.6). This is evidence about the dispatch itself:
 * `record` proves recording was never requested, `timeLimit` that the call is bounded by `CAP_CALL_SECONDS`, and
 * `statusCallbackEvent` which progress events it subscribed to (AAP 0.12.2). It is `null` for a call a test started
 * through {@link StartCallInput}.
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
 * One utterance the callee heard (AAP 0.12.2): the disclosure Twilio speaks from the TwiML, or a line the dialogue sent
 * as `text` frames. Recording the greeting separately lets a suite assert the disclosure came first.
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
 * Something the simulator could not do, or something the dialogue did that no scenario asked for. A failure never throws
 * into an unrelated test: it is recorded on the call under the step it happened at, and its detail carries a status, a
 * step name or an error code — never a phone number, a signature or an utterance (AAP 0.11.1).
 */
export interface SimFailure {
  step: string;
  detail: string;
}

/**
 * One simulated call: what the scenario scripted, what the API answered and what the simulator did (AAP 0.11.2).
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
 * A call a test starts directly, without a Twilio create (AAP 0.11.2). It builds the two URLs the dispatcher would have
 * built, from `apiPublicUrl` and the attempt id, and subscribes to all four progress events — which is how the relay, the
 * outcome and the refusal paths are tested without the dispatch queue in the loop.
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
   * The clock the resource timestamps and the `StartTime>` filter read: a suite passes the app's own test clock, so a
   * listing agrees with the API's injected time (AAP 0.11.1).
   */
  now?: () => Date;
  /** How long one step waits for the agent before it is recorded as a timeout. */
  stepTimeoutMs?: number;
}

/**
 * The simulator a suite drives (AAP 0.5.6, AAP 0.11.2). It is a {@link SimCallTarget}, so {@link VoiceSimulator.httpClient}
 * can be handed to `createTelephonyClient({ httpClient })` and every REST request the SDK builds is answered here.
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
 * `createVoiceSimulator`'s own target: the {@link SimCallTarget} the SDK's transport is handed, plus the wider
 * {@link VoiceSimulator.startCall} a test can call with a {@link StartCallInput}.
 */
interface SimulatorTarget extends SimCallTarget {
  startCall(
    input: SimCallCreateParams | StartCallInput,
  ): Promise<{ sid: string; status: 'queued' }>;
}

/**
 * Build the simulator a suite drives (AAP 0.5.6, AAP 0.11.2). All state — the calls, the per-number scenarios, the vendor
 * switch and the default scenario — lives in this closure, so a suite that builds two apps gets two independent
 * simulators.
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

  /**
   * Play one call: the callbacks Twilio posts, the TwiML it fetches, the relay it opens and the ending it reports.
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
   * Post one status callback for the current status (AAP 0.3.2). The body is validated against the shared callback schema
   * before it is signed — a self-check, so a simulator that sent a body the API would refuse fails here.
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
   * Fetch the ConversationRelay TwiML for the answered call and read it (AAP 0.5.6). The fetch carries the `CallSid`, the
   * machine-detection verdict and the attempt id in its query, which is what the route adopts the attempt from.
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
   * Post one request to the API, signed over the public URL and sent to the target's address. The two are deliberately
   * different: the API rebuilds the signed URL from `API_PUBLIC_URL`, so the signature can only match when it covers the
   * public address, while the connection has to reach wherever the API is listening.
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
      // Twilio reports the status and the duration together: `durationSec` is stamped with the
      // terminal status in `finishCall`, so the field stays `null` until the call has ended.
      duration: call.durationSec === null ? null : String(call.durationSec),
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

  /**
   * Open the relay socket, answer each agent utterance with the next scripted turn, and stop on the dialogue's `end`, on a
   * drop, on a close or on a timeout (AAP 0.5.6).
   */
  async function runRelay(runtime: SimRuntime, language: CallLanguage): Promise<void> {
    const { call, scenario } = runtime;
    // `0` closes the socket the moment the session is established, which is the "call dropped
    // before any data" trigger AAP 0.5.3 maps to `no_answer`.
    const dropAfterTurn = scenario.dropAfterTurn;
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
      // Before the first prompt and before waiting for one is the drop that leaves no data at all.
      if (dropAfterTurn === 0) {
        socket.terminate();
        break;
      }
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
      // partial data rather than as an answer (AAP 0.5.3). A count of 0 was already taken above.
      if (dropAfterTurn !== undefined && dropAfterTurn > 0 && sent >= dropAfterTurn) {
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

/** The last turn of a script, which a `loopLastTurn` scenario repeats. */
function lastTurn(turns: readonly ScenarioTurn[]): ScenarioTurn | undefined {
  return turns[turns.length - 1];
}

/**
 * Whether a create came from the SDK rather than from {@link StartCallInput}. The two forms are told apart by the URLs only
 * a create carries: a test's input names an attempt and a number, while the SDK's names the TwiML and status-callback URLs.
 */
function isCreateParams(input: SimCallCreateParams | StartCallInput): input is SimCallCreateParams {
  return 'twimlUrl' in input;
}

/**
 * Which progress events a call subscribes to: the ones it named, or all four. Twilio subscribes a call to every event when
 * `StatusCallbackEvent` is omitted, which is why an empty list means "all of them" (AAP 0.3.2).
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
 * An absolute `http(s)` URL's origin, or an error naming the option that was wrong. The simulator posts to an origin and
 * appends the public URL's own path and query, so a base address carrying a path is not used as one.
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
 * Read the ConversationRelay TwiML the API served (AAP 0.5.6). A small pattern-based reader rather than an XML parser: the
 * document is one this API wrote, its shape is fixed by `modules/voice-agent/twiml.ts`, and the three things a suite reads
 * off it sit in its first tag. Every attribute value is unescaped, because the greeting carries accents and apostrophes.
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

/** The port `VOICE_SIM_URL`'s server listens on when `PORT` names none. */
const DEFAULT_VOICE_SIM_PORT = 4010;

/** The most of a REST request body the server will read, so a runaway client cannot exhaust it. */
const MAX_REQUEST_BYTES = 64 * 1024;

/** The refusal a body over {@link MAX_REQUEST_BYTES} is answered with: the client's violation, not a fault. */
const PAYLOAD_TOO_LARGE = 'payload_too_large';

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
 * Serve the simulator over HTTP, for a process that is not the API (AAP 0.6.2, AAP 0.11.2). Two clients share this one
 * server: server-core's forwarding transport sends every REST request the SDK builds to `VOICE_SIM_URL`, so `apps/workers`
 * dispatches through it with no credential; and the compose `voice-sim` service is this binary.
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
        // A body over the bound is the caller's violation, not the simulator's own failure, so it is
        // answered as a client error rather than through the internal-failure path below (AAP 0.11.1).
        if (isPayloadTooLargeError(error)) {
          if (!response.headersSent) {
            response.writeHead(413, { 'content-type': 'application/json' });
          }
          response.end(JSON.stringify({ error: PAYLOAD_TOO_LARGE }));
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

/**
 * Read a request body, refusing one larger than {@link MAX_REQUEST_BYTES}: past it, nothing further is buffered. The rest of
 * the body is nevertheless drained to its end before the refusal is raised, because a client still uploading when the server
 * answers can see its socket reset instead of reading the response. The refusal is answered with `413`.
 */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  await new Promise<void>((resolve, reject) => {
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        oversized = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (oversized) {
        reject(payloadTooLargeError());
        return;
      }
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
 * A scenario name the map holds and this server may serve, or `null`. An unknown name is refused, and so is a
 * `vendor: 'down'` scenario: a refused connection cannot be expressed on one that was already accepted.
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
 * The refusal {@link readBody} raises for a body over {@link MAX_REQUEST_BYTES} (AAP 0.11.1). It carries its own `code` so
 * the server answers the client's violation with `413`, rather than letting it fall through to the `500`.
 */
function payloadTooLargeError(): Error {
  return Object.assign(
    new Error(`the voice simulator refuses a request body over ${MAX_REQUEST_BYTES / 1024} kib`),
    { code: PAYLOAD_TOO_LARGE },
  );
}

/** Whether a failure is the too-large-body refusal {@link payloadTooLargeError} builds. */
function isPayloadTooLargeError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === PAYLOAD_TOO_LARGE;
}

/**
 * Run the standalone server from the environment (`pnpm --filter @tablemate/api voice-sim`). Every variable is validated
 * before anything listens, and a failure names the variable and exits 1 with no value echoed.
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
