/**
 * The ConversationRelay socket, `WS /v1/webhooks/voice/relay` (AAP 0.3.3, 0.3.2, 0.5.4, 0.5.6).
 *
 * Twilio opens it once an outbound call answers and it has fetched the ConversationRelay TwiML that `./twiml.ts`
 * served; the attempt id travels as a `<Parameter>` named `packages/shared`'s {@link VOICE_ATTEMPT_PARAMETER}, and
 * everything after the upgrade happens on the connection itself (AAP 0.3.3).
 *
 * This module is the transport half of the voice agent, deliberately narrow:
 *
 *  - **It authenticates the upgrade before it happens.** `preValidation` runs the Twilio signature check over the
 *    socket's public `wss://` URL alone — the relay URL carries no query string, because the attempt id arrives
 *    inside the socket's own `setup` frame — and a refusal is a plain `400 bad_signature` on a connection Twilio
 *    never gets (AAP 0.3.3, 0.5.4).
 *  - **It bounds itself.** Its sessions are capped at `VOICE_RELAY_MAX_SESSIONS` concurrent per instance, and a
 *    further upgrade is answered `503 service_unavailable` on an unupgraded connection (AAP 0.3.2).
 *  - **It composes no word.** Every utterance is rendered by `./dialogue.ts` from a fixed per-language template;
 *    nothing here reads a language model or invents a sentence (AAP 0.5.6).
 *  - **It records no outcome.** Once the ConversationRelay TwiML has been served the dialogue session owns the
 *    call's outcome, and {@link DialogueSession.finalize} is its only writer (AAP 0.3.2).
 *
 * Failure containment is what keeps the one in-request language-model path harmless (AAP 0.3.2): the handler
 * catches everything, a failed classification ends that call politely inside the session, and a failure this file
 * cannot attribute to a dialogue closes the one socket with `1011`.
 *
 * Nothing on either path is logged: a log line holds an event name, an attempt id and — of a provider `error` frame
 * — only the five-digit code that frame's free-form `description` carries. The description itself is never logged,
 * because Twilio documents error 64111 as putting the application's own unspoken tokens there, which on a
 * `lodging_stay_verification` call are the disclosure question naming the guest and the stay dates, and no
 * key-based redaction can rewrite a name embedded in another field's string (AAP 0.5.2, 0.11.1).
 */

import { Buffer } from 'node:buffer';

import {
  RelayInboundFrame,
  RelayOutboundFrame,
  Uuid,
  VOICE_ATTEMPT_PARAMETER,
  utf8ByteLength,
  type RelaySetupFrame,
} from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { webhookLimits } from '../../plugins/rate-limit.ts';
import { WS_CLOSE } from '../../plugins/websocket.ts';

import { DialogueSession, isStripped, loadCallContext, type RelayIo } from './dialogue.ts';
import { twilioSignatureHook } from './signature.ts';
import { CLASSIFICATION_WINDOW_MAX_BYTES } from './understanding.ts';

import type { FastifyRequest, preValidationAsyncHookHandler } from 'fastify';
import type { WebSocket } from 'ws';

import type { App, AppServices } from '../../app.ts';

/**
 * The relay socket's path, relative to the `/v1` prefix `app.ts` mounts the modules under. The public
 * address Twilio signs is `./signature.ts`'s `publicRelayUrl`, which spells this same path, so the two
 * cannot drift.
 */
const RELAY_PATH = '/webhooks/voice/relay';

/** RFC 6455's normal closure: the dialogue finished and closed the socket itself. */
const CLOSE_NORMAL = 1000;

/** RFC 6455's "going away": the API is shutting down and this socket goes with it. */
const CLOSE_GOING_AWAY = 1001;

/** RFC 6455's "internal error": this file failed on a connection it had already accepted. */
const CLOSE_INTERNAL_ERROR = 1011;

/** Why a connection was refused before it carried any dialogue (AAP 0.5.6). */
type RefusalReason =
  /** `setup` named no attempt id, or one that is not a UUID. */
  | 'bad_attempt_id'
  /** The attempt does not exist, has been stripped, or is not the call the TwiML adopted. */
  | 'attempt_unavailable'
  /** The socket reports a `CallSid` other than the one the attempt already adopted. */
  | 'call_sid_mismatch'
  /** Another live socket already carries this attempt. */
  | 'duplicate_session';

/**
 * One live relay connection (AAP 0.3.2, 0.5.6): the socket Twilio opened, the attempt it claimed and
 * the dialogue that answers for it — created only once `setup` has been accepted, so a connection that
 * never sends one holds nothing but its socket.
 */
