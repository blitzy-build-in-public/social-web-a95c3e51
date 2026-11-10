/**
 * The shared dialogue engine: the turn loop of an automated call and the one exactly-once writer of a call attempt's
 * outcome.
 *
 * Four invariants hold it: the disclosure comes first, in the city's own language; every word spoken comes from an
 * `./i18n/*.json` template, never from the language model; a value counts only once it has been read back and
 * confirmed, which is what makes `high` confidence honest and leaves everything else `low`; and
 * {@link recordAttemptOutcome} is the single writer of an attempt's outcome — every writer takes {@link lockAttempt}
 * first, and an attempt that already carries an outcome writes nothing, so a racing status callback and a relay
 * finalize produce one result.
 *
 * Nothing here logs, returns or throws the callee's words: a log line carries an event name, the attempt id, an
 * outcome and, per turn, the label that turn classified as, which is what lets `voice_call_no_data` tell a call the
 * dialogue never understood from one nobody answered. A booking name is redacted out of the classification window
 * rather than left to the provider's discretion.
 */

import {
  Prisma,
  type CallAttempt,
  type CallTask,
  type DbClient,
  type DbTx,
  type LodgingClaim,
} from '@tablemate/db';
import {
  CallLanguage,
  type CallAttemptOutcome,
  type CallAttemptState,
  type CallTaskKind,
  type CallTaskStatus,
  type Confidence,
  type RelayOutboundFrame,
} from '@tablemate/shared';
import {
  localDateKey,
  type Clock,
  type LlmAdapter,
  type LlmReservation,
  type LlmSpend,
  type Logger,
} from '@tablemate/server-core';

import { transact, writeOutbox, type AfterCommit, type TransactServices } from '../outbox/write.ts';

import { lodgingStayVerificationScript } from './scripts/lodging-stay-verification.ts';
import { menuPricesScript } from './scripts/menu-prices.ts';
import {
  UNCLEAR_CLASSIFICATION,
  classifyUtterance,
  describeClassificationFailure,
  type Classification,
  type ClassificationContext,
  type ExpectedAnswer,
  type UtteranceLabel,
} from './understanding.ts';

import enUS from './i18n/en-US.json' with { type: 'json' };
import esUS from './i18n/es-US.json' with { type: 'json' };
import idID from './i18n/id-ID.json' with { type: 'json' };
import ptPT from './i18n/pt-PT.json' with { type: 'json' };
import thTH from './i18n/th-TH.json' with { type: 'json' };

/**
 * Every key the five `./i18n/*.json` files carry. A language missing one, or carrying one the others do not, fails
 * at module load rather than going silent mid-call.
 */
export const TEMPLATE_KEYS = [
  'greeting.menu_prices',
  'greeting.lodging_stay_verification',
  'ask.cheapest_main',
  'ask.priciest_main',
  'ask.coffee_or_beer',
  'ask.stay',
  'readback.price',
  'readback.stay',
  'confirm.prompt',
  'retry.unclear',
  'switch.english',
  'closing.thanks',
  'closing.refused',
  'closing.do_not_call',
  'closing.budget',
] as const;

/** One template key. A misspelt key in a script fails to compile against this type. */
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const TEMPLATE_VARS = ['dish', 'price', 'bookingName', 'stayFrom', 'stayTo'] as const;

export type TemplateVar = (typeof TEMPLATE_VARS)[number];

export type TemplateVars = Partial<Record<TemplateVar, string>>;

/** The greeting key of each call kind, which is the disclosure the call opens with (AAP 0.5.6). */
const GREETING_KEYS: Readonly<Record<CallTaskKind, TemplateKey>> = {
  menu_prices: 'greeting.menu_prices',
  lodging_stay_verification: 'greeting.lodging_stay_verification',
};

/** Every language's own template file, checked against {@link TEMPLATE_KEYS} at load. */
const TEMPLATES: Readonly<Record<CallLanguage, Readonly<Record<TemplateKey, string>>>> = {
  'en-US': templateFile('en-US', enUS),
  'pt-PT': templateFile('pt-PT', ptPT),
  'es-US': templateFile('es-US', esUS),
  'th-TH': templateFile('th-TH', thTH),
  'id-ID': templateFile('id-ID', idID),
};

/** Whether `key` is one of {@link TEMPLATE_KEYS}. */
function isTemplateKey(key: string): key is TemplateKey {
  return TEMPLATE_KEYS.some((known) => known === key);
}

/** Whether `name` is one of {@link TEMPLATE_VARS}. */
function isTemplateVar(name: string): name is TemplateVar {
  return TEMPLATE_VARS.some((known) => known === name);
}

/** One language file, asserted against {@link TEMPLATE_KEYS} as the module loads: a missing key would render as an empty utterance on a live call and a key no template carries would never be spoken, so both fail the process rather than the call. */
function templateFile(
  language: CallLanguage,
  file: Readonly<Record<string, string>>,
): Readonly<Record<TemplateKey, string>> {
  for (const key of TEMPLATE_KEYS) {
    const text = file[key];
    if (typeof text !== 'string' || text === '') {
      throw new Error(`voice_agent_template_missing: ${language} ${key}`);
    }
  }
  for (const key of Object.keys(file)) {
    if (!isTemplateKey(key)) {
      throw new Error(`voice_agent_template_unknown: ${language} ${key}`);
    }
  }
  return file;
}

/** The `{placeholder}` form the template files use. */
const PLACEHOLDER_RE = /\{([A-Za-z]+)\}/g;

/** One template as text, with its placeholders substituted — the only way an utterance is composed. A placeholder left without a value throws rather than speaking `{dish}` to a callee. */
export function renderTemplate(
  language: CallLanguage,
  key: TemplateKey,
  vars?: TemplateVars,
): string {
  const template = TEMPLATES[language][key];
  return template.replace(PLACEHOLDER_RE, (_match: string, name: string) => {
    const value = isTemplateVar(name) ? vars?.[name] : undefined;
    if (value === undefined) {
      throw new Error(`voice_agent_template_var_missing: ${language} ${key} ${name}`);
    }
    return value;
  });
}

