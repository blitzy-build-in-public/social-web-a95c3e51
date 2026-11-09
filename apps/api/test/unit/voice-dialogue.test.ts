/**
 * The voice dialogue's unit suite (AAP 0.8.1, 0.5.6, 0.12.2): the disclosure every call opens with in
 * all five languages, the templates and the two scripts the relay speaks from, the booking name's
 * redaction, the classification window's byte bound, one whole call per script driven with fakes, and
 * the call-outcome lines those calls write (AAP 0.11.1).
 */

import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { CallAttempt, CallTask, DbClient, LodgingClaim } from '@tablemate/db';
import {
  CallLanguage,
  VOICE_ATTEMPT_PARAMETER,
  utf8ByteLength,
  type CallAttemptOutcome,
  type CallTaskKind,
  type CallTaskStatus,
  type Confidence,
  type RelayOutboundFrame,
  type RelayTextFrame,
} from '@tablemate/shared';
import {
  createFakeLlmAdapter,
  createFieldKeyring,
  createLogger,
  createTestClock,
  encryptField,
  type FakeLlmAdapter,
  type FieldKeyring,
  type LlmAdapter,
  type LlmRequest,
  type LlmSpend,
  type LlmTurnCharge,
  type Logger,
} from '@tablemate/server-core';

import type { AppServices } from '../../src/app.ts';
import {
  CLASSIFICATION_JSON_SCHEMA,
  CLASSIFICATION_MAX_OUTPUT_TOKENS,
  CLASSIFICATION_TURN_TIMEOUT_MS,
  CLASSIFICATION_WINDOW_MAX_BYTES,
  UTTERANCE_LABELS,
  buildClassificationRequest,
} from '../../src/modules/voice-agent/understanding.ts';
import {
  DialogueSession,
  TEMPLATE_KEYS,
  TEMPLATE_VARS,
  disclosureFor,
  renderTemplate,
  type CallCity,
  type CallContext,
  type RelayIo,
  type ScriptContext,
  type TemplateVars,
} from '../../src/modules/voice-agent/dialogue.ts';
import {
  isMachineAnswer,
  renderHangup,
  renderTwiml,
  xmlEscape,
} from '../../src/modules/voice-agent/twiml.ts';
import {
  menuPricesScript,
  type MenuItemValue,
} from '../../src/modules/voice-agent/scripts/menu-prices.ts';
import {
  lodgingStayVerificationScript,
  type StayValue,
} from '../../src/modules/voice-agent/scripts/lodging-stay-verification.ts';

import enUS from '../../src/modules/voice-agent/i18n/en-US.json' with { type: 'json' };
import esUS from '../../src/modules/voice-agent/i18n/es-US.json' with { type: 'json' };
import idID from '../../src/modules/voice-agent/i18n/id-ID.json' with { type: 'json' };
import ptPT from '../../src/modules/voice-agent/i18n/pt-PT.json' with { type: 'json' };
import thTH from '../../src/modules/voice-agent/i18n/th-TH.json' with { type: 'json' };

import doNotCallScenario from '../support/voice-simulator/scenarios/do-not-call.json' with { type: 'json' };
import englishSwitchScenario from '../support/voice-simulator/scenarios/english-switch.json' with { type: 'json' };
import pricesHighScenario from '../support/voice-simulator/scenarios/prices-high.json' with { type: 'json' };
import stopScenario from '../support/voice-simulator/scenarios/stop.json' with { type: 'json' };
import yesScenario from '../support/voice-simulator/scenarios/yes.json' with { type: 'json' };

// ---------------------------------------------------------------------------------------------
// Fixtures (AAP 0.5.2, 0.5.6): fixed ids, a fixture guest and the two launch cities this file uses
// ---------------------------------------------------------------------------------------------

const RELAY_URL = 'wss://api.tablemate.test/v1/webhooks/voice/relay';
const ATTEMPT_ID = '018f2a10-0000-7000-8000-000000000001';
const TASK_ID = '018f2a10-0000-7000-8000-000000000002';
const PLACE_ID = '018f2a10-0000-7000-8000-000000000003';
const LODGING_ID = '018f2a10-0000-7000-8000-000000000004';
const CLAIM_ID = '018f2a10-0000-7000-8000-000000000005';
const USER_ID = '018f2a10-0000-7000-8000-000000000006';
const OUTBOX_ID = '018f2a10-0000-7000-8000-000000000007';

/** The one booking name in this file: the fictional guest the AAP 0.5.2 fixture rules require. */
const BOOKING_NAME = 'Fixture Guest';

const CLOCK_START = new Date('2026-11-04T12:00:00.000Z');
const STAY_FROM = new Date('2026-11-10T00:00:00.000Z');
const STAY_TO = new Date('2026-11-14T00:00:00.000Z');

/** `LLM_MAX_TURNS_PER_CALL` (AAP 0.5.6), and the dialogue budget a dispatch reserves with it. */
const MAX_TURNS = 60;
const DIALOGUE_BUDGET_MICROS = 600_000n;

/** pino's numeric levels: a per-turn line is debug, a call-outcome line is info (AAP 0.11.1, 0.6.2). */
const DEBUG_LEVEL = 20;
const INFO_LEVEL = 30;

/** The field keyring the stay script decrypts a booking name with (AAP 0.5.2). */
const KEYRING = createFieldKeyring({
  currentKeyId: 'k1',
  keys: { k1: randomBytes(32).toString('base64') },
});

/** A second keyring under the same id, so a ciphertext this process holds no key for can be built. */
const FOREIGN_KEYRING = createFieldKeyring({
  currentKeyId: 'k1',
  keys: { k1: randomBytes(32).toString('base64') },
});

/** Lisbon: the `pt-PT` city this file's price calls run in (AAP 0.5.2). */
const LISBON: CallCity = {
  id: 'lisbon',
  callLanguage: 'pt-PT',
  currency: 'EUR',
  timezone: 'Europe/Lisbon',
};

