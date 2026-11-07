/**
 * Criterion 5 — field-level disclosure by tier (AAP 0.5.4, 0.5.7, 0.12.1, 0.12.2).
 *
 * One profile is requested by the same viewer as a stranger, after a locked meetup, after one
 * completed meetup and after two, and each answer is compared with the contract in four independent
 * ways, because each alone misses a different mistake: the parsed key set equals `TIER_FIELDS[tier]`;
 * every leaf path `keysDeep` finds hangs off one of those keys, so an object smuggled inside a
 * permitted field is caught too; the body parses through its own tier's shared schema and fails the
 * next tier's; and the raw text carries a distinctive marker for each field the tier releases, none
 * for a field it withholds, and none of the words of a column that must not travel at all.
 *
 * The tier each row reaches comes from the real rules rather than from an assertion about a fixture:
 * the arrangements write meetups through `../support/factories.ts` and `GET /users/:userId` reads
 * them through `disclosure/tier.ts`. Two properties are covered on purpose — an open dispute
 * postpones settlement and leaves the meetup `locked`, so its pair keeps tier 1 (AAP 0.5.3), and two
 * completed meetups reach tier 3 however closely they are spaced, because the anti-farming window
 * limits the reputation counters and the leaderboard only (AAP 0.5.7, 0.7.3). Every refusal is
 * asserted on the route's one code, `404 user_not_found`, so a block in either direction, an erased
 * account, a deletion-requested account and an unknown id are indistinguishable to the caller.
 *
 * The photo bytes are read from `app.inject`'s `rawPayload`, because `callRoute` answers a
 * utf8-decoded string, which cannot carry binary.
 *
 * @see AAP 0.5.4 for the two routes, their errors and the three disclosure layers, 0.5.7 for the tier
 *   and anti-farming rules, 0.5.2 for the photo, the markers and the tombstone, 0.11.2 for the
 *   harness, 0.12.1 for the criterion this file measures, 0.12.2 for the constraint it enforces, and
 *   0.8.1 for this file.
 */

import { randomUUID } from 'node:crypto';

import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DAY_MS, PHOTO_MIN_TIER, PROFILE_SCHEMA_BY_TIER, TIER_FIELDS } from '@tablemate/shared';
import type { DisclosureTier, MeetupStatus } from '@tablemate/shared';

import { createTestApp } from '../support/app.ts';
import {
  callRoute,
  expectError,
  keysDeep,
  makeBlock,
  makeDispute,
  makeMeetup,
  makeProof,
  makeUser,
  makeVenue,
  rows,
  stripeModeLabel,
} from '../support/factories.ts';

import type { TestApp } from '../support/app.ts';
import type { MeetupFixture, RouteResponse, UserFixture } from '../support/factories.ts';

/** The launch city every fixture is proved for and every venue stands in (`config/cities.json`). */
const CITY = 'lisbon';

/**
 * The distinctive values the target fills in through `PUT /me/profile`, each a string that occurs in
 * no other field, so finding it in the raw text proves the field travelled and not finding it proves
 * it did not. The tags come from the shared vocabulary, and three is `INTEREST_TAGS_MAX`.
 */
const NICKNAME = 'NickMarker';
const BIO = 'BioMarker';
const FULL_NAME = 'FullNameMarker';
const EXTERNAL_CONTACT = 'ContactMarker';

/**
 * Which tier's release each marker belongs to (AAP 0.5.4 `TIER_ADDED_FIELDS`). Tier 0 adds identity
 * and reputation and tier 2 a boolean, so neither has one; the key-set and schema comparisons cover
 * those two tiers.
 */
const MARKERS_BY_TIER = {
  1: [NICKNAME, BIO],
  3: [FULL_NAME, EXTERNAL_CONTACT],
} as const satisfies Readonly<Partial<Record<DisclosureTier, readonly string[]>>>;

