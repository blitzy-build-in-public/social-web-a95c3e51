/**
 * The operator request shape that the contract can state by itself, at the one layer that can state it:
 * `ResolveCallTask` accepts `prices` with `completed` alone, because that is the only outcome that stores them as
 * `operator_entry` — the other three close the task on its status. A body carrying them with `refused`,
 * `do_not_call` or `unreachable` is refused by the request schema rather than answered `200` with the supplied
 * array dropped, so a caller always learns its prices went nowhere. The handler still validates the outcome value
 * against `OperatorCallTaskOutcome` and answers `422 invalid_outcome`; that is a lifecycle question no schema can
 * decide, and `admin.test.ts` covers it end to end.
 *
 * The rule is written out here rather than read from the schema's own refinement, so the schema has to disagree
 * with it to pass. Every case is a row of a table (`it.each`) and every body is built from the two fixtures below.
 */
import { describe, expect, it } from 'vitest';

import { OperatorCallTaskOutcome, ResolveCallTask } from '../src/index.ts';
/** The prices an operator is told over the phone: a main course and one standard per-person ticket, the one category whose two extra fields a price carries. `localAmountMinor` is the amount in the currency's minor unit, which only this route's input carries. */
const PRICES = [
  {
    name: 'Bacalhau à Brás',
    category: 'main',
    priceText: '$12.50',
    currency: 'USD',
    alcoholic: null,
    perPerson: null,
    ticketType: null,
    localAmountMinor: 1250,
  },
  {
    name: 'Museum entry',
    category: 'ticket',
    priceText: '$9.00',
    currency: 'USD',
    alcoholic: null,
    perPerson: true,
    ticketType: 'standard',
    localAmountMinor: 900,
  },
];
/** The four outcomes an operator may record, taken from the enum so none is written out by hand. */
const OUTCOMES = OperatorCallTaskOutcome.options;
/** The three outcomes that store nothing: the task closes on its status (AAP 0.5.3). */
const STORELESS_OUTCOMES = OUTCOMES.filter((outcome) => outcome !== 'completed');
/** Every body the schema must accept, with the case title it is read under. */
const ACCEPTED_BODIES: readonly (readonly [string, Record<string, unknown>])[] = [
  ['the prices an operator was told', { outcome: 'completed', prices: PRICES }],
  ['no prices at all', { outcome: 'completed' }],
  ...STORELESS_OUTCOMES.map((outcome) => [`\`${outcome}\` alone`, { outcome }] as const),
];
/** Every body the schema must refuse: a supplied `prices` with an outcome that stores nothing, an empty list included, since the key itself is what the rule is about. */
const REJECTED_BODIES: readonly (readonly [string, Record<string, unknown>])[] =
  STORELESS_OUTCOMES.flatMap((outcome) => [
    [`the prices with \`${outcome}\``, { outcome, prices: PRICES }] as const,
    [`an empty list with \`${outcome}\``, { outcome, prices: [] }] as const,
  ]);

describe('ResolveCallTask', () => {
  it.each(ACCEPTED_BODIES)('accepts %s', (_name, body) => {
    const parsed = ResolveCallTask.safeParse(body);

    expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(
      true,
    );
    // Nothing the caller supplied is dropped or rewritten on the way in.
    expect(parsed.success ? parsed.data : null).toEqual(body);
  });

  it.each(REJECTED_BODIES)('refuses %s', (_name, body) => {
    const parsed = ResolveCallTask.safeParse(body);

    // The failure points at the field the caller misused, so a client can fix the request rather than guess — and the outcome it sent is not itself what the refusal is about.
    expect(
      parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.')),
    ).toContain('prices');
  });

  it.each(OUTCOMES)('accepts the outcome `%s` as a plain string', (outcome) => {
    // An outcome the operator may not apply to this task is the handler's `422 invalid_outcome`, so the schema admits the four values and refuses no value of this field (AAP 0.5.4).
    expect(ResolveCallTask.safeParse({ outcome }).success).toBe(true);
  });

  it('accepts an outcome the lifecycle does not know, a refusal the handler makes', () => {
    expect(ResolveCallTask.safeParse({ outcome: 'maybe' }).success).toBe(true);
  });

  it('refuses a body carrying a key the route does not declare', () => {
    expect(ResolveCallTask.safeParse({ outcome: 'completed', note: 'called twice' }).success).toBe(
      false,
    );
  });
});