/** The disclosure sentence a call opens with, in the city's own language, spoken before anything is asked (AAP 0.5.6). */
export function disclosureFor(kind: CallTaskKind, language: CallLanguage): string {
  return renderTemplate(language, GREETING_KEYS[kind]);
}

/** What a call is about (AAP 0.5.6): the place a price call asks, or the lodging a stay call asks. */
export interface CallTarget {
  readonly type: 'place' | 'lodging';
  readonly id: string;
  readonly cityId: string;
}

export interface CallCity {
  readonly id: string;
  readonly callLanguage: CallLanguage;
  readonly currency: string;
  readonly timezone: string;
}

/** Everything one call is: the attempt, the task that asked for it, what it is calling and where that is. Read once per socket by {@link loadCallContext}, so a webhook, a TwiML fetch and the relay all work from the same row. */
export interface CallContext {
  readonly attempt: CallAttempt;
  readonly task: CallTask;
  readonly target: CallTarget;
  readonly city: CallCity;
  /** The claim a stay verification belongs to; `null` for a menu call. Never decrypted here: the lodging script does that, only while the claim is open (AAP 0.5.2). */
  readonly claim: LodgingClaim | null;
}

/**
 * What the engine needs from the app's services: a structural subset of what `buildApp` builds, so a unit test
 * can stand fakes in.
 */
export interface DialogueServices {
  readonly db: DbClient;
  /** The injected clock: no `Date` is read anywhere in this file (AAP 0.11.1). */
  readonly clock: Clock;
  readonly logger: Logger;
  readonly outbox: TransactServices['outbox'];
  /** The spend meter the dialogue budget is released through (AAP 0.5.6). */
  readonly spend: LlmSpend;
  /** The configured provider, the classifier's only caller. */
  readonly llm: LlmAdapter;
  readonly env: { readonly LLM_MAX_TURNS_PER_CALL: number };
  readonly timezoneFor: (cityId: string) => string;
}

/** The relay socket the session speaks through, injected so a unit test runs without one: every frame comes from a template, and the socket is closed once the closing line has played out. */
export interface RelayIo {
  /** Send one ConversationRelay frame. A socket that has already gone may throw; the engine logs it. */
  send(frame: RelayOutboundFrame): void;
  close(): void;
  /** Wait `ms` for buffered speech to play, defaulting to `setTimeout`; a test passes an immediate stub. */
  wait?(ms: number): Promise<void>;
}

/** One priced item a `menu_prices` call collected: `slot` decides the stored item's category and alcohol flag, and `priceText` is the price as the callee said it, never converted. */
export type MenuPriceItem = {
  readonly slot: 'cheapest_main' | 'priciest_main' | 'coffee' | 'beer';
  readonly dish: string;
  /** The price exactly as it was heard, never converted. */
  readonly priceText: string;
  /** The price in minor units of {@link currency}. */
  readonly amountMinor: number;
  readonly currency: string;
  /** Whether the callee confirmed the read-back; an unconfirmed item waits for an operator. */
  readonly confirmed: boolean;
};

/**
 * `CallAttempt.extractedFields`, the cross-app contract with `apps/workers`' `call-results`: an item with
 * `confirmed: false` is stored as `reviewStatus = needs_review`, and the lodging form applies to the claim — `yes`
 * verifies it, `no` rejects it.
 */
export type ExtractedFields =
  | { readonly kind: 'menu_prices'; readonly items: readonly MenuPriceItem[] }
  | {
      readonly kind: 'lodging_stay_verification';
      readonly answer: 'yes' | 'no' | null;
      readonly confirmed: boolean;
    };

/** What one call attempt produced: the outcome that drives the task's lifecycle, the confidence that decides whether an operator reviews it, the extracted values, the summary, and the transcript a menu call keeps for thirty days and a lodging call never keeps. */
export interface AttemptResult {
  readonly outcome: CallAttemptOutcome;
  readonly confidence: Confidence | null;
  readonly extractedFields: ExtractedFields | null;
  /** The operator's summary; never a phone number, and for a stay call never a booking field. */
  readonly summary: string | null;
  /** The call's text; only a menu call's is stored, and never for a lodging call (AAP 0.5.2). */
  readonly transcript: string | null;
}

/** What a script reports once the call ends (AAP 0.5.6): {@link AttemptResult} without the transcript, which the engine owns because it holds the dialogue. */
export type ScriptResult = Pick<
  AttemptResult,
  'outcome' | 'confidence' | 'extractedFields' | 'summary'
>;

/** What one script needs from the engine while a call runs: the values its templates render, and every string that must never reach the language model. */
export interface ScriptContext {
  readonly vars: (language: CallLanguage) => TemplateVars;
  /** Strings the engine replaces in the classification window (AAP 0.5.2): a stay call's booking name and its parts, empty for a menu call. */
  readonly redactions: readonly string[];
  readonly currency: string;
}

/** One template and the values it renders with, as a step's read-back returns it (AAP 0.5.6). */
export interface StepReadback {
  readonly key: TemplateKey;
  readonly vars: TemplateVars;
}

/** One question of a script: what it asks, what an answer has to carry, and how the answer is read back. The engine owns the turn loop, the retries, the control labels and every closing line. */
export interface ScriptStep<TValue> {
  readonly slot: string;
  readonly ask: TemplateKey;
  /** What the classifier should hear, which is what makes a bare number a price. */
  readonly expected: ExpectedAnswer;
  /**
   * `'same_answer'` when the read-back restates the question, so the same answer a second time is the confirmation;
   * omitted when the engine follows a read-back with `confirm.prompt` and reads the next `yes`. A refused read-back
   * re-asks the step once either way.
   */
  readonly confirmation?: 'same_answer';
  /** The value `c` carries, or `null` when the answer named no item and no usable price — which is what sends the engine back with `retry.unclear` rather than storing a guess. */
  accept(c: Classification, ctx: ScriptContext): TValue | null;
  readback(value: TValue, ctx: ScriptContext, language: CallLanguage): StepReadback;
}

