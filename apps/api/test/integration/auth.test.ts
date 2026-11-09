/**
 * The four `/auth` routes, the session lifetime, the age gate's scope and the health probe.
 *
 * Three properties the cases are built around: a known address and an unknown one are answered identically, so nothing is enumerated; a rotated
 * refresh token presented again revokes the account's whole session family; and the age gate covers the traveler feature routes and nothing else.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ACCESS_TOKEN_TTL_MINUTES,
  HealthResponse,
  MAGIC_LINK_MAX_PER_EMAIL_PER_HOUR,
  MAGIC_LINK_TTL_MINUTES,
  MeDto,
  MINUTE_MS,
  REFRESH_TOKEN_TTL_DAYS,
  RefreshResponse,
  VerifyResponse,
  ZkConfig,
} from '@tablemate/shared';
import { decryptField, emailLookupHash, randomToken, sha256Hex } from '@tablemate/server-core';

import { HANDLE_PATTERN } from '../../src/modules/auth/handles.ts';
import { callRoute, expectError, makeUser, rows, signIn } from '../support/factories.ts';
import { createTestApp } from '../support/app.ts';

import type { RouteResponse } from '../support/factories.ts';
import type { TestApp } from '../support/app.ts';

let t: TestApp;

let generatedEmails = 0;

/**
 * A fresh address under `example.test`, the TLD reserved for documentation: no case can reach an
 * account another one created, and no message is ever addressable.
 */
function testEmail(): string {
  generatedEmails += 1;
  return `auth-${generatedEmails}@example.test`;
}

beforeAll(async () => {
  t = await createTestApp();
});

beforeEach(async () => {
  await t.resetState();
  await t.seedCities();
});

afterAll(async () => {
  await t.close();
});

interface LinkRow {
  readonly id: string;
  readonly tokenHash: string;
  readonly emailCiphertext: string;
  readonly deliveryTokenCiphertext: string | null;
  readonly emailLookupHash: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

function linkRows(email: string): Promise<LinkRow[]> {
  return t.services.db.magicLinkToken.findMany({
    where: { emailLookupHash: emailLookupHash(t.env.EMAIL_LOOKUP_PEPPER, email) },
    orderBy: { createdAt: 'asc' },
  });
}

function postMagicLink(email: string): Promise<RouteResponse> {
  return callRoute(t.app, { method: 'POST', url: '/v1/auth/magic-link', body: { email } });
}

/**
 * Request one magic link for `email` and answer with the row that request wrote. The new row is identified by what the request added rather than by
 * `createdAt` order: that column is the database's own `now()`, so two requests of one case can land in the same microsecond.
 */
async function requestLink(email: string): Promise<LinkRow> {
  const before = new Set((await linkRows(email)).map((row) => row.id));
  const response = await postMagicLink(email);
  expect(response.status).toBe(202);
  // No body at all, which is what makes a known address and an unknown one indistinguishable.
  expect(response.body).toBe('');
  const [row] = (await linkRows(email)).filter((candidate) => !before.has(candidate.id));
  if (row === undefined) throw new Error('the magic-link request wrote no row');
  return row;
}

function deliveryCiphertext(row: LinkRow): string {
  const ciphertext = row.deliveryTokenCiphertext;
  if (ciphertext === null) {
    throw new Error('the magic-link row holds no delivery token: it was sent, or cleared unsent');
  }
  return ciphertext;
}

/**
 * The raw token the mailer would have sent, decrypted exactly as `jobs/notifications.ts` decrypts it — the value never exists on the server outside
 * the ciphertext this reads it from.
 */
function deliveryToken(row: LinkRow): string {
  return decryptField(t.services.keyring, deliveryCiphertext(row));
}

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  const [first] = items;
  if (first === undefined) throw new Error('the query answered no row');
  return first;
}

function get(url: string, as?: string): Promise<RouteResponse> {
  return callRoute(t.app, { method: 'GET', url, ...(as === undefined ? {} : { as }) });
}

function postVerify(token: string): Promise<RouteResponse> {
  return callRoute(t.app, { method: 'POST', url: '/v1/auth/verify', body: { token } });
}

function postRefresh(refreshToken: string): Promise<RouteResponse> {
  return callRoute(t.app, { method: 'POST', url: '/v1/auth/refresh', body: { refreshToken } });
}

