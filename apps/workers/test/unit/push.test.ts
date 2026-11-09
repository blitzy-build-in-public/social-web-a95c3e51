/**
 * The Expo push sender's unit suite (AAP 0.3.3, 0.11.1): the bound on one chunk send, and the
 * ticket handling the `notifications` job reads.
 */

import { type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PushDeliveryError,
  createPushSender,
  type ExpoPushClient,
  type PushSender,
} from '../../src/notify/push.ts';

/**
 * The send bound `src/notify/push.ts` declares (`SEND_TIMEOUT_MS`): the ten seconds AAP 0.11.1 puts
 * on the same kind of provider here. The module does not export it, so the number is repeated — a
 * change to the bound the module ships has to fail this suite.
 */
const PUSH_SEND_TIMEOUT_MS = 10_000;

/** Any non-blank `EXPO_ACCESS_TOKEN` enables push (AAP 0.3.3). Never a real token. */
const ACCESS_TOKEN = 'test-access-token';

/**
 * A well-formed Expo push token: the one shape `Expo.isExpoPushToken` accepts. The value is
 * assembled here rather than written out, so the literal never reads as a captured push token to
 * a scanner.
 */
const PUSH_TOKEN = `ExponentPushToken[${'a'.repeat(22)}]`;

const MESSAGE = { title: 'A seat is held', body: 'Your proposal was accepted.' };

/** A ticket case: the label, the one ticket Expo answers, and the result the send must report. */
type TicketCase = readonly [
  label: string,
  ticket: ExpoPushTicket,
  sent: number,
  invalidTokens: readonly string[],
];

/**
 * The two answers one well-formed token can get. Only the ticket differs, so both are rows of one
 * table: an accepted message is counted as sent, and a retired device is dropped from the token set
 * instead of failing the send — which is what keeps the job from retrying a dead token forever.
 */
const TICKET_CASES: readonly TicketCase[] = [
  ['an accepted message', { status: 'ok', id: 'expo-receipt-1' }, 1, []],
  [
    'a device Expo reports as unregistered',
    {
      status: 'error',
      message: 'Device not registered',
      details: { error: 'DeviceNotRegistered' },
    },
    0,
    [PUSH_TOKEN],
  ],
];

/**
 * A stub Expo client: one chunk per call, and an answer the case chooses.
 */
function stubClient(answer: (messages: ExpoPushMessage[]) => Promise<ExpoPushTicket[]>): {
  client: ExpoPushClient;
  chunks: ExpoPushMessage[][];
} {
  const chunks: ExpoPushMessage[][] = [];

  const client: ExpoPushClient = {
    chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][] {
      // One chunk of every message keeps the ticket at index n answering for the token at index n.
      return messages.length === 0 ? [] : [messages];
    },
    sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
      chunks.push(messages);
      return answer(messages);
    },
  };

  return { client, chunks };
}

/** An answer that never arrives: the half-open Expo endpoint the send bound exists for. */
function neverAnswers(): Promise<ExpoPushTicket[]> {
  // Only the bound ends this promise, which is exactly what the bound case asserts.
  return new Promise<ExpoPushTicket[]>(() => {});
}

/** The sender with push on: `createPushSender` returns `null` only when no token is configured. */
function senderFor(client: ExpoPushClient): PushSender {
  const sender = createPushSender(ACCESS_TOKEN, { client });

  if (sender === null) {
    throw new Error('push is enabled for a non-blank EXPO_ACCESS_TOKEN');
  }

  return sender;
}

beforeEach(() => {
  // The bound is ten real seconds, so the timers are faked: the suite stays fast, and the
  // handles the module leaves behind can be counted.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createPushSender', () => {
  it('disables push when no access token is configured', () => {
    // Push is switched off by configuration, not by a flag (AAP 0.3.3): with no token there is no
    // sender at all, so no Expo client is built and nothing can be sent.
    expect(createPushSender(undefined)).toBeNull();
    expect(createPushSender('')).toBeNull();
    expect(createPushSender('   ')).toBeNull();
  });
});

describe('PushSender.send ticket handling', () => {
  it.each(TICKET_CASES)('%s', async (_label, ticket, sent, invalidTokens) => {
    const { client, chunks } = stubClient(() => Promise.resolve([ticket]));
    const result = await senderFor(client).send([PUSH_TOKEN], MESSAGE);
    expect(result).toEqual({ sent, invalidTokens: [...invalidTokens] });
    expect(chunks).toHaveLength(1);
  });

  it('retires a token that is not an Expo token without making a request', async () => {
    // The SDK's own predicate decides, so a token Expo cannot address is dropped before the chunk
    // that would fail it — and every well-formed token beside it — is sent. The stub never
    // answers, so a request here would hang instead of returning this result.
    const { client, chunks } = stubClient(neverAnswers);
    const result = await senderFor(client).send(['not-an-expo-token'], MESSAGE);
    expect(result).toEqual({ invalidTokens: ['not-an-expo-token'], sent: 0 });
    expect(chunks).toEqual([]);
  });
});

describe('PushSender.send send bound', () => {
  it('fails a never-answering endpoint at the bound and clears the timer', async () => {
    const { client, chunks } = stubClient(neverAnswers);
    const otherTimers = vi.getTimerCount();
    const send = senderFor(client).send([PUSH_TOKEN], MESSAGE);
    const rejection = expect(send).rejects.toBeInstanceOf(PushDeliveryError);
    expect(vi.getTimerCount()).toBe(otherTimers + 1);
    // One millisecond short of the bound the chunk is still in flight, and it is still armed.
    await vi.advanceTimersByTimeAsync(PUSH_SEND_TIMEOUT_MS - 1);
    expect(vi.getTimerCount()).toBe(otherTimers + 1);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    await expect(send).rejects.toMatchObject({ codes: ['request_failed'] });
    expect(chunks).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(otherTimers);
  });
});