/** One whole call script (AAP 0.5.6), implemented by `./scripts/*.ts` and held by the engine with its value erased. */
export interface ScriptDefinition<TValue> {
  readonly kind: CallTaskKind;
  /**
   * Everything the call needs before it speaks: the claim decrypted and its redactions listed, or `null` when the call
   * must not proceed at all — a claim that is gone, terminal or already erased, which the engine answers by recording
   * `no_answer` without asking anything.
   */
  prepare(services: DialogueServices, ctx: CallContext): Promise<ScriptContext | null>;
  readonly steps: readonly ScriptStep<TValue>[];
  /** What the call produced once the engine stopped, with every value it collected and whether the dialogue reached its last step; it is what decides `completed` against `needs_review`. */
  result(
    collected: ReadonlyMap<string, { value: TValue; confirmed: boolean }>,
    finished: boolean,
  ): ScriptResult;
}

/** One collected value with the confirmation it earned (AAP 0.5.6). */
interface CollectedValue {
  readonly value: unknown;
  readonly confirmed: boolean;
}

/**
 * The attempt row, locked for the rest of the transaction: every writer of an attempt — a relay finalize, the status
 * webhook, a TwiML fetch — takes this first, so two of them are serialized and the second sees the first one's
 * outcome.
 */
export async function lockAttempt(tx: DbTx, attemptId: string): Promise<CallAttempt | null> {
  const rows = await tx.$queryRaw<CallAttempt[]>(Prisma.sql`
    SELECT "id",
           "call_task_id" AS "callTaskId",
           "twilio_call_sid" AS "twilioCallSid",
           "state",
           "superseded",
           "twilio_final_status" AS "twilioFinalStatus",
           "outcome",
           "extracted_fields" AS "extractedFields",
           "summary",
           "confidence",
           "transcript",
           "transcript_delete_at" AS "transcriptDeleteAt",
           "duration_sec" AS "durationSec",
           "started_at" AS "startedAt",
           "ended_at" AS "endedAt",
           "llm_reserved_micros" AS "llmReservedMicros"
      FROM "call_attempt"
     WHERE "id" = ${attemptId}::uuid
       FOR UPDATE`);
  return rows[0] ?? null;
}

/**
 * Whether an attempt has had its call content stripped: a failed dispatch never had a call, and a stripped lodging
 * attempt — one whose claim has resolved — has no `CallSid` left. A caller treats a stripped attempt, and a missing
 * one, the same way: the record exists, the call it describes does not, and a late callback is acknowledged without
 * effect.
 */
export function isStripped(attempt: Pick<CallAttempt, 'state' | 'twilioCallSid'>): boolean {
  if (attempt.state === 'dispatch_failed') {
    return true;
  }
  return attempt.state === 'ended' && attempt.twilioCallSid === null;
}

/**
 * Everything one call is, read from its attempt in a single query and outside any transaction. The claim arrives with
 * its ciphertexts and is never decrypted here — the lodging script decrypts it only while the claim is open.
 *
 * A call whose task, target or city cannot be resolved, or whose city's language is not one of the five speech
 * pairings, returns `null`, which its caller answers by closing politely.
 */
export async function loadCallContext(
  db: DbClient,
  attemptId: string,
): Promise<CallContext | null> {
  const row = await db.callAttempt.findUnique({
    where: { id: attemptId },
    include: {
      callTask: {
        include: {
          place: { include: { city: true } },
          lodging: { include: { city: true } },
          lodgingClaim: true,
        },
      },
    },
  });
  if (row === null) {
    return null;
  }
  // `attempt` is the row without its included task, so nothing here carries a relation the model does not declare.
  const { callTask: task, ...attempt } = row;
  const place = task.place;
  const lodging = task.lodging;
  const source = place ?? lodging;
  if (source === null) {
    return null;
  }
  const language = CallLanguage.safeParse(source.city.callLanguage);
  if (!language.success) {
    return null;
  }
  return {
    attempt,
    task,
    target: {
      type: place === null ? 'lodging' : 'place',
      id: source.id,
      cityId: source.cityId,
    },
    city: {
      id: source.city.id,
      callLanguage: language.data,
      currency: source.city.currency,
      timezone: source.city.timezone,
    },
    claim: task.kind === 'lodging_stay_verification' ? task.lodgingClaim : null,
  };
}

/**
 * The dialogue budget a call holds, rebuilt from its attempt: the reservation was made on the dispatch-time local day
 * of the city, so the same city and day are what its unused part is released against. A value that is not a positive
 * safe integer reads as no budget at all, which ends the call politely rather than spending past a reservation
 * nobody can vouch for.
 */
export function reservationFor(
  services: Pick<DialogueServices, 'timezoneFor'>,
  ctx: CallContext,
): LlmReservation {
  const micros = Number(ctx.attempt.llmReservedMicros);
  return {
    cityId: ctx.city.id,
    localDate: localDateKey(services.timezoneFor(ctx.city.id), ctx.attempt.startedAt),
    micros: Number.isSafeInteger(micros) && micros > 0 ? micros : 0,
  };
}

/** How long a menu call's transcript is kept before `data-expiry` deletes it (AAP 0.5.2). */
const TRANSCRIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

/** What {@link recordAttemptOutcome} may do besides storing the result (AAP 0.5.2, 0.5.6). */
export interface AttemptOutcomeOptions {
  /** The dialogue budget the attempt held. The release is booked against its city and local day, which only the enclosing call knows, so it travels with the outcome rather than being re-derived. */
  readonly reservation: LlmReservation;
  readonly unusedMicros: number;
  /** Whether this ending also moves the attempt to `ended` with its `endedAt`, which is set once. */
  readonly endCall?: boolean;
}

