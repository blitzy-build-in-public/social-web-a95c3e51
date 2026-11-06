/**
 * The `lodging_stay_verification` call script: the one question a lodging is asked, and the only
 * place in the voice relay where a guest's booking name is decrypted (AAP 0.5.2, AAP 0.5.6).
 *
 * The script asks whether a guest named `<booking name>` is staying from `<stayFrom>` to `<stayTo>`,
 * restates that question and asks for an explicit answer, and says nothing else about the user:
 * never the handle, never the app account, never the booking reference. Both answers confirm the
 * same way, so a confirmed no rejects a claim as firmly as a confirmed yes verifies one (AAP 0.5.6).
 *
 * The plaintext name lives only in the session context `prepare` builds, and only while the claim is
 * open; the name and its parts travel to the engine as `redactions`, which keeps them out of the
 * classification window. No transcript is kept for this kind, and the extracted fields and summary
 * `result` returns last only until the claim resolves: `apps/workers`' `call-results` applies them to
 * the claim and its `data-expiry` strips them (AAP 0.5.2, AAP 0.5.3). Nothing here speaks — every
 * utterance is a template key of `../i18n/*.json`.
 */

import { DateTime } from 'luxon';

import { FieldDecryptionError, decryptField } from '@tablemate/server-core';

import type { CallLanguage, LodgingClaimStatus } from '@tablemate/shared';

import type { AppServices } from '../../../app.ts';
import type { Classification } from '../understanding.ts';
import type {
  CallContext,
  ScriptContext,
  ScriptDefinition,
  ScriptStep,
  TemplateKey,
} from '../dialogue.ts';

/** What this call extracts: whether reception confirmed the guest's stay (AAP 0.5.6). */
export interface StayValue {
  answer: 'yes' | 'no';
}

/**
 * One stay date as a date the lodging's own staff read (AAP 0.5.6).
 *
 * Both columns are `@db.Date`, whose Prisma values are `Date`s at UTC midnight, so they are read in
 * UTC: a city's local zone would move a stay that begins on the 1st to the previous month for every
 * city west of Greenwich. `th-TH` then gives ICU's default Buddhist calendar (year + 543), the era
 * Thai reception staff read, while the other four give their own long forms.
 *
 * @param date - A `@db.Date` value or its `YYYY-MM-DD` text.
 * @param language - The language the call is spoken in, which is also the locale to format in.
 * @returns The day in that language's long form: day, full month name and year.
 */
export function formatStayDate(date: Date | string, language: CallLanguage): string {
  const day =
    date instanceof Date
      ? DateTime.fromJSDate(date, { zone: 'utc' })
      : DateTime.fromISO(date, { zone: 'utc' });
  return day.setLocale(language).toLocaleString(DateTime.DATE_FULL);
}

/**
 * Every form of the booking name that must never reach the language model (AAP 0.5.2, AAP 0.5.6).
 *
 * The full name is what the engine replaces in the classification window, and a callee who repeats
 * only part of it — the ordinary case on a phone call — would otherwise hand that part to the
 * provider as speech. Each whitespace-separated part of two or more characters is therefore redacted
 * as well, longest first, so the whole name is replaced before its parts are. A one-character part
 * is left alone: it would blank ordinary words out of the window.
 *
 * @param bookingName - The decrypted booking name.
 * @returns The name and its parts, trimmed, de-duplicated and longest first.
 */
export function nameRedactions(bookingName: string): readonly string[] {
  const name = bookingName.trim();
  const parts = name.split(/\s+/).filter((part) => part.length >= 2);
  // The empty string is dropped rather than kept: the engine replaces every entry in the window, and
  // an empty one would match everywhere.
  return [...new Set([name, ...parts])]
    .filter((entry) => entry !== '')
    .sort((a, b) => b.length - a.length);
}

/**
 * The claim states a call may still be placed under, and the only ones whose booking name may be
 * decrypted (AAP 0.5.2): a claim that reached a terminal state has nothing left to verify.
 */
const OPEN_CLAIM_STATUSES: readonly LodgingClaimStatus[] = ['pending_call', 'calling'];

/**
 * Decrypt the booking name and build the variables the stay question renders from (AAP 0.5.2,
 * AAP 0.5.6).
 *
 * This is the voice relay's only decryption of a booking name, and it runs under five conditions at
 * once: the task is a lodging-stay verification, the task carries a claim, the claim is still open,
 * its details are not yet erased and a ciphertext is present. Anything else refuses the call before
 * it is dialled — the engine speaks `closing.thanks` and records `no_answer` — because asking a
 * lodging about a guest whose claim is gone would disclose a name for nothing.
 *
 * A ciphertext this process cannot open, whether a key id a rotation dropped or a value written
 * under another key, ends the call the same way, recorded as a code and the attempt id and nothing
 * else (AAP 0.11.1). The booking reference is never decrypted, spoken or logged: this script asks
 * about the name and the stay dates only (AAP 0.5.6).
 *
 * @param services - The app's services: the field keyring and the redacting logger.
 * @param ctx - The call: its task, its attempt, its city and the claim loaded through the task.
 * @returns The session context — the name, both dates and the redactions — or `null` when the call
 *   must not proceed, in which case nothing about the guest is heard, logged or stored.
 */
