/**
 * The framing experiment's assignment rule (AAP 0.5.7, 0.8.1, 0.11.2).
 *
 * `bucketFor` and `variantFromBucket` decide, from the account id and `EXPERIMENT_SALT` alone, which
 * of the two deposit framings a traveler reads on every deposit screen, in every deposit
 * notification and on every deposit-funnel event. The rule is the request's own arithmetic, so the
 * suite recomputes it here over `node:crypto` instead of restating it: {@link oracleBucket} is the
 * whole HMAC-SHA256 digest under the salt, read as one unsigned big-endian integer modulo the basis,
 * which fails if the digest is truncated, read signed, or keyed the other way round.
 *
 * `assign` and `variantFor` are database-backed and are not exercised here; what this file pins is
 * the pure decision they call, plus the per-meetup pairing the proposal stores.
 */

import { createHmac, randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@tablemate/server-core';
import type { Variant, VariantPairing } from '@tablemate/shared';

import {
  SHARE_BASIS,
  bucketFor,
  variantFromBucket,
} from '../../src/modules/experiment/assignment.ts';
import { variantPairing } from '../../src/modules/experiment/copy.ts';

/** Fixed, non-secret salts: the suite never reads `EXPERIMENT_SALT` from the environment. */
const SALT = 'unit-salt-a';
const OTHER_SALT = 'unit-salt-b';

/** A UUIDv7-shaped id, fixed so every oracle row is reproducible. */
const SAMPLE_ID = '018f2c6e-9d3a-7c11-8a2b-6f0a1b2c3d01';

/** The fixed ids whose buckets the independent oracle must reproduce. */
const FIXED_IDS = [
  SAMPLE_ID,
  '018f2c6e-9d3a-7c11-8a2b-6f0a1b2c3d02',
  '018f2c6e-9d3a-7c11-8a2b-6f0a1b2c3d03',
  '018f2c6e-9d3a-7c11-8a2b-6f0a1b2c3d04',
  '018f2c6e-9d3a-7c11-8a2b-6f0a1b2c3d05',
];

/** Twenty fixed ids for the keying check: a salted digest cannot move none of twenty buckets. */
const KEYING_IDS = Array.from(
  { length: 20 },
  (_, index) => `018f2c6e-0000-7000-8000-${index.toString().padStart(12, '0')}`,
);

/** The accounts the split smoke runs over, drawn once so both shares describe the same 2,000. */
const SPLIT_IDS = Array.from({ length: 2_000 }, () => randomUUID());

/** Any user-id-shaped string, so one assertion can show no id reached the log line. */
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/**
 * The rule, recomputed independently of the unit under test: every digest byte as one unsigned
 * big-endian integer, reduced modulo the basis the split is expressed in.
 */
function oracleBucket(salt: string, userId: string): number {
  const digest = createHmac('sha256', salt).update(userId, 'utf8').digest('hex');
  return Number(BigInt(`0x${digest}`) % BigInt(SHARE_BASIS));
}

describe('bucketFor', () => {
  it('sizes the split basis at 10000 buckets', () => {
    expect(SHARE_BASIS).toBe(10_000);
  });

  it.each(FIXED_IDS)('reads the whole digest, big-endian and keyed by the salt (%s)', (userId) => {
    expect(bucketFor(SALT, userId)).toBe(oracleBucket(SALT, userId));
    expect(bucketFor(OTHER_SALT, userId)).toBe(oracleBucket(OTHER_SALT, userId));
  });

  it('keeps every bucket an integer in 0-9999 for 200 fresh ids', () => {
    for (let index = 0; index < 200; index += 1) {
      const bucket = bucketFor(SALT, randomUUID());
      expect(Number.isInteger(bucket)).toBe(true);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThanOrEqual(SHARE_BASIS - 1);
    }
  });

  it('gives one id one bucket however often it is asked', () => {
    const first = KEYING_IDS.map((userId) => bucketFor(SALT, userId));
    const second = KEYING_IDS.map((userId) => bucketFor(SALT, userId));

    expect(second).toEqual(first);
    expect(bucketFor(SALT, SAMPLE_ID)).toBe(oracleBucket(SALT, SAMPLE_ID));
  });

  it('moves at least one of twenty buckets when the salt changes', () => {
    const moved = KEYING_IDS.filter(
      (userId) => bucketFor(SALT, userId) !== bucketFor(OTHER_SALT, userId),
    );

    expect(moved.length).toBeGreaterThan(0);
  });
});

describe('variantFromBucket', () => {
  const boundaries: Array<[share: number, bucket: number, expected: Variant]> = [
    [0.5, 0, 'social'],
    [0.5, 4_999, 'social'],
    [0.5, 5_000, 'punitive'],
    [0.5, 9_999, 'punitive'],
    [1, 0, 'social'],
    [1, 9_999, 'social'],
    [0, 0, 'punitive'],
    [0, 9_999, 'punitive'],
    [0.25, 2_499, 'social'],
    [0.25, 2_500, 'punitive'],
    [0.3333, 3_332, 'social'],
    [0.3333, 3_333, 'punitive'],
  ];

  it.each(boundaries)('share %s puts bucket %i in %s', (share, bucket, expected) => {
    expect(variantFromBucket(bucket, share)).toBe(expected);
  });
});

describe('the configured split', () => {
  it('assigns between 45% and 55% social at share 0.5', () => {
    const social = SPLIT_IDS.filter(
      (userId) => variantFromBucket(bucketFor(SALT, userId), 0.5) === 'social',
    );
    const share = social.length / SPLIT_IDS.length;

    expect(share).toBeGreaterThanOrEqual(0.45);
    expect(share).toBeLessThanOrEqual(0.55);
  });

  it("assigns every account social at the request's 100% fallback", () => {
    const variants = new Set(
      SPLIT_IDS.map((userId) => variantFromBucket(bucketFor(SALT, userId), 1)),
    );

    expect(variants).toEqual(new Set(['social']));
  });
});

describe('variantPairing', () => {
  const pairings: Array<[Variant | null, Variant | null, VariantPairing]> = [
    ['social', 'social', 'social'],
    ['punitive', 'punitive', 'punitive'],
    ['social', 'punitive', 'mixed'],
    ['punitive', 'social', 'mixed'],
    [null, 'social', 'mixed'],
    [null, null, 'mixed'],
  ];

  it.each(pairings)('(%s, %s) is attributed %s', (initiator, recipient, expected) => {
    expect(variantPairing(initiator, recipient)).toBe(expected);
  });

  it('warns once, and without the user it concerns, when an assignment is missing', () => {
    // Typed over `unknown` arguments: a pino `warn` call is `(fields, message)`, and the stub keeps
    // every recorded call inspectable without an `any`.
    const warn = vi.fn<(...args: unknown[]) => void>();
    const logger: Pick<Logger, 'warn'> = { warn };

    expect(variantPairing(null, 'social', logger)).toBe('mixed');

    expect(warn).toHaveBeenCalledTimes(1);
    const [payload] = warn.mock.calls[0] ?? [];
    expect(payload).toEqual({ event: 'experiment_assignment_missing' });
    expect(payload).not.toHaveProperty('userId');
    // Analytics identify users only by salted hash (AAP 0.12.2), so no id may reach the line.
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(UUID_SHAPE);
  });

  it('logs nothing when both assignments are present', () => {
    const warn = vi.fn<(...args: unknown[]) => void>();

    expect(variantPairing('punitive', 'punitive', { warn })).toBe('punitive');
    expect(warn).not.toHaveBeenCalled();
  });
});
