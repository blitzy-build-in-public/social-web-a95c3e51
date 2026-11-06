/**
 * The shared dialogue engine: the turn loop of an automated call, the fixed per-language templates it
 * speaks from, and the one exactly-once writer of a call attempt's outcome (AAP 0.5.6, 0.5.3, 0.3.2).
 *
 * It owns four things and delegates the rest:
 *
 *  - **The disclosure always comes first.** {@link disclosureFor} is what `twiml.ts` sends as the
 *    ConversationRelay `welcomeGreeting`, so the callee hears that the call is automated before
 *    anything else, in the city's own language (AAP 0.5.6).
 *  - **Every word spoken is a template.** The engine renders `./i18n/*.json` keys and nothing else;
 *    the language model never composes an utterance, it only classifies the callee's speech through
 *    `./understanding.ts` (AAP 0.5.6).
 *  - **A value counts only once it has been read back.** A step's answer is spoken back and confirmed
 *    before it is collected, which is what makes `high` confidence honest and leaves everything else
 *    `low` for an operator (AAP 0.5.6).
 *  - **One result per attempt.** {@link recordAttemptOutcome} is the single writer of an attempt's
 *    outcome, its transcript, its extracted fields and the `apply_call_result` outbox row that
 *    `apps/workers` applies to the task and, for a lodging call, to its claim (AAP 0.3.2, 0.5.3).
 *
 * Who owns an attempt's outcome, and why exactly one result is recorded:
 *
 *  - `twiml.ts` records `no_answer` whenever it answers `<Hangup/>` — a machine, a task that is not
 *    `in_progress`, or a superseded attempt.
 *  - Once ConversationRelay TwiML has been served, {@link DialogueSession.finalize} owns the outcome.
 *  - `status-webhook.ts` records outcomes only for the final statuses `busy`, `no-answer`, `canceled`
 *    and `failed`, and never for `completed`: only an answered call fetches TwiML, so every
 *    `completed` call belongs to the TwiML or relay path.
 *  - The remaining gap belongs to `apps/workers`' `calls/reconcile.ts`: a relay process that dies
 *    mid-call, or a TwiML fetch that fails, can leave an attempt `ended` with a null outcome, which
 *    the worker moves to `needs_review` fifteen minutes after `endedAt`.
 *
 * Every writer takes {@link lockAttempt} first, and {@link recordAttemptOutcome} refuses to write
 * once an outcome is set, so a racing status callback and a relay finalize produce one result.
 *
 * Nothing here logs, returns or throws the callee's words: a log line carries an event name, the
 * attempt id and an outcome, and a booking name is redacted out of the classification window rather
 * than left to the provider's discretion (AAP 0.5.2, AAP 0.11.1, AAP 0.12.2).
 *
 * @see AAP 0.5.6 for the templates, the read-back rule, the caps and the outcomes, 0.5.3 for the
 *   call-task lifecycle the outcomes drive, 0.5.2 for what a call may keep, 0.3.2 for the single
 *   transaction that records a result and the outbox row it writes, and 0.8.1 for this file.
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

// ---------------------------------------------------------------------------------------------
// Templates (AAP 0.5.6)
// ---------------------------------------------------------------------------------------------

/**
 * Every key the five `./i18n/*.json` files carry: the two greetings, the four questions, the two
 * read-backs, the confirmation and retry prompts, the mid-call English switch and the four closing
 * lines. A language missing one, or carrying one the others do not, fails at module load rather than
 * going silent mid-call.
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

/** Every placeholder name the templates use. */
export const TEMPLATE_VARS = ['dish', 'price', 'bookingName', 'stayFrom', 'stayTo'] as const;

/** One placeholder name: what {@link renderTemplate} substitutes into `{name}`. */
export type TemplateVar = (typeof TEMPLATE_VARS)[number];

/** The values a template can be rendered with; a template's own placeholders are its keys. */
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

