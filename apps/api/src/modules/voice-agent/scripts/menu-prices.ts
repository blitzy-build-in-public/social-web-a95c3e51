/**
 * The `menu_prices` call script: the three questions one automated price call asks, and what their
 * answers become (AAP 0.5.6, 0.8.1).
 *
 * The script is fixed, so the agent improvises nothing: the cheapest main course, the most expensive
 * main course, then a coffee or a beer, each answer read back in the call's language and confirmed
 * before it counts. Every word spoken comes from a template key of `../i18n/*.json` — this module
 * holds no speech, no clock, no storage and no log — and the engine (`../dialogue.ts`) owns the turn
 * loop, the retries, the control labels and the closing lines. `accept` therefore decides one thing
 * only: whether an answer carried an item and a price, which is what makes a partial call `low`
 * confidence instead of an invented price.
 *
 * `result()` is the cross-app contract with `apps/workers/src/jobs/call-results.ts`, which stores
 * every item as a `PriceRecord` with `source = 'phone_quote'`, non-alcoholic for a `coffee` slot and
 * alcoholic for a `beer` one, `localAmountMinor = amountMinor` and `sourceUrl = tel:<number>`
 * (AAP 0.5.6). `priceText` is the callee's own words wherever they gave any, so a stored price stays
 * traceable to what was said.
 *
 * @see AAP 0.5.6 for the script, the read-back rule and the confidence rule, 0.5.2 for the transcript
 *   the engine keeps for 30 days, 0.5.3 for the task outcomes, 0.11.1 for money as integers.
 */

import type { CallLanguage } from '@tablemate/shared';

import type { Classification, ExpectedAnswer } from '../understanding.ts';

import type {
  CallContext,
  ScriptContext,
  ScriptDefinition,
  ScriptResult,
  ScriptStep,
  TemplateKey,
} from '../dialogue.ts';

/**
 * The slot of one item the call priced (AAP 0.5.6), which is how `call-results.ts` tells the three
 * kinds apart: `cheapest_main` and `priciest_main` are main courses, `coffee` is a non-alcoholic
 * drink and `beer` an alcoholic one.
 */
export type MenuItemSlot = 'cheapest_main' | 'priciest_main' | 'coffee' | 'beer';

/**
 * One priced item as the steps collect it (AAP 0.5.6): the slot is what `call-results.ts` turns into
 * a `PriceRecord` category (`coffee` non-alcoholic, `beer` alcoholic), `dish` is the callee's own
 * name for the item, `priceAmount` and `priceText` are the price exactly as it was heard and never
 * converted, and `amountMinor` is that price in `currency`'s minor units — the figure the worker
 * copies into `PriceRecord.localAmountMinor` (AAP 0.11.1).
 *
 * The currency travels inside the value because `result()` receives the collected values alone, and
 * the value has to stay plain JSON for the engine to compare and persist it — which is also why this
 * shape and the two below are type aliases and not interfaces: an interface carries no implicit
 * index signature, so it is not assignable to a JSON-carrying type.
 */
export type MenuItemValue = {
  readonly itemSlot: MenuItemSlot;
  readonly dish: string;
  readonly priceAmount: number;
  readonly priceText: string;
  readonly amountMinor: number;
  readonly currency: string;
};

/** One item as `result()` reports it: the collected value with the confirmation it earned. */
export type MenuExtractedItem = {
  readonly slot: MenuItemSlot;
  readonly dish: string;
  readonly priceText: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly confirmed: boolean;
};

/**
 * What a menu call extracted, in the order the items were asked: JSON for the
 * `CallAttempt.extractedFields` column and for `call-results.ts`, which reads `items[].slot` to set
 * `alcoholic`. It is a list rather than a flat map of scalars, so a result's extracted fields are a
 * JSON object and not only scalars.
 */
export type MenuPricesExtractedFields = {
  readonly kind: 'menu_prices';
  readonly items: MenuExtractedItem[];
};

/**
 * The currency exponents where CLDR's currency digits differ from ISO 4217: in Node 22.23.4
 * `maximumFractionDigits` resolves to 0 for both, while ISO 4217 — and so the price pipeline —
 * gives each an exponent of 2.
 */
const ISO_MINOR_UNIT_OVERRIDES: Readonly<Record<string, number>> = { COP: 2, IDR: 2 };

/**
 * How many minor units one major unit of `currency` holds (AAP 0.11.1), which is the ISO 4217
 * exponent `apps/workers/src/menus/price-parse.ts` parses a menu price with and
 * `apps/workers/src/fx/open-er-api.ts` scales one back by. The two must agree, or a price collected
 * by a call and one extracted from a page mean different amounts.
 *
 * Derived from ICU, which resolves 2 for EUR, MXN, THB and USD, and corrected for the two launch
 * currencies whose ICU digits are not their ISO 4217 exponent: an exponent read straight from ICU
 * would store a Colombian or Indonesian quote at a hundredth of its value.
 *
 * @param currency - An ISO 4217 code, as `City.currency` holds it.
 * @returns The exponent: 2 for every currency the pilot quotes in.
 */
