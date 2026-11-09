/**
 * Integration tests for the `notifications` queue (AAP 0.3.2, 0.3.4, 0.5.7).
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, testWorkersEnv, type TestApp } from '@tablemate/api/test-support/app';
import {
  callRoute,
  expectError,
  makeUser,
  makeVenue,
  proposeAndLock,
  type UserFixture,
  type UserFixtureOptions,
  type VenueFixture,
} from '@tablemate/api/test-support/factories';
import {
  JOB,
  QUEUE,
  loadWorkersEnv,
  parseJobData,
  parseOutboxPayload,
  toOutboxJob,
  type OutboxJob,
} from '@tablemate/server-core';
import { MAGIC_LINK_TTL_MINUTES, MINUTE_MS, VerifyResponse, depositCopy } from '@tablemate/shared';
import type { DepositCents, Variant } from '@tablemate/shared';

import {
  process as runNotifications,
  type NotificationDeliveryResult,
} from '../../src/jobs/notifications.ts';
import { closeWorkerContext, createWorkerContext, type WorkerContext } from '../../src/queues.ts';
import type { Mailer } from '../../src/notify/email.ts';

const CITY = 'lisbon';

const EXPIRED_AFTER_MS = MAGIC_LINK_TTL_MINUTES * MINUTE_MS + 1_000;

const PHONE_NUMBER = /\+[1-9]\d{6,}/;

interface SentMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

const sent: SentMessage[] = [];

/**
 * The capturing mailer the worker context gets, so no send reaches SMTP. `send` returns a settled
 * promise rather than being `async`, which the workspace's `require-await` rule rejects.
 */
const mailer: Mailer = {
  send(message): Promise<void> {
    sent.push({ to: message.to, subject: message.subject, text: message.text });
    return Promise.resolve();
  },
};

let testApp: TestApp;
let ctx: WorkerContext;

/** One `notification` outbox row, with the job the API's dispatcher would publish for it. */
interface PendingNotification {
  readonly id: string;
  readonly job: OutboxJob;
}

async function pendingNotifications(): Promise<PendingNotification[]> {
  const rows = await testApp.services.db.outboxMessage.findMany({
    where: { kind: 'notification' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, kind: true, payload: true },
  });

  return rows.map((row) => ({
    id: row.id,
    job: toOutboxJob({ id: row.id, kind: row.kind, payload: row.payload }),
  }));
}

async function theOnlyNotification(): Promise<PendingNotification> {
  const pending = await pendingNotifications();
  expect(pending).toHaveLength(1);
  const first = pending[0];
  if (first === undefined) {
    throw new Error('the flow queued no notification row');
  }
  return first;
}

/** Deliver one row's message through the real job, exactly as the dispatcher publishes it. */
async function deliver(pending: PendingNotification): Promise<NotificationDeliveryResult> {
  const { job } = pending;
  expect(job.queue).toBe(QUEUE.notifications);
  expect(job.name).toBe(JOB[QUEUE.notifications].deliver);

  // Parsed against the deliver name the assertions above just matched, so the job data is validated
  // as the queue's own schema describes it rather than trusted from the row.
  const data = parseJobData(QUEUE.notifications, JOB[QUEUE.notifications].deliver, job.data);

  return runNotifications({ id: job.jobId, name: job.name, data }, ctx);
}

async function deliverAll(
  pending: readonly PendingNotification[],
): Promise<NotificationDeliveryResult[]> {
  const results: NotificationDeliveryResult[] = [];
  for (const item of pending) {
    results.push(await deliver(item));
  }
  return results;
}

async function requestMagicLink(email: string): Promise<void> {
  const answer = await testApp.app.inject({
    method: 'POST',
    url: '/v1/auth/magic-link',
    payload: { email },
  });
  expect(answer.statusCode).toBe(202);
}

async function theOnlyToken() {
  return testApp.services.db.magicLinkToken.findFirstOrThrow({
    orderBy: { createdAt: 'desc' },
    select: { id: true, deliveryTokenCiphertext: true },
  });
}