function prepare(services: AppServices, ctx: CallContext): Promise<ScriptContext | null> {
  // Every guard and the decryption itself are synchronous, so the promise the engine awaits is
  // returned rather than this function being declared `async`.
  const { claim } = ctx;
  if (ctx.task.kind !== 'lodging_stay_verification' || claim === null) return Promise.resolve(null);
  if (!OPEN_CLAIM_STATUSES.includes(claim.status) || claim.detailsErasedAt !== null) {
    return Promise.resolve(null);
  }

  const ciphertext = claim.bookingNameCiphertext;
  if (ciphertext === null) return Promise.resolve(null);

  let bookingName: string;
  try {
    bookingName = decryptField(services.keyring, ciphertext).trim();
  } catch (error) {
    if (!(error instanceof FieldDecryptionError)) throw error;
    services.logger.warn({ event: 'booking_details_unavailable', attemptId: ctx.attempt.id });
    return Promise.resolve(null);
  }
  if (bookingName === '') return Promise.resolve(null);

  return Promise.resolve({
    vars: (language) => ({
      bookingName,
      stayFrom: formatStayDate(claim.stayFrom, language),
      stayTo: formatStayDate(claim.stayTo, language),
    }),
    redactions: nameRedactions(bookingName),
    currency: ctx.city.currency,
  });
}

/**
 * The two templates this script renders, named once so a misspelt key fails typecheck. Both must
 * exist in every `../i18n/*.json` with the `{bookingName}`, `{stayFrom}` and `{stayTo}` vars
 * (AAP 0.5.6).
 */
const ASK_KEY: TemplateKey = 'ask.stay';
const READBACK_KEY: TemplateKey = 'readback.stay';

/**
 * The call's one step: the stay question, which the same answer a second time confirms (AAP 0.5.6).
 *
 * The readback restates the question rather than the answer, so the engine treats a second matching
 * answer as the confirmation — which is what makes `high` confidence honest for a no as well as for
 * a yes. A label that is neither yes nor no yields no value: `unclear` and the control labels are
 * the engine's to handle.
 */
const stayStep = {
  slot: 'stay',
  ask: ASK_KEY,
  expected: 'stay_answer',
  confirmation: 'same_answer',
  accept: (c: Classification): StayValue | null => {
    if (c.label === 'yes') return { answer: 'yes' };
    if (c.label === 'no') return { answer: 'no' };
    return null;
  },
  readback: (_value: StayValue, ctx: ScriptContext, language: CallLanguage) => ({
    key: READBACK_KEY,
    vars: ctx.vars(language),
  }),
} satisfies ScriptStep<StayValue>;

/** What the engine records for this script: {@link ScriptDefinition}'s own result shape (AAP 0.5.3). */
type StayScriptResult = ReturnType<ScriptDefinition<StayValue>['result']>;

/**
 * What the engine records once the call ends (AAP 0.5.3, AAP 0.5.6): `no_answer` while nothing was
 * collected, so the task is retried while its two attempts last; `completed` with `high` confidence
 * once reception's answer was confirmed on read-back; and `needs_review` with `low` confidence
 * otherwise, which sends the claim to the operator queue.
 *
 * `finished` changes nothing: one step is this whole script, so a confirmed answer is the end of the
 * call whether or not the relay had to close early. The summary and the extracted fields carry the
 * answer and nothing else — never the booking name, never the dates — because `call-results` reads
 * the answer from them and `data-expiry` strips them once the claim resolves (AAP 0.5.2).
 */
function result(
  collected: ReadonlyMap<string, { value: StayValue; confirmed: boolean }>,
  _finished: boolean,
): StayScriptResult {
  const entry = collected.get('stay');
  if (entry === undefined) {
    return { outcome: 'no_answer', confidence: null, extractedFields: null, summary: null };
  }

  const answer = entry.value.answer;
  if (!entry.confirmed) {
    return {
      outcome: 'needs_review',
      confidence: 'low',
      extractedFields: { kind: 'lodging_stay_verification', answer, confirmed: false },
      summary: 'Reception answer not confirmed on read-back.',
    };
  }
  return {
    outcome: 'completed',
    confidence: 'high',
    extractedFields: { kind: 'lodging_stay_verification', answer, confirmed: true },
    summary: `Reception answered ${answer}; confirmed on read-back.`,
  };
}

/**
 * The `lodging_stay_verification` script as the dialogue engine consumes it (AAP 0.5.6): one
 * question, one confirmation and the answer it yields, with the booking name decrypted only here and
 * only while the claim is open (AAP 0.5.2).
 *
 * `apps/workers`' `call-results` applies `extractedFields` to the claim — `yes` marks it `verified`,
 * `no` marks it `rejected` — and its `data-expiry` erases those fields and the booking details after
 * the claim resolves.
 */
export const lodgingStayVerificationScript = {
  kind: 'lodging_stay_verification',
  prepare,
  steps: [stayStep] as const,
  result,
} satisfies ScriptDefinition<StayValue>;