export function currencyMinorDigits(currency: string): number {
  const override = ISO_MINOR_UNIT_OVERRIDES[currency];
  if (override !== undefined) {
    return override;
  }

  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits;
  // ICU resolves a digit count for every currency, so the ISO 4217 default is unreachable here.
  return digits ?? 2;
}

/**
 * `amount` as an integer number of minor units of `currency`, rounded half up.
 *
 * The figure {@link MenuItemValue.amountMinor} carries and `call-results.ts` copies into
 * `PriceRecord.localAmountMinor`, so a price heard on a call is stored exactly as the menu pipeline
 * stores one parsed from a page (AAP 0.5.6).
 *
 * @param amount - The price in major units, as the callee said it.
 * @param currency - An ISO 4217 code.
 * @returns The integer amount in minor units.
 */
export function toAmountMinor(amount: number, currency: string): number {
  return Math.round(amount * 10 ** currencyMinorDigits(currency));
}

/**
 * `amount` written the way `language` writes money, for the readback template's `{price}` variable.
 *
 * Spoken, not stored: a read-back says `12,50 €` in `pt-PT` and `฿120.00` in `th-TH`, and after a
 * mid-call switch to English the engine passes `en-US`. The stored price text is the callee's own
 * words instead, or this same figure in `en-US` when they gave none, so a stored price never depends
 * on the language the call happened to end in.
 *
 * @param amount - The price in major units.
 * @param currency - An ISO 4217 code.
 * @param language - The language the call is in now (AAP 0.5.6).
 * @returns The price as a localized currency string.
 */
export function formatSpokenPrice(
  amount: number,
  currency: string,
  language: CallLanguage,
): string {
  return new Intl.NumberFormat(language, { style: 'currency', currency }).format(amount);
}

/** The `collected` key of each step, in the order the script asks them (AAP 0.5.6). */
const STEP_SLOTS = ['cheapest_main', 'priciest_main', 'coffee_or_beer'] as const;

/** One step's `collected` key. */
type StepSlot = (typeof STEP_SLOTS)[number];

/** The item one answer named — its slot and its name — beside the price the classifier read. */
interface ItemPick {
  readonly itemSlot: MenuItemSlot;
  readonly dish: string;
}

/** What one accepted answer names, or `null` when it named no item. */
type ItemPicker = (c: Classification) => ItemPick | null;

/** One value the engine collected, with whether the callee confirmed it on read-back (AAP 0.5.6). */
interface CollectedValue {
  readonly value: MenuItemValue;
  readonly confirmed: boolean;
}

/**
 * The dish a main-course answer named, or `null` when it named none: an answer that is only a price,
 * or only `unclear`, is not an item and the engine re-asks with `retry.unclear` (AAP 0.5.6).
 *
 * @param c - The classification of the callee's latest utterance.
 * @param itemSlot - The main course being asked about.
 * @returns The named dish, or `null`.
 */
function mainCourse(c: Classification, itemSlot: MenuItemSlot): ItemPick | null {
  const dish = c.dish?.trim() ?? '';
  return dish === '' ? null : { itemSlot, dish };
}

/**
 * The coffee or beer a drink answer named, or `null` when it named neither. The dish is the callee's
 * own words when they gave a name and the drink's own name otherwise, so every stored item has a
 * name (AAP 0.5.6).
 *
 * @param c - The classification of the callee's latest utterance.
 * @returns The named drink, or `null`.
 */
function drink(c: Classification): ItemPick | null {
  if (c.drink === null) {
    return null;
  }

  const said = c.dish?.trim() ?? '';
  return { itemSlot: c.drink, dish: said === '' ? c.drink : said };
}

/**
 * One price question: what it asks, what counts as an answer, and how the answer is read back
 * (AAP 0.5.6).
 *
 * `confirmation` is deliberately left unset, so the engine speaks `confirm.prompt` after
 * `readback.price` and the next `yes` confirms the item. An answer with no item or no usable price
 * is refused, which is what sends the engine back with `retry.unclear` rather than storing a guess.
 *
 * @param slot - The `collected` key the accepted value is stored under.
 * @param ask - The template key of the question.
 * @param expected - What the classifier should hear, which is what makes a bare number a price.
 * @param pick - The rule that reads the item the answer named.
 * @returns The step, ready for the engine.
 */
function priceStep(
  slot: StepSlot,
  ask: TemplateKey,
  expected: ExpectedAnswer,
  pick: ItemPicker,
): ScriptStep<MenuItemValue> {
  return {
    slot,
    ask,
    expected,
    accept: (c, ctx) => {
      const amount = c.priceAmount;
      const picked = pick(c);
      if (picked === null || amount === null || !Number.isFinite(amount) || amount <= 0) {
        return null;
      }

      const said = c.priceText?.trim() ?? '';
      return {
        itemSlot: picked.itemSlot,
        dish: picked.dish,
        priceAmount: amount,
        priceText: said === '' ? formatSpokenPrice(amount, ctx.currency, 'en-US') : said,
        amountMinor: toAmountMinor(amount, ctx.currency),
        currency: ctx.currency,
      };
    },
    readback: (value, _ctx, language) => ({
      key: 'readback.price',
      vars: {
        dish: value.dish,
        price: formatSpokenPrice(value.priceAmount, value.currency, language),
      },
    }),
  };
}