/**
 * Record what one call attempt produced, and ask `apps/workers` to apply it — the single writer, and the one place a
 * call's result becomes durable.
 *
 * Call it with the attempt already locked by {@link lockAttempt}, inside the transaction that locks it. The first
 * recorder wins: an attempt that already carries an outcome, or one whose call content was stripped, returns `false`
 * and writes nothing, which is what makes a racing status callback and a relay finalize produce exactly one
 * `apply_call_result` row.
 *
 * The transcript follows the attempt's own extracted fields rather than its caller's word: a menu call's transcript
 * is stored with its thirty-day deletion date, and a lodging call's — and a call that extracted nothing — stores
 * none. The outbox row is written in the same transaction as the outcome; the unused dialogue budget is released
 * after the commit, through `after`, because it is a statement on another connection.
 */
export async function recordAttemptOutcome(
  tx: DbTx,
  services: DialogueServices,
  after: AfterCommit,
  attempt: CallAttempt,
  result: AttemptResult,
  opts: AttemptOutcomeOptions,
): Promise<boolean> {
  if (attempt.outcome !== null || isStripped(attempt)) {
    return false;
  }
  const now = services.clock.now();
  const transcript = result.extractedFields?.kind === 'menu_prices' ? result.transcript : null;
  const data: Prisma.CallAttemptUpdateInput = {
    outcome: result.outcome,
    confidence: result.confidence,
    summary: result.summary,
    extractedFields: result.extractedFields === null ? Prisma.DbNull : result.extractedFields,
    transcript,
    transcriptDeleteAt:
      transcript === null ? null : new Date(now.getTime() + TRANSCRIPT_RETENTION_MS),
    llmReservedMicros: 0n,
  };
  if (opts.endCall === true) {
    data.state = 'ended';
    data.endedAt = attempt.endedAt ?? now;
  }
  await tx.callAttempt.update({ where: { id: attempt.id }, data });
  await writeOutbox(tx, 'apply_call_result', { callAttemptId: attempt.id });
  if (opts.unusedMicros > 0) {
    const reservation = opts.reservation;
    const unusedMicros = opts.unusedMicros;
    after(() => services.spend.releaseLlm(reservation, unusedMicros));
  }
  services.logger.info(
    { event: 'voice_call_outcome', attemptId: attempt.id, outcome: result.outcome },
    'voice_call_outcome',
  );
  return true;
}

/** The scripts the engine resolves a call by, keyed by the task's kind (AAP 0.5.6, 0.8.1). */
const SCRIPTS: Readonly<Record<CallTaskKind, ScriptDefinition<unknown>>> = {
  menu_prices: menuPricesScript,
  lodging_stay_verification: lodgingStayVerificationScript,
};

/** The script a task's kind selects; a kind with no script is unreachable at compile time and throws here (AAP 0.5.6). */
export function scriptFor(kind: CallTaskKind): ScriptDefinition<unknown> {
  const script = SCRIPTS[kind];
  if (script === undefined) {
    throw new Error(`voice_agent_script_missing: ${kind}`);
  }
  return script;
}

/** What a redacted booking name is replaced by, in the window and at the provider (AAP 0.5.2). */
const GUEST_PLACEHOLDER = '<guest>';

/** How many tries a step gets before the dialogue keeps what it has and moves on (AAP 0.5.6). */
const STEP_TRY_LIMIT = 2;

/** The pace of one spoken utterance: about seventy milliseconds per character (AAP 0.5.6). */
const SPEECH_MS_PER_CHAR = 70;

/** The floor of a closing line's playback time, so a short word still finishes. */
const SPEECH_MIN_MS = 1_500;

/** The ceiling of it, so a long closing line never holds the socket open longer than this. */
const SPEECH_MAX_MS = 8_000;

/** The task statuses a do-not-call request cancels, every one that is not already final (AAP 0.5.3). */
const CANCELLABLE_TASK_STATUSES: CallTaskStatus[] = [
  'queued',
  'in_progress',
  'needs_review',
  'unreachable',
];

/** The attempt states that may have a live call behind them, which a do-not-call supersedes. */
const LIVE_ATTEMPT_STATES: CallAttemptState[] = [
  'dispatching',
  'dispatch_unknown',
  'dialing',
  'in_progress',
];

/** The control labels, and what the engine does about each before a step sees the answer. */
const CONTROL_ACTIONS: Readonly<Partial<Record<UtteranceLabel, ControlAction>>> = {
  prefers_english: 'switch_english',
  wants_human: 'end_refused',
  stop: 'end_refused',
  do_not_call: 'end_do_not_call',
};

type ControlAction = 'switch_english' | 'end_refused' | 'end_do_not_call';

/** An ending the engine decides itself, overriding what the script would have reported: a refusal, a do-not-call request and a refusal to spend more dialogue budget. */
interface EndingOverride {
  readonly outcome: CallAttemptOutcome;
  readonly confidence: Confidence | null;
}

const REFUSED_ENDING: EndingOverride = { outcome: 'refused', confidence: null };

const DO_NOT_CALL_ENDING: EndingOverride = { outcome: 'do_not_call', confidence: null };

/** The dialogue budget is gone: the call has no more budget, so the task is queued for an operator rather than redialled (AAP 0.5.6). */
const BUDGET_ENDING: EndingOverride = { outcome: 'needs_review', confidence: 'low' };

/** Where a step stands between its question and its collected value (AAP 0.5.6). */
type StepState =
  | { readonly kind: 'asking' }
  | {
      readonly kind: 'confirming';
      readonly style: 'prompt' | 'same_answer';
      readonly value: unknown;
      readonly label: UtteranceLabel;
    };

/** The one `asking` state, shared because it carries nothing. */
const ASKING: StepState = { kind: 'asking' };

/** A value waiting for confirmation, with the label that produced it (AAP 0.5.6). */
interface PendingAnswer {
  readonly value: unknown;
  readonly label: UtteranceLabel;
}

/**
 * How a call ended: `completed` when the dialogue reached its own end, `app_closing` when the app ended it (nothing
 * to ask, a model failure, no budget left), and the two the socket and the task decide for themselves.
 */
export type FinalizeReason = 'completed' | 'socket_closed' | 'superseded' | 'app_closing';

