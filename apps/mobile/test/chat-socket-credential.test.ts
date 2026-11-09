/**
 * The chat socket's credential lifecycle: an attempt opens only for a session the app already holds, a
 * write is never made on a socket whose credential a rotation has replaced, a write the server refuses
 * for that reason is written again on the socket the reconnect opens until the module's bound is reached
 * and is cleared by the server's echo of the stored message, and an upgrade the server refuses before
 * the socket ever opens escalates to exactly one rotation rather than retrying the same credential for
 * ever (AAP 0.3.3, AAP 0.5.4, AAP 0.11.2).
 *
 * `src/auth/session.ts` cannot be imported from here: its extensionless `./storage` import has only
 * `storage.native.ts` and `storage.web.ts` halves, which Metro resolves per platform and Node does
 * not. The socket is therefore exercised against fake hooks — the whole of what it asks of the auth
 * module — and a stub `WebSocket`, because the socket is the one thing this module exists to open.
 */
import { onlineManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureAuth, type AuthHooks } from '../src/api/client.ts';
import { ApiError } from '../src/api/errors.ts';
import { connect, disconnect, getConnectionState, send } from '../src/api/ws.ts';
import type { ConnectionState } from '../src/api/ws.ts';

/** The origin the build configures; `wsBaseUrl()` reads the variable per call. */
const WS_ORIGIN = 'ws://api.test';

/** The chat path the module appends to it. */
const CHAT_PATH = '/v1/chat';

/** The access token a session holds first. */
const TOKEN_A = 'access-token-a';

/** The token a rotation replaces it with, which is what revokes the session a socket was admitted with. */
const TOKEN_B = 'access-token-b';

/** The meetup a case sends for. */
const MEETUP_ID = '01a1c054-6117-7700-97f2-60660a2b662c';

/** One stored message: the id and the creation time the frame the server echoes it back in carries. */
const MESSAGE_ID = '3f2a1c8e-9b4d-4e6f-8a1b-2c3d4e5f6071';
const MESSAGE_CREATED_AT = '2026-11-04T12:00:00.000Z';

/** A normal closure (RFC 6455 §7.4.1), which is what the module itself sends when it drops a socket. */
const CLOSE_NORMAL = 1000;

/** What a browser reports both for an upgrade the server refused before the handshake and for a lost connection (AAP 0.3.3). */
const CLOSE_ABNORMAL = 1006;

/** The close the API sends a write made on a socket whose credential has been rotated away with, after the frame below explains it (AAP 0.5.3). */
const CLOSE_UNAUTHORIZED = 4401;

/** The frame the API refuses such a write with: the message was not stored, and the socket cannot continue. */
const TOKEN_INVALID_FRAME = {
  type: 'error',
  code: 'token_invalid',
  message: 'Token invalid.',
} as const;

/** The module's own reconnect ceiling, mirrored so a case can step past any delay its jitter picks. */
const BACKOFF_CEILING_MS = 30_000;

/**
 * The socket the module opens, recorded rather than connected: what it was opened for, what was written
 * on it, and the events a case drives it with. The module reads `readyState` and assigns the four
 * handlers, which is the whole of the API it uses.
 */
class StubSocket {
  /** Every socket the module created, in the order it created them. */
  static readonly created: StubSocket[] = [];

  readonly url: string;
  readonly protocols: readonly string[];
  readonly sent: string[] = [];
  readonly closed: (number | undefined)[] = [];
  readyState = 0;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(url: string, protocols: readonly string[]) {
    this.url = url;
    this.protocols = protocols;
    StubSocket.created.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('the socket is not open');
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closed.push(code);
    this.readyState = 3;
  }