/**
 * One language file, asserted against {@link TEMPLATE_KEYS} as the module loads (AAP 0.5.6).
 *
 * A missing key would otherwise render as an empty utterance on a live call and a key no template
 * carries would never be spoken at all, so both are startup errors: a translation that is incomplete
 * fails the process rather than the call.
 *
 * @param language - The pairing the file belongs to, named in the failure.
 * @param file - The parsed JSON file.
 * @returns The same strings, typed by the key set. The assertion holds because the two loops above
 *   have already established it.
 * @throws Error when a key is missing, blank or unknown.
 */
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

/**
 * One template as text, with its placeholders substituted (AAP 0.5.6).
 *
 * The only way an utterance is composed: every word comes from the language file, and the values
 * substituted into it are a dish name, a price as it was heard, the booking name and the two stay
 * dates. A placeholder left without a value throws rather than speaking `{dish}` to a callee.
 *
 * @param language - The language the call is in now, which a mid-call switch changes.
 * @param key - The template to render.
 * @param vars - The values for its placeholders; omit them for a template that has none.
 * @returns The utterance to speak.
 * @throws Error when a placeholder has no value.
 */
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

/**
 * The disclosure sentence a call opens with, in the city's own language (AAP 0.5.6).
 *
 * `twiml.ts` writes it as the ConversationRelay `welcomeGreeting` and the session speaks it as its
 * first line, so the callee always learns that the call is automated before anything is asked.
 *
 * @param kind - Which call the greeting belongs to: a price question or a stay verification.
 * @param language - The city's call language.
 * @returns The disclosure sentence.
 */
export function disclosureFor(kind: CallTaskKind, language: CallLanguage): string {
  return renderTemplate(language, GREETING_KEYS[kind]);
}

// ---------------------------------------------------------------------------------------------
// The call and what the app's services give the engine (AAP 0.5.1, 0.5.6)
// ---------------------------------------------------------------------------------------------

/**
 * What a call is about (AAP 0.5.6): the place a price call asks, or the lodging a stay call asks,
 * with the city both of them belong to.
 */
export interface CallTarget {
  /** `place` for a `menu_prices` call, `lodging` for a `lodging_stay_verification` call. */
  readonly type: 'place' | 'lodging';
  /** The `Place.id` or `Lodging.id` the task names. */
  readonly id: string;
  /** The target's city, which keys its call budget and its language. */
  readonly cityId: string;
}

/** The city a call is placed in, as the engine needs it (AAP 0.5.2, 0.5.6). */
export interface CallCity {
  /** The city's slug id, which keys `call_budget_day`. */
  readonly id: string;
  /** The speech pairing the call opens in; `CallLanguage` because the row was validated against it. */
  readonly callLanguage: CallLanguage;
  /** The city's ISO 4217 currency, which a price the callee says is stored in. */
  readonly currency: string;
  /** The city's IANA zone, from configuration. */
  readonly timezone: string;
}

/**
 * Everything one call is (AAP 0.5.6): the attempt it belongs to, the task that asked for it, what it
 * is calling, where that is, and — for a stay verification — the claim whose booking name the
 * lodging script decrypts. Read once per socket by {@link loadCallContext}, so a webhook, a TwiML
 * fetch and the relay all work from the same row.
 */
export interface CallContext {
  /** The `CallAttempt` row, including the dialogue budget it holds. */
  readonly attempt: CallAttempt;
  /** The `CallTask` the attempt belongs to, whose status gates every turn. */
  readonly task: CallTask;
  /** The place or lodging being called. */
  readonly target: CallTarget;
  /** The target's city. */
  readonly city: CallCity;
  /**
   * The claim a stay verification belongs to, with its ciphertexts; `null` for a menu call, and for
   * a stay call whose claim was deleted. It is never decrypted here: the lodging script does that,
   * only while the claim is open (AAP 0.5.2).
   */
  readonly claim: LodgingClaim | null;
}

/**
 * What the engine needs from the app's services: a structural subset of the object `buildApp`
 * builds, so the app's own services satisfy it as they stand and a unit test can stand fakes in for
 * the eight it reads.
 */