interface RelayConnection {
  readonly socket: WebSocket;
  attemptId: string | null;
  session: DialogueSession | null;
}

/**
 * What one connection needs from the registration that accepted it (AAP 0.3.2), narrowed to the three
 * things it reads, so the per-connection logic stays testable without the route that hosts it.
 */
interface RelayDeps {
  readonly services: AppServices;
  readonly sessions: Map<string, RelayConnection>;
  /**
   * Release this connection's capacity slot, at most once. Absent only in the pathological case where
   * the capacity hook never ran.
   */
  readonly release?: (() => void) | undefined;
}

/**
 * Registers the ConversationRelay socket on the encapsulated voice-agent context (AAP 0.5.1, 0.5.4).
 *
 * `./twiml.ts` calls this from inside the context that holds the two HTTP voice callbacks, so the socket inherits
 * that context's `@fastify/formbody` parser and its `/v1` prefix and stays out of every other route in the API. The
 * registration owns two pieces of state, both per call rather than module-global: the live sessions, keyed by the
 * attempt they carry, and the capacity slots — so a process that builds two apps gives each its own cap.
 */
export function registerVoiceRelay(app: App): void {
  /**
   * The live sessions of this registration, keyed by the attempt they carry. Two entries for one
   * attempt would mean two dialogues for one call.
   */
  const sessions = new Map<string, RelayConnection>();
  /**
   * The capacity slot each accepted upgrade holds, keyed by the request the hook and the handler
   * share. The value is the idempotent release, because a connection ends in more than one way.
   */
  const slots = new WeakMap<FastifyRequest, () => void>();
  /** Accepted upgrades that are not accounted for by a session yet. */
  let pending = 0;
  /**
   * Take one of the `VOICE_RELAY_MAX_SESSIONS` slots and return its release. The release is
   * idempotent, so all three ways a slot ends — the connection claiming its attempt, its socket
   * closing, and a handshake `ws` aborts before the handler ever runs — release it without ever
   * counting it twice or leaving it held.
   */
  function reserveSlot(): () => void {
    pending += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      pending -= 1;
    };
  }
  /**
   * Refuse an upgrade that would exceed the concurrent-session cap (AAP 0.3.2): `503 service_unavailable` thrown
   * from a `preValidation` hook, which Fastify answers as plain HTTP on a connection it never upgrades. A slot is
   * held for the whole connection, released when the dialogue claims its attempt or when the socket closes,
   * whichever comes first, so the cap bounds live relay connections rather than attached dialogues alone.
   */
  const capacityHook: preValidationAsyncHookHandler = (request) => {
    const active = sessions.size + pending;
    if (active >= app.services.env.VOICE_RELAY_MAX_SESSIONS) {
      request.log.warn({ event: 'voice_relay_capacity', active }, 'voice_relay_capacity');
      throw new AppError('service_unavailable');
    }
    const release = reserveSlot();
    slots.set(request, release);
    // The net for a handshake that never reaches the handler: `ws` aborts it and destroys the socket
    // without calling the route, and the socket's own close is then the only thing that can return the
    // slot.
    request.raw.once('close', release);
    return Promise.resolve();
  };
  app.get(
    RELAY_PATH,
    {
      websocket: true,
      // A provider callback with no request schema, no response schema and no part in the REST
      // contract: `schema.hide` keeps it out of the generated OpenAPI document.
      schema: { hide: true },
      // The per-IP webhook counter, raised rather than the traveler allowance because the requests
      // arrive from a handful of Twilio addresses and carry no user (AAP 0.5.4).
      ...webhookLimits(app),
      // The signature first, then the cap: an unsigned upgrade is refused without ever taking a slot,
      // and a signed one that arrives at capacity is refused without any call-attempt work.
      preValidation: [twilioSignatureHook('ws'), capacityHook],
    },
    (socket, request) => {
      // The promise is returned so the WebSocket plugin's own error handler stays the last net for a
      // failure that got past the containment inside; the connection itself never rejects.
      return serveConnection(socket, request, {
        services: app.services,
        sessions,
        release: slots.get(request),
      });
    },
  );
  /**
   * Record one result per live call on a graceful shutdown (AAP 0.3.2, 0.5.6): each live session
   * finalizes with what it collected, and only then is its socket closed with `1001`. A call still
   * running when the process goes is better recorded here than left to the reconcile sweep, and the
   * work is idempotent, so a session that had already ended is left as it stands.
   */
  app.addHook('onClose', async () => {
    for (const connection of [...sessions.values()]) {
      const session = connection.session;
      // The same wait as the socket teardown's: the turns the call had already received are part of
      // what it collected, and this hook records the call with what it collected (AAP 0.5.3).
      if (session !== null) {
        if (session.finalizedBy === null) await session.awaitTurns();
        await session.finalize('app_closing');
      }
      connection.socket.close(CLOSE_GOING_AWAY);
    }
    sessions.clear();
  });
}