  /** The server accepts the upgrade. */
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** The connection ends, or the server refuses the upgrade before it ever opened. */
  end(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** The server answers with a frame. */
  answer(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

/** The socket a case asserts on. */
function socketAt(index: number): StubSocket {
  const found = StubSocket.created[index];
  if (found === undefined) throw new Error(`no socket was opened at index ${index}`);
  return found;
}

/** One frame as the wire saw it, or undefined when nothing was written. */
function readFrame(payload: string | undefined): unknown {
  return payload === undefined ? undefined : JSON.parse(payload);
}

/** The frame a case expects to see written for a body: what `send` validates and puts on the wire. */
function chatSendFrame(body: string): unknown {
  return { type: 'chat_send', meetupId: MEETUP_ID, body };
}

/**
 * The frame the API pushes once a message is stored: the publish reaches both participants, so the
 * sender's own socket carries the message it wrote, which is how the module learns a write reached the
 * database (AAP 0.5.4).
 */
function messageEcho(body: string): unknown {
  return {
    type: 'message',
    message: {
      id: MESSAGE_ID,
      meetupId: MEETUP_ID,
      senderId: null,
      body,
      createdAt: MESSAGE_CREATED_AT,
    },
  };
}

/** What the hooks a case installed were asked to do. */
interface InstalledHooks {
  /** How many rotations of the session the module asked for. */
  rotations(): number;
}

/**
 * Installs fake auth hooks, as `src/auth/session.ts` does at the foot of its module.
 *
 * `gate` is the `ensureSession` hook a cold start's restore is awaited through: a function to install,
 * or null for hooks without one. `rotated` is the token a rotation installs, which is what a case
 * asserting on the credential an attempt opened with reads back.
 */
function installHooks(options: {
  readonly held: { value: string | null };
  readonly gate?: (() => Promise<void>) | null;
  readonly rotated?: string;
}): InstalledHooks {
  const refresh = vi.fn((): Promise<void> => {
    if (options.rotated !== undefined) options.held.value = options.rotated;
    return Promise.resolve();
  });
  const gate = options.gate;
  const hooks: AuthHooks = {
    getAccessToken: () => options.held.value,
    ...(gate === null || gate === undefined ? {} : { ensureSession: gate }),
    refresh,
    onSignedOut: () => undefined,
  };
  configureAuth(hooks);
  return { rotations: () => refresh.mock.calls.length };
}

/**
 * Flushes the promises the module has queued, so a case can assert an absence — no socket, no rotation
 * — as well as a presence. Microtasks only: none of the module's own reconnect timers fires here.
 */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
}

describe("the chat socket's credential", () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_WS_URL = WS_ORIGIN;
    StubSocket.created.length = 0;
    vi.stubGlobal('WebSocket', StubSocket);
    vi.useFakeTimers();
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    disconnect();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.EXPO_PUBLIC_WS_URL;
  });

  /**
   * What an attempt meets when it starts: the session it can be offered, and the socket that answers.
   * `held` is the token the session holds; `gate` is the `ensureSession` hook, if the client installs
   * one, and what it leaves behind is the input the three rows without a session share.
   */
  const ATTEMPTS: readonly (readonly [
    name: string,
    held: string | null,
    gate: 'restores' | 'installs nothing' | 'refuses' | 'absent',
    sockets: number,
    state: ConnectionState,
  ])[] = [
    ['a session already restored', TOKEN_A, 'absent', 1, 'connecting'],
    ['a gate that restores a session', null, 'restores', 1, 'connecting'],
    ['a gate that installs no token', null, 'installs nothing', 0, 'idle'],
    ['a gate the session refused', null, 'refuses', 0, 'idle'],
    ['a client with no gate at all', null, 'absent', 0, 'idle'],
  ];

