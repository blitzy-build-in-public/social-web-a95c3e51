/**
 * The Me routes end to end: `GET /me`, `POST /me/consents` and the age gate, `PUT /me/profile` with its photo processing, and
 * `POST /me/push-tokens`. Two rules the cases turn on: the 5 MiB photo cap is `me/photo.ts`'s own `413 photo_too_large`, inside the
 * route's larger body limit, and a push token belongs to the account that registered it and is never reassigned.
 */

import { randomBytes } from 'node:crypto';

import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  BIO_MAX_CHARS,
  HOME_CITY_MAX_CHARS,
  INTEREST_TAGS,
  INTEREST_TAGS_MAX,
  MeDto,
  NICKNAME_MAX_CHARS,
  PHOTO_MAX_BYTES,
  PROFILE_BODY_LIMIT_BYTES,
} from '@tablemate/shared';
import { decryptField } from '@tablemate/server-core';

import { createTestApp, type TestApp } from '../support/app.ts';
import {
  callRoute,
  expectError,
  keysDeep,
  makeProof,
  makeUser,
  rows,
  signIn,
  type RouteResponse,
  type UserFixture,
} from '../support/factories.ts';

let t: TestApp;

/** The address the real sign-in flow is walked with; every fixture address is under `example.test`. */
const SIGN_IN_EMAIL = 'me-1@example.test';

beforeAll(async () => {
  t = await createTestApp();
});

/** A fresh database, Redis and clock per case, then the five configured cities (AAP 0.5.2). */
beforeEach(async () => {
  await t.resetState();
  await t.seedCities();
});

afterAll(async () => {
  await t.close();
});

function traveler(): Promise<UserFixture> {
  return makeUser(t);
}

function putProfile(user: UserFixture, body: Record<string, unknown>): Promise<RouteResponse> {
  return callRoute(t.app, { method: 'PUT', url: '/v1/me/profile', as: user, body });
}

function registerPush(user: UserFixture, body: Record<string, unknown>): Promise<RouteResponse> {
  return callRoute(t.app, { method: 'POST', url: '/v1/me/push-tokens', as: user, body });
}

async function photoRow(
  userId: string,
): Promise<{ webp: Uint8Array; width: number; height: number }> {
  const row = await t.services.db.profilePhoto.findUnique({
    where: { userId },
    select: { webp: true, width: true, height: true },
  });
  if (row === null) {
    throw new Error('no profile photo row was stored');
  }
  return row;
}

async function disclosureRow(userId: string): Promise<{
  nickname: string | null;
  interestTags: string[];
  fullNameCiphertext: string | null;
  externalContactCiphertext: string | null;
}> {
  const row = await t.services.db.disclosureProfile.findUnique({
    where: { userId },
    select: {
      nickname: true,
      interestTags: true,
      fullNameCiphertext: true,
      externalContactCiphertext: true,
    },
  });
  if (row === null) {
    throw new Error('no disclosure profile row was stored');
  }
  return row;
}

const EXIF_MAKE = 'FixtureCam';
const EXIF_COPYRIGHT = 'Fixture Copyright';

/**
 * A 2400x1600 JPEG carrying IFD0 device tags and an IFD3 GPS position. The dimensions are past `PHOTO_MAX_EDGE_PX` (1,024) on the long edge,
 * so the stored image is proof that the resize ran, and the tags are the metadata the API must strip.
 */
function exifPhoto(): Promise<Buffer> {
  return sharp({
    create: { width: 2400, height: 1600, channels: 3, background: { r: 12, g: 120, b: 200 } },
  })
    .jpeg()
    .withExif({
      IFD0: { Make: EXIF_MAKE, Model: 'FixtureModel', Copyright: EXIF_COPYRIGHT },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '51/1 30/1 3230/100',
        GPSLongitudeRef: 'W',
        GPSLongitude: '0/1 7/1 4366/100',
      },
    })
    .toBuffer();
}

const NOT_A_PHOTO_BASE64 = Buffer.from(Array.from({ length: 64 }, (_, index) => index)).toString(
  'base64',
);