function verify(token: string) {
  return callRoute(testApp.app, { method: 'POST', url: '/v1/auth/verify', body: { token } });
}

function linkedToken(text: string): string {
  const match = /https?:\/\/\S+\/auth\/verify\?token=\S+/.exec(text);
  if (match === null) {
    throw new Error('the magic-link email carries no sign-in link');
  }
  const token = new URL(match[0]).searchParams.get('token');
  if (token === null || token === '') {
    throw new Error('the sign-in link carries no token');
  }
  return token;
}

function messagesFor(email: string): string[] {
  return sent
    .filter((message) => message.to === email)
    .map((message) => `${message.subject}\n${message.text}`);
}

interface Participant {
  readonly user: UserFixture;
  readonly variant: Variant;
  readonly otherVariant: Variant;
}

/** Assert that every message for `side` carries its own variant's copy and never the other's. */
function expectOwnFraming(side: Participant, depositCents: DepositCents): void {
  const received = messagesFor(side.user.email);
  expect(received.length).toBeGreaterThan(0);
  expect(received.some((body) => body.includes(depositCopy(side.variant, depositCents)))).toBe(
    true,
  );
  expect(received.some((body) => body.includes(depositCopy(side.otherVariant, depositCents)))).toBe(
    false,
  );
}

function expectNoPrivateContent(participants: readonly UserFixture[], venue: VenueFixture): void {
  for (const message of sent) {
    const body = `${message.subject}\n${message.text}`;
    for (const participant of participants) {
      expect(body).not.toContain(participant.email);
    }
    expect(body).not.toContain(String(venue.lat));
    expect(body).not.toContain(String(venue.lng));
    expect(body).not.toMatch(PHONE_NUMBER);
  }
}

beforeAll(async () => {
  testApp = await createTestApp();
  // The app's own clock, so a case that advances it moves the token's expiry too, and the app's own
  // origin, so the link the mailer carries is the one the client opens (AAP 0.3.2).
  ctx = await createWorkerContext(
    loadWorkersEnv(testWorkersEnv({ WEB_ORIGIN: testApp.env.WEB_ORIGIN })),
    { clock: testApp.clock, mailer },
  );
});

afterAll(async () => {
  await closeWorkerContext(ctx);
  await testApp.close();
});

beforeEach(async () => {
  await testApp.resetState();
  await testApp.seedCities();
  sent.length = 0;
});