  it.each(ATTEMPTS)(
    'opens a socket only for a session the app already holds: %s',
    async (_name, held, gate, sockets, state) => {
      const session = { value: held };
      const restores = (): Promise<void> => {
        session.value = TOKEN_A;
        return Promise.resolve();
      };
      installHooks({
        held: session,
        gate:
          gate === 'restores'
            ? restores
            : gate === 'installs nothing'
              ? () => Promise.resolve()
              : gate === 'refuses'
                ? () => Promise.reject(new ApiError(401, 'token_invalid'))
                : null,
      });

      connect();
      await settle();

      if (sockets === 0) {
        expect(StubSocket.created).toHaveLength(0);
        // A refused session is not a retry loop of this module's own: the session module calls
        // `connect` again once it installs one, and until then nothing is attempted (AAP 0.3.3).
        await vi.advanceTimersByTimeAsync(2 * BACKOFF_CEILING_MS);
        expect(StubSocket.created).toHaveLength(0);
      } else {
        expect(StubSocket.created).toHaveLength(1);
        expect(socketAt(0).url).toBe(`${WS_ORIGIN}${CHAT_PATH}`);
        expect(socketAt(0).protocols).toEqual(['bearer', TOKEN_A]);
      }
      expect(getConnectionState()).toBe(state);
    },
  );

  it('writes on a socket holding the session token, and reopens rather than writing on a stale one', async () => {
    const session = { value: TOKEN_A };
    installHooks({ held: session });
    connect();
    await settle();
    const admitted = socketAt(0);
    admitted.accept();
    expect(getConnectionState()).toBe('open');

    // A socket whose credential is current is written to as it always was.
    await expect(send(MEETUP_ID, 'first')).resolves.toBe(true);
    expect(readFrame(admitted.sent[0])).toEqual({
      type: 'chat_send',
      meetupId: MEETUP_ID,
      body: 'first',
    });
    expect(StubSocket.created).toHaveLength(1);

    // A REST 401 rotated the session, which revoked the session this socket was admitted with.
    session.value = TOKEN_B;

    const written = send(MEETUP_ID, 'second');
    await settle();
    expect(StubSocket.created).toHaveLength(2);
    const reopened = socketAt(1);
    expect(reopened.protocols).toEqual(['bearer', TOKEN_B]);
    reopened.accept();

    await expect(written).resolves.toBe(true);
    // The traveler's message went out on the socket that holds the session's token, and the stale one
    // was dropped without it.
    expect(readFrame(reopened.sent[0])).toEqual({
      type: 'chat_send',
      meetupId: MEETUP_ID,
      body: 'second',
    });
    expect(admitted.sent).toHaveLength(1);
    expect(admitted.closed).toEqual([CLOSE_NORMAL]);
  });

  it('escalates two upgrades refused before the socket ever opened to exactly one rotation', async () => {
    const session = { value: TOKEN_A };
    const hooks = installHooks({ held: session, rotated: TOKEN_B });

    connect();
    await settle();
    socketAt(0).end(CLOSE_ABNORMAL);

    // One refusal before the socket ever opened proves nothing about the session, so the first retry
    // carries the credential it already had.
    await vi.advanceTimersByTimeAsync(BACKOFF_CEILING_MS);
    expect(hooks.rotations()).toBe(0);
    expect(StubSocket.created).toHaveLength(2);
    expect(socketAt(1).protocols).toEqual(['bearer', TOKEN_A]);

    socketAt(1).end(CLOSE_ABNORMAL);

    // The second one is a credential problem: the next attempt rotates the session first, and opens
    // with the token that rotation installed.
    await vi.advanceTimersByTimeAsync(BACKOFF_CEILING_MS);
    expect(hooks.rotations()).toBe(1);
    expect(StubSocket.created).toHaveLength(3);
    expect(socketAt(2).protocols).toEqual(['bearer', TOKEN_B]);

    socketAt(2).end(CLOSE_ABNORMAL);

    // At most one rotation per credential episode, so a refusal a rotation cannot fix — a role, consent
    // or age-gate refusal, say — is retried instead of rotating for ever (AAP 0.3.3).
    await vi.advanceTimersByTimeAsync(4 * BACKOFF_CEILING_MS);
    expect(hooks.rotations()).toBe(1);
  });