/** What the target sends as its own profile, before the photo is attached. */
const TARGET_PROFILE = {
  nickname: NICKNAME,
  bio: BIO,
  fullName: FULL_NAME,
  externalContact: EXTERNAL_CONTACT,
  interestTags: ['coffee', 'markets', 'surfing'],
} as const;

/** The words of the columns a profile response must never carry, at any tier (AAP 0.5.2, 0.12.2). */
const FORBIDDEN_SUBSTRINGS = ['ciphertext', 'email', 'webp'] as const;

/** The two fields whose values are assembled rather than read from a column (AAP 0.5.4). */
const NESTED_FIELDS: readonly string[] = ['reputation', 'proofDates'];

/** The app every case drives, built once (AAP 0.11.2). */
let t: TestApp;

/** The base64 PNG the target uploads; the route re-encodes it, so it never reaches a response. */
let uploadedPhoto = '';

/**
 * One traveler's profile as `viewer` sees it (AAP 0.5.4). The route answers `404 user_not_found` for
 * every reason it refuses, so a caller asserts the code rather than the cause.
 */
async function getProfile(viewer: UserFixture, targetId: string): Promise<RouteResponse> {
  return callRoute(t.app, {
    method: 'GET',
    url: `/v1/users/${targetId}`,
    as: await t.tokenFor(viewer),
  });
}

/** One injected answer carrying bytes, which a `RouteResponse` alone cannot (see the header). */
interface PhotoResponse extends RouteResponse {
  readonly bytes: Buffer;
}

/** One traveler's stored photo as `viewer` asks for it (AAP 0.5.4). */
async function getPhoto(viewer: UserFixture, targetId: string): Promise<PhotoResponse> {
  const injected = await t.app.inject({
    method: 'GET',
    url: `/v1/users/${targetId}/photo`,
    headers: { authorization: `Bearer ${await t.tokenFor(viewer)}` },
  });

  return {
    status: injected.statusCode,
    body: injected.body,
    headers: injected.headers,
    bytes: injected.rawPayload,
    json: <T = unknown>() => JSON.parse(injected.body) as T,
  };
}

/** One response header as a string, or `''` when the route sent none. */
function headerOf(response: RouteResponse, name: string): string {
  const value = response.headers[name];
  return typeof value === 'string' ? value : '';
}

/**
 * The pair a case is about: a viewer and a target, both consented travelers with a valid `lisbon`
 * proof, the target's profile filled in through the real route, so every marker is stored by the code
 * that serves it. `withPhoto: false` leaves the target without one, which the photo route must refuse
 * at tier 2; no case writes a `ProfilePhoto` row by hand.
 */
async function pair(
  options: { readonly withPhoto?: boolean } = {},
): Promise<{ viewer: UserFixture; target: UserFixture }> {
  const viewer = await makeUser(t);
  const target = await makeUser(t);
  await makeProof(t, viewer, { cityId: CITY });
  await makeProof(t, target, { cityId: CITY });

  const response = await callRoute(t.app, {
    method: 'PUT',
    url: '/v1/me/profile',
    as: await t.tokenFor(target),
    body:
      options.withPhoto === false
        ? { ...TARGET_PROFILE }
        : { ...TARGET_PROFILE, photoBase64: uploadedPhoto },
  });
  expect(response.status, `PUT /v1/me/profile answered ${response.status}: ${response.body}`).toBe(
    200,
  );

  return { viewer, target };
}

/** One meetup of the pair in `status`, at a partner venue in the suite's city (AAP 0.5.3). */
async function meetupOf(
  viewer: UserFixture,
  target: UserFixture,
  status: MeetupStatus,
  startsAt?: Date,
): Promise<MeetupFixture> {
  const venue = await makeVenue(t, { cityId: CITY });

  return makeMeetup(t, {
    status,
    initiator: viewer,
    recipient: target,
    venue,
    ...(startsAt === undefined ? {} : { startsAt }),
  });
}