/**
 * One automated call: the turn loop that turns a callee's speech into a recorded outcome. The session is driven from
 * outside — {@link start} once, then {@link onPrompt} per transcribed utterance — and speaks only through its
 * injected socket. Four invariants hold it:
 *
 * - **One turn at a time.** Turns are chained, so a classification is never in flight while another begins, and the
 *   script's preparation runs on that same chain.
 * - **The task decides.** Before every turn the task's status and the attempt's `superseded` flag are re-read, so a
 *   task cancelled while the call runs ends the dialogue politely.
 * - **The budget bounds it.** No more than `LLM_MAX_TURNS_PER_CALL` turns are taken, and every classified turn is
 *   metered against the call's own reservation, so the reserved dialogue budget cannot be crossed.
 * - **The closing line plays out.** `end` cuts buffered speech, so the session waits for the closing line, sends
 *   the frame, records the outcome and only then closes the socket.
 */
export class DialogueSession {
  private readonly services: DialogueServices;
  private readonly ctx: CallContext;
  private readonly script: ScriptDefinition<unknown>;
  private readonly io: RelayIo;
  private readonly kind: CallTaskKind;
  private readonly keepsTranscript: boolean;
  private readonly maxTurns: number;
  private readonly reservation: LlmReservation;
  private readonly reservedMicros: number;
  private readonly collected = new Map<string, CollectedValue>();
  private readonly window: string[] = [];
  private readonly transcript: string[] = [];
  private language: CallLanguage;
  private scriptContext: ScriptContext | null = null;
  private remainingMicros: number;
  private chargedMicros = 0;
  private classifications = 0;
  private stepIndex = 0;
  private failedTries = 0;
  private stepState: StepState = ASKING;
  private finished = false;
  private closed = false;
  private ending: EndingOverride | null = null;
  private finalizeReason: FinalizeReason | null = null;
  private chain: Promise<void> = Promise.resolve();

  /** Build the session for one attempt (AAP 0.5.6). */
  constructor(
    services: DialogueServices,
    ctx: CallContext,
    script: ScriptDefinition<unknown> | undefined,
    io: RelayIo,
  ) {
    this.services = services;
    this.ctx = ctx;
    this.script = script ?? scriptFor(ctx.task.kind);
    this.io = io;
    this.kind = this.script.kind;
    this.keepsTranscript = this.kind === 'menu_prices';
    this.maxTurns = services.env.LLM_MAX_TURNS_PER_CALL;
    this.reservation = reservationFor(services, ctx);
    this.reservedMicros = this.reservation.micros;
    this.remainingMicros = this.reservation.micros;
    this.language = ctx.city.callLanguage;
  }

  /** How the call ended, once {@link finalize} has run, or `null` while it is still running. */
  get finalizedBy(): FinalizeReason | null {
    return this.finalizeReason;
  }

  /**
   * The call's opening as text: the disclosure, first, then the first question. The question joins it once it can be
   * rendered: a menu question has no placeholder, while a stay question names the guest and the dates, known only
   * after the script has decrypted the claim.
   *
   * Nothing in production reads it: the opening reaches the callee in two halves on two surfaces — `twiml.ts` speaks
   * {@link disclosureFor} as the `welcomeGreeting` and {@link start} speaks the first question alone — so this member
   * is the one place the pair exists in process, and it is what the unit suite asserts the disclosure-first rule
   * through.
   */
  openingLines(): readonly string[] {
    const disclosure = disclosureFor(this.kind, this.language);
    const step = this.step();
    if (step === undefined) {
      return [disclosure];
    }
    const context = this.scriptContext;
    if (context !== null) {
      return [disclosure, this.askText(step, context)];
    }
    // A menu question names nothing but the question itself, so it renders before `start` has run;
    // a stay question does, and joins the disclosure once the claim's values are known.
    return this.kind === 'menu_prices'
      ? [disclosure, renderTemplate(this.language, step.ask)]
      : [disclosure];
  }

  /**
   * Prepare the script and ask its first question. The disclosure has already been spoken as the `welcomeGreeting`, so
   * this speaks the first question and nothing before it, on {@link onPrompt}'s own chain: a prompt that arrives while
   * `prepare` is still in flight waits for the first question rather than meeting a call that has asked nothing. A
   * script that refuses the call closes politely with `no_answer`, which leaves the task to retry where it can.
   */
  start(): Promise<void> {
    // Enqueued on the turn chain, so no prompt is handled between this call and the first question.
    const starting = this.chain.then(() => this.begin());
    this.chain = starting.catch(() => undefined);
    return starting;
  }

  /** The preparation {@link start} enqueues, chained like a turn (AAP 0.5.6). */
  private async begin(): Promise<void> {
    let prepared: ScriptContext | null = null;
    try {
      prepared = await this.script.prepare(this.services, this.ctx);
    } catch {
      // A preparation that threw is a refusal like any other: the callee hears the closing line and
      // the attempt is recorded without data.
      this.services.logger.warn(
        { event: 'voice_prepare_failed', attemptId: this.ctx.attempt.id },
        'voice_prepare_failed',
      );
    }
    this.scriptContext = prepared;
    const step = this.step();
    if (prepared === null || step === undefined) {
      await this.close('closing.thanks', null, 'app_closing');
      return;
    }
    this.speak(this.askText(step, prepared));
  }

  /**
   * Handle one transcribed utterance.
   *
   * @param options - `overlong: true` for an utterance the relay itself cut at the classification window's byte bound,
   *   which the dialogue answers as an unusable utterance rather than classifying.
   */
  onPrompt(text: string, options: { readonly overlong?: boolean } = {}): Promise<void> {
    this.chain = this.chain.then(async () => {
      try {
        await this.handlePrompt(text, options.overlong === true);
      } catch {
        // The turn loop never throws to the socket: the failure is recorded as a code and the call is
        // closed politely, so a socket that is still open hears an ending rather than silence.
        this.services.logger.warn(
          { event: 'voice_turn_failed', attemptId: this.ctx.attempt.id },
          'voice_turn_failed',
        );
        await this.close('closing.thanks', null, 'app_closing');
      }
    });
    return this.chain;
  }

