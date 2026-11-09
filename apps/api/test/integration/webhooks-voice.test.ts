/**
 * TwiML, status callbacks and the relay dialogue: the three surfaces of one automated call
 * (AAP 0.3.2, AAP 0.3.3, AAP 0.5.4, AAP 0.5.6, AAP 0.11.2).
 *
 * Every case here breaks one of the rules that hold the call together: the signature is checked over
 * the URL Twilio called and every field it posted, only attempt-tied evidence adopts a `CallSid`, a
 * callback has one effect however often it is delivered, and the dialogue says only what its fixed
 * templates say — disclosure first and in the city's language, an English switch that moves speech
 * and recognition together, a polite ending for a stopped or cancelled call, no lodging transcript,
 * and a cap on the sessions one instance serves.
 *
 * The relay cases are driven through the scripted simulator, whose signed callbacks and socket a case
 * reads back. Whether a call is dialled at all when no dialogue budget can be reserved is a `workers`
 * decision; what is asserted here is the API's side of that path — an attempt that reaches the relay
 * with no reservation sends no model request and ends politely.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import WebSocket from 'ws';

import {
  DAY_MS,
  RelayOutboundFrame,
  TWILIO_SIGNATURE_HEADER,
  VOICE_ATTEMPT_PARAMETER,
  type CallAttemptOutcome,
  type CallAttemptState,
  type CallTaskStatus,
  type RelayInboundFrame,
  type TwilioCallStatus,
} from '@tablemate/shared';
import {
  FAKE_LLM_PRICES,
  TWILIO_SIMULATOR,
  boundMicros,
  createFakeLlmAdapter,
  waitForRedisReady,
  type FakeLlmAdapter,
} from '@tablemate/server-core';

import { renderTemplate, type TemplateKey } from '../../src/modules/voice-agent/dialogue.ts';
import {
  CLASSIFICATION_MAX_OUTPUT_TOKENS,
  CLASSIFICATION_TURN_TIMEOUT_MS,
  buildClassificationRequest,
} from '../../src/modules/voice-agent/understanding.ts';

import { createTestApp, type TestApp } from '../support/app.ts';
import {
  callRoute,
  expectError,
  makeCallAttempt,
  makeCallTask,
  makeClaim,
  makeLodging,
  makePlace,
  makeUser,
  rows,
  type CallTaskFixture,
  type RouteResponse,
} from '../support/factories.ts';
import {
  scenarioClassifier,
  twilioSignature,
  type ScenarioName,
  type SimCall,
} from '../support/voice-simulator/simulator.ts';

import enUS from '../../src/modules/voice-agent/i18n/en-US.json' with { type: 'json' };
import esUS from '../../src/modules/voice-agent/i18n/es-US.json' with { type: 'json' };
import ptPT from '../../src/modules/voice-agent/i18n/pt-PT.json' with { type: 'json' };
import budgetExhaustion from '../support/voice-simulator/scenarios/budget-exhaustion.json' with { type: 'json' };
import wantsHumanScenario from '../support/voice-simulator/scenarios/wants-human.json' with { type: 'json' };
import yesScenario from '../support/voice-simulator/scenarios/yes.json' with { type: 'json' };

/* Constants, harness and helpers (AAP 0.3.3, AAP 0.11.2) */

/** The three voice surfaces, under the `/v1` prefix `app.ts` mounts the module with (AAP 0.5.4). */
const TWIML_PATH = '/v1/webhooks/voice/twiml';
const CALLBACK_PATH = '/v1/webhooks/voice';
const RELAY_PATH = '/v1/webhooks/voice/relay';

/** The city every menu case dials in, and the one whose pairing is Spanish (AAP 0.2.4). */
const LISBON = 'lisbon';
const MEXICO_CITY = 'mexico-city';

/** The city a Thai callee dials from, which is what makes the switch to English meaningful. */
const CHIANG_MAI = 'chiang-mai';

/** The attempt id the signature cases sign over: never looked up, because the check runs first. */
const UNKNOWN_ATTEMPT = '01930000-0000-7000-8000-000000000001';

/** A `CallSid` in the shape Twilio's SID has, so the routes read it as one. */
const SID = 'CA000000000000000000000000000000a1';
const SID_TWO = 'CA000000000000000000000000000000a2';

/** The booking name a stay call asks about, which no stored field may carry (AAP 0.5.2). */
const BOOKING_NAME = 'Fixture Guest';

/**
 * The most a case waits for a played call. The simulator holds every step to its own bound, and a
 * dialogue that closed through a closing line adds that line's playback time (AAP 0.5.6).
 */
const CALL_TIMEOUT_MS = 20_000;

/** A dialogue case's own bound, above the per-test default the harness sets. */
const DIALOGUE_TIMEOUT_MS = 30_000;

/* The harness (AAP 0.11.2) */

let t: TestApp;

/**
 * The adapter the app was built with. It is the same `fake` provider the factory would have built —
 * same scenario classifier, same prices — taken here as its own type so a case can read what was
 * counted and what was sent (AAP 0.5.6).
 */
let llm: FakeLlmAdapter;

/**
 * What `apps/workers`' `call-dispatch` reserves before it dials: one turn's bound at
 * `LLM_MAX_TURNS_PER_CALL`, which it stores in `CallAttempt.llmReservedMicros` (AAP 0.5.6). A live
 * call a case builds gets the same figure, because the relay refuses every turn without one.
 */
let dispatchedMicros = 0n;

beforeAll(async () => {
  llm = createFakeLlmAdapter({ respond: scenarioClassifier });
  t = await createTestApp({ llm });
  // Listening once here points the simulator's transport at the address for the whole file, so a
  // dialogue case does not depend on an earlier case having opened the socket (idempotent by design).
  await t.listen();
  dispatchedMicros = BigInt((await firstTurnBound()) * t.env.LLM_MAX_TURNS_PER_CALL);
});