/**
 * Bodies `POST /auth/magic-link` must refuse, each answered `400 invalid_email`: the route maps any parse failure of its body to that one code, so a
 * caller cannot learn which part of an address the server disliked. 254 characters is the SMTP limit on a full address.
 */
const INVALID_ADDRESS_ROWS: readonly (readonly [string, object])[] = [
  ['a string that is not an address', { email: 'not-an-email' }],
  ['an empty address', { email: '' }],
  ['an address over the 254-character limit', { email: `${'a'.repeat(300)}@example.test` }],
  ['a body without the address key', {}],
];

/**
 * Bodies `POST /auth/verify` refuses before the service behind it sees them. `VerifyRequest` takes a token of 1 to 512 characters, so an empty or
 * absurd one is a malformed body and never reaches the `401 token_invalid` the route answers for a token that is unknown, expired or already used.
 */
const MALFORMED_TOKEN_ROWS: readonly (readonly [string, object])[] = [
  ['an empty token', { token: '' }],
  ['a token over the 512-character limit', { token: 'x'.repeat(600) }],
];

describe('POST /v1/auth/magic-link', () => {
  it('answers 202 with no body for a known address and an unknown one alike', async () => {
    const known = testEmail();
    await signIn(t, known);
    const knownAnswer = await postMagicLink(known);
    const unknownAnswer = await postMagicLink(testEmail());
    // Identical status and identical body: the two answers are what an enumeration check reads
    // (AAP 0.5.4). A link is written and queued for both.
    expect(knownAnswer.status).toBe(202);
    expect(unknownAnswer.status).toBe(202);
    expect(knownAnswer.body).toBe('');
    expect(unknownAnswer.body).toBe('');
    expect(await t.services.db.magicLinkToken.count()).toBe(3);
  });
  it.each(rows(INVALID_ADDRESS_ROWS))('answers 400 invalid_email for %s', async (_case, body) => {
    const response = await callRoute(t.app, {
      method: 'POST',
      url: '/v1/auth/magic-link',
      body,
    });
    expectError(response, 400, 'invalid_email');
  });
  it('refuses a sixth link request for one address inside the hour', async () => {
    const email = testEmail();
    for (let request = 0; request < MAGIC_LINK_MAX_PER_EMAIL_PER_HOUR; request += 1) {
      expect((await postMagicLink(email)).status).toBe(202);
    }
    const refused = await postMagicLink(email);
    expectError(refused, 429, 'rate_limited');
    // The refusal carries the window, so the caller learns when to come back.
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // It ran before the handler: the refused request wrote no row of its own.
    expect(await linkRows(email)).toHaveLength(MAGIC_LINK_MAX_PER_EMAIL_PER_HOUR);
    // The counter is the address's, not the origin's: another address still gets its link.
    expect((await postMagicLink(testEmail())).status).toBe(202);
  });
  it('stores the address and the token transformed, and queues the link for the mailer', async () => {
    const email = testEmail();
    const requestedAt = t.time.now();
    const row = await requestLink(email);
    const ciphertext = deliveryCiphertext(row);
    const token = deliveryToken(row);
    expect(row.tokenHash).toBe(sha256Hex(token));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.emailLookupHash).toBe(emailLookupHash(t.env.EMAIL_LOOKUP_PEPPER, email));
    expect(row.expiresAt.getTime()).toBe(
      requestedAt.getTime() + MAGIC_LINK_TTL_MINUTES * MINUTE_MS,
    );
    expect(row.usedAt).toBeNull();
    // The address and the token reach the database only as ciphertext (AAP 0.5.2).
    for (const stored of [row.emailCiphertext, ciphertext]) {
      expect(stored).not.toContain(email);
      expect(stored).not.toContain(token);
    }
    // One outbox row per request, carrying the token row's id and nothing else (AAP 0.3.2). What the
    // case asserts is what the row holds: whether the dispatcher has already published it by the
    // time this reads it depends on the pass `transact` kicks after every commit, so `dispatchedAt`
    // is deliberately not asserted here.
    const message = only(await t.services.db.outboxMessage.findMany());
    expect(message.kind).toBe('notification');
    expect(message.payload).toEqual({ kind: 'magic_link', magicLinkTokenId: row.id });
    const payload = JSON.stringify(message.payload);
    expect(payload).not.toContain(email);
    expect(payload).not.toContain(token);
  });
  it('drops the write for an account that has requested deletion, and serves the next address', async () => {
    const deleting = testEmail();
    const signedIn = await signIn(t, deleting);
    await t.services.db.user.update({
      where: { id: signedIn.userId },
      data: { deletionRequestedAt: t.time.now() },
    });
    const written = (await linkRows(deleting)).map((row) => row.id);
    const queued = await t.services.db.outboxMessage.count();
    // The same bare `202` an unknown address gets: the write fence is a dropped write and never a
    // refusal, so a caller cannot tell this address from one with no account (AAP 0.5.3, 0.5.4).
    const answer = await postMagicLink(deleting);
    expect(answer.status).toBe(202);
    expect(answer.body).toBe('');
    // Neither the row holding the address's ciphertext and lookup hash nor the outbox row that would
    // mail its link: the ciphertext stays out of a table the erasure job does not reach (AAP 0.5.2,
    // 0.5.3).
    expect((await linkRows(deleting)).map((row) => row.id)).toEqual(written);
    expect(await t.services.db.outboxMessage.count()).toBe(queued);
    // The fence belongs to that one address: the next one still gets its row and its outbox row.
    const fresh = await requestLink(testEmail());
    const messages = await t.services.db.outboxMessage.findMany();
    expect(messages).toHaveLength(queued + 1);
    expect(messages.map((message) => message.payload)).toContainEqual({
      kind: 'magic_link',
      magicLinkTokenId: fresh.id,
    });
  });
});