  /** Note that the callee started speaking over the agent: nothing is replayed and no log line is written, because the turn was cut short. */
  onInterrupt(): void {
    if (this.keepsTranscript) {
      this.transcript.push('interrupt');
    }
  }

  /**
   * Resolves once every turn {@link onPrompt} has received has finished.
   *
   * A socket that goes mid-turn leaves a turn already queued on {@link onPrompt}'s chain: the value the callee had
   * confirmed by then is still on its way into `collected`, and {@link finalize} reads what the call collected
   * synchronously. Without this wait that value never reaches the recorded result, and a call dropped mid-script is
   * recorded as one that collected nothing rather than as the partial data the operator queue needs. Only a caller
   * that observes the call's end from outside the dialogue awaits it — the relay's socket teardown and the app's
   * shutdown hook; the engine's own closing path runs inside this chain and must not wait on itself.
   */
  async awaitTurns(): Promise<void> {
    await this.chain.catch(() => undefined);
  }

  /**
   * Record what the call produced and end it. Idempotent: the first call wins, and a second one — a socket that closes
   * while the closing line plays out, a task cancelled mid-call — changes nothing. It never throws: a failure is
   * logged as `voice_finalize_failed` and left to `apps/workers`' reconcile, which moves an attempt left `ended` with
   * no outcome to `needs_review`.
   */
  async finalize(reason: FinalizeReason): Promise<void> {
    if (this.finalizeReason !== null) {
      return;
    }
    this.finalizeReason = reason;
    try {
      const scripted = this.script.result(this.collected, this.finished);
      const ending = this.ending;
      const result: AttemptResult = {
        outcome: ending === null ? scripted.outcome : ending.outcome,
        confidence: ending === null ? scripted.confidence : ending.confidence,
        extractedFields: scripted.extractedFields,
        summary: scripted.summary,
        transcript: this.transcriptText(),
      };
      const unusedMicros = Math.max(0, this.reservedMicros - this.chargedMicros);
      let recorded = false;
      await transact(this.services, async (tx, after) => {
        const attempt = await lockAttempt(tx, this.ctx.attempt.id);
        if (attempt === null) {
          return;
        }
        recorded = await recordAttemptOutcome(tx, this.services, after, attempt, result, {
          reservation: this.reservation,
          unusedMicros,
          endCall: true,
        });
      });
      // A call that ran and ended with nothing to apply. `no_answer` is the outcome the AAP fixes for a
      // call that produced no data, so the reason is recorded here: the callee answered and every turn
      // of this call classified `unclear`, which is what lets an operator tell a call the dialogue never
      // understood from one nobody answered (AAP 0.11.1).
      if (recorded && result.outcome === 'no_answer' && this.classifications > 0) {
        this.services.logger.info(
          {
            event: 'voice_call_no_data',
            attemptId: this.ctx.attempt.id,
            outcome: result.outcome,
            turns: this.classifications,
          },
          'voice_call_no_data',
        );
      }
    } catch {
      this.services.logger.warn(
        { event: 'voice_finalize_failed', attemptId: this.ctx.attempt.id },
        'voice_finalize_failed',
      );
    }
  }

  /** The turn loop of one utterance (AAP 0.5.6). */
  private async handlePrompt(text: string, overlong: boolean): Promise<void> {
    if (this.closed) {
      return;
    }
    // The task decides: a task that stopped being `in_progress`, or an attempt superseded mid-call,
    // ends the dialogue here. `apps/workers` records a superseded attempt's result on the attempt and
    // never applies it to the task (AAP 0.5.3).
    const live = await this.liveState();
    if (live === null || live.superseded || live.status !== 'in_progress') {
      await this.close('closing.thanks', null, 'superseded');
      return;
    }
    // The check order matters here. A refusal of the call belongs to `start`, which takes the
    // preparation onto this same chain: by the time a turn runs, a refusal has already closed the
    // session, and the `closed` check above returns on it. A null context therefore means the script is
    // not ready, and a turn must not end a call the script has not spoken into yet.
    const context = this.scriptContext;
    if (context === null) {
      return;
    }
    const step = this.step();
    if (step === undefined) {
      // A script with no steps has nothing to ask, so the call is closed as kindly as it began.
      await this.close('closing.thanks', null, 'app_closing');
      return;
    }
    if (this.classifications >= this.maxTurns) {
      await this.close('closing.budget', BUDGET_ENDING, 'app_closing');
      return;
    }
    // An overlong utterance is nothing the callee said: it is this socket's own bound having been
    // reached, so none of it is appended — it would otherwise enter the classification window and a
    // menu call's transcript as speech nobody spoke (AAP 0.5.6).
    if (!overlong) {
      this.appendCallee(text);
    }
    this.classifications += 1;
    let classification: Classification;
    if (overlong) {
      // Unusable rather than classified: no request is counted, sent or charged against the dialogue
      // budget, and the turn takes exactly the path an `unclear` classification takes below — the
      // step's `accept` is handed no usable answer, so the callee hears the retry line, or the script
      // advances once the step's tries are spent (AAP 0.5.6).
      classification = UNCLEAR_CLASSIFICATION;
    } else {
      try {
        const turn = await classifyUtterance(
          this.services,
          this.classificationContext(context),
          text,
          this.expectedFor(step),
        );
        this.charge(turn.chargedMicros);
        classification = turn.classification;
      } catch (error) {
        const failure = describeClassificationFailure(error, this.remainingMicros);
        this.charge(failure.chargedMicros);
        // A turn that did not fit the reservation never reached the provider; one that failed on the
        // provider's side may have been billed. Both end the call politely, the task keeps whatever it
        // has, and no other route is affected (AAP 0.5.6).
        await this.close(
          failure.kind === 'budget' ? 'closing.budget' : 'closing.thanks',
          failure.kind === 'budget' ? BUDGET_ENDING : null,
          'app_closing',
        );
        return;
      }
    }
    // The turn's own label, written before the control check so a refusal and a do-not-call are
    // recorded like any other turn, and so an attempt whose every turn classified `unclear` does not
    // read as a line nobody answered (AAP 0.11.1).
    this.services.logger.debug(
      {
        event: 'voice_turn',
        attemptId: this.ctx.attempt.id,
        turn: this.classifications,
        step: step.slot,
        classification: classification.label,
      },
      'voice_turn',
    );
    const control = CONTROL_ACTIONS[classification.label];
    if (control !== undefined) {
      await this.handleControl(control, step, context);
      return;
    }
    await this.applyAnswer(classification, step, context);
  }