beforeEach(async () => {
  await t.resetState();
  await t.seedCities();
  // The factory clears an adapter it built itself; this one is the case's, so its records are its own
  // to clear before the next case reads them (AAP 0.11.2).
  llm.calls.counted.length = 0;
  llm.calls.sent.length = 0;
});

afterAll(async () => {
  await t.close();
});

/* Addresses and signatures (AAP 0.3.3) */

/**
 * The address Twilio called: the public base plus the raw request target. The route rebuilds this
 * exact string, which is why signing anything else can never match (AAP 0.3.3).
 */
function publicUrl(path: string, attemptId: string | null): string {
  const query = attemptId === null ? '' : `?${VOICE_ATTEMPT_PARAMETER}=${attemptId}`;
  return `${t.env.API_PUBLIC_URL}${path}${query}`;
}

/** The public `wss://` address of the relay socket, which is what Twilio signs for an upgrade. */
function relayPublicUrl(): string {
  return `${t.env.API_PUBLIC_URL.replace(/^http/, 'ws')}${RELAY_PATH}`;
}

/** How a case tampers with a signature (AAP 0.3.3). */
type SignatureKind = 'valid' | 'wrong-token' | 'missing' | 'internal-host' | 'uncovered-field';

/** The fields Twilio posts when it fetches the TwiML of an answered call. */
function twimlParams(sid: string, answeredBy?: string): Record<string, string> {
  return {
    CallSid: sid,
    AccountSid: TWILIO_SIMULATOR.accountSid,
    From: TWILIO_SIMULATOR.fromNumber,
    To: '+14155550101',
    CallStatus: 'in-progress',
    ...(answeredBy === undefined ? {} : { AnsweredBy: answeredBy }),
  };
}

/** The fields Twilio posts for one status callback (AAP 0.3.2). */
function callbackParams(
  sid: string,
  status: TwilioCallStatus,
  sequenceNumber: number,
  errorCode?: string,
): Record<string, string> {
  return {
    CallSid: sid,
    AccountSid: TWILIO_SIMULATOR.accountSid,
    From: TWILIO_SIMULATOR.fromNumber,
    To: '+14155550101',
    CallStatus: status,
    SequenceNumber: String(sequenceNumber),
    ...(errorCode === undefined ? {} : { ErrorCode: errorCode }),
  };
}

/**
 * Post one Twilio form request, signed over the public URL and every posted field unless the case
 * asks for a tampered signature.
 */
async function postTwilio(
  path: string,
  params: Record<string, string>,
  options: { attemptId?: string | null; signature?: SignatureKind } = {},
): Promise<RouteResponse> {
  const attemptId = options.attemptId ?? null;
  const kind = options.signature ?? 'valid';
  const url = publicUrl(path, attemptId);

  // The tampering a case asks for: the internal address Twilio never dialled, another signing token,
  // a field left out of the signed set, or no header at all (AAP 0.3.3).
  const signedOver =
    kind === 'internal-host' ? `${await t.listen()}${url.slice(t.env.API_PUBLIC_URL.length)}` : url;
  // The uncovered-field case signs over every field but one of the ones it posts.
  const signedParams =
    kind === 'uncovered-field'
      ? Object.fromEntries(Object.entries(params).filter(([name]) => name !== 'To'))
      : params;
  const token =
    kind === 'wrong-token' ? `${TWILIO_SIMULATOR.authToken}-tampered` : TWILIO_SIMULATOR.authToken;

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (kind !== 'missing') {
    headers[TWILIO_SIGNATURE_HEADER] = twilioSignature(signedOver, signedParams, token);
  }

  return callRoute(t.app, {
    method: 'POST',
    url,
    body: new URLSearchParams(params).toString(),
    headers,
  });
}

/**
 * Open one raw relay socket against the API, signed over the public `wss://` address: the cap is
 * taken at the upgrade, so a case needs connections that hold their slots with no dialogue behind
 * them.
 */
function openRelay(
  baseUrl: string,
  signature: string | null,
): Promise<{ status: number | null; socket: WebSocket | null }> {
  const address = `${baseUrl.replace(/^http/, 'ws')}${RELAY_PATH}`;
  const socket = new WebSocket(
    address,
    signature === null ? {} : { headers: { [TWILIO_SIGNATURE_HEADER]: signature } },
  );

  return new Promise((resolve) => {
    socket.once('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? null;
      response.destroy();
      resolve({ status, socket: null });
    });
    socket.once('open', () => {
      resolve({ status: null, socket });
    });
    socket.once('error', () => {
      resolve({ status: null, socket: null });
    });
  });
}

/**
 * One relay conversation a case drives itself (AAP 0.3.3, 0.5.6): the `CallSid` a signed TwiML
 * fetch adopts for the call, a socket upgraded against the public address with a valid signature,
 * the `setup` frame that attaches the attempt, and every line the API speaks back.
 *
 * The simulator drives this same socket for the scripted scenarios. A case sends its own frames
 * where the framing no scenario file carries is what it is about: an utterance the relay has to cut
 * at its own byte bound, or a provider `error` frame.
 */
interface Conversation {
  /** The upgraded socket. */
  readonly socket: WebSocket;
  /** Send one frame, as Twilio would. */
  readonly send: (frame: RelayInboundFrame) => void;
  /** Every line the API has spoken so far, in order. */
  readonly spoken: () => readonly string[];
  /** Wait until a spoken line satisfies `match`, and return it (AAP 0.5.6). */
  readonly waitForSpoken: (match: (line: string) => boolean, what: string) => Promise<string>;
  /** Close the socket, as Twilio does when the call ends. */
  readonly close: () => Promise<void>;
}