export interface DialogueServices {
  /** The guarded database client. */
  readonly db: DbClient;
  /** The injected clock: no `Date` is read anywhere in this file (AAP 0.11.1). */
  readonly clock: Clock;
  /** The redacting logger. */
  readonly logger: Logger;
  /** The outbox dispatcher, which {@link transact} reads and kicks once a transaction wrote a row. */
  readonly outbox: TransactServices['outbox'];
  /** The spend meter the dialogue budget is released through (AAP 0.5.6). */
  readonly spend: LlmSpend;
  /** The configured provider, the classifier's only caller. */
  readonly llm: LlmAdapter;
  /** The process's validated environment, for `LLM_MAX_TURNS_PER_CALL`. */
  readonly env: { readonly LLM_MAX_TURNS_PER_CALL: number };
  /** The IANA zone of a city, from `config/cities.json` (AAP 0.5.6). */
  readonly timezoneFor: (cityId: string) => string;
}

/**
 * The relay socket the session speaks through, injected so a unit test runs without one
 * (AAP 0.5.6). Every frame the engine sends comes from a template, and the socket is closed once the
 * closing line has played out.
 */
export interface RelayIo {
  /** Send one ConversationRelay frame. A socket that has already gone may throw; the engine logs it. */
  send(frame: RelayOutboundFrame): void;
  /** Close the relay connection, after the closing line and the `end` frame. */
  close(): void;
  /**
   * Wait `ms` for buffered speech to play, defaulting to `setTimeout`. A test passes an immediate
   * stub, so a closing line does not cost the suite its real playback time.
   */
  wait?(ms: number): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// What a call produces (AAP 0.5.3, 0.5.6)
// ---------------------------------------------------------------------------------------------

/**
 * One priced item a `menu_prices` call collected (AAP 0.5.6), in the shape
 * `apps/workers/src/jobs/call-results.ts` reads: `slot` decides the stored item's category and
 * alcohol flag, `priceText` is the price as the callee said it, and `amountMinor` is that price in
 * the currency's minor units.
 */
export type MenuPriceItem = {
  /** Which of the three questions the item answered. */
  readonly slot: 'cheapest_main' | 'priciest_main' | 'coffee' | 'beer';
  /** The callee's own name for the item. */
  readonly dish: string;
  /** The price exactly as it was heard, never converted. */
  readonly priceText: string;
  /** The price in minor units of {@link currency}, which the worker copies into the record. */
  readonly amountMinor: number;
  /** The ISO 4217 currency the price was quoted in. */
  readonly currency: string;
  /** Whether the callee confirmed the read-back; an unconfirmed item waits for an operator. */
  readonly confirmed: boolean;
};

/**
 * `CallAttempt.extractedFields`, the cross-app contract with `apps/workers/src/jobs/call-results.ts`
 * (AAP 0.5.2, 0.5.6). The worker stores `phone_quote` price records from the menu form — coffee
 * non-alcoholic, beer alcoholic, `sourceUrl = tel:<number>` — marks every item with
 * `confirmed: false` as `reviewStatus = needs_review`, and applies the lodging form to the claim:
 * `yes` verifies it, `no` rejects it.
 */
export type ExtractedFields =
  | { readonly kind: 'menu_prices'; readonly items: readonly MenuPriceItem[] }
  | {
      readonly kind: 'lodging_stay_verification';
      readonly answer: 'yes' | 'no' | null;
      readonly confirmed: boolean;
    };

/**
 * What one call attempt produced (AAP 0.5.3, 0.5.6): the outcome that drives the task's lifecycle,
 * the confidence that decides whether an operator reviews it, the extracted values, the operator's
 * one-line summary, and the transcript that a menu call keeps for thirty days and a lodging call
 * never keeps at all.
 */
export interface AttemptResult {
  /** `completed` only when the script finished with every value confirmed and unambiguous. */
  readonly outcome: CallAttemptOutcome;
  /** `high` for a completed call, `low` when an operator must review it, `null` with no data. */
  readonly confidence: Confidence | null;
  /** The extracted values, or `null` when the call produced none. */
  readonly extractedFields: ExtractedFields | null;
  /** The operator's summary; never a phone number, and for a stay call never a booking field. */
  readonly summary: string | null;
  /** The call's text; only a menu call's is stored, and never for a lodging call (AAP 0.5.2). */
  readonly transcript: string | null;
}

/**
 * What a script reports once the call ends (AAP 0.5.6): {@link AttemptResult} without the transcript,
 * which the engine owns because it is the one holding the dialogue.
 */
export type ScriptResult = Pick<
  AttemptResult,
  'outcome' | 'confidence' | 'extractedFields' | 'summary'
>;

/**
 * What one script needs from the engine while a call runs (AAP 0.5.6): the values its templates
 * render, and every string that must never reach the language model.
 */
export interface ScriptContext {
  /** The placeholders of this call's templates, rendered in the language the call is in now. */
  readonly vars: (language: CallLanguage) => TemplateVars;
  /**
   * Strings the engine replaces in the classification window (AAP 0.5.2): a stay call's booking name
   * and its parts, empty for a menu call, whose subject is a business rather than a guest.
   */
  readonly redactions: readonly string[];
  /** The currency the city quotes in, which a collected price is stored in. */
  readonly currency: string;
}

/** One template and the values it renders with, as a step's read-back returns them (AAP 0.5.6). */
export interface StepReadback {
  /** The template key to speak. */
  readonly key: TemplateKey;
  /** The placeholders it needs. */
  readonly vars: TemplateVars;
}

/**
 * One question of a script (AAP 0.5.6): what it asks, what an answer has to carry, and how the answer
 * is read back. The step decides one thing only — whether a classification named an item and a price
 * it can be asked about again — while the engine owns the turn loop, the retries, the control labels
 * and every closing line.
 */
export interface ScriptStep<TValue> {
  /** The `collected` key this step's value is stored under. */
  readonly slot: string;
  /** The question's template key. */
  readonly ask: TemplateKey;
  /** What the classifier should hear, which is what makes a bare number a price. */
  readonly expected: ExpectedAnswer;
  /**
   * `'same_answer'` when the read-back restates the question, so the same answer a second time is
   * the confirmation; omitted when the engine follows a read-back with `confirm.prompt` and reads
   * the next `yes`. A refused read-back re-asks the step once either way.
   */
  readonly confirmation?: 'same_answer';
  /**
   * The value `c` carries, or `null` when the answer named no item and no usable price — which is
   * what sends the engine back with `retry.unclear` rather than storing a guess.
   */
  accept(c: Classification, ctx: ScriptContext): TValue | null;
  /** What the engine speaks back before asking for confirmation. */
  readback(value: TValue, ctx: ScriptContext, language: CallLanguage): StepReadback;
}

/**
 * One whole call script (AAP 0.5.6), implemented by `./scripts/menu-prices.ts` and
 * `./scripts/lodging-stay-verification.ts` and held by the engine with its value erased.
 */
export interface ScriptDefinition<TValue> {
  /** Which task kind this script runs; a script refuses a task of another kind from `prepare`. */
  readonly kind: CallTaskKind;
  /**
   * Everything the call needs before it speaks: the claim decrypted and its redactions listed, or
   * `null` when the call must not proceed at all — a claim that is gone, terminal or already erased,
   * whose booking name the engine answers by recording `no_answer` without asking anything.
   */
  prepare(services: DialogueServices, ctx: CallContext): Promise<ScriptContext | null>;
  /** The questions, in the order the call asks them. */
  readonly steps: readonly ScriptStep<TValue>[];
  /**
   * What the call produced once the engine stopped, with every value it collected and whether the
   * dialogue reached its last step. The engine hands this to {@link recordAttemptOutcome} unchanged,
   * and it is what decides `completed` against `needs_review` and `no_answer`.
   */
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

// ---------------------------------------------------------------------------------------------
// The records every writer of a call attempt shares (AAP 0.3.2, 0.5.3)
// ---------------------------------------------------------------------------------------------

/**
 * The attempt row, locked for the rest of the transaction (AAP 0.3.2).
 *
 * Every writer of an attempt — a relay finalize, the status webhook, a TwiML fetch — takes this first,
 * so two of them are serialized and the second sees the first one's outcome. The columns are aliased
 * to the model's field names, which is what the row type says; the `state` and `outcome` values come
 * back as their enum strings, which the database's own check constraint guarantees.
 *
 * @param tx - The transaction client `transact` opened.
 * @param attemptId - The attempt to lock.
 * @returns The locked row, or `null` when it no longer exists.
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
 * Whether an attempt has had its call content stripped (AAP 0.5.2): a failed dispatch never had a
 * call, and a stripped lodging attempt — one whose claim has resolved — has no `CallSid` left.
 *
 * A caller treats a stripped attempt, and a missing one, the same way: the record exists, the call it
 * describes does not, and a late callback is acknowledged without effect.
 *
 * @param attempt - The attempt row, or the two fields of it this reads.
 * @returns True when nothing may be recorded on or read from it.
 */
export function isStripped(attempt: Pick<CallAttempt, 'state' | 'twilioCallSid'>): boolean {
  if (attempt.state === 'dispatch_failed') {
    return true;
  }
  return attempt.state === 'ended' && attempt.twilioCallSid === null;
}

/**
 * Everything one call is, read from its attempt in a single query (AAP 0.5.6).
 *
 * Read-only and outside any transaction: the relay calls it when a socket opens, the TwiML route when
 * Twilio asks for a script, and the status webhook when a call ends, all on ids they already hold.
 * The claim arrives with its ciphertexts and is never decrypted here — the lodging script decrypts it
 * only while the claim is open (AAP 0.5.2).
 *
 * A call whose task, target or city cannot be resolved refuses to proceed, which its caller answers
 * by closing politely: a call placed on a missing row could only read or write nothing.
 *
 * @param db - The guarded client.
 * @param attemptId - The attempt the callback or the socket names.
 * @returns The call, or `null` when any part of it is missing or its city's language is not one of
 *   the five speech pairings.
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

  // `attempt` is the row without its included task, so nothing here carries a relation the model does
  // not declare.
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
 * The dialogue budget a call holds, rebuilt from its attempt (AAP 0.5.6).
 *
 * `apps/workers`' `call-dispatch` reserved it before dialing, on the dispatch-time local day of the
 * city, so the same city and day are what its unused part is released against. A value that is not a
 * positive safe integer reads as no budget at all, which ends the call politely instead of spending
 * past a reservation nobody can vouch for.
 *
 * @param services - The app's services, of which the city's zone is read.
 * @param ctx - The call, whose attempt holds the reserved amount.
 * @returns The reservation the session's turns are metered against.
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
  /**
   * The dialogue budget the attempt held. The release is booked against its city and local day, which
   * only the enclosing call knows, so it travels with the outcome rather than being re-derived from a
   * row this function would have to read again.
   */
  readonly reservation: LlmReservation;
  /** The micro-dollars of that budget the call never spent, released after the commit. */
  readonly unusedMicros: number;
  /**
   * Whether this ending also moves the attempt to `ended` with its `endedAt`, which is set once
   * (AAP 0.5.3).
   */
  readonly endCall?: boolean;
}

/**
 * Record what one call attempt produced, and ask `apps/workers` to apply it — the single writer, and
 * the one place a call's result becomes durable (AAP 0.3.2, 0.5.3, 0.5.6).
 *
 * Call it with the attempt already locked by {@link lockAttempt}, inside the transaction that locks
 * it. The first recorder wins: an attempt that already carries an outcome, or one whose call content
 * was stripped, returns `false` and writes nothing, which is what makes a racing status callback and
 * a relay finalize produce exactly one `apply_call_result` row.
 *
 * The transcript follows the attempt's own extracted fields rather than its caller's word: a menu
 * call's transcript is stored with its thirty-day deletion date, and a lodging call's — and a call
 * that extracted nothing — stores none at all (AAP 0.5.2, 0.5.6, 0.12.2).
 *
 * The outbox row is written in the same transaction as the outcome, so the work it announces becomes
 * durable with the result it describes; the unused dialogue budget is released after the commit,
 * through `after`, because it is a statement on another connection (AAP 0.3.2).
 *
 * @param tx - The transaction client, with the attempt already locked.
 * @param services - The app's services: the clock, the spend meter and the logger.
 * @param after - The transaction's after-commit registration.
 * @param attempt - The locked attempt row.
 * @param result - What the call produced.
 * @param opts - The release and whether this ending also ends the attempt.
 * @returns `true` when this call recorded the outcome, `false` when an earlier writer had.
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

// ---------------------------------------------------------------------------------------------
// The engine (AAP 0.5.6)
// ---------------------------------------------------------------------------------------------

/** The scripts the engine resolves a call by, keyed by the task's kind (AAP 0.5.6, 0.8.1). */
const SCRIPTS: Readonly<Record<CallTaskKind, ScriptDefinition<unknown>>> = {
  menu_prices: menuPricesScript,
  lodging_stay_verification: lodgingStayVerificationScript,
};

/**
 * The script a task's kind selects.
 *
 * @param kind - The call task's kind.
 * @returns The script the engine runs.
 * @throws Error when no script runs that kind, which the record above makes unreachable at compile
 *   time while still keeping the lookup honest at runtime.
 */
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

/** What one control label asks for (AAP 0.5.6). */
type ControlAction = 'switch_english' | 'end_refused' | 'end_do_not_call';

/**
 * An ending the engine decides itself, overriding what the script would have reported (AAP 0.5.3,
 * 0.5.6): a refusal, a do-not-call request and a refusal to spend more dialogue budget are outcomes
 * of the call rather than of what it collected.
 */
interface EndingOverride {
  readonly outcome: CallAttemptOutcome;
  readonly confidence: Confidence | null;
}

/** A callee who asked to speak to a person or to end the call (AAP 0.5.6). */
const REFUSED_ENDING: EndingOverride = { outcome: 'refused', confidence: null };

/** A callee who asked never to be called again (AAP 0.5.6). */
const DO_NOT_CALL_ENDING: EndingOverride = { outcome: 'do_not_call', confidence: null };

/**
 * An ending caused by the dialogue budget: the call has data to review or none, but it certainly has
 * no more budget, so the task is queued for an operator rather than a redial (AAP 0.5.6).
 */
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
 * How a call ended, once {@link DialogueSession.finalize} has recorded it (AAP 0.5.6): `completed`
 * when the dialogue reached its own end — the last step resolved, or the callee asked to stop —
 * `app_closing` when the app ended it (nothing to ask, a model failure, no budget left), and the two
 * the socket and the task decide for themselves.
 */
export type FinalizeReason = 'completed' | 'socket_closed' | 'superseded' | 'app_closing';

/**
 * One automated call: the turn loop that turns a callee's speech into a recorded outcome
 * (AAP 0.5.6).
 *
 * The session is driven from outside — {@link start} once, then {@link onPrompt} per transcribed
 * utterance — and speaks only through its injected socket, so a unit test runs a whole scenario
 * without Twilio. Four invariants hold it together:
 *
 *  - **One turn at a time.** Turns are chained, so a classification is never in flight while another
 *    begins, whatever order the socket delivers prompts in.
 *  - **The task decides.** Before every turn the task's status and the attempt's `superseded` flag are
 *    re-read, so a task cancelled while the call runs ends the dialogue politely instead of talking to
 *    a caller nobody wants a result from (AAP 0.5.3).
 *  - **The budget bounds it.** No more than `LLM_MAX_TURNS_PER_CALL` classifications are made, and
 *    every turn is metered again the call's own reservation, so the reserved dialogue budget cannot be
 *    crossed (AAP 0.5.6).
 *  - **The closing line plays out.** `end` cuts buffered speech, so the session waits for the closing
 *    line, sends the frame, records the outcome and only then closes the socket.
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

  /**
   * Build the session for one attempt (AAP 0.5.6).
   *
   * @param services - The app's services: the database, the clock, the logger, the outbox, the spend
   *   meter, the provider, `LLM_MAX_TURNS_PER_CALL` and the city zones.
   * @param ctx - The call, as {@link loadCallContext} read it.
   * @param script - The script to run, or `undefined` to take the one the task's kind selects.
   * @param io - The relay socket, injected so a test runs without one.
   */
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
   * The disclosure, first, then the first question (AAP 0.5.6).
   *
   * The disclosure is always the first line, whatever the script. The question joins it once it can
   * be rendered: a menu question has no placeholder, so it is there before {@link start} has run,
   * while a stay question names the guest and the dates, which are known only after the script has
   * decrypted the claim.
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
   * Prepare the script and ask its first question (AAP 0.5.6).
   *
   * Twilio has already spoken the disclosure as the `welcomeGreeting`, so this speaks the first
   * question and nothing before it. A script that refuses the call — a claim that is gone, terminal
   * or already erased — closes politely with `no_answer`, which leaves the task to retry where it can
   * and to the operator queue where it cannot.
   */
  async start(): Promise<void> {
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
   * Handle one transcribed utterance (AAP 0.5.6).
   *
   * @param text - What the callee said, as ConversationRelay transcribed it.
   * @returns A promise that resolves once this turn, and any closing line it began, has finished.
   */
  onPrompt(text: string): Promise<void> {
    this.chain = this.chain.then(async () => {
      try {
        await this.handlePrompt(text);
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

  /**
   * Note that the callee started speaking over the agent (AAP 0.5.6).
   *
   * Nothing is replayed and no log line is written: the turn was cut short, which the call's own
   * transcript records and the classification window does not.
   */
  onInterrupt(): void {
    if (this.keepsTranscript) {
      this.transcript.push('interrupt');
    }
  }

  /**
   * Record what the call produced and end it (AAP 0.5.6).
   *
   * Idempotent: the first call wins, and a second one — a socket that closes while the closing line
   * plays out, a task cancelled mid-call — changes nothing. It never throws: a failure is logged as
   * `voice_finalize_failed` and left to `apps/workers`' reconcile, which moves an attempt left
   * `ended` with no outcome to `needs_review` (AAP 0.5.3).
   *
   * @param reason - How the call ended.
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

      await transact(this.services, async (tx, after) => {
        const attempt = await lockAttempt(tx, this.ctx.attempt.id);
        if (attempt === null) {
          return;
        }
        await recordAttemptOutcome(tx, this.services, after, attempt, result, {
          reservation: this.reservation,
          unusedMicros,
          endCall: true,
        });
      });
    } catch {
      this.services.logger.warn(
        { event: 'voice_finalize_failed', attemptId: this.ctx.attempt.id },
        'voice_finalize_failed',
      );
    }
  }

  /** The turn loop of one utterance (AAP 0.5.6). */
  private async handlePrompt(text: string): Promise<void> {
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

    const context = this.scriptContext;
    const step = this.step();
    if (context === null || step === undefined) {
      await this.close('closing.thanks', null, 'app_closing');
      return;
    }

    if (this.classifications >= this.maxTurns) {
      await this.close('closing.budget', BUDGET_ENDING, 'app_closing');
      return;
    }

    this.appendCallee(text);
    this.classifications += 1;

    let classification: Classification;
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

  /**
   * Count a try that produced no confirmation (AAP 0.5.6): the step is retried once, and what the
   * call has by then — a value the callee never confirmed, or nothing at all — is what it keeps.
   */
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
   * Honour a request never to be called again (AAP 0.5.3, 0.5.6): the target is marked, every other
   * task of it is cancelled, and every attempt that may still be on a live call is superseded.
   *
   * One transaction, before the closing line, so the request survives the socket. This attempt is
   * left to its own outcome: `call-results` reads `do_not_call` from the recorded result and closes
   * the task, and a sibling task already in the queue is cancelled here.
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
   * Replace every redaction in a window line (AAP 0.5.2): a lodging call's booking name and its
   * parts become `<guest>` before the line can reach the provider, longest entry first so the whole
   * name goes before its parts and a part cannot carry the guest.
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

  /**
   * Speak a closing line, let it play out, end the relay session and record the outcome
   * (AAP 0.5.6). The first close wins: a socket that closes while the line plays, or a task that is
   * cancelled, finds the call already ended.
   */
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