  it('re-arms a write the server keeps refusing, and stops re-sending at the bound', async () => {
    const session = { value: TOKEN_A };
    installHooks({ held: session, rotated: TOKEN_B });

    connect();
    await settle();
    socketAt(0).accept();
    await expect(send(MEETUP_ID, 'survivor')).resolves.toBe(true);
    expect(readFrame(socketAt(0).sent[0])).toEqual(chatSendFrame('survivor'));

    // The session rotated while the frame was in flight, so the server refuses the write: the message is
    // not stored, and the socket that was admitted with the retired credential cannot continue.
    socketAt(0).answer(TOKEN_INVALID_FRAME);
    socketAt(0).end(CLOSE_UNAUTHORIZED);
    await vi.advanceTimersByTimeAsync(BACKOFF_CEILING_MS);

    // The reconnect rotates, and the frame is written again on the socket that rotation admits.
    expect(StubSocket.created).toHaveLength(2);
    expect(socketAt(1).protocols).toEqual(['bearer', TOKEN_B]);
    socketAt(1).accept();
    expect(socketAt(1).sent).toHaveLength(1);
    expect(readFrame(socketAt(1).sent[0])).toEqual(chatSendFrame('survivor'));

    // A second rotation landed between that reconnect and its write, so the re-send is refused as well:
    // the frame is still the traveler's, and the next open writes it again instead of losing it.
    socketAt(1).answer(TOKEN_INVALID_FRAME);
    socketAt(1).end(CLOSE_UNAUTHORIZED);
    await vi.advanceTimersByTimeAsync(BACKOFF_CEILING_MS);
    expect(StubSocket.created).toHaveLength(3);
    socketAt(2).accept();
    expect(socketAt(2).sent).toHaveLength(1);
    expect(readFrame(socketAt(2).sent[0])).toEqual(chatSendFrame('survivor'));

    // The bound is reached, so the third refusal buys no further write: the rotation and the unauthorized
    // close are what answer it, never a fourth write of the same frame (AAP 0.5.3).
    socketAt(2).answer(TOKEN_INVALID_FRAME);
    socketAt(2).end(CLOSE_UNAUTHORIZED);
    await vi.advanceTimersByTimeAsync(BACKOFF_CEILING_MS);
    expect(StubSocket.created).toHaveLength(4);
    socketAt(3).accept();
    expect(socketAt(3).sent).toHaveLength(0);
  });

  /**
   * What the server's echo says about the write it is matched with: the frame the write put on the wire
   * carries the meetup and the body that frame's own echo carries back, and no other message does — so
   * the count of frames a later socket writes is what tells an acknowledged write from an owed one.
   */
  const ECHOES: readonly (readonly [name: string, echoedBody: string, written: number])[] = [
    ['the echo of the write itself', 'delivered', 0],
    ['the echo of another message of the pair', 'a different message', 1],
  ];

  it.each(ECHOES)(
    'clears a write the server acknowledged, and re-sends one it did not: %s',
    async (_name, echoedBody, written) => {
      const session = { value: TOKEN_A };
      installHooks({ held: session, rotated: TOKEN_B });

      connect();
      await settle();
      socketAt(0).accept();
      await expect(send(MEETUP_ID, 'delivered')).resolves.toBe(true);
      socketAt(0).answer(messageEcho(echoedBody));

      // A refusal on this socket then rotates the session and opens the next one. A write the server
      // acknowledged has nothing left to send — writing it again would store a second copy of it — while
      // a write it did not is still the traveler's, and goes out on that socket.
      socketAt(0).answer(TOKEN_INVALID_FRAME);
      socketAt(0).end(CLOSE_UNAUTHORIZED);
      await vi.advanceTimersByTimeAsync(BACKOFF_CEILING_MS);

      expect(StubSocket.created).toHaveLength(2);
      socketAt(1).accept();
      expect(socketAt(1).sent).toHaveLength(written);
    },
  );
});