/** Chiang Mai: the `th-TH` city the mid-call English switch is exercised in (AAP 0.5.2, 0.2.4). */
const CHIANG_MAI: CallCity = {
  id: 'chiang-mai',
  callLanguage: 'th-TH',
  currency: 'THB',
  timezone: 'Asia/Bangkok',
};

/** The five speech pairings, taken from the enum so a sixth language reaches this suite too. */
const LANGUAGES = CallLanguage.options;

/** The five files by language, each read as the flat key-to-text map the templates are. */
const LANGUAGE_FILES: Readonly<Record<CallLanguage, Readonly<Record<string, string>>>> = {
  'en-US': enUS,
  'pt-PT': ptPT,
  'es-US': esUS,
  'th-TH': thTH,
  'id-ID': idID,
};

/** The two call kinds, from the enum that names them (AAP 0.5.2). */
const KINDS = [
  'menu_prices',
  'lodging_stay_verification',
] as const satisfies readonly CallTaskKind[];

// ---------------------------------------------------------------------------------------------
// Row builders: the rows a call is, and the values its scripts collect
// ---------------------------------------------------------------------------------------------

/**
 * One `CallAttempt` row, with the dialogue budget `reservationFor` rebuilds from it.
 *
 * `Object.assign` keeps the model's own field types for the overridden keys, so a case changes one
 * column without restating the fifteen it does not care about.
 */
function attemptRow(overrides: Partial<CallAttempt> = {}): CallAttempt {
  return Object.assign(
    {
      id: ATTEMPT_ID,
      callTaskId: TASK_ID,
      twilioCallSid: 'CA_fixture_attempt_0001',
      state: 'in_progress' as const,
      superseded: false,
      twilioFinalStatus: null,
      outcome: null,
      extractedFields: null,
      summary: null,
      confidence: null,
      transcript: null,
      transcriptDeleteAt: null,
      durationSec: null,
      startedAt: CLOCK_START,
      endedAt: null,
      llmReservedMicros: DIALOGUE_BUDGET_MICROS,
    },
    overrides,
  );
}

/** One `CallTask` row: the task whose status gates every turn (AAP 0.5.3). */
function taskRow(overrides: Partial<CallTask> = {}): CallTask {
  return Object.assign(
    {
      id: TASK_ID,
      kind: 'menu_prices',
      placeId: PLACE_ID,
      lodgingId: null,
      lodgingClaimId: null,
      status: 'in_progress',
      attempts: 1,
      vendorFailures: 0,
      nextAttemptAt: CLOCK_START,
      outcomeAt: null,
      blockedReason: null,
      priority: 0,
      resolvedBy: null,
      createdAt: CLOCK_START,
      updatedAt: CLOCK_START,
    },
    overrides,
  );
}

/** One `LodgingClaim` row whose booking name is the fixture guest's, encrypted (AAP 0.5.2). */
function claimRow(keyring: FieldKeyring, overrides: Partial<LodgingClaim> = {}): LodgingClaim {
  return Object.assign(
    {
      id: CLAIM_ID,
      userId: USER_ID,
      lodgingId: LODGING_ID,
      stayFrom: STAY_FROM,
      stayTo: STAY_TO,
      bookingNameCiphertext: encryptField(keyring, BOOKING_NAME),
      bookingReferenceCiphertext: null,
      callConsentAt: CLOCK_START,
      status: 'pending_call',
      resolvedAt: null,
      detailsErasedAt: null,
      createdAt: CLOCK_START,
    },
    overrides,
  );
}

/** One call, as `loadCallContext` reads it (AAP 0.5.6). */
function callContext(input: {
  readonly city: CallCity;
  readonly kind: CallTaskKind;
  readonly claim?: LodgingClaim | null;
}): CallContext {
  const menu = input.kind === 'menu_prices';
  return {
    attempt: attemptRow(),
    task: taskRow({
      kind: input.kind,
      placeId: menu ? PLACE_ID : null,
      lodgingId: menu ? null : LODGING_ID,
      lodgingClaimId: menu ? null : CLAIM_ID,
    }),
    target: {
      type: menu ? 'place' : 'lodging',
      id: menu ? PLACE_ID : LODGING_ID,
      cityId: input.city.id,
    },
    city: input.city,
    claim: input.claim ?? null,
  };
}

/** The three slots the menu script asks, in the order it asks them (AAP 0.5.6). */
const MENU_SLOTS = ['cheapest_main', 'priciest_main', 'coffee_or_beer'] as const;

/** One item per slot, in the shape a step's `accept` returns (AAP 0.5.6). */
const SAMPLE_ITEM: MenuItemValue = {
  itemSlot: 'cheapest_main',
  dish: 'bitoque',
  priceAmount: 9.5,
  priceText: '9,50 euros',
  amountMinor: 950,
  currency: 'EUR',
};

const MENU_ITEMS: readonly MenuItemValue[] = [
  SAMPLE_ITEM,
  {
    itemSlot: 'priciest_main',
    dish: 'cataplana de marisco',
    priceAmount: 32,
    priceText: '32 euros',
    amountMinor: 3200,
    currency: 'EUR',
  },
  {
    itemSlot: 'coffee',
    dish: 'café',
    priceAmount: 1.2,
    priceText: '1,20 euros',
    amountMinor: 120,
    currency: 'EUR',
  },
];

/** One script context: nothing to render, nothing to redact, the city's own currency. */
const SCRIPT_CONTEXT: ScriptContext = { vars: () => ({}), redactions: [], currency: 'EUR' };

/**
 * The values collected for the first `flags.length` slots of {@link MENU_SLOTS}, each with the
 * confirmation it earned — the map the session fills as a step commits.
 */
function menuCollected(
  flags: readonly boolean[],
): Map<string, { value: MenuItemValue; confirmed: boolean }> {
  const collected = new Map<string, { value: MenuItemValue; confirmed: boolean }>();
  flags.forEach((confirmed, index) => {
    const slot = MENU_SLOTS[index];
    const value = MENU_ITEMS[index];
    if (slot !== undefined && value !== undefined) {
      collected.set(slot, { value, confirmed });
    }
  });
  return collected;
}

