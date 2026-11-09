/**
 * The `lodging_stay_verification` call script: one question — is a guest named `<booking name>` staying
 * `<stayFrom>` to `<stayTo>` — and the voice relay's only decryption of a booking name. Nothing else
 * about the user is ever spoken: no handle, no app account, no booking reference, and both answers
 * confirm the same way.
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

/** What this call extracts: whether reception confirmed the guest's stay. */
export interface StayValue {
  answer: 'yes' | 'no';
}

/**
 * `@db.Date` values are read in UTC: a city's local zone would move a stay that begins on the 1st
 * into the previous month west of Greenwich. `th-TH` gives ICU's Buddhist calendar.
 */
export function formatStayDate(date: Date | string, language: CallLanguage): string {
  const day =
    date instanceof Date
      ? DateTime.fromJSDate(date, { zone: 'utc' })
      : DateTime.fromISO(date, { zone: 'utc' });
  return day.setLocale(language).toLocaleString(DateTime.DATE_FULL);
}

/**
 * Every form of the booking name that must never reach the language model: the full name plus each
 * whitespace-separated part of two or more characters, longest first so the whole name is replaced
 * before its parts. A one-character part is left alone — it would blank ordinary words.
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

/** The claim states whose booking name may be decrypted: a terminal claim has nothing left to verify. */
const OPEN_CLAIM_STATUSES: readonly LodgingClaimStatus[] = ['pending_call', 'calling'];

/**
 * Decrypts the booking name and builds the stay question's vars. Runs under five conditions at once:
 * a lodging-stay verification, a claim, an open claim status, unerased details and a ciphertext.
 * Anything else refuses the call before it is dialled, and a ciphertext this process cannot open ends
 * it the same way, recorded as a code and the attempt id and nothing else. The booking reference is
 * never decrypted, spoken or logged.
 */
function prepare(services: AppServices, ctx: CallContext): Promise<ScriptContext | null> {
  // Every guard and the decryption are synchronous: the promise is returned, not declared `async`.
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

/** Both keys must exist in every `../i18n/*.json` with the `{bookingName}`, `{stayFrom}` and `{stayTo}` vars. */
const ASK_KEY: TemplateKey = 'ask.stay';
const READBACK_KEY: TemplateKey = 'readback.stay';

/**
 * The readback restates the question rather than the answer, so a second matching answer is the
 * confirmation — which makes `high` confidence honest for a no as well as for a yes. A label that is
 * neither yes nor no yields no value; `unclear` and the control labels are the engine's to handle.
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

/** What the engine records for this script: {@link ScriptDefinition}'s own result shape. */
type StayScriptResult = ReturnType<ScriptDefinition<StayValue>['result']>;

/**
 * `no_answer` while nothing was collected, so the task is retried while its two attempts last;
 * `completed`/`high` once reception's answer was confirmed on read-back, and `needs_review`/`low`
 * otherwise, which sends the claim to the operator queue. The summary and the extracted fields carry
 * the answer and nothing else: never the booking name, never the dates.
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

/** The `lodging_stay_verification` script as the dialogue engine consumes it. */
export const lodgingStayVerificationScript = {
  kind: 'lodging_stay_verification',
  prepare,
  steps: [stayStep] as const,
  result,
} satisfies ScriptDefinition<StayValue>;
