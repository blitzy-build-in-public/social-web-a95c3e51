/**
 * Expo push delivery for the `notifications` queue (AAP 0.3.3, 0.3.4).
 *
 * Native devices register an Expo push token, and the `notifications` job pushes to a user's
 * registered tokens while web users get email instead. This module owns the native send alone: it
 * holds no state, opens no connection until a send is attempted, and takes its Expo client as an
 * injected dependency so a test can assert the requests without reaching the network.
 *
 * Every chunk send is bounded (AAP 0.11.1): {@link SEND_TIMEOUT_MS} caps one chunk, and a chunk
 * that exhausts it fails exactly as a lost answer does. Its code is recorded and the chunks after
 * it still go out. The SDK itself passes no `signal`, so the bound is a race this module owns:
 * without it a dark Expo endpoint would hold the `notifications` job's only concurrency slot open
 * and delivery would stop.
 *
 * Push is switched off by configuration, not by a flag: with no `EXPO_ACCESS_TOKEN` the
 * `workers` environment leaves the credential unset (it is optional there, AAP 0.3.3) and
 * {@link createPushSender} returns `null`, which the job reads as "this deployment sends no push".
 */

import Expo, { type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';

/** Code recorded for a chunk whose request threw, so no delivery answer was received at all. */
const REQUEST_FAILED_CODE = 'request_failed';

/** Code recorded for a chunk that answered with fewer tickets than it was sent messages. */
const MISSING_TICKET_CODE = 'missing_ticket';

/** Code recorded for a rejected ticket that names no Expo error code of its own. */
const UNKNOWN_ERROR_CODE = 'unknown_error';

/** The one ticket failure that retires a token rather than failing the send. */
const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';

/**
 * How long one Expo chunk send may take, the bound AAP 0.11.1 puts on every external call and the
 * same ten seconds `notify/email.ts` gives a connection to the same kind of provider. A chunk that
 * reaches it is recorded as a failed request, so the `notifications` job fails into its retry
 * (AAP 0.5.6) instead of waiting on an endpoint that never answers.
 */
const SEND_TIMEOUT_MS = 10_000;

/**
 * One notification to deliver to a set of the recipient's devices.
 *
 * `data` carries identifiers and in-app paths only — for example `{ kind, path }` — never a push
 * token, an email address or any text the user wrote (AAP 0.3.4). It reaches the device and is
 * not redacted, so the rule holds at the caller: the `notifications` job builds it from ids.
 */
export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/** What a send did: how many devices accepted the message, and which tokens are now dead. */
export interface PushSendResult {
  /** Tokens Expo reports as `DeviceNotRegistered`, plus tokens that are not Expo tokens at all. */
  invalidTokens: string[];
  /** Messages Expo accepted, one per token. */
  sent: number;
}

/**
 * The native push sender the `notifications` job holds, either a live sender or the `null` that
 * {@link createPushSender} returns when push is disabled.
 */
export interface PushSender {
  /**
   * Sends `message` to every given token.
   *
   * Tokens are de-duplicated, and each valid token receives one message so a ticket answers for
   * the token at the same index. After at least one delivery the result is returned even if some
   * messages were rejected, because a BullMQ retry would push again to the devices already
   * reached; nothing accepted and something rejected throws instead, so the retry is safe.
   *
   * Push receipts are not polled, which is pilot scope: a token that Expo accepts here and then
   * fails to reach its provider is retired by the next send to it, not by this one.
   */
  send(tokens: readonly string[], message: PushMessage): Promise<PushSendResult>;
}

/**
 * The part of an `Expo` client this module uses, so a test can inject a stub that answers with
 * chosen tickets and records the messages it was handed, with no network and no access token.
 */
export type ExpoPushClient = Pick<Expo, 'chunkPushNotifications' | 'sendPushNotificationsAsync'>;

/**
 * Thrown when a send delivered nothing and at least one chunk failed for a reason other than a
 * dead token, so the notification is still owed and the job may retry it.
 */
export class PushDeliveryError extends Error {
  /**
   * The Expo error codes observed, de-duplicated in first-seen order: `request_failed`,
   * `missing_ticket`, `unknown_error`, or one of the `details.error` values Expo itself reports
   * such as `InvalidCredentials`. Never a token.
   */
  readonly codes: readonly string[];
  constructor(codes: readonly string[]) {
    super(`Expo push delivery failed for every message: ${codes.join(', ')}`);
    this.name = 'PushDeliveryError';
    this.codes = [...codes];
  }
}

/**
 * Builds the push sender for `accessToken`, or `null` when the token is absent or blank and push
 * is therefore disabled (AAP 0.3.3).
 */
export function createPushSender(
  accessToken: string | undefined,
  deps?: { client?: ExpoPushClient },
): PushSender | null {
  if (accessToken === undefined || accessToken.trim().length === 0) {
    return null;
  }
  const client = deps?.client ?? new Expo({ accessToken });
  return {
    async send(tokens: readonly string[], message: PushMessage): Promise<PushSendResult> {
      const invalidTokens: string[] = [];
      const codes: string[] = [];
      const validTokens: string[] = [];
      // One token is one recipient: a repeat in the input would otherwise push twice to a device.
      const seen = new Set<string>();
      for (const token of tokens) {
        if (seen.has(token)) {
          continue;
        }
        seen.add(token);
        // A token Expo cannot address is retired by the caller and never sent: it would fail its
        // whole chunk, taking every well-formed token in that chunk down with it.
        if (!Expo.isExpoPushToken(token)) {
          invalidTokens.push(token);
          continue;
        }
        validTokens.push(token);
      }
      let sent = 0;
      if (validTokens.length > 0) {
        // One message per token, so the ticket at index n answers for the token at index n.
        const messages: ExpoPushMessage[] = validTokens.map((token) => {
          const push: ExpoPushMessage = {
            to: token,
            title: message.title,
            body: message.body,
            sound: 'default',
            priority: 'high',
          };
          if (message.data !== undefined) {
            push.data = message.data;
          }
          return push;
        });
        const chunks = client.chunkPushNotifications(messages);
        let firstToken = 0;
        // Chunks go one after another: Expo rate-limits concurrent requests against one access
        // token, and a rejected chunk leaves the chunks after it unaffected.
        for (const chunk of chunks) {
          const chunkFirstToken = firstToken;
          firstToken += chunk.length;
          let tickets: ExpoPushTicket[];
          try {
            tickets = await sendChunkWithinTimeout(client, chunk);
          } catch {
            // The answer was lost, or never came within the send's bound, rather than the messages
            // refused. Only a code is kept: the thrown error's text may quote the access token or a
            // recipient.
            recordCode(codes, REQUEST_FAILED_CODE);
            continue;
          }
          for (let offset = 0; offset < chunk.length; offset += 1) {
            const ticket = tickets[offset];
            if (ticket === undefined) {
              recordCode(codes, MISSING_TICKET_CODE);
              continue;
            }
            if (ticket.status === 'ok') {
              sent += 1;
              continue;
            }
            if (ticket.details?.error === DEVICE_NOT_REGISTERED) {
              const token = validTokens[chunkFirstToken + offset];
              if (token !== undefined) {
                invalidTokens.push(token);
              }
              continue;
            }
            recordCode(codes, ticket.details?.error ?? UNKNOWN_ERROR_CODE);
          }
        }
      }
      // Nothing was accepted, so the notification is still owed: throwing lets the job retry
      // without duplicating a push, which a partial send could not do — see `PushSender.send`.
      if (sent === 0 && codes.length > 0) {
        throw new PushDeliveryError(codes);
      }
      return { invalidTokens, sent };
    },
  };
}

/**
 * Sends one chunk under {@link SEND_TIMEOUT_MS}.
 *
 * `expo-server-sdk` 8.0.0 hands its request to `fetch` with no `signal` and no timeout of its own,
 * so the race is the only bound this module can put on a chunk. A bound that elapses rejects the
 * chunk like any lost answer, which is the path the caller already has: the code is recorded and
 * the chunk after it still goes out. The timer is cleared whichever way the race ends, so no handle
 * outlives the send.
 */
async function sendChunkWithinTimeout(
  client: ExpoPushClient,
  chunk: ExpoPushMessage[],
): Promise<ExpoPushTicket[]> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new PushDeliveryError([REQUEST_FAILED_CODE]));
    }, SEND_TIMEOUT_MS);
  });
  try {
    return await Promise.race([client.sendPushNotificationsAsync(chunk), bound]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Records a failure code once. The failure count is not the point — the same code from a hundred
 * tickets would tell a log line nothing more than the one code does.
 */
function recordCode(codes: string[], code: string): void {
  if (!codes.includes(code)) {
    codes.push(code);
  }
}