/**
 * The `menu_prices` dialogue, in the order of AAP 0.5.6: the cheapest main course, the most
 * expensive main course, then a coffee or a beer. Declared `satisfies` rather than annotated, so a
 * misspelt template key fails to typecheck against the engine's own key type.
 */
const steps = [
  priceStep('cheapest_main', 'ask.cheapest_main', 'dish_and_price', (c) =>
    mainCourse(c, 'cheapest_main'),
  ),
  priceStep('priciest_main', 'ask.priciest_main', 'dish_and_price', (c) =>
    mainCourse(c, 'priciest_main'),
  ),
  priceStep('coffee_or_beer', 'ask.coffee_or_beer', 'drink_price', drink),
] as const satisfies readonly ScriptStep<MenuItemValue>[];

/**
 * Nothing to prepare: a call about menu prices asks a business about its prices, so it needs no
 * lookup, nothing decrypted and no redaction.
 *
 * The app's injected services arrive for the scripts that do need one — the lodging call decrypts a
 * booking name — and are declared as `unknown` here, because reading none of them is what keeps this
 * script free of any dependency on the app's shape. A task of another kind is refused with `null`,
 * which the engine answers by speaking `closing.thanks` and recording `no_answer` (AAP 0.5.3).
 *
 * The promise is returned rather than awaited, and the function is not `async`: nothing in it is
 * asynchronous, and the engine only requires a promise.
 *
 * @param _services - Unused: this script reads nothing from the app.
 * @param ctx - The task and city of the call; the currency travels from here into every step.
 * @returns The script's context, or `null` when this is not a menu call.
 */
function prepareMenuPrices(_services: unknown, ctx: CallContext): Promise<ScriptContext | null> {
  if (ctx.task.kind !== 'menu_prices') {
    return Promise.resolve(null);
  }

  return Promise.resolve({
    vars: () => ({}),
    redactions: [],
    currency: ctx.city.currency,
  });
}

/** One accepted value as the item `call-results.ts` stores, with the confirmation it earned. */
function asExtractedItem(entry: CollectedValue): MenuExtractedItem {
  return {
    slot: entry.value.itemSlot,
    dish: entry.value.dish,
    priceText: entry.value.priceText,
    amountMinor: entry.value.amountMinor,
    currency: entry.value.currency,
    confirmed: entry.confirmed,
  };
}

/**
 * What the call produced once the engine stopped: the items it collected, in the order they were
 * asked, and the outcome their completeness earns (AAP 0.5.6).
 *
 * `high` needs every value confirmed on read-back and parsed unambiguously, which the `accept` gates
 * and the engine's confirmation already guarantee per item; anything less — a value never confirmed,
 * a question never answered, a call that dropped mid-script or ran out of dialogue budget — is
 * `needs_review` with whatever was collected, so an operator sees partial data rather than a lost
 * call. A call that produced no item at all is `no_answer` (AAP 0.5.3).
 *
 * The summary is the operator's one line per item. It carries no phone number, no `tel:` URL and
 * nothing the callee did not say.
 *
 * @param collected - Every value the engine accepted, by step slot.
 * @param finished - Whether the dialogue reached its last step.
 * @returns The outcome, its confidence, the extracted fields and the summary.
 */
function result(collected: ReadonlyMap<string, CollectedValue>, finished: boolean): ScriptResult {
  const items: MenuExtractedItem[] = [];
  for (const slot of STEP_SLOTS) {
    const entry = collected.get(slot);
    if (entry !== undefined) {
      items.push(asExtractedItem(entry));
    }
  }

  if (items.length === 0) {
    return { outcome: 'no_answer', confidence: null, extractedFields: null, summary: null };
  }

  const complete =
    finished && items.length === STEP_SLOTS.length && items.every((item) => item.confirmed);

  return {
    outcome: complete ? 'completed' : 'needs_review',
    confidence: complete ? 'high' : 'low',
    extractedFields: { kind: 'menu_prices', items },
    summary: items
      .map((item) => `${item.slot}: ${item.dish} ${item.priceText} ${confirmationLabel(item)}`)
      .join('\n'),
  };
}

/** How a collected item's line in the summary marks its confirmation. */
function confirmationLabel(item: MenuExtractedItem): string {
  return item.confirmed ? '(confirmed)' : '(unconfirmed)';
}

/**
 * The `menu_prices` script the relay runs for a price task (AAP 0.5.6, 0.8.1): cheapest main course,
 * most expensive main course, coffee or beer, each read back and confirmed, `high` confidence only
 * when all three are confirmed.
 *
 * `apps/workers/src/jobs/call-results.ts` consumes `result().extractedFields`, and
 * {@link MenuPricesExtractedFields} is the shape it reads.
 */
export const menuPricesScript = {
  kind: 'menu_prices',
  prepare: prepareMenuPrices,
  steps,
  result,
} as const satisfies ScriptDefinition<MenuItemValue>;