/** What a row does to the pair before it reads the profile. */
type Arrange = (viewer: UserFixture, target: UserFixture) => Promise<void>;

/** No meetup at all: the stranger's view, tier 0. */
const STRANGER: Arrange = () => Promise.resolve();

/** A shared locked meetup with both deposits `held`: tier 1 (AAP 0.5.7). */
const LOCKED: Arrange = async (viewer, target) => {
  await meetupOf(viewer, target, 'locked');
};

/** An open dispute postpones settlement and leaves the meetup `locked`, so its pair is still 1. */
const LOCKED_WITH_DISPUTE: Arrange = async (viewer, target) => {
  const meetup = await meetupOf(viewer, target, 'locked');
  await makeDispute(t, meetup, viewer);
};

/** A proposal the recipient has not locked, so not a locked meetup: tier 0 (AAP 0.5.3). */
const PROPOSED: Arrange = async (viewer, target) => {
  await meetupOf(viewer, target, 'proposed');
};

/** The other half of the tier-1 rule: a locked meetup whose recipient deposit is not held is 0. */
const LOCKED_RECIPIENT_NOT_HELD: Arrange = async (viewer, target) => {
  const venue = await makeVenue(t, { cityId: CITY });
  await makeMeetup(t, {
    status: 'locked',
    initiator: viewer,
    recipient: target,
    venue,
    deposits: { recipient: 'released' },
  });
};

/** One completed meetup: tier 2 (AAP 0.5.7). */
const COMPLETED_ONCE: Arrange = async (viewer, target) => {
  await meetupOf(viewer, target, 'completed');
};

/**
 * Two completed meetups a day apart: tier 3. The spacing is inside the anti-farming window on
 * purpose — `PairHistory.completedCount` counts both anyway, because that rule limits the reputation
 * counters and the leaderboard only (AAP 0.5.7, 0.7.3).
 */
const COMPLETED_TWICE: Arrange = async (viewer, target) => {
  await meetupOf(viewer, target, 'completed');
  await meetupOf(viewer, target, 'completed', new Date(t.time.now().getTime() - DAY_MS));
};

/**
 * One row of the criterion-5 table: the arrangement, the tier that must follow, and the label the
 * report prints. The tier precedes the arrangement so the title's placeholders read the row in order.
 */
type TierRow = readonly [label: string, tier: DisclosureTier, arrange: Arrange];

/**
 * The four tiers, with a locked meetup carrying an open dispute and a locked meetup missing a held
 * deposit as the boundary cases of the tier-1 and tier-0 rules.
 */
const TIER_ROWS: readonly TierRow[] = rows<TierRow>([
  ['a stranger', 0, STRANGER],
  ['a shared locked meetup with both deposits held', 1, LOCKED],
  ['a shared locked meetup with an open dispute', 1, LOCKED_WITH_DISPUTE],
  ['a proposal the recipient has not locked', 0, PROPOSED],
  ['a locked meetup whose recipient deposit is not held', 0, LOCKED_RECIPIENT_NOT_HELD],
  ['one completed meetup', 2, COMPLETED_ONCE],
  ['two completed meetups', 3, COMPLETED_TWICE],
]);

/** The marker fields a viewer at `tier` must receive, read from the one table above. */
function markersAtMost(tier: DisclosureTier): string[] {
  return Object.entries(MARKERS_BY_TIER)
    .filter(([added]) => Number(added) <= tier)
    .flatMap(([, markers]) => [...markers]);
}

/** The marker fields a viewer at `tier` must not receive. */
function markersAbove(tier: DisclosureTier): string[] {
  return Object.entries(MARKERS_BY_TIER)
    .filter(([added]) => Number(added) > tier)
    .flatMap(([, markers]) => [...markers]);
}

/** A leaf path's segments, with the `[]` `keysDeep` writes for a list element taken off. */
function segmentsOf(path: string): string[] {
  return path.replaceAll('[]', '').split('.');
}