/**
 * Open one relay conversation for `call` and attach it, so a case can send its own frames.
 *
 * The `CallSid` comes first: only a signed TwiML fetch of the answered call adopts it, and the relay
 * refuses a socket whose `setup` names another one (AAP 0.3.2).
 */
async function openConversation(call: LiveCall): Promise<Conversation> {
  await postTwilio(TWIML_PATH, twimlParams(SID), { attemptId: call.attemptId });

  const signature = twilioSignature(relayPublicUrl(), {}, TWILIO_SIMULATOR.authToken);
  const opened = await openRelay(await t.listen(), signature);
  const socket = opened.socket;
  if (socket === null) {
    throw new Error(
      `the relay refused an upgrade signed for the public address (${opened.status})`,
    );
  }

  const lines: string[] = [];
  socket.on('message', (data: unknown) => {
    const frame = RelayOutboundFrame.safeParse(JSON.parse(String(data)) as unknown);
    if (frame.success && frame.data.type === 'text') {
      lines.push(frame.data.token);
    }
  });

  const send = (frame: RelayInboundFrame): void => {
    socket.send(JSON.stringify(frame));
  };
  const spoken = (): readonly string[] => [...lines];
  const waitForSpoken = async (match: (line: string) => boolean, what: string): Promise<string> => {
    await waitUntil(() => lines.some(match), what);
    return lines.find(match) ?? '';
  };
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      if (socket.readyState === socket.CLOSED) {
        resolve();
        return;
      }
      socket.once('close', () => resolve());
      socket.close();
    });

  send({
    type: 'setup',
    sessionId: `VX${SID}`,
    callSid: SID,
    from: TWILIO_SIMULATOR.fromNumber,
    to: call.to,
    direction: 'outbound-api',
    customParameters: { [VOICE_ATTEMPT_PARAMETER]: call.attemptId },
  });
  await waitUntil(() => lines.length > 0, 'the first question');

  return { socket, send, spoken, waitForSpoken, close };
}

/* Fixtures (AAP 0.5.2, AAP 0.5.3) */

/** One live call a case drives: the attempt all three surfaces resolve, and what it dials. */
interface LiveCall {
  /** The `CallAttempt` id every URL and the relay `<Parameter>` carry. */
  readonly attemptId: string;
  /** The task the attempt belongs to, which the dialogue re-reads before every turn. */
  readonly taskId: string;
  /** The business number the simulated call dials, from the reserved fictional range. */
  readonly to: string;
}

/** What a live call may be built with; the states default to the ones a dialogue needs. */
interface LiveCallOptions {
  readonly cityId?: string;
  /** The attempt's dispatch state. Default `dialing`, which adoption keeps. */
  readonly state?: CallAttemptState;
  /** The task's state. Default `in_progress`. */
  readonly taskStatus?: CallTaskStatus;
  /** Mark the attempt superseded, as `apps/workers` does when a task is closed under it. */
  readonly superseded?: boolean;
  /** The dialogue budget the attempt holds, as `call-dispatch` stores it (AAP 0.5.6). */
  readonly llmReservedMicros?: bigint;
}

/**
 * Build one live `menu_prices` call: a place, its task, and an attempt no callback has adopted yet —
 * the state both adoption rules of AAP 0.3.2 start from.
 */
async function menuCall(
  options: LiveCallOptions = {},
): Promise<LiveCall & { readonly placeId: string }> {
  const place = await makePlace(t, { cityId: options.cityId ?? LISBON, category: 'restaurant' });
  const task = await makeCallTask(t, {
    kind: 'menu_prices',
    placeId: place.id,
    status: options.taskStatus ?? 'in_progress',
  });
  const attemptId = await startAttempt(task, options);
  return { attemptId, taskId: task.id, to: place.phone, placeId: place.id };
}

/**
 * Build one live `lodging_stay_verification` call whose claim names {@link BOOKING_NAME} (AAP 0.5.6).
 */
async function stayCall(): Promise<LiveCall & { readonly claimId: string }> {
  const user = await makeUser(t);
  const lodging = await makeLodging(t, { cityId: LISBON });
  const claim = await makeClaim(t, user, lodging, { bookingName: BOOKING_NAME });
  const task = await makeCallTask(t, {
    kind: 'lodging_stay_verification',
    lodgingId: lodging.id,
    lodgingClaimId: claim.id,
    status: 'in_progress',
  });
  const attemptId = await startAttempt(task, {});
  return { attemptId, taskId: task.id, to: lodging.phone, claimId: claim.id };
}

/**
 * Create one attempt in the state a case needs, with no `CallSid` yet: the fixture builder always
 * writes one so the unique column stays unique, and a call this suite drives is one no callback has
 * adopted — the signed fetch or callback carrying the attempt id is what adopts it (AAP 0.3.2).
 */
async function startAttempt(task: CallTaskFixture, options: LiveCallOptions): Promise<string> {
  const attempt = await makeCallAttempt(t, task, {
    state: options.state ?? 'dialing',
    llmReservedMicros: options.llmReservedMicros ?? dispatchedMicros,
  });
  await t.services.db.callAttempt.update({
    where: { id: attempt.id },
    data: {
      twilioCallSid: null,
      ...(options.superseded === true ? { superseded: true } : {}),
    },
  });
  return attempt.id;
}

/* Reads and waits (AAP 0.11.2) */

/** The attempt row as a case reads it. */
async function attemptRow(id: string) {
  return t.services.db.callAttempt.findUniqueOrThrow({ where: { id } });
}

/**
 * The attempt row once its outcome is recorded: the relay writes it in its own transaction, which can
 * settle just after the socket the simulator watched has closed (AAP 0.3.2).
 */