  /** The task status and attempt flag one turn is gated on (AAP 0.5.3). */
  private async liveState(): Promise<{ superseded: boolean; status: CallTaskStatus } | null> {
    const row = await this.services.db.callAttempt.findUnique({
      where: { id: this.ctx.attempt.id },
      select: { superseded: true, callTask: { select: { status: true } } },
    });
    return row === null ? null : { superseded: row.superseded, status: row.callTask.status };
  }

  /** What the classifier should hear, which the read-back changes (AAP 0.5.6). */
  private expectedFor(step: ScriptStep<unknown>): ExpectedAnswer {
    const state = this.stepState;
    if (state.kind !== 'confirming' || state.style === 'same_answer') {
      return step.expected;
    }
    return 'confirmation';
  }

  /** The one turn's classification context, rebuilt from what the call holds (AAP 0.5.6). */
  private classificationContext(context: ScriptContext): ClassificationContext {
    return {
      reservation: this.reservation,
      remainingMicros: this.remainingMicros,
      window: this.window,
      redactions: context.redactions,
    };
  }

  /** A control label, handled before the step's own `accept` ever sees the answer (AAP 0.5.6). */
  private async handleControl(
    action: ControlAction,
    step: ScriptStep<unknown>,
    context: ScriptContext,
  ): Promise<void> {
    if (action === 'switch_english') {
      if (this.language !== 'en-US') {
        this.language = 'en-US';
        // Recognition and speech move together, so the callee is not left being listened to in one
        // language and answered in another (AAP 0.5.6).
        this.sendFrame({ type: 'language', ttsLanguage: 'en-US', transcriptionLanguage: 'en-US' });
        this.speak(renderTemplate(this.language, 'switch.english'));
      }
      this.speak(this.questionText(step, context));
      return;
    }
    if (action === 'end_refused') {
      await this.close('closing.refused', REFUSED_ENDING, 'completed');
      return;
    }
    // The do-not-call effects are committed before the closing line, so a socket that dies during it
    // cannot lose the request (AAP 0.5.6).
    await this.markTargetDoNotCall();
    await this.close('closing.do_not_call', DO_NOT_CALL_ENDING, 'completed');
  }

  /** One answer: a confirmation, a fresh value, a refused read-back or an answer that fits nothing. */
  private async applyAnswer(
    c: Classification,
    step: ScriptStep<unknown>,
    context: ScriptContext,
  ): Promise<void> {
    const state = this.stepState;
    if (state.kind === 'confirming') {
      // The same answer a second time confirms a read-back that restates the question; `yes` answers
      // `confirm.prompt` for the others.
      const confirmed = state.style === 'same_answer' ? c.label === state.label : c.label === 'yes';
      if (confirmed) {
        await this.commit(step, state.value, context);
        return;
      }
      if (state.style === 'prompt' && c.label === 'no') {
        // A refused read-back re-asks the step once (AAP 0.5.6). A read-back that restates the
        // question has no refusal to distinguish: a different answer is simply a new answer.
        await this.failStep(step, context, { value: state.value, label: state.label });
        return;
      }
    }
    const value = step.accept(c, context);
    if (value === null) {
      if (state.kind === 'confirming') {
        // The callee did not confirm and said nothing the step could use: the value is kept
        // unconfirmed and the dialogue moves on, so an unclear answer costs one question and the
        // script's turns stay aligned with its questions.
        this.collected.set(step.slot, { value: state.value, confirmed: false });
        await this.advance(context);
        return;
      }
      await this.failStep(step, context, null);
      return;
    }
    this.readBack(step, value, c.label, context);
  }

  /** Speak a value back and ask for it to be confirmed (AAP 0.5.6). */
  private readBack(
    step: ScriptStep<unknown>,
    value: unknown,
    label: UtteranceLabel,
    context: ScriptContext,
  ): void {
    const readback = step.readback(value, context, this.language);
    this.speak(renderTemplate(this.language, readback.key, readback.vars));
    const style = step.confirmation === 'same_answer' ? 'same_answer' : 'prompt';
    if (style === 'prompt') {
      this.speak(renderTemplate(this.language, 'confirm.prompt'));
    }
    this.stepState = { kind: 'confirming', style, value, label };
  }

  /** Store a confirmed value and move to the next question (AAP 0.5.6). */
  private async commit(
    step: ScriptStep<unknown>,
    value: unknown,
    context: ScriptContext,
  ): Promise<void> {
    this.collected.set(step.slot, { value, confirmed: true });
    await this.advance(context);
  }

  /** Count a try that produced no confirmation: the step is retried once, and what the call has by then — a value the callee never confirmed, or nothing at all — is what it keeps. */
  private async failStep(
    step: ScriptStep<unknown>,
    context: ScriptContext,
    pending: PendingAnswer | null,
  ): Promise<void> {
    this.failedTries += 1;
    if (this.failedTries >= STEP_TRY_LIMIT) {
      if (pending !== null) {
        this.collected.set(step.slot, { value: pending.value, confirmed: false });
      }
      await this.advance(context);
      return;
    }
    this.stepState = ASKING;
    // A refused read-back is answered by asking the question again; an answer that fitted nothing is
    // answered by asking the callee to repeat it.
    this.speak(
      pending === null
        ? renderTemplate(this.language, 'retry.unclear')
        : this.askText(step, context),
    );
  }

