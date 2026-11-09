/** The call-and-menu priority rule's unit suite (AAP 0.5.7): the distance bands of `nearest_partner_distance_m`, the BullMQ priority `menu-ingest` labels its jobs with, and the `ORDER BY` fragment `call-dispatch` takes its call tasks in. */

import type { Prisma } from '@tablemate/db';

import { describe, expect, it } from 'vitest';

import { callTaskOrderSql, distanceBand, menuPriority } from '../../src/calls/priority.ts';

const NOW = new Date('2026-11-10T10:00:00.000Z');
const APP_ENV = 'test';
const TASK_ALIAS = 't';
const PLACE_ALIAS = 'p';
const BAND_EDGES_M = [250, 500, 1000, 2000] as const;
const NOT_NEAR_BAND = BAND_EDGES_M.length;
const LOCKED_MEETUP_HORIZON_DAYS = 3;
const MAX_PRIORITY = 1 + 2 * NOT_NEAR_BAND + 1;
type BandCase = readonly [distanceM: number | null, band: number];
/** Each band edge and the metres either side of it (AAP 0.5.7). An edge is inclusive; a `null` distance, and one that cannot be measured at all, is the last band. */
const BAND_CASES: readonly BandCase[] = [
  [0, 0],
  [250, 0],
  [250.01, 1],
  [251, 1],
  [500, 1],
  [501, 2],
  [1000, 2],
  [1001, 3],
  [2000, 3],
  [2001, 4],
  [null, 4],
  [Number.NaN, 4],
  [Number.POSITIVE_INFINITY, 4],
];
type Candidate = readonly [
  name: string,
  distanceM: number | null,
  nearLockedMeetup: boolean,
  lodgingOnly: boolean,
  priority: number,
];
/** Eight candidates, written out of order so the sort has to do the work (AAP 0.5.7): `a`-`f` are venue-near, paired inside a band by the locked-meetup flag, and `h`/`g` are lodging-only, where the band is the last one whatever the distance says, so only the flag separates them. */
const CANDIDATES: readonly Candidate[] = [
  ['f', 1800, false, false, 8],
  ['h', 50, true, true, 9],
  ['b', 100, false, false, 2],
  ['g', 300, false, true, 10],
  ['c', 400, true, false, 3],
  ['a', 100, true, false, 1],
  ['e', 1800, true, false, 7],
  ['d', 400, false, false, 4],
];
const RANKED = ['a', 'b', 'c', 'd', 'e', 'f', 'h', 'g'];
const BOUNDARY_CASES: readonly (readonly [nearerM: number, fartherM: number])[] = [
  [250, 251],
  [500, 501],
  [1000, 1001],
  [2000, 2001],
];
/** Aliases that would carry SQL of their own if they were quoted and sent (AAP 0.11.2). */
const UNSAFE_ALIASES: readonly (readonly [string])[] = [
  ['t; DROP TABLE call_task'],
  ['p" OR TRUE'],
  [''],
];
function priorityOf(
  nearestPartnerDistanceM: number | null,
  nearLockedMeetup: boolean,
  lodgingOnly: boolean,
): number {
  return menuPriority({ nearestPartnerDistanceM, nearLockedMeetup, lodgingOnly });
}

describe('distanceBand', () => {
  it.each(BAND_CASES)('%s m -> band %i', (distanceM, band) => {
    expect(distanceBand(distanceM)).toBe(band);
  });
});

describe('menuPriority', () => {
  it.each(CANDIDATES)(
    '%s at %s m (locked %s, lodging-only %s) -> %i',
    (name, distanceM, nearLockedMeetup, lodgingOnly, priority) => {
      const value = priorityOf(distanceM, nearLockedMeetup, lodgingOnly);
      expect(value, name).toBe(priority);
      // BullMQ runs a LOWER priority first and an unprioritized job before any of them, so every job carries a whole number of 1 or more, and none beyond the last band (AAP 0.5.6, 0.5.7).
      expect(Number.isInteger(value) && value >= 1 && value <= MAX_PRIORITY, name).toBe(true);
    },
  );

  it('orders by band, then by a near locked meetup, then lodging-only places last', () => {
    const ranked = CANDIDATES.map(([name, distanceM, nearLockedMeetup, lodgingOnly]) => ({
      name,
      priority: priorityOf(distanceM, nearLockedMeetup, lodgingOnly),
    }))
      .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name))
      .map((place) => place.name);
    expect(ranked).toEqual(RANKED);
    // The band outranks the flag: the last metre of a band still precedes the first metre of the next when only the farther place is near a locked meetup (AAP 0.5.7).
    for (const [nearerM, fartherM] of BOUNDARY_CASES) {
      expect(priorityOf(nearerM, false, false)).toBeLessThan(priorityOf(fartherM, true, false));
    }
  });
});

describe('callTaskOrderSql', () => {
  const fragment: Prisma.Sql = callTaskOrderSql(TASK_ALIAS, PLACE_ALIAS, NOW, APP_ENV);
  const bandKey = fragment.sql.indexOf('nearest_partner_distance_m');
  const lockedKey = fragment.sql.indexOf('EXISTS');

  it('orders the lodging-verification tasks, then the band, then the locked-meetup flag', () => {
    // Both aliases, the place's own distance column and the meetup's status are in the statement.
    expect(fragment.sql).toContain(`"${PLACE_ALIAS}"."nearest_partner_distance_m"`);
    expect(fragment.sql).toContain(`"${TASK_ALIAS}"."kind"`);
    expect(fragment.sql).toContain('lodging_stay_verification');
    expect(fragment.sql).toContain("'locked'");
    // The band is the rule's primary key and the flag its tie-break inside one band, so the CASE has to be ordered before the EXISTS, and the deferred tasks after both (AAP 0.5.7).
    expect(fragment.sql.indexOf(`"${TASK_ALIAS}"."kind"`)).toBeLessThan(bandKey);
    expect(bandKey).toBeLessThan(lockedKey);
    expect(lockedKey).toBeLessThan(fragment.sql.indexOf(`"${TASK_ALIAS}"."next_attempt_at"`));
  });

  it('binds the band edges, the horizon and the instant instead of writing them inline', () => {
    expect(typeof fragment.sql).toBe('string');
    expect(Array.isArray(fragment.values)).toBe(true);
    expect(fragment.values).toEqual(
      expect.arrayContaining([...BAND_EDGES_M, NOT_NEAR_BAND, LOCKED_MEETUP_HORIZON_DAYS]),
    );
    expect(fragment.values).toContain(NOW);
  });

  it.each(UNSAFE_ALIASES)('refuses the alias %o rather than quoting it', (alias) => {
    expect(() => callTaskOrderSql(alias, PLACE_ALIAS, NOW, APP_ENV)).toThrow(RangeError);
    expect(() => callTaskOrderSql(TASK_ALIAS, alias, NOW, APP_ENV)).toThrow(RangeError);
  });
});