async function settledAttempt(id: string, expected: CallAttemptOutcome) {
  await waitUntil(async () => (await attemptRow(id)).outcome === expected, `${id} → ${expected}`);
  return attemptRow(id);
}

/** Wait for `done`, polling every 25 ms, and fail with `what` when it has not held in time. */
async function waitUntil(
  done: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await done()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The city-local day's budget row, or `null` when nothing was ever metered for it (AAP 0.5.6). */
async function budgetRow(cityId: string) {
  return t.services.db.callBudgetDay.findFirst({ where: { cityId } });
}

/** The `apply_call_result` rows, which are what `apps/workers` applies to a task (AAP 0.3.2). */
async function resultRows() {
  return t.services.db.outboxMessage.findMany({ where: { kind: 'apply_call_result' } });
}

/** Play one scripted call the simulator starts itself, and return the finished call (AAP 0.5.6). */
async function playCall(call: LiveCall, scenario: ScenarioName): Promise<SimCall> {
  const { sid } = await t.simulator.startCall({ attemptId: call.attemptId, to: call.to, scenario });
  return t.simulator.waitForCall(sid, { timeoutMs: CALL_TIMEOUT_MS });
}

/** The menu items one attempt extracted, as `apps/workers`' `call-results` reads them. */
interface MenuFields {
  readonly kind: string;
  readonly items: readonly { readonly slot: string; readonly confirmed: boolean }[];
}

/** A menu attempt's extracted fields, asserted to be the shape `call-results` reads. */
function menuFields(row: { readonly extractedFields: unknown }): MenuFields {
  const fields = row.extractedFields as MenuFields | null;
  expect(fields).not.toBeNull();
  return fields as MenuFields;
}

/**
 * One attribute of the `ConversationRelay` tag exactly as the document spells it, or `null`.
 *
 * The document is one this API writes and the tag is unique, so a case reads the bytes rather than
 * running a parser over them. The values compared against it — the pt-PT and es-US disclosures and
 * the relay address — carry no XML-significant character, so the escaped form is the literal one.
 */
function relayAttribute(xml: string, name: string): string | null {
  const tag = /<\s*ConversationRelay\b([^>]*)>/i.exec(xml);
  return tag === null ? null : (new RegExp(`\\b${name}="([^"]*)"`).exec(tag[1] ?? '')?.[1] ?? null);
}

/* The signature (AAP 0.3.3, AAP 0.5.4) */

/** One tampering a signature case applies, and the surface it applies it to. */
interface SignatureRow {
  readonly surface: string;
  readonly path: string;
  readonly kind: SignatureKind;
}

/** Both HTTP callbacks, tampered four ways each: the refusals AAP 0.3.3 names. */
const SIGNATURE_ROWS: readonly SignatureRow[] = [
  { surface: 'the TwiML fetch', path: TWIML_PATH, kind: 'missing' },
  { surface: 'the TwiML fetch', path: TWIML_PATH, kind: 'wrong-token' },
  { surface: 'the TwiML fetch', path: TWIML_PATH, kind: 'internal-host' },
  { surface: 'the TwiML fetch', path: TWIML_PATH, kind: 'uncovered-field' },
  { surface: 'the status callback', path: CALLBACK_PATH, kind: 'missing' },
  { surface: 'the status callback', path: CALLBACK_PATH, kind: 'wrong-token' },
  { surface: 'the status callback', path: CALLBACK_PATH, kind: 'internal-host' },
  { surface: 'the status callback', path: CALLBACK_PATH, kind: 'uncovered-field' },
];

describe('the Twilio request signature', () => {
  it.each(rows(SIGNATURE_ROWS))('refuses $surface signed $kind', async (row) => {
    const params = row.path === TWIML_PATH ? twimlParams(SID) : callbackParams(SID, 'initiated', 1);
    const response = await postTwilio(row.path, params, {
      attemptId: UNKNOWN_ATTEMPT,
      signature: row.kind,
    });

    expectError(response, 400, 'bad_signature');
  });

  it.each(
    rows([
      { label: 'a wrong token', tampered: true },
      { label: 'no header at all', tampered: false },
    ]),
  )('refuses a relay upgrade signed with $label', async (row) => {
    const signature = row.tampered
      ? twilioSignature(relayPublicUrl(), {}, `${TWILIO_SIMULATOR.authToken}-tampered`)
      : null;

    expect((await openRelay(await t.listen(), signature)).status).toBe(400);
  });

  it('accepts a correctly signed status callback and parses its form body', async () => {
    const call = await menuCall();
    const response = await postTwilio(CALLBACK_PATH, callbackParams(SID, 'initiated', 1), {
      attemptId: call.attemptId,
    });

    expect(response.status).toBe(204);
  });
});

/* The TwiML (AAP 0.3.2, AAP 0.5.4, AAP 0.5.6) */

describe('the ConversationRelay TwiML', () => {
  it('opens a Lisbon menu call in Portuguese, with the disclosure first', async () => {
    const call = await menuCall();
    const response = await postTwilio(TWIML_PATH, twimlParams(SID), { attemptId: call.attemptId });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/xml');
    expect(relayAttribute(response.body, 'url')).toBe(relayPublicUrl());
    expect(relayAttribute(response.body, 'welcomeGreeting')).toBe(ptPT['greeting.menu_prices']);
    expect(relayAttribute(response.body, 'language')).toBe('pt-PT');
    expect(response.body).toContain('<Language code="pt-PT"');
    expect(response.body).toContain('<Language code="en-US"');
    expect(response.body).toContain(
      `<Parameter name="${VOICE_ATTEMPT_PARAMETER}" value="${call.attemptId}"/>`,
    );
  });

  it('opens a Mexico City call in Spanish and a stay call with its own disclosure', async () => {
    const menu = await menuCall({ cityId: MEXICO_CITY });
    const answer = await postTwilio(TWIML_PATH, twimlParams(SID), { attemptId: menu.attemptId });
    expect(relayAttribute(answer.body, 'language')).toBe('es-US');
    expect(relayAttribute(answer.body, 'welcomeGreeting')).toBe(esUS['greeting.menu_prices']);

    const stay = await stayCall();
    const stayAnswer = await postTwilio(TWIML_PATH, twimlParams(SID_TWO), {
      attemptId: stay.attemptId,
    });
    expect(relayAttribute(stayAnswer.body, 'welcomeGreeting')).toBe(
      ptPT['greeting.lodging_stay_verification'],
    );
  });

  it('hangs up on a machine and records the call as unanswered', async () => {
    const call = await menuCall();
    const response = await postTwilio(TWIML_PATH, twimlParams(SID, 'machine_start'), {
      attemptId: call.attemptId,
    });

    expect(response.body).toContain('<Hangup/>');
    expect((await settledAttempt(call.attemptId, 'no_answer')).outcome).toBe('no_answer');
  });

  it('hangs up on a task that is no longer in progress', async () => {
    const call = await menuCall({ taskStatus: 'cancelled' });
    const response = await postTwilio(TWIML_PATH, twimlParams(SID), { attemptId: call.attemptId });

    expect(response.body).toContain('<Hangup/>');
    expect((await settledAttempt(call.attemptId, 'no_answer')).outcome).toBe('no_answer');
  });

  it('hangs up on an attempt superseded mid-call', async () => {
    const call = await menuCall({ superseded: true });
    const response = await postTwilio(TWIML_PATH, twimlParams(SID), { attemptId: call.attemptId });

    expect(response.body).toContain('<Hangup/>');
    expect((await settledAttempt(call.attemptId, 'no_answer')).outcome).toBe('no_answer');
  });

  it('adopts the CallSid of a signed fetch that carries the attempt id', async () => {
    const call = await menuCall({ state: 'dispatch_unknown' });
    const response = await postTwilio(TWIML_PATH, twimlParams(SID), { attemptId: call.attemptId });

    expect(response.status).toBe(200);
    const row = await attemptRow(call.attemptId);
    expect(row.twilioCallSid).toBe(SID);
    expect(row.state).toBe('dialing');
  });
});

/* The status callback (AAP 0.3.2, AAP 0.5.3, AAP 0.5.4) */

/** One final status, and the outcome this route records for it. */
interface FinalStatusRow {
  readonly status: TwilioCallStatus;
  readonly errorCode?: string;
  readonly outcome: CallAttemptOutcome;
}

/** Every final status the route maps, and the invalid-number case beside them. */
const FINAL_STATUS_ROWS: readonly FinalStatusRow[] = [
  { status: 'busy', outcome: 'no_answer' },
  { status: 'no-answer', outcome: 'no_answer' },
  { status: 'canceled', outcome: 'no_answer' },
  { status: 'failed', outcome: 'no_answer' },
  { status: 'failed', errorCode: '21211', outcome: 'unreachable' },
];

describe('the call-status callback', () => {
  it('records one callback when the same event is delivered twice', async () => {
    const call = await menuCall();
    const params = callbackParams(SID, 'initiated', 1);

    expect((await postTwilio(CALLBACK_PATH, params, { attemptId: call.attemptId })).status).toBe(
      204,
    );
    expect((await postTwilio(CALLBACK_PATH, params, { attemptId: call.attemptId })).status).toBe(
      204,
    );
    expect(await t.services.db.voiceCallbackEvent.count()).toBe(1);
  });

  it('adopts a CallSid from a signed callback that names the attempt', async () => {
    const call = await menuCall();
    const response = await postTwilio(CALLBACK_PATH, callbackParams(SID, 'ringing', 1), {
      attemptId: call.attemptId,
    });

    expect(response.status).toBe(204);
    expect((await attemptRow(call.attemptId)).twilioCallSid).toBe(SID);
  });

  it('adopts nothing from a callback that names no attempt', async () => {
    const call = await menuCall();
    const response = await postTwilio(CALLBACK_PATH, callbackParams(SID, 'ringing', 1), {
      attemptId: null,
    });

    expectError(response, 400, 'invalid_field');
    expect((await attemptRow(call.attemptId)).twilioCallSid).toBeNull();
    expect(await t.services.db.voiceCallbackEvent.count()).toBe(0);
  });

  it.each(rows(FINAL_STATUS_ROWS))('maps a $status callback to $outcome', async (row) => {
    const call = await menuCall();
    const response = await postTwilio(
      CALLBACK_PATH,
      callbackParams(SID, row.status, 4, row.errorCode),
      { attemptId: call.attemptId },
    );

    expect(response.status).toBe(204);
    const attempt = await settledAttempt(call.attemptId, row.outcome);
    expect(attempt.state).toBe('ended');
    expect(attempt.endedAt).not.toBeNull();
    expect(await resultRows()).toHaveLength(1);
  });

  it('records one outcome when two final callbacks arrive', async () => {
    const call = await menuCall();

    expect(
      (
        await postTwilio(CALLBACK_PATH, callbackParams(SID, 'busy', 4), {
          attemptId: call.attemptId,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await postTwilio(CALLBACK_PATH, callbackParams(SID, 'completed', 5), {
          attemptId: call.attemptId,
        })
      ).status,
    ).toBe(204);

    expect((await settledAttempt(call.attemptId, 'no_answer')).outcome).toBe('no_answer');
    expect(await resultRows()).toHaveLength(1);
  });

  it('acknowledges a callback for an attempt whose call content was stripped', async () => {
    const call = await menuCall({ state: 'ended' });
    const response = await postTwilio(CALLBACK_PATH, callbackParams(SID, 'completed', 6), {
      attemptId: call.attemptId,
    });

    expect(response.status).toBe(204);
    expect(await t.services.db.voiceCallbackEvent.count()).toBe(0);
    const row = await attemptRow(call.attemptId);
    expect(row.outcome).toBeNull();
    expect(row.twilioCallSid).toBeNull();
  });
});

/* The relay dialogue (AAP 0.3.2, AAP 0.5.3, AAP 0.5.6) */

describe('the relay dialogue', () => {
  it(
    'runs a Lisbon menu call to a completed extraction',
    async () => {
      const call = await menuCall();
      const played = await playCall(call, 'prices-high');

      expect(played.spoken[0]?.text).toBe(ptPT['greeting.menu_prices']);
      const row = await settledAttempt(call.attemptId, 'completed');
      expect(row.confidence).toBe('high');
      // The third question's item is stored under the drink's own slot: a coffee is not a beer.
      expect(menuFields(row).items.map((item) => item.slot)).toEqual([
        'cheapest_main',
        'priciest_main',
        'coffee',
      ]);
      expect(menuFields(row).items.every((item) => item.confirmed)).toBe(true);
      expect(row.transcript).not.toBeNull();
      expect(row.transcriptDeleteAt?.getTime()).toBe(t.services.clock.nowMs() + 30 * DAY_MS);
      expect(await resultRows()).toHaveLength(1);
    },
    DIALOGUE_TIMEOUT_MS,
  );

  it(
    'leaves a call that could not confirm its prices for review',
    async () => {
      const call = await menuCall();
      await playCall(call, 'prices-low');

      const row = await settledAttempt(call.attemptId, 'needs_review');
      expect(row.confidence).toBe('low');
      expect(menuFields(row).items.some((item) => !item.confirmed)).toBe(true);
    },
    DIALOGUE_TIMEOUT_MS,
  );

  it(
    'switches a Thai call to English when the callee asks',
    async () => {
      const call = await menuCall({ cityId: CHIANG_MAI });
      const played = await playCall(call, 'english-switch');

      expect(played.languageSwitches[0]).toEqual({
        ttsLanguage: 'en-US',
        transcriptionLanguage: 'en-US',
      });
      const spoken = played.spoken.map((line) => line.text);
      expect(spoken).toContain(enUS['switch.english']);
      expect(spoken).toContain(enUS['ask.cheapest_main']);
      expect((await settledAttempt(call.attemptId, 'completed')).confidence).toBe('high');
    },
    DIALOGUE_TIMEOUT_MS,
  );

  it(
    'ends a call when the callee asks it to stop',
    async () => {
      const call = await menuCall();
      const played = await playCall(call, 'stop');

      expect(played.spoken.map((line) => line.text)).toContain(ptPT['closing.refused']);
      expect(played.endReceived).toBe(true);
      expect((await settledAttempt(call.attemptId, 'refused')).outcome).toBe('refused');
    },
    DIALOGUE_TIMEOUT_MS,
  );

  it(
    'honours a do-not-call request for the whole target',
    async () => {
      const call = await menuCall();
      const sibling = await makeCallTask(t, {
        kind: 'menu_prices',
        placeId: call.placeId,
        status: 'queued',
      });
      const played = await playCall(call, 'do-not-call');

      expect(played.spoken.map((line) => line.text)).toContain(ptPT['closing.do_not_call']);
      expect((await settledAttempt(call.attemptId, 'do_not_call')).outcome).toBe('do_not_call');
      const place = await t.services.db.place.findUniqueOrThrow({ where: { id: call.placeId } });
      expect(place.doNotCall).toBe(true);
      const queued = await t.services.db.callTask.findUniqueOrThrow({ where: { id: sibling.id } });
      expect(queued.status).toBe('cancelled');
    },
    DIALOGUE_TIMEOUT_MS,
  );

  it(
    'closes a call whose task was cancelled under it',
    async () => {
      const call = await menuCall();
      const { sid } = await t.simulator.startCall({
        attemptId: call.attemptId,
        to: call.to,
        scenario: 'prices-high',
      });
      const playing = t.simulator.calls.find((entry) => entry.sid === sid);

      await waitUntil(() => (playing?.spoken.length ?? 0) >= 2, 'the first question to be spoken');
      await t.services.db.callTask.update({
        where: { id: call.taskId },
        data: { status: 'cancelled' },
      });

      const played = await t.simulator.waitForCall(sid, { timeoutMs: CALL_TIMEOUT_MS });
      expect(played.endReceived).toBe(true);
      expect([ptPT['closing.thanks'], ptPT['closing.refused']]).toContain(
        played.spoken[played.spoken.length - 1]?.text,
      );
    },
    DIALOGUE_TIMEOUT_MS,
  );

  it(
    'keeps no booking name in what a stay call stores',
    async () => {
      const call = await stayCall();
      const played = await playCall(call, 'yes');

      expect(played.spoken.some((line) => line.text.includes(BOOKING_NAME))).toBe(true);
      const row = await settledAttempt(call.attemptId, 'completed');
      expect(row.confidence).toBe('high');
      expect(row.transcript).toBeNull();
      expect(`${row.summary ?? ''}${JSON.stringify(row.extractedFields)}`).not.toContain(
        BOOKING_NAME,
      );
      expect(row.extractedFields).toMatchObject({
        kind: 'lodging_stay_verification',
        answer: 'yes',
        confirmed: true,
      });
    },
    DIALOGUE_TIMEOUT_MS,
  );

  it('refuses a third concurrent relay session on an instance capped at two', async () => {
    const capped = await createTestApp({ env: { VOICE_RELAY_MAX_SESSIONS: '2' } });
    try {
      const baseUrl = await capped.listen();
      // The per-IP counter of the route fails closed while its fail-fast Redis connection is still
      // connecting, so the app is waited for rather than the first upgrade racing it (AAP 0.3.2).
      await waitForRedisReady(capped.services.redis.client);
      const signature = twilioSignature(relayPublicUrl(), {}, TWILIO_SIMULATOR.authToken);

      const first = await openRelay(baseUrl, signature);
      const second = await openRelay(baseUrl, signature);
      const third = await openRelay(baseUrl, signature);

      expect([first.status, second.status]).toEqual([null, null]);
      expect(third.status).toBe(503);
      first.socket?.close();
      second.socket?.close();
    } finally {
      await capped.close();
    }
  });

  /**
   * The two framings of an utterance that outgrows the classification window (AAP 0.5.6): the pieces
   * that together pass it, and one `last` frame that does so on its own. Only the framing differs, so
   * both are rows of one case — and both owe the same answer, because the relay holds neither.
   */
  const OVERLONG_ROWS: readonly {
    readonly name: string;
    readonly pieces: readonly number[];
  }[] = [
    { name: 'prompt frames that together outgrow the window', pieces: [900, 900, 900, 40] },
    { name: 'one last frame that outgrows the window on its own', pieces: [2_100] },
  ];

  it.each(rows(OVERLONG_ROWS))(
    'answers $name with the retry line and no model request',
    async (row) => {
      const call = await menuCall();
      const relay = await openConversation(call);
      try {
        expect(relay.spoken()).toEqual([ptPT['ask.cheapest_main']]);
        const before = { counted: llm.calls.counted.length, sent: llm.calls.sent.length };

        row.pieces.forEach((length, index) => {
          relay.send({
            type: 'prompt',
            voicePrompt: 'z'.repeat(length),
            lang: 'pt-PT',
            last: index === row.pieces.length - 1,
          });
        });

        // The call is not left listening: the turn is answered, in the call's own language, and the
        // socket stays open for the next question (AAP 0.5.6).
        expect(
          await relay.waitForSpoken((line) => line === ptPT['retry.unclear'], 'the retry line'),
        ).toBe(ptPT['retry.unclear']);
        expect(relay.spoken()).toEqual([ptPT['ask.cheapest_main'], ptPT['retry.unclear']]);
        expect(relay.socket.readyState).toBe(WebSocket.OPEN);

        // Nothing of the overlong utterance reached the provider: no request was counted or sent for
        // that turn, so nothing was charged to the call's dialogue budget (AAP 0.5.6).
        expect(llm.calls.counted).toHaveLength(before.counted);
        expect(llm.calls.sent).toHaveLength(before.sent);
      } finally {
        await relay.close();
      }
      // The socket going settles the call the relay's own way, and nothing the cut utterance carried
      // reaches the recorded result (AAP 0.5.3).
      expect((await settledAttempt(call.attemptId, 'no_answer')).outcome).toBe('no_answer');
    },
    DIALOGUE_TIMEOUT_MS,
  );

  it(
    'keeps the words a provider error frame carries out of the call',
    async () => {
      const call = await stayCall();
      const relay = await openConversation(call);
      try {
        await relay.waitForSpoken(
          (line) => line.includes(BOOKING_NAME),
          'the question naming the guest',
        );

        // Twilio's documented 64111 payload, verbatim in shape: the application's own unspoken tokens,
        // which on a stay call are the question naming the guest and the two dates (AAP 0.5.2, 0.11.1).
        relay.send({
          type: 'error',
          description: `Error converting tokens to speech, code: 64111, error: , tokens: ${BOOKING_NAME} staying 10 November 2026 to 14 November 2026`,
        });

        // The frame ends nothing and changes nothing about the call: the guest's answers are still
        // classified and the dialogue still reaches its own ending (AAP 0.5.6).
        for (const turn of yesScenario.turns) {
          relay.send({ type: 'prompt', voicePrompt: turn.say, lang: 'pt-PT', last: true });
        }
        expect(
          await relay.waitForSpoken((line) => line === ptPT['closing.thanks'], 'the closing line'),
        ).toBe(ptPT['closing.thanks']);
      } finally {
        await relay.close();
      }
      // The call reached its own outcome, so the frame the provider sent ended nothing on this side
      // (AAP 0.5.3, 0.5.6).
      expect((await settledAttempt(call.attemptId, 'completed')).outcome).toBe('completed');
    },
    DIALOGUE_TIMEOUT_MS,
  );
});

/* The scenario fixtures (AAP 0.5.3, AAP 0.5.6) */

/**
 * One scenario fixture the suite plays end to end, and the ending AAP gives it.
 *
 * `machine` and `drop-before-prompt` are the two remaining `no_answer` triggers of AAP 0.5.3's
 * call-task table — an answering machine and a call dropped before any data — and `wants-human` the
 * request for a person AAP 0.5.6 answers with `closing.refused` and outcome `refused`. Playing the
 * fixture is what each row proves: the document the TwiML route answers with, what the relay socket
 * carried and the outcome the attempt settles at all come from the scenario file rather than from a
 * callback the case posted itself.
 */
interface FixtureRow {
  /** The scenario file the simulator plays for a live call. */
  readonly scenario: ScenarioName;
  /** The outcome the attempt settles at, as AAP 0.5.3 and AAP 0.5.6 give this ending. */
  readonly outcome: CallAttemptOutcome;
  /** Twilio's machine-detection verdict: `machine_start` for the answering machine. */
  readonly answeredBy: string;
  /** True when the TwiML fetch was answered `<Hangup/>` instead of a relay document. */
  readonly hangup: boolean;
  /** The closing line the callee hears, or null when the call ends without one. */
  readonly closing: TemplateKey | null;
  /** True when the dialogue ended the session itself with a ConversationRelay `end`. */
  readonly endReceived: boolean;
  /** What the callee says, from the scenario's own turns (AAP 0.5.6). */
  readonly prompts: readonly string[];
}

/** Every fixture no other suite plays, and the ending its script must produce. */
const FIXTURE_ROWS: readonly FixtureRow[] = [
  {
    scenario: 'machine',
    outcome: 'no_answer',
    answeredBy: 'machine_start',
    hangup: true,
    closing: null,
    endReceived: false,
    prompts: [],
  },
  {
    scenario: 'drop-before-prompt',
    outcome: 'no_answer',
    answeredBy: 'human',
    hangup: false,
    closing: null,
    endReceived: false,
    prompts: [],
  },
  {
    scenario: 'wants-human',
    outcome: 'refused',
    answeredBy: 'human',
    hangup: false,
    closing: 'closing.refused',
    endReceived: true,
    prompts: wantsHumanScenario.turns.map((turn) => turn.say),
  },
];

describe('the scenario fixtures', () => {
  it.each(rows(FIXTURE_ROWS))(
    'settles a played $scenario call as $outcome',
    async (row) => {
      const call = await menuCall();
      const played = await playCall(call, row.scenario);

      expect(played.scenario).toBe(row.scenario);
      expect(played.answeredBy).toBe(row.answeredBy);
      expect(played.twiml.hangup).toBe(row.hangup);
      expect(played.promptsSent.map((prompt) => prompt.text)).toEqual(row.prompts);
      expect(played.failures).toEqual([]);
      if (row.hangup) {
        // No relay document: the machine hears nothing and no prompt is ever sent.
        expect(played.twiml.relayUrl).toBeNull();
        expect(played.spoken).toEqual([]);
      } else {
        // The disclosure is still the first line: Twilio speaks it from the TwiML, in the city's own
        // language (AAP 0.12.2).
        expect(played.spoken[0]?.text).toBe(ptPT['greeting.menu_prices']);
      }
      if (row.closing === null) {
        expect(played.endReceived).toBe(false);
      } else {
        expect(played.endReceived).toBe(true);
        expect(played.spoken.map((line) => line.text)).toContain(ptPT[row.closing]);
      }

      const attempt = await settledAttempt(call.attemptId, row.outcome);
      expect(attempt.state).toBe('ended');
      // Neither of the three endings has data behind it: the outcome is recorded and nothing is
      // invented — no confidence, no extracted fields (AAP 0.5.3, AAP 0.5.6).
      expect(attempt.confidence).toBeNull();
      expect(attempt.extractedFields).toBeNull();
      expect(await resultRows()).toHaveLength(1);
    },
    DIALOGUE_TIMEOUT_MS,
  );
});

/* The dialogue budget (AAP 0.3.2, AAP 0.5.6) */

/**
 * The counted bound of the dialogue's first turn, in micro-dollars: the figure a call's budget is
 * built from, taken from the app's own adapter and the price table the meter charges with rather than
 * picked by hand (AAP 0.5.6).
 */
async function firstTurnBound(): Promise<number> {
  const utterance = budgetExhaustion.turns[0]?.say ?? '';
  const request = buildClassificationRequest(
    [`agent: ${renderTemplate('pt-PT', 'ask.cheapest_main')}`, `callee: ${utterance}`],
    'dish_and_price',
    utterance,
    [],
  );
  const counted = await llm.countInputTokens(request, {
    timeoutMs: CLASSIFICATION_TURN_TIMEOUT_MS,
  });

  return boundMicros(counted, CLASSIFICATION_MAX_OUTPUT_TOKENS, FAKE_LLM_PRICES);
}

describe('the dialogue budget', () => {
  it(
    'sends no model request when the call holds no reservation',
    async () => {
      const call = await menuCall({ llmReservedMicros: 0n });
      const played = await playCall(call, 'prices-high');

      expect(played.spoken.map((line) => line.text)).toContain(ptPT['closing.budget']);
      expect((await settledAttempt(call.attemptId, 'needs_review')).confidence).toBe('low');
      // The count is free and still runs; what must not happen is a sent classification.
      expect(llm.calls.sent).toHaveLength(0);
    },
    DIALOGUE_TIMEOUT_MS,
  );

  it(
    'refuses the turn that does not fit the reservation the call holds',
    async () => {
      // Two turns of budget: the third turn's bound cannot fit what the first two left (AAP 0.5.6).
      const budget = 2 * (await firstTurnBound());
      expect(await t.services.spend.reserveLlm(LISBON, budget)).not.toBeNull();

      const call = await menuCall({ llmReservedMicros: BigInt(budget) });
      const played = await playCall(call, 'budget-exhaustion');

      expect(played.spoken.map((line) => line.text)).toContain(ptPT['closing.budget']);
      expect((await settledAttempt(call.attemptId, 'needs_review')).confidence).toBe('low');

      // The unused part of the reservation is released in the after-commit step of the transaction
      // that records the outcome, so the counter is waited for rather than read once (AAP 0.3.2).
      await waitUntil(
        async () => (await budgetRow(LISBON))?.llmReservedMicros === 0n,
        'the unused dialogue budget to be released',
      );
      const day = await budgetRow(LISBON);
      const spent = Number(day?.llmSpendMicros ?? 0n);
      expect(spent).toBeGreaterThan(0);
      expect(spent).toBeLessThanOrEqual(budget);
      // Every micro-dollar the call did not spend is back on the day's counter (AAP 0.5.6).
      expect(day?.llmReservedMicros).toBe(0n);
    },
    DIALOGUE_TIMEOUT_MS,
  );
});