describe('POST /v1/auth/verify', () => {
  it("creates the account on first use and answers with the caller's own profile", async () => {
    const email = testEmail();
    const row = await requestLink(email);
    const verifiedAt = t.time.now();
    const response = await postVerify(deliveryToken(row));
    expect(response.status).toBe(200);
    const session = VerifyResponse.parse(response.json());
    MeDto.parse(session.user);
    // The caller's own profile is the one payload that carries tier-3 fields, and it carries no
    // address: the account's address stays on the server (AAP 0.5.2, 0.5.4).
    expect(Object.keys(session.user)).not.toContain('email');
    expect(response.body).not.toContain(email);
    const user = only(await t.services.db.user.findMany());
    expect(user.id).toBe(session.user.id);
    expect(user.role).toBe('traveler');
    expect(user.handle).toMatch(HANDLE_PATTERN);
    expect(user.avatarSeed).toMatch(/^[0-9a-f]{32}$/);
    expect(user.emailLookupHash).toBe(emailLookupHash(t.env.EMAIL_LOOKUP_PEPPER, email));
    // Signing in does not pass the age gate: the consents are recorded on their own route.
    expect(user.ageConfirmedAt).toBeNull();
    expect(user.termsVersion).toBeNull();
    expect(session.user.consents.ageConfirmedAt).toBeNull();
    // One variant, assigned once, and the signup measure the dashboard reads (AAP 0.5.7).
    expect(only(await t.services.db.experimentAssignment.findMany()).userId).toBe(user.id);
    const created = only(await t.services.db.analyticsEvent.findMany());
    expect(created.name).toBe('account_created');
    expect(created.actorHash).not.toBeNull();
    // One session, and the link is spent at the instant the injected clock reads.
    expect(only(await t.services.db.session.findMany()).userId).toBe(user.id);
    const consumed = only(await linkRows(email));
    expect(consumed.id).toBe(row.id);
    expect(consumed.usedAt?.getTime()).toBe(verifiedAt.getTime());
  });
  it('opens a further session for a returning address, and creates nothing else', async () => {
    const email = testEmail();
    const first = await signIn(t, email);
    const second = await signIn(t, email);
    expect(second.userId).toBe(first.userId);
    expect(await t.services.db.user.count()).toBe(1);
    expect(await t.services.db.experimentAssignment.count()).toBe(1);
    expect(await t.services.db.analyticsEvent.count({ where: { name: 'account_created' } })).toBe(
      1,
    );
    // Two verifies, two sessions: the account, its variant and its signup event are first-use only.
    expect(await t.services.db.session.count()).toBe(2);
  });
  it('refuses a token it has already consumed', async () => {
    const token = deliveryToken(await requestLink(testEmail()));
    expect((await postVerify(token)).status).toBe(200);
    expectError(await postVerify(token), 401, 'token_invalid');
  });
  it('accepts a token inside its 15-minute window and refuses it past the window', async () => {
    const inside = deliveryToken(await requestLink(testEmail()));
    t.time.advance({ minutes: MAGIC_LINK_TTL_MINUTES - 1 });
    expect((await postVerify(inside)).status).toBe(200);
    const past = deliveryToken(await requestLink(testEmail()));
    t.time.advance({ minutes: MAGIC_LINK_TTL_MINUTES, seconds: 1 });
    expectError(await postVerify(past), 401, 'token_invalid');
  });
  it('refuses a token it never issued', async () => {
    expectError(await postVerify(randomToken()), 401, 'token_invalid');
  });
  it.each(rows(MALFORMED_TOKEN_ROWS))('answers 400 invalid_field for %s', async (_case, body) => {
    const response = await callRoute(t.app, { method: 'POST', url: '/v1/auth/verify', body });
    expectError(response, 400, 'invalid_field');
  });
  it('refuses a sign-in for an account that has requested deletion', async () => {
    const email = testEmail();
    const signedIn = await signIn(t, email);
    // Requested while the account may still be written to: past the next line the request path drops
    // the write under the same fence, which the dropped-write case above pins (AAP 0.5.3).
    const row = await requestLink(email);
    await t.services.db.user.update({
      where: { id: signedIn.userId },
      data: { deletionRequestedAt: t.time.now() },
    });
    expectError(await postVerify(deliveryToken(row)), 401, 'token_invalid');
    // The refusal rolled its consumption back, so nothing the fence refused was written (AAP 0.5.3).
    const refused = await t.services.db.magicLinkToken.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(refused.usedAt).toBeNull();
  });
});