describe('GET /v1/me', () => {
  it('answers the signed-in caller’s own account and never their email address', async () => {
    const signedIn = await signIn(t, SIGN_IN_EMAIL);
    const response = await callRoute(t.app, {
      method: 'GET',
      url: '/v1/me',
      as: signedIn.accessToken,
    });
    expect(response.status).toBe(200);
    const raw: unknown = response.json();
    const dto = MeDto.parse(raw);
    expect(dto.id).toBe(signedIn.userId);
    expect(dto.handle).not.toBeNull();
    // The account's address reaches no schema, so no key path carries one and the raw body no value.
    expect(keysDeep(raw).filter((key) => /email/i.test(key))).toEqual([]);
    expect(response.body).not.toContain(SIGN_IN_EMAIL);
  });
  it('reports a fresh account as unverified, uncredited and with zero counters', async () => {
    const user = await traveler();
    const response = await callRoute(t.app, {
      method: 'GET',
      url: '/v1/me',
      as: user.accessToken,
    });
    expect(response.status).toBe(200);
    const dto = MeDto.parse(response.json());
    expect(dto.variant).not.toBeNull();
    expect(dto.consents).toEqual({
      ageConfirmedAt: t.clock.now().toISOString(),
      termsVersion: t.env.TERMS_VERSION,
    });
    expect(dto.proof).toEqual({ status: 'none' });
    // No proof anywhere, so nothing is entitled: the client shows the import banner and asks for no
    // city's traveler list (AAP 0.5.7, 0.5.8).
    expect(dto.validCityIds).toEqual([]);
    expect(dto.tableCreditCents).toBe(0);
    expect(dto.reputation).toEqual({
      witnessedMeetups: 0,
      distinctCounterparts: 0,
      distinctVenues: 0,
      distinctCities: 0,
      noShows90d: 0,
    });
    expect(dto.activeLodgingClaim).toBeNull();
    expect([dto.hasPhoto, dto.interestTags]).toEqual([false, []]);
  });

  it('names every city the caller holds a valid proof for once, in city-id order', async () => {
    const user = await traveler();
    // Two cities, a second valid stay in the first of them, and one that has already ended: the
    // entitlement is the two cities the caller holds a valid proof for now — one entry each,
    // ascending, whatever the order the proofs were written in — and not the third (AAP 0.5.7).
    await makeProof(t, user, { cityId: 'mexico-city' });
    await makeProof(t, user, { cityId: 'lisbon' });
    await makeProof(t, user, { cityId: 'lisbon' });
    await makeProof(t, user, { cityId: 'canggu', validNow: false });

    const response = await callRoute(t.app, {
      method: 'GET',
      url: '/v1/me',
      as: user.accessToken,
    });
    expect(response.status).toBe(200);
    const dto = MeDto.parse(response.json());

    expect(dto.validCityIds).toEqual(['lisbon', 'mexico-city']);
    // One city is nonetheless the stay `proof` reports: the payload names the city the caller may act
    // on, and the set names every city they may ask the traveler list about (AAP 0.5.4, 0.5.8).
    expect(dto.proof.status).toBe('valid');
    expect(dto.validCityIds).toContain(dto.proof.cityId);
  });
});

interface ConsentsRow {
  readonly name: string;
  readonly body: (termsVersion: string) => Record<string, unknown>;
}

const INVALID_CONSENTS_ROWS = rows<ConsentsRow>([
  {
    name: 'a terms version other than the one served',
    body: (termsVersion) => ({ adult: true, termsVersion: `${termsVersion}-previous` }),
  },
  { name: 'adult: false', body: (termsVersion) => ({ adult: false, termsVersion }) },
  { name: 'a missing adult confirmation', body: (termsVersion) => ({ termsVersion }) },
  {
    name: 'an extra key',
    body: (termsVersion) => ({ adult: true, termsVersion, marketingOptIn: true }),
  },
]);

describe('POST /v1/me/consents and the age gate', () => {
  it('keeps the traveler feature routes shut until the consents are recorded', async () => {
    const user = await makeUser(t, { consents: false });
    expectError(await putProfile(user, { nickname: 'Fixture Nick' }), 403, 'age_gate_required');
    expectError(
      await callRoute(t.app, { method: 'GET', url: '/v1/cities', as: user }),
      403,
      'age_gate_required',
    );
  });
  it.each(INVALID_CONSENTS_ROWS)('refuses $name with 400 invalid_field', async (row) => {
    const user = await makeUser(t, { consents: false });
    const response = await callRoute(t.app, {
      method: 'POST',
      url: '/v1/me/consents',
      as: user,
      body: row.body(t.env.TERMS_VERSION),
    });
    expectError(response, 400, 'invalid_field');
  });
  it('records the confirmation and opens the gate on the very next request', async () => {
    const user = await makeUser(t, { consents: false });
    const recorded = await callRoute(t.app, {
      method: 'POST',
      url: '/v1/me/consents',
      as: user,
      body: { adult: true, termsVersion: t.env.TERMS_VERSION },
    });
    expect(recorded.status).toBe(200);
    const dto = MeDto.parse(recorded.json());
    expect(dto.consents.termsVersion).toBe(t.env.TERMS_VERSION);
    expect(dto.consents.ageConfirmedAt).toBe(t.clock.now().toISOString());
    // No clock movement and no second sign-in: `recordConsents` dropped the session the refusing
    // requests above had cached, so the gate is open now (AAP 0.3.2).
    const cities = await callRoute(t.app, { method: 'GET', url: '/v1/cities', as: user });
    expect(cities.status).toBe(200);
  });
});