/**
 * One ConversationRelay connection, from its accepted upgrade to its socket's close (AAP 0.3.2).
 *
 * The connection is driven entirely by frames: `setup` attaches the call, `prompt` carries the callee's speech,
 * `interrupt` records that the agent was cut short, and the socket's close ends the call. Every await happens inside
 * the frame path and the teardown, and every failure stays on this one socket — which is why the returned promise
 * never rejects: what it cannot attribute to a dialogue it closes with `1011`.
 */
async function serveConnection(
  socket: WebSocket,
  request: FastifyRequest,
  deps: RelayDeps,
): Promise<void> {
  const { services, sessions } = deps;
  const log = request.log;
  const connection: RelayConnection = { socket, attemptId: null, session: null };
  /** Whether the teardown has run, so the socket's close and its error run it once. */
  let ended = false;
  /** Whether a `setup` frame has been acted on; a second one belongs to the same socket. */
  let setupSeen = false;
  /**
   * The pieces of an utterance whose transcription has not finished yet. Never longer than
   * {@link CLASSIFICATION_WINDOW_MAX_BYTES}: past that bound the pieces are dropped rather than held.
   */
  let buffered = '';
  /** Whether the utterance being assembled outgrew that bound, so its turn is an unusable one. */
  let overlong = false;
  /**
   * End the connection once: record what the call produced, forget it, and give its slot back
   * (AAP 0.3.2, 0.5.6). `finalize` is idempotent and owns the attempt's outcome, so a socket that
   * closes while the closing line is still playing records the same single result.
   */
  const finish = async (): Promise<void> => {
    if (ended) return;
    ended = true;
    const session = connection.session;
    try {
      if (session !== null) {
        // A socket that goes mid-turn: the confirmation the callee had already spoken is part of what
        // the call collected, so it is recorded rather than lost (AAP 0.5.3). A session its own
        // closing path already finalized keeps today's teardown latency.
        if (session.finalizedBy === null) await session.awaitTurns();
        await session.finalize('socket_closed');
      }
    } finally {
      // Released whatever the finalize did: a registry entry left behind would refuse every later
      // connection for this attempt as a duplicate, and a slot left held would shrink the cap by one
      // for the life of the process.
      if (connection.attemptId !== null) sessions.delete(connection.attemptId);
      // A no-op when `setup` already returned the slot: the connection is accounted for by its
      // session from that moment, and by this release before it.
      deps.release?.();
    }
  };
  /**
   * Contain one unexpected failure (AAP 0.3.2): the call ends on this socket, with `1011`, and nothing
   * else in the process is touched. The line names the event and the attempt id alone — never the
   * frame's own content (AAP 0.11.1).
   */
  const fail = (): void => {
    log.warn(
      { event: 'voice_relay_failed', attemptId: connection.attemptId },
      'voice_relay_failed',
    );
    if (socket.readyState === socket.OPEN) socket.close(CLOSE_INTERNAL_ERROR);
  };
  /**
   * Refuse a connection that cannot be attached to its call (AAP 0.5.6): nothing is spoken, no dialogue starts, and
   * the socket is closed with the application's `forbidden` code. The reason is logged under `dropReason`, never
   * under `reason`, because the logger's redaction list censors `reason` — a dispute or a report carries free text
   * there — and a censored reason would leave the one line explaining a refused call with nothing to read.
   */
  const refuse = (reason: RefusalReason): void => {
    log.warn(
      { event: 'voice_relay_refused', attemptId: connection.attemptId, dropReason: reason },
      'voice_relay_refused',
    );
    socket.close(WS_CLOSE.forbidden);
  };
  /** Record a frame this file could not use, without any of its content (AAP 0.11.1). */
  const badFrame = (): void => {
    log.debug(
      { event: 'voice_relay_bad_frame', attemptId: connection.attemptId },
      'voice_relay_bad_frame',
    );
  };
  /**
   * The socket as the dialogue sees it (AAP 0.5.6): one way to speak and one way to hang up.
   *
   * A frame is validated as it leaves, because `RelayOutboundFrame` is strict — Twilio answers an
   * unknown field with error 64107 — and a frame the shared union refuses must never reach the
   * provider. Sending to a socket that has already gone ends nothing: the session tolerates it.
   */
  const io: RelayIo = {
    send(frame: RelayOutboundFrame): void {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify(RelayOutboundFrame.parse(frame)));
    },
    close(): void {
      socket.close(CLOSE_NORMAL);
    },
  };
  /**
   * Attach the call `setup` named to this socket, once (AAP 0.5.6). Four things have to hold before a dialogue may
   * speak, and each refusal is a closed socket rather than a half-attached call: the id has to be a UUID, no other
   * live socket may carry the same attempt, the attempt has to exist and not be stripped, and the `CallSid` has to
   * be the one the TwiML fetch already adopted (AAP 0.3.2).
   */
  const start = async (frame: RelaySetupFrame): Promise<void> => {
    const claimed = Uuid.safeParse(frame.customParameters?.[VOICE_ATTEMPT_PARAMETER] ?? '');
    if (!claimed.success) {
      refuse('bad_attempt_id');
      return;
    }
    const ctx = await loadCallContext(services.db, claimed.data);
    // These three are checked after the read, not before it, because every one of them decides whether
    // this socket was this attempt's conversation at all: a socket that reports another call, or one
    // whose attempt another live socket already carries, must not touch the attempt even to record an
    // ending. The registry entry is claimed below with no await in between, so exactly one connection
    // holds it.
    if (sessions.has(claimed.data)) {
      refuse('duplicate_session');
      return;
    }
    if (ctx === null || isStripped(ctx.attempt)) {
      refuse('attempt_unavailable');
      return;
    }
    if (ctx.attempt.twilioCallSid !== frame.callSid) {
      refuse('call_sid_mismatch');
      return;
    }
    // The socket can go while the attempt is being read. The call then dropped before any data —
    // which AAP 0.5.3 maps to `no_answer` — and the session is what records it. The socket is already
    // gone, so no question is spoken into it, and the session is never registered, because the
    // teardown has run and would leave the registry entry behind to refuse the attempt's next
    // socket.
    if (ended) {
      await new DialogueSession(services, ctx, undefined, io).finalize('socket_closed');
      return;
    }
    const session = new DialogueSession(services, ctx, undefined, io);
    connection.attemptId = claimed.data;
    connection.session = session;
    sessions.set(claimed.data, connection);
    // The session answers for this connection from here on, so the cap counts it as a session rather
    // than as a connection still waiting to become one (AAP 0.3.2).
    deps.release?.();
    // Twilio has spoken the disclosure as the conversation-relay greeting by now, so the session
    // speaks the first question and nothing before it (AAP 0.5.3).
    await session.start();
  };
  /**
   * One frame from Twilio (AAP 0.5.6). `prompt` is the only frame that reaches the dialogue: `partialPrompts` is off
   * in the TwiML, so a prompt is final, and a piece that is not is held until the one that is — an utterance is
   * never halved, except at the classification window's own byte bound, past which it reaches the dialogue as an
   * unusable utterance. A prompt before `setup` belongs to no dialogue and is ignored; `dtmf` asks for nothing,
   * because no keypad menu is served, and `info` is a session diagnostic this API does not read.
   */
  const dispatch = (frame: RelayInboundFrame): void => {
    switch (frame.type) {
      case 'setup':
        // Once per socket: a repeated `setup` is Twilio retrying a frame it already delivered, and
        // acting on it would attach a second dialogue to one call.
        if (setupSeen) return;
        setupSeen = true;
        void start(frame).catch(fail);
        return;
      case 'prompt': {
        if (!frame.last) {
          // Bounded by the very window the dialogue counts its turns against (AAP 0.5.6): while the
          // pieces fit inside it they are held as they arrive, and the first piece that would push
          // the utterance past the bound is not held at all — so what one connection accumulates for
          // a call is that window plus the one frame being read, whatever a signature-valid socket
          // sends for the length of the call. Nothing is lost with the dropped pieces: the `last`
          // frame below hands the turn to the dialogue as an unusable utterance, which is the path a
          // classification the model could not read already takes.
          if (!overlong) {
            const held = buffered + frame.voicePrompt;
            if (utf8ByteLength(held) > CLASSIFICATION_WINDOW_MAX_BYTES) {
              overlong = true;
              buffered = '';
            } else {
              buffered = held;
            }
          }
          return;
        }
        const text = buffered + frame.voicePrompt;
        // A single `last` frame whose own prompt outgrows the window is the same case as pieces that
        // together do, and neither is classified.
        const cut = overlong || utf8ByteLength(text) > CLASSIFICATION_WINDOW_MAX_BYTES;
        buffered = '';
        overlong = false;
        const session = connection.session;
        if (session === null) return;
        // The session chains its turns, so the socket never needs to await one: the next prompt is
        // answered after the current turn, whatever order the frames arrive in.
        void session.onPrompt(text, { overlong: cut }).catch(fail);
        return;
      }
      case 'interrupt':
        // Nothing is replayed in response: the turn it cut short is the call's own business.
        connection.session?.onInterrupt();
        return;
      case 'dtmf':
        return;
      case 'info':
        return;
      case 'error': {
        // Twilio's own report of a message the session rejected. Its `description` is free-form, and
        // Twilio documents error 64111 as carrying the application's own unspoken tokens in it —
        // the `menu_prices` questions, or the `lodging_stay_verification` question that names the
        // guest and the stay dates — so none of it may reach a log line (AAP 0.5.2, 0.11.1). What
        // is kept is the provider's numeric code alone, which is what an operator reads to tell one
        // relay failure from another; `relayErrorCode` is the whole of that extraction. The dialogue
        // ends the call on its own terms — a model failure hears the closing line and leaves the
        // task for retry (AAP 0.5.6).
        const code = relayErrorCode(frame.description);
        log.warn(
          {
            event: 'voice_relay_error',
            attemptId: connection.attemptId,
            // The code is left out rather than set to null when the description names none: an
            // absent field is what the workspace's log lines carry for an absent optional value
            // (AAP 0.11.1).
            ...(code === null ? {} : { code }),
          },
          'voice_relay_error',
        );
        return;
      }
    }
  };
  /** Settles when the socket has closed, whether cleanly or not. */
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => {
      resolve();
    });
    // An error on an established socket is reported by the websocket plugin's error handler, which also
    // terminates it; the teardown follows the close that terminate produces.
    socket.once('error', () => {
      resolve();
    });
  });
  try {
    socket.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          badFrame();
          return;
        }
        const frame = relayFrame(messageText(data));
        if (frame === null) {
          badFrame();
          return;
        }
        dispatch(frame);
      } catch {
        fail();
      }
    });
    await closed;
  } catch {
    fail();
  } finally {
    await finish();
  }
}