describe('the magic link (AAP 0.3.2)', () => {
  /** One address per case: the route allows five an hour for a single address (AAP 0.5.4). */
  const EMAIL = 'magic-link@fixture.test';

  it('queues the token as ids only, mails the link once, and cannot be signed in with twice', async () => {
    await requestMagicLink(EMAIL);
    const token = await theOnlyToken();
    expect(token.deliveryTokenCiphertext).not.toBeNull();
    // Ids only: the worker decrypts the address and the token from the row this id names.
    const rows = await testApp.services.db.outboxMessage.findMany({ select: { payload: true } });
    expect(rows.map((row) => row.payload)).toEqual([
      { kind: 'magic_link', magicLinkTokenId: token.id },
    ]);
    const pending = await theOnlyNotification();
    expect(await deliver(pending)).toEqual({ channel: 'email', kind: 'magic_link' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(EMAIL);
    expect(sent[0]?.text).toContain(`${testApp.env.WEB_ORIGIN}/auth/verify?token=`);
    expect(sent[0]?.text).not.toContain(EMAIL);
    expect((await theOnlyToken()).deliveryTokenCiphertext).toBeNull();
    const raw = linkedToken(sent[0]?.text ?? '');
    const session = VerifyResponse.parse((await verify(raw)).json());
    expect(session.accessToken).toBeTypeOf('string');
    expect(session.refreshToken).toBeTypeOf('string');
    // Single use: the token is consumed by the exchange above.
    expectError(await verify(raw), 401, 'token_invalid');
    // A redelivery of the same row is a no-op, which is what the row id in the job buys.
    expect(await deliver(pending)).toEqual({ skipped: 'already_sent' });
    expect(sent).toHaveLength(1);
  });

  it('sends nothing and clears the raw token when the job reaches an expired link', async () => {
    await requestMagicLink(EMAIL);
    expect((await theOnlyToken()).deliveryTokenCiphertext).not.toBeNull();
    testApp.clock.advance(EXPIRED_AFTER_MS);
    const pending = await theOnlyNotification();
    expect(await deliver(pending)).toEqual({ skipped: 'expired' });
    expect(sent).toHaveLength(0);
    expect((await theOnlyToken()).deliveryTokenCiphertext).toBeNull();
    // Purged 24 hours after expiry, not here: the row is left for `data-expiry` (AAP 0.5.2).
    expect(await testApp.services.db.magicLinkToken.count()).toBe(1);
  });
});

describe('deposit notifications (AAP 0.5.7)', () => {
  /** The two pairings the framing copy is asserted across: one per direction of the experiment. */
  const PAIRINGS: readonly {
    readonly label: string;
    readonly initiator: Variant;
    readonly recipient: Variant;
    readonly depositCents: DepositCents;
  }[] = [
    {
      label: 'a punitive initiator and a social recipient at 2000 cents',
      initiator: 'punitive',
      recipient: 'social',
      depositCents: 2000,
    },
    {
      label: 'a social initiator and a punitive recipient at 500 cents',
      initiator: 'social',
      recipient: 'punitive',
      depositCents: 500,
    },
  ];

  it.each(PAIRINGS)(
    'frames every deposit message of $label in its own variant',
    async (pairing) => {
      const venue = await makeVenue(testApp, { cityId: CITY });
      const initiator = await makeUser(testApp, { variant: pairing.initiator });
      const recipient = await makeUser(testApp, { variant: pairing.recipient });
      await proposeAndLock(testApp, {
        initiator,
        recipient,
        venue,
        depositCents: pairing.depositCents,
      });
      const pending = await pendingNotifications();
      expect(await deliverAll(pending)).toEqual([
        { channel: 'email', kind: 'proposal_received' },
        { channel: 'email', kind: 'meetup_locked' },
        { channel: 'email', kind: 'meetup_locked' },
      ]);
      expectOwnFraming(
        { user: initiator, variant: pairing.initiator, otherVariant: pairing.recipient },
        pairing.depositCents,
      );
      expectOwnFraming(
        { user: recipient, variant: pairing.recipient, otherVariant: pairing.initiator },
        pairing.depositCents,
      );
      expectNoPrivateContent([initiator, recipient], venue);
      const first = pending[0];
      expect(first).toBeDefined();
      if (first === undefined) {
        throw new Error('the flow queued no notification row');
      }
      expect(await deliver(first)).toEqual({ skipped: 'already_sent' });
      expect(sent).toHaveLength(3);
      expect(await ctx.redis.exists(`notify-sent:${first.id}:email`)).toBe(1);
    },
  );
});

describe('recipients who are told nothing (AAP 0.5.2, 0.5.3)', () => {
  /** The two accounts the job must skip, and never fail on. */
  const SILENCED: readonly { readonly label: string; readonly options: UserFixtureOptions }[] = [
    { label: 'a tombstone', options: { deleted: true } },
    { label: 'an account whose deletion has been requested', options: { deletionRequested: true } },
  ];

  it.each(SILENCED)('skips $label without sending and without throwing', async ({ options }) => {
    const user = await makeUser(testApp, options);
    const payload = parseOutboxPayload('notification', {
      kind: 'meetup_locked',
      userId: user.id,
      meetupId: randomUUID(),
    });
    const row = await testApp.services.db.outboxMessage.create({
      data: { kind: 'notification', payload, createdAt: testApp.clock.now() },
      select: { id: true, kind: true, payload: true },
    });
    const pending: PendingNotification = {
      id: row.id,
      job: toOutboxJob({ id: row.id, kind: row.kind, payload: row.payload }),
    };
    expect(await deliver(pending)).toEqual({ skipped: 'user_deleted' });
    expect(sent).toHaveLength(0);
  });
});