interface ProfileRow {
  readonly name: string;
  readonly body: Record<string, unknown>;
}

const INVALID_PROFILE_ROWS = rows<ProfileRow>([
  { name: 'an unknown key', body: { nope: 'x' } },
  { name: 'a tag outside the vocabulary', body: { interestTags: ['dancing'] } },
  {
    name: 'more than three tags',
    body: { interestTags: INTEREST_TAGS.slice(0, INTEREST_TAGS_MAX + 1) },
  },
  { name: 'a duplicated tag', body: { interestTags: ['food', 'coffee', 'food'] } },
  { name: 'a nickname of 41 characters', body: { nickname: 'n'.repeat(NICKNAME_MAX_CHARS + 1) } },
  { name: 'a bio of 281 characters', body: { bio: 'b'.repeat(BIO_MAX_CHARS + 1) } },
  { name: 'a home city of 81 characters', body: { homeCity: 'c'.repeat(HOME_CITY_MAX_CHARS + 1) } },
  { name: 'a lowercase country code', body: { homeCountryCode: 'pt' } },
  { name: 'a photo that is not an image', body: { photoBase64: NOT_A_PHOTO_BASE64 } },
]);

interface LimitRow {
  readonly name: string;
  readonly field: 'nickname' | 'bio' | 'homeCity' | 'interestTags';
  readonly limit: number;
}

const LIMIT_ROWS = rows<LimitRow>([
  { name: 'a nickname of 40 characters', field: 'nickname', limit: NICKNAME_MAX_CHARS },
  { name: 'a bio of 280 characters', field: 'bio', limit: BIO_MAX_CHARS },
  { name: 'a home city of 80 characters', field: 'homeCity', limit: HOME_CITY_MAX_CHARS },
  { name: 'exactly three distinct tags', field: 'interestTags', limit: INTEREST_TAGS_MAX },
]);

describe('PUT /v1/me/profile validation', () => {
  it.each(INVALID_PROFILE_ROWS)('refuses $name with 400 invalid_field', async (row) => {
    expectError(await putProfile(await traveler(), row.body), 400, 'invalid_field');
  });
  it.each(LIMIT_ROWS)('accepts $name', async (row) => {
    const atLimit =
      row.field === 'interestTags' ? INTEREST_TAGS.slice(0, row.limit) : 'x'.repeat(row.limit);
    const response = await putProfile(await traveler(), { [row.field]: atLimit });
    expect(response.status).toBe(200);
    expect(MeDto.parse(response.json())[row.field]).toEqual(atLimit);
  });
  it('refuses a photo over 5 MiB with 413 before the image is decoded', async () => {
    const oversized = randomBytes(PHOTO_MAX_BYTES + PHOTO_MAX_BYTES / 10).toString('base64');
    // Inside the route's own limit, so the 413 is `processPhoto`'s own cap, not the body limit.
    expect(oversized.length).toBeLessThan(PROFILE_BODY_LIMIT_BYTES);
    expectError(
      await putProfile(await traveler(), { photoBase64: oversized }),
      413,
      'photo_too_large',
    );
  });
});

describe('profile photo', () => {
  it('stores the upload as a WebP at the 1,024 px edge with every metadata block stripped', async () => {
    const user = await traveler();
    const jpeg = await exifPhoto();
    // The input is what makes the stripping observable: it carries the tags in its own bytes, and the
    // IFD0 `Make` tag is the string witness — an IFD3 GPS position is stored as rationals, so neither
    // buffer holds the text 'GPS' and only the metadata read can speak for it.
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    expect(jpeg.includes(Buffer.from(EXIF_MAKE))).toBe(true);
    const response = await putProfile(user, { photoBase64: jpeg.toString('base64') });
    expect(response.status).toBe(200);
    expect(MeDto.parse(response.json()).hasPhoto).toBe(true);
    const stored = await photoRow(user.id);
    const bytes = Buffer.from(stored.webp);
    const metadata = await sharp(bytes).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(1024);
    expect(metadata.height).toBe(683); // 2400x1600 scaled onto the long edge, aspect preserved
    expect(stored.width).toBe(1024);
    expect(stored.height).toBe(683);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.iptc).toBeUndefined();
    expect(bytes.includes(Buffer.from(EXIF_MAKE))).toBe(false);
    expect(bytes.includes(Buffer.from(EXIF_COPYRIGHT))).toBe(false);
  });
  it('removes the stored photo when the caller sends null', async () => {
    const user = await traveler();
    await putProfile(user, { photoBase64: (await exifPhoto()).toString('base64') });
    expect((await photoRow(user.id)).width).toBe(1024);
    const cleared = await putProfile(user, { photoBase64: null });
    expect(cleared.status).toBe(200);
    expect(MeDto.parse(cleared.json()).hasPhoto).toBe(false);
    expect(await t.services.db.profilePhoto.findUnique({ where: { userId: user.id } })).toBeNull();
  });
});