// ---------------------------------------------------------------------------------------------
// Fakes (AAP 0.11.2): the two database reads, the socket, the meter and the provider
// ---------------------------------------------------------------------------------------------

/** One scenario turn, as the simulator's files carry it: what was said and how it classifies. */
interface ScenarioTurn {
  readonly say: string;
  readonly classify?: {
    readonly label: string;
    readonly values?: Readonly<Record<string, unknown>>;
  };
}

/** What the fake transaction and the session's own logger recorded, for a case to assert on. */
interface Stores {
  readonly attemptUpdates: Record<string, unknown>[];
  readonly targetUpdates: Record<string, unknown>[];
  readonly taskUpdates: Record<string, unknown>[];
  readonly outboxRows: Record<string, unknown>[];
  /** Every line the session logged while the call ran, parsed (AAP 0.11.1). */
  readonly lines: Record<string, unknown>[];
}

/** One driven call and the spies a case asserts on. */
interface Harness {
  readonly session: DialogueSession;
  readonly frames: readonly RelayOutboundFrame[];
  readonly llm: FakeLlmAdapter;
  readonly stores: Stores;
  readonly releaseLlm: ReturnType<typeof vi.fn>;
  readonly closed: ReturnType<typeof vi.fn>;
}

/** A logger that writes nothing, so the suite's own output stays its own. */
function silentLogger(): Logger {
  return createLogger({ name: 'api', level: 'silent', appEnv: 'test' });
}

/**
 * The logger a driven call writes through, with every line it writes captured rather than printed
 * (AAP 0.11.1).
 */
function capturingLogger(): { readonly logger: Logger; readonly lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    name: 'api',
    level: 'debug',
    appEnv: 'test',
    destination: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  return { logger, lines };
}

/** Every captured line that carries `event`, in the order the call wrote them. */
function linesFor(
  lines: readonly Record<string, unknown>[],
  event: string,
): Record<string, unknown>[] {
  return lines.filter((line) => line['event'] === event);
}

/**
 * The stand-in for the provider's classifier: it answers with the scenario turn whose words appear
 * last in the window the caller sent, and `unclear` when none does. The voice simulator's own
 * responder applies that rule to every scenario at once, and this is the same rule for the one
 * scenario a row drives.
 */
function scenarioResponder(turns: readonly ScenarioTurn[]): (request: LlmRequest) => unknown {
  return (request: LlmRequest): Record<string, unknown> => {
    if (request.jsonSchema?.name !== CLASSIFICATION_JSON_SCHEMA.name) {
      return {};
    }
    const window = request.messages.map((message) => message.content).join('\n');
    let matched: ScenarioTurn | undefined;
    let end = -1;
    for (const turn of turns) {
      const at = window.lastIndexOf(turn.say);
      if (at > end) {
        end = at;
        matched = turn;
      }
    }
    const reply: Record<string, unknown> = {
      label: matched?.classify?.label ?? 'unclear',
      dish: null,
      drink: null,
      priceAmount: null,
      priceText: null,
    };
    for (const [key, value] of Object.entries(matched?.classify?.values ?? {})) {
      reply[key] = value;
    }
    return reply;
  };
}

/**
 * One whole call over fakes: the two database reads the session makes, a metered send that charges
 * nothing, a frozen clock, a capturing socket, a logger whose lines the case reads back, and no wait
 * for speech.
 */
function driveScenario(input: {
  readonly ctx: CallContext;
  readonly turns: readonly ScenarioTurn[];
  readonly taskStatus?: CallTaskStatus;
}): Harness {
  const capture = capturingLogger();
  const stores: Stores = {
    attemptUpdates: [],
    targetUpdates: [],
    taskUpdates: [],
    outboxRows: [],
    lines: capture.lines,
  };
  const attempt = attemptRow();
  const live = {
    superseded: false,
    status: input.taskStatus ?? 'in_progress',
  };
  const tx = {
    $queryRaw: () => Promise.resolve([attempt]),
    callAttempt: {
      update: (args: { readonly data: Record<string, unknown> }) => {
        stores.attemptUpdates.push(args.data);
        return Promise.resolve(attempt);
      },
      updateMany: (args: { readonly data: Record<string, unknown> }) => {
        stores.taskUpdates.push(args.data);
        return Promise.resolve({ count: 1 });
      },
    },
    callTask: {
      updateMany: (args: { readonly data: Record<string, unknown> }) => {
        stores.taskUpdates.push(args.data);
        return Promise.resolve({ count: 1 });
      },
    },
    place: {
      update: (args: {
        readonly where: { readonly id: string };
        readonly data: Record<string, unknown>;
      }) => {
        stores.targetUpdates.push({ ...args.where, ...args.data });
        return Promise.resolve({});
      },
    },
    lodging: {
      update: (args: {
        readonly where: { readonly id: string };
        readonly data: Record<string, unknown>;
      }) => {
        stores.targetUpdates.push({ ...args.where, ...args.data });
        return Promise.resolve({});
      },
    },
    outboxMessage: {
      create: (args: { readonly data: Record<string, unknown> }) => {
        stores.outboxRows.push(args.data);
        return Promise.resolve({ id: OUTBOX_ID });
      },
    },
  };
  const db = {
    callAttempt: {
      findUnique: () =>
        Promise.resolve({ superseded: live.superseded, callTask: { status: live.status } }),
    },
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as DbClient;
  const llm = createFakeLlmAdapter({ respond: scenarioResponder(input.turns) });
  const releaseLlm = vi.fn(() => Promise.resolve());
  /** Count, then send: the order the meter's own contract fixes (AAP 0.5.6). */
  const metered = (adapter: LlmAdapter, request: LlmRequest): Promise<LlmTurnCharge> =>
    adapter
      .complete(request, { timeoutMs: CLASSIFICATION_TURN_TIMEOUT_MS })
      .then((result) => ({ result, chargedMicros: 0, countedInputTokens: 0, remainingMicros: 0 }));
  const spend: LlmSpend = {
    reserveLlm: () => Promise.resolve(null),
    settleLlm: () => Promise.resolve(0),
    releaseLlm,
    countBound: () => Promise.resolve({ countedInputTokens: 0, boundMicros: 0 }),
    dialogueBudgetMicros: () => 0,
    runMetered: (adapter, request) => metered(adapter, request),
    runMeteredWithin: (adapter, request, options) =>
      metered(adapter, request).then((charge) => ({
        ...charge,
        remainingMicros: options.remainingMicros,
      })),
  };
  const frames: RelayOutboundFrame[] = [];
  const closed = vi.fn();
  const io: RelayIo = {
    send: (frame) => {
      frames.push(frame);
    },
    close: closed,
    wait: () => Promise.resolve(),
  };
  const services = {
    db,
    clock: createTestClock(),
    logger: capture.logger,
    outbox: {
      kick: vi.fn(),
      runOnce: () => Promise.resolve(0),
      start: () => () => Promise.resolve(),
    },
    spend,
    llm,
    env: { LLM_MAX_TURNS_PER_CALL: MAX_TURNS },
    timezoneFor: (cityId: string) => (cityId === LISBON.id ? LISBON.timezone : CHIANG_MAI.timezone),
    keyring: KEYRING,
  };
  return {
    session: new DialogueSession(services, input.ctx, undefined, io),
    frames,
    llm,
    stores,
    releaseLlm,
    closed,
  };
}

/** Every frame the session spoke, in order. */
function textFrames(frames: readonly RelayOutboundFrame[]): RelayTextFrame[] {
  return frames.filter((frame): frame is RelayTextFrame => frame.type === 'text');
}

/** The five characters an XML attribute may not carry literally (AAP 0.5.6). */
const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** One attribute value as the TwiML document must carry it, escaped the way this suite states. */
function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => XML_ESCAPES[character] ?? character);
}