describe(`field-level disclosure by tier ${stripeModeLabel()}`, () => {
  beforeAll(async () => {
    t = await createTestApp();
    // A real image, built rather than committed: the profile route decodes it and stores a WebP
    // re-encode, so the bytes the photo route serves are never the ones uploaded (AAP 0.5.2).
    uploadedPhoto = (
      await sharp({
        create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 60, b: 100 } },
      })
        .png()
        .toBuffer()
    ).toString('base64');
  });

  afterAll(async () => {
    if (t !== undefined) {
      await t.close();
    }
  });

  beforeEach(async () => {
    await t.resetState();
    await t.seedCities();
  });

  describe('GET /users/:userId', () => {
    it.each(TIER_ROWS)('%s answers the tier %i field set', async (_label, tier, arrange) => {
      const { viewer, target } = await pair();
      await arrange(viewer, target);

      const response = await getProfile(viewer, target.id);
      expect(response.status, `GET /v1/users/:userId answered ${response.status}`).toBe(200);

      const body = response.json<Record<string, unknown>>();

      // The key set is the tier's own list, so a field above the tier fails here whether it arrived
      // alone or beside the right ones (AAP 0.5.4).
      expect(Object.keys(body).sort()).toEqual([...TIER_FIELDS[tier]].sort());

      // Every leaf path hangs off one of those keys, so an object smuggled inside a permitted field
      // is caught too, and only the two assembled fields nest (AAP 0.5.4).
      const roots = new Set<string>(TIER_FIELDS[tier]);
      for (const path of keysDeep(body)) {
        const [root = '', ...nested] = segmentsOf(path);
        expect(roots.has(root), `${path} is not a field of tier ${tier}`).toBe(true);
        if (nested.length > 0) {
          expect(NESTED_FIELDS.includes(root), `${path} nests outside the assembled fields`).toBe(
            true,
          );
        }
      }

      // The payload satisfies its own tier's shared schema and cannot satisfy the next tier's, which
      // is what keeps the API's field lists and `packages/shared` from drifting (AAP 0.5.4).
      const parsed = PROFILE_SCHEMA_BY_TIER[tier].safeParse(body).success;
      expect(parsed, `the payload is not a tier ${tier} profile`).toBe(true);
      if (tier !== 3) {
        const above = PROFILE_SCHEMA_BY_TIER[(tier + 1) as DisclosureTier];
        expect(
          above.safeParse(body).success,
          `a tier ${tier} payload carries tier ${tier + 1}`,
        ).toBe(false);
      }

      // The released fields' markers are in the raw text and no withheld field's is, and the response
      // carries no word of a column that must not travel at any tier (criterion 5, AAP 0.12.2).
      const raw = response.body;
      const findings = {
        missing: markersAtMost(tier).filter((marker) => !raw.includes(marker)),
        leaked: markersAbove(tier).filter((marker) => raw.includes(marker)),
        forbidden: FORBIDDEN_SUBSTRINGS.filter((word) => raw.toLowerCase().includes(word)),
      };
      expect(findings, 'a marker is missing or leaked').toEqual({
        missing: [],
        leaked: [],
        forbidden: [],
      });

      // The photo is released from `PHOTO_MIN_TIER` up as its presence alone, and this target has
      // one: so the tier that may know says so, and the tiers below never hear of it (AAP 0.5.4).
      if (tier >= PHOTO_MIN_TIER) {
        expect(body['hasPhoto'], 'the profile does not report the photo the target stored').toBe(
          true,
        );
      }
    });

    describe('not found', () => {
      /** One refusal row: what it arranges, and the id the profile read then names. */
      type NotFoundRow = readonly [
        label: string,
        arrange: (viewer: UserFixture, target: UserFixture) => Promise<string>,
      ];

      /** Name the target once account deletion's write fence flag is set (AAP 0.5.2, 0.5.3). */
      async function unservable(
        target: UserFixture,
        stage: 'request' | 'erasure',
      ): Promise<string> {
        const now = t.time.now();
        await t.services.db.user.update({
          where: { id: target.id },
          data: stage === 'request' ? { deletionRequestedAt: now } : { deletedAt: now },
        });
        return target.id;
      }

      /**
       * Every way a profile must not be served: a block in either direction, the two flags account
       * deletion leaves, and an id no account holds. The route answers one code for all of them, so
       * no caller can tell which applies (AAP 0.5.3, 0.5.4).
       */
      const NOT_FOUND_ROWS: readonly NotFoundRow[] = rows<NotFoundRow>([
        [
          'the target blocked the viewer',
          async (viewer, target) => {
            await makeBlock(t, target, viewer);
            return target.id;
          },
        ],
        [
          'the viewer blocked the target',
          async (viewer, target) => {
            await makeBlock(t, viewer, target);
            return target.id;
          },
        ],
        ['the target erased its account', (_v, target) => unservable(target, 'erasure')],
        ['the target requested deletion', (_v, target) => unservable(target, 'request')],
        ['an id no account holds', () => Promise.resolve(randomUUID())],
      ]);

      it.each(NOT_FOUND_ROWS)('%s answers 404 user_not_found', async (_label, arrange) => {
        const { viewer, target } = await pair();

        expectError(await getProfile(viewer, await arrange(viewer, target)), 404, 'user_not_found');
      });
    });
  });

  describe('GET /users/:userId/photo', () => {
    /**
     * The tiers the gate refuses, each with the arrangement that reaches it: both are below
     * `PHOTO_MIN_TIER`, and the pair shares a locked meetup at tier 1, so what refuses the request is
     * the gate and not the absence of a history (AAP 0.5.4).
     */
    const REFUSAL_ROWS: readonly (readonly [string, Arrange])[] = rows<readonly [string, Arrange]>([
      ['a stranger at tier 0', STRANGER],
      ['a shared locked meetup at tier 1', LOCKED],
    ]);

    it('has one refusal row per tier below the photo gate', () => {
      expect(REFUSAL_ROWS.length).toBe(PHOTO_MIN_TIER);
    });

    it.each(REFUSAL_ROWS)('%s answers 404 user_not_found', async (_label, arrange) => {
      const { viewer, target } = await pair();
      await arrange(viewer, target);

      expectError(await getPhoto(viewer, target.id), 404, 'user_not_found');
    });

    it('serves the stored WebP to a viewer at the gate, and nothing cacheable', async () => {
      const { viewer, target } = await pair();
      await COMPLETED_ONCE(viewer, target);

      const photo = await getPhoto(viewer, target.id);
      expect(photo.status, `GET /v1/users/:userId/photo answered ${photo.status}`).toBe(200);
      expect(headerOf(photo, 'content-type')).toBe('image/webp');
      expect(headerOf(photo, 'cache-control')).toContain('no-store');

      // The bytes are the WebP the route re-encoded and stored, the only copy the server holds; the
      // uploaded PNG is never what a viewer receives (AAP 0.5.2).
      const stored = await t.services.db.profilePhoto.findUniqueOrThrow({
        where: { userId: target.id },
        select: { webp: true },
      });
      expect(
        photo.bytes.equals(Buffer.from(stored.webp)),
        'the bytes are not the stored WebP',
      ).toBe(true);
    });

    it('answers 404 for a tier-2 target with no photo', async () => {
      const { viewer, target } = await pair({ withPhoto: false });
      await COMPLETED_ONCE(viewer, target);

      expectError(await getPhoto(viewer, target.id), 404, 'user_not_found');
    });

    it('answers 404 for a blocked pair whose history is at the gate', async () => {
      const { viewer, target } = await pair();
      await COMPLETED_ONCE(viewer, target);
      await makeBlock(t, target, viewer);

      expectError(await getPhoto(viewer, target.id), 404, 'user_not_found');
    });
  });
});