describe('tier fields and encryption', () => {
  it('echoes every field it writes and stores the tier-3 pair as ciphertext', async () => {
    const user = await traveler();
    const body = {
      nickname: 'Fixture Nick',
      bio: 'Fixture bio for the encryption case.',
      interestTags: ['food', 'art', 'hiking'],
      fullName: 'Fixture Full Name',
      externalContact: 'fixture-contact',
      homeCity: 'Fixture Home',
      homeCountryCode: 'BR',
    };
    const response = await putProfile(user, body);
    expect(response.status).toBe(200);
    const dto = MeDto.parse(response.json());
    expect(dto.nickname).toBe(body.nickname);
    expect(dto.bio).toBe(body.bio);
    expect(dto.interestTags).toEqual(body.interestTags);
    expect(dto.fullName).toBe(body.fullName);
    expect(dto.externalContact).toBe(body.externalContact);
    expect(dto.homeCity).toBe(body.homeCity);
    expect(dto.homeCountryCode).toBe(body.homeCountryCode);
    const row = await disclosureRow(user.id);
    const fullNameCiphertext = row.fullNameCiphertext;
    const contactCiphertext = row.externalContactCiphertext;
    if (fullNameCiphertext === null || contactCiphertext === null) {
      throw new Error('the tier-3 pair was not written');
    }
    expect(fullNameCiphertext).not.toContain(body.fullName);
    expect(contactCiphertext).not.toContain(body.externalContact);
    expect(decryptField(t.services.keyring, fullNameCiphertext)).toBe(body.fullName);
    expect(decryptField(t.services.keyring, contactCiphertext)).toBe(body.externalContact);
    expect(row.interestTags).toEqual(body.interestTags);
  });
  it('clears a field the caller sets to null, in the row and in the answer', async () => {
    const user = await traveler();
    await putProfile(user, { nickname: 'Fixture Nick', fullName: 'Fixture Full Name' });
    const cleared = await putProfile(user, { nickname: null, fullName: null });
    expect(cleared.status).toBe(200);
    const dto = MeDto.parse(cleared.json());
    expect(dto.nickname).toBeNull();
    expect(dto.fullName).toBeNull();
    const row = await disclosureRow(user.id);
    expect(row.nickname).toBeNull();
    expect(row.fullNameCiphertext).toBeNull();
  });
});

interface PushRow {
  readonly name: string;
  readonly body: Record<string, unknown>;
}

const INVALID_PUSH_ROWS = rows<PushRow>([
  { name: 'an unknown platform', body: { token: 'ExponentPushToken[fixture-1]', platform: 'web' } },
  { name: 'an empty token', body: { token: '', platform: 'ios' } },
  { name: 'a token of 201 characters', body: { token: 'x'.repeat(201), platform: 'android' } },
  {
    name: 'an extra key',
    body: { token: 'ExponentPushToken[fixture-2]', platform: 'ios', extra: true },
  },
]);

describe('POST /v1/me/push-tokens', () => {
  it('registers a device token once and refreshes it in place on a repeat registration', async () => {
    const user = await traveler();
    const token = 'ExponentPushToken[fixture-device-1]';
    expect((await registerPush(user, { token, platform: 'ios' })).status).toBe(204);
    expect((await registerPush(user, { token, platform: 'android' })).status).toBe(204);
    const stored = await t.services.db.pushToken.findMany({
      where: { token },
      select: { platform: true, userId: true },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.platform).toBe('android');
    expect(stored[0]?.userId).toBe(user.id);
  });
  it('refuses a token another account already owns', async () => {
    const owner = await traveler();
    const other = await traveler();
    const token = 'ExponentPushToken[fixture-device-2]';
    expect((await registerPush(owner, { token, platform: 'ios' })).status).toBe(204);
    // The refusal names neither the token nor an account (AAP 0.11.1).
    const refused = await registerPush(other, { token, platform: 'android' });
    expectError(refused, 400, 'invalid_field');
    expect(refused.body).not.toContain(token);
    expect(refused.body).not.toContain(owner.id);
    const stored = await t.services.db.pushToken.findMany({
      where: { token },
      select: { platform: true, userId: true },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.platform).toBe('ios');
    expect(stored[0]?.userId).toBe(owner.id);
  });
  it.each(INVALID_PUSH_ROWS)('refuses $name with 400 invalid_field', async (row) => {
    expectError(await registerPush(await traveler(), row.body), 400, 'invalid_field');
  });
});