/** The `{placeholder}` names one template asks for, in the order they appear. */

/** Whether `value` is a plain object, so one captured update's own fields can be read. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** One captured list as a list of records, with anything else dropped. */
function asItemList(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> => isRecord(item));
}

/** One captured outcome update read as a menu result, or `null` when it is not one. */
function capturedMenu(recorded: Record<string, unknown> | undefined): {
  readonly items: readonly Record<string, unknown>[];
} | null {
  const fields = recorded?.['extractedFields'];
  if (!isRecord(fields) || fields['kind'] !== 'menu_prices') {
    return null;
  }
  return { items: asItemList(fields['items']) };
}

/** A captured value as text, for asserting what it must not contain. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------------------------
// The five template files (AAP 0.5.6)
// ---------------------------------------------------------------------------------------------

describe('the five language files', () => {
  it('carries the same fifteen keys in the same order in every language', () => {
    const reference = Object.keys(enUS);
    expect(reference).toEqual([...TEMPLATE_KEYS]);
    for (const language of LANGUAGES) {
      expect(Object.keys(LANGUAGE_FILES[language])).toEqual(reference);
    }
  });
  it('asks for the same placeholders per key, and none outside the declared five', () => {
    for (const key of TEMPLATE_KEYS) {
      const reference = placeholders(enUS[key]).sort();
      for (const name of reference) {
        expect(TEMPLATE_VARS).toContain(name);
      }
      for (const language of LANGUAGES) {
        expect(placeholders(LANGUAGE_FILES[language][key] ?? '').sort()).toEqual(reference);
      }
    }
    for (const language of LANGUAGES) {
      for (const text of Object.values(LANGUAGE_FILES[language])) {
        expect(text).not.toContain('{handle}');
      }
    }
  });
  it('states the two English disclosures exactly as the AAP writes them', () => {
    expect(enUS['greeting.menu_prices']).toBe(
      'Hello, this is an automated assistant calling on behalf of Tablemate to ask about your menu prices.',
    );
    expect(enUS['greeting.lodging_stay_verification']).toBe(
      "Hello, this is an automated assistant calling on behalf of Tablemate to confirm a guest's stay.",
    );
  });
  it('discloses Tablemate in every other language, in its own words', () => {
    for (const language of LANGUAGES.filter((pairing) => pairing !== 'en-US')) {
      for (const kind of KINDS) {
        const greeting = LANGUAGE_FILES[language][`greeting.${kind}`] ?? '';
        expect(greeting.length).toBeGreaterThan(0);
        expect(greeting).toContain('Tablemate');
        expect(greeting).not.toBe(LANGUAGE_FILES['en-US'][`greeting.${kind}`]);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The disclosure first, in every language (AAP 0.12.2)
// ---------------------------------------------------------------------------------------------

describe('the disclosure a call opens with', () => {
  const cases = LANGUAGES.flatMap((language) => KINDS.map((kind) => [language, kind] as const));
  it.each(cases)('%s/%s: speaks the greeting first and declares en-US', (language, kind) => {
    const greeting = disclosureFor(kind, language);
    expect(greeting).toBe(LANGUAGE_FILES[language][`greeting.${kind}`]);
    const document = renderTwiml({
      relayUrl: RELAY_URL,
      language,
      welcomeGreeting: greeting,
      attemptId: ATTEMPT_ID,
    });
    expect(document).toContain(`welcomeGreeting="${escapeAttribute(greeting)}"`);
    expect(document).toContain(`language="${language}"`);
    expect(document).toContain('<Language code="en-US"');
    expect(document).toContain(
      `<Parameter name="${VOICE_ATTEMPT_PARAMETER}" value="${ATTEMPT_ID}"/>`,
    );
    // Thai, Portuguese, Spanish and Indonesian text is spoken as text: only the five XML-significant
    // characters are ever replaced, and no other character becomes a numeric entity.
    expect(document).not.toContain('&#');
    expect(escapeAttribute(greeting)).toBe(xmlEscape(greeting));
  });
});

describe('the TwiML a call is answered with', () => {
  it('hangs up rather than conversing with a machine (AAP 0.5.3)', () => {
    expect(renderHangup()).toContain('<Hangup/>');
    expect(isMachineAnswer('machine_start')).toBe(true);
    expect(isMachineAnswer('human')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The two scripts (AAP 0.5.6)
// ---------------------------------------------------------------------------------------------

describe('the menu price script', () => {
  it('asks the three questions in order, each read back and confirmed by a prompt', () => {
    expect(menuPricesScript.steps.map((step) => step.slot)).toEqual([...MENU_SLOTS]);
    expect(menuPricesScript.steps.map((step) => step.ask)).toEqual([
      'ask.cheapest_main',
      'ask.priciest_main',
      'ask.coffee_or_beer',
    ]);
    for (const step of menuPricesScript.steps) {
      expect(step.confirmation).toBeUndefined();
      const readback = step.readback(SAMPLE_ITEM, SCRIPT_CONTEXT, 'en-US');
      expect(readback.key).toBe('readback.price');
      expect(readback.vars['dish']).toBeTruthy();
      expect(readback.vars['price']).toBeTruthy();
    }
  });
  const cases: readonly (readonly [
    string,
    readonly boolean[],
    boolean,
    CallAttemptOutcome,
    Confidence | null,
  ])[] = [
    ['all three confirmed, finished', [true, true, true], true, 'completed', 'high'],
    ['one item never confirmed', [true, true, false], true, 'needs_review', 'low'],
    ['dropped mid-script after one item', [true], false, 'needs_review', 'low'],
    ['nothing collected', [], false, 'no_answer', null],
  ];
  it.each(cases)('reports %s', (_name, flags, finished, outcome, confidence) => {
    const result = menuPricesScript.result(menuCollected(flags), finished);
    expect(result.outcome).toBe(outcome);
    expect(result.confidence).toBe(confidence);
    expect(result.summary === null).toBe(flags.length === 0);
    if (flags.length === 0) {
      expect(result.extractedFields).toBeNull();
      return;
    }
    const menu = result.extractedFields?.kind === 'menu_prices' ? result.extractedFields : null;
    // The third slot collects a `coffee` or a `beer` item, which is what `call-results` reads.
    expect(menu?.items.map((item) => item.slot)).toEqual(
      MENU_ITEMS.slice(0, flags.length).map((item) => item.itemSlot),
    );
    expect(menu?.items.map((item) => item.confirmed)).toEqual(flags);
  });
});

describe('the stay verification script', () => {
  const STAY_VARS: TemplateVars = {
    bookingName: BOOKING_NAME,
    stayFrom: '10 November 2026',
    stayTo: '14 November 2026',
  };
  const STAY_CONTEXT: ScriptContext = {
    vars: () => STAY_VARS,
    redactions: [BOOKING_NAME],
    currency: 'EUR',
  };
  it('asks one question, confirmed by the same answer a second time', () => {
    expect(lodgingStayVerificationScript.steps).toHaveLength(1);
    const step = lodgingStayVerificationScript.steps[0];
    expect(step?.slot).toBe('stay');
    expect(step?.ask).toBe('ask.stay');
    expect(step?.confirmation).toBe('same_answer');
    expect(step?.readback({ answer: 'yes' }, STAY_CONTEXT, 'en-US').key).toBe('readback.stay');
  });
  it('names the guest and both dates, and nothing else, in every language', () => {
    for (const language of LANGUAGES) {
      for (const key of ['ask.stay', 'readback.stay'] as const) {
        const spoken = renderTemplate(language, key, STAY_VARS);
        expect(spoken).toContain(BOOKING_NAME);
        expect(spoken).toContain(STAY_VARS.stayFrom);
        expect(spoken).toContain(STAY_VARS.stayTo);
        // A placeholder without a value throws, so this also proves the two templates ask for
        // exactly these three.
        expect(spoken).not.toContain('{');
      }
    }
  });
  const cases: readonly (readonly [
    string,
    { readonly value: StayValue; readonly confirmed: boolean } | null,
    CallAttemptOutcome,
    Confidence | null,
    'yes' | 'no' | null,
  ])[] = [
    ['a confirmed yes', { value: { answer: 'yes' }, confirmed: true }, 'completed', 'high', 'yes'],
    ['a confirmed no', { value: { answer: 'no' }, confirmed: true }, 'completed', 'high', 'no'],
    [
      'an unconfirmed yes',
      { value: { answer: 'yes' }, confirmed: false },
      'needs_review',
      'low',
      'yes',
    ],
    ['nothing collected', null, 'no_answer', null, null],
  ];
  it.each(cases)('reports %s', (_name, entry, outcome, confidence, answer) => {
    const collected = new Map<string, { value: StayValue; confirmed: boolean }>();
    if (entry !== null) {
      collected.set('stay', entry);
    }
    const result = lodgingStayVerificationScript.result(collected, entry !== null);
    expect(result.outcome).toBe(outcome);
    expect(result.confidence).toBe(confidence);
    const fields =
      result.extractedFields?.kind === 'lodging_stay_verification' ? result.extractedFields : null;
    expect(fields?.answer ?? null).toBe(answer);
    expect(fields?.confirmed ?? false).toBe(entry?.confirmed ?? false);
    // The summary is what an operator reads; it names no guest and no date.
    expect(textOf(result.summary)).not.toContain('Fixture');
    expect(textOf(result.summary)).not.toContain('2026-');
  });
});

// ---------------------------------------------------------------------------------------------
// What the stay script decrypts, and when it refuses to ask at all (AAP 0.5.2)
// ---------------------------------------------------------------------------------------------

describe('the stay script prepares a guest it may ask about', () => {
  // The script declares `AppServices` and reads the keyring and the logger from it; the cast names
  // that contract, because the rest of the composition root is what a unit test cannot build.
  const services = { keyring: KEYRING, logger: silentLogger() } as unknown as AppServices;
  it('returns the name, both dates and the redactions the window must use', async () => {
    const ctx = callContext({
      city: LISBON,
      kind: 'lodging_stay_verification',
      claim: claimRow(KEYRING),
    });
    const context = await lodgingStayVerificationScript.prepare(services, ctx);
    expect(context?.redactions).toContain(BOOKING_NAME);
    for (const language of ['en-US', 'th-TH'] as const) {
      const vars = context?.vars(language) ?? {};
      expect(vars.bookingName).toBe(BOOKING_NAME);
      expect(vars.stayFrom).toBeTruthy();
      expect(vars.stayTo).toBeTruthy();
      expect(renderTemplate(language, 'ask.stay', vars)).toContain(BOOKING_NAME);
    }
  });
  const refusals: readonly (readonly [string, CallContext])[] = [
    [
      'a claim that already reached a terminal state',
      callContext({
        city: LISBON,
        kind: 'lodging_stay_verification',
        claim: claimRow(KEYRING, { status: 'verified' }),
      }),
    ],
    [
      'a claim whose booking details were erased',
      callContext({
        city: LISBON,
        kind: 'lodging_stay_verification',
        claim: claimRow(KEYRING, { detailsErasedAt: CLOCK_START }),
      }),
    ],
    [
      'a ciphertext this process holds no key for',
      callContext({
        city: LISBON,
        kind: 'lodging_stay_verification',
        claim: claimRow(FOREIGN_KEYRING),
      }),
    ],
    [
      'a stay call whose claim is gone',
      callContext({ city: LISBON, kind: 'lodging_stay_verification', claim: null }),
    ],
    ['a menu task', callContext({ city: LISBON, kind: 'menu_prices' })],
  ];
  it.each(refusals)('refuses %s', async (_name, ctx) => {
    await expect(lodgingStayVerificationScript.prepare(services, ctx)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The classification turn (AAP 0.5.6)
// ---------------------------------------------------------------------------------------------

describe('the utterance classifier', () => {
  it('offers exactly the nine labels the AAP names', () => {
    expect([...UTTERANCE_LABELS]).toEqual([
      'price',
      'dish',
      'yes',
      'no',
      'prefers_english',
      'wants_human',
      'stop',
      'do_not_call',
      'unclear',
    ]);
  });
  it('sends the most recent two kilobytes of a Thai and emoji window, unbroken', () => {
    const oldest = 'agent: สวัสดีค่ะ';
    const long = `callee: ${'ก'.repeat(1_200)}${'😀'.repeat(200)} สุดท้ายค่ะ`;
    const latest = 'ค่ะ ใช่ค่ะ';
    const request = buildClassificationRequest([oldest, long], 'stay_answer', latest, []);
    const content = request.messages.map((message) => message.content).join('\n');
    const lines = content.split('\n');
    const start = lines.indexOf('Conversation:') + 1;
    const end = lines.findIndex((line) => line.startsWith('Latest: '));
    expect(utf8ByteLength(lines.slice(start, end).join('\n'))).toBeLessThanOrEqual(
      CLASSIFICATION_WINDOW_MAX_BYTES,
    );
    // The newest words are kept and the older line is dropped whole.
    expect(content).toContain('สุดท้ายค่ะ');
    expect(content).toContain(`Latest: ${latest}`);
    expect(content).not.toContain(oldest);
    // A Thai cluster or an emoji is never cut in half into a replacement character or a lone
    // surrogate, whichever bound the window hits.
    expect(content).not.toContain('\uFFFD');
    expect(content).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
    expect(request.jsonSchema).toBe(CLASSIFICATION_JSON_SCHEMA);
    expect(request.maxTokens).toBe(CLASSIFICATION_MAX_OUTPUT_TOKENS);
  });
});

// ---------------------------------------------------------------------------------------------
// One call per script, driven over fakes (AAP 0.5.6)
// ---------------------------------------------------------------------------------------------

describe('a call driven turn by turn', () => {
  it('asks the three questions, reads each answer back, confirms it and records high confidence', async () => {
    const harness = driveScenario({
      ctx: callContext({ city: LISBON, kind: 'menu_prices' }),
      turns: pricesHighScenario.turns,
    });
    await harness.session.start();
    for (const turn of pricesHighScenario.turns) {
      await harness.session.onPrompt(turn.say);
    }
    expect(textFrames(harness.frames).map((frame) => templateOf('pt-PT', frame.token))).toEqual([
      'ask.cheapest_main',
      'readback.price',
      'confirm.prompt',
      'ask.priciest_main',
      'readback.price',
      'confirm.prompt',
      'ask.coffee_or_beer',
      'readback.price',
      'confirm.prompt',
      'closing.thanks',
    ]);
    expect(harness.session.finalizedBy).toBe('completed');
    const recorded = harness.stores.attemptUpdates[0];
    expect(recorded?.['outcome']).toBe('completed');
    expect(recorded?.['confidence']).toBe('high');
    expect(recorded?.['state']).toBe('ended');
    // A menu call keeps its transcript for thirty days; a lodging call never keeps one (AAP 0.5.2).
    expect(textOf(recorded?.['transcript'])).not.toBe('');
    expect(capturedMenu(recorded)?.items.map((item) => item['slot'])).toEqual([
      'cheapest_main',
      'priciest_main',
      'coffee',
    ]);
    expect(capturedMenu(recorded)?.items[0]).toMatchObject({ currency: 'EUR', amountMinor: 950 });
    expect(harness.stores.outboxRows).toEqual([
      expect.objectContaining({ kind: 'apply_call_result' }),
    ]);
    // The attempt's unused dialogue budget is released after the commit (AAP 0.5.6).
    expect(harness.releaseLlm).toHaveBeenCalledTimes(1);
    expect(harness.closed).toHaveBeenCalledTimes(1);
    // One debug line per classified turn, in the order the answers arrived, and — the call having
    // extracted everything — no line about missing data (AAP 0.11.1).
    expect(
      linesFor(harness.stores.lines, 'voice_turn').map((line) => line['classification']),
    ).toEqual(['price', 'yes', 'price', 'yes', 'price', 'yes']);
    expect(linesFor(harness.stores.lines, 'voice_call_no_data')).toEqual([]);
  });
  it('switches recognition and speech together on a preference for English', async () => {
    const harness = driveScenario({
      ctx: callContext({ city: CHIANG_MAI, kind: 'menu_prices' }),
      turns: englishSwitchScenario.turns,
    });
    const turns = englishSwitchScenario.turns;
    await harness.session.start();
    await harness.session.onPrompt(firstTurn(turns).say);
    expect(harness.frames.slice(0, 4)).toEqual([
      {
        type: 'text',
        token: renderTemplate('th-TH', 'ask.cheapest_main'),
        last: true,
        lang: 'th-TH',
      },
      { type: 'language', ttsLanguage: 'en-US', transcriptionLanguage: 'en-US' },
      { type: 'text', token: renderTemplate('en-US', 'switch.english'), last: true, lang: 'en-US' },
      {
        type: 'text',
        token: renderTemplate('en-US', 'ask.cheapest_main'),
        last: true,
        lang: 'en-US',
      },
    ]);
    for (const turn of turns.slice(1)) {
      await harness.session.onPrompt(turn.say);
    }
    // Every line after the switch is an `en-US.json` template, whichever question it is.
    const spoken = textFrames(harness.frames);
    for (const frame of spoken.slice(3)) {
      expect(TEMPLATE_KEYS).toContain(templateOf('en-US', frame.token));
    }
    expect(templateOf('en-US', spoken.at(-1)?.token ?? '')).toBe('closing.thanks');
    const recorded = harness.stores.attemptUpdates[0];
    expect(recorded?.['outcome']).toBe('completed');
    expect(recorded?.['confidence']).toBe('high');
    // The price the callee said in baht is stored in the city's own currency (AAP 0.11.1).
    expect(capturedMenu(recorded)?.items[0]).toMatchObject({ currency: 'THB', amountMinor: 6000 });
  });
  it('closes on a refusal with the closing line of the call language', async () => {
    const harness = driveScenario({
      ctx: callContext({ city: LISBON, kind: 'menu_prices' }),
      turns: stopScenario.turns,
    });
    await harness.session.start();
    await harness.session.onPrompt(firstTurn(stopScenario.turns).say);
    const spoken = textFrames(harness.frames).map((frame) => frame.token);
    expect(spoken.at(-1)).toBe(renderTemplate('pt-PT', 'closing.refused'));
    expect(harness.frames.at(-1)).toEqual({ type: 'end' });
    expect(harness.stores.attemptUpdates[0]?.['outcome']).toBe('refused');
    expect(harness.stores.attemptUpdates[0]?.['confidence']).toBeNull();
    expect(harness.stores.targetUpdates).toEqual([]);
    // The refusal is a turn like any other: its label is recorded before the engine acts on it, and
    // a call that closed on it says nothing about missing data (AAP 0.5.6, 0.11.1).
    expect(linesFor(harness.stores.lines, 'voice_turn')).toEqual([
      expect.objectContaining({
        attemptId: ATTEMPT_ID,
        turn: 1,
        step: 'cheapest_main',
        classification: 'stop',
      }),
    ]);
    expect(linesFor(harness.stores.lines, 'voice_call_no_data')).toEqual([]);
  });
  it('marks the target and cancels its other tasks on a do-not-call request', async () => {
    const harness = driveScenario({
      ctx: callContext({ city: LISBON, kind: 'menu_prices' }),
      turns: doNotCallScenario.turns,
    });
    await harness.session.start();
    await harness.session.onPrompt(firstTurn(doNotCallScenario.turns).say);
    const spoken = textFrames(harness.frames).map((frame) => frame.token);
    expect(spoken.at(-1)).toBe(renderTemplate('pt-PT', 'closing.do_not_call'));
    expect(harness.frames.at(-1)).toEqual({ type: 'end' });
    expect(harness.stores.attemptUpdates[0]?.['outcome']).toBe('do_not_call');
    // The request is durable before the closing line is spoken (AAP 0.5.6).
    expect(harness.stores.targetUpdates).toEqual([{ id: PLACE_ID, doNotCall: true }]);
    expect(harness.stores.taskUpdates).toEqual([{ status: 'cancelled' }, { superseded: true }]);
  });
  it('ends a call whose task stopped being in_progress, and spends nothing on it', async () => {
    const harness = driveScenario({
      ctx: callContext({ city: LISBON, kind: 'menu_prices' }),
      turns: pricesHighScenario.turns,
      taskStatus: 'cancelled',
    });
    await harness.session.start();
    await harness.session.onPrompt(firstTurn(pricesHighScenario.turns).say);
    expect(harness.session.finalizedBy).toBe('superseded');
    expect(harness.stores.attemptUpdates[0]?.['outcome']).toBe('no_answer');
    expect(harness.llm.calls.sent).toEqual([]);
    // Nobody answered, so no turn was ever classified: this `no_answer` carries no turn line and no
    // line about missing data, which is what distinguishes it from a call the dialogue could not
    // understand (AAP 0.5.3, 0.11.1).
    expect(linesFor(harness.stores.lines, 'voice_turn')).toEqual([]);
    expect(linesFor(harness.stores.lines, 'voice_call_no_data')).toEqual([]);
  });
  it('verifies a stay without ever handing the guest name to the provider', async () => {
    const harness = driveScenario({
      ctx: callContext({
        city: LISBON,
        kind: 'lodging_stay_verification',
        claim: claimRow(KEYRING),
      }),
      turns: yesScenario.turns,
    });
    await harness.session.start();
    for (const turn of yesScenario.turns) {
      await harness.session.onPrompt(turn.say);
    }
    // The relay does speak the name — the question and the read-back both carry it — so the
    // redaction below is a real one rather than an absence of the string.
    const spoken = textFrames(harness.frames).map((frame) => frame.token);
    expect(spoken.some((line) => line.includes(BOOKING_NAME))).toBe(true);
    expect(harness.llm.calls.sent.length).toBeGreaterThan(0);
    for (const request of harness.llm.calls.sent) {
      expect(request).not.toContain(BOOKING_NAME);
      expect(request).not.toContain('Fixture');
      expect(request).not.toContain('Guest');
    }
    const recorded = harness.stores.attemptUpdates[0];
    expect(recorded?.['outcome']).toBe('completed');
    expect(recorded?.['confidence']).toBe('high');
    expect(recorded?.['transcript']).toBeNull();
    expect(recorded?.['summary']).toBe('Reception answered yes; confirmed on read-back.');
    expect(textOf(recorded?.['summary'])).not.toContain('Fixture');
    const fields = recorded?.['extractedFields'];
    expect(isRecord(fields) ? fields['answer'] : null).toBe('yes');
    expect(isRecord(fields) ? fields['confirmed'] : null).toBe(true);
  });
  it('logs every unclassified turn and the line that says the call ended with no data at all', async () => {
    // No scenario turns, so every prompt classifies `unclear` — the reply the credential-free `fake`
    // provider gives — and the dialogue collects nothing at all (AAP 0.5.6, 0.6.2).
    const harness = driveScenario({
      ctx: callContext({ city: LISBON, kind: 'menu_prices' }),
      turns: [],
    });
    await harness.session.start();
    // Two tries per question, three questions, and then the call closes.
    for (let turn = 0; turn < 6; turn += 1) {
      await harness.session.onPrompt('Desculpe, não percebi.');
    }
    expect(harness.session.finalizedBy).toBe('completed');
    // One debug line per classified turn, each naming the label the turn classified as and the
    // question it was answering, so the log stream shows where the dialogue was lost (AAP 0.11.1).
    const turns = linesFor(harness.stores.lines, 'voice_turn');
    expect(turns.map((line) => line['classification'])).toEqual(Array(6).fill('unclear'));
    expect(turns.map((line) => line['turn'])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(turns.map((line) => line['step'])).toEqual([
      'cheapest_main',
      'cheapest_main',
      'priciest_main',
      'priciest_main',
      'coffee_or_beer',
      'coffee_or_beer',
    ]);
    for (const line of turns) {
      expect(line['attemptId']).toBe(ATTEMPT_ID);
      expect(line['level']).toBe(DEBUG_LEVEL);
    }
    // No line carries the callee's words, however the call went (AAP 0.11.1, 0.12.2).
    expect(JSON.stringify(harness.stores.lines)).not.toContain('Desculpe');
    // The attempt keeps `no_answer`, the outcome the AAP fixes for a call that produced no data, and
    // the one line beside it says why: the dialogue ran and did not understand the callee, which is
    // not the same as a line nobody answered (AAP 0.5.2, 0.5.3, 0.11.1).
    expect(harness.stores.attemptUpdates[0]?.['outcome']).toBe('no_answer');
    expect(linesFor(harness.stores.lines, 'voice_call_outcome')).toEqual([
      expect.objectContaining({ attemptId: ATTEMPT_ID, outcome: 'no_answer' }),
    ]);
    const noData = linesFor(harness.stores.lines, 'voice_call_no_data');
    expect(noData).toEqual([
      expect.objectContaining({
        attemptId: ATTEMPT_ID,
        outcome: 'no_answer',
        turns: 6,
        level: INFO_LEVEL,
      }),
    ]);
  });

  it('answers an utterance the relay cut at its own byte bound without asking the model', async () => {
    const harness = driveScenario({
      ctx: callContext({ city: LISBON, kind: 'menu_prices' }),
      turns: pricesHighScenario.turns,
    });
    await harness.session.start();

    // The relay holds an utterance only up to the classification window's own bound, and hands the
    // turn on with nothing but the fact that it was cut (AAP 0.5.6).
    const cut = 'Z9'.repeat(CLASSIFICATION_WINDOW_MAX_BYTES);
    await harness.session.onPrompt(cut, { overlong: true });

    // No request was counted, sent or charged: the dialogue budget is untouched (AAP 0.5.6).
    expect(harness.llm.calls.counted).toEqual([]);
    expect(harness.llm.calls.sent).toEqual([]);
    // It is still a turn, and it takes the path an `unclear` classification takes: the question the
    // step asked is put again, and the per-turn line names the label the dialogue answered itself.
    expect(textFrames(harness.frames).map((frame) => frame.token)).toEqual([
      renderTemplate('pt-PT', 'ask.cheapest_main'),
      renderTemplate('pt-PT', 'retry.unclear'),
    ]);
    expect(linesFor(harness.stores.lines, 'voice_turn')).toEqual([
      expect.objectContaining({
        attemptId: ATTEMPT_ID,
        turn: 1,
        step: 'cheapest_main',
        classification: 'unclear',
      }),
    ]);

    // The next turns are classified as any other is, and neither the requests nor the call's own
    // transcript carries the cut utterance: nothing of it was appended anywhere (AAP 0.5.6). The
    // script still runs to its end, so the cut utterance cost one question and nothing else.
    for (const turn of pricesHighScenario.turns) {
      await harness.session.onPrompt(turn.say);
    }

    expect(harness.llm.calls.sent).toHaveLength(pricesHighScenario.turns.length);
    for (const request of harness.llm.calls.sent) {
      expect(request).not.toContain('Z9');
    }
    const recorded = harness.stores.attemptUpdates[0];
    expect(recorded?.['outcome']).toBe('completed');
    const transcript = textOf(recorded?.['transcript']);
    expect(transcript).toContain(renderTemplate('pt-PT', 'ask.cheapest_main'));
    expect(transcript).not.toContain('Z9');
  });
});

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1] ?? '');
}

/**
 * The template key `line` was spoken from, or the line itself when none matches: the file's own text
 * up to its first placeholder is the part a rendered utterance keeps unchanged, so a spoken line
 * names the key and the language it came from.
 */
function templateOf(language: CallLanguage, line: string): string {
  for (const key of TEMPLATE_KEYS) {
    const template = LANGUAGE_FILES[language][key] ?? '';
    const cut = template.indexOf('{');
    if (line === template || (cut > 0 && line.startsWith(template.slice(0, cut)))) {
      return key;
    }
  }
  return line;
}

/** The scenario's first turn, which every scenario file declares. */
function firstTurn(turns: readonly ScenarioTurn[]): ScenarioTurn {
  const turn = turns[0];
  if (turn === undefined) {
    throw new Error('scenario has no turns');
  }
  return turn;
}