describe('POST /v1/auth/refresh and POST /v1/auth/logout', () => {
  /**
   * The two ways a bearer-authenticated read is refused: no `Authorization` header at all, and a
   * header whose credential is not a token this process signed.
   */
  const BEARER_REFUSAL_ROWS: readonly (readonly [string, string | undefined])[] = [
    ['an absent Authorization header', undefined],
    ['a bearer that is not a token', 'garbage'],
  ];
  it('rotates the pair and serves the rotated access token', async () => {
    const signedIn = await signIn(t, testEmail());
    const rotated = await postRefresh(signedIn.refreshToken);
    expect(rotated.status).toBe(200);
    const pair = RefreshResponse.parse(rotated.json());
    expect(pair.accessToken).not.toBe(signedIn.accessToken);
    expect(pair.refreshToken).not.toBe(signedIn.refreshToken);
    expect((await get('/v1/me', pair.accessToken)).status).toBe(200);
  });
  it('revokes the whole session family when a rotated token is presented again', async () => {
    const signedIn = await signIn(t, testEmail());
    const pair = RefreshResponse.parse((await postRefresh(signedIn.refreshToken)).json());
    // The successor is the live session until the reuse is seen (AAP 0.11.2).
    expect((await get('/v1/me', pair.accessToken)).status).toBe(200);
    expectError(await postRefresh(signedIn.refreshToken), 401, 'token_invalid');
    // The successor went with it, refresh token and access token both.
    expectError(await postRefresh(pair.refreshToken), 401, 'token_invalid');
    expectError(await get('/v1/me', pair.accessToken), 401, 'token_invalid');
  });
  it('refuses an unknown refresh token', async () => {
    expectError(await postRefresh(randomToken()), 401, 'token_invalid');
  });
  it('refuses a refresh token past its 30-day lifetime', async () => {
    const signedIn = await signIn(t, testEmail());
    t.time.advance({ days: REFRESH_TOKEN_TTL_DAYS, minutes: 1 });
    expectError(await postRefresh(signedIn.refreshToken), 401, 'token_invalid');
  });
  it('ends the session at once on logout', async () => {
    const signedIn = await signIn(t, testEmail());
    const loggedOut = await callRoute(t.app, {
      method: 'POST',
      url: '/v1/auth/logout',
      as: signedIn.accessToken,
    });
    expect(loggedOut.status).toBe(204);
    expectError(await get('/v1/me', signedIn.accessToken), 401, 'token_invalid');
    expectError(await postRefresh(signedIn.refreshToken), 401, 'token_invalid');
  });
  it('refuses an access token once its 15 minutes have passed, and re-signs a working one', async () => {
    const signedIn = await signIn(t, testEmail());
    t.time.advance({ minutes: ACCESS_TOKEN_TTL_MINUTES, seconds: 1 });
    expectError(await get('/v1/me', signedIn.accessToken), 401, 'token_invalid');
    // The session is still live: only the token's own lifetime expired.
    const reSigned = await t.tokenFor({ id: signedIn.userId, sessionId: signedIn.sessionId });
    expect((await get('/v1/me', reSigned)).status).toBe(200);
  });
  it.each(rows(BEARER_REFUSAL_ROWS))('refuses GET /v1/me with %s', async (_case, token) => {
    const response = await get('/v1/me', token);
    expectError(response, 401, 'token_invalid');
  });
});