/**
 * One frame from Twilio, as the shared union reads it, or `null` for anything this file cannot use
 * (AAP 0.5.6). A relay message is JSON text carrying the callee's speech, so a frame that does not
 * parse is dropped rather than guessed at, and the union — loose on purpose, because Twilio sends
 * fields this API does not read — keeps a documented frame from breaking a live call.
 */
function relayFrame(text: string): RelayInboundFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const frame = RelayInboundFrame.safeParse(value);
  return frame.success ? frame.data : null;
}

/**
 * One relay message's text, from whatever `ws` handed the listener (AAP 0.5.6): ConversationRelay sends
 * JSON text frames, which `ws` delivers as UTF-8 bytes, and the other shapes are accepted so that a
 * fragmented or differently configured frame is decoded rather than mistaken for a malformed one. A
 * value of none of these shapes decodes to the empty string, which parses as no frame and is dropped.
 */
function messageText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data as readonly Uint8Array[]).toString('utf8');
  return '';
}

/**
 * The provider's own error code inside a relay `error` frame's `description`, or `null`
 * (AAP 0.5.2, 0.11.1).
 *
 * Twilio's `error` frame carries a free-form description, and the payload Twilio documents for error 64111 —
 * `Error converting tokens to speech, code: 64111, error: , tokens: <tokens>` — puts the application's own unspoken
 * tokens in that same field, which on a `lodging_stay_verification` call are the disclosure question naming the guest
 * and the stay dates. Nothing of the description may therefore be logged, and the five-digit code such a message
 * carries is the whole of what may be. A description naming no code reads as `null`, so the caller leaves the field
 * out rather than logging an empty one. Exported so the extraction is unit-tested on Twilio's documented payloads.
 *
 * @returns The code's own digits — `64111`, `64107` — or `null` when the description names none.
 */
export function relayErrorCode(description: string): string | null {
  return RELAY_ERROR_CODE_RE.exec(description)?.[1] ?? null;
}

/**
 * The one thing taken from a relay `error` frame's description (AAP 0.11.1): the provider's code,
 * as Twilio writes it inside its own message. Not global, so `exec` carries no state between calls,
 * and the trailing `\b` is what keeps a longer run of digits — or a code-shaped number in the free
 * text — from matching past five of them.
 */
const RELAY_ERROR_CODE_RE = /\bcode:\s*(\d{5})\b/;