  /** Move to the next step, or close the call once the last one is done (AAP 0.5.6). */
  private async advance(context: ScriptContext): Promise<void> {
    this.stepState = ASKING;
    this.failedTries = 0;
    this.stepIndex += 1;
    const next = this.step();
    if (next === undefined) {
      this.finished = true;
      await this.close('closing.thanks', null, 'completed');
      return;
    }
    this.speak(this.askText(next, context));
  }

  /** The step the call is on, or `undefined` once they are exhausted. */
  private step(): ScriptStep<unknown> | undefined {
    return this.script.steps[this.stepIndex];
  }

  /** One step's question, in the language the call is in now. */
  private askText(step: ScriptStep<unknown>, context: ScriptContext): string {
    return renderTemplate(this.language, step.ask, context.vars(this.language));
  }

  /** The question the callee owes an answer to: the step's, the confirmation's or the read-back. */
  private questionText(step: ScriptStep<unknown>, context: ScriptContext): string {
    const state = this.stepState;
    if (state.kind !== 'confirming') {
      return this.askText(step, context);
    }
    if (state.style === 'prompt') {
      return renderTemplate(this.language, 'confirm.prompt');
    }
    const readback = step.readback(state.value, context, this.language);
    return renderTemplate(this.language, readback.key, readback.vars);
  }

  /**
   * Honour a request never to be called again: the target is marked, every other task of it is cancelled, and every
   * attempt that may still be on a live call is superseded. One transaction, before the closing line, so the request
   * survives the socket.
   */
  private async markTargetDoNotCall(): Promise<void> {
    const { target, task } = this.ctx;
    await transact(this.services, async (tx) => {
      const taskFilter = { id: { not: task.id }, status: { in: CANCELLABLE_TASK_STATUSES } };
      const attemptFilter = { superseded: false, state: { in: LIVE_ATTEMPT_STATES } };
      if (target.type === 'place') {
        await tx.place.update({ where: { id: target.id }, data: { doNotCall: true } });
        await tx.callTask.updateMany({
          where: { ...taskFilter, placeId: target.id },
          data: { status: 'cancelled' },
        });
        await tx.callAttempt.updateMany({
          where: { ...attemptFilter, callTask: { placeId: target.id, id: { not: task.id } } },
          data: { superseded: true },
        });
        return;
      }
      await tx.lodging.update({ where: { id: target.id }, data: { doNotCall: true } });
      await tx.callTask.updateMany({
        where: { ...taskFilter, lodgingId: target.id },
        data: { status: 'cancelled' },
      });
      await tx.callAttempt.updateMany({
        where: { ...attemptFilter, callTask: { lodgingId: target.id, id: { not: task.id } } },
        data: { superseded: true },
      });
    });
  }

  /** The dialogue budget a turn consumed, kept against the reservation it was metered on. */
  private charge(micros: number): void {
    const charged = Number.isSafeInteger(micros) && micros > 0 ? micros : 0;
    this.chargedMicros += charged;
    this.remainingMicros = Math.max(0, this.remainingMicros - charged);
  }

  /** Speak one uttered line, and record it in the window and the transcript. */
  private speak(text: string): void {
    this.sendFrame({ type: 'text', token: text, last: true, lang: this.language });
    this.window.push('agent: ' + this.redact(text));
    if (this.keepsTranscript) {
      this.transcript.push('agent: ' + text);
    }
  }

  /** Record what the callee said, redacted in the window and verbatim in a menu transcript. */
  private appendCallee(text: string): void {
    this.window.push('callee: ' + this.redact(text));
    if (this.keepsTranscript) {
      this.transcript.push('callee: ' + text);
    }
  }

  /**
   * Replace every redaction in a window line: a lodging call's booking name and its parts become `<guest>` before the
   * line can reach the provider, longest entry first so the whole name goes before its parts.
   */
  private redact(text: string): string {
    const redactions = this.scriptContext?.redactions ?? [];
    let redacted = text;
    for (const entry of [...redactions].sort((a, b) => b.length - a.length)) {
      if (entry !== '') {
        redacted = redacted.split(entry).join(GUEST_PLACEHOLDER);
      }
    }
    return redacted;
  }

  /** The call's transcript text, or `null` when this kind keeps none or nothing was said. */
  private transcriptText(): string | null {
    if (!this.keepsTranscript || this.transcript.length === 0) {
      return null;
    }
    return this.transcript.join('\n');
  }

  /** Send one relay frame, tolerating a socket that has already gone (AAP 0.5.6). */
  private sendFrame(frame: RelayOutboundFrame): void {
    try {
      this.io.send(frame);
    } catch {
      this.services.logger.warn(
        { event: 'voice_frame_failed', attemptId: this.ctx.attempt.id, frame: frame.type },
        'voice_frame_failed',
      );
    }
  }

  /** Speak a closing line, let it play out, end the relay session and record the outcome. The first close wins: a socket that closes while the line plays finds the call already ended. */
  private async close(
    closing: TemplateKey,
    ending: EndingOverride | null,
    reason: FinalizeReason,
  ): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.ending = ending;
    const line = renderTemplate(this.language, closing);
    this.speak(line);
    await this.waitOutSpeech(line);
    this.sendFrame({ type: 'end' });
    await this.finalize(reason);
    try {
      this.io.close();
    } catch {
      // The socket is already gone; the outcome is recorded either way.
    }
  }

  /** Wait for a closing line to be spoken before `end` cuts the session (AAP 0.5.6). */
  private async waitOutSpeech(line: string): Promise<void> {
    const ms = speechDurationMs(line);
    if (this.io.wait !== undefined) {
      await this.io.wait(ms);
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

/** How long one utterance needs to play out, before the `end` frame cuts it (AAP 0.5.6). */
export function speechDurationMs(text: string): number {
  const estimate = Math.round([...text].length * SPEECH_MS_PER_CHAR);
  return Math.min(SPEECH_MAX_MS, Math.max(SPEECH_MIN_MS, estimate));
}