describe('the age gate', () => {
  const TRAVELER_FEATURE_ROUTES = ['/v1/cities', '/v1/meetups'] as const;
  it.each(TRAVELER_FEATURE_ROUTES)('holds %s until the consents are recorded', async (url) => {
    const user = await makeUser(t, { consents: false, card: 'none' });
    expectError(await get(url, user.accessToken), 403, 'age_gate_required');
  });
  it('admits the bearer routes an account needs first, and opens the gate on consent', async () => {
    const user = await makeUser(t, { consents: false, card: 'none' });
    // The own profile, the consents that open the gate and the session's own end are all reachable.
    const me = await get('/v1/me', user.accessToken);
    expect(me.status).toBe(200);
    expect(MeDto.parse(me.json()).consents.termsVersion).toBeNull();
    const consented = await callRoute(t.app, {
      method: 'POST',
      url: '/v1/me/consents',
      as: user.accessToken,
      body: { adult: true, termsVersion: t.env.TERMS_VERSION },
    });
    expect(consented.status).toBe(200);
    expect(MeDto.parse(consented.json()).consents.termsVersion).toBe(t.env.TERMS_VERSION);
    // Open for the very next request: recording the consents drops the session's cache entry
    // (AAP 0.3.2).
    expect((await get('/v1/cities', user.accessToken)).status).toBe(200);
  });
  it('refuses a terms version this API does not serve', async () => {
    const user = await makeUser(t, { consents: false, card: 'none' });
    const stale = await callRoute(t.app, {
      method: 'POST',
      url: '/v1/me/consents',
      as: user.accessToken,
      body: { adult: true, termsVersion: '2020-01-01' },
    });
    expectError(stale, 400, 'invalid_field');
  });
  it('lets an account that has not consented log out and delete itself', async () => {
    const loggingOut = await makeUser(t, { consents: false, card: 'none' });
    const loggedOut = await callRoute(t.app, {
      method: 'POST',
      url: '/v1/auth/logout',
      as: loggingOut.accessToken,
    });
    expect(loggedOut.status).toBe(204);
    const deleting = await makeUser(t, { consents: false, card: 'none' });
    const deleted = await callRoute(t.app, {
      method: 'DELETE',
      url: '/v1/me',
      as: deleting.accessToken,
    });
    expect(deleted.status).toBe(202);
    // The write fence is set and every session of the account is revoked in the same transaction.
    const deletedUser = await t.services.db.user.findUniqueOrThrow({ where: { id: deleting.id } });
    expect(deletedUser.deletionRequestedAt).not.toBeNull();
    expect(
      await t.services.db.session.count({ where: { userId: deleting.id, revokedAt: null } }),
    ).toBe(0);
  });
});

describe('the public routes', () => {
  it('serves the health probe with both of its checks', async () => {
    const response = await get('/v1/health');
    expect(response.status).toBe(200);
    const health = HealthResponse.parse(response.json());
    expect(health.status).toBe('ok');
    expect(health.checks.database).toBe('ok');
    expect(health.checks.redis).toBe('ok');
  });
  it('serves the ZK configuration to a caller with no bearer', async () => {
    const response = await get('/v1/zk/config');
    // `200` once `pnpm circuits:build` has produced the artefacts, and `503 service_unavailable`
    // without them (AAP 0.5.5). What this case holds is that no bearer is demanded of either.
    if (response.status === 200) {
      // The salt the client hashes a booking reference with is the one this API checks it against.
      expect(ZkConfig.parse(response.json()).nullifierSalt).toBe(t.env.NULLIFIER_SALT);
      return;
    }
    expectError(response, 503, 'service_unavailable');
  });
});
